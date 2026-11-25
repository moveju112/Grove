//! 실행 중 추가 메시지(RUN-007·008): queue·steer·interrupt. 모델 응답은 로컬 fixture.
use crate::common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn setup() -> (TestServer, Fixture, String, String) {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("proj").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    (s, f, prof, sid)
}

async fn start_turn(s: &TestServer, sid: &str, prof: &str, text: &str, tools: bool) -> String {
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": text, "profile_id": prof, "tools": tools })).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    v["turn"]["id"].as_str().unwrap().to_string()
}

async fn add(s: &TestServer, sid: &str, prof: &str, kind: &str, text: &str) -> (StatusCode, Value) {
    s.post(&format!("/api/v1/sessions/{sid}/followups"), json!({ "kind": kind, "text": text, "profile_id": prof, "tools": true })).await
}

async fn turns(s: &TestServer, sid: &str) -> Vec<Value> {
    let (_, v) = s.get(&format!("/api/v1/sessions/{sid}/turns")).await;
    let mut v = v.as_array().unwrap().clone();
    v.reverse(); // 오래된 것부터
    v
}

async fn wait_turn_count(s: &TestServer, sid: &str, n: usize) -> Vec<Value> {
    for _ in 0..100 {
        let t = turns(s, sid).await;
        if t.len() >= n {
            return t;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("턴 {n}개가 생기지 않음: {:?}", turns(s, sid).await);
}

async fn items(s: &TestServer, sid: &str) -> Vec<Value> {
    s.get(&format!("/api/v1/sessions/{sid}/followups")).await.1["items"].as_array().unwrap().clone()
}

async fn wait_requests(f: &Fixture, n: usize) {
    for _ in 0..200 {
        if f.requests().len() >= n {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("fixture 요청 {n}개가 오지 않음");
}

fn count_text(req: &Value, needle: &str) -> usize {
    req["messages"].as_array().unwrap().iter().filter(|m| m["content"].as_str().is_some_and(|c| c.contains(needle))).count()
}

#[tokio::test]
async fn steer_is_applied_once_at_next_model_call_after_tool_results() {
    let (s, f, prof, sid) = setup().await;
    // 쓰기 도구(승인 필요) → 승인 대기 중 steer → 승인 → 다음 모델 호출에 도구 결과 뒤 user로 한 번
    f.push(fixture::tool_calls(&[("w1", "write", json!({ "path": "a.txt", "content": "A" }))]));
    f.push(fixture::text("반영했어"));
    let tid = start_turn(&s, &sid, &prof, "파일 써", true).await;
    let t = s.wait_status(&tid, "awaiting_approval").await;
    let (st, v) = add(&s, &sid, &prof, "steer", "내용은 B로 바꿔줘").await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    assert_eq!(items(&s, &sid).await.len(), 1);
    let c = &t["tool_calls"][0];
    let (st, _) = s.post(&format!("/api/v1/tool-calls/{}/decision", c["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": c["revision"] })).await;
    assert_eq!(st, StatusCode::OK);
    s.wait_status(&tid, "completed").await;
    let reqs = f.requests();
    assert_eq!(reqs.len(), 2);
    let msgs = reqs[1]["messages"].as_array().unwrap();
    let roles: Vec<&str> = msgs.iter().map(|m| m["role"].as_str().unwrap()).collect();
    let tool_at = roles.iter().position(|r| *r == "tool").unwrap();
    let steer_at = msgs.iter().position(|m| m["content"].as_str().is_some_and(|c| c.contains("내용은 B로"))).unwrap();
    assert!(steer_at > tool_at, "steer는 도구 결과 뒤에 들어간다: {roles:?}");
    assert_eq!(count_text(&reqs[1], "내용은 B로"), 1);
    assert_eq!(count_text(&reqs[0], "내용은 B로"), 0, "첫 호출은 steer 이전");
    assert!(items(&s, &sid).await.is_empty());
    // 대화 기록에도 한 번, steer 출처로
    let (_, m) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let steers: Vec<&Value> = m["items"].as_array().unwrap().iter().filter(|x| x["content"]["source"]["kind"] == "steer").collect();
    assert_eq!(steers.len(), 1);
    assert_eq!(steers[0]["turn_id"], tid.as_str());
    assert_eq!(turns(&s, &sid).await.len(), 1, "steer는 새 턴을 만들지 않는다");
}

#[tokio::test]
async fn queue_waits_until_late_steers_finish_in_current_turn() {
    let (s, f, prof, sid) = setup().await;
    f.push(fixture::slow_text(&["첫", "답"], 200));
    f.push(fixture::text("둘째 답"));
    f.push(fixture::text("셋째 답"));
    let tid = start_turn(&s, &sid, &prof, "처음", false).await;
    s.wait_status(&tid, "running").await;
    wait_requests(&f, 1).await;
    // 실행 중 일반 전송은 거절(대기열을 써야 함)
    let (st, _) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "x", "profile_id": prof })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(add(&s, &sid, &prof, "queue", "다음 질문").await.0, StatusCode::CREATED);
    // 도구가 없어도 합치기는 같은 턴의 다음 모델 호출로 이어지고, 대기열보다 먼저 반영한다.
    assert_eq!(add(&s, &sid, &prof, "steer", "늦은 지시").await.0, StatusCode::CREATED);
    assert_eq!(add(&s, &sid, &prof, "steer", "두 번째 지시").await.0, StatusCode::CREATED);
    s.wait_status(&tid, "completed").await;
    let t = wait_turn_count(&s, &sid, 2).await;
    for x in &t {
        s.wait_status(x["id"].as_str().unwrap(), "completed").await;
    }
    let reqs = f.requests();
    assert_eq!(reqs.len(), 3);
    assert_eq!(count_text(&reqs[1], "다음 질문"), 0, "대기열은 합치기가 끝난 뒤 별도 턴으로 보낸다");
    assert_eq!(count_text(&reqs[1], "늦은 지시"), 1);
    assert_eq!(count_text(&reqs[1], "두 번째 지시"), 1);
    assert_eq!(count_text(&reqs[2], "다음 질문"), 1);
    assert_eq!(turns(&s, &sid).await.len(), 2);
    let (_, messages) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let steers: Vec<_> = messages["items"].as_array().unwrap().iter()
        .filter(|message| message["content"]["source"]["kind"] == "steer").collect();
    assert_eq!(steers.len(), 2);
    assert!(steers.iter().all(|message| message["turn_id"] == tid.as_str()));
    assert!(items(&s, &sid).await.is_empty());
}

#[tokio::test]
async fn queue_pauses_after_cancel_and_can_be_started_or_deleted() {
    let (s, f, prof, sid) = setup().await;
    f.push(fixture::hang_after("멈춤"));
    let tid = start_turn(&s, &sid, &prof, "오래 걸리는 일", false).await;
    s.wait_status(&tid, "running").await;
    wait_requests(&f, 1).await;
    let (_, a) = add(&s, &sid, &prof, "queue", "대기 A").await;
    let (_, b) = add(&s, &sid, &prof, "queue", "대기 B").await;
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    s.wait_status(&tid, "cancelled").await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(turns(&s, &sid).await.len(), 1, "취소 뒤에는 자동 시작하지 않는다");
    assert_eq!(items(&s, &sid).await.len(), 2);
    // B 삭제, A 수동 시작
    let bid = b["followup"]["id"].as_str().unwrap();
    let r = s.raw(Method::DELETE, &format!("/api/v1/sessions/{sid}/followups/{bid}"), None, None, None).await;
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    let r = s.raw(Method::DELETE, &format!("/api/v1/sessions/{sid}/followups/{bid}"), None, None, None).await;
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    f.push(fixture::text("A 답"));
    let aid = a["followup"]["id"].as_str().unwrap();
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/followups/{aid}/start"), json!({})).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let t = wait_turn_count(&s, &sid, 2).await;
    s.wait_status(t[1]["id"].as_str().unwrap(), "completed").await;
    assert!(items(&s, &sid).await.is_empty());
}

#[tokio::test]
async fn interrupt_cancels_current_and_starts_once_even_when_replayed() {
    let (s, f, prof, sid) = setup().await;
    f.push(fixture::hang_after("끝나지 않음"));
    f.push(fixture::slow_text(&["새", "방향"], 150));
    let tid = start_turn(&s, &sid, &prof, "처음 방향", false).await;
    s.wait_status(&tid, "running").await;
    // fixture 대본은 요청 도착 순서로 소비된다: 첫 요청이 닿기 전에 취소하면 새 턴이 hang 대본을 받는다.
    wait_requests(&f, 1).await;
    let body = json!({ "kind": "interrupt", "text": "방향 바꿔", "profile_id": prof });
    let r = s.raw(Method::POST, &format!("/api/v1/sessions/{sid}/followups"), Some(body.clone()), Some("interrupt-key-1"), None).await;
    assert_eq!(r.status(), StatusCode::CREATED);
    let old = s.wait_status(&tid, "cancelled").await;
    assert_eq!(old["error"]["code"], "interrupted_by_user");
    let t = wait_turn_count(&s, &sid, 2).await;
    let new_id = t[1]["id"].as_str().unwrap().to_string();
    s.wait_status(&new_id, "running").await;
    // 같은 key 재전송: 새 턴을 다시 취소하지 않는다
    let r = s.raw(Method::POST, &format!("/api/v1/sessions/{sid}/followups"), Some(body), Some("interrupt-key-1"), None).await;
    assert_eq!(r.status(), StatusCode::CREATED);
    s.wait_status(&new_id, "completed").await;
    assert_eq!(turns(&s, &sid).await.len(), 2);
    assert_eq!(count_text(&f.requests()[1], "방향 바꿔"), 1);
}

#[tokio::test]
async fn followup_without_active_turn_starts_immediately_and_is_limited() {
    let (s, f, prof, sid) = setup().await;
    f.push(fixture::text("바로"));
    let (st, v) = add(&s, &sid, &prof, "steer", "실행 중 아님").await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let tid = v["started_turn"]["id"].as_str().unwrap();
    s.wait_status(tid, "completed").await;
    assert!(items(&s, &sid).await.is_empty());
    let (st, _) = add(&s, &sid, &prof, "later", "x").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    // 상한
    f.push(fixture::hang_after("."));
    let tid = start_turn(&s, &sid, &prof, "오래", false).await;
    s.wait_status(&tid, "running").await;
    wait_requests(&f, 2).await;
    for i in 0..20 {
        assert_eq!(add(&s, &sid, &prof, "queue", &format!("q{i}")).await.0, StatusCode::CREATED);
    }
    let (st, v) = add(&s, &sid, &prof, "queue", "넘침").await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["code"], "followup_limit");
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    s.wait_status(&tid, "cancelled").await;
}

