mod common;
#[path = "common/e2ee.rs"]
mod wire;

use common::*;
use serde_json::{Value, json};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use wire::Channel;

#[tokio::test]
async fn chunked_requests_require_auth_cancel_without_writes_and_release_slots() {
    let server = TestServer::start().await;
    let (_, browser) = server.pair_browser("encrypted upload").await;
    let browser: Value = browser.json().await.unwrap();
    let access = browser["access_token"].as_str().unwrap();
    let project = server.create_project("chunk-cancellation").await;
    let path = format!("/api/v1/projects/{}/attachments", project["id"].as_str().unwrap());
    let operation = |authenticated: bool| json!({
        "kind":"http", "method":"POST", "path":path,
        "headers":if authenticated { vec![
            ("authorization", format!("Bearer {access}")),
            ("content-type", "application/json".into()),
            ("idempotency-key", "cancelled-upload".into()),
        ] } else { vec![] },
    }).to_string();
    let mut channel = Channel::open_mux(&server).await;
    channel.mux_send(0x05, 1, operation(false).as_bytes()).await;
    let (kind, id, headers) = channel.mux_receive().await;
    assert_eq!((kind, id), (0x11, 1));
    assert_eq!(serde_json::from_slice::<Value>(&headers).unwrap()["status"], 401);
    loop {
        let (kind, id, _) = channel.mux_receive().await;
        assert_eq!(id, 1);
        if kind == 0x13 { break; }
        assert_eq!(kind, 0x12);
        channel.mux_send(0x02, id, &[]).await;
    }

    // 완성되지 않은 요청은 handler를 실행하지 않는다. 네 슬롯이 차도 연결은 유지한다.
    for id in [3, 5, 7, 9] {
        channel.mux_send(0x05, id, operation(true).as_bytes()).await;
        assert_eq!(channel.mux_receive().await, (0x16, id, vec![]));
    }
    channel.mux_send(0x05, 11, operation(true).as_bytes()).await;
    assert_eq!(channel.mux_receive().await, (0x14, 11, vec![]));
    channel.mux_send(0x06, 3, br#"{"name":"cancelled.txt","data_base64":"eA=="}"#).await;
    assert_eq!(channel.mux_receive().await, (0x16, 3, vec![]));
    channel.mux_send(0x03, 3, &[]).await;
    channel.mux_send(0x07, 3, &[]).await;
    assert_eq!(channel.mux_receive().await, (0x14, 3, vec![]));
    channel.mux_send(0x05, 13, operation(true).as_bytes()).await;
    assert_eq!(channel.mux_receive().await, (0x16, 13, vec![]));
    // 큰 조각·잘못된 종료는 해당 업로드만 폐기하고 슬롯을 돌려준다.
    channel.mux_send(0x06, 13, &vec![0; 1024 * 1024 + 1]).await;
    assert_eq!(channel.mux_receive().await, (0x14, 13, vec![]));
    channel.mux_send(0x05, 15, operation(true).as_bytes()).await;
    assert_eq!(channel.mux_receive().await, (0x16, 15, vec![]));
    channel.mux_send(0x07, 15, b"invalid").await;
    assert_eq!(channel.mux_receive().await, (0x14, 15, vec![]));
    for id in [5, 7, 9] { channel.mux_send(0x03, id, &[]).await; }
    channel.mux_send(0x04, 17, &[]).await;
    assert_eq!(channel.mux_receive().await, (0x15, 17, vec![]));
    let app = &server.server.as_ref().unwrap().app;
    assert_eq!(app.db.call(|c| Ok(c.query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get::<_, i64>(0))?)).await.unwrap(), 0);

    // 같은 요청 키로 완성해 보내면 한 번 저장하고, 재전송도 같은 결과로 수렴한다.
    let body = br#"{"name":"complete.txt","data_base64":"eA=="}"#;
    let mut previous = Value::Null;
    for _ in 0..2 {
        let mut channel = Channel::open_mux(&server).await;
        let (meta, response) = channel.request_body("POST", &path, vec![
            ("authorization", format!("Bearer {access}")),
            ("content-type", "application/json".into()),
            ("idempotency-key", "cancelled-upload".into()),
        ], body).await;
        assert_eq!(meta["status"], 201);
        let saved: Value = serde_json::from_slice(&response).unwrap();
        if previous.is_null() { previous = saved; } else { assert_eq!(saved, previous); }
    }
    assert_eq!(app.db.call(|c| Ok(c.query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get::<_, i64>(0))?)).await.unwrap(), 1);
}

