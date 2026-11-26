//! 구독 로그인된 CLI의 실제 코딩·프로젝트 밖 쓰기·로컬 소켓·재개·취소 시험(opt-in). 소유한 임시 경로만 변경한다.
//!
//! ```bash
//! GROVE_REAL_CLI=claude_code:default cargo test --test real_cli -- --ignored --test-threads=1
//! GROVE_REAL_CLI=codex_cli:default   cargo test --test real_cli -- --ignored --test-threads=1
//! ```
use crate::common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;

async fn cli_profile(s: &TestServer) -> String {
    let spec = std::env::var("GROVE_REAL_CLI").expect("GROVE_REAL_CLI=claude_code:default 또는 codex_cli:default");
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

fn check_python(root: &std::path::Path) -> std::process::Output {
    std::process::Command::new("python3").args(["-m", "unittest", "-v"]).current_dir(root).output().unwrap()
}

/// 두 CLI 모두 실제 코딩·재개·중복 접수와 프로젝트 밖 쓰기·로컬 소켓 허용을 확인한다.
#[tokio::test]
#[ignore]
async fn cli_backend_codes_repairs_tests_resumes_and_allows_external_files_and_local_sockets() {
    let mut s = TestServer::start().await;
    let prof = cli_profile(&s).await;
    let p = s.create_project("cli").await;
    let root = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
    let broken = "def add(a, b):\n    return a - b\n";
    let tests = "import unittest\nfrom calculator import add\n\nclass AddTest(unittest.TestCase):\n    def test_positive(self):\n        self.assertEqual(add(2, 3), 5)\n    def test_mixed(self):\n        self.assertEqual(add(-2, 4), 2)\n";
    std::fs::write(root.join("calculator.py"), broken).unwrap();
    std::fs::write(root.join("baseline.py"), broken).unwrap();
    std::fs::write(root.join("test_calculator.py"), tests).unwrap();
    assert!(!check_python(&root).status.success(), "실제로 실패하는 독립 검사에서 시작한다");
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (st, v) = s
        .post(
            &format!("/api/v1/sessions/{sid}/turns"),
            json!({ "text": "In this disposable project: create made.txt containing exactly READY followed by a newline. Run python3 -m unittest -v to observe the failure, fix calculator.py only so add(a,b) computes addition, then rerun the tests. Do not modify baseline.py or test_calculator.py. Inspect the actual change with git diff --no-index -- baseline.py calculator.py (exit 1 means a difference). Do not commit, push, install anything, or use network. Report actual command results.", "profile_id": prof }),
        )
        .await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let t = wait_done(&s, v["turn"]["id"].as_str().unwrap()).await;
    assert_eq!(t["status"], "completed", "{t}");
    assert!(t["tool_calls"].as_array().unwrap().is_empty(), "CLI 도구는 Grove 도구 호출로 실행하지 않는다");
    assert_eq!(std::fs::read_to_string(root.join("made.txt")).unwrap(), "READY\n");
    assert_eq!(std::fs::read_to_string(root.join("test_calculator.py")).unwrap(), tests, "검사를 약화하지 않는다");
    assert_eq!(std::fs::read_to_string(root.join("baseline.py")).unwrap(), broken);
    let checked = check_python(&root);
    assert!(checked.status.success(), "독립 재검사: {}", String::from_utf8_lossy(&checked.stderr));
    let diff = std::process::Command::new("git").args(["diff", "--no-index", "--", "baseline.py", "calculator.py"]).current_dir(&root).output().unwrap();
    assert_eq!(diff.status.code(), Some(1), "실제 변경 diff가 있어야 한다");
    let (_, messages) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert!(messages["items"].as_array().unwrap().iter().any(|m|
        m["role"] == "assistant" && m["content"]["cli_activity"].as_array().is_some_and(|items| items.iter().any(|i|
            i["kind"] == "command" || i["name"] == "Bash"))), "CLI 명령 실행 기록이 있어야 한다");
    let u = &t["usage"];
    assert!(u["output_tokens"].as_u64().unwrap_or(0) > 0, "사용량 기록: {u}");
    // 서버 재접속만으로 변경을 재실행하지 않는다. 이후 같은 key 재전송도 한 번만 반영한다.
    s.restart().await;
    assert_eq!(std::fs::read_to_string(root.join("made.txt")).unwrap(), "READY\n");
    let body = json!({ "text": "Continue the previous task. Append exactly one RESUMED line to made.txt, keeping READY intact. Run python3 -m unittest -v again. Do not change any other files.", "profile_id": prof });
    let path = format!("/api/v1/sessions/{sid}/turns");
    let response = s.raw(Method::POST, &path, Some(body.clone()), Some("real-cli-resume-once"), None).await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let v: Value = response.json().await.unwrap();
    let t = wait_done(&s, v["turn"]["id"].as_str().unwrap()).await;
    assert_eq!(t["status"], "completed", "{t}");
    let replay = s.raw(Method::POST, &path, Some(body), Some("real-cli-resume-once"), None).await;
    assert_eq!(replay.status(), StatusCode::ACCEPTED);
    let replay: Value = replay.json().await.unwrap();
    assert_eq!(replay["turn"]["id"], v["turn"]["id"]);
    assert_eq!(std::fs::read_to_string(root.join("made.txt")).unwrap(), "READY\nRESUMED\n");
    assert!(check_python(&root).status.success());
    let c = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    let n: i64 = c.query_row("SELECT COUNT(*) FROM cli_sessions WHERE session_id = ?1", [&sid], |r| r.get(0)).unwrap();
    assert_eq!(n, 1, "대화×프로필당 CLI 세션 하나");
    drop(c);
    // 프로젝트와 호출별 temp 밖에서도 시험이 소유한 파일을 쓰고 로컬 소켓을 열 수 있다.
    let outside = tempfile::tempdir().unwrap();
    let sentinel = outside.path().join("untouched.txt");
    std::fs::write(&sentinel, "BEFORE\n").unwrap();
    let (_, v) = s.post(&path, json!({ "text": format!(
        "Permission test using only test-owned disposable paths: overwrite {} with exactly CHANGED followed by a newline using a native file tool or shell command. Also run python3 -c 'import socket,pathlib; s=socket.socket(); s.bind((\"127.0.0.1\",0)); s.listen(1); pathlib.Path(\"local-socket.txt\").write_text(\"BOUND\\n\"); s.close()'. Do not modify anything else, contact external services, commit, push, or install anything. If a command is denied, stop and report the denial.", sentinel.display()), "profile_id": prof })).await;
    let t = wait_done(&s, v["turn"]["id"].as_str().unwrap()).await;
    assert_eq!(t["status"], "completed", "{t}");
    assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "CHANGED\n", "프로젝트 밖의 시험 소유 파일 쓰기 허용");
    assert_eq!(std::fs::read_to_string(root.join("local-socket.txt")).unwrap(), "BOUND\n", "로컬 소켓 생성 허용");
}

