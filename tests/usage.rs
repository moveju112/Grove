//! 사용량·비용 집계와 턴 시간 분해(USAGE-001, 003~005, 008).
mod common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};
use std::time::Duration;

async fn profile(s: &TestServer, base: &str, name: &str, pricing: Option<Value>) -> String {
    let (_, sec) = s.post("/api/v1/secrets", json!({ "label": name, "value": "sk-test-secret-value-7777" })).await;
    let mut opts = json!({ "timeout_secs": 30 });
    if let Some(p) = pricing {
        opts["pricing"] = p;
    }
    let (st, p) = s.post("/api/v1/model-profiles", json!({ "name": name, "protocol": "openai", "base_url": base, "model": format!("model-{name}"), "secret_id": sec["id"], "options": opts })).await;
    assert_eq!(st, StatusCode::CREATED, "{p}");
    p["id"].as_str().unwrap().to_string()
}

async fn turn(s: &TestServer, sid: &str, prof: &str, agent: Option<&str>) {
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "q", "profile_id": prof, "agent_id": agent })).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
}

fn row<'a>(v: &'a Value, key: &str) -> &'a Value {
    v["rows"].as_array().unwrap().iter().find(|r| r["key"] == key).unwrap_or_else(|| panic!("{key} 없음: {v}"))
}

#[tokio::test]
async fn aggregates_by_dimension_with_estimated_cost_and_unpriced_tokens() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let priced = profile(&s, &f.base, "priced", Some(json!({ "currency": "USD", "version": "v-test", "input_per_mtok": 1000000.0, "output_per_mtok": 2000000.0 }))).await;
    let free = profile(&s, &f.base, "free", None).await;
    // 잘못된 가격표 거부
    let (_, sec) = s.post("/api/v1/secrets", json!({ "label": "bad", "value": "sk-test-secret-value-8888" })).await;
    let (st, _) = s.post("/api/v1/model-profiles", json!({ "name": "bad", "protocol": "openai", "base_url": f.base, "model": "m", "secret_id": sec["id"], "options": { "pricing": { "currency": "dollar", "input_per_mtok": 1, "output_per_mtok": 1 } } })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let p = s.create_project("u").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    // fixture 응답 하나 = input 11, output 3
    for _ in 0..2 {
        f.push(fixture::text("a"));
        turn(&s, &sid, &priced, Some("reviewer")).await;
    }
    f.push(fixture::text("b"));
    turn(&s, &sid, &free, None).await;
    let now = time::OffsetDateTime::now_utc();
    let fmt = |t: time::OffsetDateTime| t.format(&time::format_description::well_known::Rfc3339).unwrap();
    let (from, to) = (fmt(now - time::Duration::days(1)), fmt(now + time::Duration::days(1)));
    let (from, to) = (from.as_str(), to.as_str());
    let (st, v) = s.get(&format!("/api/v1/usage?from={from}&to={to}&group_by=model")).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["total"]["input_tokens"], 33);
    assert_eq!(v["total"]["output_tokens"], 9);
    assert_eq!(v["total"]["responses"], 3);
    let pr = row(&v, "model-priced");
    // 22 input × 1 + 6 output × 2 (백만 token당 백만 → token당 1·2)
    assert_eq!(pr["estimated_cost"][0], json!({ "currency": "USD", "amount": 34.0 }));
    assert_eq!(pr["unpriced_tokens"], 0);
    let fr = row(&v, "model-free");
    assert!(fr["estimated_cost"].as_array().unwrap().is_empty(), "가격 없으면 금액을 만들지 않는다");
    assert_eq!(fr["unpriced_tokens"], 14);
    assert_eq!(v["total"]["reasoning_unreported_responses"], 3, "보고 안 된 reasoning은 0이 아니라 미보고로 센다");
    assert_eq!(v["pricing_versions"], json!(["v-test"]));
    assert_eq!(v["cost_is_estimate"], true);
    // 에이전트별
    let (_, a) = s.get(&format!("/api/v1/usage?from={from}&to={to}&group_by=agent")).await;
    assert_eq!(row(&a, "reviewer")["responses"], 2);
    assert_eq!(row(&a, "(없음)")["responses"], 1);
    // 일별(시간대 반영)과 기간 필터
    let (_, d) = s.get(&format!("/api/v1/usage?from={from}&to={to}&group_by=day&tz_offset_minutes=540")).await;
    assert_eq!(d["rows"].as_array().unwrap().len(), 1);
    let (_, none) = s.get("/api/v1/usage?from=2000-01-01T00:00:00Z&to=2000-02-01T00:00:00Z&group_by=day").await;
    assert_eq!(none["total"]["responses"], 0);
    let (st, _) = s.get(&format!("/api/v1/usage?from={to}&to={from}&group_by=day")).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = s.get(&format!("/api/v1/usage?from={from}&to={to}&group_by=color")).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = s.get("/api/v1/usage?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z&group_by=day").await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "400일 넘는 기간 거부");
}

#[tokio::test]
async fn turn_timing_separates_approval_wait_from_tool_and_model() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("t").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    f.push(fixture::tool_calls(&[("s1", "shell", json!({ "command": "sleep 0.3" }))]));
    f.push(fixture::text("끝"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "go", "profile_id": prof, "tools": true })).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    let t = s.wait_status(&tid, "awaiting_approval").await;
    assert_eq!(t["timing"]["running"], true);
    tokio::time::sleep(Duration::from_millis(600)).await;
    let c = &t["tool_calls"][0];
    s.post(&format!("/api/v1/tool-calls/{}/decision", c["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": c["revision"] })).await;
    let t = s.wait_status(&tid, "completed").await;
    let tm = &t["timing"];
    let (total, appr, tool, other) =
        (tm["total_ms"].as_i64().unwrap(), tm["approval_wait_ms"].as_i64().unwrap(), tm["tool_ms"].as_i64().unwrap(), tm["model_and_other_ms"].as_i64().unwrap());
    assert!(appr >= 550, "승인 대기 {appr}ms");
    assert!((250..2000).contains(&tool), "도구 실행 {tool}ms");
    assert_eq!(total, appr + tool + other, "{tm}");
    assert_eq!(tm["running"], false);
}
