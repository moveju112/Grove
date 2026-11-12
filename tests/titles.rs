//! 대화 제목 생성(SESSION-002).
mod common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::Method;
use serde_json::json;
use std::time::Duration;

async fn title_of(s: &TestServer, sid: &str) -> String {
    s.get(&format!("/api/v1/sessions/{sid}")).await.1["title"].as_str().unwrap().to_string()
}

/// MODEL-024: 제목·요약 모델 경로는 주 대화 모델과 따로 설정되며 설정한 endpoint로만 간다.
#[tokio::test]
async fn title_and_summary_models_are_configured_separately_from_main_model() {
    let s = TestServer::start().await;
    let main = Fixture::start().await;
    let aux = Fixture::start().await;
    let prof = s.fixture_profile(&main.base).await;
    let aux_prof = s.fixture_profile(&aux.base).await;
    let p = s.create_project("aux").await;
    let pid = p["id"].as_str().unwrap();
    let (_, sv) = s.post(&format!("/api/v1/projects/{pid}/sessions"), json!({ "title": "원래" })).await;
    let sid = sv["id"].as_str().unwrap().to_string();
    for key in ["session.title_profile", "context.summary_profile"] {
        let (st, v) = s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/{key}"), json!({ "expected_revision": 0, "value": aux_prof })).await;
        assert!(st.is_success(), "{key}: {v}");
    }
    main.push(fixture::text(&format!("첫 답 {}", "길게 ".repeat(40))));
    let (_, t) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "첫 질문", "profile_id": prof })).await;
    s.wait_status(t["turn"]["id"].as_str().unwrap(), "completed").await;
    main.push(fixture::text("둘째 답"));
    let (_, t) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "둘째 질문", "profile_id": prof })).await;
    s.wait_status(t["turn"]["id"].as_str().unwrap(), "completed").await;
    aux.push(fixture::text("\"보조 제목\""));
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/title"), json!({})).await;
    assert!(st.is_success(), "{v}");
    assert_eq!(title_of(&s, &sid).await, "보조 제목");
    aux.push(fixture::text("짧은 요약"));
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/compact"), json!({ "profile_id": prof })).await;
    assert_eq!(st, reqwest::StatusCode::CREATED, "{v}");
    assert_eq!(aux.requests().len(), 2, "제목·요약은 보조 모델로");
    assert_eq!(main.requests().len(), 2, "주 대화 모델은 대화 요청만");
}

#[tokio::test]
async fn auto_title_is_off_by_default_and_generates_once_when_enabled() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("t").await;
    let pid = p["id"].as_str().unwrap();
    // 기본 꺼짐: 턴 하나에 모델 요청 하나
    let (_, sv) = s.post(&format!("/api/v1/projects/{pid}/sessions"), json!({ "title": "첫 줄 제목" })).await;
    let sid = sv["id"].as_str().unwrap().to_string();
    f.push(fixture::text("답"));
    let (_, t) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "배포 스크립트를 봐줘", "profile_id": prof })).await;
    s.wait_status(t["turn"]["id"].as_str().unwrap(), "completed").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(f.requests().len(), 1);
    assert_eq!(title_of(&s, &sid).await, "첫 줄 제목");

    // 켜면 첫 완료 턴 뒤 한 번 생성
    s.send(Method::PUT, "/api/v1/settings/server/-/session.auto_title", json!({ "expected_revision": 0, "value": true })).await;
    let (_, sv) = s.post(&format!("/api/v1/projects/{pid}/sessions"), json!({ "title": "임시" })).await;
    let sid2 = sv["id"].as_str().unwrap().to_string();
    f.push(fixture::text("확인했어"));
    f.push(fixture::text("\"배포 스크립트 점검\""));
    let (_, t) = s.post(&format!("/api/v1/sessions/{sid2}/turns"), json!({ "text": "배포 스크립트를 봐줘", "profile_id": prof })).await;
    s.wait_status(t["turn"]["id"].as_str().unwrap(), "completed").await;
    for _ in 0..50 {
        if title_of(&s, &sid2).await != "임시" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(title_of(&s, &sid2).await, "배포 스크립트 점검");
    let reqs = f.requests();
    assert!(reqs.last().unwrap()["messages"][0]["content"].as_str().unwrap().contains("You name conversations"));
    // 두 번째 턴 뒤에는 다시 만들지 않는다
    f.push(fixture::text("또"));
    let n = f.requests().len();
    let (_, t) = s.post(&format!("/api/v1/sessions/{sid2}/turns"), json!({ "text": "다음", "profile_id": prof })).await;
    s.wait_status(t["turn"]["id"].as_str().unwrap(), "completed").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(f.requests().len(), n + 1);
}

#[tokio::test]
async fn manual_generation_falls_back_on_failure_and_respects_user_rename() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("t").await;
    let pid = p["id"].as_str().unwrap();
    let (_, sv) = s.post(&format!("/api/v1/projects/{pid}/sessions"), json!({ "title": "원래 제목" })).await;
    let sid = sv["id"].as_str().unwrap().to_string();
    s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": "로그 회전 설정을 바꾸고 싶어" })).await;
    // 모델 오류 → 기존 제목 유지
    f.push(fixture::Step::Error(500, "boom".into()));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/title"), json!({ "profile_id": prof })).await;
    assert_eq!(v["applied"], false, "{v}");
    assert_eq!(v["reason"], "model_error");
    assert_eq!(title_of(&s, &sid).await, "원래 제목");
    // 빈 출력 → 유지
    f.push(fixture::text("   "));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/title"), json!({ "profile_id": prof })).await;
    assert_eq!(v["reason"], "empty_output");
    // 성공
    f.push(fixture::text("Title: 로그 회전 설정."));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/title"), json!({ "profile_id": prof })).await;
    assert_eq!(v["applied"], true, "{v}");
    assert_eq!(title_of(&s, &sid).await, "로그 회전 설정");
    // 생성 중 사용자가 이름을 바꾸면 덮어쓰지 않는다
    f.push(fixture::slow_text(&["느린 ", "제목"], 400));
    let s2 = &s;
    let sid_c = sid.clone();
    let prof_c = prof.clone();
    let pending = tokio::spawn({
        let base = s2.base.clone();
        let token = s2.token.clone();
        async move {
            reqwest::Client::new()
                .post(format!("{base}/api/v1/sessions/{sid_c}/title"))
                .bearer_auth(token)
                .json(&json!({ "profile_id": prof_c }))
                .send()
                .await
                .unwrap()
                .json::<serde_json::Value>()
                .await
                .unwrap()
        }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (_, cur) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    s.send(Method::PATCH, &format!("/api/v1/sessions/{sid}"), json!({ "expected_revision": cur["revision"], "title": "내가 정한 제목" })).await;
    let v = pending.await.unwrap();
    assert_eq!(v["applied"], false, "{v}");
    assert_eq!(v["reason"], "changed");
    assert_eq!(title_of(&s, &sid).await, "내가 정한 제목");
}
