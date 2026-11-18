mod common;

use common::TestServer;
use reqwest::{Response, StatusCode};
use serde_json::Value;

async fn login(s: &TestServer) -> (String, String, String) {
    let (_, response) = s.pair_browser("refresh fixture").await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = cookie(&response);
    let body: Value = response.json().await.unwrap();
    (cookie, body["browser_session_id"].as_str().unwrap().into(), body["access_token"].as_str().unwrap().into())
}

fn cookie(response: &Response) -> String {
    response.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().into()
}

async fn refresh(s: &TestServer, cookie: &str, key: &str) -> Response {
    s.client.post(format!("{}/api/v1/auth/refresh", s.base))
        .header("cookie", cookie).header("idempotency-key", key).send().await.unwrap()
}

async fn restart_at_same_address(s: &mut TestServer) {
    // HttpOnly 쿠키는 서버 authority별 이름을 쓴다. 운영 재시작처럼 접속 주소를 유지한다.
    let mut cfg = common::config(&s.data_dir());
    cfg.listen = s.base.strip_prefix("http://").unwrap().parse().unwrap();
    s.stop().await;
    s.server = Some(grove::server::start(cfg, std::sync::Arc::new(grove::util::SystemClock)).await.unwrap());
}

#[tokio::test]
async fn overlapping_refreshes_and_lost_responses_replay_one_rotation_across_restart() {
    let mut s = TestServer::start().await;
    let (old, id, _) = login(&s).await;
    let (first, second) = tokio::join!(refresh(&s, &old, "same-refresh"), refresh(&s, &old, "same-refresh"));
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(second.status(), StatusCode::OK);
    let next = cookie(&first);
    assert!(next != old, "정상 갱신은 비밀을 회전한다");
    assert!(cookie(&second) == next, "같은 요청은 다시 회전하지 않는다");
    let (id2, next_secret) = (id.clone(), next.split_once('.').unwrap().1.to_string());
    s.server.as_ref().unwrap().app.db.call(move |c| {
        let encrypted: String = c.query_row("SELECT next_secret FROM browser_refresh_receipts WHERE browser_id=?1", [&id2], |r| r.get(0))?;
        assert!(encrypted.starts_with("v1:") && !encrypted.contains(&next_secret), "재생 결과에도 평문 자격을 저장하지 않는다");
        Ok(())
    }).await.unwrap();
    restart_at_same_address(&mut s).await;
    for presented in [&old, &next] {
        let replay = refresh(&s, presented, "same-refresh").await;
        assert_eq!(replay.status(), StatusCode::OK);
        assert!(cookie(&replay) == next, "쿠키 반영 전·후의 응답 유실을 모두 복구한다");
    }
    assert_eq!(refresh(&s, &old, "other-refresh").await.status(), StatusCode::UNAUTHORIZED);
    let rotated = refresh(&s, &next, "next-refresh").await;
    assert_eq!(rotated.status(), StatusCode::OK);
    assert!(cookie(&rotated) != next);
    assert_eq!(refresh(&s, &old, "same-refresh").await.status(), StatusCode::UNAUTHORIZED, "다음 갱신이 접수되면 이전 재생 자격도 끝난다");
}

