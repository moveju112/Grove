//! 컨텍스트 사용량·압축(CTX-001~007, 011).
mod common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

const SUMMARY: &str = "You compress a conversation";

async fn profile_with_window(s: &TestServer, base: &str, window: u64) -> String {
    let (_, sec) = s.post("/api/v1/secrets", json!({ "label": "w", "value": "sk-test-secret-value-9999" })).await;
    let (st, p) = s
        .post(
            "/api/v1/model-profiles",
            json!({ "name": format!("w{window}"), "protocol": "openai", "base_url": base, "model": "m", "secret_id": sec["id"], "options": { "timeout_secs": 30, "context_window": window } }),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED, "{p}");
    p["id"].as_str().unwrap().to_string()
}

async fn turn(s: &TestServer, sid: &str, prof: &str, text: &str, tools: bool) -> Value {
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": text, "profile_id": prof, "tools": tools })).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await
}

async fn notes_of(s: &TestServer, sid: &str, kind: &str) -> Vec<Value> {
    let (_, m) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    m["items"].as_array().unwrap().iter().filter(|m| m["role"] == "note" && m["content"]["type"] == kind).cloned().collect()
}

#[tokio::test]
async fn manual_compaction_replaces_old_history_and_keeps_tool_pairs() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = profile_with_window(&s, &f.base, 100_000).await;
    let p = s.create_project("c").await;
    let root = p["root_path"].as_str().unwrap();
    std::fs::write(format!("{root}/n.txt"), "노트").unwrap();
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    // 1턴: 도구 사용, 2턴: 일반 대화
    f.push(fixture::tool_calls(&[("r1", "read", json!({ "path": "n.txt" }))]));
    f.push(fixture::text("답1 OLDSECRET"));
    turn(&s, &sid, &prof, "첫 질문", true).await;
    f.push(fixture::text("답2"));
    turn(&s, &sid, &prof, "둘째 질문", false).await;
    // 사용량(실측이 없으므로 추정)
    let (_, u) = s.get(&format!("/api/v1/sessions/{sid}/context?profile_id={prof}")).await;
    assert_eq!(u["context_window"], 100_000);
    assert!(u["estimated_tokens"].as_u64().unwrap() > 0);
    assert!(u["percent"].as_f64().is_some(), "{u}");
    // 요약 실패: 아무것도 바뀌지 않는다
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/compact"), json!({ "profile_id": prof })).await;
    assert_eq!(st, StatusCode::BAD_GATEWAY, "{v}");
    assert!(notes_of(&s, &sid, "compaction").await.is_empty());
    // 성공
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute("INSERT INTO cli_sessions(session_id,profile_id,native_id,updated_at) VALUES (?1,?2,'old-native-fixture','2020-01-01T00:00:00Z')",
        rusqlite::params![sid,prof]).unwrap();
    f.push_for(SUMMARY, fixture::text("요약: 사용자가 n.txt를 읽게 했고 첫 질문에 답함"));
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/compact"), json!({ "profile_id": prof })).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    assert_eq!(db.query_row("SELECT COUNT(*) FROM cli_sessions WHERE session_id=?1",[&sid],|r|r.get::<_,i64>(0)).unwrap(), 0,
        "요약된 원문을 가진 native CLI context를 재사용하지 않는다");
    let cp = &notes_of(&s, &sid, "compaction").await[0]["content"];
    assert_eq!(cp["auto"], false);
    // 요약 요청에는 압축 대상(1턴·도구 결과)만, 최근 user 메시지는 들어가지 않는다
    let reqs = f.requests();
    let sreq = reqs.iter().find(|r| r.to_string().contains(SUMMARY)).unwrap().to_string();
    assert!(sreq.contains("OLDSECRET") && !sreq.contains("둘째 질문"), "{sreq}");
    // 다음 턴 입력: 요약 + 최근 교환(둘째 질문·답2) + 새 질문. 압축된 원문과 고아 tool 메시지 없음
    f.push(fixture::text("셋째 답"));
    turn(&s, &sid, &prof, "셋째 질문", false).await;
    let msgs = f.requests().last().unwrap()["messages"].clone();
    let text = msgs.to_string();
    assert!(text.contains("[Summary of the earlier conversation") && text.contains("요약: 사용자가"), "{text}");
    assert!(text.contains("둘째 질문") && text.contains("답2") && text.contains("셋째 질문"));
    assert!(!text.contains("OLDSECRET"), "압축된 원문 제외: {text}");
    assert!(msgs.as_array().unwrap().iter().all(|m| m["content"] != "첫 질문"), "압축된 user 메시지는 단독으로 남지 않는다: {text}");
    assert!(msgs.as_array().unwrap().iter().all(|m| m["role"] != "tool"), "tool 결과는 짝과 함께 요약으로 대체: {text}");
    // 화면 이력은 지워지지 않는다
    let (_, all) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert!(all.to_string().contains("OLDSECRET"));
    // 모델 입력 보기(SESSION-011): 실제로 보낸 것과 같은 구성(요약 먼저, 압축된 원문·고아 tool 없음), 페이지 조회
    let (st, mi) = s.get(&format!("/api/v1/sessions/{sid}/model-input")).await;
    assert_eq!(st, StatusCode::OK, "{mi}");
    let items = mi["items"].as_array().unwrap();
    assert!(items[0]["content"]["text"].as_str().unwrap().contains("요약: 사용자가"), "{mi}");
    assert!(!mi.to_string().contains("OLDSECRET"), "압축된 원문은 모델 입력에 없다: {mi}");
    assert!(items.iter().all(|m| m["role"] != "tool"));
    let sent: Vec<&Value> = msgs.as_array().unwrap().iter().filter(|m| m["role"] != "system").collect();
    assert_eq!(mi["total"].as_u64().unwrap() as usize, sent.len() + 1, "마지막으로 보낸 입력 + 그 답(셋째 답)");
    let (_, p1) = s.get(&format!("/api/v1/sessions/{sid}/model-input?limit=2")).await;
    assert_eq!(p1["items"].as_array().unwrap().len(), 2);
    assert_eq!(p1["next_offset"], 2);
    let (_, p2) = s.get(&format!("/api/v1/sessions/{sid}/model-input?offset=2&limit=200")).await;
    assert_eq!(p2["items"][0]["index"], 2);
    assert!(p2["next_offset"].is_null());
    // 두 번째 압축: 이전 요약 + 둘째 교환이 입력이고, 마지막 교환(셋째)은 남긴다
    f.push_for(SUMMARY, fixture::text("요약2"));
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/compact"), json!({ "profile_id": prof })).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let sreq = f.requests().iter().rev().find(|r| r.to_string().contains(SUMMARY)).unwrap().to_string();
    assert!(sreq.contains("요약: 사용자가") && sreq.contains("둘째 질문") && !sreq.contains("셋째 질문"), "{sreq}");
    // 더 압축할 것이 없으면 변경 없음(200, compacted=false)
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/compact"), json!({ "profile_id": prof })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["compacted"], false);
    assert_eq!(notes_of(&s, &sid, "compaction").await.len(), 2);
}

