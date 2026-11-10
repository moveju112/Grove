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
fn token_before_first_start_explains() {
    let d = tempfile::tempdir().unwrap();
    let out = grove().args(["token", "--data-dir"]).arg(d.path()).output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("서버를 한 번 실행하면"));
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

    // auth token은 token과 같은 값
    let a = run(&["auth", "token"]);
    let t = run(&["token"]);
    assert!(a.status.success());
    assert_eq!(a.stdout, t.stdout);
    assert!(!run(&["auth", "nope"]).status.success());

    // pair: 새 기기 토큰으로 인증되고, 소유자 토큰과 다르다
    let out = run(&["pair", "폰"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let p = json_out(&out);
    assert_eq!(p["name"], "폰");
    let tok = p["token"].as_str().unwrap();
    assert_ne!(tok, String::from_utf8_lossy(&t.stdout).trim());
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let who: serde_json::Value = rt.block_on(async {
        reqwest::Client::new().get(format!("http://{listen}/api/v1/auth/whoami")).bearer_auth(tok).send().await.unwrap().json().await.unwrap()
    });
    assert_eq!(who["kind"], "device", "{who}");

    server.kill().unwrap();
    server.wait().unwrap();
    let v = json_out(&run(&["doctor"]));
    assert_eq!(v["process"]["status"], "stopped", "프로세스가 죽으면 잠금도 풀린다: {v}");
    assert_eq!(v["api"]["status"], "unreachable");
    assert_eq!(v["auth"]["status"], "skipped");
    assert!(!run(&["pair"]).status.success(), "서버가 없으면 실패");
}

#[test]
fn unlock_clears_lockouts() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path()).unwrap();
    let db = grove::store::Db::open(&d.path().join("grove.db")).unwrap();
    db.call_sync(|c| {
        c.execute("INSERT INTO login_failures (client, count, first_at, locked_until) VALUES ('1.2.3.4', 0, 't', '9999')", [])?;
        Ok(())
    })
    .unwrap();
    let out = grove().args(["unlock", "--data-dir"]).arg(d.path()).output().unwrap();
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("1건"));
}
