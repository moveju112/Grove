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
async fn native_context_uses_reported_window_survives_restart_and_excludes_old_profile_and_boundary() {
    let mut s = TestServer::start().await;
    let (_, profile) = s.post("/api/v1/model-profiles", json!({"name":"native-context","protocol":"codex_cli","base_url":"","model":"default"})).await;
    let (_, other) = s.post("/api/v1/model-profiles", json!({"name":"other-context","protocol":"codex_cli","base_url":"","model":"default"})).await;
    let p = s.create_project("native-context").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_owned();
    let pid = profile["id"].as_str().unwrap().to_owned();
    let path = format!("/api/v1/sessions/{sid}/context?profile_id={pid}");
    assert!(s.get(&path).await.1["percent"].is_null());
    for (step, tokens) in [(1, 25_000), (2, 5_000), (3, 0)] {
        let now = s.server.as_ref().unwrap().app.now();
        let (sid, pid) = (sid.clone(), pid.clone());
        s.server.as_ref().unwrap().app.db.call(move |c| {
            let tx = c.transaction()?;
            let message = grove::sessions::append_message(&tx, &now, &sid, "user", &json!({"text":"next"}), None, None)?;
            let turn = format!("context-turn-{step}");
            tx.execute("INSERT INTO turns(id,session_id,status,request_message_id,profile_id,created_at,updated_at,finished_at,owner_epoch) \
                VALUES(?1,?2,'completed',?3,?4,?5,?5,?5,'fixture')", rusqlite::params![turn,sid,message.id,pid,now])?;
            grove::sessions::append_message(&tx, &now, &sid, "assistant", &json!({
                "text":"history ".repeat(20_000), "usage":{"input_tokens":900_000,"output_tokens":100_000},
                "context_usage":{"tokens":tokens,"context_window":100_000},
            }), Some(&turn), None)?;
            tx.commit()?;
            Ok(())
        }).await.unwrap();
        let (status, usage) = s.get(&path).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(usage["basis"], "native");
        assert_eq!(usage["tokens"], tokens);
        assert_eq!(usage["percent"], tokens as f64 / 1000.0);
        assert!(usage["estimated_tokens"].as_u64().unwrap() > tokens);
        assert!(usage["measured_input_tokens"].is_null(), "과금 누적량을 실측 문맥으로 쓰지 않는다");
        if step == 1 {
            s.restart().await;
            assert_eq!(s.get(&path).await.1["percent"], 25.0);
        }
    }
    let other_path = format!("/api/v1/sessions/{sid}/context?profile_id={}", other["id"].as_str().unwrap());
    assert!(s.get(&other_path).await.1["percent"].is_null());
    let unspecified = s.get(&format!("/api/v1/sessions/{sid}/context")).await.1;
    assert!(unspecified["measured_input_tokens"].is_null(), "프로필 없는 조회도 native 과금 누적값을 제외한다");
    let now = s.server.as_ref().unwrap().app.now();
    s.server.as_ref().unwrap().app.db.call(move |c| {
        grove::sessions::append_message(c, &now, &sid, "note", &json!({"type":"context_clear","upto_seq":6}), None, None)?;
        Ok(())
    }).await.unwrap();
    let usage = s.get(&path).await.1;
    assert!(usage["percent"].is_null());
    assert_eq!(usage["basis"], "estimated");
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
    let prof = profile_with_window(&s, &f.base, 16_000).await;
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
    // 이 시험의 대화는 아주 짧으므로 최소 대상 기준(CMP-003)을 끈다
    s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/context.compact_min_tokens"), json!({ "expected_revision": 0, "value": 0 })).await;
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

async fn auto_session(s: &TestServer, base: &str, window: u64) -> (String, String, String) {
    let prof = profile_with_window(s, base, window).await;
    let p = s.create_project("cmp").await;
    let pid = p["id"].as_str().unwrap().to_string();
    let sid = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/context.auto_compact_percent"), json!({ "expected_revision": 0, "value": 50 })).await;
    (prof, pid, sid)
}

fn summary_requests(f: &Fixture) -> usize {
    f.requests().iter().filter(|r| r.to_string().contains(SUMMARY)).count()
}

// CMP-003: 요약할 이전 대화가 최소 기준보다 작으면 자동 압축은 모델을 부르지 않고 원문을 그대로 보낸다.
#[tokio::test]
async fn auto_compaction_skips_ranges_below_minimum() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let (prof, pid, sid) = auto_session(&s, &f.base, 20).await;
    f.push(fixture::text("짧은 답"));
    turn(&s, &sid, &prof, "짧은 질문", false).await;
    f.push(fixture::text("둘째 답"));
    turn(&s, &sid, &prof, "둘째", false).await;
    assert_eq!(summary_requests(&f), 0, "기본 최소 기준(500 token) 미만이면 요약 호출 0");
    assert!(notes_of(&s, &sid, "compaction").await.is_empty());
    assert!(f.requests().last().unwrap()["messages"].to_string().contains("짧은 질문"), "원문 유지");
    // 경계값: 기준을 대상 크기 이하로 낮추면 같은 대화에서 압축한다
    s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/context.compact_min_tokens"), json!({ "expected_revision": 0, "value": 1 })).await;
    f.push_for(SUMMARY, fixture::text("요"));
    f.push(fixture::text("셋째 답"));
    turn(&s, &sid, &prof, "셋째", false).await;
    assert_eq!(summary_requests(&f), 1);
    let cp = &notes_of(&s, &sid, "compaction").await[0]["content"];
    // CMP-005: 요약 후보에 원문 구간·hash·timeline revision·모델·사용량을 남긴다
    assert_eq!(cp["source"]["from_seq"], 0);
    assert_eq!(cp["source"]["upto_seq"], cp["upto_seq"]);
    assert_eq!(cp["source"]["messages"], 4, "{cp}");
    assert_eq!(cp["source"]["sha256"].as_str().unwrap().len(), 64);
    assert!(cp["source"]["timeline_revision"].is_i64() && cp["profile_id"] == prof.as_str() && cp["usage"].is_object(), "{cp}");
}

