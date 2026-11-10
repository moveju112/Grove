//! 백그라운드 작업(EXEC-003~013). 실제 bash 프로세스를 쓴다(Linux).
#![cfg(unix)]
mod common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;

async fn setup() -> (TestServer, String, String, String) {
    let s = TestServer::start().await;
    let p = s.create_project("t").await;
    let pid = p["id"].as_str().unwrap().to_string();
    let sid = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    (s, pid, sid, p["root_path"].as_str().unwrap().to_string())
}

async fn notes(s: &TestServer, sid: &str) -> Vec<Value> {
    let (_, m) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    m["items"].as_array().unwrap().iter().filter(|m| m["role"] == "note").cloned().collect()
}

#[tokio::test]
async fn background_task_records_result_once_and_output_is_readable() {
    let (s, _pid, sid, _root) = setup().await;
    let body = json!({ "command": "echo 시작; sleep 0.3; echo 오류 >&2; exit 2" });
    let r = s.raw(Method::POST, &format!("/api/v1/sessions/{sid}/tasks"), Some(body.clone()), Some("task-1"), None).await;
    assert_eq!(r.status(), StatusCode::CREATED);
    let t: Value = r.json().await.unwrap();
    assert_eq!(t["status"], "running");
    let id = t["id"].as_str().unwrap().to_string();
    // 같은 키 재전송은 프로세스를 다시 띄우지 않는다
    let r = s.raw(Method::POST, &format!("/api/v1/sessions/{sid}/tasks"), Some(body), Some("task-1"), None).await;
    assert_eq!(r.headers().get("idempotent-replayed").unwrap(), "true");
    let (_, w) = s.get(&format!("/api/v1/tasks/{id}/wait?timeout_ms=10000")).await;
    assert_eq!(w["status"], "failed", "{w}");
    assert_eq!(w["exit_code"], 2);
    assert_eq!(w["wait_timed_out"], false);
    assert!(w["stdout_tail"].as_str().unwrap().contains("시작"));
    let (_, l) = s.get(&format!("/api/v1/sessions/{sid}/tasks")).await;
    assert_eq!(l["tasks"].as_array().unwrap().len(), 1);
    let n = notes(&s, &sid).await;
    assert_eq!(n.len(), 1, "결과는 한 번만 기록: {n:?}");
    assert_eq!(n[0]["content"]["type"], "task_result");
    assert_eq!(n[0]["content"]["exit_code"], 2);
    assert!(n[0]["content"]["stderr_tail"].as_str().unwrap().contains("오류"));
    // 조각 읽기
    let (_, o) = s.get(&format!("/api/v1/tasks/{id}/output?stream=stdout&offset=0&limit=3")).await;
    assert_eq!(o["data"], "시");
    assert_eq!(o["next_offset"], 3);
    assert_eq!(o["eof"], false);
    let (_, o) = s.get(&format!("/api/v1/tasks/{id}/output?stream=stdout&offset=3")).await;
    assert_eq!(o["data"], "작\n");
    assert_eq!(o["eof"], true);
    // 끝난 작업 취소는 무해
    let (st, c) = s.post(&format!("/api/v1/tasks/{id}/cancel"), json!({})).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(c["cancelled"], false);
    assert_eq!(notes(&s, &sid).await.len(), 1);
}