#[tokio::test]
async fn compaction_is_refused_while_a_turn_runs() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = profile_with_window(&s, &f.base, 1000).await;
    let p = s.create_project("busy").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    f.push(fixture::hang_after("..."));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "길게", "profile_id": prof })).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    s.wait_status(&tid, "running").await;
    let (st, _) = s.post(&format!("/api/v1/sessions/{sid}/compact"), json!({ "profile_id": prof })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
}

#[tokio::test]
async fn auto_compaction_runs_before_first_model_call_over_threshold() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = profile_with_window(&s, &f.base, 20).await;
    let p = s.create_project("auto").await;
    let pid = p["id"].as_str().unwrap().to_string();
    let sid = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    f.push(fixture::text("첫 답변은 길게 길게 길게 길게 길게 길게 길게 길게"));
    turn(&s, &sid, &prof, "첫 질문은 길게 길게 길게 길게 길게", false).await;
    // 끔(기본 0): 압축 없음
    f.push(fixture::text("둘째 답"));
    turn(&s, &sid, &prof, "둘째", false).await;
    assert!(notes_of(&s, &sid, "compaction").await.is_empty());
    let (st, v) = s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/context.auto_compact_percent"), json!({ "expected_revision": 0, "value": 50 })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    f.push_for(SUMMARY, fixture::text("자동 요약"));
    f.push(fixture::text("셋째 답"));
    turn(&s, &sid, &prof, "셋째", false).await;
    let cps = notes_of(&s, &sid, "compaction").await;
    assert_eq!(cps.len(), 1);
    assert_eq!(cps[0]["content"]["auto"], true);
    let last = f.requests().last().unwrap()["messages"].to_string();
    assert!(last.contains("자동 요약") && last.contains("셋째"), "{last}");
    // 자동 요약 실패는 턴을 막지 않고 note로 남긴다
    f.push(fixture::text("넷째 답"));
    turn(&s, &sid, &prof, "넷째", false).await;
    assert_eq!(notes_of(&s, &sid, "compaction_failed").await.len(), 1);
}

