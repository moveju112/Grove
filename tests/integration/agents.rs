//! 자식 에이전트(AGENT-001, 006~012, 014). 모델은 로컬 fixture(부모: 기본 대본, 자식: "Delegated task" 표식 대본).
use crate::common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;

const CHILD: &str = "Delegated task";

async fn setup() -> (TestServer, Fixture, String, String, String) {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("ag").await;
    let pid = p["id"].as_str().unwrap().to_string();
    let (status, value) = s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/agents.orchestration"), json!({ "expected_revision": 0, "value": "delegated" })).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let sid = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    (s, f, prof, pid, sid)
}

async fn turn(s: &TestServer, sid: &str, prof: &str, text: &str) -> String {
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": text, "profile_id": prof, "tools": true })).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    v["turn"]["id"].as_str().unwrap().to_string()
}

async fn set_policy(s: &TestServer, value: &str) {
    let (_, eff) = s.get("/api/v1/settings/effective").await;
    let rev = eff["items"].as_array().unwrap().iter().find(|i| i["key"] == "agents.delegation").unwrap()["layers"]["server"]["revision"].as_i64().unwrap();
    let (st, v) = s.send(Method::PUT, "/api/v1/settings/server/-/agents.delegation", json!({ "expected_revision": rev, "value": value })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
}

async fn runs(s: &TestServer, sid: &str) -> Value {
    s.get(&format!("/api/v1/sessions/{sid}/agent-runs")).await.1
}

async fn wait_run(s: &TestServer, sid: &str, pred: impl Fn(&Value) -> bool) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let r = runs(s, sid).await;
        if let Some(run) = r["runs"].as_array().unwrap().first()
            && pred(run)
        {
            return run.clone();
        }
        assert!(tokio::time::Instant::now() < deadline, "run 대기 시간 초과: {r}");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

async fn notes(s: &TestServer, sid: &str) -> Vec<Value> {
    let (_, m) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    m["items"].as_array().unwrap().iter().filter(|m| m["role"] == "note" && m["content"]["type"] == "agent_result").cloned().collect()
}

/// 보조 역할의 자식 턴이 계정 한도로 실패하면 결과를 전달하기 전에 대체 모델로 같은 지시를 한 번 다시 실행한다.
#[tokio::test]
async fn helper_role_usage_limit_retries_once_on_fallback_before_reporting() {
    let (s, f, prof, _pid, sid) = setup().await;
    let primary = Fixture::start().await;
    let backup = Fixture::start().await;
    let primary_prof = s.fixture_profile(&primary.base).await;
    let backup_prof = s.fixture_profile(&backup.base).await;
    for (key, value) in [("agents.profile.context-explorer", json!(primary_prof)), ("agents.fallback.context-explorer", json!(backup_prof))] {
        let (status, v) = s.send(Method::PUT, &format!("/api/v1/settings/server/-/{key}"), json!({ "expected_revision": 0, "value": value })).await;
        assert_eq!(status, StatusCode::OK, "{key}: {v}");
    }
    f.push(fixture::tool_calls(&[("a1", "agent", json!({ "action": "spawn", "agent_id": "context-explorer", "brief": "관련 파일을 찾아" }))]));
    f.push(fixture::text("탐색을 맡겼어"));
    primary.push(fixture::Step::ErrorCode(429, "usage_limit_reached"));
    backup.push(fixture::text("탐색 결과: src/lib.rs"));
    let tid = turn(&s, &sid, &prof, "탐색 맡겨").await;
    let t = s.wait_status(&tid, "awaiting_approval").await;
    let c = &t["tool_calls"][0];
    s.post(&format!("/api/v1/tool-calls/{}/decision", c["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": c["revision"] })).await;
    let run = wait_run(&s, &sid, |r| r["status"] == "completed").await;
    assert_eq!(run["result"], "탐색 결과: src/lib.rs", "{run}");
    assert_eq!(run["profile_id"], backup_prof.as_str());
    assert_eq!((primary.requests().len(), backup.requests().len()), (1, 1));
    // 부모에는 실패 없이 최종 결과만 한 번 전달한다.
    let n = notes(&s, &sid).await;
    assert_eq!(n.len(), 1, "{n:?}");
    assert_eq!(n[0]["content"]["status"], "completed");
}

#[tokio::test]
async fn spawn_requires_approval_by_default_and_result_reaches_parent_once() {
    let (s, f, prof, _pid, sid) = setup().await;
    let (status, settings) = s.send(Method::PUT, "/api/v1/settings/server/-/agents.profile.reviewer",
        json!({ "expected_revision": 0, "value": { "profile_id": prof, "model": "review-small", "effort": "medium" } })).await;
    assert_eq!(status, StatusCode::OK, "{settings}");
    f.push(fixture::tool_calls(&[("a1", "agent", json!({ "action": "spawn", "agent_id": "reviewer", "brief": "README를 검토해" }))]));
    f.push(fixture::text("자식에게 맡겼어"));
    f.push(fixture::text("검토 결과를 확인했어"));
    let (child_result, release) = fixture::gated_text("검토 결과: 문제 없음 XYZ");
    f.push_for(CHILD, child_result);
    let tid = turn(&s, &sid, &prof, "검토 맡겨").await;
    // 기본 정책 ask: 승인 대기
    let t = s.wait_status(&tid, "awaiting_approval").await;
    let c = &t["tool_calls"][0];
    assert_eq!(c["name"], "agent");
    assert_eq!(c["target"]["agent_id"], "reviewer");
    s.post(&format!("/api/v1/tool-calls/{}/decision", c["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": c["revision"] })).await;
    s.wait_turn(&tid, |t| t["status"] == "running" && t["step"] == 2).await;
    release.send_replace(true);
    let t = s.wait_status(&tid, "completed").await;
    // 도구 결과는 즉시 running(완료로 보고하지 않음)
    assert_eq!(t["tool_calls"][0]["result"]["status"], "running", "{t}");
    let run = wait_run(&s, &sid, |r| r["status"] == "completed").await;
    assert_eq!(run["agent_id"], "reviewer");
    assert_eq!(run["depth"], 1);
    assert_eq!(run["parent_turn_id"], tid.as_str());
    assert_eq!(run["result"], "검토 결과: 문제 없음 XYZ");
    let child = run["child_session_id"].as_str().unwrap();
    let (_, cs) = s.get(&format!("/api/v1/sessions/{child}")).await;
    assert!(cs["title"].as_str().unwrap().contains("README를 검토해"), "{cs}");
    // 자식 세션은 자기 부모를 안다(출처 보존)
    let (_, cr) = s.get(&format!("/api/v1/sessions/{child}/agent-runs")).await;
    assert_eq!(cr["parent"]["id"], run["id"]);
    let (_, cm) = s.get(&format!("/api/v1/sessions/{child}/messages")).await;
    let first = &cm["items"][0];
    assert_eq!(first["role"], "user");
    assert_eq!(first["content"]["source"]["kind"], "agent_run", "지시 출처: {first}");
    assert_eq!(first["content"]["source"]["parent_session_id"], sid.as_str());
    // 부모에 note 한 번
    let n = notes(&s, &sid).await;
    assert_eq!(n.len(), 1, "{n:?}");
    assert_eq!(n[0]["content"]["type"], "agent_result");
    assert_eq!(n[0]["content"]["text"], "검토 결과: 문제 없음 XYZ");
    // 자식 요청에는 위임 지침과 reviewer 정의 본문이 들어간다
    let reqs = f.requests();
    let child_req = reqs.iter().find(|r| r.to_string().contains(CHILD)).expect("자식 요청");
    assert!(child_req.to_string().contains("README를 검토해"));
    assert_eq!(child_req["model"], "review-small");
    assert_eq!(child_req["reasoning_effort"], "medium");
    // 사용자가 자식 세션에 직접 보낸 턴은 부모에 보고하지 않는다
    f.push(fixture::text("직접 대화"));
    let (st, v) = s.post(&format!("/api/v1/sessions/{child}/turns"), json!({ "text": "추가 질문", "profile_id": prof })).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(notes(&s, &sid).await.len(), 1);
    // 직접 턴에는 "부모에 보고된다"는 위임 지침이 들어가지 않는다
    assert!(!f.requests().last().unwrap().to_string().contains(CHILD), "직접 턴에 위임 지침 없음");
    // 다음 부모 턴의 모델 입력에 결과가 들어간다
    f.push(fixture::text("확인"));
    let t2 = turn(&s, &sid, &prof, "결과는?").await;
    s.wait_status(&t2, "completed").await;
    let last = f.requests().last().unwrap()["messages"].to_string();
    assert!(last.contains("[child agent result]") && last.contains("XYZ"), "{last}");
}

/// AGENT-007: 부모 대화당 동시 자식 수 한도를 넘는 위임은 실행하지 않고 limit으로 실패하며, 자식 턴도 프로젝트 시간 예산을 그대로 받는다.
#[tokio::test]
async fn per_parent_limit_refuses_extra_children_and_children_inherit_budget() {
    let (s, f, prof, pid, sid) = setup().await;
    set_policy(&s, "auto").await;
    let (st, v) = s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/runs.budget.max_minutes"), json!({ "expected_revision": 0, "value": 9_999 })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let n = grove::agents::MAX_PER_PARENT as usize + 1;
    let calls: Vec<(String, Value)> = (0..n).map(|i| (format!("a{i}"), json!({ "action": "spawn", "agent_id": "reviewer", "brief": format!("일 {i}") }))).collect();
    let refs: Vec<(&str, &str, Value)> = calls.iter().map(|(id, a)| (id.as_str(), "agent", a.clone())).collect();
    f.push(fixture::tool_calls(&refs));
    for _ in 0..4 {
        f.push(fixture::text("부모 진행"));
    }
    let mut gates = vec![];
    for i in 0..n - 1 {
        let (step, release) = fixture::gated_text(&format!("자식 {i} 끝"));
        f.push_for(CHILD, step);
        gates.push(release);
    }
    let tid = turn(&s, &sid, &prof, "여러 개 맡겨").await;
    let t = s.wait_turn(&tid, |t| t["tool_calls"].as_array().is_some_and(|a| a.len() == n && a.iter().all(|c| c["status"] != "pending_approval" && c["status"] != "approved" && c["status"] != "running"))).await;
    let calls = t["tool_calls"].as_array().unwrap();
    let refused: Vec<_> = calls.iter().filter(|c| c["status"] == "failed").collect();
    assert_eq!(refused.len(), 1, "{t}");
    assert_eq!(refused[0]["result"]["error"]["code"], "limit", "{t}");
    let r = runs(&s, &sid).await;
    let list = r["runs"].as_array().unwrap();
    assert_eq!(list.len(), n - 1, "한도 밖 자식은 만들지 않는다");
    // 자식 턴의 예산 snapshot은 프로젝트 설정을 따른다
    let child_turn = list[0]["last_turn_id"].as_str().unwrap();
    let (_, ct) = s.get(&format!("/api/v1/turns/{child_turn}")).await;
    assert_eq!(ct["definition"]["budget"]["max_minutes"], 9_999, "{ct}");
    for g in gates {
        g.send_replace(true);
    }
    s.wait_status(&tid, "completed").await;
}

/// WORKFLOW-007: 자식의 진행·질문·완료 상태가 역할·부모 ID와 함께 부모 대화의 이벤트로 전달된다.
#[tokio::test]
async fn child_question_and_completion_reach_parent_with_role_and_parent_ids() {
    let (s, f, prof, _pid, sid) = setup().await;
    set_policy(&s, "auto").await;
    f.push(fixture::tool_calls(&[("a1", "agent", json!({ "action": "spawn", "agent_id": "reviewer", "brief": "질문하고 끝내" }))]));
    f.push(fixture::text("맡겼어"));
    f.push(fixture::text("자식 결과 확인"));
    f.push_for(CHILD, fixture::tool_calls(&[("q1", "ask_user", json!({ "question": "어느 쪽?", "options": [{ "label": "A" }, { "label": "B" }] }))]));
    f.push_for(CHILD, fixture::text("A로 끝냄"));
    let cursor = 0;
    let tid = turn(&s, &sid, &prof, "자식에게 맡겨").await;
    // 자식이 질문하면 부모 목록에서 '답변 대기'로 보인다.
    let run = wait_run(&s, &sid, |r| r["turn_status"] == "awaiting_input").await;
    assert_eq!(run["status"], "running");
    let child = run["child_session_id"].as_str().unwrap().to_string();
    let changed = |evs: &[(String, Value)], status: &str| {
        events_of(evs, "agent_run.changed").into_iter().any(|e| {
            e["session_id"] == sid.as_str()
                && e["payload"]["agent_id"] == "reviewer"
                && e["payload"]["parent_session_id"] == sid.as_str()
                && e["payload"]["parent_turn_id"] == tid.as_str()
                && e["payload"]["child_session_id"] == child.as_str()
                && (e["payload"]["turn_status"] == status || e["payload"]["status"] == status)
        })
    };
    let evs = s.read_events(Some(cursor), "", 200, 1500).await;
    assert!(changed(&evs, "awaiting_input"), "질문 대기가 부모 대화 이벤트로 전달: {evs:?}");
    // 자식 대화에서 답하면 이어서 완료되고 부모에 결과가 한 번 보고된다.
    let ct = s.wait_status(run["last_turn_id"].as_str().unwrap(), "awaiting_approval").await;
    let call = ct["tool_calls"].as_array().unwrap().iter().find(|c| c["status"] == "awaiting_input").expect("자식 질문").clone();
    let (st, v) = s.post(&format!("/api/v1/tool-calls/{}/answer", call["id"].as_str().unwrap()), json!({ "choices": ["A"], "expected_revision": call["revision"] })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let run = wait_run(&s, &sid, |r| r["status"] == "completed").await;
    assert_eq!(run["result"], "A로 끝냄");
    s.wait_status(&tid, "completed").await;
    let evs = s.read_events(Some(cursor), "", 400, 1500).await;
    assert!(changed(&evs, "completed"));
    assert_eq!(notes(&s, &sid).await.len(), 1);
}

#[tokio::test]
async fn wait_in_same_turn_keeps_tool_pairs_and_send_follows_up() {
    let (s, f, prof, _pid, sid) = setup().await;
    set_policy(&s, "auto").await;
    f.push(fixture::tool_calls(&[("a1", "agent", json!({ "action": "spawn", "agent_id": "reviewer", "brief": "천천히 해" }))]));
    f.push(fixture::text("시작함"));
    f.push(fixture::text("첫 결과 확인"));
    let (first, release) = fixture::gated_text("첫 결과");
    f.push_for(CHILD, first);
    let t1 = turn(&s, &sid, &prof, "시작").await;
    s.wait_turn(&t1, |t| t["status"] == "running" && t["step"] == 2).await;
    release.send_replace(true);
    s.wait_status(&t1, "completed").await;
    let run = wait_run(&s, &sid, |r| r["status"] == "completed").await;
    let run_id = run["id"].as_str().unwrap().to_string();
    // 사용자 직접 send로 실행 중인 자식을 만든 뒤 모델의 wait가 실제로 기다리게 한다.
    let (next, release) = fixture::gated_text("느린 결과");
    f.push_for(CHILD, next);
    s.post(&format!("/api/v1/sessions/{sid}/tool-requests"), json!({"name":"agent","args":{"action":"send","run_id":run_id,"brief":"두 번째 작업"}})).await;
    wait_run(&s, &sid, |r| r["status"] == "running").await;
    // 같은 턴에서 wait: 자식이 끝날 때까지 도구가 기다린다.
    f.push(fixture::tool_calls(&[("w1", "agent", json!({ "action": "wait", "run_id": run_id, "timeout_ms": 20000 }))]));
    f.push(fixture::text("다 기다림"));
    let t2 = turn(&s, &sid, &prof, "기다려").await;
    s.wait_turn(&t2, |t| t["tool_calls"].as_array().is_some_and(|calls| calls.iter().any(|c| c["status"]=="running"))).await;
    release.send_replace(true);
    let t = s.wait_status(&t2, "completed").await;
    let r = &t["tool_calls"][0]["result"];
    assert_eq!(r["status"], "completed", "{t}");
    assert_eq!(r["result"], "느린 결과");
    assert_eq!(r["wait_timed_out"], false);
    // wait 도구 결과 다음에야 note가 모델 입력에 들어간다(중단 합성 없음)
    let msgs = f.requests().last().unwrap()["messages"].clone();
    let arr = msgs.as_array().unwrap();
    let tool_idx = arr.iter().position(|m| m["role"] == "tool" && m["tool_call_id"] == "w1").expect("w1 결과");
    assert!(!msgs.to_string().contains("중단됨"), "{msgs}");
    let note_idx = arr.iter().position(|m| {
        let text = m.to_string();
        text.contains("[child agent result]") && text.contains("느린 결과")
    }).expect("이번 wait의 자식 결과");
    assert!(note_idx > tool_idx, "이번 결과 note는 tool 결과 뒤: {msgs}");
    // send: 끝난 run에 후속 지시 → 다시 running → 결과 note 두 번째
    f.push(fixture::tool_calls(&[("s1", "agent", json!({ "action": "send", "run_id": run_id, "brief": "한 번 더" }))]));
    f.push(fixture::text("다시 맡김"));
    f.push(fixture::text("후속 결과 확인"));
    let (next, release) = fixture::gated_text("두 번째 결과");
    f.push_for(CHILD, next);
    let t3 = turn(&s, &sid, &prof, "한 번 더").await;
    s.wait_turn(&t3, |t| t["status"] == "running" && t["step"] == 2).await;
    release.send_replace(true);
    s.wait_status(&t3, "completed").await;
    wait_run(&s, &sid, |r| r["status"] == "completed" && r["result"] == "두 번째 결과").await;
    let n = notes(&s, &sid).await;
    assert_eq!(n.len(), 3, "사용자 직접 send와 각 모델 위임 턴마다 한 번: {n:?}");
    // 실행 중 send는 거부(이중 실행 금지)는 상태 계약으로 확인: list는 하나
    let r = runs(&s, &sid).await;
    assert_eq!(r["runs"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn policy_off_and_depth_limit() {
    let (s, f, prof, _pid, sid) = setup().await;
    set_policy(&s, "off").await;
    f.push(fixture::tool_calls(&[("a1", "agent", json!({ "action": "spawn", "agent_id": "reviewer", "brief": "x" }))]));
    f.push(fixture::text("못 함"));
    let t = turn(&s, &sid, &prof, "맡겨").await;
    let t = s.wait_status(&t, "completed").await;
    assert_eq!(t["tool_calls"][0]["status"], "failed");
    assert_eq!(t["tool_calls"][0]["result"]["error"]["code"], "delegation_disabled");
    assert!(runs(&s, &sid).await["runs"].as_array().unwrap().is_empty());
    // 깊이: 부모 → A(1) → B(2). B에는 위임 도구 목록이 비어 있다
    set_policy(&s, "auto").await;
    f.push(fixture::tool_calls(&[("a2", "agent", json!({ "action": "spawn", "agent_id": "reviewer", "brief": "A 작업" }))]));
    f.push(fixture::text("부모 끝"));
    f.push(fixture::text("부모 결과 반영"));
    f.push_for(CHILD, fixture::tool_calls(&[("b1", "agent", json!({ "action": "spawn", "agent_id": "reviewer", "brief": "B 작업" }))]));
    f.push_for(CHILD, fixture::text("끝 1"));
    f.push_for(CHILD, fixture::text("끝 2"));
    f.push_for(CHILD, fixture::text("자식 결과 반영"));
    let t = turn(&s, &sid, &prof, "깊게").await;
    s.wait_status(&t, "completed").await;
    let a = wait_run(&s, &sid, |r| r["status"] == "completed").await;
    let a_child = a["child_session_id"].as_str().unwrap();
    let b = wait_run(&s, a_child, |r| r["status"] == "completed").await;
    assert_eq!(b["depth"], 2);
    let reqs = f.requests();
    assert!(reqs.iter().any(|r| r.to_string().contains("cannot be spawned from this conversation (depth limit)")), "B는 위임 불가 안내");
}

#[tokio::test]
async fn parent_cancel_cascades_and_restart_interrupts_children() {
    let (mut s, f, prof, _pid, sid) = setup().await;
    set_policy(&s, "auto").await;
    f.push(fixture::tool_calls(&[("a1", "agent", json!({ "action": "spawn", "agent_id": "reviewer", "brief": "오래 걸림" }))]));
    f.push(fixture::hang_after("부모 생각 중"));
    f.push_for(CHILD, fixture::hang_after("자식 생각 중"));
    let tid = turn(&s, &sid, &prof, "시작").await;
    let run = wait_run(&s, &sid, |r| r["status"] == "running").await;
    // 자식 턴이 실제로 실행 중일 때까지
    let child = run["child_session_id"].as_str().unwrap().to_string();
    tokio::time::sleep(Duration::from_millis(300)).await;
    // 보관은 자식 실행 중이라 거부
    let (_, sess) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    let (st, _) = s.send(Method::PATCH, &format!("/api/v1/sessions/{sid}"), json!({ "expected_revision": sess["revision"], "archived": true })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    let (st, _) = s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    assert_eq!(st, StatusCode::ACCEPTED);
    let run = wait_run(&s, &sid, |r| r["status"] != "running").await;
    assert_eq!(run["status"], "cancelled");
    let n = notes(&s, &sid).await;
    assert_eq!(n.len(), 1);
    assert_eq!(n[0]["content"]["status"], "cancelled");
    let (_, ct) = s.get(&format!("/api/v1/sessions/{child}/turns")).await;
    assert_eq!(ct[0]["status"], "cancelled");
    assert_eq!(ct[0]["error"]["code"], "parent_cancelled");

    // 재시작: 실행 중 자식은 interrupted로 보고되고 자동 재실행하지 않는다
    f.push(fixture::tool_calls(&[("a2", "agent", json!({ "action": "spawn", "agent_id": "reviewer", "brief": "재시작 전" }))]));
    f.push(fixture::text("맡김"));
    f.push_for(CHILD, fixture::hang_after("멈춤"));
    let t2 = turn(&s, &sid, &prof, "다시").await;
    s.wait_turn(&t2, |t| t["status"] == "running" && t["step"] == 2).await;
    let r2 = wait_run(&s, &sid, |r| r["status"] == "running").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    s.restart().await;
    let (_, after) = s.get(&format!("/api/v1/agent-runs/{}", r2["id"].as_str().unwrap())).await;
    assert_eq!(after["status"], "interrupted", "{after}");
    assert_eq!(notes(&s, &sid).await.len(), 2);
}

#[tokio::test]
async fn runs_belong_to_their_parent_session() {
    let (s, f, prof, pid, sid) = setup().await;
    set_policy(&s, "auto").await;
    f.push(fixture::tool_calls(&[("a1", "agent", json!({ "action": "spawn", "agent_id": "reviewer", "brief": "x" }))]));
    f.push(fixture::text("ok"));
    f.push(fixture::text("result received"));
    f.push_for(CHILD, fixture::text("done"));
    let t = turn(&s, &sid, &prof, "go").await;
    s.wait_status(&t, "completed").await;
    let run = wait_run(&s, &sid, |r| r["status"] == "completed").await;
    assert_eq!(run["turn_status"], "completed", "마지막 자식 턴 상태를 함께 보여 준다: {run}");
    // 다른 세션에서 남의 run 조회 → not_found
    let other = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    let (_, c) = s.post(&format!("/api/v1/sessions/{other}/tool-requests"), json!({ "name": "agent", "args": { "action": "status", "run_id": run["id"] } })).await;
    let id = c["id"].as_str().unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let done = loop {
        let (_, v) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
        if ["succeeded", "failed"].contains(&v["status"].as_str().unwrap()) {
            break v;
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(30)).await;
    };
    assert_eq!(done["status"], "failed", "{done}");
    assert_eq!(done["result"]["error"]["code"], "not_found");
    // 다른 세션이 남의 자식에게 후속 지시(send)를 보내도 거부되고 자식 대화에 새 턴이 생기지 않는다(SESSION-013)
    let child = run["child_session_id"].as_str().unwrap().to_string();
    let (_, before) = s.get(&format!("/api/v1/sessions/{child}/turns")).await;
    let (_, c) = s
        .post(&format!("/api/v1/sessions/{other}/tool-requests"), json!({ "name": "agent", "args": { "action": "send", "run_id": run["id"], "brief": "남의 지시" } }))
        .await;
    let id = c["id"].as_str().unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let sent = loop {
        let (_, v) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
        if ["succeeded", "failed"].contains(&v["status"].as_str().unwrap()) {
            break v;
        }
        assert!(tokio::time::Instant::now() < deadline, "{v}");
        tokio::time::sleep(Duration::from_millis(30)).await;
    };
    assert_eq!(sent["result"]["error"]["code"], "not_found", "{sent}");
    let (_, after) = s.get(&format!("/api/v1/sessions/{child}/turns")).await;
    assert_eq!(before.as_array().map(Vec::len), after.as_array().map(Vec::len), "자식 대화에 새 턴 없음");
    assert!(!f.requests().iter().any(|r| r.to_string().contains("남의 지시")), "모델을 부르지 않았다");
    // 턴 밖(사용자 직접 요청)에서는 spawn 불가
    let (_, c) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"), json!({ "name": "agent", "args": { "action": "spawn", "agent_id": "reviewer", "brief": "y" } })).await;
    let id = c["id"].as_str().unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (_, v) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
    assert_eq!(v["result"]["error"]["code"], "invalid_context", "{v}");
}
