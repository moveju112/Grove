use crate::common;

use common::{TestServer, fixture::{self, Fixture}};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn bot(s: &TestServer, pid: &str, profile: &str, name: &str) -> Value {
    let (status, b) = s.post("/api/v1/bots", json!({"name":name,"project_id":pid,"profile_id":profile,"persona":format!("persona-{name}")})).await;
    assert_eq!(status, StatusCode::CREATED, "{b}");
    b
}

async fn group(s: &TestServer, pid: &str, bots: &[&Value]) -> Value {
    let ids: Vec<_> = bots.iter().map(|b| b["id"].clone()).collect();
    let (status, room) = s.post("/api/v1/bot-rooms", json!({"name":"작업 그룹","project_id":pid,"member_ids":ids})).await;
    assert_eq!(status, StatusCode::CREATED, "{room}");
    room
}

async fn finished_turns(s: &TestServer, sid: &str, count: usize) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let (_, turns) = s.get(&format!("/api/v1/sessions/{sid}/turns")).await;
            let list = turns.as_array().unwrap();
            if list.len() == count && list.iter().all(|t| t["status"] == "completed") { return turns; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap()
}

#[tokio::test]
async fn mentioned_bots_reply_in_order_share_history_and_replay_does_not_duplicate_work() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("rooms").await;
    let pid = p["id"].as_str().unwrap();
    let a = bot(&s, pid, &profile, "설계 봇").await;
    let b = bot(&s, pid, &profile, "검토").await;
    let room = group(&s, pid, &[&a, &b]).await;
    let sid = room["session_id"].as_str().unwrap();
    assert!(f.requests().is_empty());
    f.push(fixture::text("첫 설계의 고유 내용"));
    f.push(fixture::text("설계를 검토했어요"));
    let key = s.key();
    let body = json!({"text":"@{설계 봇} @검토 @검토 함께 확인","profile_id":"ignored"});
    let path = format!("/api/v1/sessions/{sid}/turns");
    let first = s.raw(Method::POST, &path, Some(body.clone()), Some(&key), None).await;
    assert_eq!(first.status(), StatusCode::ACCEPTED);
    let first: Value = first.json().await.unwrap();
    finished_turns(&s, sid, 2).await;
    let replay = s.raw(Method::POST, &path, Some(body), Some(&key), None).await;
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    assert_eq!(replay.json::<Value>().await.unwrap(), first);
    let requests = f.requests();
    assert_eq!(requests.len(), 2);
    assert!(requests[0]["messages"][0]["content"].as_str().unwrap().contains("persona-설계 봇"));
    assert!(requests[1]["messages"][0]["content"].as_str().unwrap().contains("persona-검토"));
    assert!(requests[1].to_string().contains("첫 설계의 고유 내용"));
    let (_, messages) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let messages = messages["items"].as_array().unwrap();
    assert_eq!(messages.iter().filter(|m| m["role"] == "user").count(), 1);
    let names: Vec<_> = messages.iter().filter(|m| m["role"] == "assistant").map(|m| m["content"]["bot"]["name"].clone()).collect();
    assert_eq!(names, vec![json!("설계 봇"),json!("검토")]);
    let (status, rooms) = s.get("/api/v1/bot-rooms").await;
    assert_eq!(status, StatusCode::OK, "{rooms}");
    assert_eq!(rooms[0], room);
    assert_eq!(s.get(&format!("/api/v1/sessions/{sid}/bot-room")).await.1, room);
}

#[tokio::test]
async fn only_addressed_bots_run_and_default_is_the_first_member() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("recipients").await;
    let pid = p["id"].as_str().unwrap();
    let a = bot(&s, pid, &profile, "가").await;
    let b = bot(&s, pid, &profile, "가나다").await;
    let room = group(&s, pid, &[&a, &b]).await;
    let sid = room["session_id"].as_str().unwrap();
    for (text, expected) in [("@가나다 확인", &b), ("메일 a@example.com을 설명해", &a)] {
        f.push(fixture::text("답변"));
        let (status, turn) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":text,"profile_id":"ignored"})).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{turn}");
        let turn = s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
        assert_eq!(turn["definition"]["bot"]["id"], expected["id"]);
    }
    let before = f.requests().len();
    for text in ["@없는봇 실행", "@{가나다 실행", "@가나다suffix 실행"] {
        let (status, _) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":text,"profile_id":profile})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    assert_eq!(f.requests().len(), before);
}

