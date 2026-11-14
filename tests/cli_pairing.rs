//! 임시 데몬을 통한 CLI·HTTP 계약. 실제 사용자 데이터와 외부 서버는 사용하지 않는다.
use reqwest::blocking::Client;
use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};

struct Daemon(std::process::Child);
impl Drop for Daemon {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}

#[cfg(unix)]
fn check_password_terminal(data: &std::path::Path, listen: &str, cancel: bool) {
    use std::io::Read;
    use std::os::fd::FromRawFd;
    let (mut master, mut slave) = (-1, -1);
    assert_eq!(unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null(), std::ptr::null()) }, 0);
    let mut master = unsafe { std::fs::File::from_raw_fd(master) };
    let slave = unsafe { std::fs::File::from_raw_fd(slave) };
    let flags = || {
        use std::os::fd::AsRawFd;
        let mut term = std::mem::MaybeUninit::uninit();
        assert_eq!(unsafe { libc::tcgetattr(slave.as_raw_fd(), term.as_mut_ptr()) }, 0);
        unsafe { term.assume_init().c_lflag }
    };
    let original = flags();
    let mut child = Command::new(env!("CARGO_BIN_EXE_grove"))
        .args(["pairing", "create", "PTY", "--endpoint", "wss://example.test/api/e2ee", "--json", "--listen", listen, "--data-dir"])
        .arg(data).stdin(slave.try_clone().unwrap()).stdout(slave.try_clone().unwrap()).stderr(slave.try_clone().unwrap())
        .spawn().unwrap();
    let mut reader = master.try_clone().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let output = std::thread::spawn(move || {
        let mut bytes = vec![];
        let mut ready = false;
        loop {
            let mut byte = [0];
            match reader.read(&mut byte) {
                Ok(0) => break,
                Ok(_) => {
                    bytes.push(byte[0]);
                    if !ready && bytes.ends_with(b": ") { tx.send(()).unwrap(); ready = true; }
                }
                Err(e) if e.raw_os_error() == Some(libc::EIO) => break,
                Err(e) => panic!("PTY 읽기 실패: {e}"),
            }
        }
        bytes
    });
    rx.recv_timeout(std::time::Duration::from_secs(10)).expect("비밀번호 프롬프트");
    assert_eq!(flags() & libc::ECHO, 0, "비밀번호 입력 중 echo는 꺼져야 한다");
    if cancel { assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGINT) }, 0); }
    else { master.write_all(b"pty-only-fixture-password\n").unwrap(); }
    let status = child.wait().unwrap();
    let restored = flags() & libc::ECHO == original & libc::ECHO;
    drop(slave);
    let output = output.join().unwrap();
    assert!(restored, "종료·취소 후 터미널 echo를 복원해야 한다");
    assert!(!output.windows(b"pty-only-fixture-password".len()).any(|part| part == b"pty-only-fixture-password"));
    if cancel { assert_eq!(status.code(), Some(130)); } else { assert!(status.success()); }
}

#[test]
fn help_and_invalid_pairing_arguments_do_not_touch_data() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    for args in [
        vec!["pairing", "--help"], vec!["pairing"],
        vec!["pairing", "create", "--password", "must-not-echo"],
        vec!["pairing", "revoke", "../devices"],
        vec!["pairing", "list", "--password-stdin"],
    ] {
        let out = Command::new(env!("CARGO_BIN_EXE_grove")).args(&args)
            .env("GROVE_DATA_DIR", &data).output().unwrap();
        assert_eq!(out.status.success(), args.len() <= 2);
        assert!(!String::from_utf8_lossy(&out.stderr).contains("must-not-echo"));
        assert!(!data.exists());
    }
}

