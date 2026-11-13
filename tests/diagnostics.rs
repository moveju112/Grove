//! OBS-008: 요청·권한·수집 범위·비저장 계약. 외부 모델이나 전송 서비스는 사용하지 않는다.
mod common;

use common::{TestServer, fixture::{self, Fixture}};
use reqwest::{Method, StatusCode};
use serde_json::json;

#[tokio::test]
async fn diagnostic_bundle_is_confirmed_owner_only_allowlisted_and_read_only() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("private-diagnostic-project-name").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap();
    let root = project["root_path"].as_str().unwrap();
    std::fs::write(std::path::Path::new(root).join("private.txt"), "private-file-content-diag").unwrap();
    f.push(fixture::text("private-assistant-content-diag"));
    let (_, turn) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({
        "text":"private-prompt-content-diag", "profile_id":profile,
    })).await;
    s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
    let app = &s.server.as_ref().unwrap().app;
    let before = app.db.call(|c| Ok((
        grove::events::latest_seq(c)?,
        c.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0))?,
        c.query_row("SELECT COUNT(*) FROM idempotency", [], |r| r.get::<_, i64>(0))?,
    ))).await.unwrap();

    assert_eq!(s.client.post(format!("{}/api/v1/admin/diagnostics", s.base)).json(&json!({"confirmed":true})).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    let (st, _) = s.get("/api/v1/admin/diagnostics").await;
    assert_eq!(st, StatusCode::METHOD_NOT_ALLOWED);
    let (st, error) = s.post("/api/v1/admin/diagnostics", json!({"confirmed":false})).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert_eq!(error["error"]["code"], "invalid_request");
    let (st, _) = s.post("/api/v1/admin/diagnostics", json!({"confirmed":true,"include_logs":true})).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);

    let key = s.key();
    for _ in 0..2 {
        let response = s.raw(Method::POST, "/api/v1/admin/diagnostics", Some(json!({"confirmed":true})), Some(&key), None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert!(!response.headers().contains_key("idempotent-replayed"));
        let bundle: serde_json::Value = response.json().await.unwrap();
        assert_eq!(bundle["format"], "grove-diagnostics-v1");
        assert_eq!(bundle["server"]["schema"], grove::store::MIGRATIONS.len());
        assert_eq!(bundle["counts"]["projects"], 1);
        assert_eq!(bundle["counts"]["sessions"], 1);
        assert_eq!(bundle["counts"]["profiles_enabled"], 1);
        assert_eq!(bundle["counts"]["turns"]["completed"], 1);
        assert!(bundle["resources"]["db_bytes"]["main"].as_u64().unwrap() > 0);
        assert_eq!(bundle["privacy"]["external_upload"], false);
        let text = bundle.to_string();
        assert!(text.len() < 16 * 1024);
        for excluded in [
            s.token.as_str(), root, project["id"].as_str().unwrap(), sid, profile.as_str(),
            "sk-test-secret-value-1234", "private-diagnostic-project-name",
            "private-file-content-diag", "private-prompt-content-diag", "private-assistant-content-diag",
            f.base.as_str(),
        ] {
            assert!(!text.contains(excluded), "진단 묶음은 본문·키·식별자·경로를 포함하지 않는다");
        }
    }
    let after = app.db.call(|c| Ok((
        grove::events::latest_seq(c)?,
        c.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0))?,
        c.query_row("SELECT COUNT(*) FROM idempotency", [], |r| r.get::<_, i64>(0))?,
    ))).await.unwrap();
    assert_eq!(before, after, "진단은 메시지·이벤트·receipt를 저장하지 않는다");
    assert_eq!(f.requests().len(), 1, "진단 중 모델을 호출하지 않는다");
}
