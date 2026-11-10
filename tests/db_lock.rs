//! SQLite 잠금 경합(DB-010): WAL + busy timeout 5초 + 서버 쓰기 연결 1개.
mod common;

use common::*;
use reqwest::StatusCode;
use serde_json::json;
use std::time::{Duration, Instant};

/// 외부 연결이 `hold` 동안 쓰기 잠금을 잡는다.
fn hold_write_lock(db: std::path::PathBuf, hold: Duration) -> (std::thread::JoinHandle<()>, std::sync::mpsc::Receiver<()>) {
    let (tx, rx) = std::sync::mpsc::channel();
    let h = std::thread::spawn(move || {
        let c = rusqlite::Connection::open(db).unwrap();
        c.execute_batch("BEGIN IMMEDIATE").unwrap();
        tx.send(()).unwrap();
        std::thread::sleep(hold);
        c.execute_batch("COMMIT").unwrap();
    });
    (h, rx)
}

#[tokio::test]
async fn short_lock_waits_and_long_lock_returns_retryable_busy() {
    let s = TestServer::start().await;
    let db = s.data_dir().join("grove.db");
    let dir1 = s.make_project_dir("one");
    let dir2 = s.make_project_dir("two");

    // 짧은 잠금: 기다렸다 성공
    let (h, rx) = hold_write_lock(db.clone(), Duration::from_millis(1200));
    rx.recv().unwrap();
    let t = Instant::now();
    let (st, v) = s.post("/api/v1/projects", json!({ "root_path": dir1 })).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    assert!(t.elapsed() >= Duration::from_millis(900), "잠금이 풀릴 때까지 기다려야 한다: {:?}", t.elapsed());
    h.join().unwrap();

    // busy timeout보다 긴 잠금: 숨기지 않고 재시도 가능한 busy
    let (h, rx) = hold_write_lock(db.clone(), Duration::from_millis(6500));
    rx.recv().unwrap();
    let (st, v) = s.post("/api/v1/projects", json!({ "root_path": dir2 })).await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"]["code"], "busy");
    assert_eq!(v["error"]["retryable"], true);
    // 읽기는 WAL이라 잠금 중에도 된다
    let (st, _) = s.get("/api/v1/projects").await;
    assert_eq!(st, StatusCode::OK);
    h.join().unwrap();
    // 풀린 뒤 재시도 성공, 실패한 시도는 흔적을 남기지 않는다
    let (st, v) = s.post("/api/v1/projects", json!({ "root_path": dir2 })).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let (_, list) = s.get("/api/v1/projects").await;
    assert_eq!(list.as_array().unwrap().len(), 2);
    let c = rusqlite::Connection::open(&db).unwrap();
    let ok: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
    assert_eq!(ok, "ok");
    let mode: String = c.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
    assert_eq!(mode, "wal");
}
