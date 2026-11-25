//! CMP-012: 실제 저장 거부·응답 보류·재시작에서 원문과 마지막 유효 projection을 보존한다.
use crate::common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::StatusCode;
use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};
use std::time::Duration;

const SUMMARY: &str = "You compress a conversation";
const PRIOR: &str = "PRIOR_VALID_PROJECTION";
const OLD: &str = "ORIGINAL_BEFORE_PRIOR";
const LIVE_CALL: &str = "live-read";
const CANDIDATE: &str = "UNCOMMITTED_CANDIDATE";

struct Conversation {
    server: TestServer,
    fixture: Fixture,
    profile: String,
    session: String,
    latest_user: String,
}

impl Conversation {
    async fn start() -> Self {
        let server = TestServer::start().await;
        let fixture = Fixture::start().await;
        let profile = server.fixture_profile(&fixture.base).await;
        let project = server.create_project("compaction-faults").await;
        std::fs::write(
            std::path::Path::new(project["root_path"].as_str().unwrap()).join("source.txt"),
            "TOOL_SOURCE_PRESERVED",
        )
        .unwrap();
        let session = server.create_session(project["id"].as_str().unwrap()).await["id"]
            .as_str()
            .unwrap()
            .to_string();
        let mut c = Self {
            server,
            fixture,
            profile,
            session,
            latest_user: String::new(),
        };
        c.turn(OLD, &"original answer ".repeat(20), Some("old-read"))
            .await;
        // 두 번째 교환은 첫 압축의 범위 밖이다. 큰 원문은 SQLite FULL 후보보다 길게 둔다.
        c.turn(
            "LIVE_SOURCE",
            &"LIVE_ANSWER ".repeat(48_000),
            Some(LIVE_CALL),
        )
        .await;
        c.fixture.push_for(SUMMARY, fixture::text(PRIOR));
        let (status, body) = c.compact().await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        c.latest_user = c.turn("LATEST_SOURCE", "LATEST_ANSWER", None).await;
        let (session, profile) = (c.session.clone(), c.profile.clone());
        c.server
            .server
            .as_ref()
            .unwrap()
            .app
            .db
            .call(move |db| {
                db.execute(
                    "INSERT INTO cli_sessions(session_id,profile_id,native_id,updated_at)
                 VALUES (?1,?2,'preserve-native-context','2020-01-01T00:00:00Z')",
                    params![session, profile],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let (_, preview) = c.projection().await;
        assert!(preview.to_string().contains(PRIOR));
        assert!(!preview.to_string().contains(OLD));
        assert_pairs(&preview["items"], false);
        c
    }

    fn connection(&self) -> Connection {
        let db = Connection::open_with_flags(
            self.server.data_dir().join("grove.db"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        db.busy_timeout(Duration::from_secs(5)).unwrap();
        db
    }

    async fn turn(&self, text: &str, answer: &str, call: Option<&str>) -> String {
        if let Some(call) = call {
            self.fixture.push(fixture::tool_calls(&[(
                call,
                "read",
                json!({ "path": "source.txt" }),
            )]));
        }
        self.fixture.push(fixture::text(answer));
        let (status, body) = self
            .server
            .post(
                &format!("/api/v1/sessions/{}/turns", self.session),
                json!({ "text": text, "profile_id": self.profile, "tools": call.is_some() }),
            )
            .await;
        assert_eq!(status, StatusCode::ACCEPTED, "{body}");
        self.server
            .wait_status(body["turn"]["id"].as_str().unwrap(), "completed")
            .await;
        body["message"]["id"].as_str().unwrap().to_string()
    }

    async fn compact(&self) -> (StatusCode, Value) {
        self.server
            .post(
                &format!("/api/v1/sessions/{}/compact", self.session),
                json!({ "profile_id": self.profile }),
            )
            .await
    }

    fn pending(&self) -> tokio::task::JoinHandle<(StatusCode, Value)> {
        let (client, base, token, session, profile) = (
            self.server.client.clone(),
            self.server.base.clone(),
            self.server.token.clone(),
            self.session.clone(),
            self.profile.clone(),
        );
        tokio::spawn(async move {
            let response = client
                .post(format!("{base}/api/v1/sessions/{session}/compact"))
                .bearer_auth(token)
                .timeout(Duration::from_secs(15))
                .json(&json!({ "profile_id": profile }))
                .send()
                .await
                .unwrap();
            (response.status(), response.json().await.unwrap())
        })
    }

    async fn wait_requests(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.summary_requests() < count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("보류한 요약 요청 도착");
        assert_eq!(self.summary_requests(), count);
    }

    fn summary_requests(&self) -> usize {
        self.fixture
            .requests()
            .iter()
            .filter(|r| r.to_string().contains(SUMMARY))
            .count()
    }

    async fn projection(&self) -> (Value, Value) {
        let (status, history) = self
            .server
            .get(&format!(
                "/api/v1/sessions/{}/messages?limit=200",
                self.session
            ))
            .await;
        assert_eq!(status, StatusCode::OK, "{history}");
        let (status, input) = self
            .server
            .get(&format!(
                "/api/v1/sessions/{}/model-input?limit=200",
                self.session
            ))
            .await;
        assert_eq!(status, StatusCode::OK, "{input}");
        assert!(input["next_offset"].is_null());
        (history, input)
    }

    // JSON으로 다시 쓰지 않고 원문·별도 model_input·ID·seq·이벤트·CLI context를 그대로 비교한다.
    fn stored(&self) -> Value {
        let db = self.connection();
        let mut statement = db
            .prepare(
                "SELECT id,seq,role,content,model_input,turn_id,rewound_at
             FROM messages WHERE session_id=?1 ORDER BY seq",
            )
            .unwrap();
        let messages: Vec<Value> = statement
            .query_map([&self.session], |row| {
                Ok(json!([
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ]))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let session: (i64, i64, String) = db
            .query_row(
                "SELECT last_message_seq,timeline_revision,updated_at FROM sessions WHERE id=?1",
                [&self.session],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let mut statement = db
            .prepare("SELECT kind,payload FROM events WHERE session_id=?1 ORDER BY seq")
            .unwrap();
        let events: Vec<(String, String)> = statement
            .query_map([&self.session], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let native: Option<String> = {
            use rusqlite::OptionalExtension;
            db.query_row(
                "SELECT native_id FROM cli_sessions WHERE session_id=?1",
                [&self.session],
                |row| row.get(0),
            )
            .optional()
            .unwrap()
        };
        json!({ "messages": messages, "session": session, "events": events, "native": native })
    }

    async fn assert_preserved(&self, stored: &Value, projection: &(Value, Value)) {
        assert!(
            self.stored() == *stored,
            "원문·projection note·seq·이벤트·CLI context가 바뀌었다"
        );
        let actual = self.projection().await;
        assert!(
            actual == *projection,
            "history/model-input API의 projection이 바뀌었다"
        );
        let db = self.connection();
        assert_eq!(
            db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
    }

    async fn assert_next_request(&self) {
        let count = self.fixture.requests().len();
        let summaries = self.summary_requests();
        self.turn("AFTER_RESTART", "RESTART_ANSWER", None).await;
        let requests = self.fixture.requests();
        assert_eq!(
            requests.len(),
            count + 1,
            "재시작·원문 조회는 provider를 자동 재호출하지 않는다"
        );
        assert_eq!(self.summary_requests(), summaries);
        let messages = &requests.last().unwrap()["messages"];
        let text = messages.to_string();
        assert!(
            text.contains(PRIOR) && text.contains("LIVE_SOURCE") && text.contains("LATEST_SOURCE")
        );
        assert!(!text.contains(OLD) && !text.contains(CANDIDATE));
        assert_pairs(messages, true);
    }
}

fn assert_pairs(messages: &Value, wire: bool) {
    let messages = messages.as_array().unwrap();
    let calls: Vec<&str> = messages
        .iter()
        .flat_map(|m| {
            m["tool_calls"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|call| call["id"].as_str().unwrap())
        })
        .collect();
    let results: Vec<&str> = messages
        .iter()
        .filter(|m| m["role"] == "tool")
        .map(|m| {
            m[if wire { "tool_call_id" } else { "call_id" }]
                .as_str()
                .unwrap()
        })
        .collect();
    assert_eq!(calls, vec![LIVE_CALL]);
    assert_eq!(results, calls, "call/result가 함께 보존되어야 한다");
}

#[tokio::test]
async fn sqlite_full_rolls_back_candidate_and_preserves_prior_projection_after_restart() {
    let mut c = Conversation::start().await;
    let stored = c.stored();
    let projection = c.projection().await;
    let (step, release) = fixture::gated_text(&format!("{CANDIDATE}{}", "x".repeat(64 * 1024)));
    c.fixture.push_for(SUMMARY, step);
    let request = c.pending();
    c.wait_requests(2).await;
    let app = c.server.server.as_ref().unwrap().app.clone();
    app.db
        .call(|db| {
            let pages: i64 = db.query_row("PRAGMA page_count", [], |r| r.get(0))?;
            let free: i64 = db.query_row("PRAGMA freelist_count", [], |r| r.get(0))?;
            let size: i64 = db.query_row("PRAGMA page_size", [], |r| r.get(0))?;
            assert!(
                (free + 8) * size < 64 * 1024,
                "실패 주입 후보보다 빈 페이지가 많다"
            );
            db.pragma_update(None, "max_page_count", pages)?;
            assert_eq!(
                db.query_row("PRAGMA max_page_count", [], |r| r.get::<_, i64>(0))?,
                pages
            );
            Ok(())
        })
        .await
        .unwrap();
    release.send(true).unwrap();
    let (status, body) = request.await.unwrap();
    assert_eq!(status, StatusCode::INSUFFICIENT_STORAGE, "{body}");
    assert_eq!(body["error"]["code"], "storage_full", "{body}");
    assert_eq!(app.db.recovery_reason(), Some("storage_full"));
    assert!(
        c.stored() == stored,
        "실제 SQLITE_FULL 뒤 transaction 전체가 rollback되어야 한다"
    );
    drop(app);
    c.server.restart().await;
    c.assert_preserved(&stored, &projection).await;
    assert_eq!(c.summary_requests(), 2);
    c.assert_next_request().await;
}

#[cfg(unix)]
struct ReadOnlyDirectory {
    path: std::path::PathBuf,
    permissions: std::fs::Permissions,
}

#[cfg(unix)]
impl ReadOnlyDirectory {
    fn new(path: std::path::PathBuf) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::metadata(&path).unwrap().permissions();
        let guard = Self { path, permissions };
        std::fs::set_permissions(&guard.path, std::fs::Permissions::from_mode(0o500)).unwrap();
        // chmod 성공만으로 거부를 가정하지 않는다(root 등 우회 권한이면 시험을 실패시킨다).
        let error = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(guard.path.join("permission-probe"))
            .expect_err("실제 파일 생성 거부가 필요하다");
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        guard
    }
}

#[cfg(unix)]
impl Drop for ReadOnlyDirectory {
    fn drop(&mut self) {
        std::fs::set_permissions(&self.path, self.permissions.clone()).unwrap();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn actual_journal_permission_refusal_preserves_source_and_projection_after_restart() {
    let mut c = Conversation::start().await;
    let stored = c.stored();
    let projection = c.projection().await;
    let (step, release) = fixture::gated_text(CANDIDATE);
    c.fixture.push_for(SUMMARY, step);
    let request = c.pending();
    c.wait_requests(2).await;
    let app = c.server.server.as_ref().unwrap().app.clone();
    app.db
        .call(|db| {
            db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")?;
            assert_eq!(
                db.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))?,
                "delete"
            );
            Ok(())
        })
        .await
        .unwrap();
    let permissions = ReadOnlyDirectory::new(c.server.data_dir());
    release.send(true).unwrap();
    let (status, body) = request.await.unwrap();
    drop(permissions);
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["error"]["code"], "storage_permission", "{body}");
    assert_eq!(app.db.recovery_reason(), Some("storage_permission"));
    assert!(
        c.stored() == stored,
        "journal 생성 거부 뒤 원문과 이전 projection을 보존해야 한다"
    );
    drop(app);
    c.server.restart().await;
    c.assert_preserved(&stored, &projection).await;
    assert_eq!(c.summary_requests(), 2);
    c.assert_next_request().await;
}

#[tokio::test]
async fn restart_cancels_held_summary_without_recalling_or_applying_its_late_response() {
    let mut c = Conversation::start().await;
    let stored = c.stored();
    let projection = c.projection().await;
    let (step, release) = fixture::gated_text(CANDIDATE);
    c.fixture.push_for(SUMMARY, step);
    let request = c.pending();
    c.wait_requests(2).await;
    c.server.restart().await;
    let (status, body) = request.await.unwrap();
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "cancelled", "{body}");
    release.send_replace(true);
    c.assert_preserved(&stored, &projection).await;
    assert_eq!(c.summary_requests(), 2);
    c.assert_next_request().await;
}

#[tokio::test]
async fn changed_source_rejects_candidate_and_keeps_prior_projection_across_restart() {
    let mut c = Conversation::start().await;
    let (step, release) = fixture::gated_text(CANDIDATE);
    c.fixture.push_for(SUMMARY, step);
    let request = c.pending();
    c.wait_requests(2).await;
    let session = c.session.clone();
    c.server.server.as_ref().unwrap().app.db.call(move |db| {
        assert_eq!(db.execute(
            "UPDATE messages SET content=json_set(content,'$.text','CHANGED_LIVE_ANSWER')
             WHERE session_id=?1 AND role='assistant' AND json_extract(content,'$.text') LIKE 'LIVE_ANSWER %'",
            [session],
        )?, 1);
        Ok(())
    }).await.unwrap();
    let stored = c.stored();
    let projection = c.projection().await;
    release.send(true).unwrap();
    let (status, body) = request.await.unwrap();
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "source_changed", "{body}");
    c.assert_preserved(&stored, &projection).await;
    c.server.restart().await;
    c.assert_preserved(&stored, &projection).await;
    assert_eq!(c.summary_requests(), 2);
    c.assert_next_request().await;
}

#[tokio::test]
async fn changed_timeline_rejects_candidate_and_keeps_prior_projection_across_restart() {
    let mut c = Conversation::start().await;
    let (step, release) = fixture::gated_text(CANDIDATE);
    c.fixture.push_for(SUMMARY, step);
    let request = c.pending();
    c.wait_requests(2).await;
    let (status, session) = c
        .server
        .get(&format!("/api/v1/sessions/{}", c.session))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = c
        .server
        .post(
            &format!("/api/v1/sessions/{}/rewind", c.session),
            json!({ "message_id": c.latest_user, "expected_revision": session["revision"],
            "expected_last_message_seq": session["last_message_seq"] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let stored = c.stored();
    let projection = c.projection().await;
    assert!(projection.1.to_string().contains(PRIOR));
    release.send(true).unwrap();
    let (status, body) = request.await.unwrap();
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "timeline_changed", "{body}");
    c.assert_preserved(&stored, &projection).await;
    c.server.restart().await;
    c.assert_preserved(&stored, &projection).await;
    assert_eq!(c.summary_requests(), 2);
}

#[tokio::test]
async fn competing_candidates_apply_once_and_cannot_replace_the_winner_after_restart() {
    let mut c = Conversation::start().await;
    let (first, release_first) = fixture::gated_text(CANDIDATE);
    c.fixture.push_for(SUMMARY, first);
    let loser = c.pending();
    c.wait_requests(2).await;
    let (second, release_second) = fixture::gated_text("CAS_WINNER");
    c.fixture.push_for(SUMMARY, second);
    let winner = c.pending();
    c.wait_requests(3).await;
    release_second.send(true).unwrap();
    let (status, body) = winner.await.unwrap();
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["message"]["content"]["summary"], "CAS_WINNER");
    let stored = c.stored();
    let projection = c.projection().await;
    release_first.send(true).unwrap();
    let (status, body) = loser.await.unwrap();
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["compacted"], false, "{body}");
    c.assert_preserved(&stored, &projection).await;
    c.server.restart().await;
    c.assert_preserved(&stored, &projection).await;
    assert_eq!(c.summary_requests(), 3);
    let history = projection.0["items"].as_array().unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|m| m["content"]["type"] == "compaction")
            .count(),
        2
    );
    assert!(
        projection.0.to_string().contains(OLD),
        "승자 적용 뒤에도 원문을 삭제하지 않는다"
    );
    assert!(projection.1.to_string().contains("CAS_WINNER"));
    assert!(!projection.1.to_string().contains(CANDIDATE));
}
