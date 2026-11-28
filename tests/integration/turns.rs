//! 턴 실행·도구 승인·취소·재시작 복구. 모델 응답은 로컬 HTTP fixture(재현용, 실제 모델 품질 증거 아님).
use crate::common;

use common::fixture::{self, Fixture, Step};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn setup() -> (TestServer, Fixture, String, String, String) {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("proj").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    (s, f, prof, sid, p["root_path"].as_str().unwrap().to_string())
}

async fn start_turn(s: &TestServer, sid: &str, prof: &str, text: &str, tools: bool) -> Value {
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": text, "profile_id": prof, "tools": tools })).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    v
}

#[tokio::test]
async fn a_progressing_turn_can_finish_after_more_than_twenty_five_tool_rounds() {
    let (s, f, profile, sid, _) = setup().await;
    for i in 0..26 {
        let id = format!("list-{i}");
        f.push(fixture::tool_calls(&[(&id, "list", json!({"offset":i}))]));
    }
    f.push(fixture::text("모든 단계 완료"));
    let v = start_turn(&s, &sid, &profile, "목록을 검토해", true).await;
    let turn = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(turn["step"], 27);
    let calls = turn["tool_calls"].as_array().unwrap();
    assert_eq!(calls.len(), 26);
    assert!(calls.iter().all(|call| call["status"] == "succeeded"), "{calls:?}");
}

#[tokio::test]
async fn text_turn_streams_partial_then_persists_answer() {
    let (s, f, prof, sid, _) = setup().await;
    f.push(fixture::slow_text(&["안녕", "하세요", "!"], 150));
    let reader = {
        let (c, b, t, sid) = (s.client.clone(), s.base.clone(), s.token.clone(), sid.clone());
        tokio::spawn(async move { read_sse(&c, &b, &t, None, &sid, 100, 3000).await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let v = start_turn(&s, &sid, &prof, "인사해", false).await;
    let tid = v["turn"]["id"].as_str().unwrap();
    let t = s.wait_status(tid, "completed").await;
    assert_eq!(t["usage"]["input_tokens"], 0, "fixture slow_text는 usage를 보내지 않는다");
    let (_, msgs) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let items = msgs["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[1]["role"], "assistant");
    assert_eq!(items[1]["content"]["text"], "안녕하세요!");
    let evs = reader.await.unwrap();
    let updates = events_of(&evs, "turn.updated");
    assert!(updates.iter().any(|e| e["payload"]["status"] == "completed" && e["payload"]["completion_preview"] == "안녕하세요!"));
    assert!(updates.iter().filter(|e| e["payload"]["status"] != "completed").all(|e| e["payload"].get("completion_preview").is_none()));
    let partials: Vec<&Value> = evs.iter().filter(|(n, _)| n == "partial").map(|(_, v)| v).collect();
    assert!(partials.iter().any(|p| p["snapshot"]["text"].as_str().is_some_and(|t| !t.is_empty() && t != "안녕하세요!")), "완료 전 중간 응답 표시: {partials:?}");
    assert!(partials.last().unwrap()["snapshot"].is_null(), "완료 후 중간 응답 제거");
    // wire: system 프롬프트에 기본 워크플로우 원문 포함
    let req = &f.requests()[0];
    assert_eq!(req["model"], "fixture-model");
    assert!(req["messages"][0]["content"].as_str().unwrap().contains("An explicit request is the approval"));
    assert_eq!(f.headers(0).get("authorization").unwrap(), "Bearer sk-test-secret-value-1234");
    // 비밀 원문은 API 응답에 없다
    let (_, secrets) = s.get("/api/v1/secrets").await;
    assert!(!secrets.to_string().contains("sk-test-secret-value-1234"));
    assert_eq!(secrets[0]["masked"], "****1234");
}

#[tokio::test]
async fn cancel_while_streaming_discards_partial() {
    let (s, f, prof, sid, _) = setup().await;
    f.push(fixture::hang_after("중간"));
    let v = start_turn(&s, &sid, &prof, "길게", false).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    s.wait_status(&tid, "running").await;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let (st, c) = s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{c}");
    let t = s.wait_status(&tid, "cancelled").await;
    assert_eq!(t["error"]["code"], "user_stop");
    assert!(t["error"]["at"].is_string());
    assert!(t["error"]["last_progress_at"].is_string());
    let (_, msgs) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let items = msgs["items"].as_array().unwrap();
    assert_eq!(items.iter().filter(|m| m["role"] == "assistant").count(), 0, "취소된 중간 응답은 저장하지 않는다");
    assert_eq!(items.len(), 2, "사용자 입력과 종료 원인만 남는다");
    assert_eq!(items[1]["content"]["type"], "turn_ended");
    assert_eq!(items[1]["content"]["error"], t["error"]);
    // 이미 끝난 턴 취소는 충돌
    let (st, _) = s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    assert_eq!(st, StatusCode::CONFLICT);
    // 다음 턴은 정상
    f.push(fixture::text("다음"));
    let v = start_turn(&s, &sid, &prof, "다시", false).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    assert!(f.requests()[1].to_string().contains("user_stop"), "다음 모델 입력에도 실제 중단 원인을 보존한다");
}

#[tokio::test]
async fn one_active_turn_per_session_and_idempotent_create() {
    let (s, f, prof, sid, _) = setup().await;
    f.push(fixture::hang_after("..."));
    let body = json!({ "text": "x", "profile_id": prof });
    let r1 = s.raw(Method::POST, &format!("/api/v1/sessions/{sid}/turns"), Some(body.clone()), Some("turn-key"), None).await;
    assert_eq!(r1.status(), StatusCode::ACCEPTED);
    let v1: Value = r1.json().await.unwrap();
    // FLOW-04: 응답 유실 후 같은 키 재전송 → 같은 턴, 모델 호출 1회
    let r2 = s.raw(Method::POST, &format!("/api/v1/sessions/{sid}/turns"), Some(body.clone()), Some("turn-key"), None).await;
    let v2: Value = r2.json().await.unwrap();
    assert_eq!(v1["turn"]["id"], v2["turn"]["id"]);
    // 다른 키의 새 턴은 busy
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), body.clone()).await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"]["code"], "busy");
    // 실행 중 메시지 저장도 막는다
    let (st, _) = s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": "끼워넣기" })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(f.requests().len(), 1);
    s.post(&format!("/api/v1/turns/{}/cancel", v1["turn"]["id"].as_str().unwrap()), json!({})).await;
}

/// MODEL-015·016: 오류 정규화와 제한된 재시도. 조각이 나가기 전의 재시도 가능 오류만 최대 2번 다시 보낸다.
#[tokio::test]
async fn provider_errors_are_normalized_and_retried_only_when_safe() {
    let (s, f, prof, sid, _) = setup().await;
    // 계속 500: 처음 1번 + 재시도 2번에서 멈춘다
    for _ in 0..3 {
        f.push(Step::Error(500, "boom".into()));
    }
    let v = start_turn(&s, &sid, &prof, "x", false).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "failed").await;
    assert_eq!(t["error"]["code"], "provider_unavailable");
    assert_eq!(t["error"]["retryable"], true);
    assert_eq!(f.requests().len(), 3, "재시도는 2번까지");

    // 429 뒤 정상: 재시도로 완료
    f.push(Step::Error(429, "slow down".into()));
    f.push(fixture::text("다시 받은 답"));
    let v = start_turn(&s, &sid, &prof, "w", false).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(f.requests().len(), 5);

    // context 초과: 재시도하지 않고 구분된 코드
    f.push(Step::Error(400, "This model's maximum context length is 8192 tokens".into()));
    let v = start_turn(&s, &sid, &prof, "c", false).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "failed").await;
    assert_eq!(t["error"]["code"], "context_too_long");
    assert_eq!(t["error"]["retryable"], false);
    assert_eq!(f.requests().len(), 6, "재시도 불가 오류는 다시 보내지 않는다");

    // 조각이 나간 뒤 끊김: 같은 답을 두 번 보여 주지 않도록 재시도하지 않는다
    f.push(fixture::truncated());
    let v = start_turn(&s, &sid, &prof, "y", false).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "failed").await;
    assert_eq!(t["error"]["code"], "stream_incomplete");
    assert_eq!(f.requests().len(), 7);
    let (_, msgs) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let assistants: Vec<&Value> = msgs["items"].as_array().unwrap().iter().filter(|m| m["role"] == "assistant").collect();
    assert_eq!(assistants.len(), 1, "실패한 부분 응답은 저장하지 않는다(재시도로 받은 답만)");

    f.push(Step::Error(401, "bad key".into()));
    let v = start_turn(&s, &sid, &prof, "z", false).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "failed").await;
    assert_eq!(t["error"]["code"], "auth_failed");
    assert_eq!(f.requests().len(), 8);
    assert!(!t.to_string().contains("sk-test-secret"), "오류에 키가 노출되지 않는다");
}

/// RUN-025: 도구를 실행한 뒤 다음 모델 호출 stream이 끊기면 완료·사용자 취소가 아닌 transport 계열 실패로 끝나고,
/// 이미 실행된 도구를 다시 실행하지 않는다. 진행 범위에 실행된 도구가 남는다.
#[tokio::test]
async fn stream_drop_after_tool_step_does_not_replay_tools() {
    let (s, f, prof, sid, root) = setup().await;
    f.push(fixture::tool_calls(&[("w1", "write", json!({ "path": "once.txt", "content": "1" }))]));
    f.push(fixture::truncated());
    let v = start_turn(&s, &sid, &prof, "써", true).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    let t = s.wait_status(&tid, "awaiting_approval").await;
    let c = &t["tool_calls"][0];
    s.post(&format!("/api/v1/tool-calls/{}/decision", c["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": c["revision"] })).await;
    let t = s.wait_status(&tid, "failed").await;
    assert_eq!(t["error"]["code"], "stream_incomplete", "{t}");
    assert_eq!(t["error"]["scope"]["tool_calls"], json!({ "succeeded": 1 }));
    // 바깥에서 파일을 바꿔 둔다: 도구가 다시 실행되면 내용이 되돌아간다
    std::fs::write(format!("{root}/once.txt"), "changed").unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(std::fs::read_to_string(format!("{root}/once.txt")).unwrap(), "changed", "실행된 도구를 재생하지 않는다");
    assert_eq!(f.requests().len(), 2, "조각이 온 뒤 끊긴 호출은 자동 재시도하지 않는다");
}

