mod common;

use common::TestServer;
use reqwest::{Method, Response, StatusCode, header};
use serde_json::{Value, json};

async fn issue(server: &TestServer, name: &str, replace_id: Option<&str>) -> Value {
    let (status, value) = server.post("/api/v1/pairings", json!({ "name": name, "replace_id": replace_id })).await;
    assert_eq!(status, StatusCode::CREATED);
    value
}

async fn redeem(server: &TestServer, code: &str) -> Response {
    server.client.post(format!("{}/api/v1/auth/pairing", server.base)).json(&json!({ "code": code })).send().await.unwrap()
}

#[tokio::test]
async fn one_time_pairing_registers_a_non_owner_browser_and_device_revocation_invalidates_it() {
    let server = TestServer::start().await;
    let pair = issue(&server, "phone", None).await;
    let code = pair["code"].as_str().unwrap();
    let response = redeem(&server, code).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();
    let body: Value = response.json().await.unwrap();
    assert!(body.get("token").is_none(), "장기 기기 토큰을 브라우저에 전달하지 않는다");
    let access = body["access_token"].as_str().unwrap();
    let who = server.raw(Method::GET, "/api/v1/auth/whoami", None, None, Some(access)).await;
    assert_eq!(who.status(), StatusCode::OK);
    let who: Value = who.json().await.unwrap();
    assert_eq!(who["is_owner"], false);
    assert_eq!(who["kind"], "browser");
    let (status, rows) = server.get("/api/v1/pairings").await;
    assert_eq!(status, StatusCode::OK);
    let info = &rows.as_array().unwrap()[0];
    assert!(info["consumed_at"].is_string());
    let device_id = info["device_id"].as_str().unwrap();
    let response = server.raw(Method::GET, "/api/v1/pairings", None, None, Some(access)).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = server.raw(Method::POST, "/api/v1/pairings", Some(json!({ "name": "not-owner" })), Some("not-owner"), Some(access)).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(redeem(&server, code).await.status(), StatusCode::GONE);
    let (status, _) = server.send(Method::DELETE, &format!("/api/v1/devices/{device_id}"), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let who = server.raw(Method::GET, "/api/v1/auth/whoami", None, None, Some(access)).await;
    assert_eq!(who.status(), StatusCode::UNAUTHORIZED);
    let refresh = server.client.post(format!("{}/api/v1/auth/refresh", server.base)).header(header::COOKIE, cookie).send().await.unwrap();
    assert_eq!(refresh.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn secret_is_hashed_and_redacted_from_replay_listing_events_and_audit() {
    let server = TestServer::start().await;
    let request = || server.raw(Method::POST, "/api/v1/pairings", Some(json!({ "name": "redaction" })), Some("same-pairing"), None);
    let response = request().await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let pair: Value = response.json().await.unwrap();
    let code = pair["code"].as_str().unwrap();
    let (id, secret) = code.split_once('.').unwrap();
    let replay: Value = request().await.json().await.unwrap();
    assert_eq!(replay["id"], pair["id"]);
    assert_eq!(replay["code_redacted"], true);
    assert!(replay.get("code").is_none());
    let (_, list) = server.get("/api/v1/pairings").await;
    assert!(!list.to_string().contains(secret));
    assert!(!pair.to_string().contains(&server.token));
    let (id, secret) = (id.to_string(), secret.to_string());
    server.server.as_ref().unwrap().app.db.call(move |c| {
        let stored: String = c.query_row("SELECT secret_hash FROM pairings WHERE id=?1", [&id], |r| r.get(0))?;
        assert!(stored == grove::util::sha256_hex(secret.as_bytes()));
        let count: i64 = c.query_row("SELECT COUNT(*) FROM idempotency WHERE instr(response,?1)>0", [&secret], |r| r.get(0))?;
        assert_eq!(count, 0);
        let count: i64 = c.query_row("SELECT COUNT(*) FROM events WHERE instr(payload,?1)>0", [&secret], |r| r.get(0))?;
        assert_eq!(count, 0);
        let count: i64 = c.query_row("SELECT COUNT(*) FROM audit_log WHERE instr(detail,?1)>0", [&secret], |r| r.get(0))?;
        assert_eq!(count, 0);
        Ok(())
    }).await.unwrap();
}

#[tokio::test]
async fn concurrent_redemption_creates_exactly_one_device_and_browser() {
    let server = TestServer::start().await;
    let pair = issue(&server, "race", None).await;
    let code = pair["code"].as_str().unwrap();
    let (a, b) = tokio::join!(redeem(&server, code), redeem(&server, code));
    let mut statuses = [a.status().as_u16(), b.status().as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 410]);
    let (_, rows) = server.get("/api/v1/devices").await;
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.iter().filter(|r| r["kind"] == "device").count(), 1);
    assert_eq!(rows.iter().filter(|r| r["kind"] == "browser").count(), 1);
}

#[tokio::test]
async fn expiry_revocation_and_reissue_survive_restart_without_reviving_old_links() {
    let mut server = TestServer::start().await;
    let expired = issue(&server, "expired", None).await;
    let id = expired["id"].as_str().unwrap().to_string();
    server.server.as_ref().unwrap().app.db.call(move |c| {
        c.execute("UPDATE pairings SET expires_at='2000-01-01T00:00:00Z' WHERE id=?1", [id])?;
        Ok(())
    }).await.unwrap();
    assert_eq!(redeem(&server, expired["code"].as_str().unwrap()).await.status(), StatusCode::GONE);
    let revoked = issue(&server, "revoked", None).await;
    let (status, _) = server.send(Method::DELETE, &format!("/api/v1/pairings/{}", revoked["id"].as_str().unwrap()), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let original = issue(&server, "reissue", None).await;
    let replacement = issue(&server, "reissue", original["id"].as_str()).await;
    server.restart().await;
    for pair in [&expired, &revoked, &original] {
        assert_eq!(redeem(&server, pair["code"].as_str().unwrap()).await.status(), StatusCode::GONE);
    }
    assert_eq!(redeem(&server, replacement["code"].as_str().unwrap()).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn wrong_secret_and_cross_site_requests_do_not_consume_a_valid_link() {
    let server = TestServer::start().await;
    let pair = issue(&server, "boundaries", None).await;
    let code = pair["code"].as_str().unwrap();
    let (id, _) = code.split_once('.').unwrap();
    assert_eq!(redeem(&server, &format!("{id}.wrong")).await.status(), StatusCode::GONE);
    let foreign = server.client.post(format!("{}/api/v1/auth/pairing", server.base))
        .header(header::ORIGIN, "https://foreign.example")
        .json(&json!({ "code": code })).send().await.unwrap();
    assert_eq!(foreign.status(), StatusCode::FORBIDDEN);
    let response = server.raw(Method::GET, "/api/v1/projects", None, None, Some(code)).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "짧은 등록 코드는 일반 API 토큰이 아니다");
    assert_eq!(redeem(&server, code).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn pending_limit_and_atomic_reissue_do_not_leave_extra_active_links() {
    let server = TestServer::start().await;
    let mut first = None;
    for i in 0..20 {
        let pair = issue(&server, &format!("pending-{i}"), None).await;
        if first.is_none() { first = Some(pair); }
    }
    let (status, error) = server.post("/api/v1/pairings", json!({ "name": "excess" })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "pairing_limit");
    let old = first.unwrap();
    let fresh = issue(&server, "replacement", old["id"].as_str()).await;
    assert_eq!(redeem(&server, old["code"].as_str().unwrap()).await.status(), StatusCode::GONE);
    assert_eq!(redeem(&server, fresh["code"].as_str().unwrap()).await.status(), StatusCode::OK);
    let (status, _) = server.post("/api/v1/pairings", json!({ "name": "invalid", "replace_id": "missing" })).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
