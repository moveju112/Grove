//! 봇(BOT-001, 002, 004~008)
mod common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};

async fn bot(s: &TestServer, pid: &str, name: &str, profile: Option<&str>, persona: &str) -> Value {
    let (st, v) = s.post("/api/v1/bots", json!({ "name": name, "project_id": pid, "profile_id": profile, "persona": persona, "description": "설명" })).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    v
}

async fn home(s: &TestServer, id: &str) -> String {
    let (st, v) = s.post(&format!("/api/v1/bots/{id}/home"), json!({})).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    v["home_session_id"].as_str().unwrap().to_string()
}

async fn status(s: &TestServer, id: &str, action: &str) -> (StatusCode, Value) {
    let (_, cur) = s.get(&format!("/api/v1/bots/{id}")).await;
    s.post(&format!("/api/v1/bots/{id}/status"), json!({ "expected_revision": cur["revision"], "action": action })).await
}

fn system_prompt(req: &Value) -> String {
    req["messages"][0]["content"].as_str().unwrap_or_default().to_string()
}

#[tokio::test]
async fn home_is_unique_across_concurrent_opens_and_restart_and_needs_model() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("b").await;
    let pid = p["id"].as_str().unwrap();
    let b = bot(&s, pid, "도우미", None, "친절하다").await;
    let id = b["id"].as_str().unwrap().to_string();
    assert_eq!(b["runnable"], false, "모델 미설정");
    assert!(b["home_session_id"].is_null(), "생성만으로 대화를 만들지 않는다");
    // 여러 기기가 동시에 열어도 home은 하나
    let mut hs = vec![];
    for _ in 0..6 {
        hs.push(home(&s, &id));
    }
    let ids: Vec<String> = futures_util::future::join_all(hs).await;
    assert!(ids.iter().all(|x| x == &ids[0]), "{ids:?}");
    let sid = ids[0].clone();
    // 위임 역할 목록과 섞이지 않는다
    let (_, defs) = s.get("/api/v1/definitions?kind=agent").await;
    assert!(defs.as_array().unwrap().iter().all(|d| d["name"] != "도우미"));
    // 모델 없이 보내면 실행 불가, 모델 호출 없음
    let (st, e) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "안녕", "profile_id": prof })).await;
    assert_eq!(st, StatusCode::CONFLICT, "{e}");
    assert_eq!(e["error"]["code"], "model_not_configured");
    assert!(f.requests().is_empty(), "생성·열기·거부된 요청은 모델을 부르지 않는다");
    // 재시작 뒤에도 같은 home
    s.restart().await;
    assert_eq!(home(&s, &id).await, sid);
}

#[tokio::test]
async fn persona_and_model_changes_apply_from_next_turn() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("b").await;
    let pid = p["id"].as_str().unwrap();
    let b = bot(&s, pid, "해적", Some(&prof), "PERSONA-ONE").await;
    let id = b["id"].as_str().unwrap().to_string();
    let sid = home(&s, &id).await;
    // 요청 본문의 프로필·에이전트는 무시하고 봇 설정을 쓴다
    f.push(fixture::slow_text(&["아", "호"], 300));
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "첫", "profile_id": "ignored", "agent_id": "worker" })).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let t1 = v["turn"]["id"].as_str().unwrap().to_string();
    s.wait_status(&t1, "running").await;
    let (_, bv) = s.get(&format!("/api/v1/bots/{id}")).await;
    assert_eq!(bv["home_status"], "running");
    // 실행 중 persona 변경
    let (_, cur) = s.get(&format!("/api/v1/bots/{id}")).await;
    let (st, u) = s
        .send(reqwest::Method::PATCH, &format!("/api/v1/bots/{id}"), json!({ "expected_revision": cur["revision"], "name": "해적", "project_id": pid, "profile_id": prof, "persona": "PERSONA-TWO" }))
        .await;
    assert_eq!(st, StatusCode::OK, "{u}");
    let t1v = s.wait_status(&t1, "completed").await;
    assert_eq!(t1v["agent_id"], Value::Null);
    assert_eq!(t1v["definition"]["bot"]["persona"], "PERSONA-ONE", "진행 중 턴의 snapshot 유지");
    f.push(fixture::text("둘"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "둘", "profile_id": "ignored" })).await;
    let t2 = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(t2["definition"]["bot"]["persona"], "PERSONA-TWO");
    let reqs = f.requests();
    assert!(system_prompt(&reqs[0]).contains("PERSONA-ONE"));
    assert!(system_prompt(&reqs[1]).contains("PERSONA-TWO") && !system_prompt(&reqs[1]).contains("PERSONA-ONE"));
    // 과거 메시지의 모델 기록은 그대로
    let (_, msgs) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let list = msgs["items"].as_array().or(msgs.as_array()).unwrap().clone();
    assert!(list.iter().filter(|m| m["role"] == "assistant").all(|m| m["content"]["model"].is_string()));
    // 미읽음: 읽음 위치 갱신 전에는 unread
    let (_, bv) = s.get(&format!("/api/v1/bots/{id}")).await;
    assert_eq!(bv["unread"], true);
    let (_, sess) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    s.post(&format!("/api/v1/bots/{id}/seen"), json!({ "seq": sess["last_message_seq"] })).await;
    let (_, bv) = s.get(&format!("/api/v1/bots/{id}")).await;
    assert_eq!(bv["unread"], false);
}

