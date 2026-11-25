//! 오래된 읽기 결과의 모델 입력 전용 중복 제거와 원문·경계 보존.
use crate::common;

use common::fixture::{self, Fixture, Step};
use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};

async fn setup(text: &str) -> (TestServer, Fixture, String, String, std::path::PathBuf) {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("dedup").await;
    let path = std::path::Path::new(project["root_path"].as_str().unwrap()).join("sample.txt");
    std::fs::write(&path, text).unwrap();
    let sid = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    (s, f, profile, sid, path)
}

async fn turn(s: &TestServer, f: &Fixture, sid: &str, profile: &str, id: &str, args: Option<Value>) -> Value {
    if let Some(args) = args { f.push(fixture::tool_calls(&[(id, "read", args)])); }
    f.push(fixture::text("done"));
    let (status, response) = s.post(&format!("/api/v1/sessions/{sid}/turns"),
        json!({"profile_id":profile,"text":id,"tools":true})).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{response}");
    s.wait_status(response["turn"]["id"].as_str().unwrap(), "completed").await
}

async fn preview(s: &TestServer, sid: &str) -> Value {
    let (status, result) = s.get(&format!("/api/v1/sessions/{sid}/model-input")).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    result
}

fn tool<'a>(page: &'a Value, id: &str) -> &'a Value {
    page["items"].as_array().unwrap().iter().find(|m| m["call_id"] == id).unwrap()
}

fn duplicate(page: &Value, id: &str) -> bool {
    let text = tool(page, id)["content"]["text"].as_str().unwrap();
    serde_json::from_str::<Value>(text).is_ok_and(|v| v["kind"] == "tool_output_duplicate")
}

