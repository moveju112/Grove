//! 실제 HTTP·격리 DB를 통한 hook 설정 회귀. 명령 실행기는 연결하지 않는다.
mod common;
use common::TestServer;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

fn definition(name: &str, command: &str) -> Value {
    json!({"name":name,"event":"PreToolUse","matcher":"shell*","command":command,"enabled":true})
}
fn update(hook: &Value, revision: i64) -> Value {
    json!({"name":hook["name"],"event":hook["event"],"matcher":hook["matcher"],
        "enabled":false,"expected_revision":revision})
}
async fn remove(s: &TestServer, path: &str, revision: i64) -> (StatusCode, Value) {
    s.send(Method::DELETE, &format!("{path}?expected_revision={revision}"), json!({})).await
}

#[tokio::test]
async fn crud_is_persistent_revisioned_idempotent_and_does_not_execute() {
    let mut s = TestServer::start().await;
    let marker = s.dir.path().join("hook-must-not-run");
    let command = format!("printf executed > '{}'", marker.display());
    let body = definition("safe hook", &command);
    let first = s.raw(Method::POST, "/api/v1/hooks", Some(body.clone()), Some("create-hook"), None).await;
    assert_eq!(first.status(), StatusCode::CREATED);
    let hook: Value = first.json().await.unwrap();
    assert_eq!(hook["execution_state"], "not_implemented");
    // TMPDIR에 긴 불투명 경로가 있으면 응답이 보수적으로 가려질 수 있다.
    let stored_id = hook["id"].as_str().unwrap().to_string();
    let stored: String = s.server.as_ref().unwrap().app.db.call(move |c| {
        Ok(c.query_row("SELECT command FROM hook_definitions WHERE id=?1", [stored_id], |r| r.get(0))?)
    }).await.unwrap();
    assert_eq!(stored, command);
    assert_eq!(hook["enabled"], true);
    assert_eq!(hook["project_id"], Value::Null);
    let replay = s.raw(Method::POST, "/api/v1/hooks", Some(body.clone()), Some("create-hook"), None).await;
    assert_eq!(replay.status(), StatusCode::CREATED);
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    assert_eq!(replay.json::<Value>().await.unwrap(), hook);
    let mut different = body;
    different["matcher"] = json!("other*");
    assert_eq!(s.raw(Method::POST, "/api/v1/hooks", Some(different), Some("create-hook"), None).await.status(), StatusCode::CONFLICT);
    let (_, list) = s.get("/api/v1/hooks").await;
    assert_eq!(list["hooks"].as_array().unwrap().len(), 1);
    assert_eq!(list["matcher_syntax"], "glob");
    assert!(list["events"].as_array().unwrap().contains(&json!("PreToolUse")));
    let path = format!("/api/v1/hooks/{}", hook["id"].as_str().unwrap());
    let mut edit = update(&hook, 1);
    edit["name"] = json!("renamed hook");
    edit["matcher"] = json!("file_*");
    edit["event"] = json!("PostToolUse");
    let (status, edited) = s.send(Method::PUT, &path, edit.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(edited["revision"], 2);
    assert_eq!(edited["enabled"], false);
    assert_eq!(edited["command"], hook["command"], "명령 생략은 같은 표시와 원문 유지");
    assert_eq!(edited["event"], "PostToolUse");
    assert_eq!(edited["matcher"], "file_*");
    assert_eq!(s.send(Method::PUT, &path, edit).await.0, StatusCode::CONFLICT);
    assert_eq!(remove(&s, &path, 1).await.0, StatusCode::CONFLICT);
    s.restart().await;
    let (_, list) = s.get("/api/v1/hooks").await;
    assert_eq!(list["hooks"], json!([edited]));
    let mut replace = update(&edited, 2);
    replace["command"] = json!("printf replacement");
    let (status, replaced) = s.send(Method::PUT, &path, replace).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replaced["command"], "printf replacement");
    let deleted = s.raw(Method::DELETE, &format!("{path}?expected_revision=3"), None, Some("delete-hook"), None).await;
    assert_eq!(deleted.status(), StatusCode::OK);
    let replay = s.raw(Method::DELETE, &format!("{path}?expected_revision=3"), None, Some("delete-hook"), None).await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    assert_eq!(s.get("/api/v1/hooks").await.1["hooks"], json!([]));
    assert!(!marker.exists(), "저장·활성화·재시작·편집은 명령을 실행하지 않는다");
}