#[tokio::test]
async fn project_boundaries_invalid_members_and_device_auth_are_enforced() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("one").await;
    let q = s.create_project("two").await;
    let pid = p["id"].as_str().unwrap();
    let a = bot(&s, pid, &profile, "one").await;
    let b = bot(&s, pid, &profile, "two").await;
    let foreign = bot(&s, q["id"].as_str().unwrap(), &profile, "foreign").await;
    for ids in [json!([a["id"]]),json!([a["id"],a["id"]]),json!([a["id"],foreign["id"]])] {
        assert_eq!(s.post("/api/v1/bot-rooms", json!({"name":"invalid","project_id":pid,"member_ids":ids})).await.0, StatusCode::BAD_REQUEST);
    }
    let room = group(&s, pid, &[&a, &b]).await;
    let (status, error) = s.post(&format!("/api/v1/projects/{pid}/schedules"),json!({
        "name":"그룹 예약","prompt":"함께 확인","profile_id":profile,"kind":"interval","interval_minutes":600,
        "session_mode":"same","session_id":room["session_id"],
    })).await;
    assert_eq!(status,StatusCode::BAD_REQUEST,"{error}");
    assert!(error["error"]["message"].as_str().unwrap().contains("담당 봇"));
    let (status, error) = s.send(Method::PATCH, &format!("/api/v1/bots/{}",a["id"].as_str().unwrap()),
        json!({"expected_revision":a["revision"],"name":"one","profile_id":profile,"project_id":q["id"]})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["error"]["code"], "project_locked");
    let ordinary = s.create_session(pid).await;
    assert_eq!(s.get(&format!("/api/v1/sessions/{}/bot-room",ordinary["id"].as_str().unwrap())).await.1, Value::Null);
    assert_eq!(s.raw(Method::GET,"/api/v1/bot-rooms",None,None,Some("")).await.status(), StatusCode::UNAUTHORIZED);
    assert!(f.requests().is_empty());
    assert_eq!(room["members"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn cancel_stops_the_remaining_recipients_and_restart_does_not_replay_them() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("stop").await;
    let pid = p["id"].as_str().unwrap();
    let a = bot(&s, pid, &profile, "첫째").await;
    let b = bot(&s, pid, &profile, "둘째").await;
    let room = group(&s, pid, &[&a,&b]).await;
    let sid = room["session_id"].as_str().unwrap();
    f.push(fixture::slow_text(&["긴", "답", "변"], 600));
    let (_, turn) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"@첫째 @둘째 확인","profile_id":"ignored"})).await;
    let tid = turn["turn"]["id"].as_str().unwrap();
    s.wait_status(tid, "running").await;
    assert!(s.post(&format!("/api/v1/turns/{tid}/cancel"),json!({})).await.0.is_success());
    s.wait_status(tid, "cancelled").await;
    s.restart().await;
    let turns = s.get(&format!("/api/v1/sessions/{sid}/turns")).await.1;
    assert_eq!(turns.as_array().unwrap().len(), 1);
    assert_eq!(s.get(&format!("/api/v1/sessions/{sid}/bot-room")).await.1, room);
    let c = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    assert_eq!(c.query_row("SELECT status FROM bot_room_dispatches",[],|r|r.get::<_,String>(0)).unwrap(),"stopped");
    assert_eq!(c.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}

