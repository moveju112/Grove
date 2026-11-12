//! v39 프로필·SSE 이력·receipt의 자격 헤더를 잃지 않고 비공개 vault 참조로 옮긴다.
mod common;

use common::{TestServer, fixture::{self, Fixture}};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

const OLD_KEY: &str = "synthetic-legacy-header-credential";
const RECEIPT: &str = "legacy-profile-header-create";

#[tokio::test]
async fn legacy_headers_are_encrypted_before_serving_and_receipts_replay_without_duplicates() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let mut body = json!({"name":"legacy headers","protocol":"openai","base_url":f.base,"model":"fixture-model","options":{}});
    let response = s.raw(Method::POST, "/api/v1/model-profiles", Some(body.clone()), Some(RECEIPT), None).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let mut legacy: Value = response.json().await.unwrap();
    let id = legacy["id"].as_str().unwrap().to_string();
    body["options"] = json!({"headers":{"X-Custom-Token":OLD_KEY,"X-Public":"public-value"}});
    legacy["options"] = body["options"].clone();
    let hash = grove::idem::body_hash("profile.create", &json!({
        "n":body["name"],"p":body["protocol"],"u":body["base_url"],"m":body["model"],
        "s":null,"o":body["options"],
    }));
    let db = common::config(&s.data_dir()).db_path();
    s.stop().await;
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        // 후속 migration의 새 표·열을 제거해 v39의 backfill 전 데이터를 구성한다.
        conn.execute_batch("DROP TABLE webhook_receipts; DROP TABLE schedule_webhooks; DROP INDEX schedules_bot; ALTER TABLE schedules DROP COLUMN bot_id; DROP TABLE bot_avatars; DROP TABLE setup_runs; ALTER TABLE projects DROP COLUMN setup_script_id; DROP TABLE project_labels; DROP TABLE labels; ALTER TABLE projects DROP COLUMN pinned_at; DROP TABLE remote_watches; ALTER TABLE turns DROP COLUMN evidence; ALTER TABLE schedules DROP COLUMN max_runs; ALTER TABLE schedules DROP COLUMN end_at; ALTER TABLE schedules DROP COLUMN pause_after_failures; ALTER TABLE schedules DROP COLUMN consecutive_failures; ALTER TABLE schedules DROP COLUMN last_failed_at; ALTER TABLE schedules DROP COLUMN paused_reason; ALTER TABLE recent_items DROP COLUMN hidden_at; ALTER TABLE tasks DROP COLUMN script_snapshot; DROP TABLE project_scripts; DROP TABLE memories; ALTER TABLE cli_sessions DROP COLUMN system_sha256; DROP TABLE credential_backfills; PRAGMA user_version=39;").unwrap();
        conn.execute("UPDATE model_profiles SET options=?1 WHERE id=?2", rusqlite::params![body["options"].to_string(), id]).unwrap();
        conn.execute("INSERT INTO events(created_at,kind,payload) VALUES(?1,'profile.changed',?2)",
            rusqlite::params![legacy["updated_at"].as_str().unwrap(), legacy.to_string()]).unwrap();
        conn.execute("UPDATE idempotency SET request_hash=?1,response=?2 WHERE key=?3",
            rusqlite::params![hash, legacy.to_string(), RECEIPT]).unwrap();
    }
    s.restart().await;
    let (_, profiles) = s.get("/api/v1/model-profiles").await;
    let profile = profiles.as_array().unwrap().iter().find(|p| p["id"] == id).unwrap().clone();
    assert!(!profiles.to_string().contains(OLD_KEY));
    let reference = profile["options"]["headers"]["X-Custom-Token"]["secret_id"].as_str().unwrap();
    assert_eq!(profile["options"]["headers"]["X-Public"], "public-value");
    let events = s.read_events(Some(0), "", 100, 200).await;
    assert!(!serde_json::to_string(&events).unwrap().contains(OLD_KEY));
    let replay = s.raw(Method::POST, "/api/v1/model-profiles", Some(body.clone()), Some(RECEIPT), None).await;
    assert_eq!(replay.status(), StatusCode::CREATED);
    let replay: Value = replay.json().await.unwrap();
    assert_eq!(replay["id"], id);
    assert!(!replay.to_string().contains(OLD_KEY));
    s.server.as_ref().unwrap().app.db.call(|c| {
        for (table, column) in [("model_profiles","options"),("events","payload"),("idempotency","response"),("secrets","value")] {
            let found: i64 = c.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE instr({column},?1)>0"), [OLD_KEY], |row| row.get(0))?;
            assert_eq!(found, 0, "{table}: 비밀 원문을 남기지 않는다");
        }
        let count: i64 = c.query_row("SELECT COUNT(*) FROM model_profiles", [], |row| row.get(0))?;
        assert_eq!(count, 1);
        Ok(())
    }).await.unwrap();
    let secret_count = s.server.as_ref().unwrap().app.db.call(|c| Ok(c.query_row("SELECT COUNT(*) FROM secrets", [], |row| row.get::<_,i64>(0))?)).await.unwrap();
    let (status, _) = s.send(Method::DELETE, &format!("/api/v1/secrets/{reference}"), json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    f.push(fixture::text("legacy transport preserved"));
    let project = s.create_project("legacy header").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    let (_, turn) = s.post(&format!("/api/v1/sessions/{}/turns", session["id"].as_str().unwrap()), json!({
        "profile_id":id,"text":"legacy header transport",
    })).await;
    s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(f.inner.lock().unwrap().requests[0].0.get("x-custom-token").unwrap(), OLD_KEY);
    s.restart().await;
    let (_, profiles) = s.get("/api/v1/model-profiles").await;
    assert_eq!(profiles[0]["options"], profile["options"], "참조 ID와 공개 값은 반복 시작에서 그대로다");
    let after = s.server.as_ref().unwrap().app.db.call(|c| Ok(c.query_row("SELECT COUNT(*) FROM secrets", [], |row| row.get::<_,i64>(0))?)).await.unwrap();
    assert_eq!(after, secret_count, "완료한 backfill은 다시 비밀을 만들지 않는다");
}

