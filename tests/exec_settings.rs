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
    for dir in ["server", "project", "session"] {
        std::fs::create_dir(std::path::Path::new(a["root_path"].as_str().unwrap()).join(dir)).unwrap();
    }
    let keys = [
        ("exec.shell", json!("default"), json!("default"), json!("default")),
        ("exec.max_memory_mb", json!(0), json!(if cfg!(any(target_os = "linux", windows)) { 128 } else { 0 }), json!(0)),
        ("exec.max_cpu_seconds", json!(0), json!(if cfg!(any(target_os = "linux", windows)) { 3 } else { 0 }), json!(0)),
        ("exec.isolation", json!("process_tree"), json!("process_tree"), json!("process_tree")),
        ("exec.default_cwd", json!("server"), json!("project"), json!("session")),
    ];
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
    put(&s, "server", "-", "exec.max_cpu_seconds", 0, json!(0)).await;
    for (key, value, revision) in [
        ("exec.shell", json!("fish"), 0),
        ("exec.max_memory_mb", json!(-1), 0),
        ("exec.max_memory_mb", json!(1_048_577), 0),
        ("exec.max_memory_mb", json!("128"), 0),
        ("exec.max_cpu_seconds", json!(1.5), 1),
        ("exec.max_cpu_seconds", json!(86_401), 1),
        ("exec.isolation", json!("none"), 0),
        ("exec.isolation", json!("sandbox"), 0),
    ] {
        let (status, result) = s.send(Method::PUT, &format!("/api/v1/settings/server/-/{key}"),
            json!({ "expected_revision": revision, "value": value })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{key}: {result}");
    }
    let (status, conflict) = s.send(Method::PUT, "/api/v1/settings/server/-/exec.max_cpu_seconds",
        json!({ "expected_revision": 0, "value": 0 })).await;
    assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
    let (_, effective) = s.get("/api/v1/settings/effective").await;
    assert_eq!(item(&effective, "exec.max_cpu_seconds")["effective"], 0);
    assert_eq!(item(&effective, "exec.max_cpu_seconds")["layers"]["server"]["revision"], 1);

    let (status, registry) = s.get("/api/v1/settings/registry").await;
    assert_eq!(status, StatusCode::OK);
    for def in registry.as_array().unwrap().iter().filter(|def| matches!(def["key"].as_str(), Some("exec.shell" | "exec.isolation"))) {
        for choice in def["unavailable_options"].as_array().unwrap() {
            assert!(!choice["reason"].as_str().unwrap().is_empty());
            assert!(!def["options"].as_array().unwrap().contains(&choice["value"]));
            let (status, result) = s.send(Method::PUT,
                &format!("/api/v1/settings/server/-/{}", def["key"].as_str().unwrap()),
                json!({ "expected_revision": 0, "value": choice["value"] })).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{result}");
        }
    }
    let response = s.raw(Method::PUT, "/api/v1/settings/server/-/exec.shell",
        Some(json!({ "expected_revision": 0, "value": "default" })), Some("unauthenticated"), Some("")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn default_cwd_uses_existing_boundary_validation_and_checks_the_execution_root_again() {
    let s = TestServer::start().await;
    let p = s.create_project("cwd").await;
    let pid = p["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    let root = std::path::Path::new(p["root_path"].as_str().unwrap());
    std::fs::create_dir(root.join("work")).unwrap();
    std::fs::write(root.join("file"), "fixture").unwrap();
    for value in ["", "/tmp", "../", "work/../", "C:/temp", r"C:\temp", r"..\outside", "work\0", "missing", "file"] {
        let (status, result) = s.send(Method::PUT, &format!("/api/v1/settings/session/{sid}/exec.default_cwd"),
            json!({ "expected_revision": 0, "value": value })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{value:?}: {result}");
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(s.dir.path(), root.join("escape")).unwrap();
        let (status, result) = s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/exec.default_cwd"),
            json!({ "expected_revision": 0, "value": "escape" })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{result}");
    }
    put(&s, "project", pid, "exec.default_cwd", 0, json!("work")).await;
    let c = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    let cwd = |root: &std::path::Path, explicit| grove::settings::execution_cwd(&c, root, Some(pid), Some(&sid), explicit);
    assert_eq!(cwd(root, None).unwrap(), root.join("work").canonicalize().unwrap());
    assert_eq!(cwd(root, Some(".")).unwrap(), root.canonicalize().unwrap());
    assert!(cwd(root, Some("../")).is_err());
    let worktree = s.make_project_dir("alternate-execution-root");
    assert!(cwd(&worktree, None).is_err(), "상속한 상대 경로가 실행 root에 없으면 거부한다");
    std::fs::create_dir(worktree.join("work")).unwrap();
    assert_eq!(cwd(&worktree, None).unwrap(), worktree.join("work").canonicalize().unwrap());
    // 설정 저장 뒤 디렉터리가 교체돼도 새 계획에서 프로젝트 밖으로 나가지 않는다.
    #[cfg(unix)]
    {
        std::fs::rename(root.join("work"), root.join("old-work")).unwrap();
        std::os::unix::fs::symlink(s.dir.path(), root.join("work")).unwrap();
        assert!(cwd(root, None).is_err());
    }
    put(&s, "session", &sid, "exec.default_cwd", 0, json!(".")).await;
    assert_eq!(cwd(root, None).unwrap(), root.canonicalize().unwrap());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn session_shell_and_limits_change_only_new_plans_in_foreground_and_background() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("fixed-plans").await;
    let pid = p["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    let command = "printf 'shell=%s\\n' \"$0\"; printf 'memory='; ulimit -v; printf 'cpu='; ulimit -t";
    let mut revision = 0;
    for background in [false, true] {
        for (key, value) in [("exec.shell", json!("sh")), ("exec.max_memory_mb", json!(128)), ("exec.max_cpu_seconds", json!(3))] {
            put(&s, "session", &sid, key, revision, value).await;
        }
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
            let (shell, memory, cpu) = if next { ("bash", 256, 5) } else { ("sh", 128, 3) };
            assert_eq!(call["target"]["shell"], shell);
            assert_eq!(call["target"]["limits"], json!({ "memory_mb": memory, "cpu_seconds": cpu }));
            if !next {
                for (key, value) in [("exec.shell", json!("bash")), ("exec.max_memory_mb", json!(256)), ("exec.max_cpu_seconds", json!(5))] {
                    put(&s, "session", &sid, key, revision, value).await;
                }
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
            assert!(output.contains(&format!("memory={}\n", memory * 1024)), "{result}");
            assert!(output.contains(&format!("cpu={cpu}\n")), "{result}");
        }
        let (status, task) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({ "command": command })).await;
        assert!(status.is_success(), "{task}");
        let (_, result) = s.get(&format!("/api/v1/tasks/{}/wait?timeout_ms=10000", task["id"].as_str().unwrap())).await;
        let output = result["stdout_tail"].as_str().unwrap();
        assert!(output.contains("shell=bash\n") && output.contains("memory=262144\n") && output.contains("cpu=5\n"), "{result}");
    }
}
