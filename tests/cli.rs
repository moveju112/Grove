//! 실제 실행 파일의 명령행 계약(ARCH-007 일부)과 snapshot/restore(DB-016/017).

use std::process::Command;

fn grove() -> Command {
    Command::new(env!("CARGO_BIN_EXE_grove"))
}

#[test]
fn help_and_version_do_not_start_server_or_touch_data() {
    let d = tempfile::tempdir().unwrap();
    for args in [vec!["--version"], vec!["-V"], vec!["version"], vec!["--help"], vec!["-h"], vec!["help"]] {
        let out = grove().args(&args).env("GROVE_DATA_DIR", d.path().join("data")).output().unwrap();
        assert!(out.status.success(), "{args:?}");
        let s = String::from_utf8_lossy(&out.stdout);
        assert!(s.contains("grove"), "{s}");
    }
    assert!(!d.path().join("data").exists(), "도움말·버전은 데이터 디렉터리를 만들지 않는다");
}

#[test]
fn invalid_arguments_fail_without_side_effects() {
    let d = tempfile::tempdir().unwrap();
    for args in [vec!["--nope"], vec!["serve", "--listen"], vec!["serve", "--listen", "not-an-addr"], vec!["frobnicate"]] {
        let out = grove().args(&args).env("GROVE_DATA_DIR", d.path().join("data")).output().unwrap();
        assert!(!out.status.success(), "{args:?}");
    }
    assert!(!d.path().join("data").exists());
}

#[test]
fn legacy_token_login_commands_direct_to_pairing() {
    let d = tempfile::tempdir().unwrap();
    let out = grove().args(["token", "--data-dir"]).arg(d.path()).output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("grove pairing create"));
}

#[test]
fn snapshot_and_restore_into_new_directory() {
    let d = tempfile::tempdir().unwrap();
    let data = d.path().join("data");
    // 서버 없이 DB를 만든다(마이그레이션 적용)
    let db = grove::store::Db::open(&{
        std::fs::create_dir_all(&data).unwrap();
        data.join("grove.db")
    })
    .unwrap();
    db.call_sync(|c| {
        c.execute(
            "INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('p1', 'x', '/tmp', 't', 't')",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let before = std::fs::read(data.join("grove.db")).unwrap();
    let snap = d.path().join("snap.db");
    let out = grove().args(["snapshot"]).arg(&snap).args(["--data-dir"]).arg(&data).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    // 기존 파일 덮어쓰기 거부
    let out = grove().args(["snapshot"]).arg(&snap).args(["--data-dir"]).arg(&data).output().unwrap();
    assert!(!out.status.success());
    let restored = d.path().join("restored");
    let out = grove().args(["restore"]).arg(&snap).arg(&restored).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let r = grove::store::Db::open(&restored.join("grove.db")).unwrap();
    let n: i64 = r.call_sync(|c| Ok(c.query_row("SELECT COUNT(*) FROM projects", [], |x| x.get(0))?)).unwrap();
    assert_eq!(n, 1);
    // 비어 있지 않은 디렉터리로 복원 거부, 원본 불변
    let out = grove().args(["restore"]).arg(&snap).arg(&restored).output().unwrap();
    assert!(!out.status.success());
    // 원본 불변: WAL checkpoint로 파일 크기는 바뀔 수 있으므로 논리 내용과 무결성으로 비교한다.
    let _ = before;
    let n: i64 = db.call_sync(|c| Ok(c.query_row("SELECT COUNT(*) FROM projects", [], |x| x.get(0))?)).unwrap();
    assert_eq!(n, 1);
    drop(db);
    grove::backup::verify(&data.join("grove.db")).unwrap();
    // 손상된 snapshot 거부
    let bad = d.path().join("bad.db");
    std::fs::write(&bad, b"not a database").unwrap();
    let out = grove().args(["restore"]).arg(&bad).arg(d.path().join("r2")).output().unwrap();
    assert!(!out.status.success());
    assert!(!d.path().join("r2").exists());
}

/// Linux 신호 세 종류가 모두 같은 정상 종료 경로(실행 정리 → flush)를 탄다(ARCH-013).
/// 특히 SIGHUP(터미널 닫힘)은 이전에는 처리하지 않아 정리 없이 바로 죽었다.
#[cfg(unix)]
#[test]
fn signals_take_the_same_graceful_shutdown_path() {
    for (sig, cause) in [("INT", "Interrupt"), ("TERM", "Terminate"), ("HUP", "ConsoleClosed")] {
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("data");
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let listen = format!("127.0.0.1:{port}");
        let server = grove()
            .args(["serve", "--data-dir"])
            .arg(&data)
            .args(["--listen", &listen])
            .env("NO_COLOR", "1")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let out = grove().args(["doctor", "--data-dir"]).arg(&data).args(["--listen", &listen]).output().unwrap();
            if json_out(&out)["api"]["status"] == "ready" {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "서버 준비 시간 초과");
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let st = Command::new("kill").args(["-s", sig, &server.id().to_string()]).status().unwrap();
        assert!(st.success());
        let started = std::time::Instant::now();
        let out = server.wait_with_output().unwrap();
        let log = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        assert!(out.status.success(), "SIG{sig}: 정상 종료 코드여야 한다: {:?}\n{log}", out.status);
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "SIG{sig}: 종료가 늦다");
        assert!(log.contains(cause), "SIG{sig}: 종료 원인 기록: {log}");
        assert!(log.contains("서버 종료 완료"), "SIG{sig}: 정리 경로 완료: {log}");
        // flush: WAL이 checkpoint되어 비어 있거나 없다.
        let wal = data.join("grove.db-wal");
        assert!(!wal.exists() || std::fs::metadata(&wal).unwrap().len() == 0, "SIG{sig}: WAL checkpoint");
    }
}

fn json_out(out: &std::process::Output) -> serde_json::Value {
    serde_json::from_slice(&out.stdout).unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&out.stdout)))
}