#[tokio::test]
async fn failed_backfill_rolls_back_earlier_rows_and_retries_from_the_preserved_source() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let first = s.fixture_profile(&f.base).await;
    let second = s.fixture_profile(&f.base).await;
    let path = common::config(&s.data_dir()).db_path();
    s.stop().await;
    let db = grove::store::Db::open(&path).unwrap();
    db.call_sync(move |c| {
        for (id, value) in [(first, OLD_KEY.to_string()), (second, "synthetic-fail-later".into())] {
            c.execute("UPDATE model_profiles SET options=?1 WHERE id=?2",
                rusqlite::params![json!({"headers":{"X-Custom-Token":value}}).to_string(), id])?;
        }
        c.execute("DELETE FROM credential_backfills WHERE name='model-headers-v1'", [])?;
        c.execute_batch("CREATE TRIGGER fail_header_backfill BEFORE INSERT ON secrets
            WHEN NEW.label='이전 모델 자격 헤더' AND grove_decrypt(NEW.value)='synthetic-fail-later'
            BEGIN SELECT RAISE(ABORT,'injected header backfill failure'); END;")?;
        Ok(())
    }).unwrap();
    let before = db.call_sync(|c| Ok(c.query_row("SELECT COUNT(*) FROM secrets", [], |row| row.get::<_,i64>(0))?)).unwrap();
    assert!(db.call_sync(grove::model_headers::migrate).is_err());
    db.call_sync(|c| {
        let remaining: i64 = c.query_row(
            "SELECT COUNT(*) FROM model_profiles WHERE json_type(options,'$.headers.\"X-Custom-Token\"')='text'", [], |row| row.get(0),
        )?;
        assert_eq!(remaining, 2, "먼저 변환한 행도 실패와 함께 원상태로 보존한다");
        assert_eq!(c.query_row("SELECT COUNT(*) FROM secrets", [], |row| row.get::<_,i64>(0))?, before);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM credential_backfills WHERE name='model-headers-v1'", [], |row| row.get::<_,i64>(0))?, 0);
        c.execute_batch("DROP TRIGGER fail_header_backfill")?;
        Ok(())
    }).unwrap();
    assert_eq!(db.call_sync(grove::model_headers::migrate).unwrap(), 2);
    assert_eq!(db.call_sync(grove::model_headers::migrate).unwrap(), 0);
}
