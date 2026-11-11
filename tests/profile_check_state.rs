//! 연결 확인은 실제로 검사한 대상에만 적용하고, 늦은 응답이 새 설정을 덮어쓰지 않는다.
mod common;

use common::{TestServer, fixture::Fixture};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::sync::Arc;

async fn current(s: &TestServer, id: &str) -> Value {
    let (_, profiles) = s.get("/api/v1/model-profiles").await;
    profiles.as_array().unwrap().iter().find(|p| p["id"] == id).unwrap().clone()
}

async fn change(s: &TestServer, profile: &Value, patch: Value) -> Value {
    let mut body = patch;
    body["expected_revision"] = profile["revision"].clone();
    let (status, updated) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{}", profile["id"].as_str().unwrap()), body).await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    updated
}

async fn check(s: &TestServer, id: &str) {
    let (status, checked) = s.post(&format!("/api/v1/model-profiles/{id}/check"), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(checked["ok"], true);
}

#[tokio::test]
async fn cached_checks_follow_target_changes_but_not_display_only_edits() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let id = s.fixture_profile(&f.base).await;
    check(&s, &id).await;
    let p = change(&s, &current(&s, &id).await, json!({"name":"new display"})).await;
    assert_eq!(p["last_check"]["ok"], true);
    let p = change(&s, &p, json!({"model":"other"})).await;
    assert!(p["last_check"].is_null(), "이전 모델을 확인한 결과는 새 모델의 확인 결과가 아니다");
    check(&s, &id).await;
    let p = change(&s, &current(&s, &id).await, json!({"options":{"headers":{"X-Scope":"public"}}})).await;
    assert!(p["last_check"].is_null());
    check(&s, &id).await;
    let p = change(&s, &current(&s, &id).await, json!({"options":{"headers":{"x-scope":"public"}}})).await;
    assert_eq!(p["last_check"]["ok"], true, "헤더 이름 대소문자만 바뀌면 실제 확인 대상은 같다");
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/secrets/{}", p["secret_id"].as_str().unwrap()),
        json!({"label":"new label", "value":" sk-test-secret-value-1234 "})).await;
    assert_eq!(status, StatusCode::OK);
    let unchanged = current(&s, &id).await;
    assert_eq!(unchanged["revision"], p["revision"]);
    assert_eq!(unchanged["last_check"]["ok"], true, "정규화 후 같은 키의 표시 편집은 유효한 확인 결과를 지우지 않는다");
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/secrets/{}", p["secret_id"].as_str().unwrap()),
        json!({"label":"replaced", "value":"synthetic-replacement-key"})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(current(&s, &id).await["last_check"].is_null(), "참조 ID가 같아도 키 교체 뒤에는 다시 확인한다");
    check(&s, &id).await;
    let p = change(&s, &current(&s, &id).await, json!({"secret_id":null})).await;
    assert!(p["last_check"].is_null());
    assert!(f.requests().is_empty(), "검증/복구에 추론 호출을 사용하지 않는다");
}

struct SlowModels {
    base: String,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    task: tokio::task::JoinHandle<()>,
}

#[tokio::test]
async fn explicitly_replacing_an_unreadable_old_key_recovers_without_keeping_its_check() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let id = s.fixture_profile(&f.base).await;
    check(&s, &id).await;
    let p = current(&s, &id).await;
    let secret = p["secret_id"].as_str().unwrap().to_string();
    let corrupted = secret.clone();
    s.server.as_ref().unwrap().app.db.call(move |c| {
        // vault의 문서화된 v1:base64 형식에서 base64가 깨진 격리된 시험 행.
        c.execute("UPDATE secrets SET value='v1:not-valid-base64!' WHERE id=?1", [&corrupted])?;
        let unreadable: Option<String> = c.query_row("SELECT grove_try_decrypt(value) FROM secrets WHERE id=?1", [&corrupted], |row| row.get(0))?;
        assert!(unreadable.is_none());
        Ok(())
    }).await.unwrap();
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/secrets/{secret}"),
        json!({"label":"recovered", "value":"synthetic-recovered-key"})).await;
    assert_eq!(status, StatusCode::OK);
    let recovered = current(&s, &id).await;
    assert!(recovered["last_check"].is_null());
    assert!(recovered["revision"].as_i64().unwrap() > p["revision"].as_i64().unwrap());
    s.server.as_ref().unwrap().app.db.call(move |c| {
        let (stored, plain): (String, String) = c.query_row("SELECT value,grove_decrypt(value) FROM secrets WHERE id=?1", [secret], |row| Ok((row.get(0)?, row.get(1)?)))?;
        assert!(!stored.contains("synthetic-recovered-key"));
        assert_eq!(plain, "synthetic-recovered-key");
        Ok(())
    }).await.unwrap();
    check(&s, &id).await;
}

