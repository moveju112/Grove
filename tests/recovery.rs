//! DB-015: 손상·쓰기 권한·용량 오류는 실행을 멈추고 원본을 보존한 별도 복구로 넘긴다.
mod common;

use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};
use std::process::Command;

fn offline(path: &std::path::Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_grove")).args(["doctor", "--offline", "--data-dir"]).arg(path).output().unwrap()
}

#[test]
fn offline_diagnostics_never_create_or_migrate_data_and_preserve_damaged_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing");
    let result = offline(&missing);
    assert_eq!(result.status.code(), Some(1));
    assert!(!missing.exists());
    let report: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["mode"], "offline_read_only");
    assert_eq!(report["database"]["code"], "storage_io");
    let data = dir.path().join("data");
    std::fs::create_dir(&data).unwrap();
    let path = data.join("grove.db");
    std::fs::write(&path, "not a database").unwrap();
    let before = std::fs::read(&path).unwrap();
    let result = offline(&data);
    assert_eq!(result.status.code(), Some(1));
    let report: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["database"]["code"], "storage_corrupt");
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(!data.join("secret.key").exists());
    assert!(!data.join("owner-token").exists());

    // 오래된 DB도 읽기만 한다. doctor가 migration·키 발급·서버 시작을 하지 않는다.
    let old = dir.path().join("old");
    std::fs::create_dir(&old).unwrap();
    let path = old.join("grove.db");
    {
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('original'); PRAGMA user_version=1;").unwrap();
    }
    let before = std::fs::read(&path).unwrap();
    let result = offline(&old);
    assert!(result.status.success());
    let report: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["database"]["schema"], 1);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(!old.join("secret.key").exists());
    assert!(!old.join("owner-token").exists());
    let invalid = Command::new(env!("CARGO_BIN_EXE_grove")).args(["serve", "--offline", "--data-dir"]).arg(&missing).output().unwrap();
    assert_eq!(invalid.status.code(), Some(2));
    assert!(!missing.exists());
}

#[test]
fn read_only_failure_latches_and_no_later_db_operation_runs() {
    let dir = tempfile::tempdir().unwrap();
    let db = grove::store::Db::open(&dir.path().join("grove.db")).unwrap();
    db.call_sync(|c| { c.pragma_update(None, "query_only", true)?; Ok(()) }).unwrap();
    let error = db.call_sync(|c| { c.execute_batch("CREATE TABLE forbidden_write(value TEXT)")?; Ok(()) }).unwrap_err();
    assert_eq!(error.code, "storage_permission");
    assert_eq!(db.recovery_reason(), Some("storage_permission"));
    let mut called = false;
    let error = db.call_sync(|_| { called = true; Ok(()) }).unwrap_err();
    assert!(!called);
    assert_eq!(error.code, "storage_recovery_required");
    assert_eq!(error.details.unwrap()["reason"], "storage_permission");
}

#[tokio::test]
async fn ordinary_conflicts_and_busy_errors_do_not_latch_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let db = grove::store::Db::open(&dir.path().join("grove.db")).unwrap();
    for error in [grove::error::ApiError::busy("busy"), grove::error::ApiError::conflict("revision_conflict", "changed")] {
        assert!(db.call::<(), _>(move |_| Err(error)).await.is_err());
        assert!(db.recovery_reason().is_none());
        assert_eq!(db.call(|c| Ok(c.query_row("SELECT 1", [], |r| r.get::<_, i64>(0))?)).await.unwrap(), 1);
    }
}

