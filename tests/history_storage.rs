//! 격리 DB에서 대화 저장 압축·필요 페이지 복원·재압축·검색·재시작을 검증한다.
mod common;

use common::*;
use grove::{App, error::ApiResult, util::Clock};
use reqwest::{Method, StatusCode};
use rusqlite::params;
use serde_json::json;
use std::sync::Arc;
use time::{Duration, OffsetDateTime};

struct FixedClock(OffsetDateTime);
impl Clock for FixedClock {
    fn now(&self) -> OffsetDateTime { self.0 }
}

fn app(s: &TestServer) -> App { s.server.as_ref().unwrap().app.clone() }

async fn compress_at(s: &TestServer, now: OffsetDateTime) -> ApiResult<usize> {
    let mut app = app(s);
    app.clock = Arc::new(FixedClock(now));
    tokio::task::spawn_blocking(move || grove::storage::compress_history(&app)).await.unwrap()
}

async fn seed(s: &TestServer, session: &str, count: usize, at: OffsetDateTime) -> Vec<grove::sessions::Message> {
    let session = session.to_string();
    let at = grove::util::fmt_time(at);
    app(s).db.call(move |c| {
        let tx = c.transaction()?;
        let mut messages = Vec::new();
        for index in 0..count {
            let body = json!({ "text": format!("기록 {index}: 압축검색 a\"b AlphaCase {} 끝", "같은 원문 줄\n".repeat(200)), "index": index });
            let model = json!({ "text": format!("모델 입력 {index}: {}", "별도 원문".repeat(200)) });
            messages.push(grove::sessions::append_message(&tx, &at, &session, if index % 2 == 0 { "user" } else { "assistant" }, &body, None, Some(&model))?);
        }
        tx.commit()?;
        Ok(messages)
    }).await.unwrap()
}

async fn stored_counts(s: &TestServer, session: &str) -> (i64, i64) {
    let session = session.to_string();
    app(s).db.call(move |c| Ok(c.query_row(
        "SELECT SUM(typeof(content)='blob'),SUM(typeof(model_input)='blob') FROM messages WHERE session_id=?1",
        [session], |r| Ok((r.get(0)?,r.get(1)?)),
    )?)).await.unwrap()
}

#[tokio::test]
async fn bounded_compression_restores_only_requested_pages_and_recompresses_after_idle() {
    let s = TestServer::start().await;
    let p = s.create_project("history-pages").await;
    let session = s.create_session(p["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap();
    let now = app(&s).clock.now();
    let messages = seed(&s, sid, 105, now - Duration::days(8)).await;
    assert_eq!(compress_at(&s, now).await.unwrap(), 100);
    assert_eq!(compress_at(&s, now).await.unwrap(), 5);
    assert_eq!(stored_counts(&s, sid).await, (105,105));
    let (status, page) = s.get(&format!("/api/v1/sessions/{sid}/messages?limit=2")).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["items"], serde_json::to_value(&messages[103..]).unwrap());
    assert_eq!(page["has_more_before"], true);
    assert_eq!(page["has_more_after"], false);
    assert_eq!(stored_counts(&s, sid).await, (103,103), "조회에 사용한 여분 한 행까지 저장 복원하지 않는다");
    assert_eq!(compress_at(&s, now + Duration::minutes(1)).await.unwrap(), 0);
    assert_eq!(compress_at(&s, now + Duration::days(8)).await.unwrap(), 2);
    assert_eq!(stored_counts(&s, sid).await, (105,105));
    let (status, page) = s.get(&format!("/api/v1/sessions/{sid}/messages?after_seq=1&limit=2")).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["items"], serde_json::to_value(&messages[1..3]).unwrap());
    assert_eq!(page["has_more_before"], true);
    assert_eq!(page["has_more_after"], true);
    assert_eq!(stored_counts(&s, sid).await, (103,103));
}

