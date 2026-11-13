//! 실제 HTTP·격리 DB·로컬 프로세스 fixture. 사용자 hook이나 외부 서비스는 사용하지 않는다.
#![cfg(target_os = "linux")]
mod common;
use common::{TestServer, fixture::{self, Fixture}};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

async fn save(s: &TestServer, project: Option<&str>, event: &str, matcher: &str, command: &str) -> Value {
    let path = format!("/api/v1/hooks{}", project.map(|p| format!("?project_id={p}")).unwrap_or_default());
    let (status, hook) = s.post(&path, json!({"name":"fixture","event":event,"matcher":matcher,"command":command,"enabled":true})).await;
    assert_eq!(status, StatusCode::CREATED, "{hook}");
    hook
}
async fn calls(s: &TestServer, session: &str) -> Vec<Value> {
    s.get(&format!("/api/v1/tool-calls?session_id={session}")).await.1.as_array().unwrap().clone()
}
async fn wait_call(s: &TestServer, id: &str, status: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let (http, call) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
        assert_eq!(http, StatusCode::OK);
        if call["status"] == status { return call; }
        assert!(tokio::time::Instant::now() < deadline, "call wait timeout: {call}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
async fn decide(s: &TestServer, call: &Value, decision: &str) -> (StatusCode, Value) {
    s.post(&format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()),
        json!({"decision":decision,"expected_revision":call["revision"]})).await
}
async fn setting(s: &TestServer, project: &str, key: &str, value: Value) {
    let (status, body) = s.send(Method::PUT, &format!("/api/v1/settings/project/{project}/{key}"),
        json!({"expected_revision":0,"value":value})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
async fn marker(path: &Path) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        assert!(tokio::time::Instant::now() < deadline, "fixture marker missing");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
fn process_alive(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| {
        !s.rsplit_once(')').unwrap().1.trim_start().starts_with('Z')
    })
}

#[tokio::test]
async fn session_start_requires_a_fresh_approval_despite_allow_and_freezes_an_isolated_environment() {
    let s = TestServer::start().await;
    let project = s.create_project("start").await;
    let pid = project["id"].as_str().unwrap();
    let root = Path::new(project["root_path"].as_str().unwrap());
    setting(&s, pid, "tools.allow", json!("hook")).await;
    setting(&s, pid, "exec.max_memory_mb", json!(512)).await;
    setting(&s, pid, "exec.max_cpu_seconds", json!(2)).await;
    let hook = save(&s, Some(pid), "SessionStart", "*",
        "ulimit -v > limits.txt; ulimit -t >> limits.txt; printf '%s|%s|%s' \"${TMPDIR-unset}\" \"${BASH_ENV-unset}\" \"$GROVE_HOOK_EVENT\" > isolated.txt").await;
    assert!(!root.join("isolated.txt").exists());
    let session = s.create_session(pid).await;
    let sid = session["id"].as_str().unwrap();
    let list = calls(&s, sid).await;
    assert_eq!(list.len(), 1);
    let call = &list[0];
    assert_eq!(call["status"], "pending_approval");
    assert_eq!(call["target"]["hook_revision"], 1);
    assert_eq!(call["target"]["hook_scope"], pid);
    assert_eq!(call["target"]["matcher"], "*");
    assert_eq!(call["target"]["limits"], json!({"memory_mb":512,"cpu_seconds":2}));
    assert_eq!(call["target"]["environment"]["PATH"], "/usr/bin:/bin");
    assert!(call["target"]["environment"].get("HOME").is_none());
    assert!(call.get("precondition").is_none());
    assert_eq!(call["target"]["hook_id"], hook["id"]);
    assert!(!root.join("isolated.txt").exists());
    assert_eq!(decide(&s, call, "approve").await.0, StatusCode::OK);
    wait_call(&s, call["id"].as_str().unwrap(), "succeeded").await;
    assert_eq!(std::fs::read_to_string(root.join("isolated.txt")).unwrap(), "unset|unset|SessionStart");
    assert_eq!(std::fs::read_to_string(root.join("limits.txt")).unwrap(), "524288\n2\n");
}

#[tokio::test]
async fn prompt_replay_decision_replay_scope_and_matchers_do_not_duplicate_execution() {
    let s = TestServer::start().await;
    let p = s.create_project("scope").await;
    let other = s.create_project("other").await;
    let pid = p["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    save(&s, None, "UserPromptSubmit", &sid, "printf x >> count.txt").await;
    save(&s, Some(pid), "UserPromptSubmit", "not-this-session", "touch forbidden").await;
    save(&s, Some(other["id"].as_str().unwrap()), "UserPromptSubmit", "*", "touch forbidden").await;
    save(&s, Some(pid), "PreToolUse", "*", "touch forbidden").await;
    let path = format!("/api/v1/sessions/{sid}/messages");
    for _ in 0..2 {
        assert_eq!(s.raw(Method::POST, &path, Some(json!({"text":"fixture"})), Some("prompt-replay"), None).await.status(), StatusCode::CREATED);
    }
    let list = calls(&s, &sid).await;
    assert_eq!(list.len(), 1);
    let call = &list[0];
    let path = format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap());
    let body = json!({"decision":"approve","expected_revision":call["revision"]});
    assert_eq!(s.raw(Method::POST, &path, Some(body.clone()), Some("decision-replay"), None).await.status(), StatusCode::OK);
    wait_call(&s, call["id"].as_str().unwrap(), "succeeded").await;
    let replay = s.raw(Method::POST, &path, Some(body), Some("decision-replay"), None).await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    assert_eq!(calls(&s, &sid).await.len(), 1);
    let root = Path::new(p["root_path"].as_str().unwrap());
    assert_eq!(std::fs::read_to_string(root.join("count.txt")).unwrap(), "x");
    assert!(!root.join("forbidden").exists());
}

#[tokio::test]
async fn turn_prompt_stop_and_post_tool_events_execute_but_hook_tools_never_recurse() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("lifecycle").await;
    let pid = p["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    for event in ["UserPromptSubmit", "Stop", "PostToolUse"] {
        save(&s, Some(pid), event, "*", "printf '%s\\n' \"$GROVE_HOOK_EVENT\" >> events.txt").await;
    }
    f.push(fixture::text("fixture finished"));
    let (status, turn) = s.post(&format!("/api/v1/sessions/{sid}/turns"),
        json!({"text":"local fixture","profile_id":profile,"tools":false})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
    let (status, tool) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"),
        json!({"name":"list","args":{}})).await;
    assert_eq!(status, StatusCode::CREATED);
    wait_call(&s, tool["id"].as_str().unwrap(), "succeeded").await;
    let hooks: Vec<_> = calls(&s, &sid).await.into_iter().filter(|c| c["name"] == "hook").collect();
    assert_eq!(hooks.len(), 3);
    for call in &hooks {
        assert_eq!(call["status"], "pending_approval");
        assert_eq!(decide(&s, call, "approve").await.0, StatusCode::OK);
        wait_call(&s, call["id"].as_str().unwrap(), "succeeded").await;
    }
    assert_eq!(calls(&s, &sid).await.len(), 4, "hook 자체가 PostToolUse를 다시 만들지 않는다");
    let text = std::fs::read_to_string(Path::new(p["root_path"].as_str().unwrap()).join("events.txt")).unwrap();
    let mut actual: Vec<_> = text.lines().collect();
    actual.sort();
    assert_eq!(actual, ["PostToolUse", "Stop", "UserPromptSubmit"]);
}

#[tokio::test]
async fn changed_deleted_disabled_limits_and_current_deny_or_read_only_never_start_payloads() {
    for change in ["revision", "command", "matcher", "scope", "cwd", "disabled", "deleted", "limits", "deny_hook", "deny_shell", "read_only"] {
        let s = TestServer::start().await;
        let p = s.create_project(change).await;
        let pid = p["id"].as_str().unwrap();
        let hook = save(&s, Some(pid), "SessionStart", "*", "touch forbidden").await;
        let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
        let call = calls(&s, &sid).await.remove(0);
        let hook_path = format!("/api/v1/hooks/{}?project_id={pid}", hook["id"].as_str().unwrap());
        match change {
            "revision" | "command" | "matcher" | "disabled" => {
                let (status, _) = s.send(Method::PUT, &hook_path,
                    json!({"expected_revision":1,"name":"changed","event":"SessionStart",
                        "matcher":if change=="matcher" {"different"} else {"*"},
                        "command":if change=="command" {Some("touch changed")} else {None},
                        "enabled":change!="disabled"})).await;
                assert_eq!(status, StatusCode::OK);
            }
            "scope" => {
                let id = hook["id"].as_str().unwrap().to_string();
                s.server.as_ref().unwrap().app.db.call(move |c| {
                    c.execute("UPDATE hook_definitions SET project_id=NULL WHERE id=?1", [id])?;
                    Ok(())
                }).await.unwrap();
            }
            "cwd" => {
                let id = pid.to_string();
                let root = s.make_project_dir("moved");
                s.server.as_ref().unwrap().app.db.call(move |c| {
                    c.execute("UPDATE projects SET root_path=?1 WHERE id=?2", rusqlite::params![root.to_string_lossy(),id])?;
                    Ok(())
                }).await.unwrap();
            }
            "deleted" => assert_eq!(s.send(Method::DELETE, &format!("{hook_path}&expected_revision=1"), json!({})).await.0, StatusCode::OK),
            "limits" => setting(&s, pid, "exec.max_memory_mb", json!(100)).await,
            "deny_hook" => setting(&s, pid, "tools.deny", json!("hook")).await,
            "deny_shell" => setting(&s, pid, "tools.deny", json!("shell")).await,
            "read_only" => setting(&s, pid, "tools.mode", json!("read_only")).await,
            _ => unreachable!(),
        }
        let status = decide(&s, &call, "approve").await.0;
        assert!(matches!(status, StatusCode::OK | StatusCode::CONFLICT));
        let done = wait_call(&s, call["id"].as_str().unwrap(), "failed").await;
        let code = done["result"]["error"]["code"].as_str().unwrap();
        assert_eq!(code, match change {
            "revision" | "command" | "matcher" | "scope" | "disabled" | "deleted" => "hook_config_changed",
            "cwd" => "hook_cwd_changed",
            "limits" => "hook_limits_changed",
            "deny_hook" | "deny_shell" => "policy_denied",
            _ => "read_only",
        });
        assert!(!Path::new(p["root_path"].as_str().unwrap()).join("forbidden").exists());
    }
}

#[tokio::test]
async fn config_and_session_grant_revocation_are_rechecked_after_the_project_guard_wait() {
    for revoke_grant in [false, true] {
        let s = TestServer::start().await;
        let p = s.create_project("guard").await;
        let pid = p["id"].as_str().unwrap();
        let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
        let hook = save(&s, Some(pid), "UserPromptSubmit", "*", "touch forbidden").await;
        let (_, task) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({"command":"sleep 30"})).await;
        s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({"text":"fixture"})).await;
        let call = calls(&s, &sid).await.remove(0);
        assert_eq!(decide(&s, &call, if revoke_grant { "approve_session" } else { "approve" }).await.0, StatusCode::OK);
        wait_call(&s, call["id"].as_str().unwrap(), "running").await;
        if revoke_grant {
            assert_eq!(s.send(Method::DELETE, &format!("/api/v1/sessions/{sid}/tool-grants/hook"), json!({})).await.0, StatusCode::OK);
        } else {
            assert_eq!(s.send(Method::PUT, &format!("/api/v1/hooks/{}?project_id={pid}", hook["id"].as_str().unwrap()),
                json!({"expected_revision":1,"name":"disabled","event":"UserPromptSubmit","matcher":"*","enabled":false})).await.0, StatusCode::OK);
        }
        s.post(&format!("/api/v1/tasks/{}/cancel", task["id"].as_str().unwrap()), json!({})).await;
        let done = wait_call(&s, call["id"].as_str().unwrap(), "failed").await;
        assert_eq!(done["result"]["error"]["code"], if revoke_grant { "approval_revoked" } else { "hook_config_changed" });
        assert!(!Path::new(p["root_path"].as_str().unwrap()).join("forbidden").exists());
    }
}

