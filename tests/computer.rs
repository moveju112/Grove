//! 실제 화면을 건드리지 않는 PC 제어의 승인·대화·CLI 연결 경계 검사.
mod common;
use common::{
    TestServer,
    fixture::{Fixture, Step},
};
use grove::{App, computer::bridge::Bridge};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::watch;

async fn enable(s: &TestServer, revision: i64, value: bool) {
    let (st, v) = s
        .send(
            Method::PUT,
            "/api/v1/settings/server/-/computer.enabled",
            json!({"expected_revision":revision,"value":value}),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
}
async fn session(s: &TestServer) -> String {
    let p = s.create_project("computer").await;
    s.create_session(p["id"].as_str().unwrap()).await["id"]
        .as_str()
        .unwrap()
        .into()
}
async fn request(s: &TestServer, sid: &str, args: Value) -> Value {
    let (st, v) = s
        .post(
            &format!("/api/v1/sessions/{sid}/tool-requests"),
            json!({"name":"computer","args":args}),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    v
}
async fn running(s: &TestServer, sid: &str, f: &Fixture) -> String {
    let profile = s.fixture_profile(&f.base).await;
    f.push(Step::Hang(vec![]));
    let (st, v) = s
        .post(
            &format!("/api/v1/sessions/{sid}/turns"),
            json!({"profile_id":profile,"text":"isolated computer bridge test"}),
        )
        .await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    s.wait_status(&tid, "running").await;
    tid
}
async fn pending(app: &App, tid: &str) -> grove::approvals::ToolCallRow {
    let mut events = app.seq_tx.subscribe();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let tid = tid.to_string();
            let calls = app
                .db
                .call(move |c| grove::approvals::list_for_turn(c, &tid))
                .await
                .unwrap();
            if let Some(c) = calls.into_iter().find(|c| c.name == "computer") {
                return c;
            }
            events.changed().await.unwrap();
        }
    })
    .await
    .expect("approval receipt")
}
fn link(bridge: &Bridge) -> Value {
    serde_json::from_slice(&std::fs::read(&bridge.link.file).unwrap()).unwrap()
}

