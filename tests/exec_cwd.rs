//! SETTINGS-011: 실제 셸·직접 작업의 cwd 계획 고정과 기존 실행 경계.
#![cfg(unix)]
mod common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;

async fn setup() -> (TestServer, String, String, PathBuf) {
    let s = TestServer::start().await;
    let p = s.create_project("exec-cwd").await;
    let pid = p["id"].as_str().unwrap().to_owned();
    let sid = s.create_session(&pid).await["id"].as_str().unwrap().to_owned();
    let root = PathBuf::from(p["root_path"].as_str().unwrap());
    for dir in ["server", "project", "session", "next"] {
        std::fs::create_dir(root.join(dir)).unwrap();
    }
    (s, pid, sid, root)
}

async fn setting(s: &TestServer, scope: &str, id: &str, key: &str, revision: i64, value: Value) {
    let (status, result) = s.send(Method::PUT, &format!("/api/v1/settings/{scope}/{id}/{key}"),
        json!({"expected_revision": revision, "value": value})).await;
    assert_eq!(status, StatusCode::OK, "{result}");
}

async fn cwd_setting(s: &TestServer, scope: &str, id: &str, revision: i64, value: Value) {
    setting(s, scope, id, "exec.default_cwd", revision, value).await;
}

async fn request(s: &TestServer, sid: &str, args: Value) -> Value {
    let (status, call) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"),
        json!({"name": "shell", "args": args})).await;
    assert_eq!(status, StatusCode::CREATED, "{call}");
    call
}

async fn approve(s: &TestServer, call: &Value) -> Value {
    let id = call["id"].as_str().unwrap();
    let (status, decision) = s.post(&format!("/api/v1/tool-calls/{id}/decision"),
        json!({"decision": "approve", "expected_revision": call["revision"]})).await;
    assert!(status.is_success(), "{decision}");
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let (_, done) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
            if grove::approvals::TERMINAL.contains(&done["status"].as_str().unwrap()) {
                return done;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("셸 호출 완료")
}

async fn task(s: &TestServer, sid: &str, body: Value) -> Value {
    let (status, accepted) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), body).await;
    assert_eq!(status, StatusCode::CREATED, "{accepted}");
    let (status, done) = s.get(&format!("/api/v1/tasks/{}/wait?timeout_ms=10000", accepted["id"].as_str().unwrap())).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["status"], "completed", "{done}");
    assert_eq!(done["cwd"], accepted["cwd"]);
    done
}

fn output(root: &Path, cwd: &str) -> String {
    format!("{}\n", root.join(cwd).canonicalize().unwrap().display())
}

#[tokio::test]
async fn inherited_and_explicit_cwd_reaches_shell_and_direct_tasks() {
    let (s, pid, sid, root) = setup().await;
    cwd_setting(&s, "server", "-", 0, json!("server")).await;
    cwd_setting(&s, "project", &pid, 0, json!("project")).await;
    cwd_setting(&s, "session", &sid, 0, json!("session")).await;
    for (explicit, expected) in [(None, "session"), (Some("."), "."), (Some("next"), "next")] {
        let mut args = json!({"command": "pwd -P"});
        if let Some(cwd) = explicit { args["cwd"] = json!(cwd); }
        let done = task(&s, &sid, args.clone()).await;
        assert_eq!(done["cwd"], expected);
        assert_eq!(done["stdout_tail"], output(&root, expected));
        let planned = request(&s, &sid, args).await;
        assert_eq!(planned["target"]["cwd"], expected);
        let done = approve(&s, &planned).await;
        assert_eq!(done["status"], "succeeded", "{done}");
        assert_eq!(done["result"]["stdout"], output(&root, expected));
    }
    for (scope, id, expected) in [("session", sid.as_str(), "project"), ("project", pid.as_str(), "server"), ("server", "-", ".")] {
        cwd_setting(&s, scope, id, 1, Value::Null).await;
        let done = task(&s, &sid, json!({"command": "pwd -P"})).await;
        assert_eq!(done["cwd"], expected);
        assert_eq!(done["stdout_tail"], output(&root, expected));
        let planned = request(&s, &sid, json!({"command": "pwd -P"})).await;
        assert_eq!(planned["target"]["cwd"], expected);
        assert_eq!(approve(&s, &planned).await["result"]["stdout"], output(&root, expected));
    }
}

