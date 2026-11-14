//! 실행 중인 로컬 데몬의 승인형 페어링 API만 사용한다. DB를 직접 변경하지 않는다.
use super::{local_base, owner_token, print_json};
use crate::config::Config;
use reqwest::{Client, Method, Url};
use serde_json::{Value, json};
use std::io::{BufRead, IsTerminal, Read, Write};

const HELP: &str = "grove pairing — 비밀번호·소유자 승인형 기기 등록

  grove pairing create [이름] [--endpoint wss://주소] [--password-stdin] [--json]
  grove pairing list
  grove pairing approve <링크 ID> <요청 ID> <확인 코드>
  grove pairing reject <링크 ID> <요청 ID>
  grove pairing revoke <링크 ID>

공통: --data-dir 경로, --listen 주소:포트
create는 기본적으로 터미널에서 비밀번호를 숨김 입력받습니다(12자 이상).
자동화에는 --password-stdin을 쓰세요. 비밀번호 인자·환경변수는 받지 않습니다.
링크와 비밀번호는 따로 전달하고, 양쪽 기기의 확인 코드를 대조한 뒤 승인하세요.
revoke는 링크만 폐기합니다. 등록된 기기의 접근은 기기 관리에서 따로 폐기하세요.";

#[derive(Default)]
struct Options {
    args: Vec<String>,
    data: Option<std::path::PathBuf>,
    listen: Option<std::net::SocketAddr>,
    endpoint: Option<String>,
    stdin: bool,
    json: bool,
}

fn parse(args: &[String]) -> Result<Options, String> {
    let mut opts = Options::default();
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--password-stdin" => opts.stdin = true,
            "--json" => opts.json = true,
            "--data-dir" | "--listen" | "--endpoint" => {
                let value = args.next().ok_or("옵션 값이 필요합니다")?;
                match arg.as_str() {
                    "--data-dir" => opts.data = Some(value.into()),
                    "--listen" => opts.listen = Some(value.parse().map_err(|_| "서버 주소 형식 오류")?),
                    _ => opts.endpoint = Some(value.clone()),
                }
            }
            flag if flag.starts_with('-') => return Err("지원하지 않는 pairing 옵션입니다".into()),
            _ => opts.args.push(arg.clone()),
        }
    }
    let count = opts.args.len();
    let valid = match opts.args.first().map(String::as_str) {
        Some("create") => (1..=2).contains(&count),
        Some("list") => count == 1,
        Some("approve") => count == 4,
        Some("reject") => count == 3,
        Some("revoke") => count == 2,
        _ => false,
    };
    if !valid { return Err(format!("명령 또는 인자 수를 확인하세요\n\n{HELP}")); }
    if opts.args[0] != "create" {
        if opts.stdin || opts.endpoint.is_some() { return Err("발급 옵션은 create에서만 사용할 수 있습니다".into()); }
        for id in opts.args.iter().skip(1).take(if opts.args[0] == "approve" { 2 } else { count - 1 }) {
            uuid::Uuid::parse_str(id).map_err(|_| "올바른 링크·요청 ID가 필요합니다")?;
        }
    }
    Ok(opts)
}

pub(super) fn run(args: &[String]) -> i32 {
    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{HELP}");
        return 0;
    }
    let result = parse(args).and_then(execute);
    match result {
        Ok(()) => 0,
        Err(error) => { eprintln!("오류: {error}"); 1 }
    }
}

fn endpoint(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "암호화 연결 주소 형식 오류")?;
    if url.scheme() != "wss" || url.host_str().is_none() || !url.username().is_empty()
        || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
    { return Err("인증 정보·query·fragment 없는 wss:// 연결 주소가 필요합니다".into()); }
    Ok(url)
}

async fn request(client: &Client, base: &str, token: &str, method: Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    let mut request = client.request(method, format!("{base}/api/v1{path}"))
        .bearer_auth(token)
        .header("idempotency-key", crate::util::new_id())
        .header("x-grove-require", "pairing_approval_v1")
        .header(crate::web::PROTOCOL_HEADER, crate::PROTOCOL_VERSION.to_string());
    if let Some(body) = body { request = request.json(&body); }
    let response = request.send().await.map_err(|_| "로컬 데몬에 연결하지 못했습니다")?;
    let status = response.status();
    // 서버 오류 본문에는 사용자 입력·비밀이 섞일 수 있어 그대로 출력하지 않는다.
    if !status.is_success() { return Err(format!("페어링 API 실패(HTTP {})", status.as_u16())); }
    response.json().await.map_err(|_| "페어링 응답 형식 오류".into())
}

