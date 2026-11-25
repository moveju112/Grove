//! CMP-011: 로컬 provider를 통한 공개 실행 기록·누락·재시작 계약.
use crate::common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

const SUMMARY: &str = "You compress a conversation";

async fn profile(s: &TestServer, f: &Fixture, pricing: Option<Value>) -> String {
    let mut options = json!({ "context_window": 100_000 });
    if let Some(p) = pricing { options["pricing"] = p; }
    let (st, p) = s.post("/api/v1/model-profiles", json!({
        "name": "생성 당시 요약 프로필", "protocol": "openai", "base_url": f.base,
        "model": "summary-model", "options": options,
    })).await;
    assert_eq!(st, StatusCode::CREATED, "{p}");
    p["id"].as_str().unwrap().into()
}

fn prices() -> Value {
    json!({ "currency": "EUR", "version": "fixture-v1", "input_per_mtok": 2, "output_per_mtok": 4, "cache_read_per_mtok": 0.5 })
}

async fn turn(s: &TestServer, f: &Fixture, sid: &str, pid: &str, text: &str) {
    f.push(fixture::text(&"원문 답변 ".repeat(50)));
    let (st, t) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "profile_id": pid, "text": text, "tools": false })).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{t}");
    s.wait_status(t["turn"]["id"].as_str().unwrap(), "completed").await;
}

async fn conversation(s: &TestServer, f: &Fixture, pid: &str) -> String {
    let p = s.create_project(&s.key()).await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_owned();
    turn(s, f, &sid, pid, "첫 원문").await;
    turn(s, f, &sid, pid, "최근 원문").await;
    sid
}

async fn messages(s: &TestServer, sid: &str) -> Value {
    let (st, page) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert_eq!(st, StatusCode::OK, "{page}");
    page
}

async fn wait_summary(f: &Fixture) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !f.requests().iter().any(|r| r.to_string().contains(SUMMARY)) {
            tokio::task::yield_now().await;
        }
    }).await.expect("요약 요청 도착");
}

#[tokio::test]
async fn generation_snapshot_survives_profile_edits_deletion_and_restart() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let pid = profile(&s, &f, Some(prices())).await;
    let sid = conversation(&s, &f, &pid).await;
    let (step, release) = fixture::gated_text("짧은 요약");
    f.push_for(SUMMARY, step);
    let request = {
        let (client, base, token, sid, pid) = (s.client.clone(), s.base.clone(), s.token.clone(), sid.clone(), pid.clone());
        tokio::spawn(async move {
            client.post(format!("{base}/api/v1/sessions/{sid}/compact")).bearer_auth(token)
                .json(&json!({ "profile_id": pid })).send().await.unwrap()
        })
    };
    wait_summary(&f).await;
    let (_, profiles) = s.get("/api/v1/model-profiles").await;
    let p = profiles.as_array().unwrap().iter().find(|p| p["id"] == pid).unwrap();
    let (st, updated) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{pid}"), json!({
        "expected_revision": p["revision"], "name": "편집 후 이름", "model": "edited-model",
        "options": { "pricing": { "currency": "USD", "version": "fixture-v2", "input_per_mtok": 900, "output_per_mtok": 900 } },
    })).await;
    assert_eq!(st, StatusCode::OK, "{updated}");
    release.send(true).unwrap();
    let response = request.await.unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let result: Value = response.json().await.unwrap();
    let note = &result["message"];
    let c = &note["content"];
    assert_eq!(c["generation"], json!({ "profile_name": "생성 당시 요약 프로필", "protocol": "openai", "model": "summary-model" }));
    assert_eq!(c["pricing"], prices());
    assert_eq!(c["cost_status"], "estimated");
    assert!((c["estimated_cost"].as_f64().unwrap() - 34.0 / 1_000_000.0).abs() < 1e-12);
    assert_eq!(f.requests().last().unwrap()["model"], "summary-model");
    for key in ["options", "base_url", "secret_id", "api_key", "headers"] {
        assert!(c.get(key).is_none());
        assert!(c["generation"].get(key).is_none());
    }
    assert!(!c.to_string().contains(&f.base));
    assert_eq!(c["source"]["sha256"].as_str().unwrap().len(), 64);
    assert_eq!(c["source"]["timeline_revision"], 0);
    let (st, deleted) = s.send(Method::DELETE, &format!("/api/v1/model-profiles/{pid}"), json!({})).await;
    assert_eq!(st, StatusCode::OK, "{deleted}");
    s.restart().await;
    let all = messages(&s, &sid).await;
    assert_eq!(all["items"].as_array().unwrap().iter().find(|m| m["id"] == note["id"]).unwrap(), note);
    let from = c["source"]["from_seq"].as_i64().unwrap();
    let upto = c["source"]["upto_seq"].as_i64().unwrap();
    for query in [format!("after_seq={from}"), format!("before_seq={}", upto + 1)] {
        let (st, page) = s.get(&format!("/api/v1/sessions/{sid}/messages?limit=1&{query}")).await;
        assert_eq!(st, StatusCode::OK);
        let seq = page["items"][0]["seq"].as_i64().unwrap();
        assert!(seq > from && seq <= upto);
    }
    let (_, input) = s.get(&format!("/api/v1/sessions/{sid}/model-input")).await;
    assert!(!input.to_string().contains("첫 원문"), "원문 조회로 context를 복원하지 않는다");
}

