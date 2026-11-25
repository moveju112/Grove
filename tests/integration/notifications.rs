use crate::common;

use common::TestServer;
use reqwest::StatusCode;
use reqwest::Method;
use serde_json::json;

async fn seed(server: &TestServer, title: &str) -> String {
    let title = title.to_string();
    server.server.as_ref().unwrap().app.db.call(move |c| {
        let tx = c.transaction()?;
        let notification = grove::notifications::push(&tx, "2026-01-01T00:00:00Z", "test", &title, "body", None, None, Some("command-1"))?;
        tx.commit()?;
        Ok(notification.id)
    }).await.unwrap()
}

#[tokio::test]
async fn unread_reference_pages_keep_tied_timestamps_and_global_unread_count() {
    let server = TestServer::start().await;
    server.server.as_ref().unwrap().app.db.call(|c| {
        c.execute_batch("INSERT INTO notifications (id, kind, title, body, created_at, ref_id, read_at) VALUES
            ('a','test','','','t','wanted',NULL), ('b','test','','','t','wanted','read'),
            ('c','test','','','t','other',NULL), ('d','test','','','t','wanted',NULL)")?;
        Ok(())
    }).await.unwrap();
    let path = "/api/v1/notifications?unread=true&ref_id=wanted&limit=1";
    let (status, first) = server.get(path).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["items"][0]["id"], "d");
    assert_eq!(first["next_cursor"], "t|d");
    let (status, second) = server.get(&format!("{path}&before=t%7Cd")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["items"][0]["id"], "a");
    assert!(second["next_cursor"].is_null());
    assert_eq!(second["unread"], 3);
}

#[tokio::test]
async fn read_event_failure_keeps_notification_unread() {
    let server = TestServer::start().await;
    let id = seed(&server, "읽음 원자성").await;
    server.server.as_ref().unwrap().app.db.call(|c| {
        c.execute_batch("CREATE TRIGGER fail_notification_read BEFORE INSERT ON events WHEN NEW.kind='notification.read' BEGIN SELECT RAISE(ABORT,'injected notification event failure'); END;")?;
        Ok(())
    }).await.unwrap();
    let (status, _) = server.post(&format!("/api/v1/notifications/{id}/read"), json!({})).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let (_, page) = server.get("/api/v1/notifications").await;
    assert!(page["items"][0]["read_at"].is_null(), "이벤트 저장이 실패하면 읽음 변경도 rollback해야 한다");
}

#[tokio::test]
async fn listing_is_not_delivery_and_delivery_is_not_reading() {
    let mut server = TestServer::start().await;
    let id = seed(&server, "원격 결과").await;
    for _ in 0..2 {
        let (_, page) = server.get("/api/v1/notifications?ref_id=command-1").await;
        assert_eq!(page["items"].as_array().unwrap().len(), 1);
        assert!(page["items"][0]["delivered_at"].is_null());
        assert!(page["items"][0]["read_at"].is_null());
    }
    let (status, ack) = server.post("/api/v1/notifications/delivered", json!({ "ids": [id, id] })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ack["updated"], 1);
    let (_, page) = server.get("/api/v1/notifications").await;
    let delivered = page["items"][0]["delivered_at"].clone();
    assert!(delivered.is_string());
    assert!(page["items"][0]["read_at"].is_null());
    assert_eq!(page["unread"], 1);
    let (_, ack) = server.post("/api/v1/notifications/delivered", json!({ "ids": [id] })).await;
    assert_eq!(ack["updated"], 0);
    server.restart().await;
    let (_, page) = server.get("/api/v1/notifications").await;
    assert_eq!(page["items"][0]["delivered_at"], delivered);
    assert!(page["items"][0]["read_at"].is_null());
    let (_, read) = server.post(&format!("/api/v1/notifications/{id}/read"), json!({})).await;
    assert_eq!(read["updated"], 1);
    let (_, page) = server.get("/api/v1/notifications").await;
    assert_eq!(page["items"][0]["delivered_at"], delivered);
    let read_at = page["items"][0]["read_at"].clone();
    assert!(read_at.is_string());
    let (_, repeated) = server.post(&format!("/api/v1/notifications/{id}/read"), json!({})).await;
    assert_eq!(repeated["updated"], 0);
    let (_, page) = server.get("/api/v1/notifications").await;
    assert_eq!(page["items"][0]["read_at"], read_at);
}