fn execute(opts: Options) -> Result<(), String> {
    let cfg = Config::from_env(opts.data, opts.listen)?;
    if !cfg.listen.ip().is_loopback() && !cfg.listen.ip().is_unspecified() {
        return Err("관리 명령은 loopback 주소의 로컬 데몬만 사용할 수 있습니다".into());
    }
    let token = owner_token(&cfg).ok_or("owner-token 파일이 없습니다. 데몬과 같은 --data-dir을 지정하세요")?;
    let base = local_base(&cfg);
    let client = Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30)).build().map_err(|_| "HTTP client 생성 실패")?;
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_| "runtime 생성 실패")?;
    rt.block_on(async {
        match opts.args[0].as_str() {
            "create" => {
                let identity = request(&client, &base, &token, Method::GET, "/e2ee/identity", None).await?;
                let address = opts.endpoint.as_deref().or_else(|| identity["endpoint"].as_str())
                    .ok_or("외부 암호화 연결이 없습니다. 릴레이를 설정하거나 --endpoint wss://주소를 지정하세요")?;
                let address = endpoint(address)?;
                let key = identity["key"].as_str().ok_or("서버 공개키 응답 형식 오류")?;
                let name = opts.args.get(1).map(String::as_str).unwrap_or("새 기기");
                if name.trim().is_empty() || name.trim().chars().count() > 80 { return Err("기기 이름은 1~80자여야 합니다".into()); }
                let password = password(opts.stdin)?;
                let issued = request(&client, &base, &token, Method::POST, "/pairings", Some(json!({"name": name, "password": password}))).await?;
                let code = issued["code"].as_str().ok_or("링크 비밀을 받지 못했습니다. 목록을 확인한 뒤 필요하면 폐기하세요")?;
                let query = Url::parse_with_params("https://unused.invalid", &[("connect", address.as_str()), ("key", key), ("pairing", code)]).unwrap();
                let mut link = Url::parse(crate::e2ee::PAGES_ORIGIN).unwrap();
                link.set_fragment(query.query());
                if opts.json {
                    print_json(Ok(json!({"id": issued["id"], "name": issued["name"], "expires_at": issued["expires_at"], "link": link.as_str()})))
                } else { println!("{link}"); Ok(()) }
            }
            "list" => print_json(request(&client, &base, &token, Method::GET, "/pairings", None).await),
            action => {
                let id = &opts.args[1];
                let path = if action == "revoke" { format!("/pairings/{id}") }
                    else { format!("/pairings/{id}/requests/{}", opts.args[2]) };
                if action == "approve" {
                    let list = request(&client, &base, &token, Method::GET, "/pairings", None).await?;
                    let pending = list.as_array().and_then(|rows| rows.iter().find(|row| row["id"] == *id))
                        .and_then(|row| row["requests"].as_array())
                        .and_then(|rows| rows.iter().find(|row| row["id"] == opts.args[2]));
                    if pending.and_then(|row| row["verification_code"].as_str()) != Some(opts.args[3].as_str()) {
                        return Err("확인 코드가 다르거나 승인 대기 요청이 없습니다".into());
                    }
                }
                let method = if action == "approve" { Method::POST } else { Method::DELETE };
                let body = (action == "approve").then(|| json!({}));
                print_json(request(&client, &base, &token, method, &path, body).await)
            }
        }
    })
}

fn password(from_stdin: bool) -> Result<String, String> {
    if !from_stdin && !std::io::stdin().is_terminal() {
        return Err("터미널이 필요합니다. 자동화에는 --password-stdin을 지정하세요".into());
    }
    let echo = if from_stdin { None } else {
        let guard = EchoGuard::hide()?;
        eprint!("링크 비밀번호(12자 이상): ");
        std::io::stderr().flush().map_err(|_| "터미널 출력 실패")?;
        Some(guard)
    };
    let mut bytes = Vec::new();
    let mut input = std::io::stdin().lock();
    let result = Read::by_ref(&mut input).take(258).read_until(b'\n', &mut bytes).and_then(|_| {
        // 너무 긴 입력의 뒷부분이 명령 종료 후 셸 입력으로 넘어가지 않게 같은 줄을 소비한다.
        if bytes.len() == 258 && !bytes.ends_with(b"\n") { input.skip_until(b'\n')?; }
        Ok(())
    });
    drop(echo);
    if !from_stdin { eprintln!(); }
    result.map_err(|_| "비밀번호 입력 실패")?;
    let mut value = String::from_utf8(bytes).map_err(|_| "비밀번호는 UTF-8이어야 합니다")?;
    if value.ends_with('\n') { value.pop(); if value.ends_with('\r') { value.pop(); } }
    if value.chars().count() < 12 || value.len() > 256 {
        return Err("비밀번호는 12자 이상, 256바이트 이하여야 합니다".into());
    }
    Ok(value)
}

