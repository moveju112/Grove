use crate::common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use common::fixture::{self, Fixture};

async fn receive_reply(s: &TestServer, fixture: &Fixture, profile: &str, session: &str, text: &str) -> String {
    fixture.push(fixture::text(text));
    let (status, accepted) = s.post(&format!("/api/v1/sessions/{session}/turns"), json!({ "text": text, "profile_id": profile, "tools": false })).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{accepted}");
    s.wait_status(accepted["turn"]["id"].as_str().unwrap(), "completed").await;
    let (_, messages) = s.get(&format!("/api/v1/sessions/{session}/messages")).await;
    messages["items"].as_array().unwrap().iter().rev().find(|m| m["role"] == "assistant").unwrap()["created_at"].as_str().unwrap().to_string()
}

async fn recent_session(s: &TestServer, session: &str) -> Value {
    let (status, recent) = s.get("/api/v1/recent").await;
    assert_eq!(status, StatusCode::OK, "{recent}");
    recent["items"].as_array().unwrap().iter().find(|item| item["resource_id"] == session).unwrap().clone()
}

fn layout_two(pa: &str, sa: &str, pb: &str, sb: &str, dir: &str) -> Value {
    json!({
        "schema": 1,
        "focused_leaf": "L2",
        "root": {
            "type": "split", "direction": dir, "ratio": 0.4,
            "children": [
                { "type": "leaf", "id": "L1", "active_tab": "t1", "tabs": [{ "id": "t1", "kind": "session", "project_id": pa, "resource_id": sa }] },
                { "type": "leaf", "id": "L2", "active_tab": "t2", "tabs": [{ "id": "t2", "kind": "session", "project_id": pb, "resource_id": sb }] }
            ]
        }
    })
}