#[tokio::test]
async fn default_off_owner_only_and_exact_once_approval_even_with_allow_policy() {
    let s = TestServer::start().await;
    let sid = session(&s).await;
    let (st, status) = s.get("/api/v1/computer/status").await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(status["enabled"], false);
    assert_eq!(status["target"], "server");
    assert_eq!(status["platform"],std::env::consts::OS);
    assert_eq!(status["backend"],match std::env::consts::OS{
        "windows"=>"win32_window_messages","linux"=>"x11_window_messages",_=>"unsupported",
    });
    let call = request(&s, &sid, json!({"target":"server","action":"list"})).await;
    assert_eq!(call["status"], "failed");
    assert_eq!(call["result"]["error"]["code"], "computer_disabled");
    let (_, device) = s.post("/api/v1/devices", json!({"name":"phone"})).await;
    let token = device["token"].as_str().unwrap();
    let response = s
        .raw(
            Method::PUT,
            "/api/v1/settings/server/-/computer.enabled",
            Some(json!({"expected_revision":0,"value":true})),
            Some("device-enable"),
            Some(token),
        )
        .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    enable(&s, 0, true).await;
    // 도구 allow 정책도 PC 전체에 대한 포괄 승인으로 해석하지 않는다.
    let (st, v) = s
        .send(
            Method::PUT,
            "/api/v1/settings/server/-/tools.allow",
            json!({"expected_revision":0,"value":"computer"}),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let call = request(&s, &sid, json!({"target":"server","action":"list"})).await;
    assert_eq!(call["status"], "pending_approval");
    assert_eq!(call["needs_approval"], true);
    let id = call["id"].as_str().unwrap();
    let (st, _) = s
        .post(
            &format!("/api/v1/tool-calls/{id}/decision"),
            json!({"expected_revision":call["revision"],"decision":"approve_session"}),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = s
        .post(
            &format!("/api/v1/tool-calls/{id}/decision"),
            json!({"expected_revision":call["revision"],"decision":"deny"}),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
}

#[tokio::test]
async fn disable_reenable_invalidates_pending_requests_and_invalid_input_never_runs() {
    let s = TestServer::start().await;
    let sid = session(&s).await;
    enable(&s, 0, true).await;
    let call = request(&s, &sid, json!({"target":"server","action":"list"})).await;
    enable(&s, 1, false).await;
    enable(&s, 2, true).await;
    let app = &s.server.as_ref().unwrap().app;
    let id = call["id"].as_str().unwrap().to_string();
    let call = app
        .db
        .call(move |c| grove::approvals::get(c, &id))
        .await
        .unwrap();
    let err = app
        .db
        .call(move |c| grove::computer::validate_call(c, &call))
        .await
        .unwrap_err();
    assert_eq!(err.code, "computer_permission_changed");
    for args in [
        json!({"target":"phone","action":"list"}),
        json!({"target":"server","action":"act","window_id":"42","frame_id":"fake","actions":[{"type":"shell","command":"no"}]}),
    ] {
        assert_eq!(request(&s, &sid, args).await["status"], "failed");
    }
}

#[tokio::test]
async fn cli_bridge_is_turn_scoped_authenticated_origin_blocked_and_replays_only_receipts() {
    let s = TestServer::start().await;
    let sid = session(&s).await;
    let f = Fixture::start().await;
    let tid = running(&s, &sid, &f).await;
    let app = &s.server.as_ref().unwrap().app;
    let (tx, rx) = watch::channel(false);
    assert!(
        Bridge::start(app, &tid, &sid, rx.clone())
            .await
            .unwrap()
            .is_none()
    );
    enable(&s, 0, true).await;
    let bridge = Bridge::start(app, &tid, &sid, rx).await.unwrap().unwrap();
    let config = link(&bridge);
    let url = config["url"].as_str().unwrap();
    let token = config["token"].as_str().unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let body = json!({"request_id":"one","arguments":{"target":"server","action":"list"}});
    assert_eq!(
        client.post(url).json(&body).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .post(url)
            .bearer_auth(token)
            .header("Origin", "https://example.test")
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let request = client.post(url).bearer_auth(token).json(&body);
    let result = tokio::spawn(async move { request.send().await.unwrap() });
    let call = pending(app, &tid).await;
    assert_eq!(call.status, "pending_approval");
    s.post(
        &format!("/api/v1/tool-calls/{}/decision", call.id),
        json!({"expected_revision":call.revision,"decision":"deny"}),
    )
    .await;
    let value: Value = result.await.unwrap().json().await.unwrap();
    assert_eq!(value["isError"], true);
    let replay: Value = client
        .post(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(replay, value);
    let turn = tid.clone();
    assert_eq!(
        app.db
            .call(move |c| grove::approvals::list_for_turn(c, &turn))
            .await
            .unwrap()
            .len(),
        1
    );
    let mut changed = body.clone();
    changed["arguments"]["action"] = json!("capture");
    changed["arguments"]["window_id"] = json!("42");
    assert_eq!(
        client
            .post(url)
            .bearer_auth(token)
            .json(&changed)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    tx.send_replace(true);
    assert_eq!(
        client
            .post(url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    let file = bridge.link.file.clone();
    drop(bridge);
    assert!(!file.exists());
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({}))
        .await;
}

#[tokio::test]
async fn cli_images_are_supported_but_grove_tool_loop_remains_separate() {
    let s = TestServer::start().await;
    for protocol in ["codex_cli", "claude_code"] {
        let (st, p) = s
            .post(
                "/api/v1/model-profiles",
                json!({"name":protocol,"protocol":protocol,"base_url":"","model":"default"}),
            )
            .await;
        assert_eq!(st, StatusCode::CREATED, "{p}");
        assert_eq!(p["capabilities"]["images"], true);
        assert_eq!(p["capabilities"]["native_tools"], true);
        assert_eq!(p["capabilities"]["tools"], false);
    }
}

#[tokio::test]
async fn dropping_a_cli_bridge_cancels_pending_approvals_without_dispatch(){
    let s=TestServer::start().await;let sid=session(&s).await;let f=Fixture::start().await;
    let tid=running(&s,&sid,&f).await;let app=&s.server.as_ref().unwrap().app;enable(&s,0,true).await;
    let(_tx,rx)=watch::channel(false);
    let bridge=Bridge::start(app,&tid,&sid,rx).await.unwrap().unwrap();
    let config=link(&bridge);
    let request=s.client.post(config["url"].as_str().unwrap()).bearer_auth(config["token"].as_str().unwrap())
        .json(&json!({"request_id":"pending-stop","arguments":{"target":"server","action":"list"}}));
    let response=tokio::spawn(async move{request.send().await});
    let call=pending(app,&tid).await;assert_eq!(call.status,"pending_approval");
    let mut events=app.seq_tx.subscribe();
    drop(bridge);
    tokio::time::timeout(Duration::from_secs(5),async{
        loop {
            let id=call.id.clone();
            let current=app.db.call(move|c|grove::approvals::get(c,&id)).await.unwrap();
            if current.status=="cancelled"{assert!(current.started_at.is_none());break;}
            events.changed().await.unwrap();
        }
    }).await.unwrap();
    if let Ok(response)=response.await.unwrap(){assert_eq!(response.status(),StatusCode::CONFLICT);}
    s.post(&format!("/api/v1/turns/{tid}/cancel"),json!({})).await;
}

#[test]
fn native_worker_cannot_be_called_directly_by_an_unapproved_cli() {
    use std::io::Write;
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_grove"))
        .arg("computer-worker")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"command":{"target":"server","action":"list"}}"#)
        .unwrap();
    let out = child.wait_with_output().unwrap();
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["error"]["code"], "computer_permission_denied");
}

#[test]
fn computer_mcp_negotiates_stdio_and_lists_only_the_scoped_tool() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("link.json");
    std::fs::write(
        &file,
        br#"{"url":"http://127.0.0.1:9/","token":"fixture-with-no-authority"}"#,
    )
    .unwrap();
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_grove"))
        .arg("computer-mcp")
        .arg(file)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\"}}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n").unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let messages = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["result"]["protocolVersion"], "2024-11-05");
    assert_eq!(messages[1]["result"]["tools"].as_array().unwrap().len(), 1);
    assert_eq!(messages[1]["result"]["tools"][0]["name"], "computer");
}
