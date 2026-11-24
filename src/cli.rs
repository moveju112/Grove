//! 명령행(ARCH-007). foreground 서버와 관리 명령.

use crate::config::Config;
use crate::startup::{FailureKind, StartupError};
use crate::util::SystemClock;
use crate::VERSION;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
#[path = "cli_pairing.rs"]
mod pairing_cli;

const HELP: &str = "grove — 단일 실행 파일 에이전트 서버

사용법:
  grove [serve] [--listen 주소:포트] [--data-dir 경로]   foreground 서버 실행(기본)
                [--log-file 경로]                      기본 파일당 8MiB·보관본 7개·최대 7일
                                                       GROVE_LOG_MAX_MIB / GROVE_LOG_KEEP_DAYS로 조절
                [--json]                               준비·실패 안내(JSON); 시작 오류 종료 코드 10~17
  grove status [--listen 주소:포트]                      실행 중 서버 상태 확인(health)
  grove doctor [--listen 주소:포트] [--data-dir 경로]    프로세스·API 준비·인증·모델 설정을 각각 진단(문제 있으면 종료 코드 1)
  grove doctor --offline [--data-dir 경로]               DB 읽기 전용 무결성 검사·복구 안내(서버·migration·모델 호출 없음)
  grove config [--listen 주소:포트] [--data-dir 경로]    실제 적용될 경로·주소·환경 설정 출력(비밀값 없음)
  grove connect-link <wss://서버/api/e2ee> [--data-dir 경로]
                                                        Pages 앱의 서버 공개키 고정 연결 링크 출력(인증 토큰 미포함)
  grove pairing --help                                  첫 기기 등록과 페어링 링크 관리
  grove snapshot <대상 파일> [--data-dir 경로]           일관된 DB snapshot 생성
  grove restore <snapshot 파일> <새 데이터 디렉터리>     snapshot을 새 디렉터리로 복원·검증
  grove install --install 설치경로 --package 압축본 --data-dir 경로 --listen 주소:포트
                [--trust-key 공개키파일]… [--service process|systemd-user:<unit>]   새 설치
  grove update check  --install 설치경로 [--manifest URL|파일]          업데이트 확인(서비스 중단 없음)
  grove update apply  --install 설치경로 [--manifest URL|파일] [--force] [--allow-downgrade]
  grove update status --install 설치경로
  grove update rollback --install 설치경로                             이전 버전으로(schema가 같을 때)
  grove start --install 설치경로 | grove stop --install 설치경로        process 방식 서비스 시작·정지
  grove release verify 서명-manifest                         공식 릴리즈 서명 확인
  grove release keygen <개인키 파일>                                  서명 키 생성(.pub 함께)
  grove release sign --key 개인키 [--key 개인키]… <release.json> <출력>
  grove migrate-check <DB 복사본>                                      이 버전의 migration 사전 시험
  grove exec --base-url URL --model 이름 --prompt 텍스트 [...]          개인 문맥 없는 단발 실행(grove exec --help)
  grove --version | -V [--json]                          버전
  grove --help | -h                                      이 도움말

환경변수: GROVE_DATA_DIR, GROVE_LISTEN, GROVE_ALLOWED_ORIGINS, GROVE_ALLOWED_HOSTS,
          GROVE_WEB_DIR, GROVE_TLS_TERMINATED=1";

#[derive(Default)]
struct Opts {
    positional: Vec<String>,
    listen: Option<SocketAddr>,
    data_dir: Option<PathBuf>,
    log_file: Option<PathBuf>,
    install: Option<PathBuf>,
    package: Option<PathBuf>,
    manifest: Option<String>,
    service: Option<String>,
    trust_keys: Vec<PathBuf>,
    keys: Vec<PathBuf>,
    force: bool,
    offline: bool,
    allow_downgrade: bool,
    ready_timeout: Option<u64>,
    json: bool,
}