/// 사용률 기준 아래여도 출력·다음 입력 여유(reserve)가 모자라면 자동 압축한다(CTX-003).
#[tokio::test]
async fn reserve_for_output_and_next_input_triggers_compaction_below_percent() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let (_, sec) = s.post("/api/v1/secrets", json!({ "label": "r", "value": "sk-test-secret-value-5555" })).await;
    let (_, p) = s
        .post(
            "/api/v1/model-profiles",
            json!({ "name": "reserve", "protocol": "openai", "base_url": f.base, "model": "m", "secret_id": sec["id"], "options": { "context_window": 10_000, "max_tokens": 7_000 } }),
        )
        .await;
    let prof = p["id"].as_str().unwrap().to_string();
    let pr = s.create_project("reserve").await;
    let pid = pr["id"].as_str().unwrap().to_string();
    let sid = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    // 사용률 기준은 95%(거의 안 걸림)
    s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/context.auto_compact_percent"), json!({ "expected_revision": 0, "value": 95 })).await;
    let long = "가".repeat(4000);
    f.push(fixture::text(&long));
    turn(&s, &sid, &prof, "길게 답해줘", false).await;
    let (_, u) = s.get(&format!("/api/v1/sessions/{sid}/context?profile_id={prof}")).await;
    assert_eq!(u["reserve_tokens"], 9_000, "max_tokens 7000 + 입력 여유 기본 2000: {u}");
    assert!(u["percent"].as_f64().unwrap() < 95.0, "{u}");
    assert!(u["available_tokens"].as_i64().unwrap() < 0, "{u}");
    f.push_for(SUMMARY, fixture::text("여유 확보 요약"));
    f.push(fixture::text("다음 답"));
    turn(&s, &sid, &prof, "다음", false).await;
    assert_eq!(notes_of(&s, &sid, "compaction").await.len(), 1);
    // 입력 여유분 설정은 반영된다
    s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/context.input_reserve_tokens"), json!({ "expected_revision": 0, "value": 0 })).await;
    let (_, u) = s.get(&format!("/api/v1/sessions/{sid}/context?profile_id={prof}")).await;
    assert_eq!(u["reserve_tokens"], 7_000);
}

