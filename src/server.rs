//! 서버 수명(ARCH-008, ARCH-010, ARCH-012, ARCH-013).
//! foreground 실행과 시험 harness가 같은 시작·종료 경로를 쓴다.

use crate::config::Config;
use crate::startup::{FailureKind, StartupError};
use crate::util::SharedClock;
use crate::App;
use std::fs::File;
use std::net::SocketAddr;
use std::time::Duration;
use tokio::task::JoinHandle;

pub struct Server {
    pub addr: SocketAddr,
    pub app: App,
    pub owner_token: String,
    handle: JoinHandle<()>,
    background: Vec<JoinHandle<()>>,
    _lock: File,
}

/// 데이터 디렉터리 단위 단일 실행 잠금. 프로세스가 죽으면 OS가 잠금을 해제하므로 stale lock이 남지 않는다.
pub(crate) fn acquire_lock(cfg: &Config) -> Result<File, String> {
    acquire_startup_lock(cfg).map_err(|e| e.to_string())
}

fn acquire_startup_lock(cfg: &Config) -> Result<File, StartupError> {
    std::fs::create_dir_all(&cfg.data_dir).map_err(|e| StartupError::io(&e, &cfg.data_dir))?;
    let path = cfg.data_dir.join("grove.lock");
    let f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|e| StartupError::io(&e, &path))?;
    match f.try_lock() {
        Ok(()) => {
            let _ = f.set_len(0);
            use std::io::Write;
            let _ = (&f).write_all(std::process::id().to_string().as_bytes());
            Ok(f)
        }
        Err(std::fs::TryLockError::WouldBlock) => {
            Err(StartupError::new(FailureKind::AlreadyRunning, Some(&path)))
        }
        Err(std::fs::TryLockError::Error(e)) => Err(StartupError::io(&e, &path)),
    }
}

pub async fn start(cfg: Config, clock: SharedClock) -> Result<Server, String> {
    start_with_diagnostics(cfg, clock).await.map_err(|e| e.to_string())
}

pub(crate) async fn start_with_diagnostics(cfg: Config, clock: SharedClock) -> Result<Server, StartupError> {
    let lock = acquire_startup_lock(&cfg)?;
    let listener = tokio::net::TcpListener::bind(cfg.listen).await.map_err(|e| match e.kind() {
        std::io::ErrorKind::AddrInUse => StartupError::new(FailureKind::PortInUse, None),
        _ => StartupError::new(FailureKind::Listen, None),
    })?;
    let addr = listener.local_addr().map_err(|_| StartupError::new(FailureKind::Listen, None))?;
    let mut cfg = cfg;
    cfg.listen = addr;
    let app = App::new(cfg.clone(), clock).map_err(|e| StartupError::database(&cfg, &e.to_string()))?;
    let owner_token = crate::auth::ensure_owner_token(&app).map_err(|e| StartupError::api(&cfg, e))?;
    crate::mcp::recover_on_start(&app).await.map_err(|e| StartupError::api(&cfg, e))?;
    crate::runner::recover_on_start(&app).await.map_err(|e| StartupError::api(&cfg, e))?;
    let now = app.now();
    app.db
        .call(move |c| {
            crate::tasks::recover_on_start(c, &now)?;
            crate::terminals::recover_on_start(c, &now)
        })
        .await
        .map_err(|e| StartupError::api(&cfg, e))?;

    let mut background = vec![];
    {
        let app = app.clone();
        let mut recovery = app.db.recovery_receiver();
        background.push(tokio::spawn(async move {
            if recovery.wait_for(|reason| reason.is_some()).await.is_err() { return; }
            // 새 접수를 막은 뒤 실행 중인 외부 작업을 중지한다. 저장 실패한 종료 결과는 재시작 복구가 unknown으로 보존한다.
            app.shutdown_tx.send_replace(true);
            tokio::join!(
                crate::runner::cancel_all_for_shutdown(&app),
                crate::tasks::stop_all(&app),
                crate::terminals::stop_all(&app),
            );
            app.exit_tx.send_replace(true);
        }));
    }
    {
        // 이벤트 보존 한도 정리와 저장 공간 정리(DB-019: 한 번에 제한된 개수만)
        let app = app.clone();
        background.push(tokio::spawn(async move {
            let mut rx = app.shutdown_rx.clone();
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(600)) => {
                        if let Err(e) = app.db.call(|c| crate::events::prune(c)).await {
                            tracing::warn!(code = e.code, "이벤트 보존 기간 정리 실패");
                        }
                        let a = app.clone();
                        match tokio::task::spawn_blocking(move || crate::storage::gc(&a)).await {
                            Ok(Ok(_)) => app.notify_events().await,
                            Ok(Err(e)) => tracing::warn!(code = e.code, "저장 공간 정리 실패"),
                            Err(_) => tracing::warn!("저장 공간 정리 작업 실패"),
                        }
                    }
                    _ = rx.changed() => break,
                }
            }
        }));
    }
    background.push(crate::approvals::spawn_expiry(app.clone()));
    background.push(crate::schedules::spawn(app.clone()));
    background.push(crate::remote_watches::spawn(app.clone()));
    background.push(crate::terminals::spawn_saver(app.clone()));
    if let Some(settings) = app.e2ee.relay.clone() {
        // 외부 릴레이에서 받은 URL로 로컬 목적지를 바꾸지 않는다.
        let mut local = addr;
        if local.ip().is_unspecified() {
            local.set_ip(if local.is_ipv4() { std::net::Ipv4Addr::LOCALHOST.into() } else { std::net::Ipv6Addr::LOCALHOST.into() });
        }
        background.push(crate::relay::spawn(settings, local, app.shutdown_rx.clone()));
    }

    let router = crate::router(app.clone());
    let mut shutdown = app.shutdown_rx.clone();
    // 암호화 연결은 ACK·응답 헤더 같은 작은 frame을 주고받는다. Nagle 지연(최대 수십 ms)이 왕복마다 붙지 않게 끈다.
    use axum::serve::ListenerExt;
    let listener = listener.tap_io(|tcp| { let _ = tcp.set_nodelay(true); });
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async move {
                let _ = shutdown.wait_for(|v| *v).await;
            })
            .await;
    });
    Ok(Server { addr, app, owner_token, handle, background, _lock: lock })
}