#[tokio::test]
async fn cancel_timeout_and_wait_timeout_are_distinct() {
    let (s, _pid, sid, root) = setup().await;
    let marker = format!("{root}/child-alive");
    let (_, t) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({ "command": format!("(sleep 1; touch {marker}) & sleep 30") })).await;
    let id = t["id"].as_str().unwrap();
    // wait의 시간 초과는 작업을 끝내지 않는다
    let (_, w) = s.get(&format!("/api/v1/tasks/{id}/wait?timeout_ms=200")).await;
    assert_eq!(w["status"], "running");
    assert_eq!(w["wait_timed_out"], true);
    // 보관은 실행 중 작업 때문에 막힌다
    let (_, sess) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    let (st, v) = s.send(Method::PATCH, &format!("/api/v1/sessions/{sid}"), json!({ "expected_revision": sess["revision"], "archived": true })).await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"]["details"]["running_tasks"], 1);
    let (_, c) = s.post(&format!("/api/v1/tasks/{id}/cancel"), json!({})).await;
    assert_eq!(c["task"]["status"], "cancelled");
    assert_eq!(c["task"]["reason"], "user");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(!std::path::Path::new(&marker).exists(), "process group 전체 종료");
    // hard timeout
    let (_, t) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({ "command": "sleep 30", "timeout_ms": 300 })).await;
    let (_, w) = s.get(&format!("/api/v1/tasks/{}/wait?timeout_ms=10000", t["id"].as_str().unwrap())).await;
    assert_eq!(w["status"], "timeout");
    // 경로 경계
    let (st, _) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({ "command": "pwd", "cwd": "../.." })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn large_output_goes_to_bounded_file_not_memory() {
    let (s, _pid, sid, _root) = setup().await;
    let (_, t) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({ "command": "head -c 10000000 /dev/zero | tr '\\0' a" })).await;
    let id = t["id"].as_str().unwrap();
    let (_, w) = s.get(&format!("/api/v1/tasks/{id}/wait?timeout_ms=30000")).await;
    assert_eq!(w["status"], "completed", "{w}");
    assert_eq!(w["stdout_bytes"], 10_000_000);
    let (_, o) = s.get(&format!("/api/v1/tasks/{id}/output?offset=0&limit=10")).await;
    assert_eq!(o["stored_bytes"], grove::tasks::MAX_LOG);
    assert_eq!(o["dropped_bytes"], 10_000_000 - grove::tasks::MAX_LOG);
    let log = s.data_dir().join("tasks").join(format!("{id}.out"));
    assert_eq!(std::fs::metadata(log).unwrap().len(), grove::tasks::MAX_LOG);
}

#[tokio::test]
async fn shutdown_cancels_and_crash_leftovers_become_unknown() {
    let (mut s, _pid, sid, _root) = setup().await;
    let (_, t) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({ "command": "sleep 30" })).await;
    let id = t["id"].as_str().unwrap().to_string();
    tokio::time::sleep(Duration::from_millis(200)).await;
    s.stop().await;
    // 정상 종료는 작업을 취소로 끝낸다
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    let st: String = db.query_row("SELECT status FROM tasks WHERE id = ?1", [&id], |r| r.get(0)).unwrap();
    assert_eq!(st, "cancelled");
    // 비정상 종료 흉내: 기록상 running으로 남은 작업
    db.execute("UPDATE tasks SET status = 'running', ended_at = NULL, result_message_id = NULL WHERE id = ?1", [&id]).unwrap();
    drop(db);
    s.restart().await;
    let (_, t) = s.get(&format!("/api/v1/tasks/{id}")).await;
    assert_eq!(t["status"], "unknown");
    assert!(t["reason"].as_str().unwrap().contains("재시작"));
    let n = notes(&s, &sid).await;
    assert!(n.iter().any(|m| m["content"]["status"] == "unknown"), "{n:?}");
    // wait는 즉시 돌아온다
    let (_, w) = s.get(&format!("/api/v1/tasks/{id}/wait?timeout_ms=5000")).await;
    assert_eq!(w["wait_timed_out"], false);
}