#[tokio::test]
async fn project_scope_owner_permissions_and_authentication_are_enforced() {
    let s = TestServer::start().await;
    let a = s.create_project("hooks-a").await;
    let b = s.create_project("hooks-b").await;
    let aid = a["id"].as_str().unwrap();
    let bid = b["id"].as_str().unwrap();
    let create = format!("/api/v1/hooks?project_id={aid}");
    let (status, hook) = s.post(&create, definition("local", "printf local")).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(hook["project_id"], aid);
    assert_eq!(s.get("/api/v1/hooks").await.1["hooks"], json!([]));
    assert_eq!(s.get(&format!("/api/v1/hooks?project_id={bid}")).await.1["hooks"], json!([]));
    let base = format!("/api/v1/hooks/{}", hook["id"].as_str().unwrap());
    for query in [String::new(), format!("?project_id={bid}")] {
        assert_eq!(s.send(Method::PUT, &format!("{base}{query}"), update(&hook, 1)).await.0, StatusCode::NOT_FOUND);
    }
    assert_eq!(s.send(Method::DELETE, &format!("{base}?project_id={bid}&expected_revision=1"), json!({})).await.0, StatusCode::NOT_FOUND);
    assert_eq!(s.get("/api/v1/hooks?project_id=missing").await.0, StatusCode::NOT_FOUND);
    assert_eq!(s.post("/api/v1/hooks?project_id=missing", definition("bad scope", "true")).await.0, StatusCode::NOT_FOUND);
    assert_eq!(s.raw(Method::GET, &create, None, None, Some("")).await.status(), StatusCode::UNAUTHORIZED);
    let (_, device) = s.post("/api/v1/devices", json!({"name":"hooks-device"})).await;
    let token = device["token"].as_str().unwrap();
    for path in ["/api/v1/hooks", &create] {
        assert_eq!(s.raw(Method::GET, path, None, None, Some(token)).await.status(), StatusCode::FORBIDDEN);
        assert_eq!(s.raw(Method::POST, path, Some(definition("denied", "true")), Some("device-hook"), Some(token)).await.status(), StatusCode::FORBIDDEN);
    }
    let local = format!("{base}?project_id={aid}");
    assert_eq!(s.raw(Method::PUT, &local, Some(update(&hook, 1)), Some("device-update"), Some(token)).await.status(), StatusCode::FORBIDDEN);
    assert_eq!(s.raw(Method::DELETE, &format!("{local}&expected_revision=1"), None, Some("device-delete"), Some(token)).await.status(), StatusCode::FORBIDDEN);
    assert_eq!(s.send(Method::PUT, &local, update(&hook, 1)).await.0, StatusCode::OK);
    assert_eq!(s.get(&create).await.1["hooks"][0]["revision"], 2);
    assert_eq!(s.send(Method::DELETE, &format!("{local}&expected_revision=2"), json!({})).await.0, StatusCode::OK);
}