/// 재시도 대기 중 취소하면 다시 보내지 않는다.
#[tokio::test]
async fn cancel_during_retry_wait_stops_retrying() {
    let (s, f, prof, sid, _) = setup().await;
    f.push(Step::Error(503, "busy".into()));
    f.push(fixture::text("보내면 안 되는 답"));
    let v = start_turn(&s, &sid, &prof, "x", false).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    // 첫 실패 직후(대기 0.5~0.75초 중) 취소
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    s.wait_status(&tid, "cancelled").await;
    tokio::time::sleep(std::time::Duration::from_millis(900)).await;
    assert_eq!(f.requests().len(), 1, "취소 뒤 재시도 없음");
}

#[tokio::test]
async fn read_tool_runs_automatically_and_result_reaches_model() {
    let (s, f, prof, sid, root) = setup().await;
    std::fs::write(format!("{root}/notes.txt"), "비밀 아님\n둘째 줄\n").unwrap();
    f.push(fixture::tool_calls(&[("c1", "read", json!({ "path": "notes.txt" })), ("c2", "list", json!({}))]));
    f.push(fixture::text("읽었어"));
    let v = start_turn(&s, &sid, &prof, "notes.txt 읽어", true).await;
    let tid = v["turn"]["id"].as_str().unwrap();
    let t = s.wait_status(tid, "completed").await;
    assert_eq!(t["tool_calls"].as_array().unwrap().len(), 2);
    assert!(t["tool_calls"].as_array().unwrap().iter().all(|c| c["status"] == "succeeded"));
    let reqs = f.requests();
    assert_eq!(reqs.len(), 2);
    let msgs = reqs[1]["messages"].as_array().unwrap();
    // [system, user, assistant(tool_calls), tool c1, tool c2]
    assert_eq!(msgs[2]["tool_calls"].as_array().unwrap().len(), 2);
    let tool_msgs: Vec<&Value> = msgs.iter().filter(|m| m["role"] == "tool").collect();
    assert_eq!(tool_msgs.len(), 2);
    let c1 = tool_msgs.iter().find(|m| m["tool_call_id"] == "c1").unwrap();
    assert!(c1["content"].as_str().unwrap().contains("둘째 줄"));
    assert!(reqs[0]["tools"].as_array().unwrap().iter().any(|t| t["function"]["name"] == "edit"));
    // 표시용 필드(UI-014)는 대화 기록에만 있고 모델 입력에는 들어가지 않는다
    assert!(!c1["content"].as_str().unwrap().contains("duration_ms"));
    let (_, msgs) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let tool = msgs["items"].as_array().unwrap().iter().find(|m| m["role"] == "tool" && m["content"]["name"] == "read").unwrap().clone();
    assert_eq!(tool["content"]["args"], json!({ "path": "notes.txt" }));
    assert!(tool["content"]["duration_ms"].as_i64().is_some_and(|d| d >= 0), "{tool}");
    assert_eq!(tool["content"]["truncated"], false);
    assert_eq!(tool["content"]["status"], "succeeded");
}

#[tokio::test]
async fn tool_policy_deny_wins_over_allow_and_bypass() {
    let (s, f, prof, sid, root) = setup().await;
    let (_, sess) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    let pid = sess["project_id"].as_str().or(sess["session"]["project_id"].as_str()).unwrap().to_string();
    let put = |path: String, v: Value| (path, json!({ "expected_revision": 0, "value": v }));
    // 알 수 없는 도구 이름·대화 범위 allow는 거부(조용히 무시되는 정책 방지, 하위 범위가 넓히지 못함)
    let (p, b) = put(format!("/api/v1/settings/project/{pid}/tools.deny"), json!("no_such_tool"));
    assert_eq!(s.send(Method::PUT, &p, b).await.0, StatusCode::BAD_REQUEST);
    let (p, b) = put(format!("/api/v1/settings/session/{sid}/tools.allow"), json!("write"));
    assert_eq!(s.send(Method::PUT, &p, b).await.0, StatusCode::BAD_REQUEST);

    // 1) 프로젝트 allow: write가 승인 없이 실행된다
    let (p, b) = put(format!("/api/v1/settings/project/{pid}/tools.allow"), json!("write"));
    assert_eq!(s.send(Method::PUT, &p, b).await.0, StatusCode::OK);
    f.push(fixture::tool_calls(&[("w1", "write", json!({ "path": "a.txt", "content": "A" }))]));
    f.push(fixture::text("ok"));
    let v = start_turn(&s, &sid, &prof, "a", true).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(t["tool_calls"][0]["status"], "succeeded", "{t}");
    assert_eq!(t["tool_calls"][0]["needs_approval"], false);

    // 2) 프로젝트 deny는 allow와 대화 bypass보다 우선하며 파일은 생기지 않는다.
    let (p, b) = put(format!("/api/v1/settings/project/{pid}/tools.deny"), json!("write"));
    assert_eq!(s.send(Method::PUT, &p, b).await.0, StatusCode::OK);
    let (p, b) = put(format!("/api/v1/settings/session/{sid}/tools.mode"), json!("bypass"));
    assert_eq!(s.send(Method::PUT, &p, b).await.0, StatusCode::OK);
    f.push(fixture::tool_calls(&[("w2", "write", json!({ "path": "b.txt", "content": "B" })), ("r2", "list", json!({}))]));
    f.push(fixture::text("ok"));
    let v = start_turn(&s, &sid, &prof, "b", true).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let calls = t["tool_calls"].as_array().unwrap();
    let w2 = calls.iter().find(|c| c["name"] == "write").unwrap();
    assert_eq!(w2["status"], "failed");
    assert_eq!(w2["result"]["error"]["code"], "policy_denied", "{w2}");
    assert_eq!(calls.iter().find(|c| c["name"] == "list").unwrap()["status"], "succeeded", "읽기 도구는 허용");
    assert!(!std::path::Path::new(&format!("{root}/b.txt")).exists());
    // 모델은 거부 사유를 본다
    let last = f.requests().last().cloned().unwrap();
    assert!(last.to_string().contains("policy_denied"), "모델 입력에 정책 거부가 들어간다");

    // 3) 대화 범위 deny: 읽기 도구도 막는다(deny 최우선)
    let (p, b) = put(format!("/api/v1/settings/session/{sid}/tools.deny"), json!("list"));
    assert_eq!(s.send(Method::PUT, &p, b).await.0, StatusCode::OK);
    f.push(fixture::tool_calls(&[("r3", "list", json!({}))]));
    f.push(fixture::text("ok"));
    let v = start_turn(&s, &sid, &prof, "c", true).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(t["tool_calls"][0]["result"]["error"]["code"], "policy_denied", "{t}");
}

#[tokio::test]
async fn session_scoped_approval_is_limited_to_that_session_and_revocable() {
    let (s, f, prof, sid, root) = setup().await;
    let (_, sess) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    let pid = sess["project_id"].as_str().or(sess["session"]["project_id"].as_str()).unwrap().to_string();
    let decide = |id: &str, d: &str, rev: &Value| (format!("/api/v1/tool-calls/{id}/decision"), json!({ "decision": d, "expected_revision": rev }));

    // 1) 이번만 승인: 범위 once, 다음 호출은 다시 묻는다
    f.push(fixture::tool_calls(&[("w1", "write", json!({ "path": "a.txt", "content": "A" }))]));
    f.push(fixture::text("ok"));
    let v = start_turn(&s, &sid, &prof, "1", true).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    let c = s.wait_status(&tid, "awaiting_approval").await["tool_calls"][0].clone();
    let (p, b) = decide(c["id"].as_str().unwrap(), "approve", &c["revision"]);
    assert_eq!(s.post(&p, b).await.0, StatusCode::OK);
    let t = s.wait_status(&tid, "completed").await;
    assert_eq!(t["tool_calls"][0]["approval_scope"], "once");

    // 2) 이 대화에서 계속 허용
    f.push(fixture::tool_calls(&[("w2", "write", json!({ "path": "b.txt", "content": "B" }))]));
    f.push(fixture::text("ok"));
    let v = start_turn(&s, &sid, &prof, "2", true).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    let c = s.wait_status(&tid, "awaiting_approval").await["tool_calls"][0].clone();
    let (p, b) = decide(c["id"].as_str().unwrap(), "approve_session", &c["revision"]);
    assert_eq!(s.post(&p, b).await.0, StatusCode::OK);
    assert_eq!(s.wait_status(&tid, "completed").await["tool_calls"][0]["approval_scope"], "session");
    let (_, g) = s.get(&format!("/api/v1/sessions/{sid}/tool-grants")).await;
    assert_eq!(g["items"][0]["tool"], "write");

    // 3) 같은 대화의 다음 write는 승인 없이, 범위 session으로 기록
    f.push(fixture::tool_calls(&[("w3", "write", json!({ "path": "c.txt", "content": "C" }))]));
    f.push(fixture::text("ok"));
    let v = start_turn(&s, &sid, &prof, "3", true).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(t["tool_calls"][0]["needs_approval"], false);
    assert_eq!(t["tool_calls"][0]["approval_scope"], "session");
    assert!(std::path::Path::new(&format!("{root}/c.txt")).exists());

    // 4) 다른 대화에는 넘어가지 않는다
    let sid2 = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    f.push(fixture::tool_calls(&[("w4", "write", json!({ "path": "d.txt", "content": "D" }))]));
    let v = start_turn(&s, &sid2, &prof, "4", true).await;
    let tid2 = v["turn"]["id"].as_str().unwrap().to_string();
    assert_eq!(s.wait_status(&tid2, "awaiting_approval").await["tool_calls"][0]["status"], "pending_approval");
    s.post(&format!("/api/v1/turns/{tid2}/cancel"), json!({})).await;

    // 5) 명시적 금지는 대화 범위 허용보다 우선
    let (st, _) = s.send(Method::PUT, &format!("/api/v1/settings/session/{sid}/tools.deny"), json!({ "expected_revision": 0, "value": "write" })).await;
    assert_eq!(st, StatusCode::OK);
    f.push(fixture::tool_calls(&[("w5", "write", json!({ "path": "e.txt", "content": "E" }))]));
    f.push(fixture::text("ok"));
    let v = start_turn(&s, &sid, &prof, "5", true).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(t["tool_calls"][0]["result"]["error"]["code"], "policy_denied");
    let (st, _) = s.send(Method::PUT, &format!("/api/v1/settings/session/{sid}/tools.deny"), json!({ "expected_revision": 1, "value": null })).await;
    assert_eq!(st, StatusCode::OK);

    // 6) 해제하면 다시 묻는다(멱등)
    let (st, r) = s.send(Method::DELETE, &format!("/api/v1/sessions/{sid}/tool-grants/write"), Value::Null).await;
    assert_eq!((st, r["revoked"].clone()), (StatusCode::OK, json!(true)));
    let (_, r) = s.send(Method::DELETE, &format!("/api/v1/sessions/{sid}/tool-grants/write"), Value::Null).await;
    assert_eq!(r["revoked"], false);
    f.push(fixture::tool_calls(&[("w6", "write", json!({ "path": "f.txt", "content": "F" }))]));
    let v = start_turn(&s, &sid, &prof, "6", true).await;
    let c = s.wait_status(v["turn"]["id"].as_str().unwrap(), "awaiting_approval").await["tool_calls"][0].clone();
    assert_eq!(c["status"], "pending_approval");
    assert!(c["approval_scope"].is_null());
}

