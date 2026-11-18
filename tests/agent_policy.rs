//! AGENT-013: 실제 역할 ID·범위 상속·승인 전후 위임 및 철회 뒤 복구.
mod common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;

const ROLES: &str = "agents.allowed_roles";
const MODE: &str = "agents.orchestration";
const CHILD: &str = "Delegated task";

async fn setup() -> (TestServer, Fixture, String, String, String) {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("agent-policy").await["id"].as_str().unwrap().to_string();
    let session = s.create_session(&project).await["id"].as_str().unwrap().to_string();
    (s, f, profile, project, session)
}

async fn setting(s: &TestServer, scope: &str, id: &str, key: &str, value: Value) -> Value {
    let query = match scope {
        "project" => format!("?project_id={id}"),
        "session" => format!("?session_id={id}"),
        _ => String::new(),
    };
    let (_, effective) = s.get(&format!("/api/v1/settings/effective{query}")).await;
    let item = effective["items"].as_array().unwrap().iter().find(|item| item["key"] == key).expect("등록된 정책");
    let revision = item["layers"][scope]["revision"].as_i64().unwrap();
    let (status, result) = s.send(Method::PUT, &format!("/api/v1/settings/{scope}/{id}/{key}"), json!({"expected_revision": revision, "value": value})).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    result["item"].clone()
}

async fn available(s: &TestServer, session: &str) -> Vec<String> {
    let session = session.to_string();
    s.server.as_ref().unwrap().app.db.call(move |c| {
        Ok(grove::agents::available_for(c, &session)?.as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap().to_string()).collect())
    }).await.unwrap()
}

async fn turn(s: &TestServer, session: &str, profile: &str) -> String {
    let (status, value) = s.post(&format!("/api/v1/sessions/{session}/turns"), json!({"text":"정책 검증", "profile_id":profile, "tools":true})).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{value}");
    value["turn"]["id"].as_str().unwrap().to_string()
}

async fn runs(s: &TestServer, session: &str) -> Vec<Value> {
    s.get(&format!("/api/v1/sessions/{session}/agent-runs")).await.1["runs"].as_array().unwrap().clone()
}

