mod common;

use common::{TestServer, fixture::{self, Fixture}};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

#[tokio::test]
async fn active_turns_cannot_silently_change_model_endpoint_or_credentials() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let other = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("switching").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    f.push(fixture::Step::Hang(vec![]));
    let (_, turn) = s.post(&format!("/api/v1/sessions/{session}/turns"), json!({ "profile_id":profile, "text":"original request" })).await;
    let turn = turn["turn"]["id"].as_str().unwrap();
    s.wait_turn(turn, |_| f.requests().len() == 1).await;
    let (_, secret) = s.post("/api/v1/secrets", json!({ "label":"switch fixture", "value":"synthetic-new-credential" })).await;
    let (_, profiles) = s.get("/api/v1/model-profiles").await;
    let original = profiles.as_array().unwrap().iter().find(|p| p["id"] == profile).unwrap().clone();
    for patch in [
        json!({ "model":"different" }), json!({ "base_url":other.base }), json!({ "secret_id":secret["id"] }),
        json!({ "options":{"headers":{"x-provider-scope":"different"}} }),
    ] {
        let mut body = patch;
        body["expected_revision"] = original["revision"].clone();
        let (status, error) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{profile}"), body).await;
        assert_eq!(status, StatusCode::CONFLICT, "{error}");
        assert_eq!(error["error"]["code"], "busy");
    }
    let secret_path = format!("/api/v1/secrets/{}", original["secret_id"].as_str().unwrap());
    let (status, _) = s.send(Method::PUT, &secret_path, json!({ "label":"rotated", "value":"synthetic-in-place-replacement" })).await;
    assert_eq!(status, StatusCode::CONFLICT, "같은 secret ID의 값 교체도 실행 중 전송 자격을 바꾸면 안 된다");
    let (status, _) = s.send(Method::PUT, &secret_path, json!({ "label":"display label", "value":" sk-test-secret-value-1234 " })).await;
    assert_eq!(status, StatusCode::OK, "trim 후 같은 값의 표시 이름 변경은 허용한다");
    let (status, renamed) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{profile}"),
        json!({ "expected_revision":original["revision"], "name":"display name" })).await;
    assert_eq!(status, StatusCode::OK, "표시 이름처럼 전송 대상을 바꾸지 않는 편집은 유지한다");
    assert_eq!(renamed["model"], original["model"]);
    assert_eq!(renamed["base_url"], original["base_url"]);
    assert_eq!(renamed["secret_id"], original["secret_id"]);
    s.post(&format!("/api/v1/turns/{turn}/cancel"), json!({})).await;
    s.wait_status(turn, "cancelled").await;
    let (status, changed) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{profile}"),
        json!({ "expected_revision":renamed["revision"], "model":"different" })).await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert_eq!(changed["model"], "different");
    let (status, _) = s.send(Method::PUT, &secret_path, json!({ "label":"rotated", "value":"synthetic-in-place-replacement" })).await;
    assert_eq!(status, StatusCode::OK);
    assert!(other.requests().is_empty());
    let (_, messages) = s.get(&format!("/api/v1/sessions/{session}/messages")).await;
    assert!(messages["items"].as_array().unwrap().iter().any(|m| m["role"] == "user" && m["content"]["text"] == "original request"));
}

#[tokio::test]
async fn approval_wait_also_keeps_the_model_identity_until_explicit_completion() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("approval").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    f.push(fixture::tool_calls(&[("write-id", "write", json!({ "path":"pending.txt", "content":"pending" }))]));
    let (_, turn) = s.post(&format!("/api/v1/sessions/{session}/turns"),
        json!({ "profile_id":profile, "text":"write after approval", "tools":true })).await;
    let tid = turn["turn"]["id"].as_str().unwrap();
    s.wait_status(tid, "awaiting_approval").await;
    let (_, profiles) = s.get("/api/v1/model-profiles").await;
    let p: &Value = profiles.as_array().unwrap().iter().find(|p| p["id"] == profile).unwrap();
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{profile}"),
        json!({ "expected_revision":p["revision"], "model":"other" })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(!std::path::Path::new(project["root_path"].as_str().unwrap()).join("pending.txt").exists());
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    s.wait_status(tid, "cancelled").await;
}
