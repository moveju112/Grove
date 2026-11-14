mod common;

use common::TestServer;
use reqwest::{Method, Response, StatusCode, header};
use serde_json::{Value, json};

const PASSWORD: &str = "test-only pairing password";

async fn issue(server: &TestServer, name: &str, replace_id: Option<&str>) -> Value {
    let (status, value) = server.post("/api/v1/pairings", json!({ "name": name, "password": PASSWORD, "replace_id": replace_id })).await;
    assert_eq!(status, StatusCode::CREATED, "{value}");
    assert!(value["expires_at"].is_null());
    value
}

async fn request(server: &TestServer, code: &str, password: &str) -> Response {
    server.client.post(format!("{}/api/v1/auth/pairing", server.base))
        .json(&json!({ "code": code, "password": password, "name": "new browser" })).send().await.unwrap()
}

async fn pending(server: &TestServer, pair: &Value) -> Value {
    let response = request(server, pair["code"].as_str().unwrap(), PASSWORD).await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    let body: Value = response.json().await.unwrap();
    assert!(body.get("access_token").is_none());
    body
}

fn path(pair: &Value, request: &Value) -> String {
    let request_id = request["code"].as_str().unwrap().split_once('.').unwrap().0;
    format!("/api/v1/pairings/{}/requests/{request_id}", pair["id"].as_str().unwrap())
}