/// 작은 context 모델로 바꾸면 그 모델 기준으로 판단해 첫 호출 전에 압축한다(CTX-008).
#[tokio::test]
async fn switching_to_smaller_model_compacts_for_that_model() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let big = profile_with_window(&s, &f.base, 1_000_000).await;
    let small = profile_with_window(&s, &f.base, 8_000).await;
    let p = s.create_project("switch").await;
    let pid = p["id"].as_str().unwrap().to_string();
    let sid = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/context.auto_compact_percent"), json!({ "expected_revision": 0, "value": 80 })).await;
    f.push(fixture::text(&"나".repeat(9000)));
    turn(&s, &sid, &big, "길게", false).await;
    f.push(fixture::text("큰 모델 그대로"));
    turn(&s, &sid, &big, "계속", false).await;
    assert!(notes_of(&s, &sid, "compaction").await.is_empty(), "큰 모델에서는 여유가 있다");
    let (_, u) = s.get(&format!("/api/v1/sessions/{sid}/context?profile_id={small}")).await;
    assert!(u["available_tokens"].as_i64().unwrap() < 0, "{u}");
    f.push_for(SUMMARY, fixture::text("작은 모델용 요약"));
    f.push(fixture::text("작은 모델 답"));
    turn(&s, &sid, &small, "작은 모델로", false).await;
    let cps = notes_of(&s, &sid, "compaction").await;
    assert_eq!(cps.len(), 1);
    let last = f.requests().last().unwrap()["messages"].to_string();
    assert!(last.contains("작은 모델용 요약") && !last.contains(&"나".repeat(100)), "작은 모델 요청에는 요약만 간다");
}

/// provider가 사용량을 주지 않으면(0) 실측으로 보지 않고 추정치를 쓴다.
#[tokio::test]
async fn missing_usage_is_not_reported_as_measured_zero() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = profile_with_window(&s, &f.base, 1000).await;
    let p = s.create_project("zero").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    // usage 프레임 없는 응답
    f.push(fixture::Step::Frames(
        vec![
            json!({ "choices": [{ "delta": { "content": "답" } }] }).to_string(),
            json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] }).to_string(),
            "[DONE]".into(),
        ],
        0,
    ));
    turn(&s, &sid, &prof, "질문", false).await;
    let (_, u) = s.get(&format!("/api/v1/sessions/{sid}/context?profile_id={prof}")).await;
    assert_eq!(u["basis"], "estimated", "{u}");
    assert!(u["measured_input_tokens"].is_null());
    assert!(u["estimated_tokens"].as_u64().unwrap() > 0);
}

// DB-004: 같은 영속 메시지 ID에 연결된 화면 기록과 모델 입력은 서로 다른 표현을 유지한다.
#[tokio::test]
async fn display_and_model_input_share_identity_but_keep_distinct_content_after_restart() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = profile_with_window(&s, &f.base, 100_000).await;
    let p = s.create_project("input-representation").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let app = s.server.as_ref().unwrap().app.clone();
    let session = sid.clone();
    let now = app.now();
    let id = app.db.call(move |c| {
        let tx = c.transaction()?;
        let message = grove::sessions::append_message(&tx, &now, &session, "user", &json!({"text":"화면에 보존할 원본 기록"}), None, Some(&json!({"text":"모델에 전달할 입력 표현"})))?;
        tx.commit()?;
        Ok(message.id)
    }).await.unwrap();
    drop(app);
    s.restart().await;
    let (st, history) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert_eq!(st, StatusCode::OK);
    let shown = history["items"].as_array().unwrap().iter().find(|m| m["id"] == id).unwrap();
    assert_eq!(shown["content"]["text"], "화면에 보존할 원본 기록");
    assert!(shown.get("model_input").is_none());
    let (st, preview) = s.get(&format!("/api/v1/sessions/{sid}/model-input")).await;
    assert_eq!(st, StatusCode::OK);
    assert!(preview.to_string().contains("모델에 전달할 입력 표현"));
    assert!(!preview.to_string().contains("화면에 보존할 원본 기록"));
    f.push(fixture::text("완료"));
    turn(&s, &sid, &prof, "계속", false).await;
    let requests = f.requests();
    let actual = requests.last().unwrap()["messages"].to_string();
    assert!(actual.contains("모델에 전달할 입력 표현"));
    assert!(!actual.contains("화면에 보존할 원본 기록"));
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    let (display, model): (String, String) = db.query_row("SELECT content, model_input FROM messages WHERE id = ?1", [id], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&display).unwrap()["text"], "화면에 보존할 원본 기록");
    assert_eq!(serde_json::from_str::<Value>(&model).unwrap()["text"], "모델에 전달할 입력 표현");
}
