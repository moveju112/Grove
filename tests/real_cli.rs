//! 서버에 설치된 CLI 백엔드 실시험(opt-in, 저가형 모델). 기본 `cargo test`에서는 실행하지 않는다(#[ignore]).
//!
//! ```bash
//! GROVE_REAL_CLI=claude_code:haiku    cargo test --test real_cli -- --ignored --test-threads=1
//! GROVE_REAL_CLI=codex_cli:gpt-6-luna cargo test --test real_cli -- --ignored --test-threads=1
//! ```
mod common;

use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};
use std::time::Duration;

async fn cli_profile(s: &TestServer) -> String {
    let spec = std::env::var("GROVE_REAL_CLI").expect("GROVE_REAL_CLI=claude_code:haiku 또는 codex_cli:gpt-6-luna");
    let (protocol, model) = spec.split_once(':').expect("protocol:model");
    let (st, p) = s
        .post("/api/v1/model-profiles", json!({ "name": "cli", "protocol": protocol, "base_url": "", "model": model, "options": { "timeout_secs": 300 } }))
        .await;
    assert_eq!(st, StatusCode::CREATED, "{p}");
    p["id"].as_str().unwrap().to_string()
}

async fn wait_done(s: &TestServer, turn: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        let (_, t) = s.get(&format!("/api/v1/turns/{turn}")).await;
        if ["completed", "failed", "cancelled", "interrupted"].contains(&t["status"].as_str().unwrap_or("")) {
            return t;
        }
        assert!(tokio::time::Instant::now() < deadline, "CLI 턴 시간 초과: {t}");
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn last_answer(s: &TestServer, sid: &str) -> String {
    let (_, msgs) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    msgs["items"].as_array().unwrap().iter().rev().find(|m| m["role"] == "assistant").unwrap()["content"]["text"].as_str().unwrap().to_string()
}

/// 프로젝트 파일을 읽고, 쓰기는 거부되며, 다음 요청에서 CLI 세션을 이어 쓴다.
#[tokio::test]
#[ignore]
async fn cli_backend_reads_cannot_write_and_resumes() {
    let s = TestServer::start().await;
    let prof = cli_profile(&s).await;
    let p = s.create_project("cli").await;
    let root = p["root_path"].as_str().unwrap().to_string();
    std::fs::write(format!("{root}/note.txt"), "The secret word is KIWI-7.\n").unwrap();
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (st, v) = s
        .post(
            &format!("/api/v1/sessions/{sid}/turns"),
            json!({ "text": "Read note.txt and tell me the secret word. Then try to create a file made.txt containing hi.", "profile_id": prof }),
        )
        .await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let t = wait_done(&s, v["turn"]["id"].as_str().unwrap()).await;
    assert_eq!(t["status"], "completed", "{t}");
    assert!(t["tool_calls"].as_array().unwrap().is_empty(), "CLI 도구는 Grove 도구 호출로 실행하지 않는다");
    assert!(last_answer(&s, &sid).await.contains("KIWI-7"));
    assert!(!std::path::Path::new(&format!("{root}/made.txt")).exists(), "읽기 전용 강제: 파일이 생기면 안 된다");
    let u = &t["usage"];
    assert!(u["output_tokens"].as_u64().unwrap_or(0) > 0, "사용량 기록: {u}");
    // 다음 요청은 이전 대화를 보내지 않고 CLI 세션을 이어 쓴다
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "What was the secret word? Answer with just the word.", "profile_id": prof })).await;
    let t = wait_done(&s, v["turn"]["id"].as_str().unwrap()).await;
    assert_eq!(t["status"], "completed", "{t}");
    assert!(last_answer(&s, &sid).await.contains("KIWI-7"), "resume으로 이전 대화를 기억해야 한다");
    let c = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    let n: i64 = c.query_row("SELECT COUNT(*) FROM cli_sessions WHERE session_id = ?1", [&sid], |r| r.get(0)).unwrap();
    assert_eq!(n, 1, "대화×프로필당 CLI 세션 하나");
}

/// 실행 중 취소하면 CLI 프로세스를 끝내고 cancelled로 남는다.
#[tokio::test]
#[ignore]
async fn cli_backend_cancel_stops_process() {
    let s = TestServer::start().await;
    let prof = cli_profile(&s).await;
    let p = s.create_project("cli-cancel").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (_, v) = s
        .post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "Write a 2000 word essay about the history of tea.", "profile_id": prof }))
        .await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let (st, _) = s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    assert!(st.is_success());
    let t = wait_done(&s, &tid).await;
    assert_eq!(t["status"], "cancelled", "{t}");
}

// AUTH-001: CLI 연결 확인은 실행 파일 버전만 확인한다(모델 호출 없음).
#[tokio::test]
#[ignore]
async fn cli_profile_check_reports_installed_version() {
    let s = TestServer::start().await;
    let prof = cli_profile(&s).await;
    let (st, r) = s.post(&format!("/api/v1/model-profiles/{prof}/check"), json!({})).await;
    assert_eq!(st, StatusCode::OK, "{r}");
    assert_eq!(r["ok"], true, "{r}");
    assert!(!r["detail"]["cli_version"].as_str().unwrap_or("").is_empty(), "{r}");
    eprintln!("CLI check: {r}");
}

// UI-020: 설치된 CLI가 effort 설정(Codex `-c model_reasoning_effort`, Claude Code `MAX_THINKING_TOKENS`)을 받아 정상 응답한다.
#[tokio::test]
#[ignore]
async fn cli_backend_accepts_effort() {
    let s = TestServer::start().await;
    let prof = cli_profile(&s).await;
    let p = s.create_project("cli-effort").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (st, v) = s
        .post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "Reply with exactly the word: PONG", "profile_id": prof, "effort": "low" }))
        .await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let t = wait_done(&s, v["turn"]["id"].as_str().unwrap()).await;
    assert_eq!(t["status"], "completed", "{t}");
    assert_eq!(t["definition"]["effort"], "low");
    let a = last_answer(&s, &sid).await;
    eprintln!("effort answer: {a}");
    assert!(a.to_uppercase().contains("PONG"), "{a}");
}