// CMP-006·007: 원문보다 짧지 않은 요약은 거부하고, 마지막 압축 이후 연속 실패가 한도에 닿으면 자동 압축을 멈춘다.
#[tokio::test]
async fn longer_summary_is_rejected_and_repeated_auto_failures_pause() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let (prof, pid, sid) = auto_session(&s, &f.base, 20).await;
    s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/context.compact_min_tokens"), json!({ "expected_revision": 0, "value": 0 })).await;
    f.push(fixture::text("답"));
    turn(&s, &sid, &prof, "질문", false).await;
    let long = "긴 요약 ".repeat(50);
    for i in 0..2 {
        f.push_for(SUMMARY, fixture::text(&long));
        f.push(fixture::text(&format!("답{i}")));
        turn(&s, &sid, &prof, &format!("다음{i}"), false).await;
    }
    let failed = notes_of(&s, &sid, "compaction_failed").await;
    assert_eq!(failed.len(), 2);
    assert_eq!(failed[0]["content"]["error"]["code"], "summary_not_shorter", "{failed:?}");
    assert!(notes_of(&s, &sid, "compaction").await.is_empty(), "거부한 후보는 적용하지 않는다");
    let calls = summary_requests(&f);
    for i in 2..4 {
        f.push(fixture::text(&format!("답{i}")));
        turn(&s, &sid, &prof, &format!("다음{i}"), false).await;
    }
    assert_eq!(summary_requests(&f), calls, "한도 뒤에는 같은 대화의 자동 요약을 다시 부르지 않는다");
    let paused = notes_of(&s, &sid, "compaction_paused").await;
    assert_eq!(paused.len(), 1, "정지 안내는 한 번만");
    assert_eq!(paused[0]["content"]["limit"], 2);
    // 수동 압축이 성공하면 다시 센다
    f.push_for(SUMMARY, fixture::text("짧은 요약"));
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/compact"), json!({ "profile_id": prof })).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    f.push(fixture::text("하나 더 답"));
    f.push(fixture::text("하나 더 답 2"));
    turn(&s, &sid, &prof, "하나 더", false).await;
    turn(&s, &sid, &prof, "하나 더 2", false).await;
    assert!(summary_requests(&f) > calls + 1, "성공한 압축 뒤에는 자동 압축을 다시 시도한다");
}

// CMP-014: 추가 검사만 끄면 이전 방식(최소 대상·길이 검사 없음)으로 돌아가고, 원문 hash 확인은 그대로 남는다.
#[tokio::test]
async fn compaction_checks_can_be_disabled_without_dropping_source_checks() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let (prof, pid, sid) = auto_session(&s, &f.base, 20).await;
    let (st, v) = s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/context.compaction_checks"), json!({ "expected_revision": 0, "value": false })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    f.push(fixture::text("답"));
    turn(&s, &sid, &prof, "질문", false).await;
    f.push_for(SUMMARY, fixture::text(&"긴 요약 ".repeat(50)));
    f.push(fixture::text("다음 답"));
    turn(&s, &sid, &prof, "다음", false).await;
    let cps = notes_of(&s, &sid, "compaction").await;
    assert_eq!(cps.len(), 1, "작은 대상·긴 요약도 이전 방식대로 적용");
    assert_eq!(cps[0]["content"]["source"]["messages"], 2, "원문 구간 기록은 유지");
    assert!(notes_of(&s, &sid, "compaction_failed").await.is_empty());
}

