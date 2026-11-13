//! MODEL-025: 명시적인 loopback HTTP endpoint만 사용하며 생성·상태·목록·대화를 연결한다.
mod common;

use common::{TestServer, fixture::{self, Fixture}};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::sync::Arc;

fn input(base: &str) -> Value {
    json!({"name":"local HTTP", "protocol":"openai", "base_url":base, "model":"manual-local"})
}

async fn current(s: &TestServer, id: &str) -> Value {
    let (_, profiles) = s.get("/api/v1/model-profiles").await;
    profiles.as_array().unwrap().iter().find(|p| p["id"] == id).unwrap().clone()
}

#[tokio::test]
async fn explicit_local_profiles_need_no_key_and_replayed_creation_and_turns_are_unique() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let body = input(&format!("{}/", f.base));
    // 응답을 버린 뒤 receipt를 확인해도 프로필은 하나다.
    let first = s.raw(Method::POST, "/api/v1/model-profiles", Some(body.clone()), Some("local-create"), None).await;
    assert_eq!(first.status(), StatusCode::CREATED);
    drop(first);
    let replay = s.raw(Method::POST, "/api/v1/model-profiles", Some(body), Some("local-create"), None).await;
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    let p = replay.json::<Value>().await.unwrap();
    let id = p["id"].as_str().unwrap();
    assert_eq!(p["base_url"], f.base);
    assert!(p["secret_id"].is_null() && p["last_check"].is_null());
    assert_eq!(s.get("/api/v1/model-profiles").await.1.as_array().unwrap().len(), 1);
    assert!(f.requests().is_empty(), "저장만으로 endpoint를 호출하거나 생성하지 않는다");
    let (status, check) = s.post(&format!("/api/v1/model-profiles/{id}/check"), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(check["ok"], true);
    assert_eq!(check["detail"]["model_listed"], false);
    let (status, catalog) = s.get(&format!("/api/v1/model-profiles/{id}/models")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(catalog["profile_revision"], p["revision"]);
    assert_eq!(current(&s, id).await["model"], "manual-local", "조회는 모델을 선택하지 않는다");
    assert!(f.requests().is_empty());
    let (status, chosen) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{id}"),
        json!({"expected_revision":catalog["profile_revision"], "model":"fixture-model",
            "options":{"capabilities":{"tools":false}}})).await;
    assert_eq!(status, StatusCode::OK, "{chosen}");
    assert!(chosen["last_check"].is_null());
    assert_eq!(s.send(Method::PUT, &format!("/api/v1/model-profiles/{id}"),
        json!({"expected_revision":p["revision"], "model":"other"})).await.0, StatusCode::CONFLICT);
    let project = s.create_project("local-conversation").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap();
    f.push(fixture::text("local response"));
    let request = json!({"profile_id":id, "text":"explicit local conversation", "tools":false});
    let path = format!("/api/v1/sessions/{sid}/turns");
    let first = s.raw(Method::POST, &path, Some(request.clone()), Some("local-turn"), None).await;
    assert_eq!(first.status(), StatusCode::ACCEPTED);
    let turn = first.json::<Value>().await.unwrap();
    s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
    let replay = s.raw(Method::POST, &path, Some(request), Some("local-turn"), None).await;
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    assert_eq!(replay.json::<Value>().await.unwrap()["turn"]["id"], turn["turn"]["id"]);
    assert_eq!(f.requests().len(), 1);
    assert_eq!(f.requests()[0]["model"], "fixture-model");
    assert!(!f.headers(0).contains_key("authorization"), "가짜 키를 만들지 않는다");
    s.restart().await;
    assert_eq!(current(&s, id).await["model"], "fixture-model");
    assert_eq!(s.get(&format!("/api/v1/sessions/{sid}/messages")).await.1["items"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn local_secret_references_remain_masked_and_endpoint_changes_clear_checks_and_capabilities() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let id = s.fixture_profile(&f.base).await;
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{id}"),
        json!({"expected_revision":1, "options":{"capabilities":{"tools":false}, "context_window":4096}})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(s.post(&format!("/api/v1/model-profiles/{id}/check"), json!({})).await.1["ok"], true);
    let p = current(&s, &id).await;
    let (status, changed) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{id}"),
        json!({"expected_revision":p["revision"], "base_url":f.base.replace("/v1", "/bad")})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(changed["last_check"].is_null());
    assert!(changed["options"].get("capabilities").is_none());
    assert!(changed["options"].get("context_window").is_none());
    let (_, failed) = s.post(&format!("/api/v1/model-profiles/{id}/check"), json!({})).await;
    assert_eq!(failed["ok"], false);
    assert_eq!(failed["code"], "auth_failed");
    assert!(failed["message"].as_str().unwrap().contains("[redacted]"));
    let (_, secrets) = s.get("/api/v1/secrets").await;
    for value in [failed, secrets, s.get("/api/v1/model-profiles").await.1] {
        assert!(!value.to_string().contains("sk-test-secret-value-1234"));
    }
    let (status, restored) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{id}"),
        json!({"expected_revision":changed["revision"], "base_url":f.base})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(restored["last_check"].is_null());
    f.push(fixture::text("authenticated local response"));
    let project = s.create_project("authenticated-local").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    let (_, turn) = s.post(&format!("/api/v1/sessions/{}/turns", session["id"].as_str().unwrap()),
        json!({"profile_id":id, "text":"authenticated local prompt", "tools":false})).await;
    s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(f.headers(0)["authorization"], "Bearer sk-test-secret-value-1234");
}

#[tokio::test]
async fn local_profile_inputs_reject_url_credentials_and_mutations_and_catalogs_require_owner() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let (_, p) = s.post("/api/v1/model-profiles", input(&f.base)).await;
    let path = format!("/api/v1/model-profiles/{}", p["id"].as_str().unwrap());
    for base in ["http://", "http://user:fixture@127.0.0.1:8000/v1",
        "http://127.0.0.1:8000/v1?key=fixture", "http://127.0.0.1:8000/v1#fixture", "ollama://localhost"] {
        let (status, error) = s.post("/api/v1/model-profiles", input(base)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
        assert!(!error.to_string().contains("user:fixture"));
        assert_eq!(s.send(Method::PUT, &path, json!({"expected_revision":p["revision"], "base_url":base})).await.0, StatusCode::BAD_REQUEST);
    }
    let mut unsupported = input(&f.base);
    unsupported["protocol"] = json!("ollama");
    assert_eq!(s.post("/api/v1/model-profiles", unsupported).await.0, StatusCode::BAD_REQUEST);
    let (_, device) = s.post("/api/v1/devices", json!({"name":"local non-owner"})).await;
    for token in ["", device["token"].as_str().unwrap()] {
        let expected = if token.is_empty() { StatusCode::UNAUTHORIZED } else { StatusCode::FORBIDDEN };
        for (method, url, body) in [
            (Method::POST, "/api/v1/model-profiles".to_string(), Some(input(&f.base))),
            (Method::PUT, path.clone(), Some(json!({"expected_revision":1, "model":"other"}))),
            (Method::DELETE, path.clone(), None),
            (Method::GET, format!("{path}/models"), None),
        ] {
            assert_eq!(s.raw(method, &url, body, Some("not-owner"), Some(token)).await.status(), expected);
        }
    }
    assert_eq!(current(&s, p["id"].as_str().unwrap()).await["model"], "manual-local");
    assert!(f.requests().is_empty());
}

struct CatalogFixture {
    base: String,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    task: tokio::task::JoinHandle<()>,
}

impl CatalogFixture {
    async fn start() -> Self {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let (started, resume) = (entered.clone(), release.clone());
        let app = axum::Router::new().route("/{mode}/models", axum::routing::get(move |axum::extract::Path(mode): axum::extract::Path<String>| {
            let (started, resume) = (started.clone(), resume.clone());
            async move {
                axum::Json(match mode.as_str() {
                    "slow" => { started.notify_one(); resume.notified().await; json!({"data":[{"id":"old-local"}]}) }
                    "empty" => json!({"data":[]}),
                    "good" => json!({"data":[{"id":"manual-local"}]}),
                    _ => json!({"models":["native Ollama is not OpenAI-compatible"]}),
                })
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        Self { base, entered, release, task }
    }
}
impl Drop for CatalogFixture { fn drop(&mut self) { self.task.abort(); } }

#[tokio::test]
async fn local_catalog_failures_empty_lists_and_reconnect_keep_manual_models_and_reject_racing_changes() {
    let s = TestServer::start().await;
    let f = CatalogFixture::start().await;
    let (_, mut p) = s.post("/api/v1/model-profiles", input(&format!("{}/bad", f.base))).await;
    let id = p["id"].as_str().unwrap().to_string();
    let path = format!("/api/v1/model-profiles/{id}");
    for (mode, ok) in [("bad", false), ("empty", true), ("good", true)] {
        let (_, next) = s.send(Method::PUT, &path, json!({"expected_revision":p["revision"], "base_url":format!("{}/{mode}", f.base)})).await;
        p = next;
        let (_, check) = s.post(&format!("{path}/check"), json!({})).await;
        assert_eq!(check["ok"], ok);
        let (status, catalog) = s.get(&format!("{path}/models")).await;
        assert_eq!(status, if ok { StatusCode::OK } else { StatusCode::BAD_GATEWAY });
        if mode == "empty" { assert_eq!(catalog["models"], json!([])); }
        if !ok { assert_eq!(check["code"], "catalog_invalid"); }
        assert_eq!(current(&s, &id).await["model"], "manual-local");
    }
    for suffix in ["models", "check"] {
        let (_, next) = s.send(Method::PUT, &path, json!({"expected_revision":p["revision"], "base_url":format!("{}/slow", f.base)})).await;
        p = next;
        let client = s.client.clone();
        let (token, base, request_path) = (s.token.clone(), s.base.clone(), format!("{path}/{suffix}"));
        let pending = tokio::spawn(async move {
            let method = if suffix == "models" { Method::GET } else { Method::POST };
            let r = client.request(method, format!("{base}{request_path}")).bearer_auth(token)
                .header("Idempotency-Key", "local-race").send().await.unwrap();
            (r.status(), r.json::<Value>().await.unwrap())
        });
        tokio::time::timeout(std::time::Duration::from_secs(3), f.entered.notified()).await.unwrap();
        let (_, next) = s.send(Method::PUT, &path, json!({"expected_revision":p["revision"], "base_url":format!("{}/good", f.base), "model":"explicit-new"})).await;
        p = next;
        f.release.notify_one();
        let (status, error) = tokio::time::timeout(std::time::Duration::from_secs(3), pending).await.unwrap().unwrap();
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error["error"]["code"], if suffix == "models" { "revision_conflict" } else { "profile_changed" });
        assert!(current(&s, &id).await["last_check"].is_null());
    }
    // 사용하지 않은 전용 listener의 주소로 연결 거부를 재현한다.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gone = format!("http://{}/v1", listener.local_addr().unwrap());
    drop(listener);
    let (_, next) = s.send(Method::PUT, &path, json!({"expected_revision":p["revision"], "base_url":gone})).await;
    let (_, check) = s.post(&format!("{path}/check"), json!({})).await;
    assert_eq!(check["ok"], false);
    assert_eq!(check["code"], "connect_failed");
    assert_eq!(current(&s, &id).await["model"], "explicit-new");
    let (status, _) = s.send(Method::PUT, &path, json!({"expected_revision":next["revision"], "base_url":format!("{}/good", f.base)})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(s.post(&format!("{path}/check"), json!({})).await.1["ok"], true);
}