#[tokio::test]
async fn missing_prices_usage_and_free_prices_are_distinct() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    for (pricing, usage, status, amount) in [
        (None, Some(json!({ "prompt_tokens": 11, "completion_tokens": 3 })), "missing_pricing", None),
        (Some(prices()), None, "usage_unreported_or_zero", None),
        (Some(prices()), Some(json!({ "completion_tokens": 3 })), "usage_unreported_or_zero", None),
        (None, None, "usage_unreported_or_zero", None),
        (Some(json!({ "currency": "USD", "input_per_mtok": 0, "output_per_mtok": 0 })), Some(json!({ "prompt_tokens": 11, "completion_tokens": 3 })), "estimated", Some(0.0)),
    ] {
        let pid = profile(&s, &f, pricing.clone()).await;
        let sid = conversation(&s, &f, &pid).await;
        let mut frames = vec![json!({ "choices": [{ "delta": { "content": "요약" } }] }).to_string()];
        if let Some(u) = usage { frames.push(json!({ "choices": [], "usage": u }).to_string()); }
        frames.push("[DONE]".into());
        let step = fixture::Step::Frames(frames, 0);
        f.push_for(SUMMARY, step);
        let (st, r) = s.post(&format!("/api/v1/sessions/{sid}/compact"), json!({ "profile_id": pid })).await;
        assert_eq!(st, StatusCode::CREATED, "{r}");
        let c = &r["message"]["content"];
        assert_eq!(c["pricing"], pricing.unwrap_or(Value::Null));
        assert_eq!(c["cost_status"], status);
        assert_eq!(c["estimated_cost"].as_f64(), amount);
    }
}

#[tokio::test]
async fn cost_reuses_cache_pricing_and_automatic_summary_profile_selection() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let (st, normal) = s.post("/api/v1/model-profiles", json!({
        "name": "일반 모델", "protocol": "openai", "base_url": f.base,
        "model": "fixture-model", "options": { "context_window": 20 },
    })).await;
    assert_eq!(st, StatusCode::CREATED, "{normal}");
    let normal = normal["id"].as_str().unwrap().to_owned();
    let summary = profile(&s, &f, Some(prices())).await;
    let sid = conversation(&s, &f, &normal).await;
    let (_, session) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    let project = session["project_id"].as_str().unwrap();
    for (key, value) in [("summary_profile", json!(summary)), ("auto_compact_percent", json!(1)), ("compact_min_tokens", json!(0))] {
        let (scope, id) = if key == "summary_profile" { ("server", "-") } else { ("project", project) };
        let (st, r) = s.send(Method::PUT, &format!("/api/v1/settings/{scope}/{id}/context.{key}"), json!({ "expected_revision": 0, "value": value })).await;
        assert_eq!(st, StatusCode::OK, "{r}");
    }
    let (_, usage) = s.get(&format!("/api/v1/sessions/{sid}/context?profile_id={normal}")).await;
    assert_eq!(usage["context_window"], 20, "{usage}");
    assert!(usage["percent"].as_f64().unwrap() >= 1.0, "{usage}");
    f.push_for(SUMMARY, fixture::Step::Frames(vec![
        json!({ "choices": [{ "delta": { "content": "自動 요약" } }] }).to_string(),
        json!({ "choices": [], "usage": { "prompt_tokens": 100, "completion_tokens": 20, "prompt_tokens_details": { "cached_tokens": 30 } } }).to_string(),
        "[DONE]".into(),
    ], 0));
    turn(&s, &f, &sid, &normal, "다음 질문").await;
    let page = messages(&s, &sid).await;
    let notes: Vec<_> = page["items"].as_array().unwrap().iter().filter(|m| m["content"]["type"] == "compaction").collect();
    assert_eq!(notes.len(), 1, "{page}");
    let c = &notes[0]["content"];
    assert_eq!(c["auto"], true);
    assert_eq!(c["profile_id"], summary);
    assert_eq!(c["generation"]["model"], "summary-model");
    // fresh 70×2 + cache 30×0.5 + output 20×4 = 235 / million EUR
    assert!((c["estimated_cost"].as_f64().unwrap() - 235.0 / 1_000_000.0).abs() < 1e-12);
}

#[tokio::test]
async fn cancelled_failed_and_rejected_candidates_never_create_success_records() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let pid = profile(&s, &f, Some(prices())).await;
    let sid = conversation(&s, &f, &pid).await;
    let path = format!("/api/v1/sessions/{sid}/compact");
    let response = s.raw(Method::POST, &path, Some(json!({ "profile_id": pid })), None, Some("")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let before = messages(&s, &sid).await;
    for (step, code) in [
        (fixture::Step::Error(400, "fixture failure".into()), "summary_failed"),
        (fixture::text(""), "empty_summary"),
        (fixture::text(&"너무 긴 요약 ".repeat(1000)), "summary_not_shorter"),
    ] {
        f.push_for(SUMMARY, step);
        let (st, r) = s.post(&path, json!({ "profile_id": pid })).await;
        assert_eq!(st, StatusCode::BAD_GATEWAY, "{r}");
        assert_eq!(r["error"]["code"], code);
        assert_eq!(messages(&s, &sid).await, before);
    }
    f.push_for(SUMMARY, fixture::hang_after("대기"));
    let (cancel, mut rx) = tokio::sync::watch::channel(false);
    let app = s.server.as_ref().unwrap().app.clone();
    let (sid2, pid2) = (sid.clone(), pid.clone());
    let pending = tokio::spawn(async move { grove::context::compact(&app, &sid2, &pid2, false, &mut rx).await });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while f.requests().iter().filter(|r| r.to_string().contains(SUMMARY)).count() < 4 { tokio::task::yield_now().await; }
    }).await.unwrap();
    cancel.send(true).unwrap();
    assert_eq!(pending.await.unwrap().unwrap_err().code, "cancelled");
    assert_eq!(messages(&s, &sid).await, before);
    assert_eq!(f.requests().iter().filter(|r| r.to_string().contains(SUMMARY)).count(), 4, "mutation 자동 재시도 없음");
}