#[tokio::test]
async fn explicit_read_implies_delivery_and_read_all_is_idempotent() {
    let server = TestServer::start().await;
    let id = seed(&server, "읽으면 전달도 확인").await;
    let (status, _) = server.post(&format!("/api/v1/notifications/{id}/read"), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let (_, page) = server.get("/api/v1/notifications").await;
    assert!(page["items"][0]["read_at"].is_string());
    assert_eq!(page["items"][0]["read_at"], page["items"][0]["delivered_at"]);
    seed(&server, "모두 읽음 1").await;
    seed(&server, "모두 읽음 2").await;
    let (_, read) = server.post("/api/v1/notifications/read-all", json!({})).await;
    assert_eq!(read["updated"], 2);
    let (_, repeat) = server.post("/api/v1/notifications/read-all", json!({})).await;
    assert_eq!(repeat["updated"], 0);
    let (_, page) = server.get("/api/v1/notifications").await;
    assert_eq!(page["unread"], 0);
    server.server.as_ref().unwrap().app.db.call(|c| {
        let count: i64 = c.query_row("SELECT COUNT(*) FROM events WHERE kind='notification.read'", [], |r| r.get(0))?;
        assert_eq!(count, 2, "상태가 바뀐 두 동작만 이벤트를 만든다");
        Ok(())
    }).await.unwrap();
}

#[tokio::test]
async fn acknowledgement_and_read_all_failures_roll_back_all_metadata() {
    let server = TestServer::start().await;
    let first = seed(&server, "A").await;
    seed(&server, "B").await;
    server.server.as_ref().unwrap().app.db.call(|c| {
        c.execute_batch("CREATE TRIGGER fail_notification_ack BEFORE INSERT ON events WHEN NEW.kind IN ('notification.delivered','notification.read') BEGIN SELECT RAISE(ABORT,'injected notification event failure'); END;")?;
        Ok(())
    }).await.unwrap();
    for (path, body) in [
        ("/api/v1/notifications/delivered", json!({ "ids": [first] })),
        ("/api/v1/notifications/read-all", json!({})),
    ] {
        let (status, _) = server.post(path, body).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        let (_, page) = server.get("/api/v1/notifications").await;
        assert_eq!(page["unread"], 2);
        for item in page["items"].as_array().unwrap() {
            assert!(item["read_at"].is_null());
            assert!(item["delivered_at"].is_null());
        }
    }
}

#[tokio::test]
async fn delivery_requires_authentication_and_rejects_unbounded_batches() {
    let server = TestServer::start().await;
    let id = seed(&server, "권한").await;
    let response = server.raw(Method::POST, "/api/v1/notifications/delivered", Some(json!({ "ids": [id] })), None, Some("")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = server.raw(Method::POST, "/api/v1/notifications/delivered", Some(json!({ "ids": [id] })), None, None).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST, "새 상태 변경 API도 idempotency 계약을 따른다");
    for ids in [json!([]), json!(vec!["x"; 101]), json!(["x".repeat(129)])] {
        let (status, _) = server.post("/api/v1/notifications/delivered", json!({ "ids": ids })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let device = server.registered_device("receiver").await;
    let response = server.raw(Method::POST, "/api/v1/notifications/delivered", Some(json!({ "ids": [id] })), Some("device-ack"), device["token"].as_str()).await;
    assert_eq!(response.status(), StatusCode::OK, "기기 인증도 기존 공유 알림을 확인할 수 있다");
}

#[tokio::test]
async fn ref_filter_and_legacy_read_migration_preserve_the_delivery_boundary() {
    // Build the actual old schema instead of trying to undo every later migration.
    let dir = tempfile::tempdir().unwrap();
    let cfg = common::config(&dir.path().join("data"));
    std::fs::create_dir_all(&cfg.data_dir).unwrap();
    let db = rusqlite::Connection::open(cfg.data_dir.join("grove.db")).unwrap();
    for migration in &grove::store::MIGRATIONS[..37] { db.execute_batch(migration).unwrap(); }
    db.execute_batch("PRAGMA user_version=37;
        INSERT INTO notifications(id,kind,title,body,ref_id,created_at,read_at) VALUES
        ('legacy','test','legacy read','body','command-1','2026-01-01T00:00:00Z','2026-01-01T00:01:00Z'),
        ('other','test','another command','body','command-2','2026-01-01T00:00:00Z',NULL);").unwrap();
    drop(db);
    let server = TestServer::start_with(dir,cfg).await;
    let (_, page) = server.get("/api/v1/notifications?ref_id=command-1").await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["title"], "legacy read");
    assert_eq!(page["items"][0]["delivered_at"], "2026-01-01T00:01:00Z");
    assert_eq!(page["items"][0]["read_at"], "2026-01-01T00:01:00Z");
    let (_, other) = server.get("/api/v1/notifications?ref_id=command-2").await;
    assert!(other["items"][0]["delivered_at"].is_null());
}

#[tokio::test]
async fn delivery_replay_normalizes_the_id_set_and_preserves_the_first_confirmation() {
    let server = TestServer::start().await;
    let first = seed(&server, "first").await;
    let second = seed(&server, "second").await;
    let response = server.raw(Method::POST, "/api/v1/notifications/delivered", Some(json!({ "ids": [first, second] })), Some("same-delivery"), None).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["updated"], 2);
    let response = server.raw(Method::POST, "/api/v1/notifications/delivered", Some(json!({ "ids": [second, first, first] })), Some("same-delivery"), None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["idempotent-replayed"], "true");
    let replay: serde_json::Value = response.json().await.unwrap();
    assert_eq!(replay, body);
    let response = server.raw(Method::POST, "/api/v1/notifications/delivered", Some(json!({ "ids": [first] })), Some("same-delivery"), None).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    server.server.as_ref().unwrap().app.db.call(|c| {
        let events: i64 = c.query_row("SELECT COUNT(*) FROM events WHERE kind='notification.delivered'", [], |r| r.get(0))?;
        assert_eq!(events, 1);
        Ok(())
    }).await.unwrap();
}
