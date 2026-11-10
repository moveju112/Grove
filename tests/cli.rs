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