#[tokio::test]
async fn explicit_cancel_reaps_owned_children_and_denial_never_executes() {
    let s = TestServer::start().await;
    let p = s.create_project("cancel").await;
    let pid = p["id"].as_str().unwrap();
    let root = Path::new(p["root_path"].as_str().unwrap());
    save(&s, Some(pid), "SessionStart", "*", "sleep 30 & echo $! > child.pid; printf ready > ready; wait").await;
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    let call = calls(&s, &sid).await.remove(0);
    assert_eq!(decide(&s, &call, "approve").await.0, StatusCode::OK);
    marker(&root.join("ready")).await;
    let child: u32 = std::fs::read_to_string(root.join("child.pid")).unwrap().trim().parse().unwrap();
    assert!(process_alive(child));
    s.post(&format!("/api/v1/tool-calls/{}/cancel", call["id"].as_str().unwrap()), json!({})).await;
    let done = wait_call(&s, call["id"].as_str().unwrap(), "cancelled").await;
    assert_eq!(done["result"]["error"]["code"], "cancelled");
    assert!(!process_alive(child));
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    let call = calls(&s, &sid).await.remove(0);
    assert_eq!(decide(&s, &call, "deny").await.0, StatusCode::OK);
    wait_call(&s, call["id"].as_str().unwrap(), "denied").await;
}

