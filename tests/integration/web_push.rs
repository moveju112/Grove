use crate::common;
use common::TestServer;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
fn subscription(public: &str, endpoint: &str) -> Value {
    json!({"endpoint":endpoint,"keys":{"p256dh":public,"auth":"AAAAAAAAAAAAAAAAAAAAAA"},"scope":"https://grove.choondoggy.com/","server":"a".repeat(64),"vibrate":true,"expected_revision":0})
}
#[tokio::test]
async fn subscription_requires_authentication_validates_endpoint_and_preserves_idempotency_revision()
 {
    let s = TestServer::start().await;
    let url = "/api/v1/web-push";
    assert_eq!(
        s.raw(Method::GET, url, None, None, Some("")).await.status(),
        StatusCode::UNAUTHORIZED
    );
    let (status, config) = s.get(url).await;
    assert_eq!(status, StatusCode::OK);
    let public = config["public_key"].as_str().unwrap();
    let body = subscription(public, "https://fcm.googleapis.com/fcm/send/isolated-test");
    assert_eq!(
        s.raw(Method::PUT, url, Some(body.clone()), None, None)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let key = s.key();
    for _ in 0..2 {
        let r = s
            .raw(Method::PUT, url, Some(body.clone()), Some(&key), None)
            .await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.json::<Value>().await.unwrap()["revision"], 1);
    }
    assert_eq!(
        s.send(Method::PUT, url, body.clone()).await.0,
        StatusCode::CONFLICT
    );
    let mut updated = body.clone();
    updated["expected_revision"] = json!(1);
    updated["vibrate"] = json!(false);
    assert_eq!(s.send(Method::PUT, url, updated).await.1["revision"], 2);
    for endpoint in [
        "https://127.0.0.1/push",
        "https://fcm.googleapis.com.evil.test/push",
        "https://user@fcm.googleapis.com/push",
        "http://fcm.googleapis.com/push",
        "https://fcm.googleapis.com:444/push",
        "https://fcm.googleapis.com/push#fragment",
    ] {
        assert_eq!(
            s.send(Method::PUT, url, subscription(public, endpoint))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let key = s.key();
    let response = s
        .raw(
            Method::DELETE,
            &format!(
                "{url}?endpoint=https%3A%2F%2Ffcm.googleapis.com%2Ffcm%2Fsend%2Fisolated-test"
            ),
            None,
            Some(&key),
            None,
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        s.get(url).await.1["subscriptions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[tokio::test]
async fn completion_enqueues_atomically_once_and_revocation_cascades_without_plaintext_secrets() {
    let mut s = TestServer::start().await;
    let (_, config) = s.get("/api/v1/web-push").await;
    assert_eq!(
        s.send(
            Method::PUT,
            "/api/v1/web-push",
            subscription(
                config["public_key"].as_str().unwrap(),
                "https://fcm.googleapis.com/fcm/send/isolated-queue"
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    // Stop delivery: inspect durable queue deterministically, never contact a real push service.
    let server = s.server.take().unwrap();
    let app = server.app.clone();
    server.stop().await;
    app.db.call(|c| {
        let now="2026-11-16T12:00:00Z";
        c.execute_batch("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES('p','test','/isolated','now','now');
            INSERT INTO sessions(id,project_id,title,created_at,updated_at) VALUES('s','p','test','now','now');
            INSERT INTO messages(id,session_id,seq,role,content,created_at) VALUES('m','s',1,'user','{}','now');
            INSERT INTO turns(id,session_id,status,request_message_id,owner_epoch,created_at,updated_at) VALUES('t','s','completed','m','test','now','now');")?;
        for status in ["running","cancelled","awaiting_approval"] {
            grove::events::append(c,now,"turn.updated",Some("p"),Some("s"),&json!({"id":"t","status":status}))?;
        }
        assert_eq!(c.query_row("SELECT count(*) FROM web_push_outbox",[],|r|r.get::<_,i64>(0))?,0);
        {
            let tx=c.transaction()?;
            grove::events::append(&tx,now,"turn.updated",Some("p"),Some("s"),&json!({"id":"t","status":"completed","text":"private answer"}))?;
            assert_eq!(tx.query_row("SELECT count(*) FROM web_push_outbox",[],|r|r.get::<_,i64>(0))?,1);
            tx.rollback()?;
        }
        assert_eq!(c.query_row("SELECT count(*) FROM web_push_outbox",[],|r|r.get::<_,i64>(0))?,0);
        grove::events::append(c,now,"turn.updated",Some("p"),Some("s"),&json!({"id":"t","status":"completed","completion_preview":"최종 답변","text":"private answer"}))?;
        let payload:String=c.query_row("SELECT payload FROM web_push_outbox",[],|r|r.get(0))?;
        assert!(!payload.contains("최종 답변"));
        let clear:String=c.query_row("SELECT grove_decrypt(payload) FROM web_push_outbox",[],|r|r.get(0))?;
        assert_eq!(serde_json::from_str::<Value>(&clear)?["body"], "최종 답변");
        assert!(!clear.contains("private answer"));
        assert!(!payload.contains("private answer"));
        c.execute("DELETE FROM web_push_outbox",[])?;
        grove::events::append(c,now,"turn.updated",Some("p"),Some("s"),&json!({"id":"t","status":"completed"}))?;
        assert_eq!(c.query_row("SELECT count(*) FROM web_push_outbox",[],|r|r.get::<_,i64>(0))?,0,"even after delivery, duplicates must not requeue");
        // 질문은 답을 기다리는 호출이 만들어질 때 질문 문구로 알린다. 다른 도구·답한 뒤 상태는 알리지 않는다.
        for (name,status) in [("ask_user","succeeded"),("ask_user","cancelled"),("shell","awaiting_input"),("shell","pending_approval")] {
            grove::events::append(c,now,"tool_call.updated",Some("p"),Some("s"),&json!({"id":"q","name":name,"status":status,"target":{"question":"x"}}))?;
        }
        assert_eq!(c.query_row("SELECT count(*) FROM web_push_outbox",[],|r|r.get::<_,i64>(0))?,0);
        grove::events::append(c,now,"tool_call.updated",Some("p"),Some("s"),&json!({"id":"q","turn_id":"t","name":"ask_user","status":"awaiting_input","target":{"question":"  어느 쪽으로 갈까요?  "}}))?;
        let clear:String=c.query_row("SELECT grove_decrypt(payload) FROM web_push_outbox WHERE event_key='question:q'",[],|r|r.get(0))?;
        let question=serde_json::from_str::<Value>(&clear)?;
        assert_eq!((question["question"].clone(),question["tag"].clone(),question["body"].clone()),(json!(true),json!("question:q"),json!("어느 쪽으로 갈까요?")));
        c.execute("DELETE FROM web_push_outbox",[])?;
        let secret:String=c.query_row("SELECT auth FROM web_push_subscriptions",[],|r|r.get(0))?;
        assert_ne!(secret,"AAAAAAAAAAAAAAAAAAAAAA");
        c.execute("DELETE FROM web_push_subscriptions",[])?;
        assert_eq!(c.query_row("SELECT count(*) FROM web_push_receipts",[],|r|r.get::<_,i64>(0))?,0);
        Ok(())
    }).await.unwrap();
}

#[tokio::test]
async fn recent_input_on_another_device_skips_push_without_retrying() {
    let s = TestServer::start().await;
    let (_, config) = s.get("/api/v1/web-push").await;
    let phone = s.registered_device("isolated phone").await;
    let body = subscription(config["public_key"].as_str().unwrap(), "https://fcm.googleapis.com/fcm/send/isolated-presence");
    let subscribed = s.raw(Method::PUT, "/api/v1/web-push", Some(body), Some(&s.key()), phone["token"].as_str()).await;
    assert_eq!(subscribed.status(), StatusCode::OK);
    // 휴대폰 자신의 입력은 휴대폰 알림을 막지 않는다. 이 시험은 PC(다른 기기)의 입력만 보낸다.
    assert_eq!(s.send(Method::POST, "/api/v1/presence", json!({})).await.0, StatusCode::NO_CONTENT);
    let app = &s.server.as_ref().unwrap().app;
    let now = app.now();
    app.db.call(move |c| {
        c.execute_batch("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES('p','test','/isolated','now','now');
            INSERT INTO sessions(id,project_id,title,created_at,updated_at) VALUES('s','p','test','now','now');
            INSERT INTO messages(id,session_id,seq,role,content,created_at) VALUES('m','s',1,'user','{}','now');
            INSERT INTO turns(id,session_id,status,request_message_id,owner_epoch,created_at,updated_at) VALUES('t','s','completed','m','test','now','now');")?;
        grove::events::append(c, &now, "turn.updated", Some("p"), Some("s"), &json!({"id":"t","status":"completed"}))?;
        assert_eq!(c.query_row("SELECT count(*) FROM web_push_outbox", [], |r| r.get::<_, i64>(0))?, 1);
        Ok(())
    }).await.unwrap();
    app.notify_events().await;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        // 실제 Push 서비스에 보냈다면 실패 기록이 남거나 재시도가 대기한다.
        let (queued, error) = app.db.call(|c| Ok((
            c.query_row("SELECT count(*) FROM web_push_outbox", [], |r| r.get::<_, i64>(0))?,
            c.query_row("SELECT last_error FROM web_push_subscriptions", [], |r| r.get::<_, Option<String>>(0))?,
        ))).await.unwrap();
        assert_eq!(error, None, "다른 기기 사용 중에는 Push 서비스로 보내지 않는다");
        if queued == 0 { break; }
        assert!(tokio::time::Instant::now() < deadline, "skipped push stayed queued");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let received = app.db.call(|c| Ok(c.query_row("SELECT count(*) FROM web_push_receipts", [], |r| r.get::<_, i64>(0))?)).await.unwrap();
    assert_eq!(received, 1, "같은 완료를 나중에 다시 보내지 않는다");
}

#[tokio::test]
async fn device_scoping_and_revocation_stop_push() {
    let s = TestServer::start().await;
    let (_, config) = s.get("/api/v1/web-push").await;
    let device = s.registered_device("isolated push device").await;
    let body = subscription(
        config["public_key"].as_str().unwrap(),
        "https://fcm.googleapis.com/fcm/send/isolated-device",
    );
    assert_eq!(
        s.raw(
            Method::PUT,
            "/api/v1/web-push",
            Some(body.clone()),
            Some(&s.key()),
            device["token"].as_str()
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert!(
        s.get("/api/v1/web-push").await.1["subscriptions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        s.send(Method::PUT, "/api/v1/web-push", body).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        s.raw(
            Method::DELETE,
            &format!("/api/v1/devices/{}", device["id"].as_str().unwrap()),
            None,
            Some(&s.key()),
            None
        )
        .await
        .status(),
        StatusCode::OK
    );
    let app = &s.server.as_ref().unwrap().app;
    app.notify_events().await;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        let count = app
            .db
            .call(|c| {
                Ok(
                    c.query_row("SELECT count(*) FROM web_push_subscriptions", [], |r| {
                        r.get::<_, i64>(0)
                    })?,
                )
            })
            .await
            .unwrap();
        if count == 0 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "revoked subscription was not purged"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}