async fn approve(server: &TestServer, pair: &Value, request: &Value) -> Value {
    let (status, body) = server.post(&path(pair, request), json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

async fn claim(server: &TestServer, request: &Value) -> Response {
    server.client.post(format!("{}/api/v1/auth/pairing/claim", server.base)).json(&json!({ "code": request["code"] })).send().await.unwrap()
}

#[tokio::test]
async fn password_requires_ten_characters_and_keeps_the_byte_limit() {
    let server = TestServer::start().await;
    for (password, expected) in [
        ("123456789".to_string(), StatusCode::BAD_REQUEST),
        ("1234567890".to_string(), StatusCode::CREATED),
        ("가".repeat(9), StatusCode::BAD_REQUEST),
        ("가".repeat(10), StatusCode::CREATED),
        ("x".repeat(257), StatusCode::BAD_REQUEST),
    ] {
        let (status, body) = server.post("/api/v1/pairings", json!({ "name": "length boundary", "password": password })).await;
        assert_eq!(status, expected);
        if expected == StatusCode::CREATED {
            assert_eq!(request(&server, body["code"].as_str().unwrap(), &password).await.status(), StatusCode::ACCEPTED);
        }
    }
}

#[tokio::test]
async fn password_only_requests_access_and_owner_approval_registers_one_non_owner_browser() {
    let server = TestServer::start().await;
    let pair = issue(&server, "phone", None).await;
    let request = pending(&server, &pair).await;
    assert_eq!(claim(&server, &request).await.status(), StatusCode::ACCEPTED);
    let (_, devices) = server.get("/api/v1/devices").await;
    assert_eq!(devices.as_array().unwrap().iter().filter(|d| d["kind"] == "device").count(), 0);
    let (_, rows) = server.get("/api/v1/pairings").await;
    assert_eq!(rows[0]["requests"][0]["verification_code"], request["verification_code"]);
    assert!(rows[0]["consumed_at"].is_null());
    let approved = approve(&server, &pair, &request).await;
    let response = claim(&server, &request).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();
    let body: Value = response.json().await.unwrap();
    assert!(body.get("token").is_none());
    let access = body["access_token"].as_str().unwrap();
    let who = server.raw(Method::GET, "/api/v1/auth/whoami", None, None, Some(access)).await;
    let who: Value = who.json().await.unwrap();
    assert_eq!(who["is_owner"], false);
    assert_eq!(who["kind"], "browser");
    for (method, route) in [(Method::GET, "/api/v1/pairings".to_string()), (Method::POST, path(&pair, &request)), (Method::DELETE, path(&pair, &request))] {
        let response = server.raw(method, &route, Some(json!({})), Some("not-owner"), Some(access)).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    assert_eq!(claim(&server, &request).await.status(), StatusCode::GONE);
    assert_eq!(request_pair_status(&server, &pair).await, StatusCode::GONE);
    let (status, _) = server.send(Method::DELETE, &format!("/api/v1/devices/{}", approved["device_id"].as_str().unwrap()), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(server.raw(Method::GET, "/api/v1/auth/whoami", None, None, Some(access)).await.status(), StatusCode::UNAUTHORIZED);
    let refresh = server.client.post(format!("{}/api/v1/auth/refresh", server.base)).header(header::COOKIE, cookie).send().await.unwrap();
    assert_eq!(refresh.status(), StatusCode::UNAUTHORIZED);
}

async fn request_pair_status(server: &TestServer, pair: &Value) -> StatusCode {
    request(server, pair["code"].as_str().unwrap(), PASSWORD).await.status()
}

#[tokio::test]
async fn same_link_cannot_claim_another_browsers_request_and_only_approved_request_gets_access() {
    let server = TestServer::start().await;
    let pair = issue(&server, "shared", None).await;
    let attacker = pending(&server, &pair).await;
    let mine = pending(&server, &pair).await;
    assert_ne!(attacker["verification_code"], mine["verification_code"]);
    let forged = json!({ "code": format!("{}.{}", mine["code"].as_str().unwrap().split_once('.').unwrap().0, "x".repeat(43)) });
    assert_eq!(claim(&server, &forged).await.status(), StatusCode::GONE);
    approve(&server, &pair, &mine).await;
    assert_eq!(claim(&server, &attacker).await.status(), StatusCode::GONE);
    assert_eq!(claim(&server, &mine).await.status(), StatusCode::OK);
    assert_eq!(server.post(&path(&pair, &attacker), json!({})).await.0, StatusCode::GONE);
}

#[tokio::test]
async fn concurrent_approvals_and_claims_create_exactly_one_device_and_browser() {
    let server = TestServer::start().await;
    let pair = issue(&server, "race", None).await;
    let a = pending(&server, &pair).await;
    let b = pending(&server, &pair).await;
    let (a_path, b_path) = (path(&pair, &a), path(&pair, &b));
    let (first, second) = tokio::join!(server.post(&a_path, json!({})), server.post(&b_path, json!({})));
    let winner = if first.0 == StatusCode::OK { &a } else { &b };
    let mut statuses = [first.0.as_u16(), second.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 410]);
    let (first, second) = tokio::join!(claim(&server, winner), claim(&server, winner));
    let mut statuses = [first.status().as_u16(), second.status().as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 410]);
    let (_, rows) = server.get("/api/v1/devices").await;
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.iter().filter(|r| r["kind"] == "device").count(), 1);
    assert_eq!(rows.iter().filter(|r| r["kind"] == "browser").count(), 1);
}

#[tokio::test]
async fn five_failures_lock_only_that_link_persist_across_restart_and_block_existing_requests() {
    let mut server = TestServer::start().await;
    let pair = issue(&server, "locked", None).await;
    let other = issue(&server, "other", None).await;
    let first = pending(&server, &pair).await;
    for _ in 0..2 {
        assert_eq!(request(&server, pair["code"].as_str().unwrap(), "incorrect").await.status(), StatusCode::UNAUTHORIZED);
    }
    // 올바른 비밀번호로 요청해도 누적 실패 횟수를 초기화하지 않는다.
    pending(&server, &pair).await;
    server.restart().await;
    for attempt in 3..=5 {
        let response = request(&server, pair["code"].as_str().unwrap(), "incorrect").await;
        assert_eq!(response.status(), if attempt == 5 { StatusCode::LOCKED } else { StatusCode::UNAUTHORIZED });
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }
    server.restart().await;
    assert_eq!(request_pair_status(&server, &pair).await, StatusCode::LOCKED);
    assert_eq!(claim(&server, &first).await.status(), StatusCode::LOCKED);
    assert_eq!(server.post(&path(&pair, &first), json!({})).await.0, StatusCode::GONE);
    let (_, rows) = server.get("/api/v1/pairings").await;
    let row = rows.as_array().unwrap().iter().find(|row| row["id"] == pair["id"]).unwrap();
    assert_eq!(row["failed_attempts"], 5);
    assert!(row["locked_at"].is_string());
    assert!(row["requests"].as_array().unwrap().is_empty());
    let second = pending(&server, &other).await;
    approve(&server, &other, &second).await;
    assert_eq!(claim(&server, &second).await.status(), StatusCode::OK);
    let replacement = issue(&server, "replacement", pair["id"].as_str()).await;
    pending(&server, &replacement).await;
}

#[tokio::test]
async fn concurrent_wrong_passwords_never_exceed_five_and_never_allow_approval() {
    let server = TestServer::start().await;
    let pair = issue(&server, "wrong-race", None).await;
    let code = pair["code"].as_str().unwrap();
    for _ in 0..2 {
        let (a, b) = tokio::join!(request(&server, code, "incorrect"), request(&server, code, "incorrect"));
        assert_eq!(a.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(b.status(), StatusCode::UNAUTHORIZED);
    }
    let (a, b) = tokio::join!(request(&server, code, "incorrect"), request(&server, code, "incorrect"));
    assert_eq!(a.status(), StatusCode::LOCKED);
    assert_eq!(b.status(), StatusCode::LOCKED);
    let (_, rows) = server.get("/api/v1/pairings").await;
    assert_eq!(rows[0]["failed_attempts"], 5);
}

#[tokio::test]
async fn secrets_are_hashed_and_redacted_from_replay_listing_events_and_audit() {
    let server = TestServer::start().await;
    let create = || server.raw(Method::POST, "/api/v1/pairings", Some(json!({ "name": "redaction", "password": PASSWORD })), Some("same-pairing"), None);
    let response = create().await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let pair: Value = response.json().await.unwrap();
    let replay: Value = create().await.json().await.unwrap();
    assert_eq!(replay["id"], pair["id"]);
    assert_eq!(replay["code_redacted"], true);
    assert!(replay.get("code").is_none());
    let different = server.raw(Method::POST, "/api/v1/pairings", Some(json!({ "name": "redaction", "password": "different test password" })), Some("same-pairing"), None).await;
    assert_eq!(different.status(), StatusCode::CONFLICT);
    let request = pending(&server, &pair).await;
    let (_, list) = server.get("/api/v1/pairings").await;
    let (_, secret) = pair["code"].as_str().unwrap().split_once('.').unwrap();
    assert!(!list.to_string().contains(secret));
    assert!(!list.to_string().contains(PASSWORD));
    assert!(!list.to_string().contains(request["code"].as_str().unwrap()));
    let (id, secret, request_secret) = (pair["id"].as_str().unwrap().to_owned(), secret.to_owned(), request["code"].as_str().unwrap().split_once('.').unwrap().1.to_owned());
    server.server.as_ref().unwrap().app.db.call(move |c| {
        let (stored, verifier, salt): (String, Vec<u8>, String) = c.query_row("SELECT secret_hash,password_hash,password_salt FROM pairings WHERE id=?1", [&id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        assert_eq!(stored, grove::util::sha256_hex(secret.as_bytes()));
        assert_eq!(verifier.len(), 32);
        ring::pbkdf2::verify(ring::pbkdf2::PBKDF2_HMAC_SHA256, std::num::NonZeroU32::new(600_000).unwrap(), salt.as_bytes(), PASSWORD.as_bytes(), &verifier).unwrap();
        for sensitive in [&secret, &request_secret, PASSWORD] {
            for (table, field) in [("idempotency", "response"), ("events", "payload"), ("audit_log", "detail")] {
                let count: i64 = c.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE instr({field},?1)>0"), [sensitive], |r| r.get(0))?;
                assert_eq!(count, 0, "{table}");
            }
        }
        Ok(())
    }).await.unwrap();
}

#[tokio::test]
async fn nonexpiring_links_survive_restart_but_revoke_reissue_and_rejection_do_not_revive_requests() {
    let mut server = TestServer::start().await;
    let original = issue(&server, "long-lived", None).await;
    let id = original["id"].as_str().unwrap().to_owned();
    server.server.as_ref().unwrap().app.db.call(move |c| {
        c.execute("UPDATE pairings SET created_at='2000-01-01T00:00:00Z' WHERE id=?1", [id])?;
        Ok(())
    }).await.unwrap();
    server.restart().await;
    let old_request = pending(&server, &original).await;
    let (status, _) = server.send(Method::DELETE, &path(&original, &old_request), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(claim(&server, &old_request).await.status(), StatusCode::GONE);
    let next = pending(&server, &original).await;
    let replacement = issue(&server, "replacement", original["id"].as_str()).await;
    server.restart().await;
    assert_eq!(claim(&server, &next).await.status(), StatusCode::GONE);
    assert_eq!(request_pair_status(&server, &original).await, StatusCode::GONE);
    let request = pending(&server, &replacement).await;
    approve(&server, &replacement, &request).await;
    server.restart().await;
    assert_eq!(claim(&server, &request).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn expired_requests_do_not_consume_the_link_and_revoked_devices_cannot_claim() {
    let server = TestServer::start().await;
    let pair = issue(&server, "expired-request", None).await;
    let expired = pending(&server, &pair).await;
    let id = expired["code"].as_str().unwrap().split_once('.').unwrap().0.to_owned();
    server.server.as_ref().unwrap().app.db.call(move |c| {
        c.execute("UPDATE pairing_requests SET expires_at='2000-01-01T00:00:00Z' WHERE id=?1", [id])?;
        Ok(())
    }).await.unwrap();
    assert_eq!(claim(&server, &expired).await.status(), StatusCode::GONE);
    assert_eq!(server.post(&path(&pair, &expired), json!({})).await.0, StatusCode::GONE);
    let request = pending(&server, &pair).await;
    let approved = approve(&server, &pair, &request).await;
    server.send(Method::DELETE, &format!("/api/v1/devices/{}", approved["device_id"].as_str().unwrap()), json!({})).await;
    assert_eq!(claim(&server, &request).await.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn wrong_link_secret_and_cross_site_requests_cannot_lock_or_consume_a_link() {
    let server = TestServer::start().await;
    let pair = issue(&server, "boundaries", None).await;
    let code = pair["code"].as_str().unwrap();
    let (id, _) = code.split_once('.').unwrap();
    for _ in 0..6 {
        assert_eq!(request(&server, &format!("{id}.wrong"), "incorrect").await.status(), StatusCode::GONE);
    }
    let foreign = server.client.post(format!("{}/api/v1/auth/pairing", server.base)).header(header::ORIGIN, "https://foreign.example")
        .json(&json!({ "code": code, "password": PASSWORD, "name": "foreign" })).send().await.unwrap();
    assert_eq!(foreign.status(), StatusCode::FORBIDDEN);
    assert_eq!(server.raw(Method::GET, "/api/v1/projects", None, None, Some(code)).await.status(), StatusCode::UNAUTHORIZED);
    let (_, rows) = server.get("/api/v1/pairings").await;
    assert_eq!(rows[0]["failed_attempts"], 0);
    let request = pending(&server, &pair).await;
    let response = server.client.post(format!("{}/api/v1/auth/pairing/claim", server.base)).header(header::ORIGIN, "https://foreign.example")
        .json(&json!({ "code": request["code"] })).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn pending_limit_and_atomic_reissue_do_not_leave_extra_active_links() {
    let server = TestServer::start().await;
    let mut first = None;
    for i in 0..20 {
        let pair = issue(&server, &format!("pending-{i}"), None).await;
        if first.is_none() { first = Some(pair); }
    }
    let (status, error) = server.post("/api/v1/pairings", json!({ "name": "excess", "password": PASSWORD })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "pairing_limit");
    let old = first.unwrap();
    let fresh = issue(&server, "replacement", old["id"].as_str()).await;
    assert_eq!(request_pair_status(&server, &old).await, StatusCode::GONE);
    pending(&server, &fresh).await;
    let (status, _) = server.post("/api/v1/pairings", json!({ "name": "invalid", "password": PASSWORD, "replace_id": "missing" })).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn migration_revokes_old_links_without_losing_registered_devices_or_other_data() {
    let mut c = rusqlite::Connection::open_in_memory().unwrap();
    c.pragma_update(None, "foreign_keys", "ON").unwrap();
    for sql in &grove::store::MIGRATIONS[..62] { c.execute_batch(sql).unwrap(); }
    c.execute_batch(
        "INSERT INTO tokens(id,kind,name,secret_hash,created_at) VALUES('owner','owner','owner','hash','2026-01-01T00:00:00Z'),('device','device','phone','hash','2026-01-01T00:00:00Z');
         INSERT INTO pairings(id,name,secret_hash,issuer_id,created_at,expires_at,device_id,consumed_at) VALUES('old','old','hash','owner','2026-01-01T00:00:00Z','2099-01-01T00:00:00Z','device','2026-01-01T00:01:00Z');
         INSERT INTO pairings(id,name,secret_hash,issuer_id,created_at,expires_at) VALUES('pending','pending','hash','owner','2026-01-01T00:00:00Z','2099-01-01T00:00:00Z');"
    ).unwrap();
    let tx = c.transaction().unwrap();
    tx.execute_batch(grove::store::MIGRATIONS[62]).unwrap();
    tx.commit().unwrap();
    let n: i64 = c.query_row("SELECT COUNT(*) FROM pairings WHERE revoked_at IS NOT NULL", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 2);
    let device: String = c.query_row("SELECT device_id FROM pairings WHERE id='old'", [], |r| r.get(0)).unwrap();
    assert_eq!(device, "device");
    let n: i64 = c.query_row("SELECT COUNT(*) FROM tokens", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 2);
    assert!(!c.prepare("PRAGMA foreign_key_check").unwrap().exists([]).unwrap());
}