#[tokio::test]
async fn policy_change_while_pending_blocks_approval() {
    let (s, f, prof, sid, root) = setup().await;
    let (_, sess) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    let pid = sess["project_id"].as_str().or(sess["session"]["project_id"].as_str()).unwrap().to_string();
    f.push(fixture::tool_calls(&[("w1", "write", json!({ "path": "late.txt", "content": "X" }))]));
    f.push(fixture::text("ok"));
    let v = start_turn(&s, &sid, &prof, "w", true).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    let t = s.wait_status(&tid, "awaiting_approval").await;
    let call = t["tool_calls"][0].clone();
    // 대기 중에 쓰기 도구를 금지
    let (st, _) = s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/tools.deny"), json!({ "expected_revision": 0, "value": "write" })).await;
    assert_eq!(st, StatusCode::OK);
    let (st, r) = s
        .post(&format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": call["revision"] }))
        .await;
    assert_eq!(st, StatusCode::CONFLICT, "{r}");
    assert_eq!(r["error"]["code"], "policy_denied");
    let t = s.wait_status(&tid, "completed").await;
    assert_eq!(t["tool_calls"][0]["status"], "failed");
    assert!(!std::path::Path::new(&format!("{root}/late.txt")).exists(), "승인했어도 실행되지 않는다");
}

#[tokio::test]
async fn denied_write_keeps_file_absent_and_model_sees_denial() {
    let (s, f, prof, sid, root) = setup().await;
    f.push(fixture::tool_calls(&[("w1", "write", json!({ "path": "out.txt", "content": "hello" }))]));
    f.push(fixture::text("거부됨 확인"));
    let v = start_turn(&s, &sid, &prof, "파일 만들어", true).await;
    let tid = v["turn"]["id"].as_str().unwrap();
    let t = s.wait_status(tid, "awaiting_approval").await;
    let call = &t["tool_calls"][0];
    assert_eq!(call["status"], "pending_approval");
    assert_eq!(call["target"]["path"], "out.txt");
    assert_eq!(call["target"]["preview"], "hello");
    // FLOW-03: 거부 → 재접속/재시도해도 실행 안 됨
    let body = json!({ "decision": "deny", "expected_revision": call["revision"] });
    let r = s.raw(Method::POST, &format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()), Some(body.clone()), Some("deny-1"), None).await;
    assert_eq!(r.status(), StatusCode::OK);
    let r = s.raw(Method::POST, &format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()), Some(body), Some("deny-1"), None).await;
    assert_eq!(r.status(), StatusCode::OK, "같은 키 재전송은 같은 결과");
    // 다른 키로 승인 시도 → 이미 처리됨
    let (st, v) = s
        .post(&format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": call["revision"] }))
        .await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["code"], "already_decided");
    s.wait_status(tid, "completed").await;
    assert!(!std::path::Path::new(&format!("{root}/out.txt")).exists());
    let reqs = f.requests();
    let tool_msg = reqs[1]["messages"].as_array().unwrap().iter().find(|m| m["role"] == "tool").unwrap().clone();
    assert!(tool_msg["content"].as_str().unwrap().contains("denied"));
}

