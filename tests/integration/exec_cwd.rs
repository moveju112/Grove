//! 실제 셸·직접 작업의 cwd 계획 고정과 기존 실행 경계. cwd를 생략하면 실행 root(worktree 포함)에서 실행한다.
#![cfg(unix)]
use crate::common;

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
async fn omitted_and_explicit_cwd_reaches_shell_and_direct_tasks() {
    let (s, _pid, sid, root) = setup().await;
    for (explicit, expected) in [(None, "."), (Some("."), "."), (Some("next"), "next")] {
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
    let (_, registry) = s.get("/api/v1/settings/registry").await;
    assert!(!registry.as_array().unwrap().iter().any(|def| def["key"] == "exec.default_cwd"));
    let (status, _) = s.send(Method::PUT, "/api/v1/settings/server/-/exec.default_cwd",
        json!({"expected_revision": 0, "value": "next"})).await;
    assert!(status.is_client_error(), "기본 작업 위치는 설정할 수 없다");
}

#[tokio::test]
async fn model_foreground_hold_and_background_pin_root_cwd_before_approval() {
    let (s, _pid, sid, root) = setup().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    for mode in ["foreground", "hold", "background"] {
        let mut args = json!({"command": "pwd -P"});
        match mode {
            "hold" => args["hold_ms"] = json!(5000),
            "background" => args["background"] = json!(true),
            _ => {}
        }
        f.push(fixture::tool_calls(&[("cwd", "shell", args)]));
        f.push(fixture::text("끝"));
        // 백그라운드 결과는 같은 턴의 완료 보류 뒤 한 번 더 모델에 전달된다.
        if mode == "background" { f.push(fixture::text("결과 반영")); }
        let (status, accepted) = s.post(&format!("/api/v1/sessions/{sid}/turns"),
            json!({"text": "run", "profile_id": profile, "tools": true})).await;
        assert!(status.is_success(), "{accepted}");
        let tid = accepted["turn"]["id"].as_str().unwrap();
        let pending = s.wait_status(tid, "awaiting_approval").await;
        let call = &pending["tool_calls"][0];
        assert_eq!(call["target"]["cwd"], ".");
        assert!(call["args"].get("cwd").is_none(), "원래 모델 인자는 보존");
        let done = approve(&s, call).await;
        assert_eq!(done["target"], call["target"]);
        assert_eq!(done["status"], "succeeded", "{done}");
        let mut result = done["result"].clone();
        if result["background"] == true {
            let (_, ended) = s.get(&format!("/api/v1/tasks/{}/wait?timeout_ms=10000", result["task_id"].as_str().unwrap())).await;
            result = ended;
        }
        let stdout = result["stdout"].as_str().or(result["stdout_tail"].as_str()).unwrap();
        assert_eq!(stdout, output(&root, "."), "{mode}: {result}");
        s.wait_status(tid, "completed").await;
    }
}

#[tokio::test]
async fn worktree_cwd_uses_actual_execution_root_and_never_falls_back() {
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
    let done = task(&s, sid, json!({"command": "pwd -P; printf x >> marker", "cwd": "session"})).await;
    assert_eq!(done["stdout_tail"], output(&wt_root, "session"));
    assert_eq!(std::fs::read_to_string(wt_root.join("session/marker")).unwrap(), "x");
    assert!(!root.join("session/marker").exists());
    let call = request(&s, sid, json!({"command": "pwd -P"})).await;
    assert_eq!(call["target"]["cwd"], ".");
    assert_eq!(approve(&s, &call).await["result"]["stdout"], output(&wt_root, "."));
    let (status, _) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({"command": "pwd -P", "cwd": "project"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "프로젝트에는 있지만 worktree에는 없는 cwd");
    assert_eq!(request(&s, sid, json!({"command": "pwd -P", "cwd": "project"})).await["status"], "failed");
    assert_eq!(task(&s, sid, json!({"command": "pwd -P"})).await["stdout_tail"], output(&wt_root, "."));
}

#[tokio::test]
async fn invalid_cwd_and_post_plan_symlink_escape_never_execute_outside_root() {
    let (s, _pid, sid, root) = setup().await;
    let unsafe_args = json!({"command": "printf unsafe > escaped", "cwd": "session"});
    let call = request(&s, &sid, unsafe_args.clone()).await;
    std::fs::rename(root.join("session"), root.join("old-session")).unwrap();
    std::os::unix::fs::symlink(s.dir.path(), root.join("session")).unwrap();
    let done = approve(&s, &call).await;
    assert_eq!(done["target"], call["target"]);
    assert_eq!(done["status"], "failed", "{done}");
    assert!(done["result"]["error"]["message"].as_str().unwrap().contains("프로젝트 밖 경로"), "{done}");
    let failed = request(&s, &sid, unsafe_args.clone()).await;
    assert_eq!(failed["status"], "failed");
    let (status, _) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), unsafe_args).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(!s.dir.path().join("escaped").exists());
    assert_eq!(task(&s, &sid, json!({"command": "pwd -P", "cwd": "."})).await["stdout_tail"], output(&root, "."));
    for cwd in ["../..", "missing", "old-session/file"] {
        std::fs::write(root.join("old-session/file"), "not a directory").unwrap();
        let args = json!({"command": "printf unsafe > escaped", "cwd": cwd});
        assert_eq!(request(&s, &sid, args.clone()).await["status"], "failed", "{cwd}");
        assert_eq!(s.post(&format!("/api/v1/sessions/{sid}/tasks"), args).await.0, StatusCode::BAD_REQUEST);
    }
    assert!(!root.join("escaped").exists());
}