// 실제 이벤트를 직접 접수하는 isolated DB fixture. production HTTP에는 이벤트 발화 API가 없다.
async fn fixture_occurrence(s: &TestServer, session: &str) -> String {
    let session = session.to_string();
    s.server.as_ref().unwrap().app.db.call(move |c| {
        let id = grove::util::new_id();
        c.execute("INSERT INTO hook_events(id,session_id,event,source_id,match_target,created_at) VALUES(?1,?2,'UserPromptSubmit',?1,?2,'fixture')",
            rusqlite::params![id, session])?;
        Ok(id)
    }).await.unwrap()
}

#[tokio::test]
async fn timeout_and_nonzero_exit_remain_failures_and_output_is_capped_and_redacted() {
    for (command, code) in [
        ("sleep 30 & echo $! > child.pid; wait", "timeout"),
        ("printf failed >&2; exit 7", "hook_exit_failed"),
        ("head -c 200000 /dev/zero | tr '\\0' x", "succeeded"),
        ("TOKEN=hook-fixture-private; printf '%s' \"$TOKEN\"", "succeeded"),
    ] {
        let s = TestServer::start().await;
        let p = s.create_project("output").await;
        let pid = p["id"].as_str().unwrap();
        let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
        let hook = save(&s, Some(pid), "UserPromptSubmit", "*", command).await;
        let event = fixture_occurrence(&s, &sid).await;
        let (_, call) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"),
            json!({"name":"hook","args":{"hook_id":hook["id"],"event_id":event,"timeout_ms":if code=="timeout" {100} else {5000}}})).await;
        assert_eq!(call["status"], "pending_approval");
        assert_eq!(decide(&s, &call, "approve").await.0, StatusCode::OK);
        let done = wait_call(&s, call["id"].as_str().unwrap(), if code=="succeeded" {code} else {"failed"}).await;
        if code != "succeeded" { assert_eq!(done["result"]["error"]["code"], code); }
        if command.starts_with("head") {
            assert_eq!(done["result"]["output"]["stdout_bytes"], 200000);
            assert_eq!(done["result"]["output"]["truncated"], true);
        }
        if command.starts_with("TOKEN") {
            assert_eq!(done["target"]["command"], "[redacted]");
            assert_eq!(done["result"]["output"]["stdout"], "[redacted]");
            let evidence = s.server.as_ref().unwrap().app.db.call(|c| {
                let mut evidence = String::new();
                for sql in ["SELECT payload FROM events", "SELECT detail FROM audit_log", "SELECT response FROM idempotency"] {
                    for row in c.prepare(sql)?.query_map([], |r| r.get::<_, String>(0))? { evidence.push_str(&row?); }
                }
                Ok(evidence)
            }).await.unwrap();
            assert!(!evidence.contains("hook-fixture-private"));
            assert!(!done.to_string().contains("hook-fixture-private"));
        }
        assert!(done["result"].to_string().len() <= grove::tools::MAX_OUTPUT);
        if code == "timeout" {
            let child: u32 = std::fs::read_to_string(Path::new(p["root_path"].as_str().unwrap()).join("child.pid")).unwrap().trim().parse().unwrap();
            assert!(!process_alive(child));
        }
    }
}