fn parse(args: &[String]) -> Result<Opts, String> {
    let mut o = Opts::default();
    let mut it = args.iter();
    let val = |it: &mut std::slice::Iter<String>, name: &str| it.next().cloned().ok_or(format!("{name} 값이 필요합니다"));
    while let Some(a) = it.next() {
        match a.as_str() {
            "--listen" => o.listen = Some(val(&mut it, a)?.parse().map_err(|e| format!("--listen 형식 오류: {e}"))?),
            "--data-dir" => o.data_dir = Some(PathBuf::from(val(&mut it, a)?)),
            "--log-file" => o.log_file = Some(PathBuf::from(val(&mut it, a)?)),
            "--install" => o.install = Some(PathBuf::from(val(&mut it, a)?)),
            "--package" => o.package = Some(PathBuf::from(val(&mut it, a)?)),
            "--manifest" => o.manifest = Some(val(&mut it, a)?),
            "--service" => o.service = Some(val(&mut it, a)?),
            "--trust-key" => o.trust_keys.push(PathBuf::from(val(&mut it, a)?)),
            "--key" => o.keys.push(PathBuf::from(val(&mut it, a)?)),
            "--ready-timeout" => o.ready_timeout = Some(val(&mut it, a)?.parse().map_err(|_| "--ready-timeout은 초 단위 정수")?),
            "--force" => o.force = true,
            "--offline" => o.offline = true,
            "--allow-downgrade" => o.allow_downgrade = true,
            "--json" => o.json = true,
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
        (Some("update"), Some("check")) => print_json(u::check(&need(&o.install, "--install")?, o.manifest.as_deref().unwrap_or(u::STABLE_MANIFEST)))?,
        (Some("update"), Some("status")) => print_json(u::status(&need(&o.install, "--install")?))?,
        (Some("update"), Some("rollback")) => print_json(u::rollback_manual(&need(&o.install, "--install")?))?,
        (Some("update"), Some("auto-apply")) => {
            let pid = p(2).and_then(|p| p.parse().ok()).ok_or("데몬 PID가 필요합니다")?;
            let revision = p(3).and_then(|r| r.parse().ok()).ok_or("설정 revision이 필요합니다")?;
            let result = u::run_automatic(&need(&o.install, "--install")?, &need(&o.manifest, "--manifest")?, pid, revision)?;
            return Ok(match result["status"].as_str() {
                Some("applied" | "already" | "skipped") => 0,
                Some("deferred") => 3,
                _ => 4,
            });
        }
        (Some("update"), Some("apply")) => {
            let opts = u::ApplyOpts { force: o.force, allow_downgrade: o.allow_downgrade, ready_timeout: std::time::Duration::from_secs(o.ready_timeout.unwrap_or(60)) };
            let r = u::apply(&need(&o.install, "--install")?, o.manifest.as_deref().unwrap_or(u::STABLE_MANIFEST), &opts)?;
            println!("{}", serde_json::to_string_pretty(&r).unwrap_or_default());
            return Ok(match r["status"].as_str() {
                Some("applied" | "already") => 0,
                Some("deferred") => 3,
                _ => 4,
            });
        }
        (Some("release"), Some("verify")) => {
            let text = std::fs::read_to_string(p(2).ok_or("서명 manifest가 필요합니다")?).map_err(|e| e.to_string())?;
            print_json(u::verify_published(&text).and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string())))?;
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
    if args.first().is_some_and(|a| a == "continuation-mcp") {
        return crate::continuations::bridge::mcp_main(args.get(1));
    }
    if args.first().is_some_and(|a| a == "pairing") {
        return pairing_cli::run(&args[1..]);
    }
    // 단발 실행은 고유 옵션과 종료 코드 계약이 있으므로 서버 옵션 parser를 거치지 않는다(ONCE-001).
    if args.first().is_some_and(|a| a == "exec") {
        return crate::exec::run(&args[1..]);
    }
    if args.iter().any(|a| a == "--help" || a == "-h") || args.first().is_some_and(|a| a == "help") {
        println!("{HELP}");
        return 0;
    }
    if args.iter().any(|a| a == "--version" || a == "-V") || args.first().is_some_and(|a| a == "version") {
        if args.iter().any(|a| a == "--json") {
            // 빌드·업데이트 도구가 읽는 형식(BUILD-031, UPDATE-005)
            println!(
                "{}",
                serde_json::json!({ "version": VERSION, "protocol": crate::PROTOCOL_VERSION, "schema": crate::store::MIGRATIONS.len(), "target": std::env::consts::ARCH.to_string() + "-" + std::env::consts::OS, "features": crate::CAPABILITIES })
            );
        } else {
            println!("grove {VERSION} (protocol {}, schema {})", crate::PROTOCOL_VERSION, crate::store::MIGRATIONS.len());
        }
        return 0;
    }
    let opts = match parse(&args) {
        Ok(o) => o,
        Err(e) => {
            if args.iter().any(|a| a == "--json") && args.first().is_none_or(|a| a == "serve" || a.starts_with('-')) {
                return print_startup_error(StartupError::new(FailureKind::Configuration, None), None, true);
            }
            eprintln!("오류: {e}\n\n{HELP}");
            return 2;
        }
    };
    let cmd = opts.positional.first().map(String::as_str).unwrap_or("serve");
    if opts.offline && cmd != "doctor" {
        if cmd == "serve" && opts.json {
            return print_startup_error(StartupError::new(FailureKind::Configuration, None), None, true);
        }
        eprintln!("--offline은 doctor에서만 사용할 수 있습니다");
        return 2;
    }
    let result = match cmd {
        "serve" if opts.positional.len() == 1 || opts.positional.is_empty() => return serve(opts),
        "token" | "auth" | "pair" | "unlock" => Err("기기는 `grove pairing create`로 등록하세요".into()),
        "status" => status(opts),
        "config" => config_cmd(opts),
        "connect-link" => connect_link(opts),
        "doctor" => {
            return match doctor(opts) {
                Ok(true) => 0,
                Ok(false) => 1,
                Err(e) => {
                    eprintln!("오류: {e}");
                    1
                }
            };
        }
        "snapshot" => crate::backup::cli_snapshot(opts.positional.get(1).map(PathBuf::from), opts.data_dir),
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

fn connect_link(opts: Opts) -> Result<(), String> {
    let endpoint = opts.positional.get(1).ok_or("wss://서버/api/e2ee 주소가 필요합니다")?;
    if opts.positional.len() != 2 { return Err("connect-link는 서버 주소 하나를 받습니다".into()); }
    let url = reqwest::Url::parse(endpoint).map_err(|_| "서버 주소가 올바르지 않습니다")?;
    if url.scheme() != "wss" || url.host_str().is_none() || !url.username().is_empty()
        || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || url.path() != "/api/e2ee"
    { return Err("인증 정보·query 없는 wss://서버/api/e2ee 주소가 필요합니다".into()); }
    let cfg = Config::from_env(opts.data_dir, opts.listen)?;
    let identity = crate::e2ee::Transport::load(&cfg.data_dir).map_err(|e| e.to_string())?;
    let mut link = reqwest::Url::parse(crate::e2ee::PAGES_ORIGIN).expect("Pages URL");
    let fragment = reqwest::Url::parse_with_params("https://unused.invalid", &[("connect", url.as_str()), ("key", &identity.public_key())]).unwrap();
    link.set_fragment(fragment.query());
    println!("{link}");
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

/// 실제 적용될 실행 설정(ARCH-007, ARCH-009). 비밀값은 경로만 보여 준다.
fn config_cmd(opts: Opts) -> Result<(), String> {
    let cfg = Config::from_env(opts.data_dir, opts.listen)?;
    print_json(Ok(serde_json::json!({
        "data_dir": cfg.data_dir, "db_path": cfg.db_path(), "owner_token_file": cfg.data_dir.join("owner-token"),
        "listen": cfg.listen.to_string(), "allowed_origins": cfg.allowed_origins, "allowed_hosts": cfg.allowed_hosts,
        "tls_terminated": cfg.tls_terminated, "web_dir": cfg.web_dir,
        "approval_ttl_secs": cfg.approval_ttl_secs, "scheduler_tick_ms": cfg.scheduler_tick_ms,
    })))
}

/// 같은 PC의 서버에 접속할 주소. 전체 주소 바인딩이면 loopback으로 접속한다.
fn local_base(cfg: &Config) -> String {
    let mut a = cfg.listen;
    if a.ip().is_unspecified() {
        a.set_ip(if a.is_ipv4() { std::net::Ipv4Addr::LOCALHOST.into() } else { std::net::Ipv6Addr::LOCALHOST.into() });
    }
    format!("http://{a}")
}

fn owner_token(cfg: &Config) -> Option<String> {
    std::fs::read_to_string(cfg.data_dir.join("owner-token")).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// 같은 데이터 디렉터리로 서버가 실행 중인가. 데이터 디렉터리를 만들거나 잠금 파일을 고치지 않는다.
fn server_process(cfg: &Config) -> serde_json::Value {
    let path = cfg.data_dir.join("grove.lock");
    let Ok(f) = std::fs::File::open(&path) else {
        return serde_json::json!({ "status": "stopped", "detail": "잠금 파일 없음" });
    };
    match f.try_lock_shared() {
        Ok(()) => serde_json::json!({ "status": "stopped" }),
        Err(std::fs::TryLockError::WouldBlock) => {
            let pid = std::fs::read_to_string(&path).unwrap_or_default();
            serde_json::json!({ "status": "running", "pid": pid.trim().parse::<u64>().ok() })
        }
        Err(std::fs::TryLockError::Error(e)) => serde_json::json!({ "status": "unknown", "detail": e.to_string() }),
    }
}

/// 프로세스 존재·API 준비·인증 가능·모델 사용 가능 상태를 각각 진단한다(ARCH-007, ARCH-011).
/// 모델은 유료 호출 없이 저장된 마지막 연결 확인 결과만 보고한다. 문제가 없으면 true.
fn doctor(opts: Opts) -> Result<bool, String> {
    let cfg = Config::from_env(opts.data_dir, opts.listen)?;
    if opts.offline {
        let result = crate::backup::inspect(&cfg.db_path());
        let database = match &result {
            Ok(schema) => serde_json::json!({ "status": "integrity_ok", "schema": schema }),
            Err(error) => serde_json::json!({ "status": "recovery_required", "code": error.code, "message": error.message }),
        };
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "mode": "offline_read_only", "database": database,
            "recovery": "원본 DB·WAL·첨부·키 파일을 보존하세요. 공간·권한 문제를 해결하고, snapshot은 grove restore <snapshot> <새 디렉터리>로 별도 검증하세요. 손상 원본을 자동 수리하거나 덮어쓰지 않습니다",
        })).map_err(|e| e.to_string())?);
        return Ok(result.is_ok());
    }
    let base = local_base(&cfg);
    let process = server_process(&cfg);
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    let report = rt.block_on(async {
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
        let get = |path: &str, token: Option<&str>| {
            let mut rb = client.get(format!("{base}/api/v1{path}"));
            if let Some(t) = token {
                rb = rb.bearer_auth(t);
            }
            async move {
                let r = rb.send().await.map_err(|e| e.to_string())?;
                let st = r.status();
                let v: serde_json::Value = r.json().await.unwrap_or_default();
                Ok::<_, String>((st, v))
            }
        };
        let api = match get("/health", None).await {
            Ok((_, v)) => serde_json::json!({ "status": v["status"], "version": v["version"], "protocol": v["protocol"], "schema": v["schema"] }),
            Err(e) => serde_json::json!({ "status": "unreachable", "detail": e }),
        };
        let token = owner_token(&cfg);
        let auth = match (&token, api["status"].as_str()) {
            (None, _) => serde_json::json!({ "status": "no_token", "detail": "owner-token 파일이 없습니다. 서버를 한 번 실행하세요" }),
            (_, Some("unreachable")) => serde_json::json!({ "status": "skipped", "detail": "API에 연결할 수 없습니다" }),
            (Some(t), _) => match get("/auth/whoami", Some(t)).await {
                Ok((st, v)) if st.is_success() => serde_json::json!({ "status": "ok", "kind": v["kind"] }),
                Ok((st, v)) => serde_json::json!({ "status": "rejected", "http": st.as_u16(), "detail": v["error"]["message"] }),
                Err(e) => serde_json::json!({ "status": "error", "detail": e }),
            },
        };
        let models = match (&token, auth["status"].as_str()) {
            (Some(t), Some("ok")) => match get("/model-profiles", Some(t)).await {
                Ok((st, v)) if st.is_success() => {
                    let list = v.as_array().cloned().unwrap_or_default();
                    let enabled: Vec<_> = list.iter().filter(|p| p["enabled"] != false).collect();
                    let ok = enabled.iter().filter(|p| p["last_check"]["ok"] == true).count();
                    let failing = enabled.iter().filter(|p| p["last_check"]["ok"] == false).count();
                    let status = if list.is_empty() {
                        "none"
                    } else if enabled.is_empty() {
                        "disabled"
                    } else if ok > 0 {
                        "ok"
                    } else if failing == enabled.len() {
                        "failing"
                    } else {
                        "unverified"
                    };
                    serde_json::json!({ "status": status, "profiles": list.len(), "enabled": enabled.len(), "disabled": list.len() - enabled.len(), "verified": ok, "failing": failing,
                        "detail": "활성 프로필의 마지막 연결 확인 결과 기준(진단 중 모델을 호출하지 않음)" })
                }
                Ok((st, _)) => serde_json::json!({ "status": "error", "http": st.as_u16() }),
                Err(e) => serde_json::json!({ "status": "error", "detail": e }),
            },
            _ => serde_json::json!({ "status": "skipped", "detail": "인증이 확인되지 않았습니다" }),
        };
        Ok::<_, String>(serde_json::json!({ "process": process, "api": api, "auth": auth, "models": models }))
    })?;
    let healthy = report["process"]["status"] == "running" && report["api"]["status"] == "ready" && report["auth"]["status"] == "ok" && report["models"]["status"] == "ok";
    let mut out = report;
    out["data_dir"] = serde_json::json!(cfg.data_dir);
    out["listen"] = serde_json::json!(cfg.listen.to_string());
    out["healthy"] = serde_json::json!(healthy);
    println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
    Ok(healthy)
}

fn serve(opts: Opts) -> i32 {
    let json_output = opts.json;
    let cfg = match Config::from_env(opts.data_dir, opts.listen) {
        Ok(cfg) => cfg,
        Err(_) => return print_startup_error(StartupError::new(FailureKind::Configuration, None), None, json_output),
    };
    if let Some(bundle) = crate::update::foreground::package_directory() {
        return match crate::update::foreground::serve(&bundle, &cfg) {
            Ok(code) => code,
            Err(error) => { eprintln!("데몬 시작 실패: {error}"); 1 }
        };
    }
    match serve_config(&opts.log_file, cfg.clone(), json_output) {
        Ok(()) => 0,
        Err(error) => print_startup_error(error, Some(&cfg), json_output),
    }
}

fn print_startup_error(error: StartupError, cfg: Option<&Config>, json_output: bool) -> i32 {
    if json_output {
        println!("{}", error.report(cfg));
    } else {
        eprintln!("시작 실패: {error}");
        if let Some(cfg) = cfg {
            eprintln!("데이터 위치: {}\n접속 주소: {}", cfg.data_dir.display(), cfg.listen);
            eprintln!("owner token 파일: {}", cfg.data_dir.join("owner-token").display());
        }
    }
    error.exit_code()
}

fn serve_config(log_file: &Option<PathBuf>, cfg: Config, json_output: bool) -> Result<(), StartupError> {
    let first_start = !cfg.db_path().exists();
    let file_log = log_file.is_some();
    let (writer, maintenance) = crate::logging::writer(log_file.as_deref()).map_err(|e| {
        if e.kind() == std::io::ErrorKind::InvalidInput {
            if !json_output { eprintln!("로그 설정 오류: {e}"); }
            return StartupError::new(FailureKind::Configuration, log_file.as_deref());
        }
        log_file.as_deref().map(|path| StartupError::io(&e, path)).unwrap_or_else(|| StartupError::new(FailureKind::Runtime, None))
    })?;
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("GROVE_LOG").unwrap_or_else(|_| "info".into()))
        .with_ansi(!file_log)
        .event_format(crate::logging::EventFormat(file_log))
        .with_writer(writer)
        .init();
    tracing::debug!("개발용 상세 로그 활성화");
    if let Some(log) = &maintenance { log.log_policy(); }
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .max_blocking_threads(64)
        .build()
        .map_err(|_| StartupError::new(FailureKind::Runtime, None))?;
    let result = rt.block_on(async move {
        // 로그가 전혀 없는 유휴 서버에서도 보관 기간을 적용한다.
        let _maintenance = maintenance.map(|maintenance| tokio::spawn(async move {
            let mut interval = tokio::time::interval(crate::logging::MAINTENANCE_INTERVAL);
            loop {
                interval.tick().await;
                let log = maintenance.clone();
                match tokio::task::spawn_blocking(move || log.run()).await {
                    Ok(Err(e)) => eprintln!("로그 보관 정리 실패: {e}"),
                    Ok(Ok(())) => {},
                    Err(_) => break,
                }
            }
        }));
        let server = crate::server::start_with_diagnostics(cfg, Arc::new(SystemClock)).await?;
        // OS 신호 또는 관리 API 종료 요청(업데이트 도구)
        let mut exit_rx = server.app.exit_tx.subscribe();
        let mut signals = crate::server::Signals::new();
        crate::startup::print_ready(&server.app.cfg, first_start, json_output);
        tracing::info!(version = VERSION, address = %server.addr, "서버 준비 완료");
        let cause = tokio::select! {
            c = signals.next() => c,
            _ = exit_rx.wait_for(|v| *v) => crate::server::Shutdown::Interrupt,
        };
        signals.exit_on_next();
        tracing::info!(?cause, "서버 종료 중");
        server.stop_within(cause.connection_wait()).await;
        tracing::info!("서버 종료 완료");
        Ok::<_, StartupError>(())
    });
    if let Err(e) = &result { tracing::error!(error = %e, "서버 실행 실패"); }
    result
}