async fn run_status(s: &TestServer, session: &str, status: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let list = runs(s, session).await;
        if let Some(run) = list.iter().find(|run| run["status"] == status) {
            return run.clone();
        }
        assert!(tokio::time::Instant::now() < deadline, "{list:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn tool_done(s: &TestServer, id: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let (_, call) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
        if ["succeeded", "failed", "cancelled"].contains(&call["status"].as_str().unwrap()) {
            return call;
        }
        assert!(tokio::time::Instant::now() < deadline, "{call}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn request(s: &TestServer, session: &str, args: Value) -> Value {
    let (status, value) = s.post(&format!("/api/v1/sessions/{session}/tool-requests"), json!({"name":"agent","args":args})).await;
    assert_eq!(status, StatusCode::CREATED, "{value}");
    tool_done(s, value["id"].as_str().unwrap()).await
}

#[tokio::test]
async fn discovery_respects_off_before_any_new_policy() {
    let (s, _f, _profile, _project, session) = setup().await;
    assert!(available(&s, &session).await.contains(&"reviewer".into()));
    setting(&s, "server", "-", "agents.delegation", json!("off")).await;
    assert!(available(&s, &session).await.is_empty(), "off인데 모델에 위임 가능한 역할을 안내하면 안 된다");
}

#[tokio::test]
async fn restrictive_scope_matrix_and_exact_role_validation() {
    let (s, _f, _profile, project, session) = setup().await;
    let initial = available(&s, &session).await;
    assert!(initial.len() > 2);
    let item = setting(&s, "server", "-", ROLES, json!(" reviewer, worker ")).await;
    assert_eq!(item["effective"], "reviewer,worker");
    setting(&s, "project", &project, ROLES, json!("worker,writer")).await;
    let item = setting(&s, "session", &session, ROLES, json!("reviewer,worker,writer")).await;
    assert_eq!(item["effective"], "worker");
    assert_eq!(item["source"], "project");
    assert_eq!(available(&s, &session).await, ["worker"]);
    setting(&s, "session", &session, ROLES, json!("")).await;
    assert!(available(&s, &session).await.is_empty());
    setting(&s, "session", &session, ROLES, Value::Null).await;
    assert_eq!(available(&s, &session).await, ["worker"]);
    setting(&s, "project", &project, ROLES, Value::Null).await;
    assert_eq!(available(&s, &session).await, ["reviewer", "worker"]);
    setting(&s, "server", "-", MODE, json!("solo")).await;
    let item = setting(&s, "session", &session, MODE, json!("delegated")).await;
    assert_eq!(item["effective"], "solo");
    assert_eq!(item["source"], "server");
    assert!(available(&s, &session).await.is_empty());
    setting(&s, "server", "-", MODE, Value::Null).await;
    setting(&s, "server", "-", "agents.delegation", json!("off")).await;
    let item = setting(&s, "session", &session, "agents.delegation", json!("auto")).await;
    assert_eq!(item["effective"], "off");
    assert_eq!(item["source"], "server");
    assert!(available(&s, &session).await.is_empty());
    setting(&s, "server", "-", "agents.delegation", Value::Null).await;
    assert_eq!(available(&s, &session).await, ["reviewer", "worker"]);

    let (_, before) = s.get("/api/v1/settings/effective").await;
    let revision = before["items"].as_array().unwrap().iter().find(|i| i["key"] == ROLES).unwrap()["layers"]["server"]["revision"].clone();
    for bad in [json!(["worker"]), json!({"worker":true}), json!("Worker"), json!("missing-role"), json!("worker,,reviewer"), json!("*,worker"), json!("worker,worker"), json!(42)] {
        let (status, error) = s.send(Method::PUT, &format!("/api/v1/settings/server/-/{ROLES}"), json!({"expected_revision":revision,"value":bad})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
        assert_eq!(error["error"]["code"], "invalid_request");
    }
    let (_, after) = s.get("/api/v1/settings/effective").await;
    assert_eq!(before, after, "검증 실패로 값·revision을 바꾸지 않는다");
    let (status, custom) = s.post("/api/v1/definitions/agent", json!({"id":"policy-custom","name":"Worker","body":"fixture role"})).await;
    assert_eq!(status, StatusCode::CREATED, "{custom}");
    setting(&s, "server", "-", ROLES, json!("policy-custom")).await;
    assert_eq!(available(&s, &session).await, ["policy-custom"], "표시 이름이 아닌 정의 ID에 묶인다");
    let (status, value) = s.send(Method::PUT, "/api/v1/definitions/agent/policy-custom", json!({"expected_revision":1,"enabled":false})).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(available(&s, &session).await.is_empty());
}

#[tokio::test]
async fn denied_spawn_and_approval_withdrawal_never_create_children() {
    let (s, f, profile, _project, session) = setup().await;
    setting(&s, "server", "-", ROLES, json!("worker")).await;
    for mode in ["off", "ask", "auto"] {
        setting(&s, "server", "-", "agents.delegation", json!(mode)).await;
        f.push(fixture::tool_calls(&[("spawn", "agent", json!({"action":"spawn","agent_id":"reviewer","brief":"금지"}))]));
        f.push(fixture::text("금지 확인"));
        let id = turn(&s, &session, &profile).await;
        let done = s.wait_status(&id, "completed").await;
        assert_eq!(done["tool_calls"][0]["result"]["error"]["code"], "delegation_disabled", "{done}");
        assert!(runs(&s, &session).await.is_empty());
        assert!(!done["definition"]["agents_available"].as_array().unwrap().iter().any(|d| d["id"] == "reviewer"));
    }
    setting(&s, "server", "-", ROLES, json!("reviewer")).await;
    setting(&s, "server", "-", "agents.delegation", json!("ask")).await;
    f.push(fixture::tool_calls(&[("pending", "agent", json!({"action":"spawn","agent_id":"reviewer","brief":"승인 후 철회"}))]));
    f.push(fixture::text("철회 확인"));
    let id = turn(&s, &session, &profile).await;
    let pending = s.wait_status(&id, "awaiting_approval").await;
    let call = &pending["tool_calls"][0];
    setting(&s, "server", "-", ROLES, json!("worker")).await;
    let body = json!({"decision":"approve","expected_revision":call["revision"]});
    let path = format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap());
    let key = s.key();
    // 서버가 승인 응답을 만들었지만 클라이언트는 본문을 읽지 못한 경우, 같은 키로 확인한다.
    let first = s.raw(Method::POST, &path, Some(body.clone()), Some(&key), None).await;
    assert_eq!(first.status(), StatusCode::OK);
    drop(first);
    let replay = s.raw(Method::POST, &path, Some(body.clone()), Some(&key), None).await;
    assert_eq!(replay.status(), StatusCode::OK);
    let done = s.wait_status(&id, "completed").await;
    assert_eq!(done["tool_calls"][0]["result"]["error"]["code"], "delegation_disabled", "{done}");
    assert!(runs(&s, &session).await.is_empty());
    setting(&s, "server", "-", ROLES, json!("reviewer")).await;
    let replay = s.raw(Method::POST, &path, Some(body), Some(&key), None).await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert!(runs(&s, &session).await.is_empty(), "정책 복원·응답 재조회가 새 실행을 만들면 안 된다");
}

#[tokio::test]
async fn child_inherits_parent_policy_and_withdrawal_preserves_results_and_cancel() {
    let (s, f, profile, _project, session) = setup().await;
    setting(&s, "server", "-", "agents.delegation", json!("auto")).await;
    setting(&s, "session", &session, ROLES, json!("reviewer")).await;
    f.push(fixture::tool_calls(&[("start", "agent", json!({"action":"spawn","agent_id":"reviewer","brief":"완료"}))]));
    f.push(fixture::text("접수"));
    f.push(fixture::text("결과 확인"));
    f.push_for(CHILD, fixture::text("보존할 결과"));
    let id = turn(&s, &session, &profile).await;
    s.wait_status(&id, "completed").await;
    let run = run_status(&s, &session, "completed").await;
    let child = run["child_session_id"].as_str().unwrap();
    let inherited = setting(&s, "session", child, ROLES, json!("*")).await;
    assert_eq!(inherited["effective"], "reviewer", "설정 UI 적용값과 실제 역할 안내가 같아야 한다");
    assert_eq!(inherited["layers"][format!("parent:{session}")]["scope_id"], session);
    assert_eq!(available(&s, child).await, ["reviewer"]);
    setting(&s, "server", "-", ROLES, json!("reviewer")).await;
    setting(&s, "session", &session, ROLES, Value::Null).await;
    assert_eq!(available(&s, child).await, ["reviewer"], "상위 override를 지워도 서버 제한을 상속한다");
    setting(&s, "session", &session, ROLES, json!("reviewer")).await;
    setting(&s, "server", "-", ROLES, Value::Null).await;
    let app = s.server.as_ref().unwrap().app.clone();
    let (sid, rid, now) = (session.clone(), run["id"].as_str().unwrap().to_string(), app.now());
    let claimed = app.db.call(move |c| {
        let tx = c.transaction()?;
        let session = grove::sessions::get(&tx, &sid)?;
        let root = grove::sessions::exec_root(&tx, &sid)?;
        let call = grove::approvals::create_call(&tx, &now, 1800, &sid, &session.project_id, &root, None, None, "agent",
            &json!({"action":"send","run_id":rid,"brief":"claim 뒤 철회"}))?;
        assert_eq!(call.status, "approved");
        tx.execute("UPDATE tool_calls SET status='running' WHERE id=?1", [&call.id])?;
        let call = grove::approvals::get(&tx, &call.id)?;
        tx.commit()?;
        Ok(call)
    }).await.unwrap();
    setting(&s, "session", &session, ROLES, json!("")).await;
    let (_cancel, rx) = tokio::sync::watch::channel(false);
    let error = grove::agents::execute_tool(&app, &claimed, rx).await.unwrap_err();
    assert_eq!(error.code, "delegation_disabled");
    let (id, now) = (claimed.id, app.now());
    app.db.call(move |c| {
        grove::approvals::finish(c, &now, &id, &["running"], "failed", Some(error.to_json()))?;
        Ok(())
    }).await.unwrap();
    assert!(available(&s, child).await.is_empty());
    let inherited = setting(&s, "session", child, "agents.delegation", json!("auto")).await;
    assert_eq!(inherited["effective"], "auto");
    for args in [json!({"action":"list"}), json!({"action":"status","run_id":run["id"]}), json!({"action":"wait","run_id":run["id"],"timeout_ms":1})] {
        assert_eq!(request(&s, &session, args).await["status"], "succeeded");
    }
    let denied = request(&s, &session, json!({"action":"send","run_id":run["id"],"brief":"금지 후속"})).await;
    assert_eq!(denied["result"]["error"]["code"], "delegation_disabled");
    let (_, preserved) = s.get(&format!("/api/v1/agent-runs/{}", run["id"].as_str().unwrap())).await;
    assert_eq!(preserved["result"], "보존할 결과");
    assert_eq!(preserved["last_turn_id"], run["last_turn_id"]);

    setting(&s, "session", &session, ROLES, json!("reviewer")).await;
    let (status, disabled) = s.send(Method::PUT, "/api/v1/definitions/agent/reviewer", json!({"expected_revision":0,"enabled":false})).await;
    assert_eq!(status, StatusCode::OK, "{disabled}");
    assert_eq!(request(&s, &session, json!({"action":"send","run_id":run["id"],"brief":"비활성 역할"})).await["result"]["error"]["code"], "delegation_disabled");
    let (status, enabled) = s.send(Method::PUT, "/api/v1/definitions/agent/reviewer", json!({"expected_revision":1,"enabled":true})).await;
    assert_eq!(status, StatusCode::OK, "{enabled}");
    setting(&s, "server", "-", "agents.delegation", json!("ask")).await;
    let inherited = setting(&s, "session", child, "agents.delegation", json!("auto")).await;
    assert_eq!(inherited["effective"], "ask", "자식 auto로 부모 승인을 생략하지 않는다");
    let (status, pending) = s.post(&format!("/api/v1/sessions/{session}/tool-requests"), json!({"name":"agent","args":{"action":"send","run_id":run["id"],"brief":"후속 승인 철회"}})).await;
    assert_eq!(status, StatusCode::CREATED, "{pending}");
    assert_eq!(pending["status"], "pending_approval");
    setting(&s, "session", &session, MODE, json!("solo")).await;
    let (status, value) = s.post(&format!("/api/v1/tool-calls/{}/decision", pending["id"].as_str().unwrap()), json!({"decision":"approve","expected_revision":pending["revision"]})).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let denied = tool_done(&s, pending["id"].as_str().unwrap()).await;
    assert_eq!(denied["result"]["error"]["code"], "delegation_disabled");

    setting(&s, "session", &session, MODE, Value::Null).await;
    setting(&s, "server", "-", "agents.delegation", json!("auto")).await;
    f.push_for(CHILD, fixture::hang_after("대기"));
    let sent = request(&s, &session, json!({"action":"send","run_id":run["id"],"brief":"실행 중 취소"})).await;
    assert_eq!(sent["status"], "succeeded", "{sent}");
    let running = run_status(&s, &session, "running").await;
    s.wait_status(running["last_turn_id"].as_str().unwrap(), "running").await;
    setting(&s, "server", "-", "agents.delegation", json!("off")).await;
    setting(&s, "server", "-", MODE, json!("solo")).await;
    assert_eq!(request(&s, &session, json!({"action":"cancel","run_id":run["id"]})).await["status"], "succeeded");
    let cancelled = run_status(&s, &session, "cancelled").await;
    assert_eq!(cancelled["id"], run["id"]);
    let (_, messages) = s.get(&format!("/api/v1/sessions/{session}/messages")).await;
    let notes: Vec<_> = messages["items"].as_array().unwrap().iter().filter(|m| m["content"]["type"] == "agent_result").collect();
    assert_eq!(notes.len(), 2, "{messages}");
    assert_eq!(notes[0]["content"]["text"], "보존할 결과");
}

#[tokio::test]
async fn withdrawn_policy_survives_restart_without_replaying_work() {
    let (mut s, f, profile, _project, session) = setup().await;
    setting(&s, "server", "-", "agents.delegation", json!("auto")).await;
    f.push(fixture::tool_calls(&[("start", "agent", json!({"action":"spawn","agent_id":"reviewer","brief":"복구"}))]));
    f.push(fixture::hang_after("부모 대기"));
    f.push_for(CHILD, fixture::hang_after("자식 대기"));
    let id = turn(&s, &session, &profile).await;
    let run = run_status(&s, &session, "running").await;
    s.wait_status(run["last_turn_id"].as_str().unwrap(), "running").await;
    setting(&s, "server", "-", MODE, json!("solo")).await;
    setting(&s, "server", "-", ROLES, json!("")).await;
    s.restart().await;
    let (_, parent) = s.get(&format!("/api/v1/turns/{id}")).await;
    assert_eq!(parent["status"], "interrupted");
    let recovered = run_status(&s, &session, "interrupted").await;
    assert_eq!(recovered["last_turn_id"], run["last_turn_id"]);
    assert!(available(&s, &session).await.is_empty());
    assert_eq!(request(&s, &session, json!({"action":"status","run_id":run["id"]})).await["result"]["status"], "interrupted");
    assert_eq!(request(&s, &session, json!({"action":"send","run_id":run["id"],"brief":"재실행 금지"})).await["result"]["error"]["code"], "delegation_disabled");
    let (_, turns) = s.get(&format!("/api/v1/sessions/{}/turns", run["child_session_id"].as_str().unwrap())).await;
    assert_eq!(turns.as_array().unwrap().len(), 1);
}

/// 실행 claim 뒤 transaction에 들어오기 전 철회도 막아야 한다. 외부 실행기를 거치지 않고
/// 실행 중인 실제 호출을 execute_tool에 넘겨 두 번째 권한 경계를 직접 검증한다.
#[tokio::test]
async fn spawn_transaction_rechecks_withdrawal_and_auto_to_ask_after_claim() {
    let (s, f, profile, project, session) = setup().await;
    setting(&s, "server", "-", "agents.delegation", json!("auto")).await;
    f.push(fixture::hang_after("부모 실행 중"));
    let turn_id = turn(&s, &session, &profile).await;
    s.wait_status(&turn_id, "running").await;
    for (key, value, expected) in [(ROLES, json!(""), "delegation_disabled"), ("agents.delegation", json!("ask"), "approval_revoked")] {
        let app = s.server.as_ref().unwrap().app.clone();
        let (sid, pid, tid, now) = (session.clone(), project.clone(), turn_id.clone(), app.now());
        let call = app.db.call(move |c| {
            let tx = c.transaction()?;
            let root = grove::sessions::exec_root(&tx, &sid)?;
            let call = grove::approvals::create_call(&tx, &now, 1800, &sid, &pid, &root, Some(&tid), None, "agent",
                &json!({"action":"spawn","agent_id":"reviewer","brief":"claim 뒤 정책 변경"}))?;
            assert_eq!(call.status, "approved");
            tx.execute("UPDATE tool_calls SET status='running' WHERE id=?1", [&call.id])?;
            let call = grove::approvals::get(&tx, &call.id)?;
            tx.commit()?;
            Ok(call)
        }).await.unwrap();
        setting(&s, "server", "-", key, value).await;
        let (_cancel, rx) = tokio::sync::watch::channel(false);
        let error = grove::agents::execute_tool(&app, &call, rx).await.unwrap_err();
        assert_eq!(error.code, expected);
        assert!(runs(&s, &session).await.is_empty());
        let (id, now) = (call.id, app.now());
        app.db.call(move |c| {
            grove::approvals::finish(c, &now, &id, &["running"], "failed", Some(error.to_json()))?;
            Ok(())
        }).await.unwrap();
        setting(&s, "server", "-", key, Value::Null).await;
        setting(&s, "server", "-", "agents.delegation", json!("auto")).await;
    }
    s.post(&format!("/api/v1/turns/{turn_id}/cancel"), json!({})).await;
}

#[tokio::test]
async fn solo_helpers_use_role_model_reject_writes_and_do_not_delegate() {
    let (s, main, profile, project, session)=setup().await;
    let aux=Fixture::start().await;
    let model=s.fixture_profile(&aux.base).await;
    setting(&s,"project",&project,MODE,json!("solo")).await;
    setting(&s,"project",&project,"agents.delegation",json!("auto")).await;
    setting(&s,"server","-","agents.profile.context-explorer",json!({"profile_id":model,"model":"helper-small"})).await;
    assert_eq!(available(&s,&session).await,["context-explorer","failure-analyst","handoff-summarizer"]);
    main.push(fixture::tool_calls(&[("start","agent",json!({"action":"spawn","agent_id":"context-explorer","brief":"읽기만 해줘"}))]));
    main.push(fixture::text("기본 보조 역할 접수"));
    main.push(fixture::text("보조 결과 확인 완료"));
    aux.push(fixture::tool_calls(&[("write","write",json!({"path":"helper-must-not-write.txt","content":"forbidden"})),
        ("nested","agent",json!({"action":"spawn","agent_id":"failure-analyst","brief":"재귀 호출 금지"}))]));
    aux.push(fixture::text("읽기 전용 결과"));
    let parent=turn(&s,&session,&profile).await;
    s.wait_status(&parent,"completed").await;
    let run=run_status(&s,&session,"completed").await;
    assert_eq!(run["profile_id"],model);
    let child=run["child_session_id"].as_str().unwrap();
    let done=s.wait_status(run["last_turn_id"].as_str().unwrap(),"completed").await;
    assert_eq!(done["definition"]["model_selection"]["model"],"helper-small");
    assert!(aux.requests().iter().all(|request| request["model"]=="helper-small"));
    let calls=done["tool_calls"].as_array().unwrap();
    assert_eq!(calls.iter().find(|c|c["provider_call_id"]=="write").unwrap()["result"]["error"]["code"],"read_only");
    assert_eq!(calls.iter().find(|c|c["provider_call_id"]=="nested").unwrap()["result"]["error"]["code"],"read_only");
    assert!(available(&s,child).await.is_empty());
    let (_,p)=s.get(&format!("/api/v1/projects/{project}")).await;
    assert!(!std::path::Path::new(p["root_path"].as_str().unwrap()).join("helper-must-not-write.txt").exists());
    // 후속 요청의 모델 변경도 다음 자식 턴부터 적용한다.
    setting(&s,"server","-","agents.profile.context-explorer",json!({"profile_id":profile,"model":"helper-followup"})).await;
    main.push(fixture::text("새 모델로 후속 확인"));
    assert_eq!(request(&s,&session,json!({"action":"send","run_id":run["id"],"brief":"다시 읽기"})).await["status"],"succeeded");
    let run=run_status(&s,&session,"completed").await;
    assert_eq!(run["profile_id"],profile);
    let done=s.wait_status(run["last_turn_id"].as_str().unwrap(),"completed").await;
    assert_eq!(done["definition"]["model_selection"]["model"],"helper-followup");
    assert_eq!(main.requests().last().unwrap()["model"],"helper-followup");
}
