//! REC-012: 실제 SQLite 저장 실패를 기록 경계에서 일으키고 기존 API로 복구한다.
#![cfg(unix)]

mod common;

use common::fixture::{self, Fixture};
use common::*;
use grove::App;
use reqwest::{Method, StatusCode};
use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Clone, Copy, Debug)]
enum Failure {
    Full,
    Permission,
}

impl Failure {
    const ALL: [Self; 2] = [Self::Full, Self::Permission];

    fn code(self) -> &'static str {
        match self {
            Self::Full => "storage_full",
            Self::Permission => "storage_permission",
        }
    }

    fn status(self) -> StatusCode {
        match self {
            Self::Full => StatusCode::INSUFFICIENT_STORAGE,
            Self::Permission => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}

struct PermissionProbe(Option<PathBuf>);

impl Drop for PermissionProbe {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
}

struct Case {
    s: TestServer,
    f: Fixture,
    profile: String,
    sid: String,
    root: PathBuf,
}

impl Case {
    async fn new() -> Self {
        let s = TestServer::start().await;
        let f = Fixture::start().await;
        let profile = s.fixture_profile(&f.base).await;
        let project = s.create_project("recording-boundary").await;
        let root = PathBuf::from(project["root_path"].as_str().unwrap());
        let session = s.create_session(project["id"].as_str().unwrap()).await;
        let sid = session["id"].as_str().unwrap().to_string();
        Self { s, f, profile, sid, root }
    }

    fn app(&self) -> App {
        self.s.server.as_ref().unwrap().app.clone()
    }

    fn db(&self) -> Connection {
        Connection::open_with_flags(self.s.data_dir().join("grove.db"), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
    }

    fn body(&self) -> Value {
        json!({ "text": "recording-boundary", "profile_id": self.profile, "tools": true })
    }

    fn turn_path(&self) -> String {
        format!("/api/v1/sessions/{}/turns", self.sid)
    }

    async fn start(&self) -> String {
        let response = self.s.raw(Method::POST, &self.turn_path(), Some(self.body()), Some("rec-input"), None).await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        response.json::<Value>().await.unwrap()["turn"]["id"].as_str().unwrap().to_string()
    }

    async fn partial(&self) {
        let app = self.app();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if app.partials.get(&self.sid).is_some_and(|p| p["text"] == "new partial") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("모델의 실제 partial 수신");
    }

    async fn seed_evidence(&self, tid: &str) -> String {
        // 이전 snapshot을 고정한다. 새 snapshot의 실패가 이 원본을 손상시키면 안 된다.
        let body = json!({
            "step": 0, "text": "original snapshot", "text_chars": 17, "truncated": false,
            "tool_calls": [], "reasoning_chars": 0, "captured_at": "2026-01-01T00:00:00Z",
        }).to_string();
        let raw = json!({ "v": 1, "sha256": grove::util::sha256_hex(body.as_bytes()), "body": body }).to_string();
        let (id, evidence) = (tid.to_string(), raw.clone());
        self.app().db.call(move |c| {
            c.execute("UPDATE turns SET evidence=?2 WHERE id=?1", params![id, evidence])?;
            Ok(())
        }).await.unwrap();
        raw
    }

    fn evidence(&self, tid: &str) -> Option<String> {
        self.db().query_row("SELECT evidence FROM turns WHERE id=?1", [tid], |r| r.get(0)).unwrap()
    }

    fn executions(&self) -> Vec<u8> {
        match std::fs::read(self.root.join("executions")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => vec![],
            Err(error) => panic!("실행 횟수 fixture 읽기 실패: {error}"),
        }
    }

    async fn arm(&self, failure: Failure, boundary: &str) -> PermissionProbe {
        // 제품 schema에는 손대지 않는다. 연결 전용 TEMP trigger가 해당 SQL 경계에서
        // 실제 SQLite overflow 또는 OS가 읽기만 허용한 fixture DB의 쓰기를 시도한다.
        // RAISE나 합성 ApiError로 저장 실패를 흉내 내지 않는다.
        let mut probe = PermissionProbe(None);
        let statement = match failure {
            Failure::Full => {
                self.app().db.call(|c| {
                    let pages: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0))?;
                    // 작은 선행 기록이 아니라 경계 trigger의 1 MiB 할당이 실패하게 한다.
                    c.pragma_update(None, "max_page_count", pages + 32)?;
                    Ok(())
                }).await.unwrap();
                "INSERT INTO events(created_at,kind,payload) VALUES('2026-01-01','rec-owned-full',zeroblob(1048576));"
            }
            Failure::Permission => {
                let path = self.s.dir.path().join("recording-permission.db");
                let c = Connection::open(&path).unwrap();
                c.execute_batch("CREATE TABLE rec_denied_write(value TEXT)").unwrap();
                drop(c);
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400)).unwrap();
                probe.0 = Some(path.clone());
                let refused = std::fs::OpenOptions::new().write(true).open(&path).unwrap_err();
                assert_eq!(refused.kind(), std::io::ErrorKind::PermissionDenied, "실행 사용자에게 실제 쓰기 거부가 있어야 한다");
                self.app().db.call(move |c| {
                    c.execute("ATTACH DATABASE ?1 AS rec_permission", [path.to_str().unwrap()])?;
                    Ok(())
                }).await.unwrap();
                "INSERT INTO rec_denied_write(value) VALUES('owned permission probe');"
            }
        };
        let sql = format!("CREATE TEMP TRIGGER rec_write_failure {boundary} BEGIN {statement} END;");
        self.app().db.call(move |c| { c.execute_batch(&sql)?; Ok(()) }).await.unwrap();
        probe
    }

    async fn failed(&self, failure: Failure) {
        let app = self.app();
        tokio::time::timeout(Duration::from_secs(12), async {
            loop {
                if app.db.recovery_reason().is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("기록 경계의 실제 저장 실패");
        assert_eq!(app.db.recovery_reason(), Some(failure.code()));
        let mut ran = false;
        let error = app.db.call_sync(|_| { ran = true; Ok(()) }).unwrap_err();
        assert!(!ran, "저장 실패 뒤에는 다음 DB 작업을 실행하지 않는다");
        assert_eq!(error.code, "storage_recovery_required");
    }

    async fn cancel(&self, tid: &str) {
        let (status, body) = self.s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
        if status != StatusCode::ACCEPTED {
            // 취소 신호 뒤 실행 루프가 먼저 저장 실패를 관측하면 마지막 조회도 차단된다.
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
            assert_eq!(body["error"]["code"], "storage_recovery_required");
        }
    }

    fn durable(&self) -> Value {
        fn rows(c: &Connection, sql: &str) -> Value {
            let mut st = c.prepare(sql).unwrap();
            let names: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
            let values = st.query_map([], |row| {
                let mut value = serde_json::Map::new();
                for (i, name) in names.iter().enumerate() {
                    use rusqlite::types::ValueRef;
                    value.insert(name.clone(), match row.get_ref(i)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(n) => json!(n),
                        ValueRef::Real(n) => json!(n),
                        ValueRef::Text(s) => json!(std::str::from_utf8(s).unwrap()),
                        ValueRef::Blob(_) => panic!("복구 fixture에 예상하지 않은 blob"),
                    });
                }
                Ok(Value::Object(value))
            }).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
            json!(values)
        }
        let c = self.db();
        json!({
            "turns": rows(&c, "SELECT * FROM turns ORDER BY id"),
            "calls": rows(&c, "SELECT * FROM tool_calls ORDER BY id"),
            "messages": rows(&c, "SELECT * FROM messages ORDER BY session_id,seq"),
            "receipts": rows(&c, "SELECT * FROM idempotency WHERE key LIKE 'rec-%' ORDER BY key"),
        })
    }

    async fn converges(&mut self) -> Value {
        let requests = self.f.requests().len();
        let executions = self.executions();
        self.s.restart().await;
        let stable = self.durable();
        for _ in 0..2 {
            let (status, page) = self.s.get("/api/v1/recovery").await;
            assert_eq!(status, StatusCode::OK, "{page}");
            self.s.restart().await;
            assert_eq!(self.durable(), stable, "반복 재시작은 이력·증거·receipt·결과를 중복 기록하지 않는다");
            assert_eq!(self.f.requests().len(), requests, "모델 자동 재호출 금지");
            assert_eq!(self.executions(), executions, "도구 자동 재실행 금지");
        }
        let c = self.db();
        assert_eq!(c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0)).unwrap(), "ok");
        assert!(!c.prepare("PRAGMA foreign_key_check").unwrap().exists([]).unwrap());
        stable
    }

    async fn replay_input(&self, tid: &str) {
        let response = self.s.raw(Method::POST, &self.turn_path(), Some(self.body()), Some("rec-input"), None).await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(response.headers()["idempotent-replayed"], "true");
        assert_eq!(response.json::<Value>().await.unwrap()["turn"]["id"], tid);
    }

    async fn listed_turn(&self, tid: &str) {
        let (status, detail) = self.s.get(&format!("/api/v1/turns/{tid}")).await;
        assert_eq!(status, StatusCode::OK, "{detail}");
        assert_eq!(detail["status"], "interrupted");
        assert!(!detail["evidence"].is_null(), "{detail}");
        let (status, page) = self.s.get("/api/v1/recovery").await;
        assert_eq!(status, StatusCode::OK);
        let item = page["items"].as_array().unwrap().iter().find(|v| v["id"] == tid).unwrap();
        assert_eq!(item["kind"], "turn");
        assert!(item["evidence"].get("text").is_none(), "목록은 원문을 노출하지 않는다");
    }

    async fn pending_shell(&self) -> (String, Value) {
        self.f.push(fixture::tool_calls(&[("rec-shell", "shell", json!({ "command": "printf x >> executions" }))]));
        let tid = self.start().await;
        let turn = self.s.wait_status(&tid, "awaiting_approval").await;
        let call = turn["tool_calls"][0].clone();
        assert_eq!(call["status"], "pending_approval", "{call}");
        (tid, call)
    }

    async fn recovered_unknown(&self) -> (String, String) {
        let (tid, call) = self.pending_shell().await;
        self.seed_evidence(&tid).await;
        let cid = call["id"].as_str().unwrap().to_string();
        let (turn, tool) = (tid.clone(), cid.clone());
        self.app().db.call(move |c| {
            c.execute("UPDATE turns SET status='running',owner_epoch='rec-dead-epoch' WHERE id=?1", [turn])?;
            c.execute("UPDATE tool_calls SET status='running',started_at='2026-01-01T00:00:00Z' WHERE id=?1", [tool])?;
            Ok(())
        }).await.unwrap();
        grove::runner::recover_on_start(&self.app()).await.unwrap();
        (tid, cid)
    }
}