#[tokio::test]
async fn recovery_guard_keeps_health_readable_but_rejects_other_api_requests() {
    let dir = tempfile::tempdir().unwrap();
    let app = grove::App::new(config(&dir.path().join("data")), std::sync::Arc::new(grove::util::SystemClock)).unwrap();
    let token = grove::auth::ensure_owner_token(&app).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(axum::serve(listener, grove::router(app.clone())).into_future());
    let error = app.db.call::<(), _>(|_| Err(rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_IOERR), None).into())).await.unwrap_err();
    assert_eq!(error.code, "storage_io");
    let client = reqwest::Client::new();
    let health = client.get(format!("http://{addr}/api/v1/health")).send().await.unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    assert_eq!(health.json::<Value>().await.unwrap()["status"], "recovery_required");
    let response = client.get(format!("http://{addr}/api/v1/projects")).bearer_auth(&token).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(response.headers().contains_key("x-request-id"));
    assert_eq!(response.json::<Value>().await.unwrap()["error"]["code"], "storage_recovery_required");
    server.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn a_pty_returning_after_shutdown_is_reaped_instead_of_admitted() {
    let mut s = TestServer::start().await;
    let project = s.create_project("late-pty").await;
    let (status, _) = s.send(reqwest::Method::PUT, "/api/v1/settings/server/-/exec.shell", json!({ "expected_revision": 0, "value": "sh" })).await;
    assert_eq!(status, StatusCode::OK);
    let app = s.server.as_ref().unwrap().app.clone();
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("authorization", format!("Bearer {}", s.token).parse().unwrap());
    headers.insert("idempotency-key", "late-pty".parse().unwrap());
    let principal = grove::auth::authenticate(&app, &headers).await.unwrap();
    app.shutdown_tx.send_replace(true);
    // handler를 직접 호출해 HTTP 진입 차단 이후에 완료되는 PTY 생성의 등록 경로를 확인한다.
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), grove::terminals::create(
        axum::extract::State(app.clone()), principal, headers,
        axum::extract::Path(project["id"].as_str().unwrap().to_string()),
        axum::Json(serde_json::from_value(json!({})).unwrap()),
    )).await.unwrap();
    assert_eq!(result.unwrap_err().code, "shutting_down");
    let count = app.db.call(|c| Ok(c.query_row("SELECT COUNT(*) FROM terminals", [], |r| r.get::<_, i64>(0))?)).await.unwrap();
    assert_eq!(count, 0);
    s.server.take().unwrap().stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn actual_sqlite_full_stops_live_work_and_restart_keeps_the_result_unknown() {
    let mut s = TestServer::start().await;
    let project = s.create_project("full").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap();
    let (status, task) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({ "command": "sleep 60" })).await;
    assert_eq!(status, StatusCode::CREATED);
    let task_id = task["id"].as_str().unwrap().to_string();
    let app = s.server.as_ref().unwrap().app.clone();
    let mut done = app.tasks.done_rx(&task_id).unwrap();
    let error = app.db.call(|c| {
        let pages: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0))?;
        c.pragma_update(None, "max_page_count", pages)?;
        c.execute("INSERT INTO events(created_at,kind,payload) VALUES('2026-11-11','fixture-full',zeroblob(1048576))", [])?;
        Ok(())
    }).await.unwrap_err();
    assert_eq!(error.code, "storage_full");
    assert_eq!(error.status, StatusCode::INSUFFICIENT_STORAGE);
    assert_eq!(app.db.recovery_reason(), Some("storage_full"));
    tokio::time::timeout(std::time::Duration::from_secs(10), done.wait_for(|finished| *finished)).await.unwrap().unwrap();
    let health = grove::web::health(axum::extract::State(app.clone())).await.0;
    assert_eq!(health["status"], "recovery_required");
    assert_eq!(health["storage_error"], "storage_full");
    s.server.take().unwrap().stop().await;
    drop(app);
    let restarted = grove::server::start(config(&s.data_dir()), std::sync::Arc::new(grove::util::SystemClock)).await.unwrap();
    assert!(restarted.app.db.recovery_reason().is_none());
    let status = restarted.app.db.call(move |c| Ok(c.query_row("SELECT status FROM tasks WHERE id=?1", [task_id], |r| r.get::<_, String>(0))?)).await.unwrap();
    assert_eq!(status, "unknown", "종료 결과를 기록하지 못했으므로 성공·취소로 단정하지 않는다");
    restarted.stop().await;
}
