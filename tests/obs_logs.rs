//! OBS-001·002: 실행 로그는 turn·session·tool call ID로 연결되고 prompt·파일 본문·토큰을 남기지 않는다.
mod common;
use common::fixture::{self, Fixture, Step};
use common::*;
use reqwest::StatusCode;
use serde_json::json;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn turn_and_tool_logs_carry_ids_without_content() {
    let out = Captured::default();
    let w = out.clone();
    tracing_subscriber::fmt().with_ansi(false).with_writer(move || w.clone()).with_max_level(tracing::Level::INFO).init();
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("obs").await;
    std::fs::write(std::path::Path::new(p["root_path"].as_str().unwrap()).join("note.txt"), "파일본문-SECRET-9f").unwrap();
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    // 첫 호출은 재시도 가능한 오류 → 재시도 로그, 이어서 읽기 도구 → 도구 실행 로그
    f.push(Step::Error(503, "busy".into()));
    f.push(fixture::tool_calls(&[("r1", "read", json!({ "path": "note.txt" }))]));
    f.push(fixture::text("완료"));
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "질문본문-PROMPT-7c", "profile_id": prof, "tools": true })).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    let t = s.wait_status(&tid, "completed").await;
    let call_id = t["tool_calls"][0]["id"].as_str().unwrap().to_string();
    let log = String::from_utf8(out.0.lock().unwrap().clone()).unwrap();
    let line = |needle: &str| log.lines().find(|l| l.contains(needle)).unwrap_or_else(|| panic!("{needle} 로그 없음:\n{log}")).to_string();
    let retry = line("모델 호출 재시도");
    assert!(retry.contains(&format!("turn_id={tid}")) && retry.contains(&format!("session_id={sid}")), "{retry}");
    let tool = line("도구 실행 종료");
    assert!(tool.contains(&format!("tool_call_id={call_id}")) && tool.contains(&format!("turn_id={tid}")) && tool.contains("tool=read"), "{tool}");
    for secret in ["질문본문-PROMPT-7c", "파일본문-SECRET-9f", s.token.as_str()] {
        assert!(!log.contains(secret), "로그에 본문·토큰이 없다: {secret}");
    }
}

/// OBS-004: 소유자는 프로세스 메모리·CPU 시간·활성 세션·실행 작업·대기열·DB 크기·이벤트 구독 수를 조회한다.
#[tokio::test]
async fn metrics_report_process_work_queue_and_db() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("metrics").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (_, idle) = s.get("/api/v1/admin/metrics").await;
    assert_eq!(idle["active_sessions"], 0, "{idle}");
    assert!(idle["db_bytes"]["main"].as_u64().unwrap() > 0);
    if cfg!(target_os = "linux") {
        assert!(idle["process"]["rss_bytes"].as_u64().unwrap() > 1024 * 1024, "{idle}");
        assert!(idle["process"]["threads"].as_u64().unwrap() >= 1 && idle["process"]["cpu_seconds"].as_f64().is_some());
    }
    f.push(fixture::slow_text(&["a", "b", "c"], 500));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "x", "profile_id": prof })).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    s.wait_status(&tid, "running").await;
    let (_, busy) = s.get("/api/v1/admin/metrics").await;
    assert_eq!((busy["active_sessions"].as_i64(), busy["work"]["active_turns"].as_i64()), (Some(1), Some(1)), "{busy}");
    // 모델 호출 permit은 호출 단계마다 잡으므로 순간값만 확인한다.
    assert!(busy["queue"]["running"].as_u64().is_some_and(|n| n <= 1) && busy["queue"]["waiting"].as_u64() == Some(0), "{busy}");
    s.wait_status(&tid, "completed").await;
}