#[tokio::test]
async fn restart_reaps_a_persisted_running_owner_and_unknown_is_never_repeated() {
    let mut s = TestServer::start().await;
    let p = s.create_project("recovery").await;
    let pid = p["id"].as_str().unwrap();
    let root = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
    let hook = save(&s, Some(pid), "SessionStart", "*", "printf x >> count.txt; sleep 30").await;
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    let call = calls(&s, &sid).await.remove(0);
    let id = call["id"].as_str().unwrap().to_string();
    let running = id.clone();
    s.server.as_ref().unwrap().app.db.call(move |c| {
        c.execute("UPDATE tool_calls SET status='running',started_at='fixture' WHERE id=?1", [running])?;
        Ok(())
    }).await.unwrap();
    // crash 직전 running receipt와 소유 표식이 있는 실제 프로세스의 재시작 fixture.
    let mut command = grove::tools::shell::command("bash", "printf x >> count.txt; sleep 30", &root, &id, grove::procs::Limits::default());
    let mut child = command.spawn().unwrap();
    let child_pid = child.id().unwrap();
    marker(&root.join("count.txt")).await;
    s.restart().await;
    let done = wait_call(&s, &id, "unknown").await;
    assert_eq!(done["result"]["error"]["code"], "server_restart");
    assert!(!process_alive(child_pid));
    child.wait().await.unwrap();
    let (_, duplicate) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"),
        json!({"name":"hook","args":{"hook_id":hook["id"],"event_id":call["target"]["event_id"]}})).await;
    assert_eq!(duplicate["status"], "failed");
    assert_eq!(duplicate["result"]["error"]["code"], "unknown_pending_review");
    let (_, observation) = s.get(&format!("/api/v1/tool-calls/{id}/observe")).await;
    let (status, reviewed) = s.post(&format!("/api/v1/tool-calls/{id}/review"),
        json!({"expected_revision":done["revision"],"fingerprint":observation["fingerprint"],"outcome":"partial","note":"local fixture"})).await;
    assert_eq!(status, StatusCode::OK, "{reviewed}");
    assert_eq!(reviewed["status"], "unknown");
    let (_, duplicate) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"),
        json!({"name":"hook","args":{"hook_id":hook["id"],"event_id":call["target"]["event_id"]}})).await;
    assert_eq!(duplicate["result"]["error"]["code"], "hook_already_planned");
    assert_eq!(std::fs::read_to_string(root.join("count.txt")).unwrap(), "x");
}

