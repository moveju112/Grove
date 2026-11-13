mod common;
#[path = "common/e2ee.rs"]
mod wire;

use common::*;
use serde_json::{Value, json};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use wire::Channel;

#[tokio::test]
async fn encrypted_login_api_idempotency_and_stream_preserve_existing_contracts() {
    let server = TestServer::start().await;
    let mut c = Channel::open(&server, None, Some("https://grove.choondoggy.com")).await;
    let meta = c.request("POST", "/api/v1/auth/browser-login",
        vec![("content-type", "application/json".into())],
        json!({ "token": server.token, "name": "encrypted-browser" })).await;
    assert_eq!(meta["status"], 200);
    let headers = meta["headers"].as_array().unwrap();
    assert!(headers.iter().any(|h| h[0] == "set-cookie" && h[1].as_str().unwrap().contains("HttpOnly")));
    let login: Value = serde_json::from_slice(&c.body().await).unwrap();
    let token = login["access_token"].as_str().unwrap();
    let root = server.make_project_dir("encrypted");
    let mut id = Value::Null;
    for _ in 0..2 {
        let mut c = Channel::open(&server, None, None).await;
        let meta = c.request("POST", "/api/v1/projects", vec![
            ("authorization", format!("Bearer {token}")), ("content-type", "application/json".into()),
            ("idempotency-key", "encrypted-project".into()),
        ], json!({ "root_path": root })).await;
        assert_eq!(meta["status"], 201);
        let project: Value = serde_json::from_slice(&c.body().await).unwrap();
        if id.is_null() { id = project["id"].clone(); } else { assert_eq!(id, project["id"]); }
    }
    let mut c = Channel::open(&server, None, None).await;
    let meta = c.request("GET", "/api/v1/events", vec![("authorization", format!("Bearer {token}"))], Value::Null).await;
    assert_eq!(meta["status"], 200);
    let frame = c.receive().await;
    assert_eq!(frame[0], 1);
    assert!(String::from_utf8_lossy(&frame[1..]).contains("event: hello"));
    c.socket.close(None).await.unwrap();
}

#[tokio::test]
async fn external_plaintext_and_spoofed_proxy_headers_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(&dir.path().join("data"));
    cfg.tls_terminated = true;
    cfg.allowed_hosts = vec!["grove.example".into()];
    let server = TestServer::start_with(dir, cfg).await;
    let response = server.client.post(format!("{}/api/v1/auth/browser-login", server.base))
        .header("host", "grove.example").header("x-forwarded-proto", "https")
        .header("x-grove-e2ee-bridge", "forged").json(&json!({ "token": server.token, "name": "plain" })).send().await.unwrap();
    assert_eq!(response.status(), 426);
    let mut c = Channel::open(&server, Some("grove.example"), Some("https://grove.choondoggy.com")).await;
    let meta = c.request("GET", "/api/v1/projects", vec![("authorization", format!("Bearer {}", server.token))], Value::Null).await;
    assert_eq!(meta["status"], 200);
    assert_eq!(serde_json::from_slice::<Value>(&c.body().await).unwrap(), json!([]));
}

#[tokio::test]
async fn unauthorized_origin_plaintext_frames_tampering_and_replay_fail_closed() {
    let server = TestServer::start().await;
    let mut request = format!("{}/api/e2ee", server.base.replace("http:", "ws:")).into_client_request().unwrap();
    request.headers_mut().insert("origin", "https://attacker.invalid".parse().unwrap());
    assert!(tokio_tungstenite::connect_async(request).await.is_err());
    for kind in ["plain", "tampered", "replay"] {
        let mut c = Channel::open(&server, None, None).await;
        let bytes = json!({ "kind": "http", "method": "GET", "path": "/api/v1/health" }).to_string();
        let mut sealed = c.seal(bytes.as_bytes());
        if kind == "tampered" { sealed[0] ^= 1; }
        let message = if kind == "plain" { Message::Text(bytes.into()) } else { Message::Binary(sealed.clone().into()) };
        c.socket.send(message).await.unwrap();
        if kind == "replay" {
            let _ = c.receive().await; // metadata
            let _ = c.receive().await; // chunk, expects ACK with the next nonce
            c.socket.send(Message::Binary(sealed.into())).await.unwrap();
        }
        let response = tokio::time::timeout(std::time::Duration::from_secs(5), c.socket.next()).await.unwrap();
        assert!(response.is_none() || response.as_ref().is_some_and(|r| r.as_ref().map_or(true, |m| m.is_close())));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn encrypted_terminal_uses_existing_one_time_tickets() {
    let server = TestServer::start().await;
    let project = server.create_project("encrypted-terminal").await;
    let (_, terminal) = server.post(&format!("/api/v1/projects/{}/terminals", project["id"].as_str().unwrap()), json!({ "name": "encrypted" })).await;
    let id = terminal["id"].as_str().unwrap();
    let (_, ticket) = server.post(&format!("/api/v1/terminals/{id}/ticket"), json!({})).await;
    let mut c = Channel::open(&server, None, None).await;
    c.send(json!({ "kind": "ws", "path": ticket["url"] }).to_string().as_bytes()).await;
    assert_eq!(c.receive().await, [0]);
    c.send(&[&[1u8][..], &br#"{"type":"input","data":"printf 'E2EE_%s\\n' TERMINAL_OK\r"}"#[..]].concat()).await;
    let mut output = String::new();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !output.contains("E2EE_TERMINAL_OK") {
            let frame = c.receive().await;
            if frame[0] == 2 { output.push_str(&String::from_utf8_lossy(&frame[1..])); }
        }
    }).await.unwrap();
    c.socket.close(None).await.unwrap();
    let mut replay = Channel::open(&server, None, None).await;
    replay.send(json!({ "kind": "ws", "path": ticket["url"] }).to_string().as_bytes()).await;
    let result = replay.socket.next().await;
    assert!(result.is_none() || result.unwrap().map_or(true, |m| m.is_close()));
    server.post(&format!("/api/v1/terminals/{id}/kill"), json!({})).await;
}
