//! SESSION-008~010: 대화 rewind는 파일 undo와 별개이며 활성 이력·모델 입력·검색을 함께 바꾼다.
mod common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

const SUMMARY: &str = "You compress a conversation";

async fn setup() -> (TestServer, Fixture, String, String, String) {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("rewind").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    (s, f, prof, sid, p["root_path"].as_str().unwrap().into())
}

async fn text_turn(s: &TestServer, f: &Fixture, sid: &str, prof: &str, text: &str, answer: &str) -> Value {
    f.push(fixture::text(answer));
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": text, "profile_id": prof })).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    v
}

async fn body(s: &TestServer, sid: &str, message: &str) -> Value {
    let (_, session) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    json!({ "message_id": message, "expected_revision": session["revision"], "expected_last_message_seq": session["last_message_seq"] })
}

#[tokio::test]
async fn rewind_is_idempotent_preserves_files_audit_and_ids_and_resets_cli_context() {
    let (mut s, f, prof, sid, root) = setup().await;
    let keep = text_turn(&s, &f, &sid, &prof, "KEEP_INPUT", "KEEP_ANSWER").await;
    f.push(fixture::tool_calls(&[("w1", "write", json!({ "path": "made.txt", "content": "FILE_STAYS" }))]));
    f.push(fixture::text("REMOVE_ANSWER"));
    let (_, remove) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "REMOVE_INPUT", "profile_id": prof, "tools": true })).await;
    let tid = remove["turn"]["id"].as_str().unwrap();
    let t = s.wait_status(tid, "awaiting_approval").await;
    let call = &t["tool_calls"][0];
    s.post(&format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": call["revision"] })).await;
    s.wait_status(tid, "completed").await;
    let (_, before) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    {
        let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
        db.execute("INSERT INTO cli_sessions VALUES (?1, ?2, 'old-native-context', 't')", rusqlite::params![sid, prof]).unwrap();
    }
    let path = format!("/api/v1/sessions/{sid}/rewind");
    let b = body(&s, &sid, remove["message"]["id"].as_str().unwrap()).await;
    let r = s.raw(Method::POST, &path, Some(b.clone()), Some("rewind-once"), None).await;
    assert_eq!(r.status(), StatusCode::OK);
    let first: Value = r.json().await.unwrap();
    assert_eq!(first["removed_count"], 4);
    assert_eq!(first["files_unchanged"], true);
    let r = s.raw(Method::POST, &path, Some(b), Some("rewind-once"), None).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.json::<Value>().await.unwrap(), first);
    assert_eq!(std::fs::read_to_string(format!("{root}/made.txt")).unwrap(), "FILE_STAYS");
    let (_, page) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert_eq!(page["items"].as_array().unwrap().len(), 3);
    assert_eq!(page["items"][0]["id"], keep["message"]["id"], "남긴 메시지 ID는 바뀌지 않는다");
    assert_eq!(page["timeline_revision"], 1);
    assert!(!page.to_string().contains("REMOVE_"));
    let (_, mi) = s.get(&format!("/api/v1/sessions/{sid}/model-input")).await;
    assert!(mi.to_string().contains("KEEP_") && !mi.to_string().contains("REMOVE_"));
    let (_, hits) = s.get("/api/v1/sessions/search?q=REMOVE_INPUT&body=true").await;
    assert_eq!(hits["total"], 0);
    let (_, turns) = s.get(&format!("/api/v1/sessions/{sid}/turns")).await;
    assert_eq!(turns.as_array().unwrap().len(), 1);
    let (_, audit) = s.get(&format!("/api/v1/turns/{tid}")).await;
    assert_eq!(audit["tool_calls"][0]["status"], "succeeded", "실행 감사 기록은 보존한다");
    let (st, v) = s.post(&format!("/api/v1/turns/{tid}/retry"), json!({})).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["code"], "rewound");
    {
        let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
        assert_eq!(db.query_row("SELECT COUNT(*) FROM messages WHERE session_id = ?1 AND rewound_at IS NOT NULL", [&sid], |r| r.get::<_, i64>(0)).unwrap(), 4);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM cli_sessions WHERE session_id = ?1", [&sid], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }
    s.restart().await;
    let (_, page) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert_eq!(page["timeline_revision"], 1);
    assert!(!page.to_string().contains("REMOVE_"));
    let next = text_turn(&s, &f, &sid, &prof, "NEXT_INPUT", "NEXT_ANSWER").await;
    assert!(next["message"]["seq"].as_i64().unwrap() > before["last_message_seq"].as_i64().unwrap(), "seq를 재사용하지 않는다");
    let req = f.requests().last().unwrap().to_string();
    assert!(req.contains("KEEP_") && req.contains("NEXT_INPUT") && !req.contains("REMOVE_"));
}

