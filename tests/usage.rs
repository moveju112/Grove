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
    let (st, dashboard) = s.get(&format!("/api/v1/usage/dashboard?from={from}&to={to}&group_by=hour&tz_offset_minutes=540")).await;
    assert_eq!(st, StatusCode::OK, "{dashboard}");
    for field in ["input_tokens", "output_tokens", "responses", "cache_read_tokens", "reasoning_tokens"] {
        assert_eq!(dashboard["total"][field], v["total"][field]);
        let sum: u64 = dashboard["models"].as_array().unwrap().iter().map(|row| row["metrics"][field].as_u64().unwrap()).sum();
        assert_eq!(sum, dashboard["total"][field].as_u64().unwrap());
        let sum: u64 = dashboard["series"].as_array().unwrap().iter().map(|bucket| bucket["total"][field].as_u64().unwrap()).sum();
        assert_eq!(sum, dashboard["total"][field].as_u64().unwrap());
    }
    assert_eq!(dashboard["estimated_cost"], v["total"]["estimated_cost"]);
    assert_eq!(dashboard["unpriced_tokens"], 14);
    assert_eq!(dashboard["providers"][0]["provider"], "openai");
    let (st, _) = s.get(&format!("/api/v1/usage/dashboard?from={from}&to={to}&group_by=model")).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = s.get("/api/v1/usage/dashboard?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z&group_by=hour").await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "긴 기간에 시간별 버킷을 무제한 만들지 않는다");
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
    let fixture::Step::Frames(mut frames, delay) = fixture::slow_text(&["끝", "!"], 150) else { unreachable!() };
    frames.insert(frames.len() - 1, json!({"choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 20}}).to_string());
    f.push(fixture::Step::Frames(frames, delay));
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
    let provider = tm["provider_ms"].as_i64().unwrap();
    let overhead = tm["other_ms"].as_i64().unwrap();
    assert!(provider >= 400, "공급자 호출·stream 대기 {provider}ms");
    assert!(overhead >= 0);
    assert_eq!(total, appr + tool + provider + overhead, "{tm}");
    assert_eq!(tm["running"], false);
    let now = time::OffsetDateTime::now_utc();
    let fmt = |at: time::OffsetDateTime| at.format(&time::format_description::well_known::Rfc3339).unwrap();
    let (_, dashboard) = s.get(&format!("/api/v1/usage/dashboard?from={}&to={}&group_by=day", fmt(now - time::Duration::days(1)), fmt(now + time::Duration::days(1)))).await;
    let measured_ms = dashboard["total"]["response_ms"].as_i64().unwrap();
    assert!(measured_ms >= 400 && measured_ms <= provider + 2, "승인 대기·Grove 도구 시간을 속도 분모에 넣지 않는다: {dashboard}");
    let output = dashboard["total"]["measured_output_tokens"].as_f64().unwrap();
    assert!((dashboard["total"]["tok_per_second"].as_f64().unwrap() - output * 1000.0 / measured_ms as f64).abs() < 0.000001);
    // 이전 버전 또는 강제 중단으로 구간이 미확정이면 0으로 만들지 않는다.
    let db_tid = tid.clone();
    s.server.as_ref().unwrap().app.db.call(move |c| {
        c.execute("UPDATE turns SET provider_ms=NULL WHERE id=?1", [&db_tid])?;
        let legacy = grove::usage::turn_timing(c, &db_tid, time::OffsetDateTime::now_utc())?;
        assert!(legacy["provider_ms"].is_null() && legacy["other_ms"].is_null(), "{legacy}");
        c.execute("UPDATE turns SET provider_ms=100,provider_started_at=created_at WHERE id=?1", [&db_tid])?;
        let interrupted = grove::usage::turn_timing(c, &db_tid, time::OffsetDateTime::now_utc())?;
        assert!(interrupted["provider_ms"].is_null() && interrupted["other_ms"].is_null(), "{interrupted}");
        Ok(())
    }).await.unwrap();
}

#[tokio::test]
async fn provider_timing_includes_cancelled_calls_and_is_preserved_after_restart() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("timing cancellation").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (step, _release) = fixture::gated_text("never released");
    f.push(step);
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"wait","profile_id":prof})).await;
    let tid = v["turn"]["id"].as_str().unwrap();
    s.wait_turn(tid, |t| t["timing"]["provider_ms"].as_i64().is_some_and(|ms| ms >= 150)).await;
    let (st, _) = s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    assert_eq!(st, StatusCode::ACCEPTED);
    let finished = s.wait_status(tid, "cancelled").await;
    assert!(finished["timing"]["provider_ms"].as_i64().unwrap() >= 150, "{finished}");
    assert_eq!(finished["timing"]["approval_wait_ms"], 0);
    assert_eq!(finished["timing"]["tool_ms"], 0);
    s.restart().await;
    let (_, restored) = s.get(&format!("/api/v1/turns/{tid}")).await;
    assert_eq!(restored["timing"], finished["timing"]);
    assert_eq!(f.requests().len(), 1, "다시 시작해도 공급자를 재호출하지 않는다");
}