#[tokio::test]
async fn model_foreground_hold_and_background_freeze_cwd_before_approval_changes() {
    let (s, _pid, sid, root) = setup().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let mut revision = 0;
    for mode in ["foreground", "hold", "background"] {
        cwd_setting(&s, "session", &sid, revision, json!("session")).await;
        revision += 1;
        for next in [false, true] {
            let mut args = json!({"command": "pwd -P"});
            match mode {
                "hold" => args["hold_ms"] = json!(5000),
                "background" => args["background"] = json!(true),
                _ => {}
            }
            f.push(fixture::tool_calls(&[("cwd", "shell", args)]));
            f.push(fixture::text("끝"));
            let (status, accepted) = s.post(&format!("/api/v1/sessions/{sid}/turns"),
                json!({"text": "run", "profile_id": profile, "tools": true})).await;
            assert!(status.is_success(), "{accepted}");
            let tid = accepted["turn"]["id"].as_str().unwrap();
            let pending = s.wait_status(tid, "awaiting_approval").await;
            let call = &pending["tool_calls"][0];
            let cwd = if next { "next" } else { "session" };
            assert_eq!(call["target"]["cwd"], cwd);
            assert!(call["args"].get("cwd").is_none(), "원래 모델 인자는 보존");
            if !next {
                cwd_setting(&s, "session", &sid, revision, json!("next")).await;
                revision += 1;
            }
            let done = approve(&s, call).await;
            assert_eq!(done["target"], call["target"]);
            assert_eq!(done["status"], "succeeded", "{done}");
            let mut result = done["result"].clone();
            if result["background"] == true {
                let (_, ended) = s.get(&format!("/api/v1/tasks/{}/wait?timeout_ms=10000", result["task_id"].as_str().unwrap())).await;
                result = ended;
            }
            let stdout = result["stdout"].as_str().or(result["stdout_tail"].as_str()).unwrap();
            assert_eq!(stdout, output(&root, cwd), "{mode}: {result}");
            s.wait_status(tid, "completed").await;
        }
    }
}

#[tokio::test]
async fn worktree_defaults_use_actual_execution_root_and_never_fall_back() {
    let (s, pid, _sid, root) = setup().await;
    std::fs::write(root.join("session/tracked"), "fixture").unwrap();
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.email", "fixture@example.invalid"],
        vec!["config", "user.name", "Fixture"],
        vec!["add", "."],
        vec!["commit", "-qm", "fixture"],
    ] {
        let out = std::process::Command::new("git").args(args).current_dir(&root).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }
    s.use_workspaces(&pid).await;
    let (status, wt) = s.post(&format!("/api/v1/projects/{pid}/worktrees"), json!({"name": "cwd"})).await;
    assert_eq!(status, StatusCode::CREATED, "{wt}");
    let wt_root = PathBuf::from(wt["path"].as_str().unwrap());
    let (status, sess) = s.post(&format!("/api/v1/projects/{pid}/sessions"), json!({"worktree_id": wt["id"]})).await;
    assert_eq!(status, StatusCode::CREATED, "{sess}");
    let sid = sess["id"].as_str().unwrap();
    cwd_setting(&s, "project", &pid, 0, json!("session")).await;
    let done = task(&s, sid, json!({"command": "pwd -P; printf x >> marker"})).await;
    assert_eq!(done["stdout_tail"], output(&wt_root, "session"));
    assert_eq!(std::fs::read_to_string(wt_root.join("session/marker")).unwrap(), "x");
    assert!(!root.join("session/marker").exists());
    let call = request(&s, sid, json!({"command": "pwd -P"})).await;
    assert_eq!(call["target"]["cwd"], "session");
    assert_eq!(approve(&s, &call).await["result"]["stdout"], output(&wt_root, "session"));
    cwd_setting(&s, "project", &pid, 1, json!("project")).await;
    let (status, _) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({"command": "pwd -P"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "프로젝트에는 있지만 worktree에는 없는 cwd");
    assert_eq!(request(&s, sid, json!({"command": "pwd -P"})).await["status"], "failed");
    assert_eq!(task(&s, sid, json!({"command": "pwd -P", "cwd": "."})).await["stdout_tail"], output(&wt_root, "."));
}

