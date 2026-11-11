mod common;

use base64::{Engine, engine::general_purpose::STANDARD};
use common::{TestServer, fixture::{self, Fixture}};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn profile(s: &TestServer, f: &Fixture, options: Value) -> Value {
    let (status, profile) = s.post("/api/v1/model-profiles", json!({
        "name": "capabilities", "protocol": "openai", "base_url": f.base, "model": "fixture", "options": options,
    })).await;
    assert_eq!(status, StatusCode::CREATED, "{profile}");
    profile
}

async fn update(s: &TestServer, profile: &Value, options: Value) -> Value {
    let (status, profile) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{}", profile["id"].as_str().unwrap()),
        json!({ "expected_revision": profile["revision"], "options": options })).await;
    assert_eq!(status, StatusCode::OK, "{profile}");
    profile
}

#[tokio::test]
async fn capabilities_validate_persist_and_reset_only_when_the_model_target_changes() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let unknown = profile(&s, &f, json!({})).await;
    assert!(unknown["capabilities"]["tools"].is_null());
    assert_eq!(unknown["capabilities"]["pdf"], false);
    assert_eq!(unknown["capabilities"]["fast"], false);
    let options = json!({ "context_window": 32000, "max_tokens": 1000,
        "capabilities": { "max_output_tokens": 2048, "images": false, "tools": true, "effort": false, "temperature": false } });
    let p = update(&s, &unknown, options.clone()).await;
    assert_eq!(p["capabilities"]["context_tokens"], 32000);
    assert_eq!(p["capabilities"]["max_output_tokens"], 2048);
    s.restart().await;
    let (_, profiles) = s.get("/api/v1/model-profiles").await;
    assert_eq!(profiles[0]["capabilities"], p["capabilities"]);
    for options in [
        json!({"max_tokens":0}), json!({"max_tokens":4294967296_u64}), json!({"context_window":0}),
        json!({"capabilities":{"max_output_tokens":0}}), json!({"capabilities":{"images":"yes"}}),
        json!({"capabilities":{"extra":true}}), json!({"capabilities":{"pdf":true}}), json!({"capabilities":{"fast":true}}),
        json!({"temperature":1, "capabilities":{"temperature":false}}),
        json!({"max_tokens":3000, "capabilities":{"max_output_tokens":2000}}),
    ] {
        let (status, _) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{}", p["id"].as_str().unwrap()),
            json!({ "expected_revision": p["revision"], "options": options })).await;
        assert!(status.is_client_error());
    }
    let (status, renamed) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{}", p["id"].as_str().unwrap()),
        json!({ "expected_revision": p["revision"], "name": "renamed" })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(renamed["capabilities"], p["capabilities"]);
    let (status, switched) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{}", p["id"].as_str().unwrap()),
        json!({ "expected_revision": renamed["revision"], "model": "different" })).await;
    assert_eq!(status, StatusCode::OK);
    assert!(switched["capabilities"]["context_tokens"].is_null());
    assert!(switched["capabilities"]["max_output_tokens"].is_null());
    assert!(switched["capabilities"]["tools"].is_null());
    assert_eq!(switched["options"]["max_tokens"], 1000, "명시적인 요청 설정은 모델 지원 확인값과 구분한다");
    assert!(f.requests().is_empty());
}

#[tokio::test]
async fn unsupported_options_do_not_commit_messages_or_interrupt_other_work() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let p = profile(&s, &f, json!({ "capabilities": { "tools": false, "effort": false, "images": false } })).await;
    let project = s.create_project("capabilities").await;
    let sid = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    for extra in [json!({"tools":true}), json!({"effort":"high"})] {
        let mut body = json!({ "profile_id":p["id"], "text":"must not be stored" });
        for (key, value) in extra.as_object().unwrap() { body[key] = value.clone(); }
        let (status, error) = s.post(&format!("/api/v1/sessions/{sid}/turns"), body).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error["error"]["code"], "unsupported");
    }
    let (_, messages) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert!(messages["items"].as_array().unwrap().is_empty());
    assert!(f.requests().is_empty());
    let unrestricted = profile(&s, &f, json!({})).await;
    let (_, bot) = s.post("/api/v1/bots", json!({ "name":"bound", "project_id":project["id"], "profile_id":p["id"] })).await;
    let (_, home) = s.post(&format!("/api/v1/bots/{}/home", bot["id"].as_str().unwrap()), json!({})).await;
    let home_id = home["home_session_id"].as_str().unwrap();
    let (status, error) = s.post(&format!("/api/v1/sessions/{home_id}/turns"),
        json!({ "profile_id":unrestricted["id"], "text":"bot binding", "effort":"high" })).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
    assert_eq!(error["error"]["code"], "unsupported", "요청에 쓴 다른 프로필이 아니라 봇의 실제 프로필로 확인한다");
    let (status, thinking) = s.post("/api/v1/model-profiles", json!({
        "name":"limited thinking", "protocol":"anthropic", "base_url":f.base, "model":"fixture",
        "options":{"capabilities":{"max_output_tokens":512,"effort":true}},
    })).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, error) = s.post(&format!("/api/v1/sessions/{sid}/turns"),
        json!({ "profile_id":thinking["id"], "text":"over budget", "effort":"high" })).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(error["error"]["message"].as_str().unwrap().contains("출력 상한"));
    assert!(f.requests().is_empty(), "thinking 설정이 출력 상한을 임의로 늘리지 않는다");
    f.push(fixture::Step::Hang(vec![]));
    let (_, turn) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "profile_id":p["id"], "text":"authorized", "tools":false })).await;
    let tid = turn["turn"]["id"].as_str().unwrap();
    s.wait_status(tid, "running").await;
    let (status, error) = s.post(&format!("/api/v1/sessions/{sid}/followups"),
        json!({ "profile_id":p["id"], "text":"unsupported interrupt", "kind":"interrupt", "tools":true })).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error["error"]["code"], "unsupported");
    let (_, active) = s.get(&format!("/api/v1/turns/{tid}")).await;
    assert_eq!(active["status"], "running");
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    s.wait_status(tid, "cancelled").await;
    assert!(f.requests().iter().all(|r| !r.to_string().contains("unsupported interrupt")));
}

