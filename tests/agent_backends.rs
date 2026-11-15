mod common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

#[tokio::test]
async fn backend_catalog_requires_auth_and_never_claims_login_readiness() {
    let server = TestServer::start().await;
    let response = server.client.get(format!("{}/api/v1/agent-backends", server.base)).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let (status, catalog) = server.get("/api/v1/agent-backends").await;
    assert_eq!(status, StatusCode::OK);
    let backends = catalog["backends"].as_array().unwrap();
    assert_eq!(backends.len(), 2);
    for backend in backends {
        assert_eq!(backend["read_only"], false);
        assert!(backend["installed"].is_boolean());
        assert!(backend.get("authenticated").is_none());
        assert!(backend.get("path").is_none(), "서버 실행 경로는 응답하지 않는다");
    }
    let (_, profiles) = server.get("/api/v1/model-profiles").await;
    assert!(profiles.as_array().unwrap().is_empty(), "조회만으로 프로필을 생성하지 않는다");
}

#[tokio::test]
async fn connect_reconciles_concurrent_requests_and_keeps_owner_boundary() {
    let server = TestServer::start().await;
    let (_, retired) = server.post("/api/v1/model-profiles", json!({
        "name":"retired backend", "protocol":"codex_cli", "base_url":"", "model":"default",
    })).await;
    let (status, _) = server.send(Method::DELETE, &format!("/api/v1/model-profiles/{}", retired["id"].as_str().unwrap()), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    // 기존 기본 연결이 있으면 설치 검사·모델 호출 없이 같은 연결을 사용한다.
    let (_, profile) = server.post("/api/v1/model-profiles", json!({
        "name":"Codex", "protocol":"codex_cli", "base_url":"", "model":"default",
    })).await;
    let (first, second) = tokio::join!(
        server.post("/api/v1/agent-backends/codex_cli/connect", json!({})),
        server.post("/api/v1/agent-backends/codex_cli/connect", json!({})),
    );
    for (status, value) in [first, second] {
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["id"], profile["id"]);
    }
    let (_, profiles) = server.get("/api/v1/model-profiles").await;
    assert_eq!(profiles.as_array().unwrap().len(), 1);
    let (_, device) = server.post("/api/v1/devices", json!({"name":"phone"})).await;
    let response = server.raw(Method::POST, "/api/v1/agent-backends/codex_cli/connect", Some(json!({})), Some("device-connect"), device["token"].as_str()).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let (status, _) = server.post("/api/v1/agent-backends/not-a-program/connect", json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn connect_uses_runtime_catalog_and_replays_without_duplicates() {
    let server = TestServer::start().await;
    let (_, catalog) = server.get("/api/v1/agent-backends").await;
    for backend in catalog["backends"].as_array().unwrap() {
        let protocol = backend["protocol"].as_str().unwrap();
        let path = format!("/api/v1/agent-backends/{protocol}/connect");
        let key = format!("connect-{protocol}");
        let response = server.raw(Method::POST, &path, Some(json!({})), Some(&key), None).await;
        if backend["installed"] == false {
            assert_eq!(response.status(), StatusCode::FAILED_DEPENDENCY);
            continue;
        }
        assert_eq!(response.status(), StatusCode::CREATED);
        let created: Value = response.json().await.unwrap();
        assert_eq!(created["model"], "default");
        assert_eq!(created["secret_id"], Value::Null);
        assert_eq!(created["capabilities"]["native_tools"], true);
        assert_eq!(created["capabilities"]["tools"], false, "CLI 자체 도구를 Grove 루프로 중복 실행하지 않는다");
        let replay: Value = server.raw(Method::POST, &path, Some(json!({})), Some(&key), None).await.json().await.unwrap();
        assert_eq!(replay["id"], created["id"]);
        let (_, again) = server.post(&path, json!({})).await;
        assert_eq!(again["id"], created["id"]);
    }
}
