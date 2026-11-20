//! SETTINGS-011: 기존 범위별 설정 API와 고정 승인 대상의 실행 계약.
mod common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

fn item<'a>(value: &'a Value, key: &str) -> &'a Value {
    value["items"].as_array().unwrap().iter().find(|item| item["key"] == key).unwrap()
}

async fn put(s: &TestServer, scope: &str, id: &str, key: &str, revision: i64, value: Value) -> Value {
    let (status, result) = s.send(Method::PUT, &format!("/api/v1/settings/{scope}/{id}/{key}"),
        json!({ "expected_revision": revision, "value": value })).await;
    assert_eq!(status, StatusCode::OK, "{key}: {result}");
    assert_eq!(result["applies"], "next_turn");
    result
}

#[tokio::test]
async fn execution_settings_inherit_and_clear_each_scope_without_cross_project_overrides() {
    let s = TestServer::start().await;
    let a = s.create_project("exec-a").await;
    let b = s.create_project("exec-b").await;
    let pid = a["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    let keys = [("exec.shell", json!("default"), json!("default"), json!("default"))];
    for (key, server, project, session) in keys {
        put(&s, "server", "-", key, 0, server.clone()).await;
        put(&s, "project", pid, key, 0, project.clone()).await;
        put(&s, "session", &sid, key, 0, session.clone()).await;
        let (status, effective) = s.get(&format!("/api/v1/settings/effective?session_id={sid}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(effective["project_id"], pid);
        assert_eq!(item(&effective, key)["source"], "session");
        assert_eq!(item(&effective, key)["effective"], session);
        let (_, other) = s.get(&format!("/api/v1/settings/effective?project_id={}", b["id"].as_str().unwrap())).await;
        assert_eq!(item(&other, key)["source"], "server");
        assert_eq!(item(&other, key)["effective"], server);
        let reset = put(&s, "session", &sid, key, 1, Value::Null).await;
        assert_eq!(reset["item"]["source"], "project");
        assert_eq!(reset["item"]["effective"], project);
        let reset = put(&s, "project", pid, key, 1, Value::Null).await;
        assert_eq!(reset["item"]["source"], "server");
        let reset = put(&s, "server", "-", key, 1, Value::Null).await;
        assert_eq!(reset["item"]["source"], "default");
    }
}

#[tokio::test]
async fn invalid_execution_values_and_unavailable_choices_keep_revisions_and_values() {
    let s = TestServer::start().await;
    put(&s, "server", "-", "exec.shell", 0, json!("default")).await;
    let (status, result) = s.send(Method::PUT, "/api/v1/settings/server/-/exec.shell",
        json!({ "expected_revision": 1, "value": "fish" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{result}");
    let (status, conflict) = s.send(Method::PUT, "/api/v1/settings/server/-/exec.shell",
        json!({ "expected_revision": 0, "value": "default" })).await;
    assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
    let (_, effective) = s.get("/api/v1/settings/effective").await;
    assert_eq!(item(&effective, "exec.shell")["effective"], "default");
    assert_eq!(item(&effective, "exec.shell")["layers"]["server"]["revision"], 1);

    let (status, registry) = s.get("/api/v1/settings/registry").await;
    assert_eq!(status, StatusCode::OK);
    let shell = registry.as_array().unwrap().iter().find(|def| def["key"] == "exec.shell").unwrap();
    assert!(shell.get("unavailable_options").is_none());
    for removed in ["exec.isolation", "exec.max_memory_mb", "exec.max_cpu_seconds", "exec.default_cwd"] {
        assert!(!registry.as_array().unwrap().iter().any(|def| def["key"] == removed), "{removed}");
    }
    for choice in grove::tools::shell::SHELL_CHOICES {
        if !shell["options"].as_array().unwrap().contains(&json!(choice)) {
            let (status, result) = s.send(Method::PUT,
                "/api/v1/settings/server/-/exec.shell",
                json!({ "expected_revision": 1, "value": choice })).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{result}");
        }
    }
    let response = s.raw(Method::PUT, "/api/v1/settings/server/-/exec.shell",
        Some(json!({ "expected_revision": 1, "value": "default" })), Some("unauthenticated"), Some("")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn session_shell_changes_only_new_plans_in_foreground_and_background() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("fixed-plans").await;
    let pid = p["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    let command = "printf 'shell=%s\\n' \"$0\"";
    let mut revision = 0;
    for background in [false, true] {
        put(&s, "session", &sid, "exec.shell", revision, json!("sh")).await;
        revision += 1;
        for next in [false, true] {
            let mut args = json!({ "command": command });
            if background { args["hold_ms"] = json!(5000); }
            f.push(fixture::tool_calls(&[("exec-settings", "shell", args)]));
            f.push(fixture::text("끝"));
            let (status, accepted) = s.post(&format!("/api/v1/sessions/{sid}/turns"),
                json!({ "text": "run", "profile_id": profile, "tools": true })).await;
            assert!(status.is_success(), "{accepted}");
            let tid = accepted["turn"]["id"].as_str().unwrap();
            let pending = s.wait_status(tid, "awaiting_approval").await;
            let call = &pending["tool_calls"][0];
            let shell = if next { "bash" } else { "sh" };
            assert_eq!(call["target"]["shell"], shell);
            assert!(call["target"].get("limits").is_none());
            if !next {
                put(&s, "session", &sid, "exec.shell", revision, json!("bash")).await;
                revision += 1;
            }
            let (status, decision) = s.post(&format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()),
                json!({ "decision": "approve", "expected_revision": call["revision"] })).await;
            assert!(status.is_success(), "{decision}");
            let completed = s.wait_status(tid, "completed").await;
            assert_eq!(completed["tool_calls"][0]["target"], call["target"]);
            let result = &completed["tool_calls"][0]["result"];
            let output = result["stdout"].as_str().or(result["stdout_tail"].as_str()).unwrap_or("");
            assert!(output.contains(&format!("shell={shell}\n")), "{result}");
        }
        let (status, task) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({ "command": command })).await;
        assert!(status.is_success(), "{task}");
        let (_, result) = s.get(&format!("/api/v1/tasks/{}/wait?timeout_ms=10000", task["id"].as_str().unwrap())).await;
        let output = result["stdout_tail"].as_str().unwrap();
        assert!(output.contains("shell=bash\n"), "{result}");
    }
}
