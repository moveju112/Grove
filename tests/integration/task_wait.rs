//! EXEC-006: wait는 완료·입력·알림에 반응하며 기다림 종료가 프로세스 취소를 뜻하지 않는다.
#![cfg(unix)]
use crate::common;

use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};
use std::time::Duration;

async fn setup() -> (TestServer, String, String, String) {
    let s = TestServer::start().await;
    let p = s.create_project("wait").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let other = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (st, task) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({ "command": "sleep 30" })).await;
    assert_eq!(st, StatusCode::CREATED);
    let tid = task["id"].as_str().unwrap().to_string();
    (s, sid, other, tid)
}

async fn wait(s: &TestServer, tid: &str, after: i64, timeout: u64) -> Value {
    let (st, v) = s.get(&format!("/api/v1/tasks/{tid}/wait?timeout_ms={timeout}&after_event_seq={after}")).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    v
}

#[tokio::test]
async fn wait_filters_unrelated_input_and_cursor_prevents_lost_or_repeated_wakes() {
    let (s, sid, other, tid) = setup().await;
    let (_, initial) = s.get(&format!("/api/v1/tasks/{tid}/wait?timeout_ms=0")).await;
    let cursor = initial["event_cursor"].as_i64().unwrap();
    s.post(&format!("/api/v1/sessions/{other}/messages"), json!({ "text": "다른 대화 입력" })).await;
    let idle = wait(&s, &tid, cursor, 50).await;
    assert_eq!(idle["wake_reason"], "timeout");
    assert_eq!(idle["wait_timed_out"], true);
    let cursor = idle["event_cursor"].as_i64().unwrap();
    s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": "대기 호출 사이에 도착한 입력" })).await;
    let wake = wait(&s, &tid, cursor, 10_000).await;
    assert_eq!(wake["wake_reason"], "new_input");
    assert_eq!(wake["status"], "running");
    assert_eq!(wake["wait_timed_out"], false);
    assert!(wake["wake_event_seq"].as_i64().unwrap() > cursor);
    let repeated = wait(&s, &tid, wake["event_cursor"].as_i64().unwrap(), 0).await;
    assert_eq!(repeated["wake_reason"], "timeout", "같은 입력을 두 번 알리지 않는다");
    let (_, task) = s.get(&format!("/api/v1/tasks/{tid}")).await;
    assert_eq!(task["status"], "running", "입력 도착은 실행 중 작업을 취소하지 않는다");
    s.post(&format!("/api/v1/tasks/{tid}/cancel"), json!({})).await;
    let done = wait(&s, &tid, cursor, 10_000).await;
    assert_eq!(done["wake_reason"], "completed");
    assert_eq!(done["status"], "cancelled");
    assert_eq!(done["wait_timed_out"], false);
}

#[tokio::test]
async fn in_flight_wait_wakes_on_input_without_waiting_for_process_completion() {
    let (s, sid, _, tid) = setup().await;
    let (_, initial) = s.get(&format!("/api/v1/tasks/{tid}/wait?timeout_ms=0")).await;
    let cursor = initial["event_cursor"].as_i64().unwrap();
    let req = s.client.get(format!("{}/api/v1/tasks/{tid}/wait?timeout_ms=10000&after_event_seq={cursor}", s.base)).bearer_auth(&s.token);
    let pending = tokio::spawn(async move { req.send().await.unwrap().json::<Value>().await.unwrap() });
    s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": "새 지시" })).await;
    let wake = tokio::time::timeout(Duration::from_secs(2), pending).await.expect("새 입력은 완료를 기다리지 않고 전달").unwrap();
    assert_eq!(wake["wake_reason"], "new_input");
    assert_eq!(wake["status"], "running");
    s.post(&format!("/api/v1/tasks/{tid}/cancel"), json!({})).await;
}

#[tokio::test]
async fn owned_result_notifications_wake_wait_and_expired_cursor_requests_resync() {
    let (s, sid, _, tid) = setup().await;
    let (_, initial) = s.get(&format!("/api/v1/tasks/{tid}/wait?timeout_ms=0")).await;
    let cursor = initial["event_cursor"].as_i64().unwrap();
    let (_, short) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({ "command": "printf notification" })).await;
    let (_, done) = s.get(&format!("/api/v1/tasks/{}/wait?timeout_ms=10000", short["id"].as_str().unwrap())).await;
    assert_eq!(done["status"], "completed");
    let wake = wait(&s, &tid, cursor, 10_000).await;
    assert_eq!(wake["wake_reason"], "notification");
    assert_eq!(wake["status"], "running");
    assert!(wake["wake_event_seq"].is_number());
    let cursor = wake["event_cursor"].as_i64().unwrap();
    s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": "보존 범위 1" })).await;
    s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": "보존 범위 2" })).await;
    {
        let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
        db.execute("DELETE FROM events WHERE seq <= ?1", [cursor + 1]).unwrap();
    }
    let wake = wait(&s, &tid, cursor, 10_000).await;
    assert_eq!(wake["wake_reason"], "resync");
    assert_eq!(wake["status"], "running");
    assert_eq!(wake["wait_timed_out"], false);
    let (st, _) = s.get(&format!("/api/v1/tasks/{tid}/wait?after_event_seq=-1")).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    s.post(&format!("/api/v1/tasks/{tid}/cancel"), json!({})).await;
}
