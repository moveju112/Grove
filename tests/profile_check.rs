//! 모델 프로필 연결 확인(AUTH-001): 생성 요청 없이 확인하고, 결과를 남기며, 비밀은 응답·기록에 남기지 않는다.
mod common;

use common::fixture::Fixture;
use common::*;
use reqwest::StatusCode;
use serde_json::json;

#[tokio::test]
async fn profile_check_reports_ok_failure_and_never_echoes_secret() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let (st, r) = s.post(&format!("/api/v1/model-profiles/{prof}/check"), json!({})).await;
    assert_eq!(st, StatusCode::OK, "{r}");
    assert_eq!(r["ok"], true);
    assert_eq!(r["detail"]["models"], 2);
    assert_eq!(r["detail"]["model_listed"], true);
    assert!(r["latency_ms"].as_i64().is_some() && r["checked_at"].is_string());
    assert!(f.requests().is_empty(), "생성 요청(chat/completions)을 보내지 않는다");
    // 목록에도 마지막 결과가 보인다
    let (_, list) = s.get("/api/v1/model-profiles").await;
    let p = list.as_array().unwrap().iter().find(|p| p["id"] == prof.as_str()).unwrap().clone();
    assert_eq!(p["last_check"]["ok"], true);

    // 인증 실패: 서버가 키를 되돌려도 응답·저장에는 남기지 않는다
    let sec = p["secret_id"].as_str().unwrap();
    let bad_base = f.base.replace("/v1", "/bad");
    let (st, bad) = s.post("/api/v1/model-profiles", json!({ "name": "bad", "protocol": "openai", "base_url": bad_base, "model": "x", "secret_id": sec })).await;
    assert_eq!(st, StatusCode::CREATED, "{bad}");
    let bid = bad["id"].as_str().unwrap();
    let (st, r) = s.post(&format!("/api/v1/model-profiles/{bid}/check"), json!({})).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "auth_failed");
    assert_eq!(r["detail"]["status"], 401);
    let all = s.get("/api/v1/model-profiles").await.1.to_string();
    assert!(!r.to_string().contains("sk-test-secret-value-1234") && !all.contains("sk-test-secret-value-1234"), "{r}");
    assert!(r["message"].as_str().unwrap().contains("[redacted]"));

    // 연결 불가
    let (_, gone) = s.post("/api/v1/model-profiles", json!({ "name": "gone", "protocol": "openai", "base_url": "http://127.0.0.1:9/v1", "model": "x" })).await;
    let (_, r) = s.post(&format!("/api/v1/model-profiles/{}/check", gone["id"].as_str().unwrap()), json!({})).await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "connect_failed", "{r}");
    // 없는 프로필
    let (st, _) = s.post("/api/v1/model-profiles/nope/check", json!({})).await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    // PATCH 의미: secret_id 생략은 그대로, null은 연결 끊기(이전 결함: null이 무시됨)
    let (_, list) = s.get("/api/v1/model-profiles").await;
    let b = list.as_array().unwrap().iter().find(|p| p["id"] == bid).unwrap().clone();
    let (st, v) = s.send(reqwest::Method::PUT, &format!("/api/v1/model-profiles/{bid}"), json!({ "expected_revision": b["revision"], "name": "bad2" })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["secret_id"], b["secret_id"], "생략하면 그대로");
    let (st, v) = s.send(reqwest::Method::PUT, &format!("/api/v1/model-profiles/{bid}"), json!({ "expected_revision": v["revision"], "secret_id": null })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert!(v["secret_id"].is_null(), "null이면 연결을 끊는다: {v}");
}
