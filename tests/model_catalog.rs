mod common;

use axum::{Json, Router, http::{HeaderMap, Method as HttpMethod, Uri}, routing::any};
use common::{TestServer, fixture::{self, Fixture}};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::{Arc, Mutex}};

const KEY: &str = "catalog-fixture-value-1234";
const CURSOR: &str = "https://not-a-destination.invalid/path?value=cursor";

#[derive(Clone)]
struct Call { path: String, query: HashMap<String, String>, authenticated: bool, method: HttpMethod }

struct CatalogServer {
    base: String, calls: Arc<Mutex<Vec<Call>>>, task: tokio::task::JoinHandle<()>,
    entered: Arc<tokio::sync::Notify>, release: Arc<tokio::sync::Notify>,
}
impl CatalogServer {
    async fn start() -> Self {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let (started, resume) = (entered.clone(), release.clone());
        let app = Router::new().fallback(any(move |method: HttpMethod, uri: Uri, headers: HeaderMap| {
            let seen = seen.clone();
            let (started, resume) = (started.clone(), resume.clone());
            async move {
                let parsed = reqwest::Url::parse(&format!("http://fixture{uri}")).unwrap();
                let query: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
                let authenticated = if uri.path().contains("/v1beta/") {
                    headers.get("x-goog-api-key").is_some_and(|h| h == KEY)
                } else if uri.path().ends_with("/v1/models") {
                    headers.get("x-api-key").is_some_and(|h| h == KEY)
                } else {
                    headers.get("authorization").and_then(|h| h.to_str().ok()) == Some(format!("Bearer {KEY}").as_str())
                };
                seen.lock().unwrap().push(Call { path: uri.path().into(), query: query.clone(), authenticated, method });
                let body = match uri.path() {
                    "/openai/models" => json!({ "data": [{ "id": "z" }, { "id": "a" }, { "id": "a" }] }),
                    "/anthropic/v1/models" if query.get("after_id").map(String::as_str) == Some(CURSOR) =>
                        json!({ "data": [{ "id": "z", "display_name": "Zulu" }, { "id": "a", "display_name": "Alpha" }], "has_more": false, "last_id": "z" }),
                    "/anthropic/v1/models" =>
                        json!({ "data": [{ "id": "a", "display_name": "Alpha" }], "has_more": true, "last_id": CURSOR }),
                    "/gemini/v1beta/models" if query.get("pageToken").map(String::as_str) == Some(CURSOR) =>
                        json!({ "models": [{ "name": "models/a", "displayName": "Alpha", "supportedGenerationMethods": ["generateContent"] }, { "name": "a" }] }),
                    "/gemini/v1beta/models" =>
                        json!({ "models": [{ "name": "models/z", "displayName": "Zulu", "supportedGenerationMethods": ["generateContent"] },
                            { "name": "models/embed", "supportedGenerationMethods": ["embedContent"] }], "nextPageToken": CURSOR }),
                    "/cycle/v1/models" => json!({ "data": [{ "id": "a" }], "has_more": true, "last_id": "repeat" }),
                    "/secret/models" => json!({ "data": [{ "id": KEY }] }),
                    "/empty/v1beta/models" => json!({}),
                    "/large/models" => json!({ "data": (0..2001).map(|id| json!({ "id": format!("model-{id}") })).collect::<Vec<_>>() }),
                    "/slow/models" => {
                        started.notify_one();
                        resume.notified().await;
                        json!({ "data": [{ "id": "before-change" }] })
                    }
                    _ => json!({ "unexpected": "not a model catalog" }),
                };
                Json(body)
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        Self { base, calls, task, entered, release }
    }
}
impl Drop for CatalogServer { fn drop(&mut self) { self.task.abort(); } }

async fn profile(s: &TestServer, stub: &CatalogServer, protocol: &str, prefix: &str) -> Value {
    let (status, secret) = s.post("/api/v1/secrets", json!({ "label": prefix, "value": KEY })).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, profile) = s.post("/api/v1/model-profiles", json!({
        "name": prefix, "protocol": protocol, "base_url": format!("{}{prefix}", stub.base), "model": "manual-model",
        "secret_id": secret["id"],
    })).await;
    assert_eq!(status, StatusCode::CREATED);
    profile
}

#[tokio::test]
async fn catalogs_follow_all_provider_pages_normalize_ids_and_do_not_change_manual_configuration() {
    let s = TestServer::start().await;
    let stub = CatalogServer::start().await;
    for (protocol, prefix) in [("openai", "/openai"), ("anthropic", "/anthropic"), ("gemini", "/gemini")] {
        let p = profile(&s, &stub, protocol, prefix).await;
        assert_eq!(p["enabled"], true);
        let (status, catalog) = s.get(&format!("/api/v1/model-profiles/{}/models", p["id"].as_str().unwrap())).await;
        assert_eq!(status, StatusCode::OK, "{catalog}");
        assert_eq!(catalog["profile_revision"], p["revision"]);
        let ids: Vec<&str> = catalog["models"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["a", "z"]);
        assert!(!catalog.to_string().contains(KEY));
        let (_, profiles) = s.get("/api/v1/model-profiles").await;
        assert_eq!(profiles.as_array().unwrap().iter().find(|m| m["id"] == p["id"]).unwrap()["model"], "manual-model");
    }
    let calls = stub.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 5);
    assert!(calls.iter().all(|call| call.authenticated && call.method == HttpMethod::GET));
    assert!(calls.iter().any(|call| call.query.get("after_id").map(String::as_str) == Some(CURSOR)));
    assert!(calls.iter().any(|call| call.query.get("pageToken").map(String::as_str) == Some(CURSOR)));
    assert!(calls.iter().all(|call| ["/openai/models", "/anthropic/v1/models", "/gemini/v1beta/models"].contains(&call.path.as_str())));
}

#[tokio::test]
async fn malformed_cycle_and_secret_echo_are_errors_not_successful_empty_or_partial_catalogs() {
    let s = TestServer::start().await;
    let stub = CatalogServer::start().await;
    for (protocol, prefix) in [("openai", "/bad"), ("anthropic", "/cycle"), ("openai", "/secret")] {
        let p = profile(&s, &stub, protocol, prefix).await;
        let (status, error) = s.get(&format!("/api/v1/model-profiles/{}/models", p["id"].as_str().unwrap())).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(error["error"]["code"], "catalog_invalid");
        assert!(!error.to_string().contains(KEY));
        if prefix == "/bad" {
            let (_, check) = s.post(&format!("/api/v1/model-profiles/{}/check", p["id"].as_str().unwrap()), json!({})).await;
            assert_eq!(check["ok"], false);
            assert_eq!(check["code"], "catalog_invalid");
        }
    }
    assert_eq!(stub.calls.lock().unwrap().iter().filter(|call| call.path == "/cycle/v1/models").count(), 2);
}

#[tokio::test]
async fn disabled_profiles_persist_and_block_new_turns_without_messages_or_silent_fallback() {
    let mut s = TestServer::start().await;
    let fixture = Fixture::start().await;
    let pid = s.fixture_profile(&fixture.base).await;
    let project = s.create_project("disabled-profile").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap();
    let (status, disabled) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{pid}"), json!({ "expected_revision": 1, "enabled": false })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(disabled["enabled"], false);
    let body = json!({ "profile_id": pid, "text": "do not send", "tools": false });
    let (status, error) = s.post(&format!("/api/v1/sessions/{sid}/turns"), body.clone()).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "profile_disabled");
    assert_eq!(s.get(&format!("/api/v1/sessions/{sid}/messages")).await.1["items"], json!([]));
    assert!(fixture.requests().is_empty());
    assert_eq!(s.post(&format!("/api/v1/model-profiles/{pid}/check"), json!({})).await.1["ok"], true);
    assert_eq!(s.get(&format!("/api/v1/model-profiles/{pid}/models")).await.0, StatusCode::OK);
    s.restart().await;
    assert_eq!(s.post(&format!("/api/v1/sessions/{sid}/turns"), body.clone()).await.0, StatusCode::CONFLICT);
    let (_, enabled) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{pid}"), json!({ "expected_revision": disabled["revision"], "enabled": true })).await;
    assert_eq!(enabled["enabled"], true);
    fixture.push(fixture::text("enabled"));
    let (status, turn) = s.post(&format!("/api/v1/sessions/{sid}/turns"), body).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(fixture.requests().len(), 1);
}

#[tokio::test]
async fn active_turns_prevent_disabling_and_devices_cannot_refresh_owner_catalogs() {
    let s = TestServer::start().await;
    let fixture = Fixture::start().await;
    let pid = s.fixture_profile(&fixture.base).await;
    let project = s.create_project("profile-busy").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    fixture.push(fixture::hang_after("started"));
    let (_, turn) = s.post(&format!("/api/v1/sessions/{}/turns", session["id"].as_str().unwrap()),
        json!({ "profile_id": pid, "text": "hold", "tools": false })).await;
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{pid}"), json!({ "expected_revision": 1, "enabled": false })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (_, device) = s.post("/api/v1/devices", json!({ "name": "device" })).await;
    let response = s.raw(Method::GET, &format!("/api/v1/model-profiles/{pid}/models"), None, None, Some(device["token"].as_str().unwrap())).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let tid = turn["turn"]["id"].as_str().unwrap();
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    s.wait_status(tid, "cancelled").await;
    assert_eq!(s.send(Method::PUT, &format!("/api/v1/model-profiles/{pid}"), json!({ "expected_revision": 1, "enabled": false })).await.0, StatusCode::OK);
}

#[tokio::test]
async fn pre_upgrade_create_receipts_still_replay_with_the_default_enabled_state() {
    let s = TestServer::start().await;
    let body = json!({ "name": "legacy", "protocol": "openai", "base_url": "http://127.0.0.1:9/v1", "model": "manual" });
    let (_, profile) = s.post("/api/v1/model-profiles", body.clone()).await;
    let owner = grove::auth::parse_token(&s.token).unwrap().0.to_string();
    let hash = grove::idem::body_hash("profile.create", &json!({
        "n": "legacy", "p": "openai", "u": "http://127.0.0.1:9/v1", "m": "manual", "s": null, "o": {},
    }));
    let mut historical = profile.clone();
    historical.as_object_mut().unwrap().remove("enabled");
    let stored = historical.clone();
    s.server.as_ref().unwrap().app.db.call(move |c| {
        c.execute("INSERT INTO idempotency(owner_id,key,request_hash,status,response,created_at) VALUES (?1,'legacy-profile',?2,201,?3,'2026-01-01T00:00:00Z')",
            rusqlite::params![owner, hash, stored.to_string()])?;
        Ok(())
    }).await.unwrap();
    for enabled in [None, Some(true)] {
        let mut request = body.clone();
        if let Some(enabled) = enabled { request["enabled"] = json!(enabled); }
        let response = s.raw(Method::POST, "/api/v1/model-profiles", Some(request), Some("legacy-profile"), None).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(response.headers()["idempotent-replayed"], "true");
        assert_eq!(response.json::<Value>().await.unwrap(), historical);
    }
    let mut changed = body;
    changed["enabled"] = json!(false);
    assert_eq!(s.raw(Method::POST, "/api/v1/model-profiles", Some(changed), Some("legacy-profile"), None).await.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn empty_and_oversized_catalogs_are_distinguished_and_profile_changes_reject_stale_results() {
    let s = TestServer::start().await;
    let stub = CatalogServer::start().await;
    let empty = profile(&s, &stub, "gemini", "/empty").await;
    let (_, catalog) = s.get(&format!("/api/v1/model-profiles/{}/models", empty["id"].as_str().unwrap())).await;
    assert_eq!(catalog["models"], json!([]));
    let large = profile(&s, &stub, "openai", "/large").await;
    let (status, error) = s.get(&format!("/api/v1/model-profiles/{}/models", large["id"].as_str().unwrap())).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(error["error"]["code"], "catalog_too_large");
    let slow = profile(&s, &stub, "openai", "/slow").await;
    let id = slow["id"].as_str().unwrap();
    let request = s.client.get(format!("{}/api/v1/model-profiles/{id}/models", s.base)).bearer_auth(&s.token);
    let waiting = tokio::spawn(async move { request.send().await.unwrap() });
    tokio::time::timeout(std::time::Duration::from_secs(5), stub.entered.notified()).await.unwrap();
    assert_eq!(s.send(Method::PUT, &format!("/api/v1/model-profiles/{id}"), json!({ "expected_revision": slow["revision"], "model": "after-change" })).await.0, StatusCode::OK);
    stub.release.notify_one();
    let response = waiting.await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(response.json::<Value>().await.unwrap()["error"]["code"], "revision_conflict");
}

#[tokio::test]
async fn bot_readiness_tracks_profile_activation_without_losing_its_configuration() {
    let s = TestServer::start().await;
    let fixture = Fixture::start().await;
    let pid = s.fixture_profile(&fixture.base).await;
    let project = s.create_project("bot-profile").await;
    let (status, bot) = s.post("/api/v1/bots", json!({ "name": "activation", "project_id": project["id"], "profile_id": pid })).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(bot["runnable"], true);
    let (_, disabled) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{pid}"), json!({ "expected_revision": 1, "enabled": false })).await;
    let (_, list) = s.get("/api/v1/bots").await;
    let current = list["bots"].as_array().unwrap().iter().find(|entry| entry["id"] == bot["id"]).unwrap();
    assert_eq!(current["runnable"], false);
    assert_eq!(current["model_state"], "disabled");
    assert_eq!(current["profile_id"], pid);
    s.send(Method::PUT, &format!("/api/v1/model-profiles/{pid}"), json!({ "expected_revision": disabled["revision"], "enabled": true })).await;
    let (_, list) = s.get("/api/v1/bots").await;
    let current = list["bots"].as_array().unwrap().iter().find(|entry| entry["id"] == bot["id"]).unwrap().clone();
    assert_eq!((&current["runnable"], &current["model_state"]), (&json!(true), &json!("ok")));
    // BOT-002-B: 삭제된 프로필은 미설정과 구분하고 다른 모델로 대체하지 않는다.
    let (st, _) = s.send(Method::DELETE, &format!("/api/v1/model-profiles/{pid}"), json!({})).await;
    assert!(st.is_success());
    let (_, current) = s.get(&format!("/api/v1/bots/{}", bot["id"].as_str().unwrap())).await;
    assert_eq!((&current["runnable"], &current["model_state"], &current["profile_id"]), (&json!(false), &json!("deleted"), &json!(pid)));
    let (_, home) = s.post(&format!("/api/v1/bots/{}/home", bot["id"].as_str().unwrap()), json!({})).await;
    let (st, e) = s.post(&format!("/api/v1/sessions/{}/turns", home["home_session_id"].as_str().unwrap()), json!({ "text": "x", "profile_id": "ignored" })).await;
    assert_eq!((st, e["error"]["code"].as_str()), (StatusCode::CONFLICT, Some("model_deleted")));
    assert!(fixture.requests().is_empty());
}

#[tokio::test]
async fn doctor_does_not_report_previously_verified_but_disabled_profiles_as_usable() {
    let s = TestServer::start().await;
    let fixture = Fixture::start().await;
    let pid = s.fixture_profile(&fixture.base).await;
    assert_eq!(s.post(&format!("/api/v1/model-profiles/{pid}/check"), json!({})).await.1["ok"], true);
    assert_eq!(s.send(Method::PUT, &format!("/api/v1/model-profiles/{pid}"), json!({ "expected_revision": 1, "enabled": false })).await.0, StatusCode::OK);
    let data = s.data_dir();
    let listen = s.server.as_ref().unwrap().addr.to_string();
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new(env!("CARGO_BIN_EXE_grove")).arg("doctor").arg("--data-dir").arg(data).args(["--listen", &listen]).output().unwrap()
    }).await.unwrap();
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["models"]["status"], "disabled");
    assert_eq!(report["models"]["enabled"], 0);
    assert_eq!(report["models"]["disabled"], 1);
    assert_eq!(report["models"]["verified"], 0);
    assert_eq!(report["healthy"], false);
    assert!(fixture.requests().is_empty(), "진단은 생성 요청을 보내지 않는다");
}