#[tokio::test]
async fn encrypted_attachment_accepts_maximum_size_and_downloads_original() {
    use base64::{Engine, engine::general_purpose::STANDARD};

    let server = TestServer::start().await;
    let project = server.create_project("encrypted-attachment-limit").await;
    let (_, browser) = server.pair_browser("encrypted attachment").await;
    let browser: Value = browser.json().await.unwrap();
    let access = browser["access_token"].as_str().unwrap();
    let bytes = vec![b'x'; grove::attachments::MAX_FILE_BYTES];
    let mut channel = Channel::open_mux(&server).await;
    channel.receive_timeout = std::time::Duration::from_secs(30);
    let (meta, response) = channel.request_body("POST", &format!("/api/v1/projects/{}/attachments", project["id"].as_str().unwrap()), vec![
        ("authorization", format!("Bearer {access}")),
        ("content-type", "application/json".into()),
        ("idempotency-key", "encrypted-maximum-attachment".into()),
    ], json!({"name":"maximum.txt","data_base64":STANDARD.encode(&bytes)}).to_string().as_bytes()).await;
    assert_eq!(meta["status"], 201);
    let attachment: Value = serde_json::from_slice(&response).unwrap();
    assert_eq!(attachment["size"], bytes.len());

    let mut channel = Channel::open(&server, None, None).await;
    channel.receive_timeout = std::time::Duration::from_secs(30);
    let meta = channel.request("GET", &format!("/api/v1/attachments/{}/content", attachment["id"].as_str().unwrap()),
        vec![("authorization", format!("Bearer {access}"))], Value::Null).await;
    assert_eq!(meta["status"], 200);
    assert_eq!(channel.body().await, bytes);
}

#[tokio::test]
async fn encrypted_login_api_idempotency_and_stream_preserve_existing_contracts() {
    let server = TestServer::start().await;
    let password = "test-only encrypted pairing password";
    let (status, link) = server.post("/api/v1/pairings", json!({ "name": "encrypted browser", "password": password, "issuance_password": common::ISSUANCE_PASSWORD })).await;
    assert_eq!(status, reqwest::StatusCode::CREATED);
    let mut c = Channel::open(&server, None, Some("https://grove.choondoggy.com")).await;
    let meta = c.request("POST", "/api/v1/auth/pairing",
        vec![("content-type", "application/json".into())],
        json!({ "code": link["code"], "password": password, "name": "encrypted browser" })).await;
    assert_eq!(meta["status"], 202);
    let request: Value = serde_json::from_slice(&c.body().await).unwrap();
    let code = request["code"].as_str().unwrap();
    let request_id = code.split_once('.').unwrap().0;
    assert_eq!(server.post(&format!("/api/v1/pairings/{}/requests/{request_id}", link["id"].as_str().unwrap()), json!({})).await.0, reqwest::StatusCode::OK);
    let mut c = Channel::open(&server, None, Some("https://grove.choondoggy.com")).await;
    let meta = c.request("POST", "/api/v1/auth/pairing/claim",
        vec![("content-type", "application/json".into())], json!({ "code": code })).await;
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
    let response = server.client.post(format!("{}/api/v1/auth/pairing", server.base))
        .header("host", "grove.example").header("x-forwarded-proto", "https")
        .header("x-grove-e2ee-bridge", "forged").json(&json!({ "token": server.token, "name": "plain" })).send().await.unwrap();
    assert_eq!(response.status(), 426);
    let mut c = Channel::open(&server, Some("grove.example"), Some("https://grove.choondoggy.com")).await;
    let meta = c.request("GET", "/api/v1/projects", vec![("authorization", format!("Bearer {}", server.token))], Value::Null).await;
    assert_eq!(meta["status"], 401, "로컬 관리 토큰은 원격 암호화 API의 자격이 아니다");
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