/// START-004 / FLOW-12 서버 측: 두 프로젝트 세션을 최근 항목·분할로 저장하고 재시작 후 복원.
#[tokio::test]
async fn two_projects_recent_and_split_survive_restart() {
    let mut s = TestServer::start().await;
    let a = s.create_project("A").await;
    let b = s.create_project("B").await;
    let (pa, pb) = (a["id"].as_str().unwrap().to_string(), b["id"].as_str().unwrap().to_string());
    let sa = s.create_session(&pa).await["id"].as_str().unwrap().to_string();
    let sb = s.create_session(&pb).await["id"].as_str().unwrap().to_string();

    for (p, sid) in [(&pa, &sa), (&pb, &sb), (&pa, &sa)] {
        let (st, v) = s.post("/api/v1/recent/touch", json!({ "kind": "session", "project_id": p, "resource_id": sid })).await;
        assert_eq!(st, StatusCode::OK, "{v}");
    }
    let (_, recent) = s.get("/api/v1/recent").await;
    let items = recent["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "같은 자원 재열기는 중복 항목을 만들지 않는다");
    assert_eq!(items[0]["resource_id"], sb.as_str(), "답변이 없으면 생성 시각을 쓰고 다시 열어도 순서는 바뀌지 않는다");
    assert_eq!(items[0]["project_name"], "B");

    // 세션 B를 고정하면 맨 앞
    let rb = items.iter().find(|i| i["resource_id"] == sb.as_str()).unwrap();
    let (st, v) = s
        .send(Method::PATCH, &format!("/api/v1/recent/{}", rb["id"].as_str().unwrap()), json!({ "expected_revision": rb["revision"], "pinned": true }))
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let (_, recent) = s.get("/api/v1/recent").await;
    assert_eq!(recent["items"][0]["resource_id"], sb.as_str());
    let (_, pinned) = s.get("/api/v1/recent?filter=pinned").await;
    assert_eq!(pinned["items"].as_array().unwrap().len(), 1);
    let (_, found) = s.get("/api/v1/recent?q=b").await;
    assert_eq!(found["items"].as_array().unwrap().len(), 1);

    // 좌우 분할 저장 → 위아래로 변경 → 재시작 후 복원
    let (st, v) = s.send(Method::PUT, "/api/v1/layouts/pc-1", json!({ "expected_revision": 0, "layout": layout_two(&pa, &sa, &pb, &sb, "row") })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let (st, _) = s.send(Method::PUT, "/api/v1/layouts/pc-1", json!({ "expected_revision": 1, "layout": layout_two(&pa, &sa, &pb, &sb, "column") })).await;
    assert_eq!(st, StatusCode::OK);
    // 다른 기기(폰)는 PC 배치를 강제로 복사받지 않는다
    let (_, phone) = s.get("/api/v1/layouts/phone-1").await;
    assert!(phone["layout"].is_null());
    s.restart().await;
    let (_, l) = s.get("/api/v1/layouts/pc-1").await;
    assert_eq!(l["revision"], 2);
    assert_eq!(l["layout"]["root"]["direction"], "column");
    assert_eq!(l["layout"]["root"]["children"][1]["tabs"][0]["project_id"], pb.as_str());
    let (_, recent) = s.get("/api/v1/recent").await;
    assert_eq!(recent["items"][0]["pinned"], true);
}

#[tokio::test]
async fn terminals_are_not_recorded_or_listed_as_recent() {
    let s = TestServer::start().await;
    let project = s.create_project("terminal-recent").await;
    let pid = project["id"].as_str().unwrap();
    let (status, response) = s.post("/api/v1/recent/touch", json!({
        "kind": "terminal", "project_id": pid, "resource_id": "new-terminal",
    })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");

    let session = s.create_session(pid).await;
    let (status, response) = s.post("/api/v1/recent/touch", json!({
        "kind": "session", "project_id": pid, "resource_id": session["id"],
    })).await;
    assert_eq!(status, StatusCode::OK, "{response}");

    // 이전 버전에서 기록된 터미널은 고정되어 있어도 페이지에 포함하지 않는다.
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute(
        "INSERT INTO recent_items (id, kind, project_id, resource_id, title, last_access_at, pinned) \
         VALUES ('legacy-recent', 'terminal', ?1, 'legacy-terminal', 'Legacy terminal', '2026-01-01T00:00:00Z', 1)",
        [pid],
    ).unwrap();
    drop(db);

    let (status, page) = s.get("/api/v1/recent?limit=1").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["items"][0]["resource_id"], session["id"]);
    assert_eq!(page["total"], 1);
    assert!(page["next_offset"].is_null());
}

#[tokio::test]
async fn layout_validation_and_conflict() {
    let s = TestServer::start().await;
    let bad = [
        json!({ "schema": 2, "root": { "type": "leaf", "id": "a", "tabs": [] } }),
        json!({ "schema": 1, "root": { "type": "split", "direction": "diag", "ratio": 0.5, "children": [] } }),
        json!({ "schema": 1, "root": { "type": "split", "direction": "row", "ratio": 0.95, "children": [
            { "type": "leaf", "id": "a", "tabs": [] }, { "type": "leaf", "id": "b", "tabs": [] }] } }),
        json!({ "schema": 1, "root": { "type": "leaf", "id": "a", "tabs": [{ "id": "t", "kind": "session", "resource_id": "x" }] } }),
        json!({ "schema": 1, "root": { "type": "split", "direction": "row", "ratio": 0.5, "children": [
            { "type": "leaf", "id": "a", "tabs": [] }, { "type": "leaf", "id": "a", "tabs": [] }] } }),
    ];
    for l in bad {
        let (st, v) = s.send(Method::PUT, "/api/v1/layouts/d1", json!({ "expected_revision": 0, "layout": l })).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{v}");
    }
    let ok = json!({ "schema": 1, "root": { "type": "leaf", "id": "a", "tabs": [] } });
    let (st, _) = s.send(Method::PUT, "/api/v1/layouts/d1", json!({ "expected_revision": 0, "layout": ok })).await;
    assert_eq!(st, StatusCode::OK);
    let (st, v) = s.send(Method::PUT, "/api/v1/layouts/d1", json!({ "expected_revision": 0, "layout": ok })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["details"]["current"]["revision"], 1);
    let (st, _) = s.get("/api/v1/layouts/bad%20id").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn shared_workspace_tabs_resume_after_restart() {
    let mut s = TestServer::start().await;
    let project = s.create_project("shared").await;
    let project_id = project["id"].as_str().unwrap();
    let session = s.create_session(project_id).await;
    let key = format!("/api/v1/layouts/workspace-tabs-{project_id}");
    let resume = "/api/v1/layouts/workspace-resume";
    let layout = json!({
        "schema": 1, "focused_leaf": "workspace-tabs",
        "root": { "type": "leaf", "id": "workspace-tabs", "active_tab": "tab", "tabs": [
            { "id": "tab", "kind": "session", "project_id": project_id, "resource_id": session["id"], "title": "Shared" }
        ] }
    });
    let (_, empty) = s.get(resume).await;
    assert!(empty["layout"].is_null());
    let (status, _) = s.send(Method::PUT, resume, json!({ "expected_revision": 0, "layout": layout })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let mut wrong_project = layout.clone();
    wrong_project["root"]["tabs"][0]["project_id"] = json!("another-project");
    let (status, _) = s.send(Method::PUT, &key, json!({ "expected_revision": 0, "layout": wrong_project })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, result) = s.send(Method::PUT, &key, json!({ "expected_revision": 0, "layout": layout })).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    s.restart().await;
    let (_, resumed) = s.get(resume).await;
    assert_eq!(resumed["layout"], layout);
    assert_eq!(resumed["revision"], 1);
    let mut closed = layout.clone();
    closed["root"]["tabs"] = json!([]);
    closed["root"]["active_tab"] = Value::Null;
    let (status, _) = s.send(Method::PUT, &key, json!({ "expected_revision": 1, "layout": closed })).await;
    assert_eq!(status, StatusCode::OK);
    let (_, resumed) = s.get(resume).await;
    assert!(resumed["layout"].is_null());
}

/// 제거한 초안 API는 조회·저장 모두 제공하지 않는다.
#[tokio::test]
async fn draft_endpoints_are_not_available() {
    let s = TestServer::start().await;
    let p = s.create_project("p").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let key = format!("session:{sid}");
    for key in [key, format!("project:{}", p["id"].as_str().unwrap())] {
        let (st, _) = s.get(&format!("/api/v1/drafts/{key}")).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        let (st, _) = s.send(Method::PUT, &format!("/api/v1/drafts/{key}"), json!({ "expected_revision": 0, "text": "unused", "device_name": "pc" })).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
    }
}

/// RECENT-001: 마지막 사용자 메시지·확정 답변으로 정렬하고, 숨긴 뒤 새 사용자 메시지가 오면 다시 보이며,
/// 시간 범위 밖이어도 고정·진행 중 항목은 남는다.
#[tokio::test]
async fn recent_follows_last_activity_window_and_revives_hidden() {
    let s = TestServer::start().await;
    let fixture = Fixture::start().await;
    let profile = s.fixture_profile(&fixture.base).await;
    let pid = s.create_project("p").await["id"].as_str().unwrap().to_string();
    let a = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    let b = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    let (_, ia) = s.post("/api/v1/recent/touch", json!({ "kind": "session", "project_id": pid, "resource_id": a })).await;
    s.post("/api/v1/recent/touch", json!({ "kind": "session", "project_id": pid, "resource_id": b })).await;
    assert_eq!(ia["last_user_message_at"], Value::Null);
    let order = |list: &Value| list["items"].as_array().unwrap().iter().map(|i| i["resource_id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    let (_, list) = s.get("/api/v1/recent").await;
    assert_eq!(order(&list), [b.clone(), a.clone()]);
    // 보내면 그 시각부터 다시 센다.
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    s.post(&format!("/api/v1/sessions/{a}/messages"), json!({ "text": "a" })).await;
    let (_, list) = s.get("/api/v1/recent").await;
    assert_eq!(order(&list), [a.clone(), b.clone()]);
    assert_eq!(list["items"][0]["last_activity_at"], list["items"][0]["last_user_message_at"]);
    let answered_at = receive_reply(&s, &fixture, &profile, &a, "reply a").await;
    let (_, list) = s.get("/api/v1/recent").await;
    assert_eq!(order(&list), [a.clone(), b.clone()]);
    assert_eq!(list["items"][0]["last_activity_at"], answered_at);
    assert_eq!(list["items"][0]["last_access_at"], ia["last_access_at"]);

    // 숨김 → 새 사용자 메시지가 오면 다시 보인다.
    let ia = &list["items"][0];
    let (st, hidden) = s.send(Method::PATCH, &format!("/api/v1/recent/{}", ia["id"].as_str().unwrap()), json!({ "expected_revision": ia["revision"], "hidden": true })).await;
    assert_eq!(st, StatusCode::OK, "{hidden}");
    assert_eq!(hidden["hidden"], true);
    let (_, list) = s.get("/api/v1/recent").await;
    assert_eq!(order(&list), [b.clone()]);
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    s.post(&format!("/api/v1/sessions/{a}/messages"), json!({ "text": "again" })).await;
    let (_, list) = s.get("/api/v1/recent").await;
    assert_eq!(order(&list), [a.clone(), b.clone()]);
    assert_eq!(list["items"][0]["hidden"], false);
    assert_eq!(list["items"][0]["last_activity_at"], list["items"][0]["last_user_message_at"], "새 메시지가 마지막 활동이 된다");
    assert_ne!(list["items"][0]["last_activity_at"], answered_at);

    // 시간 범위: 미래 시각 이후 활동은 없으므로 고정 항목만 남는다. 잘못된 시각은 거절한다.
    let ib = list["items"].as_array().unwrap().iter().find(|i| i["resource_id"] == b.as_str()).unwrap().clone();
    s.send(Method::PATCH, &format!("/api/v1/recent/{}", ib["id"].as_str().unwrap()), json!({ "expected_revision": ib["revision"], "pinned": true })).await;
    let (_, list) = s.get("/api/v1/recent?since=2999-01-01T00:00:00Z").await;
    assert_eq!(order(&list), [b.clone()]);
    let (_, list) = s.get("/api/v1/recent?since=2000-01-01T00:00:00Z").await;
    assert_eq!(order(&list), [b.clone(), a.clone()], "고정 먼저");
    let (st, _) = s.get("/api/v1/recent?since=yesterday").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    // 숨긴 시각이 없는 이전 숨김은 새 메시지가 와도 다시 열 때까지 유지한다.
    let aid = a.clone();
    s.server.as_ref().unwrap().app.db.call(move |c| {
        c.execute("UPDATE recent_items SET hidden = 1, hidden_at = NULL WHERE resource_id = ?1", [&aid])?;
        Ok(())
    }).await.unwrap();
    s.post(&format!("/api/v1/sessions/{a}/messages"), json!({ "text": "legacy" })).await;
    let (_, list) = s.get("/api/v1/recent").await;
    assert_eq!(order(&list), [b.clone()]);
    let (_, reopened) = s.post("/api/v1/recent/touch", json!({ "kind": "session", "project_id": pid, "resource_id": a })).await;
    assert_eq!(reopened["hidden"], false);
}

#[tokio::test]
async fn background_recent_touch_keeps_closed_session_hidden_until_explicit_reopen() {
    let s = TestServer::start().await;
    let pid = s.create_project("closed-recent").await["id"].as_str().unwrap().to_string();
    let sid = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": "keep history" })).await;
    let (_, item) = s.post("/api/v1/recent/touch", json!({ "kind": "session", "project_id": pid, "resource_id": sid })).await;
    let (status, hidden) = s.send(Method::PATCH, &format!("/api/v1/recent/{}", item["id"].as_str().unwrap()),
        json!({ "expected_revision": item["revision"], "hidden": true, "pinned": true })).await;
    assert_eq!(status, StatusCode::OK, "{hidden}");
    let (status, read) = s.post("/api/v1/recent/touch", json!({
        "kind": "session", "project_id": pid, "resource_id": sid,
        "reopen": false, "view_state": { "last_seen_seq": 1 },
    })).await;
    assert_eq!(status, StatusCode::OK, "{read}");
    assert_eq!(read["hidden"], true);
    assert_eq!(read["pinned"], true);
    assert_eq!(read["view_state"]["last_seen_seq"], 1);
    let (_, list) = s.get("/api/v1/recent").await;
    assert!(list["items"].as_array().unwrap().is_empty());
    let (_, reopened) = s.post("/api/v1/recent/touch", json!({ "kind": "session", "project_id": pid, "resource_id": sid })).await;
    assert_eq!(reopened["hidden"], false);
    assert_eq!(reopened["pinned"], true);
}

#[tokio::test]
async fn recent_changes_at_send_and_reply_not_open_or_tool_events() {
    let mut s = TestServer::start().await;
    let fixture = Fixture::start().await;
    let profile = s.fixture_profile(&fixture.base).await;
    let pid = s.create_project("reply-clock").await["id"].as_str().unwrap().to_string();
    let a = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    let b = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    for sid in [&a, &b] {
        s.post("/api/v1/recent/touch", json!({ "kind": "session", "project_id": pid, "resource_id": sid })).await;
    }
    let first_reply = receive_reply(&s, &fixture, &profile, &a, "first reply").await;
    let second_reply = receive_reply(&s, &fixture, &profile, &b, "second reply").await;
    let (_, opened) = s.post("/api/v1/recent/touch", json!({ "kind": "session", "project_id": pid, "resource_id": a })).await;
    assert_eq!(opened["last_activity_at"], first_reply);
    let (_, list) = s.get("/api/v1/recent").await;
    assert_eq!(list["items"][0]["resource_id"], b);
    assert_eq!(list["items"][0]["last_activity_at"], second_reply);

    let (step, release) = fixture::gated_text("latest reply");
    fixture.push(step);
    let (status, accepted) = s.post(&format!("/api/v1/sessions/{a}/turns"), json!({ "text": "wait for reply", "profile_id": profile, "tools": false })).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{accepted}");
    s.wait_status(accepted["turn"]["id"].as_str().unwrap(), "running").await;
    let (_, list) = s.get("/api/v1/recent").await;
    assert_eq!(list["items"][0]["resource_id"], a, "전송하면 그 시각부터 다시 센다");
    let during = &list["items"][0];
    assert_eq!(during["last_activity_at"], during["last_user_message_at"]);
    let sent_at = during["last_activity_at"].as_str().unwrap().to_string();
    let before_release = grove::util::fmt_time(s.server.as_ref().unwrap().app.clock.now());
    release.send(true).unwrap();
    s.wait_status(accepted["turn"]["id"].as_str().unwrap(), "completed").await;
    let (_, list) = s.get("/api/v1/recent").await;
    let answered_at = list["items"][0]["last_activity_at"].as_str().unwrap().to_string();
    assert_eq!(list["items"][0]["resource_id"], a);
    assert!(grove::util::parse_time(&answered_at).unwrap() >= grove::util::parse_time(&before_release).unwrap());
    assert_ne!(list["items"][0]["last_activity_at"], list["items"][0]["last_user_message_at"]);

    // 도구·상태 알림과 본문 없는 assistant 메시지는 채팅 답변이 아니다.
    let sid = a.clone();
    let now = grove::util::fmt_time(s.server.as_ref().unwrap().app.clock.now());
    s.server.as_ref().unwrap().app.db.call(move |c| {
        let tx = c.transaction()?;
        for (role, content) in [("tool", json!({ "text": "tool result" })), ("note", json!({ "text": "status" })), ("assistant", json!({ "text": " \n", "tool_calls": [] }))] {
            grove::sessions::append_message(&tx, &now, &sid, role, &content, None, None)?;
        }
        tx.commit()?;
        Ok(())
    }).await.unwrap();
    s.restart().await;
    let (_, list) = s.get("/api/v1/recent").await;
    assert_eq!(list["items"][0]["last_activity_at"], answered_at, "재시작과 비답변 메시지도 시각을 바꾸지 않는다");
    let sid = a.clone();
    s.server.as_ref().unwrap().app.db.call(move |c| {
        c.execute("UPDATE messages SET rewound_at = ?2 WHERE session_id = ?1 AND role = 'assistant' AND created_at = ?2", rusqlite::params![sid, answered_at])?;
        Ok(())
    }).await.unwrap();
    let (_, list) = s.get("/api/v1/recent").await;
    assert_eq!(list["items"][0]["resource_id"], a);
    assert_eq!(list["items"][0]["last_activity_at"], sent_at, "되돌린 답변은 제외한다");
}

#[tokio::test]
async fn recent_status_reflects_archived_and_hidden() {
    let s = TestServer::start().await;
    let p = s.create_project("p").await;
    let pid = p["id"].as_str().unwrap();
    let sess = s.create_session(pid).await;
    let sid = sess["id"].as_str().unwrap();
    let (_, item) = s.post("/api/v1/recent/touch", json!({ "kind": "session", "project_id": pid, "resource_id": sid })).await;
    assert_eq!(item["status"], "active");
    assert_eq!(item["unread"], false);
    for filter in ["all", "pinned", "running", "awaiting_approval", "awaiting_input", "unread", "hidden"] {
        let (st, page) = s.get(&format!("/api/v1/recent?filter={filter}")).await;
        assert_eq!(st, StatusCode::OK, "{filter}: {page}");
        assert!(page["items"].is_array(), "{filter}: {page}");
    }
    s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": "new" })).await;
    let (_, unread) = s.get("/api/v1/recent?filter=unread").await;
    assert_eq!(unread["items"].as_array().unwrap().len(), 1);
    // 읽음 처리
    let (st, item) = s
        .send(Method::PATCH, &format!("/api/v1/recent/{}", item["id"].as_str().unwrap()), json!({ "expected_revision": item["revision"], "view_state": { "last_seen_seq": 1 } }))
        .await;
    assert_eq!(st, StatusCode::OK, "{item}");
    assert_eq!(item["unread"], false);
    s.send(Method::PATCH, &format!("/api/v1/sessions/{sid}"), json!({ "expected_revision": 1, "archived": true })).await;
    let (_, list) = s.get("/api/v1/recent").await;
    assert_eq!(list["items"][0]["status"], "archived");
    // 최근 목록에서 숨기기는 세션 삭제가 아니다
    let it = &list["items"][0];
    s.send(Method::PATCH, &format!("/api/v1/recent/{}", it["id"].as_str().unwrap()), json!({ "expected_revision": it["revision"], "hidden": true })).await;
    let (_, list) = s.get("/api/v1/recent").await;
    assert!(list["items"].as_array().unwrap().is_empty());
    let (_, hidden) = s.get("/api/v1/recent?filter=hidden").await;
    assert_eq!(hidden["items"].as_array().unwrap().len(), 1);
    let (st, _) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    assert_eq!(st, StatusCode::OK);
    // 다른 프로젝트의 세션을 섞어 등록할 수 없다
    let q = s.create_project("q").await;
    let (st, _) = s.post("/api/v1/recent/touch", json!({ "kind": "session", "project_id": q["id"], "resource_id": sid })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

/// RECENT-006: 같은 대화를 여러 기기에서 볼 때 늦은 기기의 낮은 읽음 위치가 읽음을 되돌리지 않고,
/// 고정·숨김 동시 변경은 revision 충돌로 알리며 다른 필드를 덮어쓰지 않는다.
#[tokio::test]
async fn recent_access_from_several_devices_never_regresses_read_state() {
    let s = TestServer::start().await;
    let pid = s.create_project("p").await["id"].as_str().unwrap().to_string();
    let sid = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    for t in ["a", "b", "c"] {
        s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": t })).await;
    }
    let touch = |seq: Option<i64>| {
        let mut body = json!({ "kind": "session", "project_id": pid, "resource_id": sid });
        if let Some(seq) = seq { body["view_state"] = json!({ "last_seen_seq": seq }); }
        body
    };
    // PC가 끝까지 읽음 → 늦게 갱신된 폰이 이전 위치(1)로 접근해도 읽음 유지.
    let (_, pc) = s.post("/api/v1/recent/touch", touch(Some(3))).await;
    assert_eq!(pc["unread"], false);
    let (_, phone) = s.post("/api/v1/recent/touch", touch(Some(1))).await;
    assert_eq!(phone["view_state"]["last_seen_seq"], 3);
    assert_eq!(phone["unread"], false);
    // 위치 없이 여는 접근(최근 목록 클릭)은 읽음 정보를 그대로 둔다.
    let (_, opened) = s.post("/api/v1/recent/touch", touch(None)).await;
    assert_eq!(opened["view_state"]["last_seen_seq"], 3);
    // 새 메시지는 다시 읽지 않음.
    s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": "d" })).await;
    let (_, list) = s.get("/api/v1/recent").await;
    assert_eq!(list["items"][0]["unread"], true);

    // 고정(PC)과 숨김(폰, 오래된 revision)이 동시에 오면 폰은 충돌을 받고 현재 값을 확인한다.
    let item = list["items"][0].clone();
    let id = item["id"].as_str().unwrap();
    let (st, _) = s.send(Method::PATCH, &format!("/api/v1/recent/{id}"), json!({ "expected_revision": item["revision"], "pinned": true })).await;
    assert_eq!(st, StatusCode::OK);
    let (st, conflict) = s.send(Method::PATCH, &format!("/api/v1/recent/{id}"), json!({ "expected_revision": item["revision"], "hidden": true })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    let current = &conflict["error"]["details"]["current"];
    assert_eq!(current["pinned"], true);
    // 최신 revision으로 숨김만 다시 적용해도 다른 기기의 고정은 유지된다.
    let (st, after) = s.send(Method::PATCH, &format!("/api/v1/recent/{id}"), json!({ "expected_revision": current["revision"], "hidden": true })).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(after["pinned"], true);
    assert_eq!(after["hidden"], true);
}

#[tokio::test]
async fn completed_recent_is_acknowledged_separately_and_never_regresses() {
    let mut s = TestServer::start().await;
    let fixture = Fixture::start().await;
    let profile = s.fixture_profile(&fixture.base).await;
    let pid = s.create_project("completion").await["id"].as_str().unwrap().to_string();
    let sid = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    s.post("/api/v1/recent/touch", json!({
        "kind": "session", "project_id": pid, "resource_id": sid,
        "view_state": { "last_seen_seq": 0, "scroll": 42 },
    })).await;
    receive_reply(&s, &fixture, &profile, &sid, "first completion").await;
    let first = recent_session(&s, &sid).await;
    assert_eq!(first["status"], "completed");
    assert_eq!(first["completion_unread"], true);
    let first_turn = first["completed_turn_id"].as_str().unwrap().to_string();
    let (_, session) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    let (_, read) = s.post("/api/v1/recent/touch", json!({
        "kind": "session", "project_id": pid, "resource_id": sid,
        "view_state": { "last_seen_seq": session["last_message_seq"] },
    })).await;
    assert_eq!(read["unread"], false);
    assert_eq!(read["completion_unread"], true, "메시지를 읽었더라도 완료 확인은 별개다");
    assert_eq!(read["view_state"]["scroll"], 42);
    let ack = |id: &str| json!({
        "kind": "session", "project_id": pid, "resource_id": sid, "seen_completed_turn_id": id,
    });
    let (status, read) = s.post("/api/v1/recent/touch", ack(&first_turn)).await;
    assert_eq!(status, StatusCode::OK, "{read}");
    assert_eq!(read["completion_unread"], false);
    assert_eq!(read["last_activity_at"], first["last_activity_at"], "확인은 답변 정렬 시각을 바꾸지 않는다");
    let first_seen = read["view_state"]["last_seen_completed_seq"].as_i64().unwrap();
    receive_reply(&s, &fixture, &profile, &sid, "second completion").await;
    let second = recent_session(&s, &sid).await;
    assert_eq!(second["completion_unread"], true);
    let second_turn = second["completed_turn_id"].as_str().unwrap().to_string();
    assert_ne!(first_turn, second_turn);
    let (_, stale) = s.post("/api/v1/recent/touch", ack(&first_turn)).await;
    assert_eq!(stale["completion_unread"], true, "이전 완료 클릭으로 새 완료를 지우지 않는다");
    let (_, forged) = s.post("/api/v1/recent/touch", json!({
        "kind": "session", "project_id": pid, "resource_id": sid,
        "view_state": { "last_seen_seq": 0, "last_seen_completed_seq": i64::MAX },
    })).await;
    assert_eq!(forged["completion_unread"], true, "완료 위치는 요청 ID 확인으로만 전진한다");
    assert_eq!(forged["view_state"]["last_seen_completed_seq"], first_seen);
    assert_eq!(forged["view_state"]["scroll"], 42);
    let (_, latest) = s.post("/api/v1/recent/touch", ack(&second_turn)).await;
    assert_eq!(latest["completion_unread"], false);
    let second_seen = latest["view_state"]["last_seen_completed_seq"].as_i64().unwrap();
    assert!(second_seen > first_seen);
    let (_, stale) = s.post("/api/v1/recent/touch", ack(&first_turn)).await;
    assert_eq!(stale["view_state"]["last_seen_completed_seq"], second_seen);
    assert_eq!(stale["completion_unread"], false);
    s.restart().await;
    assert_eq!(recent_session(&s, &sid).await["completion_unread"], false);
}

#[tokio::test]
async fn completion_ack_rejects_other_sessions_and_running_turns() {
    let s = TestServer::start().await;
    let fixture = Fixture::start().await;
    let profile = s.fixture_profile(&fixture.base).await;
    let pid = s.create_project("completion-boundary").await["id"].as_str().unwrap().to_string();
    let a = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    let b = s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    s.post("/api/v1/recent/touch", json!({ "kind": "session", "project_id": pid, "resource_id": a })).await;
    receive_reply(&s, &fixture, &profile, &a, "done").await;
    let done = recent_session(&s, &a).await;
    let (status, _) = s.post("/api/v1/recent/touch", json!({
        "kind": "session", "project_id": pid, "resource_id": b, "seen_completed_turn_id": done["completed_turn_id"],
    })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(recent_session(&s, &a).await["completion_unread"], true);
    let (step, release) = fixture::gated_text("running");
    fixture.push(step);
    let (_, accepted) = s.post(&format!("/api/v1/sessions/{a}/turns"), json!({
        "text": "running", "profile_id": profile, "tools": false,
    })).await;
    let id = accepted["turn"]["id"].as_str().unwrap();
    s.wait_status(id, "running").await;
    let running = recent_session(&s, &a).await;
    assert_eq!(running["status"], "running");
    assert_eq!(running["completion_unread"], false);
    assert!(running["completed_turn_id"].is_null());
    let (status, _) = s.post("/api/v1/recent/touch", json!({
        "kind": "session", "project_id": pid, "resource_id": a, "seen_completed_turn_id": id,
    })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    release.send(true).unwrap();
    s.wait_status(id, "completed").await;
    assert_eq!(recent_session(&s, &a).await["completion_unread"], true);
}

/// RECENCY-007: 대량 최근 목록(파일 4,000 + 대화 1,000)의 정렬·검색·시간 범위·상태 필터 결과와 응답 시간.
/// 시간 상한은 debug 빌드·부하 차이를 감안한 병적 회귀 감시용이고, 측정값은 출력해 기록한다.
#[tokio::test]
async fn large_recent_list_search_sort_and_window_stay_correct_and_bounded() {
    let s = TestServer::start().await;
    let fixture = Fixture::start().await;
    let profile = s.fixture_profile(&fixture.base).await;
    let pid = s.create_project("big").await["id"].as_str().unwrap().to_string();
    let mut sessions = Vec::new();
    for _ in 0..1000 {
        sessions.push(s.create_session(&pid).await["id"].as_str().unwrap().to_string());
    }
    let (p2, sids) = (pid.clone(), sessions.clone());
    s.server.as_ref().unwrap().app.db.call(move |c| {
        let tx = c.transaction()?;
        for i in 0..4000 {
            // 오래된 접근 시각(2020년)의 파일 항목. 이름에 번호를 넣어 검색 대상을 만든다.
            tx.execute(
                "INSERT INTO recent_items (id, kind, project_id, resource_id, title, last_access_at, view_state) VALUES (?1, 'file', ?2, ?3, ?3, ?4, '{}')",
                rusqlite::params![format!("rf{i:05}"), p2, format!("src/file-{i:05}.rs"), format!("2020-01-01T00:{:02}:{:02}Z", (i / 60) % 60, i % 60)],
            )?;
        }
        for (i, sid) in sids.iter().enumerate() {
            let created_at = format!("2021-01-01T00:{:02}:{:02}Z", (i / 60) % 60, i % 60);
            tx.execute("UPDATE sessions SET created_at = ?2 WHERE id = ?1", rusqlite::params![sid, created_at])?;
            tx.execute(
                "INSERT INTO recent_items (id, kind, project_id, resource_id, title, last_access_at, view_state) VALUES (?1, 'session', ?2, ?3, 't', ?4, '{}')",
                rusqlite::params![format!("rs{i:05}"), p2, sid, format!("2021-01-01T00:{:02}:{:02}Z", (i / 60) % 60, i % 60)],
            )?;
        }
        tx.commit()?;
        Ok(())
    }).await.unwrap();
    // 마지막 대화 하나의 새 답변 → 맨 앞으로 오고 시간 범위 안에 든다.
    let newest = sessions.last().unwrap().clone();
    receive_reply(&s, &fixture, &profile, &newest, "now").await;
    let timed = |path: String| {
        let s = &s;
        async move {
            let t = std::time::Instant::now();
            let (st, v) = s.get(&path).await;
            assert_eq!(st, StatusCode::OK, "{path}: {v}");
            (v, t.elapsed())
        }
    };
    let (all, t_all) = timed("/api/v1/recent?limit=50".into()).await;
    assert_eq!(all["total"], 5000);
    assert_eq!(all["items"][0]["resource_id"], newest.as_str(), "마지막 확정 답변이 가장 최근 활동");
    assert_eq!(all["items"][1]["kind"], "session", "2021년 대화가 2020년 파일보다 앞");
    let (found, t_q) = timed("/api/v1/recent?limit=50&q=file-03999".into()).await;
    assert_eq!(found["total"], 1);
    let (window, t_since) = timed("/api/v1/recent?limit=50&since=2025-01-01T00:00:00Z".into()).await;
    assert_eq!(window["total"], 1);
    let (unread, t_unread) = timed("/api/v1/recent?limit=50&filter=unread".into()).await;
    assert_eq!(unread["total"], 1);
    let (last, t_last) = timed("/api/v1/recent?limit=50&offset=4990".into()).await;
    assert_eq!(last["items"].as_array().unwrap().len(), 10);
    assert!(last["next_offset"].is_null());
    println!("recent 5000: all={t_all:?} q={t_q:?} since={t_since:?} unread={t_unread:?} last_page={t_last:?}");
    for t in [t_all, t_q, t_since, t_unread, t_last] {
        assert!(t < std::time::Duration::from_secs(5), "최근 목록 조회가 너무 느립니다: {t:?}");
    }
}

#[tokio::test]
async fn recent_filters_before_paging_in_pinned_activity_and_id_order() {
    let s = TestServer::start().await;
    let project = s.create_project("p").await["id"].as_str().unwrap().to_owned();
    s.server.as_ref().unwrap().app.db.call(move |c| {
        for (id, at, pinned, hidden) in [
            ("a", "2026-01-01T00:00:00Z", false, false),
            ("b", "2026-01-01T09:00:00+09:00", false, false),
            ("c", "2026-01-02T00:00:00Z", false, false),
            ("d", "2025-01-01T00:00:00Z", true, false),
            ("e", "2026-01-03T00:00:00Z", true, true),
        ] {
            c.execute("INSERT INTO recent_items (id, kind, project_id, resource_id, title, last_access_at, pinned, hidden) \
                VALUES (?1, 'file', ?2, 'src/match-' || ?1, '파일', ?3, ?4, ?5)", rusqlite::params![id, project, at, pinned, hidden])?;
        }
        Ok(())
    }).await.unwrap();
    let query = "/api/v1/recent?q=MATCH&since=2026-01-01T00:00:00Z&limit=2";
    let (st, first) = s.get(query).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(first["total"], 4);
    assert_eq!(first["next_offset"], 2);
    assert_eq!(first["items"][0]["id"], "d");
    assert_eq!(first["items"][1]["id"], "c");
    let (st, second) = s.get(&format!("{query}&offset=2")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(second["next_offset"], Value::Null);
    assert_eq!(second["items"][0]["id"], "b");
    assert_eq!(second["items"][1]["id"], "a");
}

#[tokio::test]
async fn recent_pagination_offsets() {
    let s = TestServer::start().await;
    let p = s.create_project("p").await;
    let pid = p["id"].as_str().unwrap();
    for i in 0..5 {
        s.post("/api/v1/recent/touch", json!({ "kind": "file", "project_id": pid, "resource_id": format!("f{i}.txt") })).await;
    }
    let (_, a) = s.get("/api/v1/recent?limit=2").await;
    assert_eq!(a["total"], 5);
    assert_eq!(a["next_offset"], 2);
    let (_, c) = s.get("/api/v1/recent?limit=2&offset=4").await;
    assert_eq!(c["items"].as_array().unwrap().len(), 1);
    assert!(c["next_offset"].is_null());
    let _: Value = c;
}