#[tokio::test]
async fn exact_old_duplicates_preserve_latest_pairs_originals_restart_and_retrieval() {
    for text in [format!("{}\n", "가😀".repeat(50)).repeat(16), format!("{}\n", "가😀".repeat(50)).repeat(100)] {
        let (mut s, f, profile, sid, _) = setup(&text).await;
        let first = turn(&s, &f, &sid, &profile, "first", Some(json!({"path":"sample.txt"}))).await;
        let first_call = first["tool_calls"][0].clone();
        let second = turn(&s, &f, &sid, &profile, "second", Some(json!({"path":"sample.txt"}))).await;
        let recent = preview(&s, &sid).await;
        assert!(!duplicate(&recent, "first") && !duplicate(&recent, "second"), "최근 두 턴은 보존");
        turn(&s, &f, &sid, &profile, "third", None).await;
        let page = preview(&s, &sid).await;
        assert!(duplicate(&page, "first"));
        assert!(!duplicate(&page, "second"));
        let reference: Value = serde_json::from_str(tool(&page, "first")["content"]["text"].as_str().unwrap()).unwrap();
        assert_eq!(reference["call_id"], first_call["id"]);
        assert_eq!(reference["duplicate_of"], second["tool_calls"][0]["id"]);
        let original = grove::provider::tool_content_string(&first_call["result"]);
        assert_eq!(reference["sha256"], grove::util::sha256_hex(original.as_bytes()));
        assert_eq!(reference["total_bytes"], original.len());
        assert!(reference.to_string().len() < original.len());
        let requests = f.requests();
        let messages = requests.last().unwrap()["messages"].as_array().unwrap();
        let sent = messages.iter().find(|m| m["tool_call_id"] == "first").unwrap();
        assert_eq!(sent["content"], tool(&page, "first")["content"]["text"]);
        assert!(messages.iter().any(|m| m["role"] == "assistant"
            && m["tool_calls"].as_array().is_some_and(|calls| calls.iter().any(|c| c["id"] == "first"))));
        let old_index = page["items"].as_array().unwrap().iter().position(|m| m["call_id"] == "first").unwrap();
        let (_, single) = s.get(&format!("/api/v1/sessions/{sid}/model-input?offset={old_index}&limit=1")).await;
        assert_eq!(&single["items"][0], tool(&page, "first"));
        assert_eq!(single["total"], page["total"]);
        // provider에 실제 전달한 본문·인자와 마지막 응답으로 추정량을 독립 계산한다.
        let chars: usize = messages.iter().filter(|m| m["role"] != "system").map(|m| {
            m["content"].as_str().unwrap_or("").chars().count()
                + m["tool_calls"].as_array().into_iter().flatten().map(|call| {
                    call["function"]["name"].as_str().unwrap().len()
                        + call["function"]["arguments"].as_str().unwrap().len()
                }).sum::<usize>()
        }).sum();
        let (_, usage) = s.get(&format!("/api/v1/sessions/{sid}/context?profile_id={profile}")).await;
        assert_eq!(usage["estimated_tokens"], (chars + "done".len()).div_ceil(4));
        let (_, display) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
        let original_message = display["items"].as_array().unwrap().iter()
            .find(|m| m["content"]["provider_call_id"] == "first").unwrap();
        assert_eq!(original_message["content"]["output"], first_call["result"]);
        s.restart().await;
        assert_eq!(tool(&preview(&s, &sid).await, "first"), tool(&page, "first"));
        // 실제 모델이 기존 조회 도구로 원문을 다시 읽는다. 파일 도구는 재실행하지 않는다.
        f.push(fixture::tool_calls(&[("retrieve", "tool_output_read", reference["read"]["arguments"].clone())]));
        f.push(fixture::text("retrieved"));
        let (_, response) = s.post(&format!("/api/v1/sessions/{sid}/turns"),
            json!({"profile_id":profile,"text":"retrieve","tools":true})).await;
        let done = s.wait_status(response["turn"]["id"].as_str().unwrap(), "completed").await;
        let result = &done["tool_calls"][0]["result"];
        assert_eq!(result["call_id"], first_call["id"]);
        let end = result["end_offset"].as_u64().unwrap() as usize;
        assert_eq!(result["text"], original[..end]);
        let (_, stored) = s.get(&format!("/api/v1/tool-calls/{}", first_call["id"].as_str().unwrap())).await;
        assert_eq!(stored["result"], first_call["result"]);
        turn(&s, &f, &sid, &profile, "fourth-read", Some(json!({"path":"sample.txt"}))).await;
        let later = preview(&s, &sid).await;
        assert_eq!(tool(&later, "first"), tool(&page, "first"), "중복이 더 생겨도 기존 참조는 바꾸지 않는다");
        assert!(duplicate(&later, "second"));
        assert!(!duplicate(&later, "fourth-read"));
    }
}

#[tokio::test]
async fn different_arguments_changed_results_and_small_results_are_not_duplicates() {
    for variant in ["arguments", "result", "small"] {
        let text = if variant == "small" { "small".to_string() } else { format!("{}\n", "x".repeat(100)).repeat(60) };
        let (s, f, profile, sid, path) = setup(&text).await;
        let first = turn(&s, &f, &sid, &profile, "first", Some(json!({"path":"sample.txt","offset":0}))).await;
        if variant == "result" { std::fs::write(path, format!("{}\n", "y".repeat(100)).repeat(60)).unwrap(); }
        let offset = if variant == "arguments" { 1 } else { 0 };
        let second = turn(&s, &f, &sid, &profile, "second", Some(json!({"path":"sample.txt","offset":offset}))).await;
        if variant == "arguments" {
            assert_eq!(first["tool_calls"][0]["result"], second["tool_calls"][0]["result"],
                "같은 결과라도 요청 인자가 다르면 보존한다");
        }
        turn(&s, &f, &sid, &profile, "third", None).await;
        let page = preview(&s, &sid).await;
        assert!(!duplicate(&page, "first"), "{variant}: {page}");
    }
}

