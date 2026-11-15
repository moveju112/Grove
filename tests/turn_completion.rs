//! RUN-020: 모델의 이른 final은 소유 작업 결과를 반영하기 전에는 턴 완료가 아니다.
#![cfg(unix)]
mod common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;

async fn messages(s: &TestServer, sid: &str) -> Vec<Value> {
    s.get(&format!("/api/v1/sessions/{sid}/messages")).await.1["items"].as_array().unwrap().clone()
}

async fn wait_message(s: &TestServer, sid: &str, text: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(m) = messages(s, sid).await.into_iter().find(|m| m["content"]["text"] == text) {
            return m;
        }
        assert!(tokio::time::Instant::now() < deadline, "메시지 대기 시간 초과: {text}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn early_final_waits_for_owned_task_without_holding_the_model_slot_and_includes_its_result() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let (st, v) = s.send(Method::PUT, "/api/v1/settings/server/-/runs.max_active", json!({"expected_revision":0,"value":1})).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let p = s.create_project("completion").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let root = std::path::Path::new(p["root_path"].as_str().unwrap());
    f.push(fixture::tool_calls(&[("bg", "shell", json!({
        "command": "while [ ! -f release ]; do sleep 0.02; done; printf 'owned result'; exit 7",
        "background": true, "timeout_ms": 10000
    }))]));
    f.push(fixture::text("premature final"));
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"finish the work", "profile_id":prof, "tools":true})).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let tid = v["turn"]["id"].as_str().unwrap();
    let t = s.wait_status(tid, "awaiting_approval").await;
    let call = &t["tool_calls"][0];
    s.post(&format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()),
        json!({"decision":"approve","expected_revision":call["revision"]})).await;
    let candidate = wait_message(&s, &sid, "premature final").await;
    let (_, t) = s.get(&format!("/api/v1/turns/{tid}")).await;
    assert_eq!(t["status"], "running", "실행 중 소유 작업이 있으면 완료로 확정하지 않는다: {t}");
    assert!(t["finished_at"].is_null());
    assert_eq!(candidate["content"]["pending_work"]["tasks"].as_array().unwrap().len(), 1);

    // 대기 중 다른 대화의 모델 호출은 막지 않는다.
    let other = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    f.push(fixture::text("independent answer"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{other}/turns"), json!({"text":"independent", "profile_id":prof})).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    f.push(fixture::text("task failed with code 7; owned result"));
    std::fs::write(root.join("release"), b"go").unwrap();
    s.wait_status(tid, "completed").await;
    let requests = f.requests();
    let last = requests.last().unwrap()["messages"].to_string();
    assert!(last.contains("[background task result]") && last.contains("owned result") && last.contains("failed") && last.contains("7"), "{last}");
    assert!(last.contains("completion deferred"), "{last}");
    assert_eq!(messages(&s, &sid).await.into_iter().filter(|m| m["content"]["type"] == "task_result").count(), 1);
}

#[tokio::test]
async fn child_results_are_required_and_send_transfers_ownership_and_cancellation_to_the_current_turn() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let (st, v) = s.send(Method::PUT, "/api/v1/settings/server/-/agents.delegation", json!({"expected_revision":0,"value":"auto"})).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let p = s.create_project("child-completion").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    f.push(fixture::tool_calls(&[("spawn", "agent", json!({"action":"spawn","agent_id":"reviewer","brief":"owned child"}))]));
    f.push(fixture::text("first provisional"));
    f.push_for("Delegated task", fixture::hang_after("child working"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"delegate","profile_id":prof,"tools":true})).await;
    let tid = v["turn"]["id"].as_str().unwrap();
    let candidate = wait_message(&s, &sid, "first provisional").await;
    let run_id = candidate["content"]["pending_work"]["agents"][0]["id"].as_str().unwrap();
    assert_eq!(s.get(&format!("/api/v1/turns/{tid}")).await.1["status"], "running");
    f.push(fixture::text("child cancelled, not completed"));
    s.post(&format!("/api/v1/agent-runs/{run_id}/cancel"), json!({})).await;
    s.wait_status(tid, "completed").await;
    let last = f.requests().last().unwrap()["messages"].to_string();
    assert!(last.contains("[child agent result]") && last.contains("cancelled"), "{last}");

    f.push(fixture::tool_calls(&[("send", "agent", json!({"action":"send","run_id":run_id,"brief":"follow-up child"}))]));
    f.push(fixture::text("second provisional"));
    f.push_for("Delegated task", fixture::hang_after("child reused"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"delegate again","profile_id":prof,"tools":true})).await;
    let second = v["turn"]["id"].as_str().unwrap();
    let candidate = wait_message(&s, &sid, "second provisional").await;
    assert_eq!(candidate["content"]["pending_work"]["agents"][0]["id"], run_id);
    let run = s.get(&format!("/api/v1/agent-runs/{run_id}")).await.1;
    assert_eq!(run["parent_turn_id"], second);
    assert_eq!(s.get(&format!("/api/v1/turns/{second}")).await.1["status"], "running");
    s.post(&format!("/api/v1/turns/{second}/cancel"), json!({})).await;
    s.wait_status(second, "cancelled").await;
    let child = run["last_turn_id"].as_str().unwrap();
    s.wait_status(child, "cancelled").await;
    let t = s.get(&format!("/api/v1/turns/{second}")).await.1;
    assert_eq!(t["error"]["scope"]["running_agents"][0]["id"], run_id);
}