#[tokio::test]
async fn rewind_checks_message_identity_revision_new_messages_and_active_work() {
    let (s, f, prof, sid, _) = setup().await;
    let a = text_turn(&s, &f, &sid, &prof, "ONE", "ANSWER").await;
    let mid = a["message"]["id"].as_str().unwrap();
    let path = format!("/api/v1/sessions/{sid}/rewind");
    let old_body = body(&s, &sid, mid).await;
    s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": "LATE_INPUT" })).await;
    let (st, _) = s.post(&path, old_body).await;
    assert_eq!(st, StatusCode::CONFLICT, "새 입력이 끼어들면 이전 확인으로 지우지 않는다");
    let mut stale = body(&s, &sid, mid).await;
    stale["expected_revision"] = json!(0);
    assert_eq!(s.post(&path, stale).await.0, StatusCode::CONFLICT);
    let mut wrong = body(&s, &sid, "missing").await;
    assert_eq!(s.post(&path, wrong.clone()).await.0, StatusCode::NOT_FOUND);
    let (_, page) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    wrong["message_id"] = page["items"][1]["id"].clone();
    assert_eq!(s.post(&path, wrong).await.0, StatusCode::BAD_REQUEST, "assistant 지점은 tool 짝을 자를 수 있어 금지");
    let p = s.create_project("other").await;
    let other = s.create_session(p["id"].as_str().unwrap()).await;
    let foreign = body(&s, other["id"].as_str().unwrap(), mid).await;
    assert_eq!(s.post(&format!("/api/v1/sessions/{}/rewind", other["id"].as_str().unwrap()), foreign).await.0, StatusCode::NOT_FOUND);
    f.push(fixture::hang_after("진행"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "RUNNING", "profile_id": prof })).await;
    let tid = v["turn"]["id"].as_str().unwrap();
    s.wait_status(tid, "running").await;
    let (st, _) = s.post(&path, body(&s, &sid, mid).await).await;
    assert_eq!(st, StatusCode::CONFLICT);
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    s.wait_status(tid, "cancelled").await;
    let (_, page) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert_eq!(page["timeline_revision"], 0, "거절된 요청은 이력을 바꾸지 않는다");
}

#[tokio::test]
async fn rewind_preserves_existing_forks_and_handles_gaps_in_pagination() {
    let (s, f, prof, sid, _) = setup().await;
    let a = text_turn(&s, &f, &sid, &prof, "PARENT", "ANSWER").await;
    let (_, cur) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    let (_, fork) = s.post(&format!("/api/v1/sessions/{sid}/fork"), json!({ "from_seq": cur["last_message_seq"], "inherit_context": true })).await;
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/rewind"), body(&s, &sid, a["message"]["id"].as_str().unwrap()).await).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["code"], "fork_dependency");
    let child = fork["id"].as_str().unwrap();
    let (_, mi) = s.get(&format!("/api/v1/sessions/{child}/model-input")).await;
    assert!(mi.to_string().contains("PARENT"));

    let b = text_turn(&s, &f, child, &prof, "CHILD", "ANSWER").await;
    let (st, _) = s.post(&format!("/api/v1/sessions/{child}/rewind"), body(&s, child, b["message"]["id"].as_str().unwrap()).await).await;
    assert_eq!(st, StatusCode::OK);
    let (_, page) = s.get(&format!("/api/v1/sessions/{child}/messages?after_seq=0")).await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1, "자기 메시지 대신 rewind 안내만 남는다");
    assert_eq!(page["has_more_before"], false, "seq 공백을 과거 메시지로 오인하지 않는다");
    let (_, mi) = s.get(&format!("/api/v1/sessions/{child}/model-input")).await;
    assert!(mi.to_string().contains("PARENT") && !mi.to_string().contains("CHILD"));
}

#[tokio::test]
async fn rewind_rejects_compacted_range_but_keeps_valid_summary_for_later_boundary() {
    let (s, f, prof, sid, _) = setup().await;
    let a = text_turn(&s, &f, &sid, &prof, "FIRST", "FIRST_ANSWER").await;
    let b = text_turn(&s, &f, &sid, &prof, "REMOVE_LATER", "REMOVE_ANSWER").await;
    f.push_for(SUMMARY, fixture::text("SUMMARY_KEEP"));
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/compact"), json!({ "profile_id": prof })).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let path = format!("/api/v1/sessions/{sid}/rewind");
    let (st, v) = s.post(&path, body(&s, &sid, a["message"]["id"].as_str().unwrap()).await).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["code"], "compacted_range");
    assert_eq!(v["error"]["details"]["upto_seq"], 2);
    let (st, v) = s.post(&path, body(&s, &sid, b["message"]["id"].as_str().unwrap()).await).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let (_, page) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert_eq!(page["rewind_boundary_seq"], 2);
    assert!(page.to_string().contains("SUMMARY_KEEP") && !page.to_string().contains("REMOVE_"));
    text_turn(&s, &f, &sid, &prof, "NEXT", "DONE").await;
    let req = f.requests().last().unwrap().to_string();
    assert!(req.contains("SUMMARY_KEEP") && !req.contains("FIRST_ANSWER") && !req.contains("REMOVE_"));
}

#[tokio::test]
async fn compaction_started_before_rewind_cannot_restore_hidden_context() {
    let (s, f, prof, sid, _) = setup().await;
    text_turn(&s, &f, &sid, &prof, "KEEP", "KEEP_ANSWER").await;
    let b = text_turn(&s, &f, &sid, &prof, "REMOVE", "REMOVE_ANSWER").await;
    f.push_for(SUMMARY, fixture::slow_text(&["STALE_SUMMARY"], 500));
    let request = s.client.post(format!("{}/api/v1/sessions/{sid}/compact", s.base)).bearer_auth(&s.token).json(&json!({ "profile_id": prof }));
    let compact = tokio::spawn(async move { request.send().await.unwrap() });
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while !f.requests().iter().any(|r| r.to_string().contains(SUMMARY)) {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/rewind"), body(&s, &sid, b["message"]["id"].as_str().unwrap()).await).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let result = compact.await.unwrap();
    assert_eq!(result.status(), StatusCode::CONFLICT);
    let (_, page) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert!(!page.to_string().contains("STALE_SUMMARY"));
}
