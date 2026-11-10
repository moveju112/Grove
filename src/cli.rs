//! 명령행(ARCH-007). foreground 서버와 관리 명령.

use crate::config::Config;
use crate::util::SystemClock;
use crate::VERSION;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

const HELP: &str = "grove — 단일 실행 파일 에이전트 서버

사용법:
  grove [serve] [--listen 주소:포트] [--data-dir 경로]   foreground 서버 실행(기본)
  grove token [--data-dir 경로]                          소유자 토큰 출력
  grove unlock [--data-dir 경로]                         브라우저 로그인 실패 잠금 해제
  grove status [--listen 주소:포트]                      실행 중 서버 상태 확인
  grove snapshot <대상 파일> [--data-dir 경로]           일관된 DB snapshot 생성
  grove restore <snapshot 파일> <새 데이터 디렉터리>     snapshot을 새 디렉터리로 복원·검증
  grove import paseo <원본 sessions 디렉터리> [--dry-run] [--data-dir 경로]
                                                        기존 Paseo 대화 가져오기(원본은 읽기만, 서버 정지 상태에서)
  grove install --install 설치경로 --package 압축본 --data-dir 경로 --listen 주소:포트
                [--trust-key 공개키파일]… [--service process|systemd-user:<unit>]   새 설치
  grove update check  --install 설치경로 --manifest URL|파일          업데이트 확인(서비스 중단 없음)
  grove update apply  --install 설치경로 --manifest URL|파일 [--force] [--allow-downgrade]
  grove update status --install 설치경로
  grove update rollback --install 설치경로                             이전 버전으로(schema가 같을 때)
  grove start --install 설치경로 | grove stop --install 설치경로        process 방식 서비스 시작·정지
  grove release keygen <개인키 파일>                                  서명 키 생성(.pub 함께)
  grove release sign --key 개인키 [--key 개인키]… <release.json> <출력>
  grove migrate-check <DB 복사본>                                      이 버전의 migration 사전 시험
  grove --version | -V [--json]                          버전
  grove --help | -h                                      이 도움말

환경변수: GROVE_DATA_DIR, GROVE_LISTEN, GROVE_ALLOWED_ORIGINS, GROVE_ALLOWED_HOSTS,
          GROVE_WEB_DIR, GROVE_TLS_TERMINATED=1, GROVE_ENABLE_TOOL_LOOP=1";

#[derive(Default)]
struct Opts {
    positional: Vec<String>,
    listen: Option<SocketAddr>,
    data_dir: Option<PathBuf>,
    install: Option<PathBuf>,
    package: Option<PathBuf>,
    manifest: Option<String>,
    service: Option<String>,
    trust_keys: Vec<PathBuf>,
    keys: Vec<PathBuf>,
    force: bool,
    dry_run: bool,
    allow_downgrade: bool,
    ready_timeout: Option<u64>,
}

fn parse(args: &[String]) -> Result<Opts, String> {
    let mut o = Opts::default();
    let mut it = args.iter();
    let val = |it: &mut std::slice::Iter<String>, name: &str| it.next().cloned().ok_or(format!("{name} 값이 필요합니다"));
    while let Some(a) = it.next() {
        match a.as_str() {
            "--listen" => o.listen = Some(val(&mut it, a)?.parse().map_err(|e| format!("--listen 형식 오류: {e}"))?),
            "--data-dir" => o.data_dir = Some(PathBuf::from(val(&mut it, a)?)),
            "--install" => o.install = Some(PathBuf::from(val(&mut it, a)?)),
            "--package" => o.package = Some(PathBuf::from(val(&mut it, a)?)),
            "--manifest" => o.manifest = Some(val(&mut it, a)?),
            "--service" => o.service = Some(val(&mut it, a)?),
            "--trust-key" => o.trust_keys.push(PathBuf::from(val(&mut it, a)?)),
            "--key" => o.keys.push(PathBuf::from(val(&mut it, a)?)),
            "--ready-timeout" => o.ready_timeout = Some(val(&mut it, a)?.parse().map_err(|_| "--ready-timeout은 초 단위 정수")?),
            "--force" => o.force = true,
            "--dry-run" => o.dry_run = true,
            "--allow-downgrade" => o.allow_downgrade = true,
            "--json" => {}
            s if s.starts_with("--") => return Err(format!("알 수 없는 옵션: {s}")),
            _ => o.positional.push(a.clone()),
        }
    }
    Ok(o)
}