#[tokio::test]
async fn deferred_completion_obeys_cancel_time_budget_and_restart_without_replaying_the_model() {
    for mode in ["cancel", "budget", "restart"] {
        let mut s = TestServer::start().await;
        let f = Fixture::start().await;
        let prof = s.fixture_profile(&f.base).await;
        let p = s.create_project(mode).await;
        let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
        if mode == "budget" {
            s.send(Method::PUT, &format!("/api/v1/settings/session/{sid}/runs.budget.max_minutes"), json!({"expected_revision":0,"value":1})).await;
        }
        f.push(fixture::tool_calls(&[("bg", "shell", json!({"command":"sleep 10","background":true,"timeout_ms":10000}))]));
        f.push(fixture::text("provisional"));
        let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"go","profile_id":prof,"tools":true})).await;
        let tid = v["turn"]["id"].as_str().unwrap().to_string();
        let t = s.wait_status(&tid, "awaiting_approval").await;
        let call = &t["tool_calls"][0];
        if mode == "budget" {
            let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
            let back = grove::util::fmt_time(time::OffsetDateTime::now_utc()-time::Duration::seconds(59));
            db.execute("UPDATE turns SET created_at=?2 WHERE id=?1", rusqlite::params![tid,back]).unwrap();
        }
        s.post(&format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()),
            json!({"decision":"approve","expected_revision":call["revision"]})).await;
        let candidate = wait_message(&s, &sid, "provisional").await;
        let task_id = candidate["content"]["pending_work"]["tasks"][0]["id"].as_str().unwrap();
        let (status, code) = match mode {
            "budget" => ("failed", "time_budget_exceeded"),
            "restart" => { s.restart().await; ("interrupted", "server_shutdown") }
            _ => { s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await; ("cancelled","user_stop") }
        };
        let t = s.wait_status(&tid, status).await;
        assert_eq!(t["error"]["code"], code, "{t}");
        assert_eq!(t["error"]["scope"]["running_tasks"][0]["id"], task_id, "{mode}: {t}");
        if mode != "restart" {
            s.post(&format!("/api/v1/tasks/{task_id}/cancel"), json!({})).await;
            let result = s.get(&format!("/api/v1/tasks/{task_id}/wait?timeout_ms=5000")).await.1;
            assert_ne!(result["status"], "running");
        }
        assert_eq!(s.get(&format!("/api/v1/turns/{tid}")).await.1["status"], status);
        assert_eq!(f.requests().len(), 2, "종료 뒤 자동 모델 재호출 없음: {mode}");
    }
}