#[cfg(unix)]
struct EchoGuard(libc::termios, libc::sigaction, libc::sigaction);
#[cfg(unix)]
static ORIGINAL_TERMINAL: std::sync::OnceLock<libc::termios> = std::sync::OnceLock::new();
#[cfg(unix)]
extern "C" fn cancel_password(signal: libc::c_int) {
    if let Some(original) = ORIGINAL_TERMINAL.get() {
        // tcsetattr와 _exit는 POSIX async-signal-safe 호출이다.
        unsafe { libc::tcsetattr(0, libc::TCSANOW, original); }
    }
    unsafe { libc::_exit(128 + signal); }
}
#[cfg(unix)]
impl EchoGuard {
    fn hide() -> Result<Self, String> {
        let mut original = std::mem::MaybeUninit::uninit();
        if unsafe { libc::tcgetattr(0, original.as_mut_ptr()) } != 0 { return Err("터미널 모드 조회 실패".into()); }
        let original = unsafe { original.assume_init() };
        ORIGINAL_TERMINAL.set(original).map_err(|_| "비밀번호 입력은 명령당 한 번만 가능합니다")?;
        let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
        action.sa_sigaction = cancel_password as *const () as usize;
        unsafe { libc::sigemptyset(&mut action.sa_mask); }
        let mut interrupt = std::mem::MaybeUninit::uninit();
        if unsafe { libc::sigaction(libc::SIGINT, &action, interrupt.as_mut_ptr()) } != 0 {
            return Err("취소 처리 설정 실패".into());
        }
        let interrupt = unsafe { interrupt.assume_init() };
        let mut terminate = std::mem::MaybeUninit::uninit();
        if unsafe { libc::sigaction(libc::SIGTERM, &action, terminate.as_mut_ptr()) } != 0 {
            unsafe { libc::sigaction(libc::SIGINT, &interrupt, std::ptr::null_mut()); }
            return Err("종료 처리 설정 실패".into());
        }
        let guard = Self(original, interrupt, unsafe { terminate.assume_init() });
        let mut hidden = original;
        hidden.c_lflag &= !(libc::ECHO | libc::ECHONL);
        if unsafe { libc::tcsetattr(0, libc::TCSANOW, &hidden) } != 0 { return Err("비밀번호 숨김 입력 설정 실패".into()); }
        Ok(guard)
    }
}
#[cfg(unix)]
impl Drop for EchoGuard {
    fn drop(&mut self) {
        unsafe {
            libc::tcsetattr(0, libc::TCSANOW, &self.0);
            libc::sigaction(libc::SIGINT, &self.1, std::ptr::null_mut());
            libc::sigaction(libc::SIGTERM, &self.2, std::ptr::null_mut());
        }
    }
}

#[cfg(windows)]
struct EchoGuard(windows_sys::Win32::Foundation::HANDLE, u32);
#[cfg(windows)]
static ORIGINAL_CONSOLE_MODE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
#[cfg(windows)]
unsafe extern "system" fn cancel_password(_: u32) -> windows_sys::core::BOOL {
    use windows_sys::Win32::System::Console::*;
    unsafe {
        SetConsoleMode(GetStdHandle(STD_INPUT_HANDLE), ORIGINAL_CONSOLE_MODE.load(std::sync::atomic::Ordering::Relaxed));
    }
    0 // 원래 Windows 종료 처리를 계속한다.
}
#[cfg(windows)]
impl EchoGuard {
    fn hide() -> Result<Self, String> {
        use windows_sys::Win32::System::Console::*;
        let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        let mut mode = 0;
        if unsafe { GetConsoleMode(handle, &mut mode) } == 0 {
            return Err("비밀번호 숨김 입력 설정 실패".into());
        }
        ORIGINAL_CONSOLE_MODE.store(mode, std::sync::atomic::Ordering::Relaxed);
        if unsafe { SetConsoleCtrlHandler(Some(cancel_password), 1) } == 0 { return Err("취소 처리 설정 실패".into()); }
        let guard = Self(handle, mode);
        if unsafe { SetConsoleMode(handle, mode & !ENABLE_ECHO_INPUT) } == 0 { return Err("비밀번호 숨김 입력 설정 실패".into()); }
        Ok(guard)
    }
}
#[cfg(windows)]
impl Drop for EchoGuard {
    fn drop(&mut self) {
        use windows_sys::Win32::System::Console::*;
        unsafe { SetConsoleMode(self.0, self.1); SetConsoleCtrlHandler(Some(cancel_password), 0); }
    }
}
