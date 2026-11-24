mod common;

use base64::Engine;
use common::TestServer;
use ed25519_dalek::SigningKey;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::path::PathBuf;

const SETTINGS: &str = "/api/v1/updates/settings";
const CHECK: &str = "/api/v1/updates/check";

fn source(s: &TestServer) -> (PathBuf, SigningKey) {
    let root = s.dir.path().join("update-fixture");
    std::fs::create_dir_all(&root).unwrap();
    let key = SigningKey::from_bytes(&[25; 32]);
    std::fs::write(root.join("trusted-keys.json"), json!({ "keys": [{
        "key_id": grove::update::key_id(&key.verifying_key()),
        "public_key": base64::engine::general_purpose::STANDARD.encode(key.verifying_key().as_bytes()),
    }] }).to_string()).unwrap();
    std::fs::write(s.data_dir().join("update-source.json"), json!({
        "root": root, "manifests": { "stable": root.join("stable.json"), "beta": root.join("beta.json") },
    }).to_string()).unwrap();
    (root, key)
}

fn manifest(root: &std::path::Path, key: &SigningKey, channel: &str, version: &str) {
    let release = json!({
        "product": "grove", "version": version, "channel": channel,
        "protocol": grove::PROTOCOL_VERSION, "schema": grove::store::MIGRATIONS.len(),
        "issued_at": "2026-09-21T00:00:00Z",
        // 확인은 패키지를 내려받지 않으므로 존재하지 않는 로컬 경로여도 된다.
        "artifacts": { grove::update::platform(): { "url": "/not-downloaded", "sha256": "0".repeat(64), "size": 1 } },
    });
    std::fs::write(root.join(format!("{channel}.json")), grove::update::sign_release(&release, std::slice::from_ref(key)).to_string()).unwrap();
}