#[tokio::test]
async fn compressed_history_preserves_previews_search_model_input_forks_and_restart() {
    let mut s = TestServer::start().await;
    let p = s.create_project("history-search").await;
    let session = s.create_session(p["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap().to_string();
    let now = app(&s).clock.now();
    let messages = seed(&s, &sid, 4, now - Duration::days(8)).await;
    let (_, before) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    let (_, model_before) = s.get(&format!("/api/v1/sessions/{sid}/model-input")).await;
    let (_, context_before) = s.get(&format!("/api/v1/sessions/{sid}/context")).await;
    let (status, fork) = s.post(&format!("/api/v1/sessions/{sid}/fork"), json!({ "from_seq": 4, "inherit_context": true })).await;
    assert_eq!(status, StatusCode::CREATED, "{fork}");
    let fork_id = fork["id"].as_str().unwrap();
    assert_eq!(compress_at(&s, now).await.unwrap(), 4);
    assert_eq!(s.get(&format!("/api/v1/sessions/{sid}")).await.1, before);
    assert_eq!(s.get(&format!("/api/v1/sessions/{sid}/model-input")).await.1, model_before);
    assert_eq!(s.get(&format!("/api/v1/sessions/{sid}/context")).await.1, context_before);
    assert_eq!(s.get(&format!("/api/v1/sessions/{fork_id}/model-input")).await.1, model_before);
    for needle in ["압축검색", "압축", "a\"b", "alphacase", "원문 줄\n", "不存在"] {
        let q = reqwest::Url::parse_with_params("http://unused/", &[("q",needle)]).unwrap().query().unwrap().to_string();
        let (status, hits) = s.get(&format!("/api/v1/sessions/search?body=true&{q}")).await;
        assert_eq!(status, StatusCode::OK, "{needle}: {hits}");
        assert_eq!(hits["total"], if needle == "不存在" { 0 } else { 1 }, "{needle}: {hits}");
        let (status, recall) = s.get(&format!("/api/v1/recall?{q}")).await;
        assert_eq!(status, StatusCode::OK, "{needle}: {recall}");
        assert_eq!(recall["total"], if needle == "不存在" { 0 } else { 4 }, "{needle}: {recall}");
    }
    assert_eq!(stored_counts(&s, &sid).await, (4,4), "검색·모델 입력 조회는 디스크 압축본을 유지한다");
    s.restart().await;
    assert_eq!(stored_counts(&s, &sid).await, (4,4));
    let (status, page) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["items"], serde_json::to_value(messages).unwrap());
}

#[tokio::test]
async fn default_period_is_seven_days_and_configured_period_and_active_work_are_respected() {
    let s = TestServer::start().await;
    let p = s.create_project("history-policy").await;
    let session = s.create_session(p["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap().to_string();
    let now = app(&s).clock.now();
    let messages = seed(&s, &sid, 2, now - Duration::days(4)).await;
    let (_, settings) = s.get("/api/v1/settings/effective").await;
    let setting = settings["items"].as_array().unwrap().iter().find(|v| v["key"] == "storage.history_compress_after_days").unwrap();
    assert_eq!(setting["effective"], 7);
    assert_eq!(compress_at(&s, now).await.unwrap(), 0);
    for value in [json!(0),json!(-1),json!(3651),json!("7")] {
        let (status, body) = s.send(Method::PUT, "/api/v1/settings/server/-/storage.history_compress_after_days",
            json!({ "expected_revision": 0, "value": value })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
    let (status, body) = s.send(Method::PUT, "/api/v1/settings/server/-/storage.history_compress_after_days",
        json!({ "expected_revision": 0, "value": 1 })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let session_id = sid.clone();
    let message_id = messages[0].id.clone();
    app(&s).db.call(move |c| {
        c.execute("INSERT INTO turns(id,session_id,status,request_message_id,owner_epoch,created_at,updated_at) VALUES('active-history',?1,'queued',?2,'fixture','2026-01-01','2026-01-01')",
            params![session_id,message_id])?;
        Ok(())
    }).await.unwrap();
    assert_eq!(compress_at(&s, now).await.unwrap(), 0);
    app(&s).db.call(|c| { c.execute("UPDATE turns SET status='interrupted' WHERE id='active-history'", [])?; Ok(()) }).await.unwrap();
    assert_eq!(compress_at(&s, now).await.unwrap(), 2);
    let (status, _) = s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": "続きの会話" })).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(compress_at(&s, now + Duration::minutes(1)).await.unwrap(), 0);
}

#[tokio::test]
async fn corrupt_payload_fails_explicitly_without_erasing_the_stored_history() {
    let s = TestServer::start().await;
    let p = s.create_project("history-integrity").await;
    let session = s.create_session(p["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap().to_string();
    let now = app(&s).clock.now();
    let messages = seed(&s, &sid, 2, now - Duration::days(8)).await;
    assert_eq!(compress_at(&s, now).await.unwrap(), 2);
    let mid = messages[1].id.clone();
    let (original, broken) = app(&s).db.call(move |c| {
        let original: Vec<u8> = c.query_row("SELECT content FROM messages WHERE id=?1", [&mid], |r|r.get(0))?;
        let mut broken = original.clone();
        *broken.last_mut().unwrap() ^= 1;
        c.execute("UPDATE messages SET content=?2 WHERE id=?1", params![mid,broken])?;
        Ok((original,broken))
    }).await.unwrap();
    let (status, body) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    let mid = messages[1].id.clone();
    app(&s).db.call(move |c| {
        let saved: Vec<u8> = c.query_row("SELECT content FROM messages WHERE id=?1", [&mid], |r|r.get(0))?;
        assert_eq!(saved, broken);
        let accessed: Option<String> = c.query_row("SELECT history_accessed_at FROM sessions WHERE id=(SELECT session_id FROM messages WHERE id=?1)", [&mid], |r|r.get(0))?;
        assert_eq!(accessed, None);
        c.execute("UPDATE messages SET content=?2 WHERE id=?1", params![mid,original])?;
        Ok(())
    }).await.unwrap();
    let (status, body) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"], serde_json::to_value(messages).unwrap());
}

#[tokio::test]
async fn indexes_follow_edits_rewinds_and_permanent_deletion_without_decoding_lists() {
    let s = TestServer::start().await;
    let p = s.create_project("history-index").await;
    let session = s.create_session(p["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap().to_string();
    let now = app(&s).clock.now();
    let messages = seed(&s, &sid, 2, now - Duration::days(8)).await;
    assert_eq!(compress_at(&s, now).await.unwrap(), 2);
    let mid = messages[1].id.clone();
    app(&s).db.call(move |c| {
        c.execute("UPDATE messages SET content=?2 WHERE id=?1", params![mid,json!({ "text":"교체된 본문 REPLACEMENT".repeat(100) }).to_string()])?;
        c.execute_batch("VACUUM;")?;
        Ok(())
    }).await.unwrap();
    let (status, found) = s.get("/api/v1/recall?q=REPLACEMENT").await;
    assert_eq!(status, StatusCode::OK, "{found}");
    assert_eq!(found["total"],1);
    assert_eq!(compress_at(&s, now).await.unwrap(), 1);
    let mid = messages[0].id.clone();
    app(&s).db.call(move |c| { c.execute("UPDATE messages SET rewound_at='2026-11-17T00:00:00Z' WHERE id=?1", [mid])?; Ok(()) }).await.unwrap();
    assert_eq!(s.get("/api/v1/recall?q=압축검색").await.1["total"],0);
    let (_, current) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    let (status, archived) = s.send(Method::PATCH, &format!("/api/v1/sessions/{sid}"),
        json!({ "expected_revision":current["revision"], "archived":true })).await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    let (status, deleted) = s.send(Method::POST, &format!("/api/v1/sessions/{sid}/delete"),
        json!({ "expected_revision":archived["revision"], "confirm_title":archived["title"] })).await;
    assert_eq!(status, StatusCode::OK, "{deleted}");
    app(&s).db.call(|c| {
        assert_eq!(c.query_row("SELECT COUNT(*) FROM message_search", [], |r|r.get::<_,i64>(0))?,0);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r|r.get::<_,i64>(0))?,0);
        Ok(())
    }).await.unwrap();
}

#[test]
fn existing_database_migration_preserves_message_bytes_and_search() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("grove.db");
    let original = json!({ "text":"移行前 migration 原文\n".repeat(1000) }).to_string();
    {
        let c = rusqlite::Connection::open(&path).unwrap();
        for migration in &grove::store::MIGRATIONS[..grove::store::MIGRATIONS.len()-1] { c.execute_batch(migration).unwrap(); }
        c.pragma_update(None,"user_version",(grove::store::MIGRATIONS.len()-1) as i64).unwrap();
        c.execute_batch("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES('p','fixture','/fixture','2026-01-01','2026-01-01');
            INSERT INTO sessions(id,project_id,title,created_at,updated_at,last_message_seq) VALUES('s','p','old','2026-01-01','2026-01-01',1);").unwrap();
        c.execute("INSERT INTO messages(id,session_id,seq,role,content,created_at) VALUES('m','s',1,'user',?1,'2026-01-01')", [&original]).unwrap();
    }
    let db = grove::store::Db::open(&path).unwrap();
    db.call_sync(move |c| {
        assert_eq!(c.query_row("SELECT content FROM message_history WHERE id='m'", [], |r|r.get::<_,String>(0))?,original);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM message_search WHERE message_search MATCH '\"mig\" AND \"ion\"'", [], |r|r.get::<_,i64>(0))?,1);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r|r.get::<_,i64>(0))?,0);
        Ok(())
    }).unwrap();
}

#[tokio::test]
async fn compressed_history_survives_snapshot_restore_without_a_plaintext_copy() {
    let s = TestServer::start().await;
    let p = s.create_project("history-backup").await;
    let session = s.create_session(p["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap().to_string();
    let now = app(&s).clock.now();
    let messages = seed(&s, &sid, 2, now - Duration::days(8)).await;
    assert_eq!(compress_at(&s, now).await.unwrap(), 2);
    let db_path = app(&s).db.path.clone();
    let destination = s.dir.path().join("compressed-snapshot.db");
    let restored = s.dir.path().join("restored");
    tokio::task::spawn_blocking(move || {
        grove::backup::snapshot_to(&db_path, &destination).unwrap();
        let path = grove::backup::restore_into(&destination, &restored).unwrap();
        let db = grove::store::Db::open(&path).unwrap();
        db.call_sync(move |c| {
            assert_eq!(c.query_row("SELECT COUNT(*) FROM messages WHERE typeof(content)='blob'", [], |r|r.get::<_,i64>(0))?,2);
            for message in messages {
                let content: String = c.query_row("SELECT content FROM message_history WHERE id=?1", [&message.id], |r|r.get(0))?;
                assert_eq!(serde_json::from_str::<serde_json::Value>(&content).unwrap(),message.content);
            }
            assert_eq!(c.query_row("SELECT COUNT(*) FROM message_search WHERE message_search MATCH '\"압축검\"'", [], |r|r.get::<_,i64>(0))?,2);
            Ok(())
        }).unwrap();
    }).await.unwrap();
}