#[tokio::test]
async fn disabling_a_waiting_member_preserves_the_completed_reply_and_reports_the_stop() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("disabled").await;
    let pid = p["id"].as_str().unwrap();
    let a = bot(&s, pid, &profile, "먼저").await;
    let b = bot(&s, pid, &profile, "나중").await;
    let room = group(&s, pid, &[&a,&b]).await;
    let sid = room["session_id"].as_str().unwrap();
    f.push(fixture::slow_text(&["첫", "답"], 300));
    let (_, t) = s.post(&format!("/api/v1/sessions/{sid}/turns"),json!({"text":"@먼저 @나중 확인","profile_id":"ignored"})).await;
    let tid = t["turn"]["id"].as_str().unwrap();
    s.wait_status(tid,"running").await;
    assert_eq!(s.post(&format!("/api/v1/bots/{}/status",b["id"].as_str().unwrap()),json!({"expected_revision":b["revision"],"action":"disable"})).await.0,StatusCode::OK);
    s.wait_status(tid,"completed").await;
    let (_, m) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert!(m["items"].as_array().unwrap().iter().any(|m|m["content"]["type"]=="bot_room_stopped"));
    assert_eq!(s.get(&format!("/api/v1/sessions/{sid}/turns")).await.1.as_array().unwrap().len(),1);
}

#[tokio::test]
async fn approval_survives_restart_and_only_then_allows_the_next_member_to_reply() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("room-approval").await;
    let pid = p["id"].as_str().unwrap();
    let a = bot(&s,pid,&profile,"작업").await;
    let b = bot(&s,pid,&profile,"검사").await;
    let room = group(&s,pid,&[&a,&b]).await;
    let sid = room["session_id"].as_str().unwrap();
    f.push(fixture::tool_calls(&[("shell","shell",json!({"command":"printf room-approved"}))]));
    f.push(fixture::text("승인 뒤 작업 완료"));
    f.push(fixture::text("다음 봇 확인"));
    let (status,t) = s.post(&format!("/api/v1/sessions/{sid}/turns"),json!({"text":"@작업 @검사 확인","profile_id":"ignored","tools":true})).await;
    assert_eq!(status,StatusCode::ACCEPTED,"{t}");
    let tid = t["turn"]["id"].as_str().unwrap();
    let waiting = s.wait_status(tid,"awaiting_approval").await;
    assert_eq!(f.requests().len(),1,"승인 전 다음 봇은 실행하지 않는다");
    let call = &waiting["tool_calls"][0];
    s.restart().await;
    assert_eq!(s.get(&format!("/api/v1/turns/{tid}")).await.1["status"],"awaiting_approval");
    let (status,response) = s.post(&format!("/api/v1/tool-calls/{}/decision",call["id"].as_str().unwrap()),
        json!({"decision":"approve","expected_revision":call["revision"]})).await;
    assert_eq!(status,StatusCode::OK,"{response}");
    finished_turns(&s,sid,2).await;
    assert_eq!(f.requests().len(),3);
}

#[tokio::test]
async fn queued_mentions_use_the_recipient_model_and_cannot_steer_a_different_bot() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("room-followup").await;
    let pid = p["id"].as_str().unwrap();
    let a = bot(&s,pid,&profile,"현재").await;
    let b = bot(&s,pid,&profile,"다음").await;
    let room = group(&s,pid,&[&a,&b]).await;
    let sid = room["session_id"].as_str().unwrap();
    let (step,release) = fixture::gated_text("첫 답변");
    f.push(step);
    f.push(fixture::text("대기한 봇의 답변"));
    let (_,turn) = s.post(&format!("/api/v1/sessions/{sid}/turns"),json!({"text":"@현재 확인","profile_id":"ignored"})).await;
    s.wait_status(turn["turn"]["id"].as_str().unwrap(),"running").await;
    let path = format!("/api/v1/sessions/{sid}/followups");
    let body = json!({"kind":"steer","text":"@다음 확인","profile_id":"ignored"});
    let (status,error) = s.post(&path,body).await;
    assert_eq!(status,StatusCode::BAD_REQUEST,"{error}");
    let (status,queued) = s.post(&path,json!({"kind":"queue","text":"@다음 확인","profile_id":"ignored"})).await;
    assert_eq!(status,StatusCode::CREATED,"{queued}");
    release.send(true).unwrap();
    let turns = finished_turns(&s,sid,2).await;
    assert!(turns.as_array().unwrap().iter().any(|t|t["definition"]["bot"]["id"]==b["id"]));
    assert!(f.requests()[1]["messages"][0]["content"].as_str().unwrap().contains("persona-다음"));
}