/// `exec.shell` 설정은 사용자 작업·모델 셸(즉시/백그라운드)·새 터미널에 적용되고,
/// 승인 대상에 고정되어 승인 뒤 설정을 바꿔도 승인한 셸로 실행한다(EXEC-001).
#[tokio::test]
async fn configured_shell_applies_and_is_fixed_at_approval() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("sh").await;
    let pid = p["id"].as_str().unwrap().to_string();
    let sid = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    let put = |v: &'static str, rev: i64| {
        let (s, pid) = (&s, pid.clone());
        async move { s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/exec.shell"), json!({ "expected_revision": rev, "value": v })).await }
    };
    let (st, v) = put("fish", 0).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "목록 밖 셸은 거부: {v}");
    let (st, v) = put("sh", 0).await;
    assert!(st.is_success(), "{v}");
    // 사용자 작업: `sh -c`의 $0은 sh
    let (_, t) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({ "command": "echo \"shell=$0\"" })).await;
    let (_, w) = s.get(&format!("/api/v1/tasks/{}/wait?timeout_ms=10000", t["id"].as_str().unwrap())).await;
    assert!(w["stdout_tail"].as_str().unwrap().contains("shell=sh"), "{w}");
    // 모델 셸: 계획 때 sh로 고정, 승인 전에 설정을 bash로 바꿔도 sh로 실행(즉시·백그라운드 경로 모두)
    for (i, args) in [json!({ "command": "echo \"shell=$0\"" }), json!({ "command": "echo \"shell=$0\"", "hold_ms": 5000 })].into_iter().enumerate() {
        f.push(fixture::tool_calls(&[(&format!("c{i}"), "shell", args)]));
        f.push(fixture::text("끝"));
        let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "go", "profile_id": prof, "tools": true })).await;
        let tid = v["turn"]["id"].as_str().unwrap().to_string();
        let t = s.wait_status(&tid, "awaiting_approval").await;
        let c = &t["tool_calls"][0];
        assert_eq!(c["target"]["shell"], "sh", "{c}");
        if i == 0 {
            let (st, v) = put("bash", 1).await;
            assert!(st.is_success(), "{v}");
        }
        s.post(&format!("/api/v1/tool-calls/{}/decision", c["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": c["revision"] })).await;
        let t = s.wait_status(&tid, "completed").await;
        let r = &t["tool_calls"][0]["result"];
        let out = r["stdout"].as_str().or(r["stdout_tail"].as_str()).unwrap_or("");
        assert!(out.contains("shell=sh"), "{r}");
        if i == 0 {
            // 되돌려 두 번째 호출도 sh로 계획되게 한다
            put("sh", 2).await;
        }
    }
    // 새 터미널도 설정을 따른다
    let (st, term) = s.post(&format!("/api/v1/projects/{pid}/terminals"), json!({})).await;
    assert!(st.is_success(), "{term}");
    assert_eq!(term["shell"], "sh", "{term}");
}

/// 서버가 비정상 종료해 남은 작업 프로세스(분리된 setsid 자손 포함)는 재시작 때 표식으로 찾아 종료한다.
/// 표식이 없거나 다른 작업 표식인 프로세스는 건드리지 않는다(EXEC-010).
#[cfg(target_os = "linux")]
#[tokio::test]
async fn crash_leftover_processes_are_reaped_by_task_marker_only() {
    let (mut s, _pid, sid, _root) = setup().await;
    let (_, t) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({ "command": "sleep 30" })).await;
    let id = t["id"].as_str().unwrap().to_string();
    s.stop().await;
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute("UPDATE tasks SET status = 'running', ended_at = NULL, result_message_id = NULL WHERE id = ?1", [&id]).unwrap();
    drop(db);
    // 비정상 종료 후 남은 프로세스 흉내: 해당 작업 표식을 물려받은 셸과 setsid로 떨어져 나간 손자.
    let spawn = |env: Option<(&str, &str)>, script: &str| {
        let mut c = std::process::Command::new("bash");
        c.args(["-c", script]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null());
        c.env_remove(grove::tasks::TASK_ENV);
        if let Some((k, v)) = env {
            c.env(k, v);
        }
        c.spawn().unwrap()
    };
    let mut leftover = spawn(Some((grove::tasks::TASK_ENV, &id)), "setsid sleep 30 & sleep 30");
    let mut other = spawn(Some((grove::tasks::TASK_ENV, "other-task")), "sleep 30");
    let mut plain = spawn(None, "sleep 30");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let tagged = |id: &str| -> usize {
        std::fs::read_dir("/proc")
            .unwrap()
            .flatten()
            .filter(|e| {
                std::fs::read(e.path().join("environ"))
                    .map(|env| env.split(|b| *b == 0).any(|kv| kv == format!("{}={id}", grove::tasks::TASK_ENV).as_bytes()))
                    .unwrap_or(false)
            })
            .count()
    };
    assert!(tagged(&id) >= 3, "셸·sleep·setsid 손자가 표식을 가짐");
    s.restart().await;
    assert_eq!(tagged(&id), 0, "표식이 일치하는 잔여 프로세스는 모두 종료");
    leftover.wait().unwrap();
    assert!(other.try_wait().unwrap().is_none(), "다른 작업 표식 프로세스는 유지");
    assert!(plain.try_wait().unwrap().is_none(), "표식 없는 프로세스는 유지");
    let (_, t) = s.get(&format!("/api/v1/tasks/{id}")).await;
    assert_eq!(t["status"], "unknown", "부작용은 알 수 없으므로 성공·취소로 바꾸지 않는다");
    let reason = t["reason"].as_str().unwrap();
    assert!(reason.contains("재시작") && reason.contains("종료했습니다"), "{reason}");
    other.kill().unwrap();
    plain.kill().unwrap();
    let _ = (other.wait(), plain.wait());
}