impl SlowModels {
    async fn start() -> Self {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let (started, resume) = (entered.clone(), release.clone());
        let app = axum::Router::new().route("/v1/models", axum::routing::get(move || {
            let (started, resume) = (started.clone(), resume.clone());
            async move {
                started.notify_one();
                resume.notified().await;
                axum::Json(json!({"data":[{"id":"original"}]}))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        Self { base, entered, release, task }
    }
}
impl Drop for SlowModels { fn drop(&mut self) { self.task.abort(); } }

#[tokio::test]
async fn delayed_checks_cannot_publish_results_for_a_different_current_target() {
    for kind in ["model", "endpoint", "key", "headers", "name", "catalog_key", "header_key"] {
        let s = TestServer::start().await;
        let f = SlowModels::start().await;
        let (_, secret) = s.post("/api/v1/secrets", json!({"label":"initial", "value":"synthetic-original-key"})).await;
        let header_secret = if kind == "header_key" {
            Some(s.post("/api/v1/secrets", json!({"label":"header initial","value":"synthetic-original-header"})).await.1)
        } else { None };
        let options = header_secret.as_ref().map_or(json!({}), |secret| json!({"headers":{"X-Client-Name":{"secret_id":secret["id"]}}}));
        let (status, p) = s.post("/api/v1/model-profiles", json!({
            "name":"original", "protocol":"openai", "base_url":f.base, "model":"original", "secret_id":secret["id"],
            "options":options,
        })).await;
        assert_eq!(status, StatusCode::CREATED);
        let id = p["id"].as_str().unwrap();
        let suffix = if kind == "catalog_key" { "models" } else { "check" };
        let method = if kind == "catalog_key" { Method::GET } else { Method::POST };
        let request = s.client.request(method, format!("{}/api/v1/model-profiles/{id}/{suffix}", s.base))
            .bearer_auth(&s.token).header("Idempotency-Key", s.key());
        let request = if kind == "catalog_key" { request } else { request.json(&json!({})) };
        let pending = tokio::spawn(async move {
            let response = request.send().await.unwrap();
            (response.status(), response.json::<Value>().await.unwrap())
        });
        tokio::time::timeout(std::time::Duration::from_secs(3), f.entered.notified()).await.unwrap();
        match kind {
            "key" | "catalog_key" => {
                let (status, _) = s.send(Method::PUT, &format!("/api/v1/secrets/{}", secret["id"].as_str().unwrap()),
                    json!({"label":"updated", "value":"synthetic-new-key"})).await;
                assert_eq!(status, StatusCode::OK);
            }
            "header_key" => {
                let (status, _) = s.send(Method::PUT, &format!("/api/v1/secrets/{}", header_secret.as_ref().unwrap()["id"].as_str().unwrap()),
                    json!({"label":"header updated", "value":"synthetic-new-header"})).await;
                assert_eq!(status, StatusCode::OK);
            }
            _ => {
                let patch = match kind {
                    "model" => json!({"model":"different"}),
                    "endpoint" => json!({"base_url":format!("{}/different", f.base)}),
                    "headers" => json!({"options":{"headers":{"x-scope":"different"}}}),
                    _ => json!({"name":"display only"}),
                };
                change(&s, &p, patch).await;
            }
        }
        f.release.notify_one();
        let (status, result) = tokio::time::timeout(std::time::Duration::from_secs(3), pending).await.unwrap().unwrap();
        if kind == "name" {
            assert_eq!(status, StatusCode::OK);
            assert_eq!(result["ok"], true);
            assert_eq!(current(&s, id).await["last_check"]["ok"], true);
        } else {
            assert_eq!(status, StatusCode::CONFLICT, "{kind}: {result}");
            assert_eq!(result["error"]["code"], if kind == "catalog_key" { "revision_conflict" } else { "profile_changed" });
            assert!(current(&s, id).await["last_check"].is_null(), "{kind}");
        }
    }
}
