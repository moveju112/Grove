mod common;

use common::{TestServer, config};
use reqwest::StatusCode;
use serde_json::{Value, json};

#[tokio::test]
async fn browser_origin_scheme_follows_the_explicit_tls_boundary_not_forwarded_headers() {
    for terminated in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = config(&dir.path().join("data"));
        cfg.tls_terminated = terminated;
        let server = TestServer::start_with(dir, cfg).await;
        let authority = server.base.strip_prefix("http://").unwrap();
        let expected = format!("{}://{authority}", if terminated { "https" } else { "http" });
        let rejected = format!("{}://{authority}", if terminated { "http" } else { "https" });
        let response = server.client.post(format!("{}/api/v1/auth/browser-login", server.base))
            .header("origin", &rejected)
            .header("x-forwarded-proto", if terminated { "https" } else { "http" })
            .header("forwarded", format!("proto={};host={authority}", if terminated { "https" } else { "http" }))
            .json(&json!({ "token": server.token, "name": "wrong-scheme" }))
            .send().await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "HTTP와 HTTPS는 같은 origin이 아니다");
        let response = server.client.post(format!("{}/api/v1/auth/browser-login", server.base))
            .header("origin", expected).json(&json!({ "token": server.token, "name": "expected-scheme" }))
            .send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers()["set-cookie"].to_str().unwrap();
        assert_eq!(cookie.contains("; Secure"), terminated);
        let credentials: Value = response.json().await.unwrap();
        assert!(credentials["access_token"].is_string());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn websocket_origin_rejection_does_not_consume_the_single_use_ticket() {
    use tokio_tungstenite::tungstenite::{Error, client::IntoClientRequest};

    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(&dir.path().join("data"));
    cfg.tls_terminated = true;
    let server = TestServer::start_with(dir, cfg).await;
    let project = server.create_project("websocket-origin").await;
    let (status, terminal) = server.post(&format!("/api/v1/projects/{}/terminals", project["id"].as_str().unwrap()), json!({ "name": "origin" })).await;
    assert_eq!(status, StatusCode::CREATED);
    let id = terminal["id"].as_str().unwrap();
    let (_, ticket) = server.post(&format!("/api/v1/terminals/{id}/ticket"), json!({})).await;
    let socket_url = format!("{}{}", server.base.replace("http://", "ws://"), ticket["url"].as_str().unwrap());
    for origin in [server.base.clone(), "https://attacker.example".into(), "null".into()] {
        let mut request = socket_url.as_str().into_client_request().unwrap();
        request.headers_mut().insert("origin", origin.parse().unwrap());
        request.headers_mut().insert("x-forwarded-proto", "https".parse().unwrap());
        match tokio_tungstenite::connect_async(request).await {
            Err(Error::Http(response)) => assert_eq!(response.status(), StatusCode::FORBIDDEN),
            _ => panic!("잘못된 Origin의 WebSocket은 upgrade 전에 거절해야 한다"),
        }
    }
    let mut request = socket_url.as_str().into_client_request().unwrap();
    request.headers_mut().insert("origin", server.base.replace("http://", "https://").parse().unwrap());
    let (mut socket, response) = tokio_tungstenite::connect_async(request).await.expect("올바른 origin의 첫 사용");
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    socket.close(None).await.unwrap();
    assert!(tokio_tungstenite::connect_async(socket_url).await.is_err(), "성공한 upgrade 이후에는 티켓을 다시 쓸 수 없다");
    let (status, _) = server.post(&format!("/api/v1/terminals/{id}/kill"), json!({})).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn explicit_development_origin_is_preserved_but_cross_site_fetch_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(&dir.path().join("data"));
    cfg.allowed_origins = vec!["http://localhost:5173".into()];
    let server = TestServer::start_with(dir, cfg).await;
    let response = server.client.get(format!("{}/api/v1/projects", server.base))
        .header("origin", "http://localhost:5173").bearer_auth(&server.token).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = server.client.get(format!("{}/api/v1/projects", server.base))
        .header("origin", "http://localhost:5173").header("sec-fetch-site", "cross-site")
        .bearer_auth(&server.token).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}
