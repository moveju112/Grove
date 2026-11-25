//! 공정 실행(FAIR-003, 005, 007, 008, 009, 011, 012).
use crate::common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

async fn set(s: &TestServer, key: &str, v: i64) {
    let (st, r) = s.send(Method::PUT, &format!("/api/v1/settings/server/-/{key}"), json!({ "expected_revision": 0, "value": v })).await;
    assert_eq!(st, StatusCode::OK, "{r}");
}

async fn as_device(s: &TestServer, token: &str, method: Method, path: &str, body: Option<Value>, key: &str) -> (StatusCode, Value) {
    let mut rb = s.client.request(method, format!("{}{path}", s.base)).bearer_auth(token).header("X-Grove-Protocol", "1").header("Idempotency-Key", key);
    if let Some(b) = body {
        rb = rb.json(&b);
    }
    let r = rb.send().await.unwrap();
    let st = r.status();
    (st, r.json().await.unwrap_or(Value::Null))
}

/// FAIR-008: 승인 대기 중인 턴은 모델 슬롯을 차지하지 않는다.
#[tokio::test]
async fn approval_wait_does_not_hold_a_model_slot() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    set(&s, "runs.max_active", 1).await;
    let p = s.create_project("fair2").await;
    let pid = p["id"].as_str().unwrap().to_string();
    let w = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    let o = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    f.push_for("MARK_W", fixture::tool_calls(&[("w1", "write", json!({ "path": "x.txt", "content": "x" }))]));
    f.push_for("MARK_O", fixture::text("다른 대화 답"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{w}/turns"), json!({ "text": "MARK_W", "profile_id": prof, "tools": true })).await;
    let wt = v["turn"]["id"].as_str().unwrap().to_string();
    s.wait_status(&wt, "awaiting_approval").await;
    let (_, v) = s.post(&format!("/api/v1/sessions/{o}/turns"), json!({ "text": "MARK_O", "profile_id": prof })).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    assert!(t.get("queue").is_none());
    let (_, still) = s.get(&format!("/api/v1/turns/{wt}")).await;
    assert_eq!(still["status"], "awaiting_approval");
}

#[tokio::test]
async fn newcomer_runs_next_queue_limits_and_control_stays_responsive() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    set(&s, "runs.max_active", 1).await;
    let p = s.create_project("fair").await;
    let pid = p["id"].as_str().unwrap().to_string();
    let mut sids = vec![];
    for _ in 0..5 {
        sids.push(s.create_session(&pid).await["id"].as_str().unwrap().to_string());
    }
    let dev = s.registered_device("phone").await;
    let dev_token = dev["token"].as_str().unwrap().to_string();
    for m in ["MARK_A1", "MARK_A2", "MARK_A3", "MARK_B1"] {
        f.push_for(m, fixture::slow_text(&["ok"], 400));
    }
    let start = |sid: String, text: &'static str| {
        let s = &s;
        let prof = prof.clone();
        async move {
            let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": text, "profile_id": prof })).await;
            (st, v)
        }
    };
    // 소유자 A: 대화 3개로 요청을 쌓는다(한도 1이라 첫 요청만 실행)
    let a1 = start(sids[0].clone(), "MARK_A1").await.1["turn"]["id"].as_str().unwrap().to_string();
    tokio::time::sleep(Duration::from_millis(80)).await;
    let a2 = start(sids[1].clone(), "MARK_A2").await.1["turn"]["id"].as_str().unwrap().to_string();
    let a3 = start(sids[2].clone(), "MARK_A3").await.1["turn"]["id"].as_str().unwrap().to_string();
    // 기기 B는 자기 한도로 접수된다
    tokio::time::sleep(Duration::from_millis(80)).await;
    let (st, b) = as_device(&s, &dev_token, Method::POST, &format!("/api/v1/sessions/{}/turns", sids[4]), Some(json!({ "text": "MARK_B1", "profile_id": prof })), "b1").await;
    assert_eq!(st, StatusCode::ACCEPTED, "{b}");
    let b1 = b["turn"]["id"].as_str().unwrap().to_string();
    tokio::time::sleep(Duration::from_millis(80)).await;

    // 대기 이유 표시(FAIR-011): 대기 중인 턴은 queue 정보, 실행 중인 턴은 없음
    let (_, t3) = s.get(&format!("/api/v1/turns/{a3}")).await;
    assert_eq!(t3["queue"]["limit"], 1, "{t3}");
    assert_eq!(t3["queue"]["active"], 1);
    let (_, t1) = s.get(&format!("/api/v1/turns/{a1}")).await;
    assert!(t1.get("queue").is_none(), "{t1}");
    // 사용량 화면의 실행 용량: 서버 전체는 합계만, 상세는 자기 요청만(다른 소유자의 대화·순서는 보이지 않는다)
    let (st, cap) = s.get("/api/v1/usage/capacity").await;
    assert_eq!(st, StatusCode::OK, "{cap}");
    assert_eq!(cap["limits"]["max_active"], 1);
    assert_eq!(cap["server"], json!({ "running": 1, "waiting": 3 }));
    assert_eq!(cap["mine"], json!({ "waiting": 2, "running": 1, "awaiting_user": 0 }));
    let ids: Vec<&str> = cap["requests"].as_array().unwrap().iter().map(|r| r["turn_id"].as_str().unwrap()).collect();
    assert_eq!(ids, [a1.as_str(), a2.as_str(), a3.as_str()]);
    assert_eq!(cap["requests"][2]["queue"]["limit"], 1);
    assert!(!cap.to_string().contains(&b1) && !cap.to_string().contains(&sids[4]), "다른 소유자 상세 비노출: {cap}");
    let (st, cap_b) = as_device(&s, &dev_token, Method::GET, "/api/v1/usage/capacity", None, "cap-b").await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(cap_b["server"], cap["server"]);
    let ids: Vec<&str> = cap_b["requests"].as_array().unwrap().iter().map(|r| r["turn_id"].as_str().unwrap()).collect();
    assert_eq!(ids, [b1.as_str()]);
    assert!(!cap_b.to_string().contains(&a2) && !cap_b.to_string().contains(&sids[0]));

    // 제어 요청은 포화 중에도 바로 응답(FAIR-009): 상태 조회·대기 중 턴 취소
    let t0 = Instant::now();
    let (st, _) = s.get("/api/v1/health").await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = s.post(&format!("/api/v1/turns/{a3}/cancel"), json!({})).await;
    assert!(st.is_success(), "{st}");
    assert!(t0.elapsed() < Duration::from_millis(300), "제어 요청 지연 {:?}", t0.elapsed());
    s.wait_status(&a3, "cancelled").await;

    // 끝나는 순서: A1 → B1(새로 온 소유자가 다음 기회) → A2
    let mut fin = vec![];
    for id in [&a1, &a2, &b1] {
        let t = s.wait_status(id, "completed").await;
        fin.push((t["finished_at"].as_str().unwrap().to_string(), id.clone()));
    }
    fin.sort();
    let order: Vec<&str> = fin.iter().map(|x| x.1.as_str()).collect();
    assert_eq!(order, [a1.as_str(), b1.as_str(), a2.as_str()], "A가 먼저 쌓았어도 B가 다음 빈 슬롯을 받는다");
    // 대기 중 취소된 턴은 모델을 부르지 않았다(FAIR-007)
    let called: Vec<String> = f.requests().iter().map(|r| r.to_string()).collect();
    assert!(!called.iter().any(|b| b.contains("MARK_A3")), "취소된 대기 턴이 모델을 불렀다");
    assert_eq!(called.len(), 3);
    // 모두 끝나면 슬롯·대기 0, 한도가 다시 열린다
    let (st, _) = start(sids[3].clone(), "MARK_A4").await;
    assert_eq!(st, StatusCode::ACCEPTED, "끝난 뒤에는 다시 접수");
}