#[tokio::test]
async fn user_started_background_work_is_not_owned_by_a_model_turn() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("independent-task").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (_, task) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({"command":"sleep 10"})).await;
    f.push(fixture::text("independent final"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"answer","profile_id":prof})).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let answer = wait_message(&s, &sid, "independent final").await;
    assert!(answer["content"].get("pending_work").is_none());
    assert_eq!(f.requests().len(), 1);
    let task_id = task["id"].as_str().unwrap();
    assert_eq!(s.get(&format!("/api/v1/tasks/{task_id}")).await.1["status"], "running");
    s.post(&format!("/api/v1/tasks/{task_id}/cancel"), json!({})).await;
}

#[tokio::test]
async fn a_result_arriving_during_the_final_model_call_is_incorporated_even_when_no_work_remains_running() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("completion-race").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let root = std::path::Path::new(p["root_path"].as_str().unwrap());
    f.push(fixture::tool_calls(&[("bg", "shell", json!({
        "command":"while [ ! -f release ]; do sleep 0.02; done; printf 'arrived during model call'",
        "background":true,"timeout_ms":10000
    }))]));
    let (response, release) = fixture::gated_text("stale final");
    f.push(response);
    f.push(fixture::text("incorporated result"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"work","profile_id":prof,"tools":true})).await;
    let tid = v["turn"]["id"].as_str().unwrap();
    let t = s.wait_status(tid, "awaiting_approval").await;
    let c = &t["tool_calls"][0];
    s.post(&format!("/api/v1/tool-calls/{}/decision", c["id"].as_str().unwrap()),
        json!({"decision":"approve","expected_revision":c["revision"]})).await;
    let deadline = tokio::time::Instant::now()+Duration::from_secs(10);
    while f.requests().len() < 2 {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let t = s.get(&format!("/api/v1/turns/{tid}")).await.1;
    let task_id = t["tool_calls"][0]["result"]["task_id"].as_str().unwrap();
    std::fs::write(root.join("release"), b"go").unwrap();
    assert_eq!(s.get(&format!("/api/v1/tasks/{task_id}/wait?timeout_ms=5000")).await.1["status"], "completed");
    release.send_replace(true);
    s.wait_status(tid, "completed").await;
    let candidate = wait_message(&s, &sid, "stale final").await;
    assert_eq!(candidate["content"]["pending_work"]["tasks"], json!([]));
    assert_eq!(candidate["content"]["pending_work"]["unseen_results"], true);
    assert_eq!(f.requests().len(), 3);
    let last = f.requests().last().unwrap()["messages"].to_string();
    assert!(last.contains("[background task result]") && last.contains("arrived during model call"), "{last}");
}

#[tokio::test]
async fn steering_wakes_deferred_completion_before_the_child_finishes() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    s.send(Method::PUT, "/api/v1/settings/server/-/agents.delegation", json!({"expected_revision":0,"value":"auto"})).await;
    let p = s.create_project("steer-completion").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    f.push(fixture::tool_calls(&[("spawn","agent",json!({"action":"spawn","agent_id":"reviewer","brief":"long work"}))]));
    f.push(fixture::text("waiting for child"));
    f.push_for("Delegated task", fixture::hang_after("child running"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"delegate","profile_id":prof,"tools":true})).await;
    let tid = v["turn"]["id"].as_str().unwrap();
    let candidate = wait_message(&s, &sid, "waiting for child").await;
    let run = candidate["content"]["pending_work"]["agents"][0]["id"].as_str().unwrap();
    f.push(fixture::tool_calls(&[("cancel","agent",json!({"action":"cancel","run_id":run}))]));
    f.push(fixture::text("stopped child as requested"));
    let (st, body) = s.post(&format!("/api/v1/sessions/{sid}/followups"), json!({
        "kind":"steer","text":"stop this child now","profile_id":prof,"tools":true
    })).await;
    assert_eq!(st, StatusCode::CREATED, "{body}");
    s.wait_status(tid, "completed").await;
    let requests = f.requests();
    let cancel_request = requests.iter().find(|r| r["messages"].to_string().contains("stop this child now")).expect("새 지시가 모델에 도착");
    assert!(!cancel_request["messages"].to_string().contains("[child agent result]"), "자식 종료를 기다리기 전에 steer를 반영");
    assert_eq!(s.get(&format!("/api/v1/agent-runs/{run}")).await.1["status"], "cancelled");
}
