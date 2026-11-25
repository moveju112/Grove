#![cfg(unix)]
use crate::common;

use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};

async fn gc(s: &TestServer) -> Value {
    let app = s.server.as_ref().unwrap().app.clone();
    tokio::task::spawn_blocking(move || grove::storage::gc(&app))
        .await
        .unwrap()
        .unwrap()
}

async fn setup() -> (TestServer, String, std::path::PathBuf) {
    let s = TestServer::start().await;
    let p = s.create_project("task-logs").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let root = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
    (s, sid, root)
}

async fn run(s: &TestServer, sid: &str, command: &str) -> Value {
    let (st, t) = s
        .post(
            &format!("/api/v1/sessions/{sid}/tasks"),
            json!({"command":command}),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED, "{t}");
    let (st, v) = s
        .get(&format!(
            "/api/v1/tasks/{}/wait?timeout_ms=10000",
            t["id"].as_str().unwrap()
        ))
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    v
}

#[tokio::test]
async fn log_directory_failure_does_not_execute_or_leave_running_task() {
    let (s, sid, root) = setup().await;
    std::fs::write(s.data_dir().join("tasks"), b"occupied").unwrap();
    let t = run(&s, &sid, "touch executed").await;
    assert_eq!(t["status"], "failed", "{t}");
    assert!(!root.join("executed").exists());
    assert_eq!(t["logs"][0]["state"], "error", "{t}");
    assert_eq!(t["logs"][0]["error"], "log_create_failed");
    let (_, messages) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let note = messages["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "note")
        .unwrap();
    assert_eq!(note["content"]["log_errors"].as_array().unwrap().len(), 2);
    assert!(grove::tasks::note_text(&note["content"]).contains("로그 저장에 실패"));
}

#[tokio::test]
async fn immutable_logs_have_metadata_and_corruption_is_not_empty_success() {
    let (mut s, sid, _) = setup().await;
    let t = run(&s, &sid, "printf original; printf problem >&2").await;
    assert_eq!(t["status"], "completed", "{t}");
    let id = t["id"].as_str().unwrap();
    let out = t["logs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["stream"] == "stdout")
        .unwrap();
    assert_eq!(out["state"], "ready");
    assert_eq!(out["size"], 8);
    assert_eq!(out["sha256"], grove::util::sha256_hex(b"original"));
    assert_eq!(out["ref_count"], 1);
    assert_eq!(out["session_id"], sid);
    assert!(out["storage_key"].as_str().unwrap().starts_with("tasks/"));
    s.stop().await;
    s.restart().await;
    let (st, v) = s.get(&format!("/api/v1/tasks/{id}/output")).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["data"], "original");
    std::fs::write(
        s.data_dir().join("tasks").join(format!("{id}.out")),
        b"modified",
    )
    .unwrap();
    let (st, v) = s.get(&format!("/api/v1/tasks/{id}/output")).await;
    assert_eq!(st, StatusCode::GONE, "{v}");
    assert_eq!(v["error"]["code"], "task_log_unavailable");
    let (_, t) = s.get(&format!("/api/v1/tasks/{id}")).await;
    let out = t["logs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["stream"] == "stdout")
        .unwrap();
    assert_eq!(out["state"], "error");
    assert_eq!(out["error"], "log_hash_mismatch");
    // 손상된 원문은 증거로 보존한다.
    assert_eq!(
        std::fs::read(s.data_dir().join("tasks").join(format!("{id}.out"))).unwrap(),
        b"modified"
    );
}

#[tokio::test]
async fn gc_marks_missing_and_expired_logs_without_losing_fingerprints() {
    let (s, sid, _) = setup().await;
    let t = run(&s, &sid, "printf keep").await;
    let id = t["id"].as_str().unwrap();
    let out = s.data_dir().join("tasks").join(format!("{id}.out"));
    std::fs::remove_file(out).unwrap();
    assert_eq!(gc(&s).await["task_logs_marked"], 1);
    let (st, v) = s.get(&format!("/api/v1/tasks/{id}/output")).await;
    assert_eq!(st, StatusCode::GONE, "{v}");
    assert_eq!(v["error"]["details"]["state"], "missing");
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT sha256 FROM task_logs WHERE task_id=?1 AND stream='out'",
            [id],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        grove::util::sha256_hex(b"keep")
    );
    db.execute(
        "UPDATE tasks SET ended_at='2020-01-01T00:00:00Z' WHERE id=?1",
        [id],
    )
    .unwrap();
    let (st, v) = s
        .send(
            reqwest::Method::PUT,
            "/api/v1/settings/server/-/storage.task_log_retention_days",
            json!({"expected_revision":0,"value":1}),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    // 파일 iterator를 끝까지 소진한 다음 한 번 더 검사한다.
    for _ in 0..2 {
        gc(&s).await;
    }
    let (st, v) = s
        .get(&format!("/api/v1/tasks/{id}/output?stream=stderr"))
        .await;
    assert_eq!(st, StatusCode::GONE, "{v}");
    assert_eq!(v["error"]["details"]["state"], "expired");
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM task_logs WHERE task_id=?1",
            [id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
}

#[tokio::test]
async fn final_commit_failure_keeps_original_for_unknown_restart_without_reexecution() {
    let (mut s, sid, root) = setup().await;
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_task_finish BEFORE UPDATE OF status ON tasks WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'fixture final commit failure'); END;").unwrap();
    let (st, t) = s
        .post(
            &format!("/api/v1/sessions/{sid}/tasks"),
            json!({"command":"printf once >> marker; printf evidence"}),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED, "{t}");
    let id = t["id"].as_str().unwrap();
    if let Some(mut done) = s.server.as_ref().unwrap().app.tasks.done_rx(id) {
        tokio::time::timeout(std::time::Duration::from_secs(10), done.wait_for(|v| *v))
            .await
            .unwrap()
            .unwrap();
    }
    assert_eq!(std::fs::read(root.join("marker")).unwrap(), b"once");
    assert_eq!(
        db.query_row("SELECT status FROM tasks WHERE id=?1", [id], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "running"
    );
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM task_logs WHERE task_id=?1 AND state='writing'",
            [id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    db.execute_batch("DROP TRIGGER fail_task_finish").unwrap();
    drop(db);
    s.stop().await;
    s.restart().await;
    let (_, t) = s.get(&format!("/api/v1/tasks/{id}")).await;
    assert_eq!(t["status"], "unknown");
    gc(&s).await;
    let (st, v) = s.get(&format!("/api/v1/tasks/{id}/output")).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["data"], "evidence");
    assert_eq!(v["log"]["sha256"], grove::util::sha256_hex(b"evidence"));
    assert_eq!(std::fs::read(root.join("marker")).unwrap(), b"once");
}

#[tokio::test]
async fn migration_adopts_legacy_logs_without_rewriting_original_bytes() {
    let (mut s, sid, _) = setup().await;
    let t = run(&s, &sid, "printf legacy").await;
    let id = t["id"].as_str().unwrap();
    s.stop().await;
    {
        // 실제 v33 schema의 열만 복사한다. 새 migration을 추가해도 과거 fixture는 바뀌지 않는다.
        let staged = tempfile::NamedTempFile::new_in(s.dir.path()).unwrap();
        let legacy = rusqlite::Connection::open(staged.path()).unwrap();
        for migration in grove::store::MIGRATIONS.iter().take(33) {
            legacy.execute_batch(migration).unwrap();
        }
        legacy.pragma_update(None, "user_version", 33).unwrap();
        legacy.execute("ATTACH DATABASE ?1 AS latest", [s.data_dir().join("grove.db").to_str().unwrap()]).unwrap();
        let tables: Vec<String> = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").unwrap()
            .query_map([], |r|r.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
        for table in tables {
            let columns: Vec<String> = legacy.prepare(&format!("PRAGMA table_info({table})")).unwrap()
                .query_map([], |r|r.get(1)).unwrap().collect::<Result<_,_>>().unwrap();
            let columns = columns.join(",");
            legacy.execute_batch(&format!("DELETE FROM {table}; INSERT INTO {table}({columns}) SELECT {columns} FROM latest.{table};")).unwrap();
        }
        legacy.execute_batch("DETACH DATABASE latest").unwrap();
        let mut target = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
        rusqlite::backup::Backup::new(&legacy, &mut target).unwrap()
            .run_to_completion(256, std::time::Duration::from_millis(5), None).unwrap();
    }
    s.restart().await;
    let (_, t) = s.get(&format!("/api/v1/tasks/{id}")).await;
    assert_eq!(t["logs"][0]["state"], "writing");
    let (st, v) = s.get(&format!("/api/v1/tasks/{id}/output")).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["data"], "legacy");
    assert_eq!(v["log"]["state"], "ready");
    assert_eq!(v["log"]["sha256"], grove::util::sha256_hex(b"legacy"));
}

#[tokio::test]
async fn legacy_hashing_advances_with_a_bounded_byte_budget_and_preserves_unknown() {
    let (s, sid, _) = setup().await;
    for _ in 0..5 {
        run(&s, &sid, "printf retained").await;
    }
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute(
        "UPDATE task_logs SET state='writing',sha256=NULL,size=0",
        [],
    )
    .unwrap();
    db.execute(
        "UPDATE tasks SET status='unknown',ended_at='2020-01-01T00:00:00Z'",
        [],
    )
    .unwrap();
    for expected in [4, 8, 10] {
        gc(&s).await;
        let ready = db
            .query_row(
                "SELECT COUNT(*) FROM task_logs WHERE state='ready'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(
            ready, expected,
            "한 번에 최대 32MiB(최대 파일 4개)를 검증한다"
        );
    }
    assert_eq!(
        std::fs::read_dir(s.data_dir().join("tasks"))
            .unwrap()
            .count(),
        10
    );
}

#[tokio::test]
async fn symlink_log_is_neither_previewed_nor_followed() {
    let (s, sid, root) = setup().await;
    let t = run(&s, &sid, "printf log").await;
    let id = t["id"].as_str().unwrap();
    let log = s.data_dir().join("tasks").join(format!("{id}.out"));
    let target = root.join("unrelated");
    std::fs::write(&target, b"outside-log").unwrap();
    std::fs::remove_file(&log).unwrap();
    std::os::unix::fs::symlink(&target, &log).unwrap();
    let (_, t) = s.get(&format!("/api/v1/tasks/{id}")).await;
    assert_eq!(t["stdout_tail"], "");
    let (st, v) = s.get(&format!("/api/v1/tasks/{id}/output")).await;
    assert_eq!(st, StatusCode::GONE, "{v}");
    assert_eq!(v["error"]["details"]["reason"], "log_invalid_file");
    gc(&s).await;
    assert_eq!(std::fs::read(target).unwrap(), b"outside-log");
    assert!(
        std::fs::symlink_metadata(log)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}