#[tokio::test]
async fn model_shell_with_hold_detaches_and_result_reaches_next_turn() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("m").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    // 빨리 끝나는 명령: hold 안에서 결과가 도구 결과로 바로 온다(note 없음)
    f.push(fixture::tool_calls(&[("q1", "shell", json!({ "command": "echo fast", "hold_ms": 5000 }))]));
    f.push(fixture::text("빠름"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "go", "profile_id": prof, "tools": true })).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    let t = s.wait_status(&tid, "awaiting_approval").await;
    let c = &t["tool_calls"][0];
    s.post(&format!("/api/v1/tool-calls/{}/decision", c["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": c["revision"] })).await;
    let t = s.wait_status(&tid, "completed").await;
    assert_eq!(t["tool_calls"][0]["result"]["exit_code"], 0, "{t}");
    assert!(t["tool_calls"][0]["result"]["stdout_tail"].as_str().unwrap().contains("fast"));
    assert!(notes(&s, &sid).await.is_empty(), "hold 안에 끝나면 note를 남기지 않는다");

    // 오래 걸리는 명령: hold가 지나면 task_id를 돌려주고 턴은 계속, 끝나면 note
    f.push(fixture::tool_calls(&[("q2", "shell", json!({ "command": "sleep 0.8; echo late", "hold_ms": 100 }))]));
    f.push(fixture::text("백그라운드로 보냄"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "go2", "profile_id": prof, "tools": true })).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    let t = s.wait_status(&tid, "awaiting_approval").await;
    let c = &t["tool_calls"][0];
    s.post(&format!("/api/v1/tool-calls/{}/decision", c["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": c["revision"] })).await;
    let t = s.wait_status(&tid, "completed").await;
    let r = &t["tool_calls"][0]["result"];
    assert_eq!(r["background"], true, "{r}");
    let task_id = r["task_id"].as_str().unwrap();
    let (_, w) = s.get(&format!("/api/v1/tasks/{task_id}/wait?timeout_ms=10000")).await;
    assert_eq!(w["status"], "completed");
    assert_eq!(w["call_id"], c["id"]);
    let n = notes(&s, &sid).await;
    assert_eq!(n.len(), 1);
    assert!(n[0]["content"]["stdout_tail"].as_str().unwrap().contains("late"));
    // 다음 턴의 모델 입력에 결과가 들어간다
    f.push(fixture::text("확인"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "결과는?", "profile_id": prof })).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let reqs = f.requests();
    let last = reqs.last().unwrap()["messages"].to_string();
    assert!(last.contains("[background task result]") && last.contains("late"), "{last}");
}