/// doctor·config·auth·pair 계약(ARCH-007)과 상태 단계 구분(ARCH-011).
#[test]
fn doctor_config_auth_and_pair_against_running_server() {
    let d = tempfile::tempdir().unwrap();
    let data = d.path().join("data");
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let listen = format!("127.0.0.1:{port}");
    let run = |args: &[&str]| grove().args(args).args(["--data-dir"]).arg(&data).args(["--listen", &listen]).output().unwrap();

    // 서버 전: 데이터 디렉터리를 만들지 않고 각 단계를 따로 보고한다.
    let out = run(&["doctor"]);
    assert_eq!(out.status.code(), Some(1));
    let v = json_out(&out);
    assert_eq!(v["process"]["status"], "stopped");
    assert_eq!(v["api"]["status"], "unreachable");
    assert_eq!(v["auth"]["status"], "no_token");
    assert_eq!(v["models"]["status"], "skipped");
    assert!(!data.exists(), "doctor는 데이터 디렉터리를 만들지 않는다");
    let out = run(&["config"]);
    assert!(out.status.success());
    let c = json_out(&out);
    assert_eq!(c["listen"], listen);
    assert_eq!(c["db_path"].as_str().unwrap(), data.join("grove.db").to_str().unwrap());
    assert!(!c.to_string().contains("grv_"), "비밀값 미포함");

    let mut server = grove().args(["serve", "--data-dir"]).arg(&data).args(["--listen", &listen]).stderr(std::process::Stdio::null()).spawn().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let v = json_out(&run(&["doctor"]));
        if v["api"]["status"] == "ready" && v["auth"]["status"] == "ok" {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "서버 준비 시간 초과: {v}");
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let out = run(&["doctor"]);
    let v = json_out(&out);
    assert_eq!(v["process"]["status"], "running", "{v}");
    assert_eq!(v["process"]["pid"], server.id());
    assert_eq!(v["auth"]["kind"], "owner");
    assert_eq!(v["models"]["status"], "none", "모델 프로필이 없으면 사용 불가로 따로 표시");
    assert_eq!(v["healthy"], false);
    assert_eq!(out.status.code(), Some(1));

    for args in [&["auth", "token"][..], &["token"][..], &["pair", "폰"][..], &["unlock"][..]] {
        let out = run(args);
        assert!(!out.status.success());
        assert!(out.stdout.is_empty());
        assert!(String::from_utf8_lossy(&out.stderr).contains("grove pairing create"));
    }

    server.kill().unwrap();
    server.wait().unwrap();
    let v = json_out(&run(&["doctor"]));
    assert_eq!(v["process"]["status"], "stopped", "프로세스가 죽으면 잠금도 풀린다: {v}");
    assert_eq!(v["api"]["status"], "unreachable");
    assert_eq!(v["auth"]["status"], "skipped");
}
