//! 설정 기본값 복원은 제공하지 않는다. 기존 값·revision은 보존한다.
mod common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::json;

#[tokio::test]
async fn reset_endpoints_and_capability_are_removed_without_changing_saved_settings() {
    let s = TestServer::start().await;
    let (status, saved) = s.send(Method::PUT, "/api/v1/settings/server/-/output.style",
        json!({"expected_revision":0,"value":"concise"})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!grove::CAPABILITIES.contains(&"settings_reset_v1"));
    assert_eq!(s.get("/api/v1/settings/reset-preview?scope=server&scope_id=-&keys=output.style").await.0, StatusCode::NOT_FOUND);
    assert_eq!(s.post("/api/v1/settings/reset", json!({})).await.0, StatusCode::NOT_FOUND);
    let (_, effective) = s.get("/api/v1/settings/effective").await;
    let current = effective["items"].as_array().unwrap().iter().find(|item| item["key"] == "output.style").unwrap();
    assert_eq!(current, &saved["item"]);
}
