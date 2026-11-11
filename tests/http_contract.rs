//! HTTP 경계 계약(NET-003). timeout·연결 취소는 실행 취소와 구분한다.
mod common;

use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};

#[tokio::test]
async fn request_ids_cover_success_errors_and_untrusted_headers() {
    let s = TestServer::start().await;
    let id = uuid::Uuid::new_v4().to_string();
    let r = s.client.get(format!("{}/api/v1/health", s.base)).header("x-request-id", &id).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()["x-request-id"], id);
    let r = s.client.get(format!("{}/api/v1/projects", s.base)).header("x-request-id", &id).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(r.headers()["x-request-id"], id);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["error"]["code"], "unauthorized");
    for invalid in [None, Some("not-a-uuid"), Some("Bearer-private-value")] {
        let mut req = s.client.get(format!("{}/api/v1/health", s.base));
        if let Some(value) = invalid { req = req.header("x-request-id", value); }
        let r = req.send().await.unwrap();
        let id = r.headers()["x-request-id"].to_str().unwrap();
        assert!(uuid::Uuid::parse_str(id).is_ok());
        assert_ne!(Some(id), invalid);
    }
}

#[tokio::test]
async fn extractor_router_and_body_limit_errors_use_the_standard_envelope() {
    let s = TestServer::start().await;
    for (method, path, content_type, body, status, code) in [
        ("POST", "/projects", "application/json", "{".to_string(), 400, "invalid_request"),
        ("POST", "/projects", "text/plain", "{}".to_string(), 415, "unsupported_media_type"),
        ("POST", "/projects", "application/json", "{}".to_string(), 422, "invalid_request"),
        ("DELETE", "/health", "application/json", "".to_string(), 405, "method_not_allowed"),
        ("GET", "/missing-api", "application/json", "".to_string(), 404, "not_found"),
        ("POST", "/projects", "application/json", "x".repeat(8 * 1024 * 1024 + 1), 413, "payload_too_large"),
    ] {
        let r = s.client.request(method.parse().unwrap(), format!("{}/api/v1{path}", s.base))
            .bearer_auth(&s.token).header("idempotency-key", s.key())
            .header("content-type", content_type).body(body).send().await.unwrap();
        assert_eq!(r.status().as_u16(), status, "{path}");
        let id = r.headers().get("x-request-id").unwrap_or_else(|| panic!("{method} {path}: request ID 누락"));
        assert!(uuid::Uuid::parse_str(id.to_str().unwrap()).is_ok());
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["error"]["code"], code, "{v}");
        assert_eq!(v["error"]["retryable"], false, "{v}");
        assert!(v["error"]["message"].is_string(), "{v}");
    }
}

#[tokio::test]
async fn idempotency_replay_has_a_new_transport_id_without_repeating_the_mutation() {
    let s = TestServer::start().await;
    let root = s.make_project_dir("request-id");
    let key = s.key();
    let mut bodies = vec![];
    let mut ids = vec![];
    for _ in 0..2 {
        let id = uuid::Uuid::new_v4().to_string();
        let r = s.client.post(format!("{}/api/v1/projects", s.base))
            .bearer_auth(&s.token).header("idempotency-key", &key).header("x-request-id", &id)
            .json(&json!({ "root_path": root })).send().await.unwrap();
        assert_eq!(r.status(), StatusCode::CREATED);
        assert_eq!(r.headers()["x-request-id"], id);
        ids.push(id);
        bodies.push(r.json::<Value>().await.unwrap());
    }
    assert_ne!(ids[0], ids[1]);
    assert_eq!(bodies[0], bodies[1]);
    let (_, projects) = s.get("/api/v1/projects").await;
    assert_eq!(projects.as_array().unwrap().len(), 1);
}
