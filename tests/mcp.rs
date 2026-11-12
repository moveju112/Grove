mod common;

use common::TestServer;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

fn stdio(name: &str) -> Value {
    json!({ "name": name, "config": { "transport": "stdio", "command": "mcp-fixture", "args": ["--flag"], "env_secrets": {} } })
}

#[tokio::test]
async fn settings_crud_replay_conflict_and_restart_do_not_connect() {
    let mut s = TestServer::start().await;
    let mut body = stdio(" EXAMPLE ");
    let key = s.key();
    let r = s.raw(Method::POST, "/api/v1/mcp/servers", Some(body.clone()), Some(&key), None).await;
    assert_eq!(r.status(), StatusCode::CREATED);
    let created: Value = r.json().await.unwrap();
    assert_eq!(created["name"], "example");
    assert_eq!(created["connection_state"], "disabled");
    body["name"] = json!("example");
    let r = s.raw(Method::POST, "/api/v1/mcp/servers", Some(body.clone()), Some(&key), None).await;
    assert_eq!(r.status(), StatusCode::CREATED);
    assert_eq!(r.headers()["idempotent-replayed"], "true");
    assert_eq!(r.json::<Value>().await.unwrap(), created);
    body["name"] = json!("different");
    let r = s.raw(Method::POST, "/api/v1/mcp/servers", Some(body.clone()), Some(&key), None).await;
    assert_eq!(r.status(), StatusCode::CONFLICT);
    body["name"] = json!("example");
    assert_eq!(s.post("/api/v1/mcp/servers", body.clone()).await.0, StatusCode::CONFLICT);
    body["enabled"] = json!(true);
    let path = format!("/api/v1/mcp/servers/{}", created["id"].as_str().unwrap());
    let update = json!({ "expected_revision": 1, "server": body });
    let (status, enabled) = s.send(Method::PUT, &path, update.clone()).await;
    assert_eq!(status, StatusCode::OK, "{enabled}");
    assert_eq!(enabled["connection_state"], "disconnected");
    assert_eq!(enabled["revision"], 2);
    let (status, conflict) = s.send(Method::PUT, &path, update).await;
    assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
    assert_eq!(conflict["error"]["details"]["current"], enabled);
    let mut invalid = stdio("example");
    invalid["config"]["env_secrets"] = json!({ "TOKEN": "missing" });
    assert_eq!(s.send(Method::PUT, &path, json!({ "expected_revision": 2, "server": invalid })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(s.get("/api/v1/mcp/servers").await.1, json!([enabled.clone()]));
    s.restart().await;
    assert_eq!(s.get("/api/v1/mcp/servers").await.1, json!([enabled]));
    let (status, _) = s.send(Method::DELETE, &format!("{path}?expected_revision=1"), Value::Null).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let delete = format!("{path}?expected_revision=2");
    let key = s.key();
    for _ in 0..2 {
        assert_eq!(s.raw(Method::DELETE, &delete, None, Some(&key), None).await.status(), StatusCode::OK);
    }
    assert_eq!(s.get("/api/v1/mcp/servers").await.1, json!([]));
}

#[tokio::test]
async fn config_validation_rejects_invalid_transports_credentials_and_references_atomically() {
    let s = TestServer::start().await;
    let invalid = [
        json!({ "transport": "unknown" }),
        json!({ "transport": "stdio", "command": "" }),
        json!({ "transport": "stdio", "command": "bad\ncommand" }),
        json!({ "transport": "stdio", "command": "server", "args": ["bad\u{0000}arg"] }),
        json!({ "transport": "stdio", "command": "server", "env": { "TOKEN": "plaintext" } }),
        json!({ "transport": "stdio", "command": "server", "env_secrets": { "1BAD": "missing" } }),
        json!({ "transport": "stdio", "command": "server", "env_secrets": { "TOKEN": "missing" } }),
        json!({ "transport": "http", "endpoint": "file:///tmp/server" }),
        json!({ "transport": "http", "endpoint": "https://user:password@example.com/mcp" }),
        json!({ "transport": "http", "endpoint": "https://example.com/mcp?key=value" }),
        json!({ "transport": "http", "endpoint": "https://example.com/mcp#secret" }),
        json!({ "transport": "http", "endpoint": "https://example.com", "headers": { "Authorization": "plaintext" } }),
        json!({ "transport": "http", "endpoint": "https://example.com", "header_secrets": { "Host": "missing" } }),
        json!({ "transport": "http", "endpoint": "https://example.com", "header_secrets": { "Bad\nName": "missing" } }),
    ];
    for config in invalid {
        let (status, error) = s.post("/api/v1/mcp/servers", json!({ "name": "invalid", "config": config })).await;
        assert!(status.is_client_error(), "{status}: {error}");
    }
    for name in ["../path", "__proto__", "constructor", "prototype", "bad name"] {
        assert_eq!(s.post("/api/v1/mcp/servers", stdio(name)).await.0, StatusCode::BAD_REQUEST);
    }
    let mut body = stdio("bad-timeout");
    for timeout in [0, 301] {
        body["timeout_secs"] = json!(timeout);
        assert_eq!(s.post("/api/v1/mcp/servers", body.clone()).await.0, StatusCode::BAD_REQUEST);
    }
    assert_eq!(s.get("/api/v1/mcp/servers").await.1, json!([]));
}

#[tokio::test]
async fn secret_refs_are_redacted_from_events_and_protect_vault_until_removed() {
    let s = TestServer::start().await;
    const SECRET: &str = "Bearer fixture-mcp-private-value";
    let (_, secret) = s.post("/api/v1/secrets", json!({ "label": "MCP auth", "value": SECRET })).await;
    let id = secret["id"].as_str().unwrap();
    for transport in ["stdio", "http", "sse"] {
        let config = if transport == "stdio" {
            json!({ "transport": transport, "command": "fixture", "env_secrets": { "TOKEN": id } })
        } else {
            json!({ "transport": transport, "endpoint": "https://example.com/mcp", "header_secrets": { "Authorization": id } })
        };
        let body = json!({ "name": transport, "config": config });
        let (status, v) = s.post("/api/v1/mcp/servers", body).await;
        assert_eq!(status, StatusCode::CREATED, "{v}");
        assert!(!v.to_string().contains(SECRET));
        if transport != "stdio" { assert_eq!(v["config"]["header_secrets"]["authorization"], id); }
        let path = format!("/api/v1/secrets/{id}");
        let (status, error) = s.send(Method::DELETE, &path, Value::Null).await;
        assert_eq!(status, StatusCode::CONFLICT, "{error}");
        assert!(error["error"]["details"]["used_by"].as_array().unwrap().contains(&json!(format!("MCP: {transport}"))));
        assert_eq!(s.send(Method::DELETE, &format!("/api/v1/mcp/servers/{}?expected_revision=1", v["id"].as_str().unwrap()), Value::Null).await.0, StatusCode::OK);
    }
    let c = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    for table in ["mcp_servers", "events", "idempotency", "audit"] {
        // 비밀 원문은 암호화 vault 밖으로 복제되지 않는다.
        let sql = match table {
            "mcp_servers" => "SELECT config FROM mcp_servers",
            "events" => "SELECT payload FROM events WHERE kind='mcp.changed'",
            "idempotency" => "SELECT response FROM idempotency",
            _ => "SELECT detail FROM audit_log",
        };
        let mut st = c.prepare(sql).unwrap();
        for text in st.query_map([], |r| r.get::<_, String>(0)).unwrap() {
            assert!(!text.unwrap().contains(SECRET));
        }
    }
    assert_eq!(s.send(Method::DELETE, &format!("/api/v1/secrets/{id}"), Value::Null).await.0, StatusCode::OK);
}

#[tokio::test]
async fn owner_required_for_listing_and_all_mutations() {
    let s = TestServer::start().await;
    let (_, v) = s.post("/api/v1/devices", json!({ "name": "mcp-device" })).await;
    let token = v["token"].as_str().unwrap();
    let (_, server) = s.post("/api/v1/mcp/servers", stdio("owner")).await;
    let path = format!("/api/v1/mcp/servers/{}", server["id"].as_str().unwrap());
    for (method, path, body) in [
        (Method::GET, "/api/v1/mcp/servers".into(), None),
        (Method::POST, "/api/v1/mcp/servers".into(), Some(stdio("device"))),
        (Method::PUT, path.clone(), Some(json!({ "expected_revision": 1, "server": stdio("changed") }))),
        (Method::DELETE, format!("{path}?expected_revision=1"), None),
    ] {
        assert_eq!(s.raw(method.clone(), &path, body.clone(), Some(&s.key()), Some(token)).await.status(), StatusCode::FORBIDDEN);
        assert_eq!(s.raw(method, &path, body, Some(&s.key()), Some("")).await.status(), StatusCode::UNAUTHORIZED);
    }
}