#[tokio::test]
async fn execution_listing_is_owner_scoped_and_unsupported_or_disabled_events_are_explicit() {
    let s = TestServer::start().await;
    let p = s.create_project("listing").await;
    let other = s.create_project("listing-other").await;
    let pid = p["id"].as_str().unwrap();
    let (_, listing) = s.get("/api/v1/hooks").await;
    assert_eq!(listing["execution_state"], "partial");
    assert_eq!(listing["supported_events"], json!(["SessionStart","UserPromptSubmit","PostToolUse","Stop"]));
    for event in ["PreToolUse", "SessionEnd"] {
        let hook = save(&s, Some(pid), event, "*", "touch forbidden").await;
        assert_eq!(hook["execution_state"], "not_implemented");
    }
    let disabled = save(&s, Some(pid), "SessionStart", "*", "touch forbidden").await;
    let path = format!("/api/v1/hooks/{}?project_id={pid}", disabled["id"].as_str().unwrap());
    assert_eq!(s.send(Method::PUT, &path, json!({"expected_revision":1,"name":"disabled","event":"SessionStart","matcher":"*","enabled":false})).await.0, StatusCode::OK);
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    assert!(calls(&s, &sid).await.is_empty());
    save(&s, Some(pid), "UserPromptSubmit", "*", "TOKEN=fixture-value printf hidden").await;
    s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({"text":"fixture"})).await;
    let path = format!("/api/v1/hooks/executions?project_id={pid}");
    let (status, executions) = s.get(&path).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(executions.as_array().unwrap().len(), 1);
    assert!(!executions.to_string().contains("fixture-value"));
    assert!(executions[0].get("precondition").is_none());
    assert_eq!(s.get(&format!("/api/v1/hooks/executions?project_id={}", other["id"].as_str().unwrap())).await.1, json!([]));
    let (_, device) = s.post("/api/v1/devices", json!({"name":"fixture"})).await;
    assert_eq!(s.raw(Method::GET, &path, None, None, Some(device["token"].as_str().unwrap())).await.status(), StatusCode::FORBIDDEN);
    assert_eq!(s.raw(Method::GET, &path, None, None, Some("")).await.status(), StatusCode::UNAUTHORIZED);
    // 일반 설정 API는 없는 셸을 거절한다. 다른 환경에서 저장된 셸이 남은 복구 상황을 준비한다.
    {
        let c = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
        c.execute(
            "INSERT INTO settings (scope,scope_id,key,value,revision,updated_at) VALUES ('project',?1,'exec.shell',?2,1,?3)",
            rusqlite::params![pid, json!("zsh").to_string(), "2026-01-01T00:00:00Z"],
        ).unwrap();
    }
    s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({"text":"unsupported shell fixture"})).await;
    assert!(calls(&s, &sid).await.iter().any(|c| c["result"]["error"]["code"]=="hook_shell_unsupported"));
    assert!(!Path::new(p["root_path"].as_str().unwrap()).join("forbidden").exists());
}

#[tokio::test]
async fn sh_uses_the_approved_shell_without_loading_host_environment() {
    let s = TestServer::start().await;
    let p = s.create_project("sh").await;
    let pid = p["id"].as_str().unwrap();
    setting(&s, pid, "exec.shell", json!("sh")).await;
    save(&s, Some(pid), "SessionStart", "*", "printf '%s' \"${TMPDIR-unset}\"").await;
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    let call = calls(&s, &sid).await.remove(0);
    assert_eq!(call["target"]["shell"], "sh");
    assert_eq!(decide(&s, &call, "approve").await.0, StatusCode::OK);
    let done = wait_call(&s, call["id"].as_str().unwrap(), "succeeded").await;
    assert_eq!(done["result"]["output"]["stdout"], "unset");
}