#[tokio::test]
async fn public_header_values_matching_model_ids_are_not_treated_as_credentials() {
    let s = TestServer::start().await;
    let stub = CatalogServer::start().await;
    let p = profile(&s, &stub, "openai", "/openai").await;
    let id = p["id"].as_str().unwrap();
    let (status, updated) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{id}"),
        json!({ "expected_revision": p["revision"], "options": { "headers": { "x-client-version": "a" } } })).await;
    assert_eq!(status, StatusCode::OK);
    let (status, catalog) = s.get(&format!("/api/v1/model-profiles/{id}/models")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(catalog["models"].as_array().unwrap().iter().any(|model| model["id"] == "a"));
    let (status, credential) = s.post("/api/v1/secrets", json!({"label":"catalog fixture credential","value":"a"})).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(s.send(Method::PUT, &format!("/api/v1/model-profiles/{id}"),
        json!({ "expected_revision": updated["revision"], "options": { "headers": { "x-custom-credential": {"secret_id":credential["id"]} } } })).await.0, StatusCode::OK);
    let (status, error) = s.get(&format!("/api/v1/model-profiles/{id}/models")).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(error["error"]["code"], "catalog_invalid");
    assert!(error.get("models").is_none(), "자격으로 분류한 값과 일치하는 모델 식별자는 반환하지 않는다");
}

#[tokio::test]
async fn profile_update_receipts_distinguish_keep_secret_from_explicit_detachment() {
    let s = TestServer::start().await;
    let stub = CatalogServer::start().await;
    let profile = profile(&s, &stub, "openai", "/openai").await;
    let path = format!("/api/v1/model-profiles/{}", profile["id"].as_str().unwrap());
    let keep = json!({ "expected_revision": profile["revision"], "name": "renamed" });
    let response = s.raw(Method::PUT, &path, Some(keep.clone()), Some("secret-intent"), None).await;
    assert_eq!(response.status(), StatusCode::OK);
    let kept: Value = response.json().await.unwrap();
    assert_eq!(kept["secret_id"], profile["secret_id"]);
    let mut detach = keep;
    detach["secret_id"] = Value::Null;
    let response = s.raw(Method::PUT, &path, Some(detach), Some("secret-intent"), None).await;
    assert_eq!(response.status(), StatusCode::CONFLICT, "생략과 명시적 null은 같은 변경이 아니다");
    let (status, detached) = s.send(Method::PUT, &path, json!({ "expected_revision": kept["revision"], "secret_id": null })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detached["secret_id"], Value::Null);
}
