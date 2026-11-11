mod common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

#[tokio::test]
async fn health_is_public_and_api_requires_token() {
    let s = TestServer::start().await;
    let r = s.raw(Method::GET, "/api/v1/health", None, None, Some("")).await;
    assert_eq!(r.status(), StatusCode::OK);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["status"], "ready");
    assert_eq!(v["protocol"], 1);

    // 토큰 없음 / 잘못된 토큰 / 형식 오류
    for t in ["", "grv_nope.nope", "garbage"] {
        let r = s.raw(Method::GET, "/api/v1/projects", None, None, Some(t)).await;
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED, "token {t:?}");
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["error"]["code"], "unauthorized");
    }
    // 올바른 id에 틀린 secret
    let (id, _) = grove::auth::parse_token(&s.token).unwrap();
    let bad = format!("grv_{id}.wrong");
    let r = s.raw(Method::GET, "/api/v1/projects", None, None, Some(&bad)).await;
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    let (st, _) = s.get("/api/v1/projects").await;
    assert_eq!(st, StatusCode::OK);
}

#[tokio::test]
async fn cross_site_and_foreign_host_are_rejected() {
    let s = TestServer::start().await;
    let url = format!("{}/api/v1/projects", s.base);
    // FLOW-01: 임의 웹사이트 origin
    let r = s.client.get(&url).bearer_auth(&s.token).header("Origin", "https://evil.example").send().await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    let r = s.client.get(&url).bearer_auth(&s.token).header("Sec-Fetch-Site", "cross-site").send().await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    // DNS rebinding: loopback 바인딩인데 다른 Host
    let r = s.client.get(&url).bearer_auth(&s.token).header("Host", "evil.example").send().await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    // 같은 origin은 허용, 기존 연결 유지
    let r = s.client.get(&url).bearer_auth(&s.token).header("Origin", &s.base).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    // 로그인 경로도 교차 사이트 거부
    let r = s
        .client
        .post(format!("{}/api/v1/auth/browser-login", s.base))
        .header("Origin", "https://evil.example")
        .json(&json!({ "token": s.token }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn idempotency_replay_conflict_and_missing_key() {
    let s = TestServer::start().await;
    let dir = s.make_project_dir("a");
    let body = json!({ "root_path": dir });
    let r1 = s.raw(Method::POST, "/api/v1/projects", Some(body.clone()), Some("same"), None).await;
    assert_eq!(r1.status(), StatusCode::CREATED);
    let v1: Value = r1.json().await.unwrap();
    let r2 = s.raw(Method::POST, "/api/v1/projects", Some(body.clone()), Some("same"), None).await;
    assert_eq!(r2.status(), StatusCode::CREATED);
    assert_eq!(r2.headers().get("idempotent-replayed").unwrap(), "true");
    let v2: Value = r2.json().await.unwrap();
    assert_eq!(v1, v2);
    let (_, list) = s.get("/api/v1/projects").await;
    assert_eq!(list.as_array().unwrap().len(), 1, "재전송이 두 번째 프로젝트를 만들면 안 된다");

    let other = s.make_project_dir("b");
    let r3 = s.raw(Method::POST, "/api/v1/projects", Some(json!({ "root_path": other })), Some("same"), None).await;
    assert_eq!(r3.status(), StatusCode::CONFLICT);
    let v3: Value = r3.json().await.unwrap();
    assert_eq!(v3["error"]["code"], "idempotency_conflict");

    let r4 = s.raw(Method::POST, "/api/v1/projects", Some(json!({ "root_path": other })), None, None).await;
    assert_eq!(r4.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn projects_validation_and_revision() {
    let s = TestServer::start().await;
    let (st, v) = s.post("/api/v1/projects", json!({ "root_path": "/definitely/not/here" })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{v}");
    let p = s.create_project("alpha").await;
    let dir = p["root_path"].as_str().unwrap().to_string();
    let (st, v) = s.post("/api/v1/projects", json!({ "root_path": dir })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["code"], "already_exists");
    assert_eq!(v["error"]["details"]["id"], p["id"]);

    let id = p["id"].as_str().unwrap();
    let (st, v) = s.send(Method::PATCH, &format!("/api/v1/projects/{id}"), json!({ "expected_revision": 1, "name": "알파" })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["name"], "알파");
    assert_eq!(v["revision"], 2);
    let (st, v) = s.send(Method::PATCH, &format!("/api/v1/projects/{id}"), json!({ "expected_revision": 1, "name": "x" })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["code"], "revision_conflict");
    assert_eq!(v["error"]["details"]["current"]["name"], "알파");
}

#[tokio::test]
async fn sessions_messages_and_pagination() {
    let s = TestServer::start().await;
    let p = s.create_project("p").await;
    let pid = p["id"].as_str().unwrap();
    let mut ids = vec![];
    for _ in 0..5 {
        ids.push(s.create_session(pid).await["id"].as_str().unwrap().to_string());
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    let (_, page1) = s.get(&format!("/api/v1/projects/{pid}/sessions?limit=2")).await;
    assert_eq!(page1["items"].as_array().unwrap().len(), 2);
    let c = page1["next_cursor"].as_str().unwrap();
    let (_, page2) = s.get(&format!("/api/v1/projects/{pid}/sessions?limit=2&cursor={}", urlenc(c))).await;
    let (_, page3) = s
        .get(&format!("/api/v1/projects/{pid}/sessions?limit=2&cursor={}", urlenc(page2["next_cursor"].as_str().unwrap())))
        .await;
    assert!(page3["next_cursor"].is_null());
    let mut seen: Vec<String> = [&page1, &page2, &page3]
        .iter()
        .flat_map(|p| p["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap().to_string()))
        .collect();
    seen.sort();
    let mut want = ids.clone();
    want.sort();
    assert_eq!(seen, want, "페이지 경계에서 누락·중복 없음");

    let sid = &ids[0];
    for i in 0..7 {
        let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": format!("m{i}") })).await;
        assert_eq!(st, StatusCode::CREATED, "{v}");
        assert_eq!(v["seq"], i + 1);
    }
    let (_, last) = s.get(&format!("/api/v1/sessions/{sid}/messages?limit=3")).await;
    let seqs: Vec<i64> = last["items"].as_array().unwrap().iter().map(|m| m["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs, vec![5, 6, 7]);
    assert_eq!(last["has_more_before"], true);
    let (_, before) = s.get(&format!("/api/v1/sessions/{sid}/messages?limit=3&before_seq=5")).await;
    let seqs: Vec<i64> = before["items"].as_array().unwrap().iter().map(|m| m["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs, vec![2, 3, 4]);
    let (_, after) = s.get(&format!("/api/v1/sessions/{sid}/messages?after_seq=5")).await;
    assert_eq!(after["items"].as_array().unwrap().len(), 2);
    assert_eq!(after["has_more_after"], false);

    let (st, _) = s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": "   " })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

fn urlenc(s: &str) -> String {
    s.replace('|', "%7C").replace('+', "%2B").replace(':', "%3A")
}

#[tokio::test]
async fn session_rename_archive_restore() {
    let s = TestServer::start().await;
    let p = s.create_project("p").await;
    let sess = s.create_session(p["id"].as_str().unwrap()).await;
    let sid = sess["id"].as_str().unwrap();
    let (st, v) = s.send(Method::PATCH, &format!("/api/v1/sessions/{sid}"), json!({ "expected_revision": 1, "title": "이름" })).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["title"], "이름");
    let (st, v) = s.send(Method::PATCH, &format!("/api/v1/sessions/{sid}"), json!({ "expected_revision": 2, "archived": true })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert!(v["archived_at"].is_string());
    // 보관 후 새 메시지 거절
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": "x" })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["code"], "archived");
    let (_, list) = s.get(&format!("/api/v1/projects/{}/sessions?archived=true", p["id"].as_str().unwrap())).await;
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    let (st, _) = s.send(Method::PATCH, &format!("/api/v1/sessions/{sid}"), json!({ "expected_revision": 3, "archived": false })).await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": "x" })).await;
    assert_eq!(st, StatusCode::CREATED);
}

#[tokio::test]
async fn sse_cursor_replay_without_duplicates() {
    let s = TestServer::start().await;
    let p = s.create_project("p").await;
    let sess = s.create_session(p["id"].as_str().unwrap()).await;
    let sid = sess["id"].as_str().unwrap();
    let evs = s.read_events(Some(0), "", 2, 2000).await;
    assert_eq!(evs[0].0, "hello");
    let all = events_of(&evs, "project.created").len() + events_of(&evs, "session.created").len();
    assert_eq!(all, 2);
    let cursor = evs.iter().filter(|(n, _)| n == "event").map(|(_, v)| v["seq"].as_i64().unwrap()).max().unwrap();

    // 단절 중 발생한 메시지를 cursor로 정확히 한 번씩 재생(FLOW-05)
    for i in 0..3 {
        s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": format!("m{i}") })).await;
    }
    let evs = s.read_events(Some(cursor), "", 3, 2000).await;
    let msgs = events_of(&evs, "message.created");
    let texts: Vec<&str> = msgs.iter().map(|v| v["payload"]["content"]["text"].as_str().unwrap()).collect();
    assert_eq!(texts, vec!["m0", "m1", "m2"]);
    let seqs: Vec<i64> = msgs.iter().map(|v| v["seq"].as_i64().unwrap()).collect();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]));

    // 실시간 수신
    let base = s.base.clone();
    let token = s.token.clone();
    let client = s.client.clone();
    let last = *seqs.last().unwrap();
    let reader = tokio::spawn(async move { read_sse(&client, &base, &token, Some(last), "", 1, 3000).await });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": "live" })).await;
    let evs = reader.await.unwrap();
    assert_eq!(events_of(&evs, "message.created")[0]["payload"]["content"]["text"], "live");

    // 존재하지 않는 미래 cursor → resync
    let evs = s.read_events(Some(1_000_000), "", 1, 2000).await;
    assert_eq!(evs.last().unwrap().0, "resync");
}

#[tokio::test]
async fn notifications_paginate_by_keyset_cursor() {
    let s = TestServer::start().await;
    {
        // 같은 시각 알림도 섞어 keyset 경계를 시험한다(서버와 같은 DB 파일, WAL).
        let c = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
        for i in 0..7 {
            let t = format!("2026-01-01T00:00:0{}Z", i / 2);
            c.execute(
                "INSERT INTO notifications (id, kind, title, body, created_at) VALUES (?1, 'info', ?2, '', ?3)",
                rusqlite::params![format!("n{i}"), format!("t{i}"), t],
            )
            .unwrap();
        }
    }
    let mut seen = vec![];
    let mut cursor: Option<String> = None;
    for _ in 0..5 {
        let path = match &cursor {
            Some(c) => format!("/api/v1/notifications?limit=3&before={}", urlencoding(c)),
            None => "/api/v1/notifications?limit=3".into(),
        };
        let (st, v) = s.get(&path).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        seen.extend(v["items"].as_array().unwrap().iter().map(|x| x["id"].as_str().unwrap().to_string()));
        cursor = v["next_cursor"].as_str().map(String::from);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(seen, ["n6", "n5", "n4", "n3", "n2", "n1", "n0"], "중복·누락 없이 최신순");
    let (st, _) = s.get("/api/v1/notifications?before=bad").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

fn urlencoding(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[tokio::test]
async fn sse_expired_cursor_requires_resync() {
    let s = TestServer::start().await;
    s.create_project("p").await;
    s.create_project("q").await;
    // 오래된 이벤트를 인위적으로 정리해 cursor 0이 보존 범위 밖이 되게 한다.
    let app = s.server.as_ref().unwrap().app.clone();
    app.db.call(|c| Ok(c.execute("DELETE FROM events WHERE seq = 1", [])?)).await.unwrap();
    let evs = s.read_events(Some(0), "", 1, 2000).await;
    assert_eq!(evs.last().unwrap().0, "resync");
    assert_eq!(evs.last().unwrap().1["reason"], "cursor_expired");
    let evs = s.read_events(Some(1), "", 1, 2000).await;
    assert_eq!(evs.last().unwrap().0, "event");
}

#[tokio::test]
async fn devices_issue_list_revoke() {
    let s = TestServer::start().await;
    let (st, v) = s.post("/api/v1/devices", json!({ "name": "폰" })).await;
    assert_eq!(st, StatusCode::CREATED);
    let dev_token = v["token"].as_str().unwrap().to_string();
    let dev_id = v["id"].as_str().unwrap().to_string();
    // 기기 토큰으로 일반 API 사용 가능, 기기 관리 불가
    let r = s.raw(Method::GET, "/api/v1/projects", None, None, Some(&dev_token)).await;
    assert_eq!(r.status(), StatusCode::OK);
    let r = s.raw(Method::GET, "/api/v1/devices", None, None, Some(&dev_token)).await;
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    let (_, list) = s.get("/api/v1/devices").await;
    assert!(list.as_array().unwrap().iter().any(|d| d["id"] == dev_id.as_str()));
    // 토큰 원문은 목록·idempotency 저장본에 없다
    assert!(!list.to_string().contains(dev_token.split('.').nth(1).unwrap()));
    let (st, _) = s.send(Method::DELETE, &format!("/api/v1/devices/{dev_id}"), json!({})).await;
    assert_eq!(st, StatusCode::OK);
    let r = s.raw(Method::GET, "/api/v1/projects", None, None, Some(&dev_token)).await;
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    // 소유자 토큰은 폐기 불가
    let (oid, _) = grove::auth::parse_token(&s.token).unwrap();
    let (st, _) = s.send(Method::DELETE, &format!("/api/v1/devices/{oid}"), json!({})).await;
    assert_eq!(st, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn device_token_redacted_on_replay() {
    let s = TestServer::start().await;
    let body = json!({ "name": "pc" });
    let r1 = s.raw(Method::POST, "/api/v1/devices", Some(body.clone()), Some("dev-1"), None).await;
    let v1: Value = r1.json().await.unwrap();
    assert!(v1["token"].is_string());
    let r2 = s.raw(Method::POST, "/api/v1/devices", Some(body), Some("dev-1"), None).await;
    let v2: Value = r2.json().await.unwrap();
    assert!(v2.get("token").is_none());
    assert_eq!(v2["token_redacted"], true);
    assert_eq!(v1["id"], v2["id"]);
}

#[tokio::test]
async fn browser_login_refresh_logout() {
    let s = TestServer::start().await;
    let client = reqwest::Client::new();
    let login = client
        .post(format!("{}/api/v1/auth/browser-login", s.base))
        .header("Origin", &s.base)
        .json(&json!({ "token": s.token, "name": "chrome" }))
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), StatusCode::OK);
    let cookie = login.headers().get("set-cookie").unwrap().to_str().unwrap().to_string();
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict") && cookie.contains("Path=/api/v1/auth"));
    let v: Value = login.json().await.unwrap();
    let access = v["access_token"].as_str().unwrap().to_string();
    let r = s.raw(Method::GET, "/api/v1/auth/whoami", None, None, Some(&access)).await;
    assert_eq!(r.status(), StatusCode::OK);
    let who: Value = r.json().await.unwrap();
    assert_eq!(who["kind"], "browser");
    assert_eq!(who["is_owner"], true);

    // refresh 쿠키 원문은 Bearer로 쓸 수 없다
    let refresh_raw = cookie.split(';').next().unwrap().split_once('=').unwrap().1.to_string();
    let r = s.raw(Method::GET, "/api/v1/projects", None, None, Some(&refresh_raw)).await;
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);

    // refresh: 쿠키 교체, 이전 쿠키 재사용 거절
    let cookie_kv = cookie.split(';').next().unwrap().to_string();
    let r = client.post(format!("{}/api/v1/auth/refresh", s.base)).header("Cookie", &cookie_kv).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let new_cookie = r.headers().get("set-cookie").unwrap().to_str().unwrap().split(';').next().unwrap().to_string();
    assert_ne!(new_cookie, cookie_kv);
    let r = client.post(format!("{}/api/v1/auth/refresh", s.base)).header("Cookie", &cookie_kv).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);

    // logout: refresh·access 모두 무효
    let r = client.post(format!("{}/api/v1/auth/logout", s.base)).header("Cookie", &new_cookie).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let r = s.raw(Method::GET, "/api/v1/auth/whoami", None, None, Some(&access)).await;
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    let r = client.post(format!("{}/api/v1/auth/refresh", s.base)).header("Cookie", &new_cookie).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
}

/// NET-020/021: 5회 실패 시 잠금, 재시작 후에도 유지, 로컬 복구로 해제.
#[tokio::test]
async fn browser_login_lockout_persists_and_can_be_cleared_locally() {
    let mut s = TestServer::start().await;
    let url = |s: &TestServer| format!("{}/api/v1/auth/browser-login", s.base);
    for _ in 0..5 {
        let r = s.client.post(url(&s)).json(&json!({ "token": "grv_x.y" })).send().await.unwrap();
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    }
    // 올바른 토큰도 잠금 중에는 거절
    let r = s.client.post(url(&s)).json(&json!({ "token": s.token })).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::TOO_MANY_REQUESTS);
    s.restart().await;
    let r = s.client.post(url(&s)).json(&json!({ "token": s.token })).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::TOO_MANY_REQUESTS, "잠금은 재시작 후에도 유지");
    // Bearer API는 잠금과 무관(토큰 자체가 256bit 비밀)
    let (st, _) = s.get("/api/v1/projects").await;
    assert_eq!(st, StatusCode::OK);
    let app = s.server.as_ref().unwrap().app.clone();
    app.db.call(|c| grove::auth::clear_lockouts(c)).await.unwrap();
    let r = s.client.post(url(&s)).json(&json!({ "token": s.token })).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
}

#[tokio::test]
async fn access_tokens_do_not_survive_restart_but_data_does() {
    let mut s = TestServer::start().await;
    let p = s.create_project("p").await;
    let sess = s.create_session(p["id"].as_str().unwrap()).await;
    s.post(&format!("/api/v1/sessions/{}/messages", sess["id"].as_str().unwrap()), json!({ "text": "보존" })).await;
    let r = s
        .client
        .post(format!("{}/api/v1/auth/browser-login", s.base))
        .json(&json!({ "token": s.token }))
        .send()
        .await
        .unwrap();
    let access = r.json::<Value>().await.unwrap()["access_token"].as_str().unwrap().to_string();
    let owner_before = s.token.clone();
    s.restart().await;
    assert_eq!(s.token, owner_before, "소유자 토큰 파일은 재시작 후에도 유효");
    let r = s.raw(Method::GET, "/api/v1/projects", None, None, Some(&access)).await;
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    let (_, m) = s.get(&format!("/api/v1/sessions/{}/messages", sess["id"].as_str().unwrap())).await;
    assert_eq!(m["items"][0]["content"]["text"], "보존");
}

#[tokio::test]
async fn second_server_on_same_data_dir_is_refused() {
    let s = TestServer::start().await;
    let cfg = config(&s.data_dir());
    let err = grove::server::start(cfg, std::sync::Arc::new(grove::util::SystemClock)).await.err().unwrap();
    assert!(err.contains("이미 서버가 실행 중"), "{err}");
}

#[tokio::test]
async fn port_conflict_is_reported() {
    let s = TestServer::start().await;
    let other = tempfile::tempdir().unwrap();
    let mut cfg = config(&other.path().join("data"));
    cfg.listen = s.server.as_ref().unwrap().addr;
    let err = grove::server::start(cfg, std::sync::Arc::new(grove::util::SystemClock)).await.err().unwrap();
    assert!(err.contains("이미 사용 중"), "{err}");
}

#[tokio::test]
async fn newer_schema_is_refused() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("grove.db");
    {
        let c = rusqlite::Connection::open(&path).unwrap();
        c.pragma_update(None, "user_version", 999).unwrap();
    }
    let err = grove::store::Db::open(&path).err().unwrap();
    assert!(err.to_string().contains("새롭습니다"), "{err}");
}

#[tokio::test]
async fn shutdown_rejects_new_mutations() {
    let s = TestServer::start().await;
    let app = s.server.as_ref().unwrap().app.clone();
    // graceful shutdown은 리스너를 닫으므로, 이미 열려 있던 연결을 흉내 내기 위해 같은 상태로 별도 리스너를 띄운다.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(axum::serve(listener, grove::router(app.clone())).into_future());
    app.shutdown_tx.send_replace(true);
    let dir = s.make_project_dir("z");
    let r = s
        .client
        .post(format!("http://{addr}/api/v1/projects"))
        .bearer_auth(&s.token)
        .header("Idempotency-Key", "k")
        .json(&json!({ "root_path": dir }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["error"]["code"], "shutting_down");
    assert_eq!(v["error"]["retryable"], true);
    // 조회는 계속 허용
    let r = s.client.get(format!("http://{addr}/api/v1/projects")).bearer_auth(&s.token).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
}

/// 오래 열린 탭(다른 protocol)이 보낸 변경 요청은 실행하지 않는다. 조회는 허용하고 모든 응답에 서버 protocol을 붙인다.
#[tokio::test]
async fn protocol_mismatch_blocks_mutations_but_not_reads() {
    let s = TestServer::start().await;
    let r = s.client.get(format!("{}/api/v1/projects", s.base)).bearer_auth(&s.token).header("x-grove-protocol", "999").send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers().get("x-grove-protocol").unwrap(), &grove::PROTOCOL_VERSION.to_string());
    let dir = s.make_project_dir("pm");
    let r = s
        .client
        .post(format!("{}/api/v1/projects", s.base))
        .bearer_auth(&s.token)
        .header("idempotency-key", "pm-1")
        .header("x-grove-protocol", "999")
        .json(&serde_json::json!({ "root_path": dir }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::CONFLICT);
    let v: serde_json::Value = r.json().await.unwrap();
    assert_eq!(v["error"]["code"], "protocol_mismatch");
    assert_eq!(v["error"]["details"]["server_protocol"], grove::PROTOCOL_VERSION);
    let (_, list) = s.get("/api/v1/projects").await;
    assert!(list.as_array().unwrap().is_empty(), "실행되지 않음");
    // 같은 protocol은 정상
    let r = s
        .client
        .post(format!("{}/api/v1/projects", s.base))
        .bearer_auth(&s.token)
        .header("idempotency-key", "pm-2")
        .header("x-grove-protocol", grove::PROTOCOL_VERSION.to_string())
        .json(&serde_json::json!({ "root_path": dir }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::CREATED);
}

/// 기능 협상(NET-001): 서버는 health·이벤트 hello에 같은 기능 목록을 알리고,
/// 클라이언트가 요구한 기능이 없으면 조회·변경 모두 실행하지 않는다. 헤더가 없으면 검사하지 않는다.
#[tokio::test]
async fn capability_negotiation_advertises_and_enforces_required_features() {
    let s = TestServer::start().await;
    let (_, h) = s.get("/api/v1/health").await;
    let caps: Vec<String> = serde_json::from_value(h["capabilities"].clone()).unwrap();
    assert_eq!(caps, grove::CAPABILITIES.iter().map(|c| c.to_string()).collect::<Vec<_>>());
    assert!(caps.contains(&"worktrees_v1".to_string()));
    // 이벤트 hello도 같은 목록
    let mut r = s.client.get(format!("{}/api/v1/events", s.base)).bearer_auth(&s.token).send().await.unwrap();
    let mut buf = String::new();
    while !buf.contains("\n\n") {
        buf.push_str(&String::from_utf8_lossy(&r.chunk().await.unwrap().unwrap()));
    }
    let data = buf.lines().find_map(|l| l.strip_prefix("data:")).unwrap().trim();
    let hello: serde_json::Value = serde_json::from_str(data).unwrap();
    assert_eq!(hello["capabilities"], h["capabilities"]);
    drop(r);

    let dir = s.make_project_dir("cap");
    let post = |key: &'static str, require: &'static str| {
        s.client
            .post(format!("{}/api/v1/projects", s.base))
            .bearer_auth(&s.token)
            .header("idempotency-key", key)
            .header("x-grove-require", require)
            .json(&serde_json::json!({ "root_path": dir }))
            .send()
    };
    let r = post("cap-1", "worktrees_v1, teleport_v9").await.unwrap();
    assert_eq!(r.status(), StatusCode::CONFLICT);
    let v: serde_json::Value = r.json().await.unwrap();
    assert_eq!(v["error"]["code"], "capability_missing");
    assert_eq!(v["error"]["details"]["missing"], serde_json::json!(["teleport_v9"]));
    let (_, list) = s.get("/api/v1/projects").await;
    assert!(list.as_array().unwrap().is_empty(), "실행되지 않음");
    // 조회도 같은 규칙
    let r = s.client.get(format!("{}/api/v1/projects", s.base)).bearer_auth(&s.token).header("x-grove-require", "teleport_v9").send().await.unwrap();
    assert_eq!(r.status(), StatusCode::CONFLICT);
    // 있는 기능만 요구하면 정상
    let r = post("cap-2", "worktrees_v1").await.unwrap();
    assert_eq!(r.status(), StatusCode::CREATED);
}