#[tokio::test]
async fn partial_errors_and_unresolved_turn_receipts_are_preserved() {
    for variant in ["partial_error", "failed", "cancelled", "unknown"] {
        let (s, f, profile, sid, _) = setup(&format!("{}\n", "x".repeat(100)).repeat(240)).await;
        let args = if variant == "partial_error" {
            json!({"files":[{"path":"sample.txt"},{"path":"missing.txt"}]})
        } else { json!({"path":"sample.txt"}) };
        let first = turn(&s, &f, &sid, &profile, "first", Some(args.clone())).await;
        turn(&s, &f, &sid, &profile, "second", Some(args)).await;
        turn(&s, &f, &sid, &profile, "third", None).await;
        if variant != "partial_error" {
            assert!(duplicate(&preview(&s, &sid).await, "first"));
            let app = s.server.as_ref().unwrap().app.clone();
            let tid = first["id"].as_str().unwrap().to_string();
            let cid = first["tool_calls"][0]["id"].as_str().unwrap().to_string();
            app.db.call(move |c| {
                if variant == "unknown" {
                    c.execute("UPDATE tool_calls SET status='unknown' WHERE id=?1", [cid])?;
                } else {
                    c.execute("UPDATE turns SET status=?2 WHERE id=?1", [&tid, variant])?;
                }
                Ok(())
            }).await.unwrap();
        }
        assert!(!duplicate(&preview(&s, &sid).await, "first"), "{variant}");
    }
}

#[tokio::test]
async fn an_in_progress_newer_result_does_not_replace_a_completed_old_result() {
    let (s, f, profile, sid, _) = setup(&format!("{}\n", "x".repeat(100)).repeat(60)).await;
    turn(&s, &f, &sid, &profile, "first", Some(json!({"path":"sample.txt"}))).await;
    turn(&s, &f, &sid, &profile, "second", None).await;
    f.push(fixture::tool_calls(&[("active", "read", json!({"path":"sample.txt"}))]));
    let (release, gate) = tokio::sync::watch::channel(false);
    let Step::Frames(frames, _) = fixture::text("held") else { unreachable!() };
    f.push(Step::Gated(frames, gate));
    let (_, response) = s.post(&format!("/api/v1/sessions/{sid}/turns"),
        json!({"profile_id":profile,"text":"active","tools":true})).await;
    let tid = response["turn"]["id"].as_str().unwrap();
    s.wait_turn(tid, |t| t["tool_calls"].as_array()
        .is_some_and(|calls| calls.iter().any(|c| c["provider_call_id"] == "active" && c["status"] == "succeeded"))).await;
    assert!(!duplicate(&preview(&s, &sid).await, "first"));
    let (status, _) = s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    assert!(status.is_success());
    release.send_replace(true);
    s.wait_status(tid, "cancelled").await;
    assert!(!duplicate(&preview(&s, &sid).await, "first"));
}

#[tokio::test]
async fn duplicates_outside_a_fork_boundary_never_hide_inherited_results() {
    let (s, f, profile, sid, _) = setup(&format!("{}\n", "x".repeat(100)).repeat(60)).await;
    turn(&s, &f, &sid, &profile, "first", Some(json!({"path":"sample.txt"}))).await;
    let (_, first_session) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    turn(&s, &f, &sid, &profile, "second", Some(json!({"path":"sample.txt"}))).await;
    turn(&s, &f, &sid, &profile, "third", None).await;
    assert!(duplicate(&preview(&s, &sid).await, "first"));
    let (status, child) = s.post(&format!("/api/v1/sessions/{sid}/fork"),
        json!({"from_seq":first_session["last_message_seq"],"inherit_context":true})).await;
    assert_eq!(status, StatusCode::CREATED, "{child}");
    let child = child["id"].as_str().unwrap();
    turn(&s, &f, child, &profile, "child-one", None).await;
    turn(&s, &f, child, &profile, "child-two", None).await;
    let page = preview(&s, child).await;
    assert!(!duplicate(&page, "first"));
    assert!(!page["items"].as_array().unwrap().iter().any(|m| m["call_id"] == "second"));
}