fn print_json(r: Result<serde_json::Value, String>) -> Result<(), String> {
    let v = r?;
    println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
    Ok(())
}

fn need<T: Clone>(v: &Option<T>, name: &str) -> Result<T, String> {
    v.clone().ok_or(format!("{name}이(가) 필요합니다"))
}

/// 설치·업데이트·서명 명령. 보류(deferred)는 종료 코드 3, 되돌림·실패는 4로 구분한다.
fn update_cmds(o: &Opts) -> Result<i32, String> {
    use crate::update as u;
    let p = |i: usize| o.positional.get(i).map(String::as_str);
    match (p(0), p(1)) {
        (Some("install"), _) => {
            let data = need(&o.data_dir, "--data-dir")?;
            let listen = o.listen.map(|l| l.to_string()).unwrap_or_else(|| crate::config::DEFAULT_LISTEN.to_string());
            print_json(u::install(&need(&o.install, "--install")?, &need(&o.package, "--package")?, &data, &listen, &o.trust_keys, o.service.as_deref().unwrap_or("process")))?;
        }
        (Some("start"), _) => u::start_service(&u::Install { root: need(&o.install, "--install")? })?,
        (Some("stop"), _) => u::stop_service(&u::Install { root: need(&o.install, "--install")? })?,
        (Some("update"), Some("check")) => print_json(u::check(&need(&o.install, "--install")?, &need(&o.manifest, "--manifest")?))?,
        (Some("update"), Some("status")) => print_json(u::status(&need(&o.install, "--install")?))?,
        (Some("update"), Some("rollback")) => print_json(u::rollback_manual(&need(&o.install, "--install")?))?,
        (Some("update"), Some("apply")) => {
            let opts = u::ApplyOpts { force: o.force, allow_downgrade: o.allow_downgrade, ready_timeout: std::time::Duration::from_secs(o.ready_timeout.unwrap_or(60)) };
            let r = u::apply(&need(&o.install, "--install")?, &need(&o.manifest, "--manifest")?, &opts)?;
            println!("{}", serde_json::to_string_pretty(&r).unwrap_or_default());
            return Ok(match r["status"].as_str() {
                Some("applied" | "already") => 0,
                Some("deferred") => 3,
                _ => 4,
            });
        }
        (Some("release"), Some("keygen")) => print_json(u::keygen(&PathBuf::from(p(2).ok_or("개인키 파일 경로가 필요합니다")?)))?,
        (Some("release"), Some("sign")) => {
            let (i, out) = (p(2).ok_or("release.json 경로가 필요합니다")?, p(3).ok_or("출력 경로가 필요합니다")?);
            if o.keys.is_empty() {
                return Err("--key가 필요합니다".into());
            }
            print_json(u::sign(&PathBuf::from(i), &o.keys, &PathBuf::from(out)))?;
        }
        (Some("migrate-check"), _) => print_json(u::migrate_check(&PathBuf::from(p(1).ok_or("DB 경로가 필요합니다")?)))?,
        _ => return Err(format!("알 수 없는 명령\n\n{HELP}")),
    }
    Ok(0)
}

