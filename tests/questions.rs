//! 질문 도구(RUN-013·014): 단일·다중 선택, 자유 입력, 닫기, 검증, 승인 대기와의 구분. 모델 응답은 로컬 fixture.
mod common;

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

async fn ask(s: &TestServer, f: &Fixture, prof: &str, sid: &str, args: Value) -> (String, Value) {
    f.push(fixture::tool_calls(&[("q1", "ask_user", args)]));
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "물어보고 진행해", "profile_id": prof, "tools": true })).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    let t = s.wait_status(&tid, "awaiting_approval").await;
    (tid, t["tool_calls"][0].clone())
}

async fn answer(s: &TestServer, c: &Value, body: Value) -> (StatusCode, Value) {
    let mut b = body;
    b["expected_revision"] = c["revision"].clone();
    s.post(&format!("/api/v1/tool-calls/{}/answer", c["id"].as_str().unwrap()), b).await
}

fn tool_content(req: &Value) -> String {
    req["messages"].as_array().unwrap().iter().filter(|m| m["role"] == "tool").map(|m| m["content"].as_str().unwrap_or("").to_string()).collect()
}

#[tokio::test]
async fn single_choice_question_waits_for_input_then_resumes_with_answer() {
    let (s, f, prof, sid) = setup().await;
    let (tid, c) = ask(&s, &f, &prof, &sid, json!({ "question": "어느 DB를 쓸까요?", "options": [{ "label": "SQLite", "description": "단일 파일" }, { "label": "Postgres" }], "allow_free_text": false })).await;
    // 승인 대기와 구분되는 영속 상태
    assert_eq!(c["status"], "awaiting_input");
    assert_eq!(c["needs_approval"], false);
    assert_eq!(c["target"]["options"][0]["label"], "SQLite");
    assert_eq!(c["target"]["multi_select"], false);
    let (_, sess) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    assert_eq!(sess["pending_approvals"], 0, "질문은 승인 대기로 세지 않는다");
    // 목록에는 승인 대기와 다른 '답변 대기'로 보인다
    assert_eq!(sess["active_turn"], "awaiting_input");
    let pid = sess["project_id"].as_str().unwrap();
    s.post("/api/v1/recent/touch", json!({ "kind": "session", "project_id": pid, "resource_id": sid })).await;
    let (_, r) = s.get("/api/v1/recent").await;
    let item = r["items"].as_array().or(r.as_array()).unwrap().iter().find(|i| i["resource_id"] == sid.as_str()).unwrap().clone();
    assert_eq!(item["status"], "awaiting_input", "{item}");
    // 잘못된 답: 없는 선택지·여러 개·직접 입력 불가·빈 답·오래된 revision
    assert_eq!(answer(&s, &c, json!({ "choices": ["MySQL"] })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(answer(&s, &c, json!({ "choices": ["SQLite", "Postgres"] })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(answer(&s, &c, json!({ "text": "직접" })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(answer(&s, &c, json!({})).await.0, StatusCode::BAD_REQUEST);
    let mut stale = c.clone();
    stale["revision"] = json!(c["revision"].as_i64().unwrap() + 5);
    assert_eq!(answer(&s, &stale, json!({ "choices": ["SQLite"] })).await.0, StatusCode::CONFLICT);
    assert_eq!(f.requests().len(), 1, "답하기 전에는 모델을 다시 부르지 않는다");
    // 정상 답 → 재개, 모델은 답을 도구 결과로 받는다
    f.push(fixture::text("Postgres로 진행할게"));
    let (st, v) = answer(&s, &c, json!({ "choices": ["Postgres"] })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "succeeded");
    s.wait_status(&tid, "completed").await;
    let reqs = f.requests();
    assert_eq!(reqs.len(), 2);
    let tc = tool_content(&reqs[1]);
    assert!(tc.contains("Postgres") && !tc.contains("\"is_error\":true"), "{tc}");
    // 늦은 두 번째 답은 거절
    assert_eq!(answer(&s, &c, json!({ "choices": ["SQLite"] })).await.0, StatusCode::CONFLICT);
}

#[tokio::test]
async fn multi_select_with_free_text_and_replay_is_single() {
    let (s, f, prof, sid) = setup().await;
    let (tid, c) = ask(&s, &f, &prof, &sid, json!({ "question": "무엇을 포함할까요?", "options": [{ "label": "테스트" }, { "label": "문서" }, { "label": "CI" }], "multi_select": true })).await;
    f.push(fixture::text("반영할게"));
    let body = json!({ "expected_revision": c["revision"], "choices": ["테스트", "CI"], "text": "CI는 ARM도" });
    let path = format!("/api/v1/tool-calls/{}/answer", c["id"].as_str().unwrap());
    let r1 = s.raw(Method::POST, &path, Some(body.clone()), Some("answer-1"), None).await;
    assert_eq!(r1.status(), StatusCode::OK);
    let r2 = s.raw(Method::POST, &path, Some(body), Some("answer-1"), None).await;
    assert_eq!(r2.status(), StatusCode::OK, "같은 key 재전송은 같은 결과");
    s.wait_status(&tid, "completed").await;
    assert_eq!(f.requests().len(), 2, "재전송으로 두 번 재개하지 않는다");
    let tc = tool_content(&f.requests()[1]);
    assert!(tc.contains("테스트") && tc.contains("CI") && tc.contains("ARM도"), "{tc}");
}

#[tokio::test]
async fn closing_question_tells_model_user_declined() {
    let (s, f, prof, sid) = setup().await;
    let (tid, c) = ask(&s, &f, &prof, &sid, json!({ "question": "배포할까요?" })).await;
    f.push(fixture::text("알겠어, 배포하지 않을게"));
    let (st, v) = answer(&s, &c, json!({ "cancel": true })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "cancelled");
    s.wait_status(&tid, "completed").await;
    let tc = tool_content(&f.requests()[1]);
    assert!(tc.contains("답하지 않고"), "{tc}");
}

#[tokio::test]
async fn cancelling_turn_closes_question_and_invalid_question_fails_fast() {
    let (s, f, prof, sid) = setup().await;
    let (tid, c) = ask(&s, &f, &prof, &sid, json!({ "question": "어느 쪽?", "options": [{ "label": "A" }, { "label": "B" }] })).await;
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    let t = s.wait_status(&tid, "cancelled").await;
    assert_eq!(t["tool_calls"][0]["status"], "cancelled");
    assert_eq!(answer(&s, &c, json!({ "choices": ["A"] })).await.0, StatusCode::CONFLICT);
    // 중복 label 같은 잘못된 질문은 기다리지 않고 바로 실패로 모델에 돌아간다
    f.push(fixture::tool_calls(&[("q2", "ask_user", json!({ "question": "?", "options": [{ "label": "X" }, { "label": "X" }] }))]));
    f.push(fixture::text("질문을 고쳐 볼게"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "다시", "profile_id": prof, "tools": true })).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(t["tool_calls"][0]["status"], "failed");
    let r = s.raw(Method::GET, "/api/v1/health", None, None, None).await;
    assert!(r.status().is_success());
}