// CMP-008: 요약 생성 중 대상 원문이 바뀌면 후보를 적용하지 않는다(원문 구간 hash 비교).
#[tokio::test]
async fn summary_is_discarded_when_source_changes_during_generation() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = profile_with_window(&s, &f.base, 100_000).await;
    let p = s.create_project("cas").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    f.push(fixture::text("첫 답"));
    turn(&s, &sid, &prof, "첫 질문", false).await;
    f.push(fixture::text("둘째 답"));
    turn(&s, &sid, &prof, "둘째 질문", false).await;
    f.push_for(SUMMARY, fixture::slow_text(&["요", "약"], 400));
    let compact = {
        let (c, b, t, sid, prof) = (s.client.clone(), s.base.clone(), s.token.clone(), sid.clone(), prof.clone());
        tokio::spawn(async move {
            let r = c.post(format!("{b}/api/v1/sessions/{sid}/compact")).bearer_auth(t).header("Idempotency-Key", "cas-1").json(&json!({ "profile_id": prof })).send().await.unwrap();
            (r.status(), r.json::<Value>().await.unwrap())
        })
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while summary_requests(&f) == 0 {
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute("UPDATE messages SET content = json_set(content, '$.text', '바뀐 답') WHERE session_id = ?1 AND role = 'assistant' AND seq = (SELECT MIN(seq) FROM messages WHERE session_id = ?1 AND role = 'assistant')", [&sid]).unwrap();
    let (st, v) = compact.await.unwrap();
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"]["code"], "source_changed");
    assert!(notes_of(&s, &sid, "compaction").await.is_empty());
}

// CMP-010: 압축이 없으면 다음 요청은 이전 요청의 지침·도구 schema·메시지를 같은 직렬화로 그대로 앞에 둔다(provider cache prefix 유지).
#[tokio::test]
async fn consecutive_requests_keep_an_identical_serialized_prefix() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = profile_with_window(&s, &f.base, 100_000).await;
    let p = s.create_project("prefix").await;
    let root = p["root_path"].as_str().unwrap();
    std::fs::write(format!("{root}/AGENTS.md"), "지침: 짧게 답한다").unwrap();
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    f.push(fixture::tool_calls(&[("r1", "read", json!({ "path": "AGENTS.md" }))]));
    f.push(fixture::text("첫 답"));
    turn(&s, &sid, &prof, "첫 질문", true).await;
    f.push(fixture::text("둘째 답"));
    turn(&s, &sid, &prof, "둘째 질문", true).await;
    let reqs = f.requests();
    let (a, b) = (&reqs[1], &reqs[2]);
    assert_eq!(a["tools"].to_string(), b["tools"].to_string(), "도구 schema 직렬화가 같다");
    let (am, bm) = (a["messages"].as_array().unwrap(), b["messages"].as_array().unwrap());
    assert!(bm.len() > am.len());
    for (i, m) in am.iter().enumerate() {
        assert_eq!(m.to_string(), bm[i].to_string(), "{i}번째 메시지가 다시 쓰였다");
    }
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

#[tokio::test]
async fn disabled_compressor_uses_main_but_selected_compressor_failure_has_no_fallback() {
    let s=TestServer::start().await;
    let main=Fixture::start().await;
    let aux=Fixture::start().await;
    let profile=profile_with_window(&s,&main.base,100_000).await;
    let model=profile_with_window(&s,&aux.base,100_000).await;
    let pid=s.create_project("compressor-route").await["id"].as_str().unwrap().to_string();
    let sid=s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    for text in ["첫 질문","둘째 질문"] {
        main.push(fixture::text(&"충분히 긴 대화 근거 ".repeat(100)));
        turn(&s,&sid,&profile,text,false).await;
    }
    s.send(Method::PUT,"/api/v1/settings/server/-/context.summary_profile",json!({"expected_revision":0,"value":model})).await;
    let (_,def)=s.get("/api/v1/definitions/agent/context-compressor").await;
    s.send(Method::PUT,"/api/v1/definitions/agent/context-compressor",json!({"expected_revision":def["revision"],"enabled":false,"body":"CUSTOM_COMPRESSOR_INSTRUCTIONS"})).await;
    main.push_for(SUMMARY,fixture::text("기본 대화 압축"));
    let (status,result)=s.post(&format!("/api/v1/sessions/{sid}/compact"),json!({"profile_id":profile})).await;
    assert_eq!(status,StatusCode::CREATED,"{result}");
    assert!(aux.requests().is_empty());
    assert!(!main.requests().last().unwrap().to_string().contains("CUSTOM_COMPRESSOR_INSTRUCTIONS"));
    main.push(fixture::text(&"다음 근거 ".repeat(100)));
    turn(&s,&sid,&profile,"셋째 질문",false).await;
    let (_,def)=s.get("/api/v1/definitions/agent/context-compressor").await;
    s.send(Method::PUT,"/api/v1/definitions/agent/context-compressor",json!({"expected_revision":def["revision"],"enabled":true})).await;
    let before=main.requests().len();
    aux.push(fixture::Step::Error(400,"fixture unavailable".into()));
    let (status,result)=s.post(&format!("/api/v1/sessions/{sid}/compact"),json!({"profile_id":profile})).await;
    assert_eq!(status,StatusCode::BAD_GATEWAY,"{result}");
    assert_eq!(main.requests().len(),before,"선택한 모델 실패 후 대화 모델을 호출하지 않는다");
    assert_eq!(notes_of(&s,&sid,"compaction").await.len(),1);
    assert!(aux.requests()[0].to_string().contains("CUSTOM_COMPRESSOR_INSTRUCTIONS"));
}