impl Server {
    /// 종료 순서: 신규 접수 중단 → 실행 정리 → 연결 종료 대기 → 기록 flush.
    pub async fn stop(self) {
        self.stop_within(Shutdown::Interrupt.connection_wait()).await
    }

    /// 연결 종료 대기 시간만 다르고 순서는 같다(ARCH-013). OS가 곧 강제 종료하는 경우 짧게 기다려 flush까지 끝낸다.
    pub async fn stop_within(self, connection_wait: Duration) {
        self.app.shutdown_tx.send_replace(true);
        crate::runner::cancel_all_for_shutdown(&self.app).await;
        crate::tasks::stop_all(&self.app).await;
        crate::terminals::stop_all(&self.app).await;
        let _ = tokio::time::timeout(connection_wait, self.handle).await;
        for b in self.background {
            b.abort();
        }
        let _ = self.app.db.call(|c| {
            c.pragma_update(None, "wal_checkpoint", "TRUNCATE")?;
            Ok(())
        })
        .await;
    }
}

/// OS 종료 요청의 종류(ARCH-013). Linux 신호와 Windows 콘솔 이벤트를 같은 원인으로 묶어 같은 정책을 적용한다.
/// - Interrupt: SIGINT / Ctrl-C·Ctrl-Break — 사용자가 직접 멈춤. 관리 API 종료도 같다.
/// - Terminate: SIGTERM / 시스템 종료(CTRL_SHUTDOWN) — 서비스 관리자·OS가 멈춤.
/// - ConsoleClosed: SIGHUP / 콘솔 창 닫기(CTRL_CLOSE) — 터미널이 사라짐. Windows는 몇 초 뒤 강제 종료한다.
///
/// Windows 로그오프(CTRL_LOGOFF)는 서비스로 실행 중일 때도 오므로 종료하지 않는다(Linux에 해당 신호 없음).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shutdown {
    Interrupt,
    Terminate,
    ConsoleClosed,
}

impl Shutdown {
    /// 연결 종료 대기 한도. OS가 곧 강제 종료하는 원인은 짧게 잡아 DB flush까지 마친다(Windows는 약 5초 뒤 강제 종료).
    pub fn connection_wait(self) -> Duration {
        match self {
            Shutdown::Interrupt => Duration::from_secs(10),
            Shutdown::Terminate | Shutdown::ConsoleClosed => Duration::from_secs(3),
        }
    }
}

impl Default for Signals {
    fn default() -> Self {
        Self::new()
    }
}

impl Signals {
    /// 종료를 시작한 뒤에도 신호를 계속 받는다. 정리 중 요청이 한 번 더 오면 기다리지 않고 즉시 끝낸다
    /// (DB는 WAL이라 비정상 종료에도 마지막 commit까지 보존된다).
    pub fn exit_on_next(mut self) {
        tokio::spawn(async move {
            let again = self.next().await;
            tracing::warn!(?again, "종료 중 종료 요청을 다시 받아 즉시 끝냅니다");
            std::process::exit(130);
        });
    }
}

/// OS 종료 요청 수신기. 서버 준비 직후 만들어 종료가 끝날 때까지 유지한다.
#[cfg(unix)]
pub struct Signals {
    int: tokio::signal::unix::Signal,
    term: tokio::signal::unix::Signal,
    hup: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl Signals {
    pub fn new() -> Self {
        use tokio::signal::unix::{SignalKind, signal};
        Self {
            int: signal(SignalKind::interrupt()).expect("SIGINT handler"),
            term: signal(SignalKind::terminate()).expect("SIGTERM handler"),
            hup: signal(SignalKind::hangup()).expect("SIGHUP handler"),
        }
    }
    pub async fn next(&mut self) -> Shutdown {
        tokio::select! {
            _ = self.int.recv() => Shutdown::Interrupt,
            _ = self.term.recv() => Shutdown::Terminate,
            _ = self.hup.recv() => Shutdown::ConsoleClosed,
        }
    }
}

#[cfg(windows)]
pub struct Signals {
    c: tokio::signal::windows::CtrlC,
    brk: tokio::signal::windows::CtrlBreak,
    close: tokio::signal::windows::CtrlClose,
    shutdown: tokio::signal::windows::CtrlShutdown,
}

#[cfg(windows)]
impl Signals {
    pub fn new() -> Self {
        use tokio::signal::windows;
        Self {
            c: windows::ctrl_c().expect("ctrl_c"),
            brk: windows::ctrl_break().expect("ctrl_break"),
            close: windows::ctrl_close().expect("ctrl_close"),
            shutdown: windows::ctrl_shutdown().expect("ctrl_shutdown"),
        }
    }
    pub async fn next(&mut self) -> Shutdown {
        tokio::select! {
            _ = self.c.recv() => Shutdown::Interrupt,
            _ = self.brk.recv() => Shutdown::Interrupt,
            _ = self.close.recv() => Shutdown::ConsoleClosed,
            _ = self.shutdown.recv() => Shutdown::Terminate,
        }
    }
}