#[tokio::test]
async fn startup_recovery_protects_live_owner_tools_and_preserves_dead_owner_receipts() {
    let mut e = Case::new().await;
    let app = e.app();
    let (sid, profile, epoch) = (e.sid.clone(), e.profile.clone(), app.epoch.clone());
    let (tid, ids) = app.db.call(move |c| {
        let tx = c.transaction()?;
        let now = "2026-01-01T00:00:00Z";
        let (turn, _) = grove::runner::enqueue_turn(&tx, now, &epoch, "rec-owner", &sid, "live owner", &profile, None, true, None)?;
        let session = grove::sessions::get(&tx, &sid)?;
        let root = grove::sessions::exec_root(&tx, &sid)?;
        let mut ids = vec![];
        for (name, args, status) in [
            ("read", json!({ "path": "not-executed" }), "running"),
            ("shell", json!({ "command": "printf x >> executions" }), "running"),
            ("shell", json!({ "command": "printf x >> executions" }), "approved"),
        ] {
            let call = grove::approvals::create_call(&tx, now, 1800, &sid, &session.project_id, &root, Some(&turn.id), None, name, &args)?;
            tx.execute("UPDATE tool_calls SET status=?2,started_at=?3 WHERE id=?1", params![call.id, status, (status == "running").then_some(now)])?;
            ids.push(call.id);
        }
        tx.commit()?;
        Ok((turn.id, ids))
    }).await.unwrap();
    e.seed_evidence(&tid).await;
    for status in ["queued", "awaiting_approval", "running"] {
        let id = tid.clone();
        app.db.call(move |c| {
            c.execute("UPDATE turns SET status=?2 WHERE id=?1", params![id, status])?;
            Ok(())
        }).await.unwrap();
        let live = e.durable();
        for _ in 0..2 {
            grove::runner::recover_on_start(&app).await.unwrap();
            assert_eq!(e.durable(), live, "같은 owner_epoch의 실행·승인 receipt를 복구가 빼앗으면 안 된다");
        }
    }
    let turn = tid.clone();
    app.db.call(move |c| {
        c.execute("UPDATE turns SET owner_epoch='rec-dead-epoch' WHERE id=?1", [turn])?;
        Ok(())
    }).await.unwrap();
    grove::runner::recover_on_start(&app).await.unwrap();
    for (id, expected) in ids.iter().zip(["failed", "unknown", "cancelled"]) {
        let (status, call) = e.s.get(&format!("/api/v1/tool-calls/{id}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(call["status"], expected, "{call}");
    }
    e.listed_turn(&tid).await;
    e.converges().await;
    assert!(e.f.requests().is_empty());
    assert!(!e.root.join("executions").exists());
    e.s.stop().await;
}

#[tokio::test]
async fn input_receipt_write_failure_rolls_back_message_turn_and_receipt() {
    for failure in Failure::ALL {
        let mut e = Case::new().await;
        e.f.push(fixture::text("must not execute"));
        let before = e.durable();
        let _probe = e.arm(failure, "BEFORE INSERT ON main.idempotency").await;
        let response = e.s.raw(Method::POST, &e.turn_path(), Some(e.body()), Some("rec-input"), None).await;
        assert_eq!(response.status(), failure.status(), "{failure:?}");
        assert_eq!(response.json::<Value>().await.unwrap()["error"]["code"], failure.code());
        e.failed(failure).await;
        assert_eq!(e.durable(), before, "입력 접수 transaction 전체를 되돌린다: {failure:?}");
        e.converges().await;
        assert!(e.f.requests().is_empty());
        e.s.stop().await;
    }
}

#[tokio::test]
async fn progress_periodic_and_final_evidence_write_failures_preserve_original_bytes() {
    for failure in Failure::ALL {
        for boundary in ["progress", "periodic_evidence", "final_evidence"] {
            let mut e = Case::new().await;
            e.f.push(fixture::hang_after("new partial"));
            let tid = e.start().await;
            e.partial().await;
            let original = e.seed_evidence(&tid).await;
            let sql = if boundary == "progress" {
                "BEFORE UPDATE OF progress_at ON main.turns"
            } else {
                "BEFORE UPDATE OF evidence ON main.turns"
            };
            let _probe = e.arm(failure, sql).await;
            if boundary == "final_evidence" {
                e.cancel(&tid).await;
            }
            e.failed(failure).await;
            assert_eq!(e.evidence(&tid).as_deref(), Some(original.as_str()), "{failure:?}/{boundary}");
            let state = e.durable();
            assert_eq!(state["turns"][0]["status"], "running");
            assert_eq!(state["turns"][0]["step"], 0);
            assert_eq!(state["turns"][0]["owner_epoch"], e.app().epoch);
            assert_eq!(state["messages"].as_array().unwrap().len(), 1);
            e.converges().await;
            e.listed_turn(&tid).await;
            e.replay_input(&tid).await;
            assert_eq!(e.evidence(&tid).as_deref(), Some(original.as_str()));
            assert_eq!(e.f.requests().len(), 1);
            e.s.stop().await;
        }
    }
}

#[tokio::test]
async fn answer_commit_and_tool_plan_write_failures_rollback_answer_usage_step_and_evidence_clear() {
    for failure in Failure::ALL {
        for boundary in ["answer_commit", "tool_plan"] {
            let mut e = Case::new().await;
            let (step, release) = fixture::gated_text("uncommitted answer");
            let step = if boundary == "tool_plan" {
                let fixture::Step::Gated(_, gate) = step else { unreachable!() };
                let fixture::Step::Frames(frames, _) = fixture::tool_calls(&[("rec-shell", "shell", json!({ "command": "printf x >> executions" }))]) else { unreachable!() };
                fixture::Step::Gated(frames, gate)
            } else {
                step
            };
            e.f.push(step);
            let tid = e.start().await;
            tokio::time::timeout(Duration::from_secs(10), async {
                while e.f.requests().is_empty() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }).await.unwrap();
            let original = e.seed_evidence(&tid).await;
            let _probe = e.arm(failure, if boundary == "answer_commit" {
                "BEFORE UPDATE OF evidence ON main.turns"
            } else {
                "BEFORE INSERT ON main.tool_calls"
            }).await;
            release.send_replace(true);
            e.failed(failure).await;
            let state = e.durable();
            assert_eq!(state["turns"][0]["status"], "running", "{failure:?}/{boundary}");
            assert_eq!(state["turns"][0]["step"], 0);
            assert_eq!(state["turns"][0]["usage"], "{}");
            assert_eq!(state["messages"].as_array().unwrap().len(), 1);
            assert!(state["calls"].as_array().unwrap().is_empty());
            assert_eq!(e.evidence(&tid).as_deref(), Some(original.as_str()));
            e.converges().await;
            e.listed_turn(&tid).await;
            e.replay_input(&tid).await;
            assert!(!e.root.join("executions").exists());
            e.s.stop().await;
        }
    }
}

#[tokio::test]
async fn approval_execution_claim_and_result_failures_preserve_receipts_without_reexecution() {
    for failure in Failure::ALL {
        for boundary in ["decision", "execution_claim", "result"] {
            let mut e = Case::new().await;
            let (tid, call) = e.pending_shell().await;
            let cid = call["id"].as_str().unwrap();
            let before = e.durable();
            let _probe = e.arm(failure, match boundary {
                "decision" => "BEFORE UPDATE OF decided_at ON main.tool_calls",
                "execution_claim" => "BEFORE UPDATE OF started_at ON main.tool_calls",
                _ => "BEFORE UPDATE OF result ON main.tool_calls",
            }).await;
            let response = e.s.raw(
                Method::POST, &format!("/api/v1/tool-calls/{cid}/decision"),
                Some(json!({ "decision": "approve", "expected_revision": call["revision"] })), Some("rec-decision"), None,
            ).await;
            assert_eq!(response.status(), if boundary == "decision" { failure.status() } else { StatusCode::OK }, "{failure:?}/{boundary}");
            e.failed(failure).await;
            let recorded = e.durable();
            assert_eq!(recorded["messages"], before["messages"], "확정 assistant 원문 보존");
            let tool = &recorded["calls"][0];
            match boundary {
                "decision" => {
                    assert_eq!(tool, &before["calls"][0]);
                    assert_eq!(recorded["receipts"], before["receipts"]);
                }
                "execution_claim" => {
                    assert_eq!(tool["status"], "approved");
                    assert!(tool["started_at"].is_null());
                    assert!(tool["result"].is_null());
                }
                _ => {
                    assert_eq!(tool["status"], "running");
                    assert!(tool["started_at"].is_string());
                    assert!(tool["result"].is_null());
                    assert_eq!(std::fs::read(e.root.join("executions")).unwrap(), b"x");
                }
            }
            let stable = e.converges().await;
            assert_eq!(stable["calls"][0]["status"], match boundary {
                "decision" => "pending_approval",
                "execution_claim" => "cancelled",
                _ => "unknown",
            });
            for receipt in recorded["receipts"].as_array().unwrap() {
                assert!(stable["receipts"].as_array().unwrap().contains(receipt));
            }
            e.replay_input(&tid).await;
            if boundary != "decision" {
                let page = e.s.get("/api/v1/recovery").await.1;
                assert_eq!(page["items"].as_array().unwrap().iter().any(|v| v["id"] == cid), boundary == "result");
            }
            let executions = e.executions();
            assert_eq!(executions, if boundary == "result" { b"x".to_vec() } else { vec![] });
            assert_eq!(e.f.requests().len(), 1);
            e.s.stop().await;
        }
    }
}

#[tokio::test]
async fn final_end_record_failure_keeps_evidence_and_restart_emits_one_end_note() {
    for failure in Failure::ALL {
        let mut e = Case::new().await;
        e.f.push(fixture::hang_after("new partial"));
        let tid = e.start().await;
        e.partial().await;
        // 상태·종료 시각·error를 쓴 뒤의 note 저장도 같은 transaction으로 되돌아가야 한다.
        let _probe = e.arm(failure, "BEFORE INSERT ON main.messages").await;
        e.cancel(&tid).await;
        e.failed(failure).await;
        let original = e.evidence(&tid).unwrap();
        assert_eq!(grove::runner::read_evidence(Some(original.clone()))["text"], "new partial");
        assert_eq!(e.durable()["turns"][0]["status"], "running");
        let stable = e.converges().await;
        assert_eq!(e.evidence(&tid).as_deref(), Some(original.as_str()));
        let ended = stable["messages"].as_array().unwrap().iter().filter(|m| {
            serde_json::from_str::<Value>(m["content"].as_str().unwrap()).unwrap()["type"] == "turn_ended"
        }).count();
        assert_eq!(ended, 1);
        e.listed_turn(&tid).await;
        e.s.stop().await;
    }
}

#[tokio::test]
async fn restart_recovery_write_failure_is_atomic_and_a_later_restart_converges() {
    for failure in Failure::ALL {
        let mut e = Case::new().await;
        let (tid, call) = e.pending_shell().await;
        let original = e.seed_evidence(&tid).await;
        let (turn, cid) = (tid.clone(), call["id"].as_str().unwrap().to_string());
        e.app().db.call(move |c| {
            c.execute("UPDATE turns SET status='running',owner_epoch='rec-dead-epoch' WHERE id=?1", [turn])?;
            c.execute("UPDATE tool_calls SET status='running',started_at='2026-01-01T00:00:00Z' WHERE id=?1", [cid])?;
            Ok(())
        }).await.unwrap();
        let before = e.durable();
        let _probe = e.arm(failure, "BEFORE UPDATE OF finished_at ON main.turns").await;
        let error = grove::runner::recover_on_start(&e.app()).await.unwrap_err();
        assert_eq!(error.code, failure.code());
        assert_eq!(error.status, failure.status());
        e.failed(failure).await;
        assert_eq!(e.durable(), before, "앞서 쓴 unknown·도구 메시지도 복구 transaction과 함께 rollback");
        let stable = e.converges().await;
        assert_eq!(stable["turns"][0]["status"], "interrupted");
        assert_eq!(stable["calls"][0]["status"], "unknown");
        assert_eq!(e.evidence(&tid).as_deref(), Some(original.as_str()));
        e.listed_turn(&tid).await;
        assert!(!e.root.join("executions").exists());
        e.s.stop().await;
    }
}

#[tokio::test]
async fn acknowledgment_and_review_failures_keep_originals_and_only_committed_receipts_replay() {
    for failure in Failure::ALL {
        for boundary in ["acknowledge", "review_receipt"] {
            let mut e = Case::new().await;
            let (tid, cid) = e.recovered_unknown().await;
            let before = e.durable();
            let original = e.evidence(&tid).unwrap();
            let (status, observation) = e.s.get(&format!("/api/v1/tool-calls/{cid}/observe")).await;
            assert_eq!(status, StatusCode::OK);
            let review = json!({
                "expected_revision": observation["revision"], "fingerprint": observation["fingerprint"],
                "outcome": "unsure", "note": "fixture review; not a success receipt",
            });
            let _probe = e.arm(failure, if boundary == "acknowledge" {
                "BEFORE UPDATE OF acknowledged_at ON main.turns"
            } else {
                "BEFORE INSERT ON main.idempotency"
            }).await;
            let (path, body) = if boundary == "acknowledge" {
                (format!("/api/v1/turns/{tid}/acknowledge"), json!({}))
            } else {
                (format!("/api/v1/tool-calls/{cid}/review"), review.clone())
            };
            let response = e.s.raw(Method::POST, &path, Some(body), Some("rec-review"), None).await;
            assert_eq!(response.status(), failure.status(), "{failure:?}/{boundary}");
            assert_eq!(response.json::<Value>().await.unwrap()["error"]["code"], failure.code());
            e.failed(failure).await;
            assert_eq!(e.durable(), before);
            e.converges().await;
            e.listed_turn(&tid).await;
            let page = e.s.get("/api/v1/recovery").await.1;
            assert!(page["items"].as_array().unwrap().iter().any(|v| v["id"] == cid));
            let (status, acknowledged) = e.s.post(&format!("/api/v1/turns/{tid}/acknowledge"), json!({})).await;
            assert_eq!(status, StatusCode::OK);
            let (status, repeated) = e.s.post(&format!("/api/v1/turns/{tid}/acknowledge"), json!({})).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(acknowledged["acknowledged_at"], repeated["acknowledged_at"]);
            for replay in [false, true] {
                let response = e.s.raw(Method::POST, &format!("/api/v1/tool-calls/{cid}/review"), Some(review.clone()), Some("rec-review"), None).await;
                assert_eq!(response.status(), StatusCode::OK);
                assert_eq!(response.headers().contains_key("idempotent-replayed"), replay);
                let result = response.json::<Value>().await.unwrap();
                assert_eq!(result["status"], "unknown");
                assert_eq!(result["review"]["outcome"], "unsure");
            }
            let page = e.s.get("/api/v1/recovery").await.1;
            assert!(page["items"].as_array().unwrap().is_empty());
            let reviewed = e.durable();
            assert_eq!(e.converges().await, reviewed);
            assert_eq!(e.evidence(&tid).as_deref(), Some(original.as_str()));
            assert_eq!(e.f.requests().len(), 1);
            assert!(!e.root.join("executions").exists());
            e.s.stop().await;
        }
    }
}
