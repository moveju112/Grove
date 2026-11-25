//! 일반 도구 전체 권한: 명시적 범위·자동 실행·셸 환경·기존 제한의 우선순위.
#![cfg(unix)]
use crate::common;

use common::TestServer;
use common::fixture::{self, Fixture};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;

async fn setup() -> (TestServer, Value, String) {
    let s = TestServer::start_default_permissions().await;
    let project = s.create_project("full-access").await;
    let sid = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    (s, project, sid)
}

async fn setting(s: &TestServer, scope: &str, id: &str, key: &str, revision: i64, value: Value) {
    let (status, body) = s.send(Method::PUT, &format!("/api/v1/settings/{scope}/{id}/{key}"),
        json!({"expected_revision":revision,"value":value})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

async fn request(s: &TestServer, sid: &str, name: &str, args: Value) -> Value {
    let (status, body) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"), json!({"name":name,"args":args})).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let id = body["id"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let (status, call) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
            assert_eq!(status, StatusCode::OK, "{call}");
            if !matches!(call["status"].as_str(), Some("approved" | "running")) { return call; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.expect("tool receipt")
}

#[tokio::test]
async fn full_access_is_the_default_and_automates_file_changes_and_both_shell_paths() {
    let (s, project, sid) = setup().await;
    let root = std::path::Path::new(project["root_path"].as_str().unwrap());
    let (_, registry) = s.get("/api/v1/settings/registry").await;
    assert!(!registry.as_array().unwrap().iter().any(|row| row["key"] == "tools.default_enabled"));
    let definition = registry.as_array().unwrap().iter().find(|row| row["key"] == "tools.full_access").unwrap();
    assert_eq!(definition["default"], true);
    assert_eq!(definition["scopes"], json!(["server", "project"]));
    for (name, args) in [
        ("write", json!({"path":"regular.txt","content":"READY\n"})),
        ("edit", json!({"path":"regular.txt","old_string":"READY","new_string":"EDITED"})),
        ("apply_patch", json!({"patch":"*** Begin Patch\n*** Add File: patched.txt\n+PATCHED\n*** End Patch\n"})),
        ("shell", json!({"command":"python3 -c 'import pathlib,socket; s=socket.socket(); s.bind((\"127.0.0.1\",0)); s.listen(1); pathlib.Path(\"../outside-probe.txt\").write_text(\"BOUND\\n\"); s.close()'"})),
        ("shell", json!({"command":"printf 'BACKGROUND\\n' > background.txt","hold_ms":10000})),
    ] {
        let call = request(&s, &sid, name, args).await;
        assert_eq!(call["status"], "succeeded", "{call}");
        assert_eq!(call["needs_approval"], false);
        assert_eq!(call["approval_scope"], "policy");
        if name == "shell" { assert_eq!(call["target"]["inherit_credentials"], true); }
    }
    assert_eq!(std::fs::read_to_string(root.join("regular.txt")).unwrap(), "EDITED\n");
    assert_eq!(std::fs::read_to_string(root.join("patched.txt")).unwrap(), "PATCHED\n");
    assert_eq!(std::fs::read_to_string(root.join("background.txt")).unwrap(), "BACKGROUND\n");
    assert_eq!(std::fs::read_to_string(root.parent().unwrap().join("outside-probe.txt")).unwrap(), "BOUND\n");
}

#[tokio::test]
async fn new_turn_and_followup_use_tools_by_default_but_allow_an_explicit_opt_out() {
    let (s, project, sid) = setup().await;
    let root = std::path::Path::new(project["root_path"].as_str().unwrap());
    let fixture = Fixture::start().await;
    let profile = s.fixture_profile(&fixture.base).await;
    for (endpoint, field, filename) in [("turns", "turn", "first.txt"), ("followups", "started_turn", "followup.txt")] {
        fixture.push(fixture::tool_calls(&[("w1", "write", json!({"path":filename,"content":"written\n"}))]));
        fixture.push(fixture::text("done"));
        let (status, body) = s.post(&format!("/api/v1/sessions/{sid}/{endpoint}"),
            json!({"kind":"queue","text":"파일 써","profile_id":profile})).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{body}");
        assert_eq!(body[field]["tools_enabled"], true);
        s.wait_status(body[field]["id"].as_str().unwrap(), "completed").await;
        assert_eq!(std::fs::read_to_string(root.join(filename)).unwrap(), "written\n");
    }
    fixture.push(fixture::text("text only"));
    let (status, body) = s.post(&format!("/api/v1/sessions/{sid}/turns"),
        json!({"text":"말로만 답해","profile_id":profile,"tools":false})).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(body["turn"]["tools_enabled"], false);
    s.wait_status(body["turn"]["id"].as_str().unwrap(), "completed").await;
    assert!(fixture.requests().last().unwrap().get("tools").is_none());
}

#[tokio::test]
async fn explicit_restriction_survives_restart_and_clearing_it_restores_the_default() {
    let (mut s, project, sid) = setup().await;
    let root = std::path::PathBuf::from(project["root_path"].as_str().unwrap());
    setting(&s, "server", "-", "tools.mode", 0, json!("ask")).await;
    setting(&s, "server", "-", "tools.full_access", 0, json!(false)).await;
    s.restart().await;
    for (name, args) in [
        ("write", json!({"path":"restricted.txt","content":"NO\n"})),
        ("shell", json!({"command":"printf forbidden"})),
    ] {
        let call = request(&s, &sid, name, args).await;
        assert_eq!(call["status"], "pending_approval");
        if name == "shell" { assert_eq!(call["target"]["inherit_credentials"], false); }
    }
    assert!(!root.join("restricted.txt").exists());
    setting(&s, "server", "-", "tools.full_access", 1, Value::Null).await;
    let call = request(&s, &sid, "write", json!({"path":"default.txt","content":"YES\n"})).await;
    assert_eq!(call["status"], "succeeded");
    assert_eq!(std::fs::read_to_string(root.join("default.txt")).unwrap(), "YES\n");
}

#[tokio::test]
async fn full_access_can_be_scoped_and_never_overrides_explicit_deny() {
    let (s, project, sid) = setup().await;
    let pid = project["id"].as_str().unwrap();
    setting(&s, "project", pid, "tools.mode", 0, json!("ask")).await;
    setting(&s, "server", "-", "tools.full_access", 0, json!(true)).await;
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/settings/session/{sid}/tools.full_access"),
        json!({"expected_revision":0,"value":true})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "대화 범위에서 포괄 권한을 넓히지 않는다");
    setting(&s, "project", pid, "tools.full_access", 0, json!(false)).await;
    let call = request(&s, &sid, "write", json!({"path":"pending.txt","content":"no"})).await;
    assert_eq!(call["status"], "pending_approval");
    setting(&s, "project", pid, "tools.full_access", 1, json!(true)).await;
    setting(&s, "session", &sid, "tools.deny", 0, json!("shell")).await;
    let call = request(&s, &sid, "shell", json!({"command":"printf forbidden > blocked.txt"})).await;
    assert_eq!(call["result"]["error"]["code"], "policy_denied");
    let call = request(&s, &sid, "write", json!({"path":"allowed.txt","content":"YES\n"})).await;
    assert_eq!(call["status"], "succeeded");
    assert!(!std::path::Path::new(project["root_path"].as_str().unwrap()).join("blocked.txt").exists());
}

#[tokio::test]
async fn full_access_keeps_delegation_policy_separate() {
    let (s, project, sid) = setup().await;
    let pid = project["id"].as_str().unwrap().to_string();
    setting(&s, "server", "-", "tools.full_access", 0, json!(true)).await;
    s.server.as_ref().unwrap().app.db.call(move |c| {
        let spec = grove::tools::spec("agent").unwrap();
        assert_eq!(grove::approvals::tool_policy(c, &pid, &sid, &spec)?, grove::approvals::PolicyDecision::Default);
        Ok(())
    }).await.unwrap();
}