#[test]
fn cli_pairing_creates_links_checks_codes_and_preserves_approval_boundaries() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let listen = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().to_string();
    let base = format!("http://{listen}/api/v1");
    let client = Client::builder().no_proxy().timeout(std::time::Duration::from_secs(5)).build().unwrap();
    let mut server = Command::new(env!("CARGO_BIN_EXE_grove"));
    server.args(["serve", "--listen", &listen, "--data-dir"]).arg(&data).stdout(Stdio::null()).stderr(Stdio::null());
    let _daemon = Daemon(server.spawn().unwrap());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        if client.get(format!("{base}/health")).send().is_ok_and(|r| r.status().is_success()) { break; }
        assert!(std::time::Instant::now() < deadline, "임시 데몬 준비 시간 초과");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let owner = std::fs::read_to_string(data.join("owner-token")).unwrap();
    #[cfg(unix)]
    {
        check_password_terminal(&data, &listen, false);
        check_password_terminal(&data, &listen, true);
    }
    let run = |args: &[&str], input: Option<&str>| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_grove"));
        command.arg("pairing").args(args).args(["--listen", &listen, "--data-dir"]).arg(&data)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        if let Some(input) = input { child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap(); }
        else { drop(child.stdin.take()); }
        let out = child.wait_with_output().unwrap();
        assert!(!String::from_utf8_lossy(&out.stdout).contains(owner.trim()));
        assert!(!String::from_utf8_lossy(&out.stderr).contains(owner.trim()));
        out
    };
    let password = "test-only!";
    let create = |name: &str| {
        let out = run(&["create", name, "--endpoint", "wss://example.test/api/e2ee", "--password-stdin", "--json"], Some(&format!("{password}\n")));
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(!String::from_utf8_lossy(&out.stdout).contains(password));
        assert!(!String::from_utf8_lossy(&out.stderr).contains(password));
        serde_json::from_slice::<Value>(&out.stdout).unwrap()
    };
    assert!(!run(&["create", "--endpoint", "wss://example.test/api/e2ee"], Some(password)).status.success());
    assert!(!run(&["create", "--endpoint", "wss://example.test/api/e2ee", "--password-stdin"], Some("123456789\n")).status.success());
    assert!(!run(&["create", "--endpoint", "wss://example.test/api/e2ee", "--password-stdin"], Some(&format!("{}\n", "x".repeat(300)))).status.success());
    let pair = create("CLI 기기");
    let link = reqwest::Url::parse(pair["link"].as_str().unwrap()).unwrap();
    assert_eq!(link.origin().ascii_serialization(), grove::e2ee::PAGES_ORIGIN.trim_end_matches('/'));
    let params: std::collections::HashMap<_, _> = reqwest::Url::parse(&format!("https://unused.invalid/?{}", link.fragment().unwrap()))
        .unwrap().query_pairs().into_owned().collect();
    assert_eq!(params["connect"], "wss://example.test/api/e2ee");
    let identity: Value = client.get(format!("{base}/e2ee/identity")).bearer_auth(owner.trim()).send().unwrap().json().unwrap();
    assert_eq!(params["key"], identity["key"].as_str().unwrap());
    let pending: Value = client.post(format!("{base}/auth/pairing"))
        .json(&json!({"code": params["pairing"], "password": password, "name": "CLI 폰"})).send().unwrap().error_for_status().unwrap().json().unwrap();
    let list = run(&["list"], None);
    assert!(list.status.success());
    assert!(!String::from_utf8_lossy(&list.stdout).contains(&params["pairing"]));
    let list: Value = serde_json::from_slice(&list.stdout).unwrap();
    let request = &list[0]["requests"][0];
    let id = pair["id"].as_str().unwrap();
    let request_id = request["id"].as_str().unwrap();
    let code = request["verification_code"].as_str().unwrap();
    assert!(!run(&["approve", id, request_id, "WRONG"], None).status.success());
    let waiting = client.post(format!("{base}/auth/pairing/claim")).json(&json!({"code": pending["code"]})).send().unwrap();
    assert_eq!(waiting.status(), 202);
    assert!(run(&["approve", id, request_id, code], None).status.success());
    let claimed = client.post(format!("{base}/auth/pairing/claim")).json(&json!({"code": pending["code"]})).send().unwrap();
    assert_eq!(claimed.status(), 200);
    let session: Value = claimed.json().unwrap();
    assert!(run(&["revoke", id], None).status.success());
    assert_eq!(client.get(format!("{base}/auth/whoami")).bearer_auth(session["access_token"].as_str().unwrap()).send().unwrap().status(), 200);
    let second = create("거절할 기기");
    let link = reqwest::Url::parse(second["link"].as_str().unwrap()).unwrap();
    let params: std::collections::HashMap<_, _> = reqwest::Url::parse(&format!("https://unused.invalid/?{}", link.fragment().unwrap())).unwrap().query_pairs().into_owned().collect();
    let pending: Value = client.post(format!("{base}/auth/pairing")).json(&json!({"code": params["pairing"], "password": password, "name": "거절"}))
        .send().unwrap().error_for_status().unwrap().json().unwrap();
    let list: Value = serde_json::from_slice(&run(&["list"], None).stdout).unwrap();
    assert!(run(&["reject", second["id"].as_str().unwrap(), list[0]["requests"][0]["id"].as_str().unwrap()], None).status.success());
    assert_eq!(client.post(format!("{base}/auth/pairing/claim")).json(&json!({"code": pending["code"]})).send().unwrap().status(), 410);
}