#[tokio::test]
async fn lifecycle_disable_reset_delete_restore_and_name_reuse() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("b").await;
    let pid = p["id"].as_str().unwrap();
    let b = bot(&s, pid, "비서", Some(&prof), "").await;
    let id = b["id"].as_str().unwrap().to_string();
    let sid = home(&s, &id).await;
    // 같은 이름 거부, 오래된 revision 거부
    let (st, e) = s.post("/api/v1/bots", json!({ "name": "비서", "project_id": pid })).await;
    assert_eq!((st, e["error"]["code"].clone()), (StatusCode::CONFLICT, json!("name_taken")));
    let (st, _) = s.send(reqwest::Method::PATCH, &format!("/api/v1/bots/{id}"), json!({ "expected_revision": 0, "name": "x", "project_id": pid })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    // 비활성화: 새 실행 거부, 대화는 유지
    let (st, _) = status(&s, &id, "disable").await;
    assert_eq!(st, StatusCode::OK);
    let (st, e) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "q", "profile_id": prof })).await;
    assert_eq!(e["error"]["code"], "bot_disabled", "{st}");
    status(&s, &id, "enable").await;
    // 실행 중에는 초기화 실패하고 원본 유지
    f.push(fixture::slow_text(&["a", "b", "c"], 300));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "q", "profile_id": prof })).await;
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    s.wait_status(&tid, "running").await;
    let (st, e) = status(&s, &id, "reset").await;
    assert_eq!(st, StatusCode::CONFLICT, "{e}");
    let (_, bv) = s.get(&format!("/api/v1/bots/{id}")).await;
    assert_eq!(bv["home_session_id"], sid.as_str());
    let (_, ss) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    assert!(ss["archived_at"].is_null());
    s.wait_status(&tid, "completed").await;
    // 초기화: 이전 대화는 보관, 다음 열기에서 새 대화
    let (st, r) = status(&s, &id, "reset").await;
    assert_eq!(st, StatusCode::OK, "{r}");
    assert!(r["home_session_id"].is_null());
    let (_, old) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    assert!(old["archived_at"].is_string(), "이력은 지우지 않고 보관");
    let sid2 = home(&s, &id).await;
    assert_ne!(sid2, sid);
    // 삭제: home 보관, 이름 재사용 가능, 새 봇은 이력을 승계하지 않음
    let (st, d) = status(&s, &id, "delete").await;
    assert_eq!(st, StatusCode::OK, "{d}");
    let (_, h2) = s.get(&format!("/api/v1/sessions/{sid2}")).await;
    assert!(h2["archived_at"].is_string());
    let nb = bot(&s, pid, "비서", Some(&prof), "").await;
    assert_ne!(nb["id"], id.as_str());
    assert!(nb["home_session_id"].is_null());
    let (st, e) = s.post(&format!("/api/v1/bots/{id}/home"), json!({})).await;
    assert_eq!(st, StatusCode::CONFLICT, "삭제된 봇은 열지 않는다: {e}");
    // 같은 이름이 있으면 복원 거부, 이름이 비면 복원되고 대화도 복원
    let (st, e) = status(&s, &id, "restore").await;
    assert_eq!((st, e["error"]["code"].clone()), (StatusCode::CONFLICT, json!("name_taken")));
    status(&s, nb["id"].as_str().unwrap(), "delete").await;
    let (st, r) = status(&s, &id, "restore").await;
    assert_eq!(st, StatusCode::OK, "{r}");
    let (_, h2) = s.get(&format!("/api/v1/sessions/{sid2}")).await;
    assert!(h2["archived_at"].is_null());
}

#[tokio::test]
async fn featured_is_single_and_order_uses_revision() {
    let s = TestServer::start().await;
    let p = s.create_project("b").await;
    let pid = p["id"].as_str().unwrap();
    let a = bot(&s, pid, "A", None, "").await;
    let b = bot(&s, pid, "B", None, "").await;
    let c = bot(&s, pid, "C", None, "").await;
    let (_, l) = s.get("/api/v1/bots").await;
    let rev = l["order_revision"].clone();
    let order = json!([c["id"], a["id"], b["id"]]);
    let (st, o) = s.post("/api/v1/bots/order", json!({ "expected_revision": rev, "ids": order })).await;
    assert_eq!(st, StatusCode::OK, "{o}");
    let (st, _) = s.post("/api/v1/bots/order", json!({ "expected_revision": rev, "ids": [a["id"]] })).await;
    assert_eq!(st, StatusCode::CONFLICT, "오래된 순서 revision");
    let (_, l) = s.get("/api/v1/bots").await;
    let names: Vec<&str> = l["bots"].as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["C", "A", "B"]);
    // 대표는 하나, 맨 앞
    for x in [&a, &b] {
        let (_, cur) = s.get(&format!("/api/v1/bots/{}", x["id"].as_str().unwrap())).await;
        s.send(reqwest::Method::PATCH, &format!("/api/v1/bots/{}", x["id"].as_str().unwrap()), json!({ "expected_revision": cur["revision"], "name": cur["name"], "project_id": pid, "featured": true })).await;
    }
    let (_, l) = s.get("/api/v1/bots").await;
    let featured: Vec<&str> = l["bots"].as_array().unwrap().iter().filter(|x| x["featured"] == true).map(|x| x["name"].as_str().unwrap()).collect();
    assert_eq!(featured, ["B"]);
    assert_eq!(l["bots"][0]["name"], "B");
}