async fn interrupted_native_work(restart: bool) {
    let mut s = TestServer::start().await;
    let prof = cli_profile(&s).await;
    let p = s.create_project("cli-cancel").await;
    let root = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let marker = format!("grove-native-cancel-{sid}");
    let (_, v) = s
        .post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": format!("Cancellation test in this disposable project. Use a foreground Bash/shell command to run exactly: python3 -c 'import os,time,pathlib; marker=\"{marker}\"; pathlib.Path(\"before.txt\").write_text(str(os.getpid())); time.sleep(240); pathlib.Path(\"after.txt\").write_text(\"unexpected\")'. Do not run it in the background and do not shorten or skip the sleep. This command will be cancelled by the test owner."), "profile_id": prof }))
        .await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    while !root.join("before.txt").exists() {
        let (_, t) = s.get(&format!("/api/v1/turns/{tid}")).await;
        assert!(!["completed", "failed", "cancelled"].contains(&t["status"].as_str().unwrap_or("")), "취소 전 실행이 끝남: {t}");
        assert!(tokio::time::Instant::now() < deadline, "실제 명령 시작을 확인하지 못함");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _child: i32 = std::fs::read_to_string(root.join("before.txt")).unwrap().parse().unwrap();
    if restart {
        s.restart().await;
    } else {
        let (st, _) = s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
        assert!(st.is_success());
    }
    let t = wait_done(&s, &tid).await;
    assert_eq!(t["status"], if restart { "interrupted" } else { "cancelled" }, "{t}");
    assert_eq!(t["evidence"]["cli_execution_attempted"], true, "활동 보고가 늦어도 실행 시도 기록을 남긴다: {t}");
    assert!(root.join("before.txt").exists(), "취소는 이미 저장한 파일을 rollback하지 않는다");
    assert!(!root.join("after.txt").exists());
    let (_, turns) = s.get(&format!("/api/v1/sessions/{sid}/turns")).await;
    assert_eq!(turns.as_array().unwrap().len(), 1, "중단한 변경 작업을 자동 재접수하지 않는다");
    #[cfg(target_os = "linux")]
    {
        // host /proc에서 실제 자식의 종료를 확인한다.
        let alive = || std::fs::read_dir("/proc").unwrap().filter_map(Result::ok).any(|entry|
            std::fs::read(entry.path().join("cmdline")).ok().is_some_and(|cmd|
                String::from_utf8_lossy(&cmd).contains(&marker)));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while alive() {
            assert!(tokio::time::Instant::now() < deadline, "취소 뒤 자식 프로세스가 남음");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while unsafe { libc::kill(_child, 0) } == 0 {
            assert!(tokio::time::Instant::now() < deadline, "취소 뒤 자식 프로세스가 남음");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

/// 실행 중 취소는 실제 자식을 종료하고 이미 저장한 변경·중단 기록은 보존한다.
/// 두 CLI 모두 선택 질문을 답변 본문이 아닌 Grove 공통 질문 창(ask_user)으로 묻고, 답을 받아 같은 턴에서 이어간다.
#[tokio::test]
#[ignore]
async fn cli_backend_asks_through_shared_question_tool() {
    let s = TestServer::start().await;
    let prof = cli_profile(&s).await;
    let p = s.create_project("cli-question").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (st, v) = s
        .post(
            &format!("/api/v1/sessions/{sid}/turns"),
            json!({ "text": "이 빈 프로젝트에서 시안 색을 정해야 해. 파랑과 초록 중 하나를 나한테 물어보고, 내가 고른 색 이름만 한 단어로 답해줘. 다른 작업은 하지 마.", "profile_id": prof }),
        )
        .await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let turn = v["turn"]["id"].as_str().unwrap().to_string();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    let call = loop {
        let (_, t) = s.get(&format!("/api/v1/turns/{turn}")).await;
        if let Some(c) = t["tool_calls"].as_array().unwrap().iter().find(|c| c["status"] == "awaiting_input") {
            break c.clone();
        }
        assert!(!["completed", "failed", "cancelled", "interrupted"].contains(&t["status"].as_str().unwrap_or("")),
            "질문 창 없이 턴이 끝났다: {}", last_answer(&s, &sid).await);
        assert!(tokio::time::Instant::now() < deadline, "질문 대기 시간 초과: {t}");
        tokio::time::sleep(Duration::from_millis(300)).await;
    };
    assert_eq!(call["name"], "ask_user", "{call}");
    let options: Vec<String> = call["target"]["options"].as_array().unwrap().iter()
        .map(|o| o["label"].as_str().unwrap().to_string()).collect();
    let green = options.iter().find(|l| l.contains("초록") || l.to_lowercase().contains("green"))
        .unwrap_or_else(|| panic!("초록 선택지가 있어야 한다: {options:?}")).clone();
    let (st, v) = s
        .post(&format!("/api/v1/tool-calls/{}/answer", call["id"].as_str().unwrap()), json!({ "choices": [green], "expected_revision": call["revision"] }))
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let t = wait_done(&s, &turn).await;
    assert_eq!(t["status"], "completed", "{t}");
    let answer = last_answer(&s, &sid).await;
    assert!(answer.contains("초록") || answer.to_lowercase().contains("green"), "{answer}");
}

/// Codex 기본 지침이 권하는 request_user_input_async도 같은 질문 창으로 띄우고, 답을 다음 입력으로 받아 이어 간다.
#[tokio::test]
#[ignore]
async fn codex_async_question_reaches_shared_question_window() {
    let s = TestServer::start().await;
    let prof = cli_profile(&s).await;
    let p = s.create_project("cli-async-question").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (st, v) = s
        .post(
            &format!("/api/v1/sessions/{sid}/turns"),
            json!({ "text": "이번 시험에서는 ask_user를 쓰지 말고 request_user_input_async 도구로 파랑과 초록 중 하나를 나한테 물어봐. 질문한 뒤에는 다른 작업 없이 턴을 끝내고, 내 답이 오면 고른 색 이름만 한 단어로 답해줘.", "profile_id": prof }),
        )
        .await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let turn = v["turn"]["id"].as_str().unwrap().to_string();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    let call = loop {
        let (_, t) = s.get(&format!("/api/v1/turns/{turn}")).await;
        if let Some(c) = t["tool_calls"].as_array().unwrap().iter().find(|c| c["status"] == "awaiting_input") {
            break c.clone();
        }
        assert!(!["completed", "failed", "cancelled", "interrupted"].contains(&t["status"].as_str().unwrap_or("")),
            "질문 창 없이 턴이 끝났다: {}", last_answer(&s, &sid).await);
        assert!(tokio::time::Instant::now() < deadline, "질문 대기 시간 초과: {t}");
        tokio::time::sleep(Duration::from_millis(300)).await;
    };
    assert_eq!(call["provider_call_id"].as_str().map(|id| id.starts_with("codex-question:")), Some(true), "{call}");
    let options: Vec<String> = call["target"]["options"].as_array().unwrap().iter()
        .map(|o| o["label"].as_str().unwrap().to_string()).collect();
    let green = options.iter().find(|l| l.contains("초록") || l.to_lowercase().contains("green"))
        .unwrap_or_else(|| panic!("초록 선택지가 있어야 한다: {options:?}")).clone();
    let (st, v) = s
        .post(&format!("/api/v1/tool-calls/{}/answer", call["id"].as_str().unwrap()), json!({ "choices": [green], "expected_revision": call["revision"] }))
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let t = wait_done(&s, &turn).await;
    assert_eq!(t["status"], "completed", "{t}");
    let answer = last_answer(&s, &sid).await;
    assert!(answer.contains("초록") || answer.to_lowercase().contains("green"), "{answer}");
}

#[tokio::test]
#[ignore]
async fn cli_backend_cancel_stops_process() {
    interrupted_native_work(false).await;
}

/// 서버 재시작도 같은 소유 프로세스 경계를 쓰며 변경 작업을 자동 반복하지 않는다.
#[tokio::test]
#[ignore]
async fn cli_backend_restart_keeps_changes_without_replaying() {
    interrupted_native_work(true).await;
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

// UI-020: 설치된 CLI가 effort 설정(Codex `-c model_reasoning_effort`, Claude Code `CLAUDE_CODE_EFFORT_LEVEL`)을 받아 정상 응답한다.
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