pub fn run(args: Vec<String>) -> i32 {
    if args.iter().any(|a| a == "--help" || a == "-h") || args.first().is_some_and(|a| a == "help") {
        println!("{HELP}");
        return 0;
    }
    if args.iter().any(|a| a == "--version" || a == "-V") || args.first().is_some_and(|a| a == "version") {
        if args.iter().any(|a| a == "--json") {
            // 빌드·업데이트 도구가 읽는 형식(BUILD-031, UPDATE-005)
            println!(
                "{}",
                serde_json::json!({ "version": VERSION, "protocol": crate::PROTOCOL_VERSION, "schema": crate::store::MIGRATIONS.len(), "target": std::env::consts::ARCH.to_string() + "-" + std::env::consts::OS })
            );
        } else {
            println!("grove {VERSION} (protocol {}, schema {})", crate::PROTOCOL_VERSION, crate::store::MIGRATIONS.len());
        }
        return 0;
    }
    let opts = match parse(&args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("오류: {e}\n\n{HELP}");
            return 2;
        }
    };
    let cmd = opts.positional.first().map(String::as_str).unwrap_or("serve");
    let result = match cmd {
        "serve" if opts.positional.len() == 1 || opts.positional.is_empty() => serve(opts),
        "token" => token(opts),
        "unlock" => unlock(opts),
        "status" => status(opts),
        "snapshot" => crate::backup::cli_snapshot(opts.positional.get(1).map(PathBuf::from), opts.data_dir),
        "import" if opts.positional.get(1).map(String::as_str) == Some("paseo") => {
            crate::import::cli(opts.positional.get(2).map(PathBuf::from), opts.data_dir, opts.dry_run)
        }
        "restore" => crate::backup::cli_restore(opts.positional.get(1).map(PathBuf::from), opts.positional.get(2).map(PathBuf::from)),
        "install" | "update" | "release" | "migrate-check" | "start" | "stop" => {
            return match update_cmds(&opts) {
                Ok(code) => code,
                Err(e) => {
                    eprintln!("오류: {e}");
                    1
                }
            };
        }
        other => Err(format!("알 수 없는 명령: {other}\n\n{HELP}")),
    };
    match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("오류: {e}");
            1
        }
    }
}

fn token(opts: Opts) -> Result<(), String> {
    let cfg = Config::from_env(opts.data_dir, opts.listen)?;
    let path = cfg.data_dir.join("owner-token");
    let t = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e} (서버를 한 번 실행하면 생성됩니다)", path.display()))?;
    println!("{}", t.trim());
    Ok(())
}

/// 로그인 잠금 해제(로컬 복구 경로, NET-020). 서버 실행 중에도 DB에 직접 적용된다.
fn unlock(opts: Opts) -> Result<(), String> {
    let cfg = Config::from_env(opts.data_dir, opts.listen)?;
    let db = crate::store::Db::open(&cfg.db_path()).map_err(|e| e.to_string())?;
    let n = db.call_sync(|c| crate::auth::clear_lockouts(c)).map_err(|e| e.message)?;
    println!("로그인 잠금 {n}건을 해제했습니다");
    Ok(())
}

fn status(opts: Opts) -> Result<(), String> {
    let cfg = Config::from_env(opts.data_dir, opts.listen)?;
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    rt.block_on(async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut s = tokio::net::TcpStream::connect(cfg.listen).await.map_err(|e| format!("{}: 연결 실패 ({e})", cfg.listen))?;
        let req = format!("GET /api/v1/health HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n", cfg.listen);
        s.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;
        let mut buf = String::new();
        s.read_to_string(&mut buf).await.map_err(|e| e.to_string())?;
        let body = buf.split("\r\n\r\n").nth(1).unwrap_or("");
        println!("{body}");
        Ok(())
    })
}

fn serve(opts: Opts) -> Result<(), String> {
    let cfg = Config::from_env(opts.data_dir, opts.listen)?;
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("GROVE_LOG").unwrap_or_else(|_| "info".into()))
        .with_writer(std::io::stderr)
        .init();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .max_blocking_threads(64)
        .build()
        .map_err(|e| e.to_string())?;
    rt.block_on(async move {
        let server = crate::server::start(cfg, Arc::new(SystemClock)).await?;
        eprintln!("grove {VERSION} listening on http://{}", server.addr);
        eprintln!("owner token file: {}", server.app.cfg.data_dir.join("owner-token").display());
        // OS 신호 또는 관리 API 종료 요청(업데이트 도구)
        let mut exit_rx = server.app.exit_tx.subscribe();
        tokio::select! {
            _ = crate::server::wait_for_signal() => {}
            _ = exit_rx.wait_for(|v| *v) => {}
        }
        eprintln!("종료 중...");
        server.stop().await;
        Ok(())
    })
}