#[tokio::test]
async fn output_limit_is_sent_and_image_history_is_checked_after_model_changes() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let p = profile(&s, &f, json!({ "capabilities": { "max_output_tokens": 512, "images": true } })).await;
    let project = s.create_project("images").await;
    let pid = project["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(1, 1).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    let (status, attachment) = s.post(&format!("/api/v1/projects/{pid}/attachments"),
        json!({ "name":"pixel.png", "data_base64":STANDARD.encode(bytes.into_inner()) })).await;
    assert_eq!(status, StatusCode::CREATED);
    f.push(fixture::text("first"));
    let (_, turn) = s.post(&format!("/api/v1/sessions/{sid}/turns"),
        json!({ "profile_id":p["id"], "text":"image", "attachments":[attachment["id"]] })).await;
    s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(f.requests()[0]["max_tokens"], 512);
    assert!(f.requests()[0].get("temperature").is_none());
    let explicit = profile(&s, &f, json!({ "max_tokens":512 })).await;
    let (status, bounded) = s.get(&format!("/api/v1/sessions/{sid}/context?profile_id={}", p["id"].as_str().unwrap())).await;
    assert_eq!(status, StatusCode::OK);
    let (status, configured) = s.get(&format!("/api/v1/sessions/{sid}/context?profile_id={}", explicit["id"].as_str().unwrap())).await;
    assert_eq!(status, StatusCode::OK);
    assert!(configured["reserve_tokens"].is_number());
    assert_eq!(bounded["reserve_tokens"], configured["reserve_tokens"], "실제 요청 출력 상한과 컨텍스트 여유 계산은 같은 값을 쓴다");
    update(&s, &p, json!({ "capabilities": { "images":false } })).await;
    let (_, turn) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "profile_id":p["id"], "text":"next" })).await;
    let failed = s.wait_status(turn["turn"]["id"].as_str().unwrap(), "failed").await;
    assert_eq!(failed["error"]["code"], "unsupported");
    assert_eq!(f.requests().len(), 1, "현재 첨부가 없어도 이미지 이력을 미지원 모델에 보내지 않는다");
}

#[tokio::test]
async fn queued_followups_and_schedules_recheck_capabilities_before_execution() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let p = profile(&s, &f, json!({})).await;
    let project = s.create_project("queued").await;
    let pid = project["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    f.push(fixture::Step::Hang(vec![]));
    let (_, turn) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "profile_id":p["id"], "text":"first" })).await;
    let tid = turn["turn"]["id"].as_str().unwrap();
    s.wait_status(tid, "running").await;
    let (status, queued) = s.post(&format!("/api/v1/sessions/{sid}/followups"),
        json!({ "kind":"queue", "profile_id":p["id"], "text":"queued", "tools":true })).await;
    assert_eq!(status, StatusCode::CREATED);
    update(&s, &p, json!({ "capabilities": { "tools":false } })).await;
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    s.wait_status(tid, "cancelled").await;
    // 사용자 취소 뒤에는 기존 계약대로 자동 실행하지 않고 명시적으로 시작한다.
    let (status, error) = s.post(&format!("/api/v1/sessions/{sid}/followups/{}/start", queued["followup"]["id"].as_str().unwrap()), json!({})).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error["error"]["code"], "unsupported");
    let (_, queued) = s.get(&format!("/api/v1/sessions/{sid}/followups")).await;
    assert_eq!(queued["items"][0]["last_error"]["code"], "unsupported");
    assert_eq!(queued["items"][0]["text"], "queued", "다시 설정할 수 있도록 원래 요청을 보존한다");
    let (status, schedule) = s.post(&format!("/api/v1/projects/{pid}/schedules"),
        json!({ "name":"capability schedule", "prompt":"schedule", "profile_id":p["id"], "kind":"interval", "interval_minutes":600, "tools":true, "allowed_tools":["read"] })).await;
    assert_eq!(status, StatusCode::CREATED, "{schedule}");
    let (status, run) = s.post(&format!("/api/v1/schedules/{}/run", schedule["id"].as_str().unwrap()), json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(run["status"], "start_failed");
    assert!(run["turn_id"].is_null());
    assert!(f.requests().iter().all(|r| !r.to_string().contains("\"queued\"") && !r.to_string().contains("\"schedule\"")));
}
