mod common;

use common::{TestServer, fixture::{self, Fixture}};
use reqwest::StatusCode;
use serde_json::json;

const HEADER_KEY: &str = "synthetic-custom-header-credential";

#[tokio::test]
async fn credential_header_literals_require_an_encrypted_vault_reference() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let (status, response) = s.post("/api/v1/model-profiles", json!({
        "name":"header credential", "protocol":"openai", "base_url":f.base, "model":"fixture-model",
        "options":{"headers":{"X-Custom-Token":HEADER_KEY}},
    })).await;
    let device = s.registered_device("header read fixture").await;
    let listed = s.client.get(format!("{}/api/v1/model-profiles", s.base))
        .bearer_auth(device["token"].as_str().unwrap()).send().await.unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
    assert!(!listed.text().await.unwrap().contains(HEADER_KEY), "등록 기기 조회에 자격 헤더 원문을 전달하지 않는다");
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "자격 증명 헤더 원문을 공개 프로필·이벤트에 저장하면 안 된다");
    assert!(!response.to_string().contains(HEADER_KEY));
    let (_, profiles) = s.get("/api/v1/model-profiles").await;
    assert!(profiles.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn private_header_references_are_publicly_safe_and_count_as_secret_dependencies() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let (_, secret) = s.post("/api/v1/secrets", json!({"label":"custom header", "value":HEADER_KEY})).await;
    let private_public_name = "synthetic-protected-public-name-value";
    let (_, second) = s.post("/api/v1/secrets", json!({"label":"private value in a public header name", "value":private_public_name})).await;
    let (status, profile) = s.post("/api/v1/model-profiles", json!({
        "name":"referenced header", "protocol":"openai", "base_url":f.base, "model":"fixture-model",
        "options":{"headers":{"X-Custom-Token":{"secret_id":secret["id"]},"X-Client-Name":{"secret_id":second["id"]}}},
    })).await;
    assert_eq!(status, StatusCode::CREATED, "비밀 값 대신 vault 참조를 사용한다");
    assert!(!profile.to_string().contains(HEADER_KEY));
    let (_, profiles) = s.get("/api/v1/model-profiles").await;
    assert!(!profiles.to_string().contains(HEADER_KEY));
    let events = s.read_events(Some(0), "", 100, 200).await;
    assert!(!serde_json::to_string(&events).unwrap().contains(HEADER_KEY));
    let (status, _) = s.post(&format!("/api/v1/model-profiles/{}/check", profile["id"].as_str().unwrap()), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    f.push(fixture::text("header transport"));
    let project = s.create_project("headers").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    let path = format!("/api/v1/sessions/{}/turns", session["id"].as_str().unwrap());
    let (_, turn) = s.post(&path, json!({"profile_id":profile["id"],"text":"transport"})).await;
    s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
    {
        let inner = f.inner.lock().unwrap();
        assert_eq!(inner.requests[0].0.get("x-custom-token").unwrap(), HEADER_KEY);
        assert_eq!(inner.requests[0].0.get("x-client-name").unwrap(), private_public_name);
    }
    f.push(fixture::Step::Error(401, private_public_name.into()));
    let (_, turn) = s.post(&path, json!({"profile_id":profile["id"],"text":"error echo"})).await;
    let failed = s.wait_status(turn["turn"]["id"].as_str().unwrap(), "failed").await;
    assert_eq!(failed["error"]["code"], "auth_failed");
    assert!(!failed.to_string().contains(private_public_name));
    assert!(failed["error"]["message"].as_str().unwrap().contains("[redacted]"), "명시한 vault 참조는 공개 이름의 헤더에서도 비밀이다");
    let (status, _) = s.send(reqwest::Method::DELETE, &format!("/api/v1/secrets/{}", secret["id"].as_str().unwrap()), json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "header 참조도 사용 중인 비밀의 삭제를 막는다");
}

#[tokio::test]
async fn private_header_rotation_obeys_active_turns_and_applies_on_the_next_explicit_request() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let (_, secret) = s.post("/api/v1/secrets", json!({"label":"active header","value":HEADER_KEY})).await;
    let (_, alternate) = s.post("/api/v1/secrets", json!({"label":"alternate header","value":"synthetic-alternate-header"})).await;
    let (status, profile) = s.post("/api/v1/model-profiles", json!({
        "name":"active reference","protocol":"openai","base_url":f.base,"model":"fixture-model",
        "options":{"headers":{"X-Client-Name":{"secret_id":secret["id"]}}},
    })).await;
    assert_eq!(status, StatusCode::CREATED);
    let project = s.create_project("active header").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    let path = format!("/api/v1/sessions/{}/turns", session["id"].as_str().unwrap());
    f.push(fixture::Step::Hang(vec![]));
    let (_, turn) = s.post(&path, json!({"profile_id":profile["id"],"text":"in flight"})).await;
    let tid = turn["turn"]["id"].as_str().unwrap();
    s.wait_turn(tid, |_| f.requests().len() == 1).await;
    let secret_path = format!("/api/v1/secrets/{}", secret["id"].as_str().unwrap());
    let (status, _) = s.send(reqwest::Method::PUT, &secret_path, json!({"label":"rotate","value":"synthetic-rotated-header"})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = s.send(reqwest::Method::PUT, &format!("/api/v1/model-profiles/{}", profile["id"].as_str().unwrap()), json!({
        "expected_revision":profile["revision"],"options":{"headers":{"X-Client-Name":{"secret_id":alternate["id"]}}},
    })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    s.wait_status(tid, "cancelled").await;
    let (status, _) = s.send(reqwest::Method::PUT, &secret_path, json!({"label":"rotate","value":"synthetic-rotated-header"})).await;
    assert_eq!(status, StatusCode::OK);
    f.push(fixture::text("rotated"));
    let (_, turn) = s.post(&path, json!({"profile_id":profile["id"],"text":"next explicit request"})).await;
    s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(f.inner.lock().unwrap().requests[1].0.get("x-client-name").unwrap(), "synthetic-rotated-header");
}
