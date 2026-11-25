use crate::common;
use common::TestServer;
use reqwest::{Method, StatusCode};
use serde_json::json;

#[tokio::test]
async fn quota_requires_auth_and_does_not_invent_limits_for_api_profiles() {
    let server = TestServer::start().await;
    let response = server.raw(Method::GET, "/api/v1/usage/accounts", None, None, Some("")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let fixture = common::fixture::Fixture::start().await;
    server.fixture_profile(&fixture.base).await;
    let response = server.raw(Method::GET, "/api/v1/usage/accounts", None, None, None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.json::<serde_json::Value>().await.unwrap(), json!({"accounts":[]}));
}
