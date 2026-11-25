//! 대화별 Goal 목록(AGENT-017/018).
use crate::common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;

fn titles(v: &Value) -> Vec<String> {
    v["goals"].as_array().unwrap().iter().map(|g| g["title"].as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn crud_reorder_conflict_and_persistence() {
    let mut s = TestServer::start().await;
    let p = s.create_project("g").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let base = format!("/api/v1/sessions/{sid}/goals");
    let mut ids = vec![];
    for t in ["설계", "구현", "시험"] {
        let (st, g) = s.post(&base, json!({ "title": t })).await;
        assert_eq!(st, StatusCode::CREATED, "{g}");
        ids.push(g["id"].as_str().unwrap().to_string());
    }
    let (st, _) = s.post(&base, json!({ "title": "   " })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    // 상태 변경 + revision 충돌
    let (st, g) = s.send(Method::PATCH, &format!("{base}/{}", ids[0]), json!({ "expected_revision": 1, "status": "done" })).await;
    assert_eq!(st, StatusCode::OK, "{g}");
    let (st, _) = s.send(Method::PATCH, &format!("{base}/{}", ids[0]), json!({ "expected_revision": 1, "title": "x" })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    let (st, _) = s.send(Method::PATCH, &format!("{base}/{}", ids[1]), json!({ "expected_revision": 1, "status": "finished" })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    // 순서: 누락·남의 ID 거부, 전체면 반영
    let (st, _) = s.post(&format!("{base}/reorder"), json!({ "ids": [ids[2], ids[0]] })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, v) = s.post(&format!("{base}/reorder"), json!({ "ids": [ids[2], ids[0], ids[1]] })).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(titles(&v), ["시험", "설계", "구현"]);
    // 다른 대화의 항목은 바꿀 수 없다
    let other = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (st, _) = s.send(Method::PATCH, &format!("/api/v1/sessions/{other}/goals/{}", ids[1]), json!({ "expected_revision": 1, "status": "done" })).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    // 재시작 후에도 그대로
    s.restart().await;
    let (_, v) = s.get(&base).await;
    assert_eq!(titles(&v), ["시험", "설계", "구현"]);
    assert_eq!(v["goals"][1]["status"], "done");
}

#[tokio::test]
async fn model_manages_goals_reminder_reaches_next_turn_and_no_auto_turns() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("gm").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    // 모델이 goal 도구로 항목을 추가(승인 없이 실행)
    f.push(fixture::tool_calls(&[("g1", "goal", json!({ "action": "add", "titles": ["로그인 고치기", "시험 추가"] }))]));
    f.push(fixture::text("목록을 만들었어"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "계획 세워", "profile_id": prof, "tools": true })).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(t["tool_calls"][0]["status"], "succeeded", "{t}");
    assert_eq!(t["tool_calls"][0]["needs_approval"], false);
    let (_, g) = s.get(&format!("/api/v1/sessions/{sid}/goals")).await;
    assert_eq!(titles(&g), ["로그인 고치기", "시험 추가"]);
    let first = g["goals"][0]["id"].as_str().unwrap().to_string();
    // 미완료가 있어도 턴이 자동으로 생기지 않는다
    tokio::time::sleep(Duration::from_millis(800)).await;
    let (_, turns) = s.get(&format!("/api/v1/sessions/{sid}/turns")).await;
    assert_eq!(turns.as_array().unwrap().len(), 1, "자동 턴 없음");
    // 다음 턴 지침에 미완료 목록, 모델이 하나를 완료로 바꾼다
    f.push(fixture::tool_calls(&[("g2", "goal", json!({ "action": "update", "id": first, "status": "done" }))]));
    f.push(fixture::text("하나 끝"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "진행해", "profile_id": prof, "tools": true })).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let reqs = f.requests();
    let sys = reqs[2]["messages"][0]["content"].as_str().unwrap();
    assert!(sys.contains("# Open goals") && sys.contains("로그인 고치기") && sys.contains("시험 추가"), "{sys}");
    let (_, g) = s.get(&format!("/api/v1/sessions/{sid}/goals")).await;
    assert_eq!(g["goals"][0]["status"], "done");
    // 다른 대화의 Goal ID로 바꾸려 하면 실패로 기록
    let other = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (_, c) = s.post(&format!("/api/v1/sessions/{other}/tool-requests"), json!({ "name": "goal", "args": { "action": "update", "id": first, "status": "cancelled" } })).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (_, call) = s.get(&format!("/api/v1/tool-calls/{}", c["id"].as_str().unwrap())).await;
    assert_eq!(call["status"], "failed", "{call}");
    let (_, g) = s.get(&format!("/api/v1/sessions/{sid}/goals")).await;
    assert_eq!(g["goals"][0]["status"], "done");
}
