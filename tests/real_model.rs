//! 실제 모델 시험(opt-in, 경량 모델 기준). 기본 `cargo test`에서는 실행하지 않는다(#[ignore]).
//!
//! ```bash
//! GROVE_REAL_BASE=http://127.0.0.1:11434/v1 GROVE_REAL_MODEL=qwen2.5:1.5b \
//!   cargo test --test real_model -- --ignored --test-threads=1
//! ```
//! 로컬 OpenAI 호환 서버(Ollama 등)는 API 키가 필요 없다. 키가 필요하면 GROVE_REAL_KEY.
//! 작은 모델의 답은 흔들리므로, 정확한 문장 대신 프로토콜·상태·도구 실행 결과를 판정한다.
mod common;

use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};
use std::time::Duration;

fn env(k: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| panic!("{k}가 필요합니다(opt-in 실모델 시험)"))
}

async fn real_profile(s: &TestServer) -> String {
    let mut body = json!({
        "name": "real", "protocol": "openai", "base_url": env("GROVE_REAL_BASE"), "model": env("GROVE_REAL_MODEL"),
        "options": { "timeout_secs": 300, "max_tokens": 512 },
    });
    if let Ok(k) = std::env::var("GROVE_REAL_KEY") {
        let (st, sec) = s.post("/api/v1/secrets", json!({ "label": "real", "value": k })).await;
        assert_eq!(st, StatusCode::CREATED);
        body["secret_id"] = sec["id"].clone();
    }
    let (st, p) = s.post("/api/v1/model-profiles", body).await;
    assert_eq!(st, StatusCode::CREATED, "{p}");
    p["id"].as_str().unwrap().to_string()
}

async fn wait_done(s: &TestServer, turn: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        let (_, t) = s.get(&format!("/api/v1/turns/{turn}")).await;
        if ["completed", "failed", "cancelled", "interrupted", "awaiting_approval"].contains(&t["status"].as_str().unwrap_or("")) {
            return t;
        }
        assert!(tokio::time::Instant::now() < deadline, "실모델 턴 시간 초과: {t}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// 첫 대화와 이어지는 두 번째 요청(대화 이력이 모델에 전달되는지).
#[tokio::test]
#[ignore]
async fn real_model_answers_and_keeps_history() {
    let s = TestServer::start().await;
    let prof = real_profile(&s).await;
    let p = s.create_project("real").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (st, v) = s
        .post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "My favorite color is teal. Reply with one short sentence.", "profile_id": prof }))
        .await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let t = wait_done(&s, v["turn"]["id"].as_str().unwrap()).await;
    assert_eq!(t["status"], "completed", "{t}");
    assert!(t["usage"]["output_tokens"].as_i64().unwrap_or(0) > 0 || t["usage"].as_object().is_some_and(|u| !u.is_empty()), "사용량 기록: {t}");
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "What is my favorite color? Answer with just the color.", "profile_id": prof })).await;
    let t = wait_done(&s, v["turn"]["id"].as_str().unwrap()).await;
    assert_eq!(t["status"], "completed", "{t}");
    let (_, msgs) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let last = msgs["items"].as_array().unwrap().iter().rev().find(|m| m["role"] == "assistant").unwrap()["content"]["text"].as_str().unwrap().to_lowercase();
    assert!(last.contains("teal"), "이전 대화를 기억해야 한다: {last}");
}

/// 도구 루프: 읽기 도구(승인 불필요)를 실제 모델이 호출하고 결과로 답한다.
#[tokio::test]
#[ignore]
async fn real_model_uses_read_tool() {
    let s = TestServer::start().await;
    let prof = real_profile(&s).await;
    let p = s.create_project("real-tools").await;
    let root = p["root_path"].as_str().unwrap().to_string();
    std::fs::write(format!("{root}/notes.txt"), "The secret code word is MANGO-42.\n").unwrap();
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (st, v) = s
        .post(
            &format!("/api/v1/sessions/{sid}/turns"),
            json!({ "text": "Use the read tool to read notes.txt, then tell me the secret code word.", "profile_id": prof, "tools": true }),
        )
        .await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let t = wait_done(&s, v["turn"]["id"].as_str().unwrap()).await;
    assert_eq!(t["status"], "completed", "{t}");
    let calls = t["tool_calls"].as_array().unwrap();
    assert!(calls.iter().any(|c| c["name"] == "read" && c["status"] == "succeeded"), "read 도구 실행: {calls:?}");
    let (_, msgs) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let last = msgs["items"].as_array().unwrap().iter().rev().find(|m| m["role"] == "assistant").unwrap()["content"]["text"].as_str().unwrap().to_string();
    assert!(last.contains("MANGO-42"), "도구 결과로 답해야 한다: {last}");
}

/// 쓰기 도구는 실제 모델이 불러도 승인 전에는 실행되지 않는다.
#[tokio::test]
#[ignore]
async fn real_model_write_waits_for_approval() {
    let s = TestServer::start().await;
    let prof = real_profile(&s).await;
    let p = s.create_project("real-write").await;
    let root = p["root_path"].as_str().unwrap().to_string();
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (_, v) = s
        .post(
            &format!("/api/v1/sessions/{sid}/turns"),
            json!({ "text": "Use the write tool to create hello.txt containing the word hi.", "profile_id": prof, "tools": true }),
        )
        .await;
    let t = wait_done(&s, v["turn"]["id"].as_str().unwrap()).await;
    assert_eq!(t["status"], "awaiting_approval", "작은 모델이 write를 부르지 않았다면 모델 품질 문제: {t}");
    assert!(!std::path::Path::new(&format!("{root}/hello.txt")).exists(), "승인 전 파일 없음");
}
