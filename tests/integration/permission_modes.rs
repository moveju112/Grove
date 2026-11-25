//! 일반 도구의 영구 승인·bypass와 제한 정책의 우선순위.
use crate::common;
use common::TestServer;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn setting(s: &TestServer, scope: &str, id: &str, key: &str, revision: i64, value: Value) {
    let (status, body) = s.send(Method::PUT, &format!("/api/v1/settings/{scope}/{id}/{key}"),
        json!({"expected_revision":revision,"value":value})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
async fn write(s: &TestServer, sid: &str, path: &str) -> Value {
    let (status, body) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"),
        json!({"name":"write","args":{"path":path,"content":"fixture"}})).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body
}
async fn allow(s: &TestServer) -> Value {
    let (_, body) = s.get("/api/v1/settings/effective").await;
    body["items"].as_array().unwrap().iter().find(|v| v["key"] == "tools.allow").unwrap().clone()
}
async fn finished(s: &TestServer, call: &Value) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let (_, body) = s.get(&format!("/api/v1/tool-calls/{}", call["id"].as_str().unwrap())).await;
        if body["status"] == "succeeded" { return; }
        assert!(tokio::time::Instant::now() < deadline, "{body}");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn always_approval_appends_persists_across_projects_and_replays_without_new_revision() {
    let mut s = TestServer::start().await;
    setting(&s,"server","-","tools.allow",0,json!("read")).await;
    let p = s.create_project("always").await;
    let session = s.create_session(p["id"].as_str().unwrap()).await;
    let call = write(&s,session["id"].as_str().unwrap(),"first.txt").await;
    assert_eq!(call["status"],"pending_approval");
    let path = format!("/api/v1/tool-calls/{}/decision",call["id"].as_str().unwrap());
    let body = json!({"decision":"approve_always","expected_revision":call["revision"]});
    for _ in 0..2 {
        let response = s.raw(Method::POST,&path,Some(body.clone()),Some("always-replay"),None).await;
        assert_eq!(response.status(),StatusCode::OK);
        assert_eq!(response.json::<Value>().await.unwrap()["approval_scope"],"policy");
    }
    let stored = allow(&s).await;
    assert_eq!(stored["effective"],"read, write");
    assert_eq!(stored["layers"]["server"]["revision"],2);
    finished(&s,&call).await;
    s.restart().await;
    let other = s.create_project("other").await;
    let session = s.create_session(other["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap();
    let next = write(&s,sid,"second.txt").await;
    assert_eq!(next["status"],"approved");
    assert_eq!(next["approval_scope"],"policy");
    finished(&s,&next).await;
    setting(&s,"server","-","tools.allow",2,json!("read")).await;
    assert_eq!(write(&s,sid,"third.txt").await["status"],"pending_approval");
}

#[tokio::test]
async fn stale_revision_and_new_restrictions_cannot_save_always_approval() {
    let s = TestServer::start().await;
    let p = s.create_project("blocked").await;
    let pid = p["id"].as_str().unwrap();
    let session = s.create_session(pid).await;
    let call = write(&s,session["id"].as_str().unwrap(),"blocked.txt").await;
    let path = format!("/api/v1/tool-calls/{}/decision",call["id"].as_str().unwrap());
    let (status, _) = s.post(&path,json!({"decision":"approve_always","expected_revision":99})).await;
    assert_eq!(status,StatusCode::CONFLICT);
    assert_eq!(allow(&s).await["effective"],"");
    setting(&s,"project",pid,"tools.deny",0,json!("write")).await;
    let (status, body) = s.post(&path,json!({"decision":"approve_always","expected_revision":call["revision"]})).await;
    assert_eq!(status,StatusCode::CONFLICT,"{body}");
    assert_eq!(body["error"]["code"],"policy_denied");
    assert_eq!(allow(&s).await["effective"],"");
    assert!(!std::path::Path::new(p["root_path"].as_str().unwrap()).join("blocked.txt").exists());
}

#[tokio::test]
async fn bypass_is_default_but_deny_still_wins() {
    let s = TestServer::start_default_permissions().await;
    let p = s.create_project("bypass").await;
    let pid = p["id"].as_str().unwrap().to_string();
    let session = s.create_session(&pid).await;
    let sid = session["id"].as_str().unwrap().to_string();
    let (_, registry) = s.get("/api/v1/settings/registry").await;
    let mode = registry.as_array().unwrap().iter().find(|item| item["key"] == "tools.mode").unwrap();
    assert_eq!(mode["default"], "bypass");
    assert_eq!(mode["options"], json!(["ask","bypass"]));
    for scope in ["server/-".to_owned(), format!("project/{pid}"), format!("session/{sid}")] {
        let (status, body) = s.send(Method::PUT, &format!("/api/v1/settings/{scope}/tools.mode"),
            json!({"expected_revision":0,"value":"read_only"})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
    let call = write(&s,&sid,"allowed.txt").await;
    assert_eq!(call["status"],"approved");
    assert_eq!(call["approval_scope"],"policy");
    finished(&s,&call).await;
    let (status, blocked_fetch) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"),
        json!({"name":"web_fetch","args":{"url":"http://127.0.0.1"}})).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(blocked_fetch["result"]["error"]["code"], "blocked_address");
    assert!(blocked_fetch["started_at"].is_null());
    // 네트워크·셸은 계획까지만 검사하고 rollback하여 외부 부작용을 만들지 않는다.
    let root = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
    let (plan_pid,plan_sid) = (pid.clone(),sid.clone());
    s.server.as_ref().unwrap().app.db.call(move |c| {
        let tx = c.transaction()?;
        for (name,args) in [("web_fetch",json!({"url":"https://example.com"})),
            ("shell",json!({"command":"echo fixture"}))] {
            let call = grove::approvals::create_call(&tx,"2026-01-01T00:00:00Z",1800,&plan_sid,&plan_pid,&root,None,None,name,&args)?;
            assert_eq!(call.status,"approved","{call:?}");
            assert_eq!(call.approval_scope.as_deref(),Some("policy"));
            let spec = grove::tools::spec(name).unwrap();
            assert_eq!(grove::approvals::tool_policy(&tx,&plan_pid,&plan_sid,&spec)?,grove::approvals::PolicyDecision::Allow);
        }
        Ok(())
    }).await.unwrap();
    setting(&s,"project",&pid,"tools.deny",0,json!("write")).await;
    let blocked = write(&s,&sid,"denied.txt").await;
    assert_eq!(blocked["result"]["error"]["code"],"policy_denied");
    assert_eq!(allow(&s).await["effective"],"");
}

#[tokio::test]
async fn queued_web_fetch_does_not_execute_after_bypass_or_permanent_allow_is_revoked() {
    let s = TestServer::start().await;
    let p = s.create_project("revoke-fetch").await;
    let session = s.create_session(p["id"].as_str().unwrap()).await;
    for (key, enabled, disabled) in [("tools.mode",json!("bypass"),json!("ask")),
        ("tools.allow",json!("web_fetch"),json!(""))] {
        let revision = if key == "tools.mode" { 1 } else { 0 };
        setting(&s,"server","-",key,revision,enabled).await;
        let pid = p["id"].as_str().unwrap().to_string();
        let sid = session["id"].as_str().unwrap().to_string();
        let root = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
        let app = &s.server.as_ref().unwrap().app;
        let call = app.db.call(move |c| {
            let tx = c.transaction()?;
            let call = grove::approvals::create_call(&tx,"2026-01-01T00:00:00Z",1800,&sid,&pid,&root,
                None,None,"web_fetch",&json!({"url":"https://example.com"}))?;
            tx.commit()?;
            Ok(call)
        }).await.unwrap();
        assert_eq!(call.status,"approved");
        assert_eq!(call.approval_scope.as_deref(),Some("policy"));
        setting(&s,"server","-",key,revision + 1,disabled).await;
        grove::approvals::spawn_execute(app,call.id.clone());
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let (_, current) = s.get(&format!("/api/v1/tool-calls/{}",call.id)).await;
            if current["status"] == "failed" {
                assert_eq!(current["result"]["error"]["code"],"approval_revoked");
                assert!(current["started_at"].is_null());
                break;
            }
            assert!(tokio::time::Instant::now() < deadline,"{current}");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }
}