#[tokio::test]
async fn approved_edit_applies_once_and_conflicts_if_file_changed() {
    let (s, f, prof, sid, root) = setup().await;
    let path = format!("{root}/a.txt");
    std::fs::write(&path, "one\ntwo\n").unwrap();
    f.push(fixture::tool_calls(&[("e1", "edit", json!({ "path": "a.txt", "old_string": "two", "new_string": "TWO" }))]));
    f.push(fixture::text("done"));
    let v = start_turn(&s, &sid, &prof, "고쳐", true).await;
    let tid = v["turn"]["id"].as_str().unwrap();
    let t = s.wait_status(tid, "awaiting_approval").await;
    let call = &t["tool_calls"][0];
    assert!(call["target"]["diff"].as_str().unwrap().contains("+TWO"));
    let (st, _) = s.post(&format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": call["revision"] })).await;
    assert_eq!(st, StatusCode::OK);
    s.wait_status(tid, "completed").await;
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "one\nTWO\n");

    // 승인 전에 파일이 바뀌면 편집하지 않는다(동시 편집 충돌)
    f.push(fixture::tool_calls(&[("e2", "edit", json!({ "path": "a.txt", "old_string": "one", "new_string": "ONE" }))]));
    f.push(fixture::text("ok"));
    let v = start_turn(&s, &sid, &prof, "또 고쳐", true).await;
    let tid = v["turn"]["id"].as_str().unwrap();
    let t = s.wait_status(tid, "awaiting_approval").await;
    std::fs::write(&path, "one\nTWO\nuser edit\n").unwrap();
    let before = file_sha(std::path::Path::new(&path));
    let call = &t["tool_calls"][0];
    s.post(&format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": call["revision"] })).await;
    let t = s.wait_status(tid, "completed").await;
    assert_eq!(t["tool_calls"][0]["status"], "failed");
    assert_eq!(t["tool_calls"][0]["result"]["error"]["code"], "conflict");
    assert_eq!(file_sha(std::path::Path::new(&path)), before);
}

#[tokio::test]
async fn approval_survives_restart_and_resumes() {
    let (mut s, f, prof, sid, root) = setup().await;
    f.push(fixture::tool_calls(&[("w1", "write", json!({ "path": "new.txt", "content": "x" }))]));
    let v = start_turn(&s, &sid, &prof, "만들어", true).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    let t = s.wait_status(&tid, "awaiting_approval").await;
    let call = t["tool_calls"][0].clone();
    s.restart().await;
    // FLOW-07: 재시작 후에도 승인 대기 유지
    let (_, t) = s.get(&format!("/api/v1/turns/{tid}")).await;
    assert_eq!(t["status"], "awaiting_approval");
    assert_eq!(t["tool_calls"][0]["status"], "pending_approval");
    f.push(fixture::text("만들었어"));
    s.post(&format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": call["revision"] })).await;
    s.wait_status(&tid, "completed").await;
    assert_eq!(std::fs::read_to_string(format!("{root}/new.txt")).unwrap(), "x");
}

#[tokio::test]
async fn running_turn_interrupted_by_restart_is_not_rerun() {
    let (mut s, f, prof, sid, _) = setup().await;
    f.push(fixture::hang_after("..."));
    let v = start_turn(&s, &sid, &prof, "x", false).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    s.wait_status(&tid, "running").await;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while f.requests().is_empty() {
        assert!(std::time::Instant::now() < deadline, "모델 요청이 도착하지 않음");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    // 프로세스 강제 종료를 흉내: 실행 루프를 남긴 채 DB만 재시작 경로로 연다
    let app = s.server.as_ref().unwrap().app.clone();
    app.cancels.cancel_all();
    s.restart().await;
    let (_, t) = s.get(&format!("/api/v1/turns/{tid}")).await;
    assert!(t["status"] == "interrupted" || t["status"] == "cancelled", "{t}");
    assert!(["server_restart", "server_shutdown", "cancelled"].contains(&t["error"]["code"].as_str().unwrap()), "{t}");
    assert!(t["error"]["at"].is_string());
    let (_, msgs) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let notes: Vec<_> = msgs["items"].as_array().unwrap().iter().filter(|m| m["content"]["type"] == "turn_ended").collect();
    assert_eq!(notes.len(), 1, "복구를 거쳐도 종료 원인은 한 번만 남는다");
    assert_eq!(notes[0]["content"]["error"], t["error"]);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(f.requests().len(), 1, "재시작 후 모델을 다시 부르지 않는다");
}

// RUN-024: 중단 시점의 미완료 범위(단계·도구 상태·계속 실행 중인 작업)를 기록하고 모델 입력에는 넣지 않는다.
#[tokio::test]
async fn end_scope_records_progress_and_running_tasks() {
    let (s, f, prof, sid, _) = setup().await;
    f.push(fixture::tool_calls(&[("b1", "shell", json!({ "command": "sleep 30", "hold_ms": 100 }))]));
    f.push(fixture::hang_after("두 번째 응답 중"));
    let v = start_turn(&s, &sid, &prof, "작업", true).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    let t = s.wait_status(&tid, "awaiting_approval").await;
    let c = &t["tool_calls"][0];
    s.post(&format!("/api/v1/tool-calls/{}/decision", c["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": c["revision"] })).await;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while f.requests().len() < 2 {
        assert!(std::time::Instant::now() < deadline, "두 번째 모델 요청이 오지 않음");
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    let t = s.wait_turn(&tid, |t| t["status"] == "cancelled").await;
    let scope = &t["error"]["scope"];
    assert_eq!(scope["steps"], 1, "{t}");
    assert_eq!(scope["tool_calls"], json!({ "succeeded": 1 }), "{t}");
    let tasks = scope["running_tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "{t}");
    assert_eq!(tasks[0]["command"], "sleep 30");
    let (_, msgs) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let note = msgs["items"].as_array().unwrap().iter().find(|m| m["content"]["type"] == "turn_ended").unwrap().clone();
    assert_eq!(note["content"]["error"], t["error"], "기록과 턴의 원인은 같다");
    // 다음 요청의 모델 입력에 범위가 섞이지 않는다
    f.push(fixture::text("ok"));
    let v = start_turn(&s, &sid, &prof, "다음", false).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let last = f.requests().last().unwrap()["messages"].to_string();
    assert!(last.contains("previous request ended") && !last.contains("running_tasks"), "{last}");
    s.post(&format!("/api/v1/tasks/{}/cancel", tasks[0]["id"].as_str().unwrap()), json!({})).await;
}

// RUN-023: stream 중 실제 진행 시각을 DB에 남기고, 강제 종료 뒤 복구에서도 그 시각을 중단 원인에 쓴다.
#[tokio::test]
async fn stream_progress_time_survives_forced_stop() {
    let (mut s, f, prof, sid, _) = setup().await;
    f.push(fixture::hang_after("진행 중"));
    let v = start_turn(&s, &sid, &prof, "x", false).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    s.wait_status(&tid, "running").await;
    let db_path = s.data_dir().join("grove.db");
    let read = |p: &std::path::Path, tid: &str| -> (Option<String>, String) {
        let db = rusqlite::Connection::open(p).unwrap();
        db.query_row("SELECT progress_at, updated_at FROM turns WHERE id = ?1", [tid], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let progress = loop {
        if let (Some(p), _) = read(&db_path, &tid) {
            break p;
        }
        assert!(std::time::Instant::now() < deadline, "stream 중 진행 시각이 기록되지 않음");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    };
    s.stop().await;
    // 강제 종료 흉내: 기록상 실행 중으로 남은 턴. 단계 갱신 시각은 진행 시각보다 이르다.
    let db = rusqlite::Connection::open(&db_path).unwrap();
    db.execute(
        "UPDATE turns SET status = 'running', error = NULL, owner_epoch = 'dead-epoch', updated_at = '2000-01-01T00:00:00Z' WHERE id = ?1",
        [&tid],
    )
    .unwrap();
    db.execute("DELETE FROM messages WHERE turn_id = ?1 AND role = 'note'", [&tid]).unwrap();
    drop(db);
    s.restart().await;
    let (_, t) = s.get(&format!("/api/v1/turns/{tid}")).await;
    assert_eq!(t["status"], "interrupted", "{t}");
    assert_eq!(t["error"]["last_progress_at"], progress, "단계 갱신 시각이 아니라 stream 진행 시각: {t}");
}

// REC-003·005·006·012: 확정 전 응답은 실행 중에 중단 증거로 남고, 강제 종료 뒤 복구·반복 재시작에서도 원본 그대로 보존된다.
// 확정 답변으로 바꾸거나 모델을 다시 부르지 않으며, 확인(포기)은 목록에서만 내리고 증거는 지우지 않는다.
#[tokio::test]
async fn interrupted_stream_evidence_survives_forced_stop_and_is_listed() {
    let (mut s, f, prof, sid, _) = setup().await;
    f.push(fixture::hang_after("부분 응답"));
    let v = start_turn(&s, &sid, &prof, "x", false).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    s.wait_status(&tid, "running").await;
    let db_path = s.data_dir().join("grove.db");
    let raw = |p: &std::path::Path, tid: &str| -> Option<String> {
        let db = rusqlite::Connection::open(p).unwrap();
        db.query_row("SELECT evidence FROM turns WHERE id = ?1", [tid], |r| r.get(0)).unwrap()
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let written = loop {
        if let Some(e) = raw(&db_path, &tid) {
            break e;
        }
        assert!(std::time::Instant::now() < deadline, "stream 중 중단 증거가 기록되지 않음");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    };
    s.stop().await;
    // 강제 종료 흉내: 종료 정리 전 상태(실행 중, 죽은 epoch)와 실행 중에 기록된 증거만 남긴다.
    let db = rusqlite::Connection::open(&db_path).unwrap();
    db.execute(
        "UPDATE turns SET status = 'running', error = NULL, finished_at = NULL, owner_epoch = 'dead-epoch', evidence = ?2 WHERE id = ?1",
        rusqlite::params![tid, written],
    )
    .unwrap();
    db.execute("DELETE FROM messages WHERE turn_id = ?1 AND role = 'note'", [&tid]).unwrap();
    drop(db);
    s.restart().await;
    let (_, t) = s.get(&format!("/api/v1/turns/{tid}")).await;
    assert_eq!(t["status"], "interrupted", "{t}");
    assert_eq!(t["evidence"]["text"], "부분 응답", "{t}");
    assert_eq!(t["evidence"]["step"], 0);
    assert_eq!(t["evidence"]["truncated"], false);
    assert!(t["evidence"]["sha256"].is_string() && t["evidence"].get("reasoning").is_none(), "{t}");
    let (_, msgs) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert!(!msgs["items"].as_array().unwrap().iter().any(|m| m["role"] == "assistant"), "중단 증거를 확정 답변으로 바꾸지 않는다");
    let (st, page) = s.get("/api/v1/recovery").await;
    assert_eq!(st, StatusCode::OK, "{page}");
    let item = page["items"].as_array().unwrap().iter().find(|i| i["id"] == tid.as_str()).cloned().expect("미복구 목록에 중단 턴");
    assert_eq!(item["kind"], "turn");
    assert_eq!(item["session_id"], sid.as_str());
    assert_eq!(item["evidence"]["text_chars"], 5);
    assert!(item["evidence"].get("text").is_none(), "목록에는 원문을 싣지 않는다: {item}");
    // 반복 재시작에도 원본 bytes가 그대로이고 모델을 다시 부르지 않는다.
    s.restart().await;
    assert_eq!(raw(&db_path, &tid).as_deref(), Some(written.as_str()));
    assert_eq!(f.requests().len(), 1, "재시작 후 모델을 다시 부르지 않는다");
    let (st, _) = s.post(&format!("/api/v1/turns/{tid}/acknowledge"), json!({})).await;
    assert_eq!(st, StatusCode::OK);
    let (_, page) = s.get("/api/v1/recovery").await;
    assert!(!page["items"].as_array().unwrap().iter().any(|i| i["id"] == tid.as_str()), "확인한 턴은 목록에서 내린다");
    assert_eq!(raw(&db_path, &tid).as_deref(), Some(written.as_str()), "확인은 증거를 지우지 않는다");
    // REC-013: snapshot을 새 디렉터리에 복원해도 증거·확인 기록이 남고 모델을 다시 부르지 않는다.
    let backup = tempfile::tempdir().unwrap();
    let snap = backup.path().join("snap.db");
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_grove")).arg("snapshot").arg(&snap).arg("--data-dir").arg(s.data_dir()).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    s.stop().await;
    let target = tempfile::tempdir().unwrap();
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_grove")).arg("restore").arg(&snap).arg(target.path().join("data")).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let cfg = config(&target.path().join("data"));
    let r = TestServer::start_with(target, cfg).await;
    let (_, t) = r.get(&format!("/api/v1/turns/{tid}")).await;
    assert_eq!(t["status"], "interrupted");
    assert_eq!(t["evidence"]["text"], "부분 응답");
    assert!(t["acknowledged_at"].is_string());
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(f.requests().len(), 1, "복원 뒤에도 모델을 다시 부르지 않는다");
}

// REC-006: 답변이 확정되면 같은 commit에서 중단 증거를 지운다. 사용자 취소는 증거를 남기되 목록에는 올리지 않는다.
#[tokio::test]
async fn evidence_cleared_on_commit_and_kept_on_cancel() {
    let (s, f, prof, sid, _) = setup().await;
    f.push(fixture::slow_text(&["안녕", "하세요"], 100));
    let v = start_turn(&s, &sid, &prof, "a", false).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    assert!(t["evidence"].is_null(), "{t}");
    f.push(fixture::hang_after("멈춘 응답"));
    let v = start_turn(&s, &sid, &prof, "b", false).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    s.wait_status(&tid, "running").await;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while f.requests().len() < 2 {
        assert!(std::time::Instant::now() < deadline, "모델 요청이 도착하지 않음");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    let t = s.wait_status(&tid, "cancelled").await;
    assert_eq!(t["evidence"]["text"], "멈춘 응답", "{t}");
    let (_, page) = s.get("/api/v1/recovery").await;
    assert!(page["items"].as_array().unwrap().is_empty(), "사용자 취소는 미복구 목록에 올리지 않는다: {page}");
}

// REC-007·009: 손상된 증거는 원본 bytes를 바꾸지 않고 분류·hash만 알리며, 새 턴이 덮어쓰지 않는다. 목록은 keyset cursor로 나눈다.
#[tokio::test]
async fn corrupt_evidence_is_reported_and_preserved() {
    let (mut s, f, prof, sid, _) = setup().await;
    let mut ids = vec![];
    for i in 0..3 {
        f.push(fixture::text("ok"));
        let v = start_turn(&s, &sid, &prof, &format!("q{i}"), false).await;
        let tid = v["turn"]["id"].as_str().unwrap().to_string();
        s.wait_status(&tid, "completed").await;
        ids.push(tid);
    }
    s.stop().await;
    let db_path = s.data_dir().join("grove.db");
    let good = r#"{"v":1,"sha256":"00","body":"{\"text\":\"변조\"}"}"#;
    let db = rusqlite::Connection::open(&db_path).unwrap();
    for (i, (tid, ev)) in ids.iter().zip(["not json", good, r#"{"v":2}"#]).enumerate() {
        db.execute(
            "UPDATE turns SET status = 'interrupted', evidence = ?2, finished_at = ?3, acknowledged_at = NULL WHERE id = ?1",
            rusqlite::params![tid, ev, format!("2030-01-01T00:00:0{i}Z")],
        )
        .unwrap();
    }
    drop(db);
    s.restart().await;
    let (_, t) = s.get(&format!("/api/v1/turns/{}", ids[0])).await;
    assert_eq!(t["evidence"]["corrupt"], true);
    assert_eq!(t["evidence"]["kind"], "parse");
    assert_eq!(t["evidence"]["raw_bytes"], 8);
    assert_eq!(t["evidence"]["raw_sha256"], grove::util::sha256_hex(b"not json"));
    let (_, t) = s.get(&format!("/api/v1/turns/{}", ids[1])).await;
    assert_eq!(t["evidence"]["kind"], "hash_mismatch", "{t}");
    assert!(t["evidence"].get("text").is_none());
    let (_, t) = s.get(&format!("/api/v1/turns/{}", ids[2])).await;
    assert_eq!(t["evidence"]["kind"], "unsupported_version");
    // 최신순 2개씩: 다음 cursor로 나머지 1개
    let (_, p1) = s.get("/api/v1/recovery?limit=2").await;
    let got: Vec<_> = p1["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(got, vec![ids[2].clone(), ids[1].clone()]);
    assert_eq!(p1["items"][1]["evidence"], json!({ "corrupt": true, "kind": "hash_mismatch" }));
    let cursor = p1["next_cursor"].as_str().unwrap().to_string();
    let (_, p2) = s.get(&format!("/api/v1/recovery?limit=2&cursor={}", urlencoding(&cursor))).await;
    assert_eq!(p2["items"].as_array().unwrap().len(), 1);
    assert_eq!(p2["items"][0]["id"], ids[0].as_str());
    assert!(p2["next_cursor"].is_null());
    let (st, _) = s.get("/api/v1/recovery?cursor=bad").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    // 같은 세션의 새 턴은 진행되지만 이전 턴의 손상 원본은 그대로다.
    f.push(fixture::text("새 답"));
    let v = start_turn(&s, &sid, &prof, "새 요청", false).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let db = rusqlite::Connection::open(&db_path).unwrap();
    let kept: String = db.query_row("SELECT evidence FROM turns WHERE id = ?1", [&ids[0]], |r| r.get(0)).unwrap();
    assert_eq!(kept, "not json");
}

fn urlencoding(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

// PROJECT-006: 셸 호출의 `cwd` 인자와 명령 안의 `cd`는 그 호출에만 적용되고, 대화의 실행 위치(프로젝트 root)는 바뀌지 않는다.
#[tokio::test]
async fn shell_cwd_is_per_call_and_does_not_move_session_root() {
    let (s, f, prof, sid, root) = setup().await;
    std::fs::create_dir_all(format!("{root}/sub")).unwrap();
    let (st, v) = s.send(Method::PUT, "/api/v1/settings/server/-/tools.allow", json!({ "expected_revision": 0, "value": "shell" })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    f.push(fixture::tool_calls(&[("s1", "shell", json!({ "command": "pwd; cd /; pwd", "cwd": "sub" }))]));
    f.push(fixture::tool_calls(&[("s2", "shell", json!({ "command": "pwd" }))]));
    f.push(fixture::text("확인"));
    let v = start_turn(&s, &sid, &prof, "위치 확인", true).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let canon = std::fs::canonicalize(&root).unwrap();
    let first = t["tool_calls"][0]["result"]["stdout"].as_str().unwrap().to_string();
    let lines: Vec<&str> = first.lines().collect();
    assert_eq!(lines, vec![canon.join("sub").to_str().unwrap(), "/"], "{t}");
    assert_eq!(t["tool_calls"][0]["result"]["cwd"], "sub");
    let second = t["tool_calls"][1]["result"]["stdout"].as_str().unwrap().trim().to_string();
    assert_eq!(second, canon.to_str().unwrap(), "다음 호출은 다시 프로젝트 root에서 시작");
    let (_, sess) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    assert!(sess["worktree_id"].is_null(), "대화 실행 위치는 그대로");
}

// RUN-023: provider timeout은 사용자 중지와 구별되고, 원인·시간·설정이 다음 모델 요청까지 유지된다.
#[tokio::test]
async fn provider_timeout_cause_survives_into_next_request() {
    let (s, f, prof, sid, _) = setup().await;
    let (_, profiles) = s.get("/api/v1/model-profiles").await;
    let p = profiles.as_array().unwrap().iter().find(|p| p["id"] == prof).unwrap();
    let (st, v) = s
        .send(Method::PUT, &format!("/api/v1/model-profiles/{prof}"), json!({ "expected_revision": p["revision"], "options": { "timeout_secs": 5 } }))
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    f.push(fixture::hang_after("응답 시작"));
    let v = start_turn(&s, &sid, &prof, "기다려", false).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "failed").await;
    assert_eq!(t["error"]["code"], "idle_timeout", "{t}");
    assert_eq!(t["error"]["settings"]["provider_timeout_secs"], 5);
    let at = time::OffsetDateTime::parse(t["error"]["at"].as_str().unwrap(), &time::format_description::well_known::Rfc3339).unwrap();
    let last = time::OffsetDateTime::parse(t["error"]["last_progress_at"].as_str().unwrap(), &time::format_description::well_known::Rfc3339).unwrap();
    assert!(at >= last);
    assert_eq!(f.requests().len(), 1, "응답이 시작된 뒤 timeout이면 재시도하지 않는다");

    f.push(fixture::text("이어서 답함"));
    let v = start_turn(&s, &sid, &prof, "이어서", false).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let wire = f.requests()[1].to_string();
    assert!(wire.contains("idle_timeout") && wire.contains("provider_timeout_secs") && wire.contains("last_progress_at"), "{wire}");
    assert!(!wire.contains("user_stop"), "자동 중단을 사용자 취소로 바꾸지 않는다");
}

/// FLOW-06: 부작용 실행 중 crash → unknown, 자동 재실행 없음, 검토 전 새 턴 차단.
#[tokio::test]
async fn crash_during_tool_marks_unknown_and_requires_review() {
    let (mut s, f, prof, sid, root) = setup().await;
    let path = format!("{root}/b.txt");
    std::fs::write(&path, "v1\n").unwrap();
    let (st, call) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"), json!({ "name": "edit", "args": { "path": "b.txt", "old_string": "v1", "new_string": "v2" } })).await;
    assert_eq!(st, StatusCode::CREATED, "{call}");
    assert_eq!(call["status"], "pending_approval");
    // 실행 시작 receipt만 기록된 상태(=부작용 도중 crash)를 만든다
    let id = call["id"].as_str().unwrap().to_string();
    let app = s.server.as_ref().unwrap().app.clone();
    let id2 = id.clone();
    app.db.call(move |c| Ok(c.execute("UPDATE tool_calls SET status = 'running' WHERE id = ?1", [id2])?)).await.unwrap();
    std::fs::write(&path, "v2\n").unwrap(); // 실제로는 적용됐을 수도 있다
    s.restart().await;
    let (_, c) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
    assert_eq!(c["status"], "unknown");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "v2\n", "자동 재실행 없음");
    let (_, sess) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    assert_eq!(sess["unreviewed_unknown"], 1);
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "x", "profile_id": prof })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["code"], "unknown_pending_review");
    // 보관도 막힌다
    let (st, _) = s.send(Method::PATCH, &format!("/api/v1/sessions/{sid}"), json!({ "expected_revision": sess["revision"], "archived": true })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    // 관찰 → 상태 변경 → 오래된 fingerprint 거절 → 다시 관찰 → 검토
    let (_, obs) = s.get(&format!("/api/v1/tool-calls/{id}/observe")).await;
    assert_eq!(obs["observation"]["state"], "matches_expected_result");
    std::fs::write(&path, "v3\n").unwrap();
    let (st, v) = s.post(&format!("/api/v1/tool-calls/{id}/review"), json!({ "expected_revision": obs["revision"], "fingerprint": obs["fingerprint"], "outcome": "applied" })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["code"], "observation_stale");
    let (_, obs) = s.get(&format!("/api/v1/tool-calls/{id}/observe")).await;
    assert_eq!(obs["observation"]["state"], "different");
    let (st, v) = s.post(&format!("/api/v1/tool-calls/{id}/review"), json!({ "expected_revision": obs["revision"], "fingerprint": obs["fingerprint"], "outcome": "partial", "note": "사용자 수정" })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "unknown", "검토는 성공으로 바꾸지 않는다");
    assert_eq!(v["review"]["outcome"], "partial");
    f.push(fixture::text("ok"));
    let v = start_turn(&s, &sid, &prof, "이제 가능", false).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
}

/// RUN-017: 재시작 시 읽기 전용 도구는 failed(부작용 없음), 변경 도구는 unknown.
#[tokio::test]
async fn restart_distinguishes_read_only_from_mutating_calls() {
    let (mut s, _f, _prof, sid, root) = setup().await;
    std::fs::write(format!("{root}/r.txt"), "x").unwrap();
    let (_, w) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"), json!({ "name": "write", "args": { "path": "n.txt", "content": "1" } })).await;
    let app = s.server.as_ref().unwrap().app.clone();
    // 읽기 호출을 만들고 둘 다 running 상태로 고정(실행 도중 crash 흉내)
    let (_, r) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"), json!({ "name": "read", "args": { "path": "r.txt" } })).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let (wid, rid) = (w["id"].as_str().unwrap().to_string(), r["id"].as_str().unwrap().to_string());
    let ids = (wid.clone(), rid.clone());
    app.db.call(move |c| Ok(c.execute("UPDATE tool_calls SET status = 'running' WHERE id IN (?1, ?2)", [ids.0, ids.1])?)).await.unwrap();
    s.restart().await;
    let (_, w) = s.get(&format!("/api/v1/tool-calls/{wid}")).await;
    let (_, r) = s.get(&format!("/api/v1/tool-calls/{rid}")).await;
    assert_eq!(w["status"], "unknown");
    assert_eq!(r["status"], "failed");
    assert_eq!(r["result"]["error"]["code"], "server_restart");
}

/// SEC-010: 턴 취소 시 미결 승인은 실행되지 않고 정리된다.
#[tokio::test]
async fn cancelling_turn_cancels_pending_approvals() {
    let (s, f, prof, sid, root) = setup().await;
    f.push(fixture::tool_calls(&[("w1", "write", json!({ "path": "never.txt", "content": "x" }))]));
    let v = start_turn(&s, &sid, &prof, "만들어", true).await;
    let tid = v["turn"]["id"].as_str().unwrap();
    let t = s.wait_status(tid, "awaiting_approval").await;
    let call = t["tool_calls"][0].clone();
    let (st, _) = s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    assert_eq!(st, StatusCode::ACCEPTED);
    let t = s.wait_status(tid, "cancelled").await;
    assert_eq!(t["tool_calls"][0]["status"], "cancelled");
    // 늦게 도착한 승인은 거절되고 파일은 생기지 않는다
    let (st, _) = s.post(&format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": call["revision"] })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(!std::path::Path::new(&format!("{root}/never.txt")).exists());
    assert_eq!(f.requests().len(), 1, "취소 후 모델을 다시 부르지 않는다");
}

#[tokio::test]
async fn cancelling_turn_emits_pending_call_events_in_status_and_insertion_order() {
    let (s, f, prof, sid, _) = setup().await;
    f.push(fixture::tool_calls(&[
        ("w1", "write", json!({ "path": "first.txt", "content": "x" })),
        ("q1", "ask_user", json!({ "question": "계속할까요?" })),
        ("w2", "write", json!({ "path": "second.txt", "content": "x" })),
    ]));
    let v = start_turn(&s, &sid, &prof, "계속", true).await;
    let tid = v["turn"]["id"].as_str().unwrap();
    s.wait_status(tid, "awaiting_approval").await;
    let db = &s.server.as_ref().unwrap().app.db;
    let db_tid = tid.to_owned();
    let (cursor, expected) = db.call(move |c| {
        let mut st = c.prepare("SELECT id, status FROM tool_calls WHERE turn_id=?1 ORDER BY rowid")?;
        let calls = st.query_map([db_tid], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.collect::<Result<Vec<_>, _>>()?;
        assert_eq!(calls.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), ["pending_approval", "awaiting_input", "pending_approval"]);
        Ok((grove::events::latest_seq(c)?, [calls[1].0.clone(), calls[0].0.clone(), calls[2].0.clone()]))
    }).await.unwrap();
    let (st, _) = s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    assert_eq!(st, StatusCode::ACCEPTED);
    let actual = db.call(move |c| {
        Ok(grove::events::read_after(c, cursor, 200)?.into_iter()
            .filter(|e| e.kind == "tool_call.updated" && e.payload["status"] == "cancelled")
            .map(|e| e.payload["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>())
    }).await.unwrap();
    assert_eq!(actual, expected);
}

// RUN-010: 턴 중지는 실행 중인 도구 프로세스까지 멈춘다(모델 호출 취소·자식 에이전트는 다른 시험).
#[tokio::test]
async fn cancelling_turn_stops_running_tool_process() {
    let (s, f, prof, sid, root) = setup().await;
    let marker = format!("{root}/after-cancel.txt");
    f.push(fixture::tool_calls(&[("sh1", "shell", json!({ "command": format!("sleep 1; touch {marker}") }))]));
    let v = start_turn(&s, &sid, &prof, "오래 걸리는 명령 실행", true).await;
    let tid = v["turn"]["id"].as_str().unwrap();
    let t = s.wait_status(tid, "awaiting_approval").await;
    let call = t["tool_calls"][0].clone();
    let (st, _) = s.post(&format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": call["revision"] })).await;
    assert_eq!(st, StatusCode::OK);
    s.wait_turn(tid, |t| t["tool_calls"][0]["status"] == "running").await;
    let (st, _) = s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    assert_eq!(st, StatusCode::ACCEPTED);
    let t = s.wait_turn(tid, |t| t["status"] == "cancelled" && t["tool_calls"][0]["status"] != "running").await;
    assert_eq!(t["tool_calls"][0]["status"], "cancelled", "{t}");
    // 프로세스가 죽었으므로 1초 뒤에도 파일이 생기지 않는다
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    assert!(!std::path::Path::new(&marker).exists(), "취소 뒤에도 명령이 계속 실행됨");
    assert_eq!(f.requests().len(), 1, "취소 후 모델을 다시 부르지 않는다");
}

#[tokio::test]
async fn fork_shows_history_and_inherits_context_only_when_chosen() {
    let (s, f, prof, sid, _) = setup().await;
    f.push(fixture::text("첫 답"));
    let v = start_turn(&s, &sid, &prof, "첫 질문", false).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let (_, sess) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    let (st, with_ctx) = s.post(&format!("/api/v1/sessions/{sid}/fork"), json!({ "from_seq": sess["last_message_seq"], "inherit_context": true })).await;
    assert_eq!(st, StatusCode::CREATED, "{with_ctx}");
    assert_eq!(with_ctx["parent_session_id"], sid.as_str());
    assert_eq!(with_ctx["fork_inherits_context"], true);
    let (_, without) = s.post(&format!("/api/v1/sessions/{sid}/fork"), json!({ "from_seq": sess["last_message_seq"], "inherit_context": false })).await;
    let (st, _) = s.post(&format!("/api/v1/sessions/{sid}/fork"), json!({ "from_seq": 99, "inherit_context": false })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    f.push(fixture::text("a"));
    f.push(fixture::text("b"));
    let v = start_turn(&s, with_ctx["id"].as_str().unwrap(), &prof, "이어서", false).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let v = start_turn(&s, without["id"].as_str().unwrap(), &prof, "새로", false).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let reqs = f.requests();
    let users = |r: &Value| r["messages"].as_array().unwrap().iter().filter(|m| m["role"] == "user").count();
    assert_eq!(users(&reqs[1]), 2, "컨텍스트 계승: 원본 질문 + 새 질문");
    assert_eq!(users(&reqs[2]), 1, "계승 안 함: 새 질문만");
}

#[tokio::test]
async fn user_tool_requests_and_boundaries() {
    let (s, _f, _prof, sid, root) = setup().await;
    std::fs::write(format!("{root}/r.txt"), "abc").unwrap();
    let (_, c) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"), json!({ "name": "read", "args": { "path": "r.txt" } })).await;
    let id = c["id"].as_str().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let done = loop {
        let (_, c) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
        if c["status"] == "succeeded" || std::time::Instant::now() > deadline {
            break c;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    assert_eq!(done["result"]["content"], "abc\n");
    let (_, c) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"), json!({ "name": "read", "args": { "path": "../../etc/passwd" } })).await;
    assert_eq!(c["status"], "failed");
    assert_eq!(c["result"]["error"]["code"], "outside_project");
    let (_, c) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"), json!({ "name": "nope", "args": {} })).await;
    assert_eq!(c["result"]["error"]["code"], "unsupported_tool");
    let (_, c) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"), json!({ "name": "read", "args": { "path": 3 } })).await;
    assert_eq!(c["result"]["error"]["code"], "invalid_arguments");
    // 실행 중 셸 취소
    let (_, c) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"), json!({ "name": "shell", "args": { "command": "sleep 30" } })).await;
    let id = c["id"].as_str().unwrap();
    s.post(&format!("/api/v1/tool-calls/{id}/decision"), json!({ "decision": "approve", "expected_revision": c["revision"] })).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let (st, _) = s.post(&format!("/api/v1/tool-calls/{id}/cancel"), json!({})).await;
    assert_eq!(st, StatusCode::OK);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let (_, c) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
        if c["status"] == "cancelled" {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "{c}");
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
}

#[tokio::test]
async fn approval_expires() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(&dir.path().join("data"));
    cfg.approval_ttl_secs = 1;
    let s = TestServer::start_with_restricted_permissions(dir, cfg).await;
    let p = s.create_project("p").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (_, c) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"), json!({ "name": "write", "args": { "path": "x", "content": "y" } })).await;
    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
    let (_, now) = s.get(&format!("/api/v1/tool-calls/{}", c["id"].as_str().unwrap())).await;
    assert_eq!(now["status"], "expired");
    let (st, _) = s.post(&format!("/api/v1/tool-calls/{}/decision", c["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": now["revision"] })).await;
    assert_eq!(st, StatusCode::CONFLICT);
}

#[tokio::test]
async fn profile_validation() {
    let s = TestServer::start().await;
    for bad in [
        json!({ "name": "x", "protocol": "foo", "base_url": "http://a.b", "model": "m" }),
        json!({ "name": "x", "protocol": "openai", "base_url": "ftp://a.b", "model": "m" }),
        json!({ "name": "x", "protocol": "openai", "base_url": "http://a.b", "model": "m m" }),
        json!({ "name": "x", "protocol": "openai", "base_url": "http://a.b", "model": "m", "options": { "headers": { "Authorization": "x" } } }),
        json!({ "name": "x", "protocol": "openai", "base_url": "http://a.b", "model": "m", "options": { "temperature": 5 } }),
    ] {
        let (st, v) = s.post("/api/v1/model-profiles", bad).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{v}");
    }
    let (st, sec) = s.post("/api/v1/secrets", json!({ "label": "k", "value": "abcdefghijkl" })).await;
    assert_eq!(st, StatusCode::CREATED);
    let (_, p) = s.post("/api/v1/model-profiles", json!({ "name": "x", "protocol": "anthropic", "base_url": "https://api.anthropic.com", "model": "claude", "secret_id": sec["id"] })).await;
    let (st, v) = s.send(Method::DELETE, &format!("/api/v1/secrets/{}", sec["id"].as_str().unwrap()), json!({})).await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"]["details"]["used_by"][0], "x");
    let (st, _) = s.send(Method::DELETE, &format!("/api/v1/model-profiles/{}", p["id"].as_str().unwrap()), json!({})).await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = s.send(Method::DELETE, &format!("/api/v1/secrets/{}", sec["id"].as_str().unwrap()), json!({})).await;
    assert_eq!(st, StatusCode::OK);
}

#[tokio::test]
async fn apply_patch_shows_per_file_diff_and_applies_once_after_approval() {
    let (s, f, prof, sid, root) = setup().await;
    std::fs::write(format!("{root}/a.txt"), "1\n2\n").unwrap();
    let patch = "*** Begin Patch\n*** Update File: a.txt\n 1\n-2\n+둘\n*** Add File: b/new.txt\n+새 파일\n*** End Patch";
    f.push(fixture::tool_calls(&[("p1", "apply_patch", json!({ "patch": patch }))]));
    f.push(fixture::text("적용했어"));
    let v = start_turn(&s, &sid, &prof, "고쳐", true).await;
    let tid = v["turn"]["id"].as_str().unwrap();
    let t = s.wait_status(tid, "awaiting_approval").await;
    let call = &t["tool_calls"][0];
    let files = call["target"]["files"].as_array().unwrap();
    assert_eq!(files.len(), 2);
    assert!(files[0]["diff"].as_str().unwrap().contains("+둘"));
    assert!(!std::path::Path::new(&format!("{root}/b/new.txt")).exists(), "승인 전에는 쓰지 않는다");
    s.post(&format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": call["revision"] })).await;
    let t = s.wait_status(tid, "completed").await;
    assert_eq!(t["tool_calls"][0]["status"], "succeeded", "{t}");
    assert_eq!(t["tool_calls"][0]["result"]["files"], 2);
    assert_eq!(std::fs::read_to_string(format!("{root}/a.txt")).unwrap(), "1\n둘\n");
    assert_eq!(std::fs::read_to_string(format!("{root}/b/new.txt")).unwrap(), "새 파일\n");
}

// UI-012: reasoning은 표시용으로 저장하고 다음 모델 입력에는 넣지 않는다.
#[tokio::test]
async fn reasoning_is_stored_for_display_but_not_sent_back() {
    let (s, f, prof, sid, _root) = setup().await;
    f.push(fixture::reasoning_text("먼저 파일 구조를 생각해 본다", "답이야"));
    f.push(fixture::text("둘째 답"));
    let v = start_turn(&s, &sid, &prof, "생각해 봐", false).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let (_, msgs) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let a = msgs["items"].as_array().unwrap().iter().find(|m| m["role"] == "assistant").unwrap().clone();
    assert_eq!(a["content"]["text"], "답이야");
    assert_eq!(a["content"]["reasoning"], "먼저 파일 구조를 생각해 본다");
    assert_eq!(a["content"]["reasoning_chars"], 16);
    let v = start_turn(&s, &sid, &prof, "다음", false).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let wire = f.requests()[1].to_string();
    assert!(wire.contains("답이야") && !wire.contains("파일 구조를 생각"), "{wire}");
}

// RUN-012: 같은 호출의 반복 실패·무한 반복을 감지해 멈추고, 마지막 호출은 실행하지 않는다.
#[tokio::test]
async fn repeated_failing_call_and_identical_loop_are_stopped() {
    let (s, f, prof, sid, root) = setup().await;
    // 없는 파일 읽기 3번 실패 → 4번째에서 멈춤
    for i in 0..4 {
        f.push(fixture::tool_calls(&[(&format!("r{i}"), "read", json!({ "path": "missing.txt" }))]));
    }
    let v = start_turn(&s, &sid, &prof, "읽어", true).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "failed").await;
    assert_eq!(t["error"]["code"], "repeated_tool_failure", "{t}");
    let calls = t["tool_calls"].as_array().unwrap();
    assert_eq!(calls.len(), 4);
    assert!(calls[..3].iter().all(|c| c["status"] == "failed"));
    assert_eq!(calls[3]["status"], "cancelled", "멈춘 뒤의 호출은 실행하지 않는다");
    assert_eq!(f.requests().len(), 4);

    // 성공하는 같은 호출 5번째 → 무한 반복으로 멈춤
    std::fs::write(format!("{root}/a.txt"), "A").unwrap();
    for i in 0..5 {
        f.push(fixture::tool_calls(&[(&format!("l{i}"), "read", json!({ "path": "a.txt" }))]));
    }
    let v = start_turn(&s, &sid, &prof, "또 읽어", true).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "failed").await;
    assert_eq!(t["error"]["code"], "loop_detected", "{t}");
    assert_eq!(t["tool_calls"].as_array().unwrap().len(), 5);

    // 인자가 바뀌면 반복이 아니다
    for i in 0..4 {
        std::fs::write(format!("{root}/f{i}.txt"), "x").unwrap();
        f.push(fixture::tool_calls(&[(&format!("d{i}"), "read", json!({ "path": format!("f{i}.txt") }))]));
    }
    f.push(fixture::text("다 읽었어"));
    let v = start_turn(&s, &sid, &prof, "각각 읽어", true).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
}

// RUN-021: 시간 예산은 사용자가 정한 경우에만 적용하고(기본 제한 없음), 원인을 기록한다.
#[tokio::test]
async fn explicit_time_budget_stops_turn_with_its_cause() {
    check_time_budget_after_approval(59_500).await;
}

#[tokio::test]
async fn expired_budget_preserves_settings_without_starting_another_model_request() {
    check_time_budget_after_approval(61_000).await;
}

async fn check_time_budget_after_approval(elapsed_ms: i64) {
    let (s, f, prof, sid, root) = setup().await;
    let (st, _) = s.send(Method::PUT, &format!("/api/v1/settings/session/{sid}/runs.budget.max_minutes"), json!({ "expected_revision": 0, "value": 1 })).await;
    assert_eq!(st, StatusCode::OK);
    f.push(fixture::tool_calls(&[("w1", "write", json!({ "path": "t.txt", "content": "T" }))]));
    f.push(fixture::hang_after("끝나지 않는"));
    let v = start_turn(&s, &sid, &prof, "써", true).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    let t = s.wait_status(&tid, "awaiting_approval").await;
    assert_eq!(t["definition"]["budget"]["max_minutes"], 1, "접수 시점 예산을 고정");
    {
        let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
        let back = grove::util::fmt_time(time::OffsetDateTime::now_utc() - time::Duration::milliseconds(elapsed_ms));
        db.execute("UPDATE turns SET created_at = ?2 WHERE id = ?1", rusqlite::params![tid, back]).unwrap();
    }
    let c = &t["tool_calls"][0];
    let started = std::time::Instant::now();
    let (st, _) = s.post(&format!("/api/v1/tool-calls/{}/decision", c["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": c["revision"] })).await;
    assert_eq!(st, StatusCode::OK);
    let t = s.wait_status(&tid, "failed").await;
    assert_eq!(t["error"]["code"], "time_budget_exceeded", "{t}");
    assert_eq!(t["error"]["budget"]["max_minutes"], 1);
    assert_eq!(t["error"]["settings"]["provider_timeout_secs"], 30);
    assert!(t["error"]["last_progress_at"].is_string());
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    assert!(std::path::Path::new(&format!("{root}/t.txt")).exists(), "예산 전 승인된 도구는 끝까지 실행");

    if elapsed_ms >= 60_000 {
        assert_eq!(f.requests().len(), 1, "승인을 기다리는 동안 예산이 끝나면 모델을 다시 호출하지 않는다");
    }

    // 예산 0(기본): 같은 대화에서 정상 완료
    let (st, _) = s.send(Method::PUT, &format!("/api/v1/settings/session/{sid}/runs.budget.max_minutes"), json!({ "expected_revision": 1, "value": 0 })).await;
    assert_eq!(st, StatusCode::OK);
    // 예산이 다음 모델 호출 직전에 끝나도 두 번째 턴은 자체 응답을 받는다.
    f.push_for("예산 없이 다시", fixture::text("완료"));
    let v = start_turn(&s, &sid, &prof, "예산 없이 다시", false).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    assert!(t["definition"]["budget"].is_null());
}

// UI-020: 추론 강도는 접수 때 고정되어 모델 요청에 들어가고, auto면 보내지 않는다.
#[tokio::test]
async fn effort_is_fixed_at_acceptance_and_sent_to_provider() {
    let (s, f, prof, sid, _) = setup().await;
    let (st, rejected) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "x", "profile_id": prof, "effort": "max" })).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{rejected}");
    assert_eq!(rejected["error"]["code"], "unsupported");
    f.push(fixture::text("낮게"));
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "낮은 강도", "profile_id": prof, "effort": "low" })).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    assert_eq!(v["turn"]["definition"]["effort"], "low");
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    f.push(fixture::text("자동"));
    let v = start_turn(&s, &sid, &prof, "자동 강도", false).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let reqs = f.requests();
    assert_eq!(reqs[0]["reasoning_effort"], "low");
    assert!(reqs[1].get("reasoning_effort").is_none(), "auto는 보내지 않는다");
    // 실행 중 대기열에 넣은 메시지도 고른 강도를 지킨다
    f.push(fixture::slow_text(&["천천히"], 300));
    f.push(fixture::text("대기열 답"));
    let v = start_turn(&s, &sid, &prof, "느린 요청", false).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "running").await;
    let (st, q) = s.post(&format!("/api/v1/sessions/{sid}/followups"), json!({ "kind": "queue", "text": "다음", "profile_id": prof, "effort": "high" })).await;
    assert_eq!(st, StatusCode::CREATED, "{q}");
    for _ in 0..100 {
        if f.requests().len() >= 4 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(f.requests()[3]["reasoning_effort"], "high");
}

// RUN-009: 실행 중 워크플로를 바꾸거나 본문을 고쳐도 진행 중인 요청은 접수 때 고정한 워크플로로 끝까지 간다.
#[tokio::test]
async fn workflow_change_during_turn_applies_from_next_turn() {
    let (s, f, prof, sid, _) = setup().await;
    let (st, v) = s.post("/api/v1/definitions/workflow", json!({ "id": "wf-a", "name": "A", "body": "WORKFLOW-A-BODY" })).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let (_, sess) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    let (st, sess) = s.send(Method::PATCH, &format!("/api/v1/sessions/{sid}"), json!({ "expected_revision": sess["revision"], "workflow_id": "wf-a" })).await;
    assert_eq!(st, StatusCode::OK, "{sess}");
    f.push(fixture::tool_calls(&[("w1", "write", json!({ "path": "a.txt", "content": "A" }))]));
    f.push(fixture::text("끝"));
    let v = start_turn(&s, &sid, &prof, "써", true).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    let t = s.wait_status(&tid, "awaiting_approval").await;
    // 대기 중 변경: 본문 수정 + 대화 워크플로를 기본으로
    let (st, _) = s.send(Method::PUT, "/api/v1/definitions/workflow/wf-a", json!({ "expected_revision": 1, "body": "WORKFLOW-A-CHANGED" })).await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = s.send(Method::PATCH, &format!("/api/v1/sessions/{sid}"), json!({ "expected_revision": sess["revision"], "workflow_id": null })).await;
    assert_eq!(st, StatusCode::OK);
    let c = &t["tool_calls"][0];
    s.post(&format!("/api/v1/tool-calls/{}/decision", c["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": c["revision"] })).await;
    s.wait_status(&tid, "completed").await;
    let sys = |r: &Value| r["messages"][0]["content"].as_str().unwrap_or("").to_string();
    let reqs = f.requests();
    assert!(sys(&reqs[1]).contains("WORKFLOW-A-BODY") && !sys(&reqs[1]).contains("CHANGED"), "진행 중 요청은 고정된 워크플로");
    // 다음 요청부터 기본 워크플로
    f.push(fixture::text("다음"));
    let v = start_turn(&s, &sid, &prof, "다음", false).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let last = sys(f.requests().last().unwrap());
    assert!(!last.contains("WORKFLOW-A"), "다음 요청은 바뀐 설정");
}

// WORKFLOW-006: 진행 중 요청은 접수 때 워크플로를 유지하고, 비활성화한 워크플로는 다음 요청부터 기본으로 대신하되
// 대화의 선택은 남아 다시 켜면 복원된다. 삭제하면 진행 중 요청은 그대로 끝나고 다음 요청은 기본 워크플로다.
#[tokio::test]
async fn disabled_or_deleted_workflow_never_changes_active_turn_and_next_turn_uses_default() {
    let (s, f, prof, sid, _) = setup().await;
    let (st, _) = s.post("/api/v1/definitions/workflow", json!({ "id": "wf-b", "name": "B", "body": "WORKFLOW-B-BODY" })).await;
    assert_eq!(st, StatusCode::CREATED);
    let (_, sess) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    let (st, _) = s.send(Method::PATCH, &format!("/api/v1/sessions/{sid}"), json!({ "expected_revision": sess["revision"], "workflow_id": "wf-b" })).await;
    assert_eq!(st, StatusCode::OK);
    let sys = |r: &Value| r["messages"][0]["content"].as_str().unwrap_or("").to_string();
    let approve_and_finish = |t: Value| {
        let s = &s;
        async move {
            let c = &t["tool_calls"][0];
            s.post(&format!("/api/v1/tool-calls/{}/decision", c["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": c["revision"] })).await;
            s.wait_status(t["id"].as_str().unwrap(), "completed").await
        }
    };

    // 1) 승인 대기 중 비활성화 → 진행 중 요청은 B로 끝난다.
    f.push(fixture::tool_calls(&[("w1", "write", json!({ "path": "b1.txt", "content": "1" }))]));
    f.push(fixture::text("끝1"));
    let tid = start_turn(&s, &sid, &prof, "하나", true).await["turn"]["id"].as_str().unwrap().to_string();
    let t = s.wait_status(&tid, "awaiting_approval").await;
    let (_, d) = s.get("/api/v1/definitions/workflow/wf-b").await;
    let (st, _) = s.send(Method::PUT, "/api/v1/definitions/workflow/wf-b", json!({ "expected_revision": d["revision"], "enabled": false })).await;
    assert_eq!(st, StatusCode::OK);
    approve_and_finish(t).await;
    assert!(sys(&f.requests()[1]).contains("WORKFLOW-B-BODY"), "진행 중 요청은 접수 때 워크플로");

    // 2) 다음 요청: 기본 워크플로로 대신하고 snapshot에 원래 선택을 남긴다. 대화 선택은 유지.
    f.push(fixture::text("둘"));
    let v = start_turn(&s, &sid, &prof, "둘", false).await;
    let done = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    assert!(!sys(f.requests().last().unwrap()).contains("WORKFLOW-B"), "비활성 워크플로는 새 요청에 적용하지 않는다");
    assert_eq!(done["definition"]["workflow"]["id"], "default");
    assert_eq!(done["definition"]["workflow"]["disabled_selection"], "wf-b");
    assert_eq!(s.get(&format!("/api/v1/sessions/{sid}")).await.1["workflow_id"], "wf-b");

    // 3) 다시 켜면 다음 요청부터 B로 돌아온다.
    let (_, d) = s.get("/api/v1/definitions/workflow/wf-b").await;
    s.send(Method::PUT, "/api/v1/definitions/workflow/wf-b", json!({ "expected_revision": d["revision"], "enabled": true })).await;
    f.push(fixture::text("셋"));
    let v = start_turn(&s, &sid, &prof, "셋", false).await;
    let done = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    assert!(sys(f.requests().last().unwrap()).contains("WORKFLOW-B-BODY"));
    assert!(done["definition"]["workflow"].get("disabled_selection").is_none());

    // 4) 승인 대기 중 삭제 → 진행 중 요청은 B로 끝나고, 다음 요청은 기본이며 대화 선택은 비워진다.
    f.push(fixture::tool_calls(&[("w2", "write", json!({ "path": "b2.txt", "content": "2" }))]));
    f.push(fixture::text("끝4"));
    let n = f.requests().len();
    let tid = start_turn(&s, &sid, &prof, "넷", true).await["turn"]["id"].as_str().unwrap().to_string();
    let t = s.wait_status(&tid, "awaiting_approval").await;
    let (_, d) = s.get("/api/v1/definitions/workflow/wf-b").await;
    let (st, _) = s.send(Method::DELETE, &format!("/api/v1/definitions/workflow/wf-b?expected_revision={}", d["revision"]), json!({})).await;
    assert_eq!(st, StatusCode::OK);
    approve_and_finish(t).await;
    assert!(sys(&f.requests()[n + 1]).contains("WORKFLOW-B-BODY"), "삭제 뒤에도 진행 중 요청은 고정한 본문");
    assert!(s.get(&format!("/api/v1/sessions/{sid}")).await.1["workflow_id"].is_null());
    f.push(fixture::text("다섯"));
    let v = start_turn(&s, &sid, &prof, "다섯", false).await;
    let done = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    assert!(!sys(f.requests().last().unwrap()).contains("WORKFLOW-B"));
    assert_eq!(done["definition"]["workflow"]["id"], "default");
}

// RUN-019: 끝난(실패·중단·취소) 요청은 다시 실행하거나 포기(확인)할 수 있다.
#[tokio::test]
async fn retry_applies_new_model_and_effort_on_the_same_profile() {
    let (s, f, profile, sid, _) = setup().await;
    f.push(fixture::truncated());
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({
        "profile_id": profile, "text": "다시 실행할 원문", "model": "old-model", "effort": "high",
    })).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let old = v["turn"]["id"].as_str().unwrap();
    s.wait_status(old, "failed").await;
    f.push(fixture::text("다른 모델의 답"));
    let path = format!("/api/v1/turns/{old}/retry");
    let request = json!({ "model_selection": { "profile_id": profile, "model": "new-model", "effort": "auto" } });
    let retry = s.raw(Method::POST, &path, Some(request.clone()), Some("retry-model"), None).await;
    assert_eq!(retry.status(), StatusCode::ACCEPTED);
    let result: Value = retry.json().await.unwrap();
    s.wait_status(result["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(f.requests().last().unwrap()["model"], "new-model");
    assert!(f.requests().last().unwrap().get("reasoning_effort").is_none());
    let mut changed = request;
    changed["model_selection"]["model"] = json!("different-model");
    let conflict = s.raw(Method::POST, &path, Some(changed), Some("retry-model"), None).await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert_eq!(conflict.json::<Value>().await.unwrap()["error"]["code"], "idempotency_conflict");
}

#[tokio::test]
async fn ended_turn_can_be_retried_once_or_acknowledged() {
    let (s, f, prof, sid, _) = setup().await;
    f.push(fixture::hang_after("멈춤"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "다시 해 볼 요청", "profile_id": prof, "effort": "medium" })).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    s.wait_status(&tid, "running").await;
    for _ in 0..100 {
        if !f.requests().is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    let old = s.wait_status(&tid, "cancelled").await;
    assert!(old["acknowledged_at"].is_null());

    f.push(fixture::text("다시 한 답"));
    let path = format!("/api/v1/turns/{tid}/retry");
    let r1 = s.raw(Method::POST, &path, Some(json!({})), Some("retry-1"), None).await;
    assert_eq!(r1.status(), StatusCode::ACCEPTED);
    let v1: Value = r1.json().await.unwrap();
    let r2 = s.raw(Method::POST, &path, Some(json!({})), Some("retry-1"), None).await;
    let v2: Value = r2.json().await.unwrap();
    assert_eq!(v1["turn"]["id"], v2["turn"]["id"], "같은 key 재전송은 같은 요청");
    let nt = v1["turn"]["id"].as_str().unwrap();
    assert_eq!(v1["turn"]["definition"]["effort"], "medium", "원래 강도 유지");
    // EFF-002: 요청값과 provider에 보내는 적용값을 함께 고정한다
    assert_eq!(v1["turn"]["definition"]["effort_applied"], json!({ "requested": "medium", "field": "reasoning_effort", "value": "medium" }));
    assert_eq!(v1["message"]["content"]["text"], "다시 해 볼 요청");
    assert_eq!(v1["message"]["content"]["source"]["kind"], "retry");
    s.wait_status(nt, "completed").await;
    let (_, old) = s.get(&format!("/api/v1/turns/{tid}")).await;
    assert!(old["acknowledged_at"].is_string(), "다시 실행하면 원래 요청은 확인됨");
    let (_, turns) = s.get(&format!("/api/v1/sessions/{sid}/turns")).await;
    assert_eq!(turns.as_array().unwrap().len(), 2);
    // 최신이 아니면·정상 완료면 다시 실행 불가
    let (st, v) = s.post(&format!("/api/v1/turns/{tid}/retry"), json!({})).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["code"], "not_latest");
    let (st, v) = s.post(&format!("/api/v1/turns/{nt}/retry"), json!({})).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["code"], "not_retryable");

    // 포기(확인): 실패한 요청의 배너만 닫는다
    f.push(Step::Error(400, "실패 fixture".into()));
    let v = start_turn(&s, &sid, &prof, "실패할 요청", false).await;
    let ft = v["turn"]["id"].as_str().unwrap();
    s.wait_status(ft, "failed").await;
    let (st, a) = s.post(&format!("/api/v1/turns/{ft}/acknowledge"), json!({})).await;
    assert_eq!(st, StatusCode::OK, "{a}");
    assert_eq!(a["status"], "failed", "결과는 그대로");
    assert!(a["acknowledged_at"].is_string());
    let (st, _) = s.post(&format!("/api/v1/turns/{nt}/acknowledge"), json!({})).await;
    assert_eq!(st, StatusCode::CONFLICT, "정상 완료는 확인 대상 아님");
}

// 웹은 이 두 이벤트의 payload로 대화 cache의 한 건을 갱신한다(web/app/state/store.ts). 목록 조회의 같은 행과 값이 같아야 한다.
#[tokio::test]
async fn message_and_tool_call_event_payloads_match_list_rows() {
    let (s, f, profile, sid, _) = setup().await;
    f.push(fixture::tool_calls(&[("list-1", "list", json!({}))]));
    f.push(fixture::text("완료"));
    let v = start_turn(&s, &sid, &profile, "목록을 봐", true).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let events = s.server.as_ref().unwrap().app.db.call(|c| grove::events::read_after(c, 0, 1000)).await.unwrap();
    let (_, all) = s.get(&format!("/api/v1/sessions/{sid}/messages?limit=500")).await;
    let all = all["items"].as_array().unwrap();
    let created: Vec<&Value> = events.iter()
        .filter(|e| e.kind == "message.created" && e.session_id.as_deref() == Some(sid.as_str())).map(|e| &e.payload).collect();
    assert_eq!(created, all.iter().collect::<Vec<_>>());
    assert!(all.iter().any(|m| m["role"] == "tool"), "{all:?}");
    // 대화 보기의 숨김 규칙은 web/app/state/conversationPages.ts의 conversationVisibility와 같다.
    let (_, view) = s.get(&format!("/api/v1/sessions/{sid}/messages?limit=500&view=conversation")).await;
    let shown: Vec<&Value> = all.iter().filter(|m| m["role"] != "tool"
        && !(m["role"] == "note" && ["cli_activity", "task_result"].contains(&m["content"]["type"].as_str().unwrap_or("")))).collect();
    assert_eq!(view["items"].as_array().unwrap().iter().collect::<Vec<_>>(), shown);
    let (_, calls) = s.get(&format!("/api/v1/tool-calls?session_id={sid}&limit=200")).await;
    let calls = calls.as_array().unwrap();
    assert_eq!(calls.len(), 1);
    let last = events.iter().rev().find(|e| e.kind == "tool_call.updated" && e.payload["id"] == calls[0]["id"]).unwrap();
    assert_eq!(last.payload, calls[0]);
}
