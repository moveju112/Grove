//! 모델 입력 페이지·분기 구간의 순차 처리(DB-012).
use crate::common;

use common::fixture::Fixture;
use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};

async fn append(s: &TestServer, session: &str, rows: Vec<(&str, Value, Option<Value>)>) {
    let session = session.to_string();
    let rows: Vec<_> = rows.into_iter().map(|(role, content, model_input)| (role.to_string(), content, model_input)).collect();
    let app = s.server.as_ref().unwrap().app.clone();
    let now = app.now();
    app.db.call(move |c| {
        let tx = c.transaction()?;
        for (role, content, model_input) in rows {
            grove::sessions::append_message(&tx, &now, &session, &role, &content, None, model_input.as_ref())?;
        }
        tx.commit()?;
        Ok(())
    }).await.unwrap();
}

#[tokio::test]
async fn large_pages_use_model_representation_and_keep_exact_counts_and_unicode_cuts() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("pages").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap();
    let mut rows = vec![];
    let mut chars = 0u64;
    for index in 0..300 {
        if index % 2 == 0 {
            let text = format!("입력{index}");
            chars += text.chars().count() as u64;
            rows.push(("user", json!({ "text": format!("표시 원본 {}", "x".repeat(16_000)) }), Some(json!({ "text": text }))));
        } else {
            let text = format!("{}{index}", "가".repeat(6000));
            chars += text.chars().count() as u64;
            rows.push(("assistant", json!({ "text": text }), None));
        }
    }
    append(&s, sid, rows).await;
    let (status, page) = s.get(&format!("/api/v1/sessions/{sid}/model-input?offset=1&limit=2")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["total"], 300);
    assert_eq!(page["offset"], 1);
    assert_eq!(page["next_offset"], 3);
    assert_eq!(page["items"].as_array().unwrap().len(), 2);
    assert_eq!(page["items"][0]["role"], "assistant");
    assert_eq!(page["items"][0]["content"]["text"].as_str().unwrap(), "가".repeat(4000));
    assert_eq!(page["items"][0]["content"]["truncated_chars"], 2001);
    assert_eq!(page["items"][1]["content"]["text"], "입력2");
    assert!(!page.to_string().contains("표시 원본"));
    let (_, outside) = s.get(&format!("/api/v1/sessions/{sid}/model-input?offset=999&limit=2")).await;
    assert_eq!(outside["total"], 300);
    assert_eq!(outside["offset"], 300);
    assert!(outside["items"].as_array().unwrap().is_empty());
    assert!(outside["next_offset"].is_null());
    let (_, usage) = s.get(&format!("/api/v1/sessions/{sid}/context?profile_id={profile}")).await;
    assert_eq!(usage["estimated_tokens"], chars.div_ceil(4));
}

#[tokio::test]
async fn page_boundaries_keep_tool_results_synthetic_interruptions_and_deferred_notes() {
    let s = TestServer::start().await;
    let project = s.create_project("pairs").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap();
    append(&s, sid, vec![
        ("user", json!({ "text": "start" }), None),
        ("assistant", json!({ "tool_calls": [
            { "id": "missing", "name": "read", "arguments": {} },
            { "id": "done", "name": "read", "arguments": {} },
        ] }), None),
        ("note", json!({ "type": "agent_result", "run_id": "r", "agent_id": "worker", "status": "completed", "text": "deferred-result" }), None),
        ("tool", json!({ "provider_call_id": "done", "name": "read", "output": "result" }), None),
        ("user", json!({ "text": "next" }), None),
    ]).await;
    let (_, page) = s.get(&format!("/api/v1/sessions/{sid}/model-input?offset=2&limit=2")).await;
    assert_eq!(page["total"], 5);
    assert_eq!(page["next_offset"], 4);
    assert_eq!(page["items"][0]["call_id"], "done");
    assert_eq!(page["items"][0]["content"]["text"], "result");
    assert_eq!(page["items"][1]["call_id"], "missing");
    assert_eq!(page["items"][1]["is_error"], true);
    let (_, last) = s.get(&format!("/api/v1/sessions/{sid}/model-input?offset=4&limit=1")).await;
    assert_eq!(last["items"][0]["role"], "user");
    let text = last["items"][0]["content"]["text"].as_str().unwrap();
    assert!(text.contains("deferred-result") && text.ends_with("\n\nnext"));
}

#[tokio::test]
async fn nested_forks_use_only_parent_compactions_that_existed_at_the_fork_boundary() {
    let s = TestServer::start().await;
    let project = s.create_project("fork-pages").await;
    let parent = s.create_session(project["id"].as_str().unwrap()).await;
    let parent = parent["id"].as_str().unwrap();
    append(&s, parent, vec![
        ("user", json!({ "text": "obsolete-history".repeat(10_000) }), None),
        ("assistant", json!({ "text": "obsolete-answer" }), None),
        ("note", json!({ "type": "compaction", "upto_seq": 2, "summary": "retained-summary" }), None),
        ("user", json!({ "text": "after-summary" }), None),
        ("assistant", json!({ "text": "recent-answer" }), None),
    ]).await;
    let (status, child) = s.post(&format!("/api/v1/sessions/{parent}/fork"), json!({ "from_seq": 5, "inherit_context": true })).await;
    assert_eq!(status, StatusCode::CREATED);
    let child = child["id"].as_str().unwrap();
    append(&s, parent, vec![
        ("note", json!({ "type": "compaction", "upto_seq": 5, "summary": "late-summary" }), None),
    ]).await;
    append(&s, child, vec![
        ("user", json!({ "text": "child-question" }), None),
        ("assistant", json!({ "text": "child-answer" }), None),
    ]).await;
    let (status, grandchild) = s.post(&format!("/api/v1/sessions/{child}/fork"), json!({ "from_seq": 2, "inherit_context": true })).await;
    assert_eq!(status, StatusCode::CREATED);
    let grandchild = grandchild["id"].as_str().unwrap();
    append(&s, grandchild, vec![("user", json!({ "text": "grandchild-question" }), None)]).await;
    let (_, preview) = s.get(&format!("/api/v1/sessions/{grandchild}/model-input")).await;
    let text = preview.to_string();
    assert_eq!(preview["total"], 5, "{preview}");
    for expected in ["retained-summary", "after-summary", "recent-answer", "child-question", "child-answer", "grandchild-question"] {
        assert!(text.contains(expected), "{expected}: {preview}");
    }
    assert!(!text.contains("obsolete") && !text.contains("late-summary"), "{preview}");
    let (_, original) = s.get(&format!("/api/v1/sessions/{parent}/messages")).await;
    assert!(original.to_string().contains("obsolete-history"), "표시 원본은 보존한다");
}