#[tokio::test]
async fn refresh_extends_idle_expiry_but_replays_do_not_and_expired_sessions_stay_expired() {
    let s = TestServer::start().await;
    let (old, id, _) = login(&s).await;
    let app = &s.server.as_ref().unwrap().app;
    let id2 = id.clone();
    let near_expiry = grove::util::fmt_time(app.clock.now() + time::Duration::hours(1));
    app.db.call(move |c| {
        c.execute("UPDATE tokens SET expires_at=?2 WHERE id=?1", rusqlite::params![id2, near_expiry])?;
        Ok(())
    }).await.unwrap();
    let before = app.clock.now();
    assert_eq!(refresh(&s, &old, "extend").await.status(), StatusCode::OK);
    let id2 = id.clone();
    let expiry: String = app.db.call(move |c| Ok(c.query_row("SELECT expires_at FROM tokens WHERE id=?1", [id2], |r| r.get(0))?)).await.unwrap();
    assert!(grove::util::parse_time(&expiry).unwrap() >= before + grove::auth::REFRESH_TTL);
    assert_eq!(refresh(&s, &old, "extend").await.status(), StatusCode::OK);
    let id2 = id.clone();
    app.db.call(move |c| {
        let replay_expiry: String = c.query_row("SELECT expires_at FROM tokens WHERE id=?1", [&id2], |r| r.get(0))?;
        assert_eq!(replay_expiry, expiry, "재생만 반복해 세션 수명을 늘릴 수 없다");
        c.execute("UPDATE tokens SET expires_at='2000-01-01T00:00:00Z' WHERE id=?1", [id2])?;
        Ok(())
    }).await.unwrap();
    assert_eq!(refresh(&s, &old, "extend").await.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn replay_cannot_bypass_parent_revocation_and_logout_handles_a_lost_refresh_response() {
    let s = TestServer::start().await;
    let (old, _, access) = login(&s).await;
    assert_eq!(refresh(&s, &old, "lost-response").await.status(), StatusCode::OK);
    let response = s.client.post(format!("{}/api/v1/auth/logout", s.base))
        .header("cookie", &old).header("idempotency-key", "lost-response").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(refresh(&s, &old, "lost-response").await.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(s.client.get(format!("{}/api/v1/auth/whoami", s.base)).bearer_auth(access).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    let (old, id, _) = login(&s).await;
    assert_eq!(refresh(&s, &old, "revoked-parent").await.status(), StatusCode::OK);
    s.server.as_ref().unwrap().app.db.call(move |c| {
        c.execute("UPDATE tokens SET revoked_at='2000-01-01T00:00:00Z' WHERE id=(SELECT parent_id FROM tokens WHERE id=?1)", [id])?;
        Ok(())
    }).await.unwrap();
    assert_eq!(refresh(&s, &old, "revoked-parent").await.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn failed_receipt_commit_keeps_original_credential_and_session_expiry() {
    let s = TestServer::start().await;
    let (old, id, _) = login(&s).await;
    let id2 = id.clone();
    let expiry: String = s.server.as_ref().unwrap().app.db.call(move |c| {
        Ok(c.query_row("SELECT expires_at FROM tokens WHERE id=?1", [id2], |r| r.get(0))?)
    }).await.unwrap();
    s.server.as_ref().unwrap().app.db.call(|c| {
        c.execute_batch("CREATE TRIGGER fail_refresh BEFORE INSERT ON browser_refresh_receipts BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END;")?;
        Ok(())
    }).await.unwrap();
    assert_eq!(refresh(&s, &old, "failed-receipt").await.status(), StatusCode::INTERNAL_SERVER_ERROR);
    s.server.as_ref().unwrap().app.db.call(move |c| {
        let after: String = c.query_row("SELECT expires_at FROM tokens WHERE id=?1", [id], |r| r.get(0))?;
        assert_eq!(after, expiry);
        c.execute_batch("DROP TRIGGER fail_refresh")?;
        Ok(())
    }).await.unwrap();
    assert_eq!(refresh(&s, &old, "failed-receipt").await.status(), StatusCode::OK, "재생 저장 실패로 원래 자격까지 소실되면 안 된다");
}

#[tokio::test]
async fn migration_preserves_existing_browser_and_parent_credentials() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    std::fs::create_dir(&data).unwrap();
    let migrations = grove::store::MIGRATIONS;
    let before_refresh = migrations.iter().position(|sql| sql.contains("CREATE TABLE browser_refresh_receipts")).unwrap();
    let old = format!("grove_refresh={}", grove::auth::format_token("browser-fixture", "test-only-refresh-secret"));
    {
        let c = rusqlite::Connection::open(data.join("grove.db")).unwrap();
        for sql in &migrations[..before_refresh] { c.execute_batch(sql).unwrap(); }
        c.pragma_update(None, "user_version", before_refresh as i64).unwrap();
        c.execute("INSERT INTO tokens (id,kind,name,secret_hash,created_at) VALUES ('device-fixture','device','device','unused','2025-01-01T00:00:00Z')", []).unwrap();
        c.execute("INSERT INTO pairings(id,name,secret_hash,issuer_id,created_at,device_id,consumed_at) VALUES('pairing-fixture','browser','unused','device-fixture','2025-01-01T00:00:00Z','device-fixture','2025-01-01T00:00:00Z')", []).unwrap();
        c.execute("INSERT INTO tokens (id,kind,name,secret_hash,parent_id,created_at) VALUES ('browser-fixture','browser','browser',?1,'device-fixture','2025-01-01T00:00:00Z')",
            [grove::util::sha256_hex(b"test-only-refresh-secret")]).unwrap();
    }
    let cfg = common::config(&data);
    let s = TestServer::start_with(tmp, cfg).await;
    let next = refresh(&s, &old, "after-migration").await;
    assert_eq!(next.status(), StatusCode::OK, "기존 쿠키로 새 schema에서 갱신할 수 있어야 한다");
    let (_, devices) = s.get("/api/v1/devices").await;
    assert!(devices.as_array().unwrap().iter().any(|row| row["id"] == "device-fixture"), "부모 자격을 보존한다");
}

#[tokio::test]
async fn a_refresh_request_key_is_not_a_credential_or_a_cross_session_replay_key() {
    let s = TestServer::start().await;
    let (first, _, _) = login(&s).await;
    let (second, _, _) = login(&s).await;
    assert_eq!(refresh(&s, &first, "shared-request-id").await.status(), StatusCode::OK);
    let forged = format!("{}.wrong-secret", first.split_once('.').unwrap().0);
    assert_eq!(refresh(&s, &forged, "shared-request-id").await.status(), StatusCode::UNAUTHORIZED);
    let response = s.client.post(format!("{}/api/v1/auth/logout", s.base))
        .header("cookie", &forged).header("idempotency-key", "shared-request-id").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let next = refresh(&s, &second, "shared-request-id").await;
    assert_eq!(next.status(), StatusCode::OK, "요청 키가 같아도 브라우저별로 별도 접수한다");
    assert_eq!(refresh(&s, &first, "shared-request-id").await.status(), StatusCode::OK, "다른 브라우저의 접수로 원래 재생을 덮지 않는다");
}
