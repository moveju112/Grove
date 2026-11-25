use crate::common;

use common::TestServer;
use futures_util::StreamExt;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;

async fn device(s: &TestServer, name: &str) -> Value {
    let (id, response) = s.pair_browser(name).await;
    let cookie = response.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_string();
    let body: Value = response.json().await.unwrap();
    json!({ "id": id, "token": body["access_token"], "cookie": cookie })
}

#[tokio::test]
async fn device_name_changes_only_authenticated_root_and_survives_browser_login() {
    let s = TestServer::start().await;
    let first = device(&s, "first").await;
    let second = device(&s, "second").await;
    let access = first["token"].as_str().unwrap();
    let path = "/api/v1/auth/device";
    assert_eq!(s.client.get(format!("{}{path}", s.base)).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    for (index, name) in ["", &"x".repeat(81)].iter().enumerate() {
        assert_eq!(s.raw(Method::PUT, path, Some(json!({ "name": name })), Some(&format!("invalid-name-{index}")), Some(&access)).await.status(), StatusCode::BAD_REQUEST);
    }
    let response = s.raw(Method::PUT, path, Some(json!({ "name": " renamed ", "id": second["id"] })),
        Some("rename-self"), Some(&access)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let renamed: Value = response.json().await.unwrap();
    assert_eq!(renamed["id"], first["id"]);
    assert_eq!(renamed["name"], "renamed");
    for (token, expected) in [(first["token"].as_str().unwrap(), "renamed"), (second["token"].as_str().unwrap(), "second")] {
        let response = s.raw(Method::GET, path, None, None, Some(token)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["name"], expected);
    }
    assert_eq!(s.send(Method::DELETE, &format!("/api/v1/devices/{}", first["id"].as_str().unwrap()), json!({})).await.0, StatusCode::OK);
    assert_eq!(s.raw(Method::PUT, path, Some(json!({ "name": "forbidden" })), Some("revoked-rename"), Some(&access)).await.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn devices_share_full_access_without_sharing_idempotency_receipts() {
    let s = TestServer::start().await;
    let p = s.create_project("shared-user").await;
    let first = device(&s, "first").await;
    let second = device(&s, "second").await;
    let access = first["token"].as_str().unwrap();
    for token in [access, second["token"].as_str().unwrap()] {
        for path in ["/devices", "/secrets", "/audit", "/pairings", "/admin/update-readiness", "/admin/metrics"] {
            assert_eq!(s.raw(Method::GET, &format!("/api/v1{path}"), None, None, Some(token)).await.status(), StatusCode::OK);
        }
    }
    let path = format!("/api/v1/projects/{}/sessions", p["id"].as_str().unwrap());
    let mut ids = Vec::new();
    for token in [first["token"].as_str().unwrap(), second["token"].as_str().unwrap()] {
        let response = s.raw(Method::POST, &path, Some(json!({ "title": "same request" })), Some("same-device-key"), Some(token)).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let session: Value = response.json().await.unwrap();
        ids.push(session["id"].as_str().unwrap().to_string());
    }
    assert_ne!(ids[0], ids[1], "idempotency를 다른 기기의 접수 결과로 대신하지 않는다");
    let response = s.raw(Method::GET, &format!("/api/v1/sessions/{}", ids[0]), None, None, Some(second["token"].as_str().unwrap())).await;
    assert_eq!(response.status(), StatusCode::OK, "단일 사용자의 대화는 등록 기기 사이에서 공유한다");
    let response = s.raw(Method::POST, &path, Some(json!({ "title": "same request" })), Some("same-device-key"), Some(&access)).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(response.headers()["idempotent-replayed"], "true");
    let session: Value = response.json().await.unwrap();
    assert_eq!(session["id"], ids[0], "동일 기기의 브라우저는 부모의 접수 범위를 사용한다");
    assert_eq!(s.send(Method::DELETE, &format!("/api/v1/devices/{}", first["id"].as_str().unwrap()), json!({})).await.0, StatusCode::OK);
    for token in [access] {
        for path in [format!("/api/v1/sessions/{}", ids[0]), format!("/api/v1/sessions/{}/tasks", ids[0]), "/api/v1/tasks/missing/output".into()] {
            assert_eq!(s.raw(Method::GET, &path, None, None, Some(token)).await.status(), StatusCode::UNAUTHORIZED);
        }
        assert_eq!(s.raw(Method::POST, "/api/v1/tasks/missing/cancel", Some(json!({})), None, Some(token)).await.status(), StatusCode::UNAUTHORIZED);
    }
}

#[tokio::test]
async fn revocation_invalidates_preissued_file_links_without_affecting_another_device() {
    let s = TestServer::start().await;
    let project = s.create_project("access").await;
    std::fs::write(project["root_path"].as_str().unwrap().to_string() + "/note.txt", "private").unwrap();
    let first = device(&s, "first").await;
    let second = device(&s, "second").await;
    let mut links = Vec::new();
    for token in [first["token"].as_str().unwrap(), second["token"].as_str().unwrap()] {
        let response = s.raw(Method::POST, &format!("/api/v1/projects/{}/files/ticket", project["id"].as_str().unwrap()),
            Some(json!({ "path": "note.txt" })), None, Some(token)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        links.push(body["url"].as_str().unwrap().to_string());
    }
    assert_eq!(s.client.get(format!("{}{}", s.base, links[0])).send().await.unwrap().status(), StatusCode::OK);
    assert_eq!(s.send(Method::DELETE, &format!("/api/v1/devices/{}", first["id"].as_str().unwrap()), json!({})).await.0, StatusCode::OK);
    for link in &links[..1] {
        assert_eq!(s.client.get(format!("{}{link}", s.base)).send().await.unwrap().status(), StatusCode::UNAUTHORIZED,
            "폐기한 기기와 자식 브라우저의 이전 링크도 차단해야 한다");
    }
    assert_eq!(s.client.get(format!("{}{}", s.base, links[1])).send().await.unwrap().status(), StatusCode::OK);
}

#[tokio::test]
async fn expired_parent_cannot_authorize_browser_access_or_refresh() {
    let s = TestServer::start().await;
    let d = device(&s, "expires").await;
    let (access, cookie) = (d["token"].as_str().unwrap(), d["cookie"].as_str().unwrap());
    let id = d["id"].as_str().unwrap().to_string();
    s.server.as_ref().unwrap().app.db.call(move |c| {
        c.execute("UPDATE tokens SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?1", [id])?;
        Ok(())
    }).await.unwrap();
    assert_eq!(s.raw(Method::GET, "/api/v1/auth/whoami", None, None, Some(&access)).await.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(s.client.post(format!("{}/api/v1/auth/refresh", s.base)).header("cookie", cookie).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn revocation_closes_existing_idle_event_stream() {
    let s = TestServer::start().await;
    let d = device(&s, "events").await;
    let response = s.raw(Method::GET, "/api/v1/events", None, None, Some(d["token"].as_str().unwrap())).await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut stream = response.bytes_stream();
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut text = String::new();
        while !text.contains("event: hello") {
            text.push_str(&String::from_utf8_lossy(&stream.next().await.unwrap().unwrap()));
        }
    }).await.unwrap();
    assert_eq!(s.send(Method::DELETE, &format!("/api/v1/devices/{}", d["id"].as_str().unwrap()), json!({})).await.0, StatusCode::OK);
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(chunk) = stream.next().await { chunk.unwrap(); }
    }).await.expect("폐기한 기기의 idle SSE 연결도 닫혀야 한다");
}

#[tokio::test]
async fn forged_logout_cookie_cannot_revoke_a_known_browser_id() {
    let s = TestServer::start().await;
    let d = device(&s, "logout-proof").await;
    let (access, cookie) = (d["token"].as_str().unwrap(), d["cookie"].as_str().unwrap());
    let (prefix, _) = cookie.split_once('.').unwrap();
    let forged = format!("{prefix}.wrong-secret");
    let response = s.client.post(format!("{}/api/v1/auth/logout", s.base)).header("cookie", forged).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(s.raw(Method::GET, "/api/v1/auth/whoami", None, None, Some(&access)).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn logout_only_revokes_its_browser_and_closes_its_event_stream() {
    let s = TestServer::start().await;
    let a = device(&s, "browser-a").await;
    let b = device(&s, "browser-b").await;
    let first = a["token"].as_str().unwrap();
    let cookie = a["cookie"].as_str().unwrap();
    let second = b["token"].as_str().unwrap();
    let response = s.raw(Method::GET, "/api/v1/events", None, None, Some(&first)).await;
    let mut stream = response.bytes_stream();
    assert!(stream.next().await.unwrap().is_ok());
    let response = s.client.post(format!("{}/api/v1/auth/logout", s.base)).header("cookie", cookie).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(chunk) = stream.next().await { chunk.unwrap(); }
    }).await.expect("로그아웃한 브라우저의 SSE는 종료한다");
    assert_eq!(s.raw(Method::GET, "/api/v1/auth/whoami", None, None, Some(second)).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn local_service_credential_cannot_log_in_a_browser() {
    let s = TestServer::start().await;
    let legacy = s.client.post(format!("{}/api/v1/auth/browser-login", s.base))
        .json(&json!({ "token": s.token })).send().await.unwrap();
    assert_eq!(legacy.status(), StatusCode::NOT_FOUND);
    let with_browser_origin = s.client.get(format!("{}/api/v1/admin/metrics", s.base))
        .header("origin", &s.base).bearer_auth(&s.token).send().await.unwrap();
    assert_eq!(with_browser_origin.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(s.get("/api/v1/admin/metrics").await.0, StatusCode::OK);
}

#[tokio::test]
async fn a_legacy_token_login_must_pair_before_getting_device_permissions() {
    let s = TestServer::start().await;
    let owner = grove::auth::parse_token(&s.token).unwrap().0.to_owned();
    let app = &s.server.as_ref().unwrap().app;
    app.db.call(move |c| {
        c.execute("INSERT INTO tokens(id,kind,name,secret_hash,created_at) VALUES('legacy-device','device','legacy','unused','2026-01-01T00:00:00Z')", [])?;
        for (browser, parent) in [("from-local", owner.as_str()), ("from-device", "legacy-device")] {
            c.execute("INSERT INTO tokens(id,kind,name,secret_hash,parent_id,created_at) VALUES(?1,'browser','legacy',?2,?3,'2026-01-01T00:00:00Z')",
                rusqlite::params![browser, grove::util::sha256_hex(b"fixture-legacy-secret"), parent])?;
        }
        Ok(())
    }).await.unwrap();
    // 소유자 토큰 로그인으로 만든 세션은 다시 등록하라고 구분해 알리고, 미등록 기기 세션은 일반 인증 실패로 남는다.
    for (browser, code) in [("from-local", "login_retired"), ("from-device", "unauthorized")] {
        let token = grove::auth::format_token(browser, "fixture-legacy-secret");
        let response = s.client.post(format!("{}/api/v1/auth/refresh", s.base))
            .header("cookie", format!("grove_refresh={token}")).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["error"]["code"], code, "{browser}");
    }
}

#[tokio::test]
async fn idle_stream_expires_without_new_events_or_revocation() {
    let s = TestServer::start().await;
    let d = device(&s, "short-lived").await;
    let id = d["id"].as_str().unwrap().to_string();
    let expires = grove::util::fmt_time(time::OffsetDateTime::now_utc() + time::Duration::seconds(1));
    s.server.as_ref().unwrap().app.db.call(move |c| {
        c.execute("UPDATE tokens SET expires_at = ?2 WHERE id = ?1", rusqlite::params![id, expires])?;
        Ok(())
    }).await.unwrap();
    let response = s.raw(Method::GET, "/api/v1/events", None, None, Some(d["token"].as_str().unwrap())).await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut stream = response.bytes_stream();
    assert!(stream.next().await.unwrap().is_ok());
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(chunk) = stream.next().await { chunk.unwrap(); }
    }).await.expect("별도 활동 없이도 만료 시 연결을 닫는다");
}

#[cfg(unix)]
#[tokio::test]
async fn task_access_and_inflight_wait_follow_the_device_lifetime_without_cancelling_shared_work() {
    use axum::extract::{Path, Query, State};
    use axum::http::{HeaderMap, header};
    let s = TestServer::start().await;
    let p = s.create_project("task-access").await;
    let session = s.create_session(p["id"].as_str().unwrap()).await;
    let d = device(&s, "tasks").await;
    let other = device(&s, "other-tasks").await;
    let response = s.raw(Method::POST, &format!("/api/v1/sessions/{}/tasks", session["id"].as_str().unwrap()),
        Some(json!({ "command": "sleep 60", "timeout_ms": 10000 })), Some("device-task"), Some(d["token"].as_str().unwrap())).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let task: Value = response.json().await.unwrap();
    let id = task["id"].as_str().unwrap();
    let app = s.server.as_ref().unwrap().app.clone();
    let mut headers = HeaderMap::new();
    headers.insert(header::AUTHORIZATION, format!("Bearer {}", d["token"].as_str().unwrap()).parse().unwrap());
    let principal = grove::auth::authenticate(&app, &headers).await.unwrap();
    let waiting = grove::tasks::wait(State(app), principal, Path(id.to_string()),
        Query(grove::tasks::WaitQuery { timeout_ms: Some(5000), after_event_seq: None }));
    tokio::pin!(waiting);
    assert!(futures_util::poll!(&mut waiting).is_pending(), "대기 요청을 시작한 뒤 폐기한다");
    assert_eq!(s.send(Method::DELETE, &format!("/api/v1/devices/{}", d["id"].as_str().unwrap()), json!({})).await.0, StatusCode::OK);
    let error = tokio::time::timeout(Duration::from_secs(3), waiting).await.unwrap().unwrap_err();
    assert_eq!(error.status, StatusCode::UNAUTHORIZED);
    for path in [format!("/api/v1/tasks/{id}"), format!("/api/v1/tasks/{id}/output"), format!("/api/v1/tasks/{id}/wait?timeout_ms=0")] {
        assert_eq!(s.raw(Method::GET, &path, None, None, Some(d["token"].as_str().unwrap())).await.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(s.raw(Method::GET, &path, None, None, Some(other["token"].as_str().unwrap())).await.status(), StatusCode::OK);
    }
    assert_eq!(s.raw(Method::POST, &format!("/api/v1/tasks/{id}/cancel"), Some(json!({})), None, Some(d["token"].as_str().unwrap())).await.status(), StatusCode::UNAUTHORIZED);
    let response = s.raw(Method::POST, &format!("/api/v1/tasks/{id}/cancel"), Some(json!({})), None, Some(other["token"].as_str().unwrap())).await;
    assert_eq!(response.status(), StatusCode::OK, "남은 기기는 같은 사용자의 작업을 중단할 수 있다");
}

#[cfg(unix)]
#[tokio::test]
async fn revocation_closes_terminal_socket_and_invalidates_unused_ticket_but_keeps_pty() {
    use tokio_tungstenite::tungstenite::{Error, Message};
    let s = TestServer::start().await;
    let p = s.create_project("terminal-access").await;
    let (status, terminal) = s.post(&format!("/api/v1/projects/{}/terminals", p["id"].as_str().unwrap()), json!({})).await;
    assert_eq!(status, StatusCode::CREATED);
    let id = terminal["id"].as_str().unwrap();
    let d = device(&s, "terminal").await;
    let mut urls = Vec::new();
    for _ in 0..2 {
        let response = s.raw(Method::POST, &format!("/api/v1/terminals/{id}/ticket"), Some(json!({})), None, Some(d["token"].as_str().unwrap())).await;
        assert_eq!(response.status(), StatusCode::OK);
        let ticket: Value = response.json().await.unwrap();
        urls.push(format!("{}{}", s.base.replace("http://", "ws://"), ticket["url"].as_str().unwrap()));
    }
    let (mut socket, _) = tokio_tungstenite::connect_async(&urls[0]).await.unwrap();
    assert!(matches!(socket.next().await, Some(Ok(Message::Text(_)))));
    assert_eq!(s.send(Method::DELETE, &format!("/api/v1/devices/{}", d["id"].as_str().unwrap()), json!({})).await.0, StatusCode::OK);
    match tokio_tungstenite::connect_async(&urls[1]).await {
        Err(Error::Http(response)) => assert_eq!(response.status(), StatusCode::UNAUTHORIZED),
        _ => panic!("폐기한 기기가 발급한 미사용 티켓은 upgrade할 수 없다"),
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match socket.next().await {
                None | Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => {}
                Some(Err(e)) => panic!("정상 close 대신 오류: {e}"),
            }
        }
    }).await.expect("폐기한 기기의 기존 소켓도 닫혀야 한다");
    let (_, terminals) = s.get(&format!("/api/v1/projects/{}/terminals", p["id"].as_str().unwrap())).await;
    assert_eq!(terminals["terminals"][0]["status"], "running", "다른 기기의 공유 PTY를 종료하지 않는다");
    assert_eq!(s.post(&format!("/api/v1/terminals/{id}/kill"), json!({})).await.0, StatusCode::OK);
}
