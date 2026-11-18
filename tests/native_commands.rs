mod common;
use common::TestServer;
use reqwest::{Method, StatusCode};
use serde_json::json;

#[tokio::test]
async fn catalog_rejects_unknown_scope_profiles_and_arbitrary_paths_before_cli_start() {
    let server = TestServer::start().await;
    let a = server.create_project("a").await;
    let b = server.create_project("b").await;
    let session = server.create_session(b["id"].as_str().unwrap()).await;
    let path = format!("/api/v1/projects/{}/native-commands?profile_id=missing", a["id"].as_str().unwrap());
    let response = server.raw(Method::GET, &path, None, None, Some("")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let (status, _) = server.get(&format!("{path}&root=/private")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = server.get(&format!("{path}&session_id={}", session["id"].as_str().unwrap())).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = server.get(&path).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn legacy_selections_and_files_are_preserved_but_retired_management_is_not_routable() {
    let mut server = TestServer::start().await;
    let fixture = common::fixture::Fixture::start().await;
    let profile = server.fixture_profile(&fixture.base).await;
    let project = server.create_project("legacy").await;
    let session = server.create_session(project["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap().to_string();
    server.server.as_ref().unwrap().app.db.call({
        let sid = sid.clone();
        move |c| {
            c.execute("INSERT INTO session_skills(session_id,bindings) VALUES(?1,'[{\"legacy\":\"retired-skill-canary\"}]')", [&sid])?;
            Ok(())
        }
    }).await.unwrap();
    let file = server.data_dir().join("skills/legacy/SKILL.md");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "retired-skill-canary").unwrap();
    server.restart().await;
    for suffix in ["", "/body", "/selection", "/management"] {
        let path = format!("/api/v1/sessions/{sid}/skills{suffix}");
        let response = server.raw(if suffix == "/body" { Method::POST } else if suffix.is_empty() { Method::GET } else { Method::PUT },
            &path, Some(json!({})), Some(&server.key()), None).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
    let count = server.server.as_ref().unwrap().app.db.call(move |c| {
        Ok(c.query_row("SELECT COUNT(*) FROM session_skills WHERE session_id=?1", [&sid], |row| row.get::<_, i64>(0))?)
    }).await.unwrap();
    assert_eq!(count, 1);
    fixture.push(common::fixture::text("no legacy skill injection"));
    let (status, turn) = server.post(&format!("/api/v1/sessions/{}/turns", session["id"].as_str().unwrap()),
        json!({"text":"ordinary request","profile_id":profile})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    server.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
    assert!(!fixture.requests()[0].to_string().contains("retired-skill-canary"));
    assert_eq!(std::fs::read_to_string(file).unwrap(), "retired-skill-canary");
}

#[tokio::test]
async fn queued_native_selection_is_durable_idempotent_and_never_applied_as_steer() {
    let server = TestServer::start().await;
    let project = server.create_project("queued").await;
    let session = server.create_session(project["id"].as_str().unwrap()).await;
    let (status, profile) = server.post("/api/v1/model-profiles",
        json!({"name":"codex","protocol":"codex_cli","base_url":"","model":"default"})).await;
    assert_eq!(status, StatusCode::CREATED);
    let sid = session["id"].as_str().unwrap().to_string();
    let pid = profile["id"].as_str().unwrap().to_string();
    server.server.as_ref().unwrap().app.db.call({
        let (sid, pid) = (sid.clone(), pid.clone());
        move |c| {
            c.execute("INSERT INTO messages(id,session_id,seq,role,content,created_at) VALUES('held-msg',?1,1,'user','{}','2026-01-01')", [&sid])?;
            c.execute("INSERT INTO turns(id,session_id,status,request_message_id,profile_id,created_at,updated_at,owner_epoch) VALUES('held',?1,'running','held-msg',?2,'2026-01-01','2026-01-01','held')", rusqlite::params![sid,pid])?;
            Ok(())
        }
    }).await.unwrap();
    let id = format!("cmd_{}", "a".repeat(64));
    let body = json!({"kind":"queue","text":"/review file","profile_id":pid,"native_command":id});
    let key = server.key();
    let path = format!("/api/v1/sessions/{sid}/followups");
    for _ in 0..2 {
        let response = server.raw(Method::POST, &path, Some(body.clone()), Some(&key), None).await;
        assert_eq!(response.status(), StatusCode::CREATED);
    }
    let (_, saved) = server.get(&path).await;
    assert_eq!(saved["items"].as_array().unwrap().len(), 1);
    assert_eq!(saved["items"][0]["native_command"], id);
    let mut changed = body.clone();
    changed["native_command"] = json!(format!("cmd_{}", "b".repeat(64)));
    assert_eq!(server.raw(Method::POST, &path, Some(changed), Some(&key), None).await.status(), StatusCode::CONFLICT);
    let mut steer = body;
    steer["kind"] = json!("steer");
    assert_eq!(server.post(&path, steer).await.0, StatusCode::BAD_REQUEST);
}