#[tokio::test]
async fn invalid_defaults_and_post_plan_symlink_escape_never_execute_outside_root() {
    let (s, pid, sid, root) = setup().await;
    cwd_setting(&s, "project", &pid, 0, json!("session")).await;
    let call = request(&s, &sid, json!({"command": "printf unsafe > escaped"})).await;
    std::fs::rename(root.join("session"), root.join("old-session")).unwrap();
    std::os::unix::fs::symlink(s.dir.path(), root.join("session")).unwrap();
    let done = approve(&s, &call).await;
    assert_eq!(done["target"], call["target"]);
    assert_eq!(done["status"], "failed", "{done}");
    assert_eq!(done["result"]["error"]["code"], "outside_project");
    let failed = request(&s, &sid, json!({"command": "printf unsafe > escaped"})).await;
    assert_eq!(failed["status"], "failed");
    let (status, _) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({"command": "printf unsafe > escaped"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(!s.dir.path().join("escaped").exists());
    assert_eq!(task(&s, &sid, json!({"command": "pwd -P", "cwd": "."})).await["stdout_tail"], output(&root, "."));
    for cwd in ["../..", "missing", "old-session/file"] {
        std::fs::write(root.join("old-session/file"), "not a directory").unwrap();
        let args = json!({"command": "printf unsafe > escaped", "cwd": cwd});
        assert_eq!(request(&s, &sid, args.clone()).await["status"], "failed", "{cwd}");
        assert_eq!(s.post(&format!("/api/v1/sessions/{sid}/tasks"), args).await.0, StatusCode::BAD_REQUEST);
    }
    cwd_setting(&s, "server", "-", 0, json!("missing")).await;
    cwd_setting(&s, "project", &pid, 1, Value::Null).await;
    assert_eq!(request(&s, &sid, json!({"command": "pwd -P"})).await["status"], "failed");
    assert_eq!(s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({"command": "pwd -P"})).await.0, StatusCode::BAD_REQUEST);
    assert!(!root.join("escaped").exists());
}

#[tokio::test]
async fn cwd_defaults_do_not_bypass_deny_or_read_only_rechecks() {
    for (key, value, code) in [("tools.deny", "shell", "policy_denied"), ("tools.mode", "read_only", "read_only")] {
        let (s, pid, sid, root) = setup().await;
        cwd_setting(&s, "project", &pid, 0, json!("session")).await;
        let pending = request(&s, &sid, json!({"command": "printf unsafe > marker"})).await;
        setting(&s, "project", &pid, key, 0, json!(value)).await;
        let blocked = request(&s, &sid, json!({"command": "printf unsafe > marker"})).await;
        assert_eq!(blocked["target"]["cwd"], "session");
        assert_eq!(blocked["status"], "failed");
        assert_eq!(blocked["result"]["error"]["code"], code);
        let id = pending["id"].as_str().unwrap();
        let (status, result) = s.post(&format!("/api/v1/tool-calls/{id}/decision"),
            json!({"decision": "approve", "expected_revision": pending["revision"]})).await;
        assert!(!status.is_success(), "{result}");
        assert!(!root.join("session/marker").exists());
    }
}

#[tokio::test]
async fn accepted_task_replay_keeps_cwd_after_lost_body_and_changed_defaults() {
    let (s, _pid, sid, root) = setup().await;
    cwd_setting(&s, "session", &sid, 0, json!("session")).await;
    let path = format!("/api/v1/sessions/{sid}/tasks");
    let body = json!({"command": "pwd -P; printf x >> counter"});
    let response = s.raw(Method::POST, &path, Some(body.clone()), Some("lost-body"), None).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    drop(response); // 접수 응답 본문을 소비하지 않아도 같은 키만 재사용한다.
    cwd_setting(&s, "session", &sid, 1, json!("next")).await;
    std::fs::rename(root.join("next"), root.join("old-next")).unwrap();
    let replay = s.raw(Method::POST, &path, Some(body.clone()), Some("lost-body"), None).await;
    assert_eq!(replay.status(), StatusCode::CREATED);
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    let accepted: Value = replay.json().await.unwrap();
    assert_eq!(accepted["cwd"], "session");
    let (_, done) = s.get(&format!("/api/v1/tasks/{}/wait?timeout_ms=10000", accepted["id"].as_str().unwrap())).await;
    assert_eq!(done["stdout_tail"], output(&root, "session"));
    assert_eq!(std::fs::read_to_string(root.join("session/counter")).unwrap(), "x");
    let (_, tasks) = s.get(&path).await;
    assert_eq!(tasks["tasks"].as_array().unwrap().len(), 1);
    let conflict = s.raw(Method::POST, &path, Some(json!({"command": body["command"], "cwd": "."})), Some("lost-body"), None).await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn unknown_receipt_and_restart_keep_task_cwd_without_resolving_defaults_again() {
    let (mut s, _pid, sid, root) = setup().await;
    cwd_setting(&s, "session", &sid, 0, json!("session")).await;
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_cwd_receipt BEFORE UPDATE ON idempotency WHEN NEW.status=201
        BEGIN SELECT RAISE(ABORT,'fixture final receipt failure'); END;").unwrap();
    let path = format!("/api/v1/sessions/{sid}/tasks");
    let body = json!({"command": "pwd -P; printf x >> counter"});
    let response = s.raw(Method::POST, &path, Some(body.clone()), Some("unknown-cwd"), None).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let first: Value = response.json().await.unwrap();
    assert_eq!(first["error"]["code"], "result_unknown");
    db.execute_batch("DROP TRIGGER fail_cwd_receipt;").unwrap();
    let id = first["error"]["details"]["task_id"].as_str().unwrap();
    let (_, done) = s.get(&format!("/api/v1/tasks/{id}/wait?timeout_ms=10000")).await;
    assert_eq!(done["stdout_tail"], output(&root, "session"));
    cwd_setting(&s, "session", &sid, 1, json!("next")).await;
    // crash 복구 입력: 완료한 격리 fixture 작업의 영속 상태만 running으로 되돌린다.
    db.execute("UPDATE tasks SET status='running', ended_at=NULL, result_message_id=NULL WHERE id=?1", [id]).unwrap();
    drop(db);
    s.restart().await;
    let replay = s.raw(Method::POST, &path, Some(body), Some("unknown-cwd"), None).await;
    assert_eq!(replay.status(), StatusCode::CONFLICT);
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    assert_eq!(replay.json::<Value>().await.unwrap(), first);
    let (_, recovered) = s.get(&format!("/api/v1/tasks/{id}")).await;
    assert_eq!(recovered["status"], "unknown");
    assert_eq!(recovered["cwd"], "session");
    let (_, tasks) = s.get(&path).await;
    assert_eq!(tasks["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(std::fs::read_to_string(root.join("session/counter")).unwrap(), "x");
    assert!(!root.join("next/counter").exists());
}

#[tokio::test]
async fn confirmed_project_script_stays_at_root_instead_of_inheriting_default_cwd() {
    let (s, pid, sid, root) = setup().await;
    cwd_setting(&s, "session", &sid, 0, json!("session")).await;
    let (status, script) = s.post(&format!("/api/v1/projects/{pid}/scripts"),
        json!({"name": "root check", "command": "pwd -P; printf x >> root-counter"})).await;
    assert_eq!(status, StatusCode::CREATED, "{script}");
    let (_, list) = s.get(&format!("/api/v1/projects/{pid}/scripts")).await;
    let path = format!("/api/v1/sessions/{sid}/scripts/{}/run", script["id"].as_str().unwrap());
    let body = json!({"command": script["command"], "expected_revision": script["revision"],
        "expected_execution": list["execution"]["fingerprint"], "expected_owner": list["owner"]});
    let accepted = s.raw(Method::POST, &path, Some(body.clone()), Some("script-root"), None).await;
    assert_eq!(accepted.status(), StatusCode::CREATED);
    let accepted: Value = accepted.json().await.unwrap();
    assert_eq!(accepted["cwd"], ".");
    let (_, done) = s.get(&format!("/api/v1/tasks/{}/wait?timeout_ms=10000", accepted["id"].as_str().unwrap())).await;
    assert_eq!(done["stdout_tail"], output(&root, "."));
    assert_eq!(std::fs::read_to_string(root.join("root-counter")).unwrap(), "x");
    assert!(!root.join("session/root-counter").exists());
    cwd_setting(&s, "session", &sid, 1, json!("next")).await;
    let replay = s.raw(Method::POST, &path, Some(body), Some("script-root"), None).await;
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    assert_eq!(replay.json::<Value>().await.unwrap()["id"], accepted["id"]);
}
