use crate::common;

use common::{TestServer, fixture::{self, Fixture}};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

#[tokio::test]
async fn request_models_are_isolated_idempotent_and_preserved_for_queued_followups() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("request-model").await;
    let sid = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let path = format!("/api/v1/sessions/{sid}/turns");
    f.push(fixture::hang_after("hold"));
    let body = json!({"profile_id":profile,"text":"selected model","model":"other"});
    let response = s.raw(Method::POST, &path, Some(body.clone()), Some("model-selection"), None).await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let accepted: Value = response.json().await.unwrap();
    let tid = accepted["turn"]["id"].as_str().unwrap();
    s.wait_turn(tid, |_| f.requests().len() == 1).await;
    assert_eq!(f.requests()[0]["model"], "other");
    let (status, _) = s.post(&format!("/api/v1/sessions/{sid}/followups"), json!({
        "kind":"steer","profile_id":profile,"text":"do not silently change model","model":"different",
    })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let replay: Value = s.raw(Method::POST, &path, Some(body.clone()), Some("model-selection"), None).await.json().await.unwrap();
    assert_eq!(replay["turn"]["id"], tid);
    let mut changed = body;
    changed["model"] = json!("different");
    assert_eq!(s.raw(Method::POST, &path, Some(changed), Some("model-selection"), None).await.status(), StatusCode::CONFLICT);
    let (_, queued) = s.post(&format!("/api/v1/sessions/{sid}/followups"), json!({
        "kind":"queue","profile_id":profile,"text":"queued model","model":"fixture-model",
    })).await;
    assert_eq!(queued["followup"]["model"], "fixture-model");
    f.push(fixture::text("queued complete"));
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    s.wait_status(tid, "cancelled").await;
    let fid = queued["followup"]["id"].as_str().unwrap();
    let (_, started) = s.post(&format!("/api/v1/sessions/{sid}/followups/{fid}/start"), json!({})).await;
    let queued_id = started["turn_id"].as_str().unwrap();
    s.wait_status(queued_id, "completed").await;
    assert_eq!(f.requests()[1]["model"], "fixture-model");
    let (_, profiles) = s.get("/api/v1/model-profiles").await;
    let saved = profiles.as_array().unwrap().iter().find(|p| p["id"] == profile).unwrap();
    assert_eq!(saved["model"], "fixture-model");
    for model in ["", "contains space", "\ninvalid"] {
        let (status, _) = s.post(&path, json!({"profile_id":profile,"text":"invalid","model":model})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}

// 다른 기기의 입력창이 이어 쓰도록 대화 상세는 마지막 사용자 턴의 모델·추론·속도를 함께 준다.
#[tokio::test]
async fn session_detail_reports_the_last_turn_effort_and_service_tier() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("last-model").await;
    let sid = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let path = format!("/api/v1/sessions/{sid}/turns");
    f.push(fixture::text("first"));
    let (status, v) = s.post(&path, json!({"profile_id":profile,"text":"high","model":"other","effort":"high"})).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    let first = v["turn"]["id"].as_str().unwrap().to_string();
    s.wait_status(&first, "completed").await;
    let last = s.get(&format!("/api/v1/sessions/{sid}")).await.1["last_model"].clone();
    assert_eq!(last, json!({"turn_id":first,"profile_id":profile,"model":"other","effort":"high","service_tier":null}));
    // Codex 계열의 속도 선택은 같은 definition 위치에 고정된다.
    rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap()
        .execute("UPDATE turns SET definition_snapshot=json_set(definition_snapshot,'$.service_tier','priority') WHERE id=?1", [&first]).unwrap();
    assert_eq!(s.get(&format!("/api/v1/sessions/{sid}")).await.1["last_model"]["service_tier"], "priority");
    f.push(fixture::text("second"));
    let (_, v) = s.post(&path, json!({"profile_id":profile,"text":"auto"})).await;
    let second = v["turn"]["id"].as_str().unwrap().to_string();
    s.wait_status(&second, "completed").await;
    let last = s.get(&format!("/api/v1/sessions/{sid}")).await.1["last_model"].clone();
    assert_eq!(last, json!({"turn_id":second,"profile_id":profile,"model":null,"effort":null,"service_tier":null}));
}

#[tokio::test]
async fn retry_preserves_the_request_model_without_changing_the_profile_default() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("retry-model").await;
    let sid = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    f.push(fixture::hang_after("hold"));
    let (_, accepted) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({
        "profile_id": profile, "text": "keep this model", "model": "other", "effort": "high",
    })).await;
    let tid = accepted["turn"]["id"].as_str().unwrap();
    s.wait_turn(tid, |_| f.requests().len() == 1).await;
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    s.wait_status(tid, "cancelled").await;
    f.push(fixture::text("retry complete"));
    let path = format!("/api/v1/turns/{tid}/retry");
    let response = s.raw(Method::POST, &path, Some(json!({})), Some("selected-model-retry"), None).await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let retried: Value = response.json().await.unwrap();
    let retry_id = retried["turn"]["id"].as_str().unwrap();
    s.wait_status(retry_id, "completed").await;
    let requests = f.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1]["model"], "other");
    assert_eq!(requests[1]["reasoning_effort"], "high");
    let replay: Value = s.raw(Method::POST, &path, Some(json!({})), Some("selected-model-retry"), None).await.json().await.unwrap();
    assert_eq!(replay["turn"]["id"], retry_id);
    assert_eq!(f.requests().len(), 2);
    let (_, profiles) = s.get("/api/v1/model-profiles").await;
    let saved = profiles.as_array().unwrap().iter().find(|p| p["id"] == profile).unwrap();
    assert_eq!(saved["model"], "fixture-model");
}

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