#[tokio::test]
async fn defaults_enable_auto_apply_and_devices_are_read_only() {
    let s = TestServer::start().await;
    let (status, initial) = s.get(SETTINGS).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(initial["server"], json!({
        "version": grove::VERSION, "protocol": grove::PROTOCOL_VERSION, "schema": grove::store::MIGRATIONS.len(),
    }));
    assert_eq!(initial["settings"], json!({ "channel": "stable", "auto_apply": "minor", "revision": 0 }));
    assert_eq!(initial["last_check"], Value::Null);
    assert_eq!(initial["automatic_application"], "external");
    assert_eq!(initial["can_manage"], true);
    let device = s.registered_device("update settings").await;
    let token = device["token"].as_str().unwrap();
    let response = s.raw(Method::GET, SETTINGS, None, None, Some(token)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let read: Value = response.json().await.unwrap();
    assert_eq!(read["can_manage"], true);
    assert_eq!(read["server"], initial["server"]);
    let response = s.raw(Method::PUT, SETTINGS,
        Some(json!({ "channel": "beta", "auto_apply": "minor", "expected_revision": 0 })), Some("device-write"), Some(token)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(s.raw(Method::GET, SETTINGS, None, None, Some("")).await.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(s.get(SETTINGS).await.1["settings"]["channel"], "beta");
    assert_eq!(s.get(SETTINGS).await.1["last_check"], Value::Null);
}

#[tokio::test]
async fn owner_saves_with_revision_idempotency_and_restart_persistence() {
    let mut s = TestServer::start().await;
    let body = json!({ "channel": "beta", "auto_apply": "patch", "expected_revision": 0 });
    for replayed in [false, true] {
        let response = s.raw(Method::PUT, SETTINGS, Some(body.clone()), Some("settings-once"), None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().contains_key("idempotent-replayed"), replayed);
        assert_eq!(response.json::<Value>().await.unwrap()["settings"]["revision"], 1);
    }
    assert_eq!(s.send(Method::PUT, SETTINGS, body).await.0, StatusCode::CONFLICT);
    let (status, conflict) = s.post(CHECK, json!({ "expected_revision": 0 })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["error"]["code"], "revision_conflict");
    for body in [
        json!({ "channel": "nightly", "auto_apply": "patch", "expected_revision": 1 }),
        json!({ "channel": "stable", "auto_apply": "everything", "expected_revision": 1 }),
        json!({ "channel": "stable", "auto_apply": "minor", "expected_revision": 1, "source": "https://invalid" }),
    ] {
        assert_eq!(s.send(Method::PUT, SETTINGS, body).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    }
    s.restart().await;
    assert_eq!(s.get(SETTINGS).await.1["settings"], json!({ "channel": "beta", "auto_apply": "patch", "revision": 1 }));
    let (status, _) = s.send(Method::PUT, SETTINGS, json!({ "channel": "stable", "auto_apply": "notify_only", "expected_revision": 1 })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    s.server.as_ref().unwrap().app.db.call(|c| {
        c.execute("UPDATE settings SET value=json_set(value,'$.auto_apply','notify_only') WHERE key='server_update.preferences'", [])?;
        Ok(())
    }).await.unwrap();
    s.restart().await;
    assert_eq!(s.get(SETTINGS).await.1["settings"], json!({ "channel": "beta", "auto_apply": "minor", "revision": 1 }));
}

#[tokio::test]
async fn signed_local_checks_cover_new_current_failed_and_channel_selection_without_applying() {
    let mut s = TestServer::start().await;
    let (root, key) = source(&s);
    manifest(&root, &key, "stable", "9999.0.0");
    let web = "/api/v1/updates/web-release?version=1.0.0";
    assert_eq!(s.get(web).await, (StatusCode::OK, json!({ "version": "9999.0.0", "newer": true })));
    assert_eq!(s.get(SETTINGS).await.1["last_check"], Value::Null);
    let (status, available) = s.post(CHECK, json!({ "expected_revision": 0 })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(available["last_check"]["status"], "available");
    assert_eq!(available["last_check"]["release"]["available"], "9999.0.0");
    assert_eq!(available["last_check"]["release"]["current"], grove::VERSION);
    assert_eq!(available["last_check"]["release"]["artifact"], true);
    assert!(!root.join("update-state.json").exists());
    assert!(!root.join("current").exists());
    manifest(&root, &key, "stable", grove::VERSION);
    let response = s.raw(Method::POST, CHECK, Some(json!({ "expected_revision": 0 })), Some("check-once"), None).await;
    let same: Value = response.json().await.unwrap();
    assert_eq!(same["last_check"]["status"], "up_to_date");
    std::fs::write(root.join("stable.json"), "invalid manifest").unwrap();
    let response = s.raw(Method::POST, CHECK, Some(json!({ "expected_revision": 0 })), Some("check-once"), None).await;
    assert_eq!(response.headers()["idempotent-replayed"], "true");
    assert_eq!(response.json::<Value>().await.unwrap(), same);
    assert_eq!(s.get(web).await.0, StatusCode::BAD_GATEWAY);
    let (_, failed) = s.post(CHECK, json!({ "expected_revision": 0 })).await;
    assert_eq!(failed["last_check"]["status"], "failed");
    assert_eq!(failed["last_check"]["error"], "manifest_check_failed");
    assert!(!failed.to_string().contains(root.to_str().unwrap()));
    let (status, _) = s.send(Method::PUT, SETTINGS, json!({ "channel": "beta", "auto_apply": "minor", "expected_revision": 0 })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(s.get(SETTINGS).await.1["last_check"]["channel"], "stable");
    manifest(&root, &key, "beta", "9999.1.0-beta.1");
    let (_, beta) = s.post(CHECK, json!({ "expected_revision": 1 })).await;
    assert_eq!(beta["last_check"]["channel"], "beta");
    assert_eq!(beta["last_check"]["release"]["available"], "9999.1.0-beta.1");
    s.restart().await;
    assert_eq!(s.get(SETTINGS).await.1["last_check"], beta["last_check"]);
    // beta 경로에 유효하게 서명된 stable manifest를 넣어도 채널이 다르면 거부한다.
    manifest(&root, &key, "stable", "9999.2.0");
    std::fs::copy(root.join("stable.json"), root.join("beta.json")).unwrap();
    assert_eq!(s.post(CHECK, json!({ "expected_revision": 1 })).await.1["last_check"]["status"], "failed");
}

#[tokio::test]
async fn missing_or_network_sources_are_recorded_as_failures_without_network_access() {
    let s = TestServer::start().await;
    assert_eq!(s.post(CHECK, json!({ "expected_revision": 0 })).await.1["last_check"]["error"], "local_source_unavailable");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    std::fs::write(s.data_dir().join("update-source.json"), json!({
        "root": s.dir.path(), "manifests": { "stable": format!("http://{}/manifest", listener.local_addr().unwrap()) },
    }).to_string()).unwrap();
    let (_, failed) = s.post(CHECK, json!({ "expected_revision": 0 })).await;
    assert_eq!(failed["last_check"]["error"], "local_source_required");
    assert_eq!(listener.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
    let response = s.raw(Method::POST, CHECK, Some(json!({ "expected_revision": 0 })), None, None).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn active_work_is_reported_and_never_cancelled_by_checking() {
    let s = TestServer::start().await;
    let project = s.create_project("update-busy").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    s.server.as_ref().unwrap().app.db.call(move |c| {
        c.execute(
            "INSERT INTO tasks(id,session_id,project_id,command,cwd,timeout_ms,status,detached,started_at) VALUES('update-busy',?1,?2,'not-executed','/',1000,'running',0,'2026-09-21T00:00:00Z')",
            rusqlite::params![session["id"].as_str().unwrap(), project["id"].as_str().unwrap()],
        )?;
        Ok(())
    }).await.unwrap();
    let (_, status) = s.get(SETTINGS).await;
    assert_eq!(status["readiness"]["idle"], false);
    assert_eq!(status["readiness"]["busy"]["running_tasks"], 1);
    let server = s.server.as_ref().unwrap();
    let seq = server.app.db.call(|c| grove::events::latest_seq(c)).await.unwrap();
    let cutover = format!("/api/v1/admin/shutdown-if-idle?pid={}&revision=0&snapshot_seq={seq}", std::process::id());
    assert_eq!(s.post(&cutover, json!({})).await.0, StatusCode::CONFLICT);
    assert!(!*server.app.exit_tx.borrow());
    let (_, existing) = s.get("/api/v1/admin/update-readiness").await;
    assert_eq!(status["readiness"]["busy"], existing["busy"]);
    s.post(CHECK, json!({ "expected_revision": 0 })).await;
    assert_eq!(s.get(SETTINGS).await.1["readiness"]["busy"]["running_tasks"], 1);
}
