//! 실제 CLI의 파일 로그·기본 stderr·시작 실패 계약(DB-019).
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn grove() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_grove"));
    cmd.env("GROVE_LOG", "info");
    cmd
}

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn file_log_rotates_at_startup_and_records_normal_shutdown() {
    let d = tempfile::tempdir().unwrap();
    let data = d.path().join("data");
    let path = d.path().join("logs/server.log");
    std::fs::create_dir(path.parent().unwrap()).unwrap();
    std::fs::write(&path, vec![b'x'; 2 * 1024 * 1024]).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let listen = format!("127.0.0.1:{port}");
    let mut server = Server(
        grove()
            .args(["serve", "--data-dir"])
            .arg(&data)
            .args(["--listen", &listen, "--log-file"])
            .arg(&path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if client
            .get(format!("http://{listen}/api/v1/health"))
            .send()
            .is_ok_and(|r| r.status().is_success())
        {
            break;
        }
        assert!(
            server.0.try_wait().unwrap().is_none(),
            "서버가 준비 전에 종료됨"
        );
        assert!(Instant::now() < deadline, "서버 준비 시간 초과");
        std::thread::sleep(Duration::from_millis(25));
    }
    let first = std::fs::read(&path).unwrap();
    let second_data = d.path().join("second-data");
    let duplicate = grove()
        .args(["serve", "--listen", "127.0.0.1:0", "--data-dir"])
        .arg(&second_data)
        .arg("--log-file")
        .arg(&path)
        .output()
        .unwrap();
    assert!(!duplicate.status.success());
    assert_eq!(duplicate.status.code(), Some(15));
    let error = String::from_utf8_lossy(&duplicate.stderr);
    assert!(error.contains(path.to_str().unwrap()) && error.contains("조치:"), "{error}");
    assert!(!second_data.exists());
    assert_eq!(std::fs::read(&path).unwrap(), first);
    let token = std::fs::read_to_string(data.join("owner-token")).unwrap();
    let response = client
        .post(format!("http://{listen}/api/v1/admin/shutdown"))
        .bearer_auth(token.trim())
        .json(&serde_json::json!({}))
        .send()
        .unwrap();
    assert!(response.status().is_success());
    loop {
        if let Some(status) = server.0.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(Instant::now() < deadline, "서버 종료 시간 초과");
        std::thread::sleep(Duration::from_millis(25));
    }
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains("서버 준비 완료") && text.contains("서버 종료 중"));
    assert!(text.contains(grove::VERSION));
    assert!(!text.contains('\x1b') && !text.contains(token.trim()));
    assert_eq!(
        std::fs::metadata(path.with_file_name("server.log.1"))
            .unwrap()
            .len(),
        2 * 1024 * 1024
    );
}

#[test]
fn startup_failure_is_recorded_in_the_selected_output() {
    let d = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let listen = listener.local_addr().unwrap().to_string();
    for file_log in [false, true] {
        let path = d.path().join("server.log");
        let mut cmd = grove();
        cmd.args(["serve", "--listen", &listen, "--data-dir"])
            .arg(d.path().join(if file_log { "file" } else { "stderr" }));
        if file_log {
            cmd.arg("--log-file").arg(&path);
        }
        let out = cmd.output().unwrap();
        assert!(!out.status.success());
        let text = if file_log {
            std::fs::read_to_string(path).unwrap()
        } else {
            String::from_utf8(out.stderr).unwrap()
        };
        assert!(text.contains("서버 실행 실패") && text.contains("이미 사용 중"));
        assert!(!text.contains("서버 준비 완료"));
    }
}

#[test]
fn detailed_logging_is_opt_in_and_expired_slots_are_removed_before_startup() {
    let d = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let listen = listener.local_addr().unwrap().to_string();
    for (i, level) in [None, Some("info"), Some("debug"), Some("trace"), Some("[invalid")].into_iter().enumerate() {
        let path = d.path().join(format!("server-{i}.log"));
        let archive = path.with_extension("log.1");
        let expired = std::fs::File::create(&archive).unwrap();
        use std::io::Write;
        (&expired).write_all(b"expired debug detail\n").unwrap();
        expired.set_modified(std::time::SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60)).unwrap();
        drop(expired);
        let mut cmd = grove();
        cmd.env_remove("GROVE_LOG");
        if let Some(level) = level {
            cmd.env("GROVE_LOG", level);
        }
        let out = cmd.args(["serve", "--listen", &listen, "--data-dir"])
            .arg(d.path().join(format!("data-{i}")))
            .arg("--log-file").arg(&path).output().unwrap();
        assert!(!out.status.success());
        let text = std::fs::read_to_string(path).unwrap();
        assert!(text.contains("서버 실행 실패"), "{text}");
        assert_eq!(text.contains("개발용 상세 로그 활성화"), matches!(level, Some("debug" | "trace")), "{text}");
        assert!(!archive.exists());
    }
}

#[test]
fn invalid_log_target_fails_before_server_data_is_created() {
    let d = tempfile::tempdir().unwrap();
    let data = d.path().join("data");
    let out = grove()
        .args(["serve", "--data-dir"])
        .arg(&data)
        .arg("--log-file")
        .arg(d.path())
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert_eq!(out.status.code(), Some(15));
    let error = String::from_utf8_lossy(&out.stderr);
    assert!(error.contains(d.path().to_str().unwrap()) && error.contains("조치:"), "{error}");
    assert!(!data.exists());
    let out = grove()
        .args(["serve", "--data-dir"])
        .arg(&data)
        .arg("--log-file")
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(!data.exists());
}
