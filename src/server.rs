//! 서버 수명(ARCH-008, ARCH-010, ARCH-012, ARCH-013).
//! foreground 실행과 시험 harness가 같은 시작·종료 경로를 쓴다.

use crate::config::Config;
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
    std::fs::create_dir_all(&cfg.data_dir).map_err(|e| format!("데이터 디렉터리 생성 실패: {e}"))?;
    let path = cfg.data_dir.join("grove.lock");
    let f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    match f.try_lock() {
        Ok(()) => {
            let _ = f.set_len(0);
            use std::io::Write;
            let _ = (&f).write_all(std::process::id().to_string().as_bytes());
            Ok(f)
        }
        Err(std::fs::TryLockError::WouldBlock) => {
            let pid = std::fs::read_to_string(&path).unwrap_or_default();
            Err(format!("같은 데이터 디렉터리로 이미 서버가 실행 중입니다(pid {})", pid.trim()))
        }
        Err(std::fs::TryLockError::Error(e)) => Err(format!("잠금 실패: {e}")),
    }
}

pub async fn start(cfg: Config, clock: SharedClock) -> Result<Server, String> {
    let lock = acquire_lock(&cfg)?;
    let listener = tokio::net::TcpListener::bind(cfg.listen).await.map_err(|e| match e.kind() {
        std::io::ErrorKind::AddrInUse => format!("{} 포트가 이미 사용 중입니다", cfg.listen),
        _ => format!("{} 바인딩 실패: {e}", cfg.listen),
    })?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let mut cfg = cfg;
    cfg.listen = addr;
    let app = App::new(cfg, clock).map_err(|e| e.to_string())?;
    let owner_token = crate::auth::ensure_owner_token(&app).map_err(|e| e.message)?;
    crate::runner::recover_on_start(&app).await.map_err(|e| e.message)?;
    let now = app.now();
    app.db
        .call(move |c| {
            crate::tasks::recover_on_start(c, &now)?;
            crate::terminals::recover_on_start(c, &now)
        })
        .await
        .map_err(|e| e.message)?;

    let mut background = vec![];
    {
        // 이벤트 보존 한도 정리
        let app = app.clone();
        background.push(tokio::spawn(async move {
            let mut rx = app.shutdown_rx.clone();
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(600)) => {
                        let _ = app.db.call(|c| crate::events::prune(c)).await;
                    }
                    _ = rx.changed() => break,
                }
            }
        }));
    }
    background.push(crate::approvals::spawn_expiry(app.clone()));
    background.push(crate::schedules::spawn(app.clone()));
    background.push(crate::terminals::spawn_saver(app.clone()));

    let router = crate::router(app.clone());
    let mut shutdown = app.shutdown_rx.clone();
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
        self.app.shutdown_tx.send_replace(true);
        crate::runner::cancel_all_for_shutdown(&self.app).await;
        crate::tasks::stop_all(&self.app).await;
        crate::terminals::stop_all(&self.app).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), self.handle).await;
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

pub async fn wait_for_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(windows)]
    {
        let mut close = tokio::signal::windows::ctrl_close().expect("ctrl_close");
        let mut shutdown = tokio::signal::windows::ctrl_shutdown().expect("ctrl_shutdown");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = close.recv() => {}
            _ = shutdown.recv() => {}
        }
    }
}
