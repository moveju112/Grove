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
    for (key, model, effort) in [("session.title_profile", "title-small", "low"), ("context.summary_profile", "summary-large", "high")] {
        let (st, v) = s.send(Method::PUT, &format!("/api/v1/settings/server/-/{key}"), json!({ "expected_revision": 0, "value": {"profile_id": aux_prof, "model": model, "effort": effort} })).await;
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
    let requests = aux.requests();
    assert_eq!(requests[0]["model"], "title-small");
    assert_eq!(requests[0]["reasoning_effort"], "low");
    assert_eq!(requests[1]["model"], "summary-large");
    assert_eq!(requests[1]["reasoning_effort"], "high");
    let (_, profiles) = s.get("/api/v1/model-profiles").await;
    assert_eq!(profiles.as_array().unwrap().iter().find(|p| p["id"] == aux_prof).unwrap()["model"], "fixture-model");
}

#[tokio::test]
async fn auto_title_uses_server_model_with_server_or_project_auto_title() {
    for scope in ["server", "project"] {
        let s = TestServer::start().await;
        let main = Fixture::start().await;
        let aux = Fixture::start().await;
        let prof = s.fixture_profile(&main.base).await;
        let aux_prof = s.fixture_profile(&aux.base).await;
        let p = s.create_project("title-model").await;
        let pid = p["id"].as_str().unwrap();
        let scope_id = if scope == "server" { "-" } else { pid };
        for (key, value) in [("session.auto_title", json!(true)), ("session.title_profile", json!({"profile_id":aux_prof,"model":"auto-title-small"}))] {
            let (scope, scope_id) = if key == "session.title_profile" { ("server", "-") } else { (scope, scope_id) };
            let (st, v) = s.send(Method::PUT, &format!("/api/v1/settings/{scope}/{scope_id}/{key}"), json!({ "expected_revision": 0, "value": value })).await;
            assert!(st.is_success(), "{key}: {v}");
        }
        let (_, session) = s.post(&format!("/api/v1/projects/{pid}/sessions"), json!({ "title": "임시" })).await;
        let sid = session["id"].as_str().unwrap();
        main.push(fixture::text("대화 응답"));
        aux.push(fixture::text("전용 모델 제목"));
        let (_, turn) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "제목 모델 분리 확인", "profile_id": prof })).await;
        s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
        tokio::time::timeout(Duration::from_secs(3), async {
            while title_of(&s, sid).await != "전용 모델 제목" {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("설정한 전용 모델로 자동 제목을 생성해야 한다");
        assert_eq!(main.requests().len(), 1, "{scope}: 대화 모델은 대화 요청만");
        assert_eq!(aux.requests().len(), 1, "{scope}: 제목은 전용 모델로");
        assert_eq!(aux.requests()[0]["model"],"auto-title-small");
        assert!(aux.requests()[0]["messages"][0]["content"].as_str().unwrap().contains("You name conversations"));
    }
}

#[tokio::test]
async fn auto_title_skips_disabled_or_unconfigured_model() {
    // 이전 턴의 후처리가 다음 시나리오의 설정을 읽지 않도록 서버를 분리한다.
    for enabled in [false, true] {
        let s = TestServer::start().await;
        let main = Fixture::start().await;
        let aux = Fixture::start().await;
        let profile = s.fixture_profile(&main.base).await;
        let (key, value) = if enabled {
            ("session.auto_title", json!(true))
        } else {
            ("session.title_profile", json!(s.fixture_profile(&aux.base).await))
        };
        let (status, body) = s.send(Method::PUT, &format!("/api/v1/settings/server/-/{key}"),
            json!({"expected_revision":0,"value":value})).await;
        assert!(status.is_success(), "{body}");
        let project = s.create_project("title-disabled").await;
        let session = s.create_session(project["id"].as_str().unwrap()).await;
        let sid = session["id"].as_str().unwrap();
        main.push(fixture::text("답변"));
        let (_, turn) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"첫 목표","profile_id":profile})).await;
        let tid = turn["turn"]["id"].as_str().unwrap();
        s.wait_status(tid, "completed").await;
        grove::titles::after_turn(&s.server.as_ref().unwrap().app, tid).await;
        assert_eq!(main.requests().len(), 1);
        assert!(aux.requests().is_empty());
    }
}

#[tokio::test]
async fn auto_title_updates_each_turn_and_preserves_manual_titles() {
    let s = TestServer::start().await;
    let main = Fixture::start().await;
    let aux = Fixture::start().await;
    let profile = s.fixture_profile(&main.base).await;
    let title_profile = s.fixture_profile(&aux.base).await;
    let pid = s.create_project("title-flow").await["id"].as_str().unwrap().to_string();
    let sid = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    for (key, value) in [("session.auto_title", json!(true)), ("session.title_profile", json!(title_profile))] {
        let (status, body) = s.send(Method::PUT, &format!("/api/v1/settings/server/-/{key}"),
            json!({"expected_revision":0,"value":value})).await;
        assert!(status.is_success(), "{body}");
    }
    for (prompt,title) in [("배포 스크립트 점검","배포 절차 확인"),("작업을 바꿔 로그인 오류 수정","로그인 오류 수정")] {
        main.push(fixture::text("처리 결과"));
        aux.push(fixture::text(title));
        let (_,t) = s.post(&format!("/api/v1/sessions/{sid}/turns"),json!({"text":prompt,"profile_id":profile})).await;
        s.wait_status(t["turn"]["id"].as_str().unwrap(),"completed").await;
        tokio::time::timeout(Duration::from_secs(3),async { while title_of(&s,&sid).await!=title { tokio::time::sleep(Duration::from_millis(20)).await; } }).await.unwrap();
    }
    let request = aux.requests().last().unwrap().clone();
    let source = request["messages"][1]["content"].as_str().unwrap();
    assert!(source.contains("로그인 오류 수정"));
    assert!(source.contains("currentTitle"));
    assert!(request["tools"].is_null() || request["tools"].as_array().is_some_and(Vec::is_empty));
    assert_eq!(main.requests().len(),2);
    let (_,session) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    s.send(Method::PATCH,&format!("/api/v1/sessions/{sid}"),json!({"expected_revision":session["revision"],"title":"직접 정한 제목"})).await;
    main.push(fixture::text("후속 답변"));
    let (_,t) = s.post(&format!("/api/v1/sessions/{sid}/turns"),json!({"text":"다른 목표","profile_id":profile})).await;
    s.wait_status(t["turn"]["id"].as_str().unwrap(),"completed").await;
    grove::titles::after_turn(&s.server.as_ref().unwrap().app,t["turn"]["id"].as_str().unwrap()).await;
    assert_eq!(title_of(&s,&sid).await,"직접 정한 제목");
    assert_eq!(aux.requests().len(),2);
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