#[tokio::test]
async fn invalid_matcher_event_and_command_never_change_the_saved_definition() {
    let s = TestServer::start().await;
    let (_, hook) = s.post("/api/v1/hooks", definition("valid", "printf valid")).await;
    let path = format!("/api/v1/hooks/{}", hook["id"].as_str().unwrap());
    for (field, invalid) in [
        ("matcher", json!("[")), ("matcher", json!("")), ("matcher", json!("bad\nmatcher")),
        ("event", json!("ArbitraryEvent")), ("command", json!("")), ("command", json!("a\0b")),
        ("name", json!("")), ("expected_revision", json!(0)),
    ] {
        let mut body = update(&hook, 1);
        body[field] = invalid;
        let (status, _) = s.send(Method::PUT, &path, body).await;
        assert_eq!(status, if field == "expected_revision" { StatusCode::CONFLICT } else { StatusCode::BAD_REQUEST }, "{field}");
    }
    let mut invalid = definition("bad", "true");
    invalid["matcher"] = json!("[");
    assert_eq!(s.post("/api/v1/hooks", invalid).await.0, StatusCode::BAD_REQUEST);
    let (_, list) = s.get("/api/v1/hooks").await;
    assert_eq!(list["hooks"], json!([hook]));
}

#[tokio::test]
async fn command_secrets_stay_in_storage_but_not_responses_conflicts_receipts_events_or_audit() {
    let s = TestServer::start().await;
    // 인공 fixture일 뿐 실제 자격증명이 아니다.
    let secret = "hooks-fixture-private";
    let command = format!("TOKEN='{secret}' printf retained");
    let body = definition("redacted hook", &command);
    let response = s.raw(Method::POST, "/api/v1/hooks", Some(body.clone()), Some("secret-hook"), None).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let hook: Value = response.json().await.unwrap();
    assert_eq!(hook["command"], "[redacted]");
    assert_eq!(hook["command_redacted"], true);
    let id = hook["id"].as_str().unwrap().to_string();
    let path = format!("/api/v1/hooks/{id}");
    assert_eq!(s.send(Method::PUT, &path, update(&hook, 1)).await.0, StatusCode::OK);
    let (status, conflict) = s.send(Method::PUT, &path, update(&hook, 1)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["error"]["details"]["current"]["command"], "[redacted]");
    assert!(!conflict.to_string().contains(secret));
    let list = s.get("/api/v1/hooks").await.1;
    assert!(!list.to_string().contains(secret));
    let replay = s.raw(Method::POST, "/api/v1/hooks", Some(body), Some("secret-hook"), None).await;
    assert!(!replay.text().await.unwrap().contains(secret));
    let db = &s.server.as_ref().unwrap().app.db;
    let stored: String = db.call(move |c| Ok(c.query_row("SELECT command FROM hook_definitions WHERE id=?1", [id], |r| r.get(0))?)).await.unwrap();
    assert_eq!(stored, command, "가려진 상태를 저장 원문에 덮어쓰지 않는다");
    let evidence: Vec<String> = db.call(|c| {
        let mut values = Vec::new();
        for sql in ["SELECT response FROM idempotency", "SELECT payload FROM events WHERE kind='hook.changed'", "SELECT detail FROM audit_log WHERE action LIKE 'hook.%'"] {
            values.extend(c.prepare(sql)?.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?);
        }
        Ok(values)
    }).await.unwrap();
    assert!(evidence.iter().all(|v| !v.contains(secret)));
}

#[tokio::test]
async fn credential_forms_are_conservatively_hidden_and_plain_commands_roundtrip_verbatim() {
    let s = TestServer::start().await;
    for command in [
        "PASSWORD='hooks fixture with spaces' printf ready",
        "curl -H 'Authorization: Bearer hooks-fixture' https://example.invalid",
        "curl https://fixture:hooks-fixture@example.invalid",
        "KEY=hooks-fixture printf ready",
        "curl -u fixture:hooks-fixture https://example.invalid",
        "printf sk-hooks-fixture",
    ] {
        let (status, hook) = s.post("/api/v1/hooks", definition("credential fixture", command)).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(hook["command"], "[redacted]");
        assert_eq!(hook["command_redacted"], true);
    }
    let command = "  printf 'literal; | $HOME'\n# kept as written\n";
    let (status, hook) = s.post("/api/v1/hooks", definition("plain fixture", command)).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(hook["command"], command);
    assert_eq!(hook["command_redacted"], false);
}