#[tokio::test]
async fn explicit_cwd_does_not_bypass_deny_rechecks() {
    let (s, pid, sid, root) = setup().await;
    let args = json!({"command": "printf unsafe > marker", "cwd": "session"});
    let pending = request(&s, &sid, args.clone()).await;
    setting(&s, "project", &pid, "tools.deny", 0, json!("shell")).await;
    let blocked = request(&s, &sid, args).await;
    assert_eq!(blocked["target"]["cwd"], "session");
    assert_eq!(blocked["status"], "failed");
    assert_eq!(blocked["result"]["error"]["code"], "policy_denied");
    let id = pending["id"].as_str().unwrap();
    let (status, result) = s.post(&format!("/api/v1/tool-calls/{id}/decision"),
        json!({"decision": "approve", "expected_revision": pending["revision"]})).await;
    assert!(!status.is_success(), "{result}");
    assert!(!root.join("session/marker").exists());
}

#[tokio::test]
async fn accepted_task_replay_keeps_cwd_after_lost_body() {
    let (s, _pid, sid, root) = setup().await;
    let path = format!("/api/v1/sessions/{sid}/tasks");
    let body = json!({"command": "pwd -P; printf x >> counter", "cwd": "session"});
    let response = s.raw(Method::POST, &path, Some(body.clone()), Some("lost-body"), None).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    drop(response); // 접수 응답 본문을 소비하지 않아도 같은 키만 재사용한다.
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
async fn unknown_receipt_and_restart_keep_task_cwd() {
    let (mut s, _pid, sid, root) = setup().await;
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_cwd_receipt BEFORE UPDATE ON idempotency WHEN NEW.status=201
        BEGIN SELECT RAISE(ABORT,'fixture final receipt failure'); END;").unwrap();
    let path = format!("/api/v1/sessions/{sid}/tasks");
    let body = json!({"command": "pwd -P; printf x >> counter", "cwd": "session"});
    let response = s.raw(Method::POST, &path, Some(body.clone()), Some("unknown-cwd"), None).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let first: Value = response.json().await.unwrap();
    assert_eq!(first["error"]["code"], "result_unknown");
    db.execute_batch("DROP TRIGGER fail_cwd_receipt;").unwrap();
    let id = first["error"]["details"]["task_id"].as_str().unwrap();
    let (_, done) = s.get(&format!("/api/v1/tasks/{id}/wait?timeout_ms=10000")).await;
    assert_eq!(done["stdout_tail"], output(&root, "session"));
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
async fn confirmed_project_script_runs_at_root() {
    let (s, pid, sid, root) = setup().await;
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
    let replay = s.raw(Method::POST, &path, Some(body), Some("script-root"), None).await;
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    assert_eq!(replay.json::<Value>().await.unwrap()["id"], accepted["id"]);
}