#[tokio::test]
async fn auxiliary_title_memory_and_discarded_summary_calls_are_counted_by_their_own_model() {
    let s = TestServer::start().await;
    let main = Fixture::start().await;
    let aux = Fixture::start().await;
    let prof = s.fixture_profile(&main.base).await;
    let aux_prof = s.fixture_profile(&aux.base).await;
    let p = s.create_project("aux usage").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    for (key, value) in [
        ("session.title_profile", json!({ "profile_id": aux_prof, "model": "title-small" })),
        ("context.summary_profile", json!({ "profile_id": aux_prof, "model": "summary-large" })),
        ("memory.profile", json!({ "profile_id": aux_prof, "model": "memory-small", "effort": "medium" })),
        ("memory.enabled", json!(true)),
        ("session.auto_title", json!(false)),
    ] {
        let (st, v) = s.send(reqwest::Method::PUT, &format!("/api/v1/settings/server/-/{key}"), json!({ "expected_revision": 0, "value": value })).await;
        assert!(st.is_success(), "{key}: {v}");
    }
    for text in ["첫 답", "둘째 답"] {
        main.push(fixture::text(text));
        turn(&s, &sid, &prof, None).await;
    }
    aux.push(fixture::text("\"보조 제목\""));
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/title"), json!({})).await;
    assert!(st.is_success() && v["applied"] == true, "{v}");
    // 원문보다 긴 요약은 버려지지만 모델 사용량은 생긴다.
    aux.push(fixture::text(&"긴 요약 ".repeat(2000)));
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/compact"), json!({ "profile_id": prof })).await;
    assert_eq!(st, StatusCode::BAD_GATEWAY, "{v}");
    aux.push(fixture::text("결정: 보조 사용량을 기록한다."));
    let app = &s.server.as_ref().unwrap().app;
    grove::memory::tick(app).await.unwrap();
    // 응답을 받지 못한 실패는 원인만 남기고 사용량에는 넣지 않는다.
    aux.push(fixture::Step::Error(400, "model unavailable".into()));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/title"), json!({})).await;
    assert_eq!(v["reason"], "model_error", "{v}");
    assert_eq!(aux.requests().len(), 4);

    let calls = app.db.call(|c| {
        let mut st = c.prepare("SELECT kind, status, error_code, model, usage IS NOT NULL FROM aux_model_calls ORDER BY created_at, rowid")?;
        Ok(st.query_map([], |r| Ok(json!([r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?, r.get::<_, bool>(4)?])))?
            .collect::<Result<Vec<_>, _>>()?)
    }).await.unwrap();
    assert_eq!(calls, vec![
        json!(["title", "applied", null, "title-small", true]),
        json!(["compaction", "discarded", "summary_not_shorter", "summary-large", true]),
        json!(["maintainer", "applied", null, "memory-small", true]),
        json!(["title", "failed", "model_error", "title-small", false]),
    ]);

    let now = time::OffsetDateTime::now_utc();
    let fmt = |t: time::OffsetDateTime| t.format(&time::format_description::well_known::Rfc3339).unwrap();
    let (from, to) = (fmt(now - time::Duration::days(1)), fmt(now + time::Duration::days(1)));
    let (_, models) = s.get(&format!("/api/v1/usage?from={from}&to={to}&group_by=model")).await;
    assert_eq!(models["total"]["responses"], 5, "대화 응답 2개와 보조 응답 3개: {models}");
    assert_eq!(models["total"]["input_tokens"], 55);
    for model in ["title-small", "summary-large", "memory-small"] {
        assert_eq!(row(&models, model)["responses"], 1, "{model}: {models}");
    }
    let (_, agents) = s.get(&format!("/api/v1/usage?from={from}&to={to}&group_by=agent")).await;
    for agent in ["(제목 생성)", "(압축 요약)", "(메모리 정리)"] {
        assert_eq!(row(&agents, agent)["responses"], 1, "{agent}: {agents}");
    }
    let (_, dashboard) = s.get(&format!("/api/v1/usage/dashboard?from={from}&to={to}&group_by=hour")).await;
    assert_eq!(dashboard["total"]["responses"], 5, "{dashboard}");
    assert!(dashboard["models"].as_array().unwrap().iter().any(|m| m["key"] == "memory-small"), "{dashboard}");
}
