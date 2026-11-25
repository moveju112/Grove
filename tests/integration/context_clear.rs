//! idle 초기화는 모델 입력 경계일 뿐 화면 이력 삭제나 요약 성공이 아니다.
use crate::common;

use common::{TestServer, fixture::{self, Fixture}};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn setting(s: &TestServer, pid: &str, revision: i64, minutes: u64) {
    let (status, value) = s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/context.auto_clear_minutes"),
        json!({"expected_revision":revision,"value":minutes})).await;
    assert_eq!(status, StatusCode::OK, "{value}");
}

async fn seed(s: &TestServer, sid: &str, profile: &str) {
    let (sid, profile) = (sid.to_string(), profile.to_string());
    s.server.as_ref().unwrap().app.db.call(move |c| {
        let tx = c.transaction()?;
        let old = "2020-01-01T00:00:00Z";
        grove::sessions::append_message(&tx, old, &sid, "user", &json!({"text":"OLD_HISTORY_FIXTURE"}), None, None)?;
        grove::sessions::append_message(&tx, old, &sid, "assistant", &json!({
            "text":"old answer","usage":{"input_tokens":90000},
            "tool_calls":[{"id":"old-read","name":"read","arguments":{"path":"old.txt"}}]
        }), None, None)?;
        grove::sessions::append_message(&tx, old, &sid, "tool", &json!({
            "provider_call_id":"old-read","name":"read","output":{"content":"OLD_TOOL_FIXTURE"},"is_error":false
        }), None, None)?;
        tx.execute("INSERT INTO cli_sessions(session_id,profile_id,native_id,updated_at) VALUES (?1,?2,'old-native-fixture',?3)",
            rusqlite::params![sid,profile,old])?;
        tx.commit()?;
        Ok(())
    }).await.unwrap();
}

async fn run(s: &TestServer, f: &Fixture, sid: &str, profile: &str, text: &str) -> Value {
    f.push(fixture::text("new answer"));
    let (status, accepted) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":text,"profile_id":profile})).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{accepted}");
    s.wait_status(accepted["turn"]["id"].as_str().unwrap(), "completed").await
}

async fn notes(s: &TestServer, sid: &str) -> Vec<Value> {
    let (_, history) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    history["items"].as_array().unwrap().iter().filter(|m| m["content"]["type"] == "context_clear").cloned().collect()
}

#[tokio::test]
async fn idle_clear_is_atomic_idempotent_and_persistent_but_history_and_files_remain() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("context-clear").await;
    let pid = project["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    seed(&s, &sid, &profile).await;
    let file = std::path::Path::new(project["root_path"].as_str().unwrap()).join("keep.txt");
    std::fs::write(&file, "user file fixture").unwrap();
    // 기본값 0은 시간 제한 없이 유지한다.
    let (_, usage) = s.get(&format!("/api/v1/sessions/{sid}/context?profile_id={profile}")).await;
    assert_eq!(usage["auto_clear_minutes"], 0);
    assert_eq!(usage["measured_input_tokens"], 90000);
    assert!(notes(&s, &sid).await.is_empty());
    setting(&s, pid, 0, 30).await;
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_clear_acceptance BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT, 'fixture acceptance failure'); END;").unwrap();
    let body = json!({"text":"new request","profile_id":profile});
    let path = format!("/api/v1/sessions/{sid}/turns");
    assert_eq!(s.post(&path, body.clone()).await.0, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(notes(&s, &sid).await.is_empty(), "접수 실패는 context 경계도 되돌린다");
    assert_eq!(db.query_row("SELECT COUNT(*) FROM cli_sessions WHERE session_id=?1",[&sid],|r|r.get::<_,i64>(0)).unwrap(), 1);
    db.execute_batch("DROP TRIGGER fail_clear_acceptance").unwrap();
    f.push(fixture::text("new answer"));
    let first = s.raw(Method::POST, &path, Some(body.clone()), Some("clear-replay"), None).await;
    assert_eq!(first.status(), StatusCode::ACCEPTED);
    let accepted: Value = first.json().await.unwrap();
    let tid = accepted["turn"]["id"].as_str().unwrap();
    let turn = s.wait_status(tid, "completed").await;
    assert_eq!(turn["definition"]["context_clear"]["idle_minutes"], 30);
    let sent = f.requests()[0]["messages"].clone();
    assert!(!sent.to_string().contains("OLD_HISTORY_FIXTURE") && !sent.to_string().contains("OLD_TOOL_FIXTURE"));
    assert!(sent.to_string().contains("new request"));
    assert!(sent.as_array().unwrap().iter().all(|m| m["role"] != "tool"));
    assert_eq!(notes(&s, &sid).await.len(), 1);
    assert_eq!(db.query_row("SELECT COUNT(*) FROM cli_sessions WHERE session_id=?1",[&sid],|r|r.get::<_,i64>(0)).unwrap(), 0);
    let (_, history) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert!(history.to_string().contains("OLD_HISTORY_FIXTURE") && history.to_string().contains("OLD_TOOL_FIXTURE"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "user file fixture");
    drop(db);
    s.restart().await;
    let replay = s.raw(Method::POST, &path, Some(body), Some("clear-replay"), None).await;
    assert_eq!(replay.status(), StatusCode::ACCEPTED);
    assert_eq!(replay.json::<Value>().await.unwrap()["turn"]["id"], tid);
    assert_eq!(notes(&s, &sid).await.len(), 1);
    let (_, preview) = s.get(&format!("/api/v1/sessions/{sid}/model-input")).await;
    assert!(!preview.to_string().contains("OLD_HISTORY_FIXTURE"));
    run(&s, &f, &sid, &profile, "continue immediately").await;
    assert_eq!(notes(&s, &sid).await.len(), 1, "각 턴이 아니라 실제 idle 경계에서만 초기화한다");
    assert_eq!(f.requests().len(), 2, "초기화는 요약 모델 호출이나 중복 실행을 만들지 않는다");
    assert!(f.requests()[1]["messages"].to_string().contains("new request"));
}

#[tokio::test]
async fn profile_overrides_can_disable_or_enable_clear_without_changing_other_profiles() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let inherited = s.fixture_profile(&f.base).await;
    let (_, disabled) = s.post("/api/v1/model-profiles", json!({
        "name":"keep","protocol":"openai","base_url":f.base,"model":"keep","options":{"auto_clear_minutes":0}
    })).await;
    let disabled = disabled["id"].as_str().unwrap();
    let (_, enabled) = s.post("/api/v1/model-profiles", json!({
        "name":"clear","protocol":"openai","base_url":f.base,"model":"clear","options":{"auto_clear_minutes":1}
    })).await;
    let enabled = enabled["id"].as_str().unwrap();
    let p = s.create_project("clear-overrides").await;
    let pid = p["id"].as_str().unwrap();
    setting(&s, pid, 0, 1).await;
    for (profile, should_clear) in [(&*inherited, true), (disabled, false)] {
        let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
        seed(&s, &sid, profile).await;
        run(&s, &f, &sid, profile, "current").await;
        assert_eq!(!notes(&s, &sid).await.is_empty(), should_clear);
        assert_eq!(f.requests().last().unwrap()["messages"].to_string().contains("OLD_HISTORY_FIXTURE"), !should_clear);
    }
    setting(&s, pid, 1, 0).await;
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    seed(&s, &sid, enabled).await;
    run(&s, &f, &sid, enabled, "current").await;
    assert_eq!(notes(&s, &sid).await.len(), 1);
    for invalid in [json!(-1), json!(0.5), json!("1"), json!(null), json!(525601)] {
        let (status, _) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{enabled}"),
            json!({"expected_revision":1,"options":{"auto_clear_minutes":invalid}})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn idle_uses_request_finish_and_skips_active_turns_background_tasks_and_pending_input() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("clear-active").await;
    let pid = project["id"].as_str().unwrap();
    setting(&s, pid, 0, 1).await;
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    seed(&s, &sid, &profile).await;
    // 긴 요청이 방금 끝났으면 시작 시각이 오래돼도 아직 idle이 아니다.
    run(&s, &f, &sid, &profile, "first").await;
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute("UPDATE messages SET created_at='2020-01-01T00:00:00Z' WHERE session_id=?1",[&sid]).unwrap();
    let app = s.server.as_ref().unwrap().app.clone();
    let direct = |sid: String, profile: String, now: String| {
        let app = app.clone();
        async move {
            app.db.call(move |c| {
                let tx = c.transaction()?;
                let profile = grove::models::get_profile(&tx, &profile)?;
                let result = grove::context::maybe_auto_clear(&tx, &now, &sid, &profile)?;
                tx.commit()?;
                Ok(result)
            }).await.unwrap()
        }
    };
    assert!(direct(sid.clone(),profile.clone(),app.now()).await.is_none());
    f.push(fixture::hang_after("working"));
    let (_, accepted) = s.post(&format!("/api/v1/sessions/{sid}/turns"),json!({"text":"busy","profile_id":profile})).await;
    let tid = accepted["turn"]["id"].as_str().unwrap();
    s.wait_status(tid,"running").await;
    let future = grove::util::fmt_time(time::OffsetDateTime::now_utc() + time::Duration::days(10));
    assert!(direct(sid.clone(),profile.clone(),future.clone()).await.is_none());
    s.post(&format!("/api/v1/turns/{tid}/cancel"),json!({})).await;
    s.wait_status(tid,"cancelled").await;
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    seed(&s, &sid, &profile).await;
    db.execute("INSERT INTO followups(id,session_id,kind,text,profile_id,owner_key,created_at) VALUES ('fixture-pending',?1,'queue','pending',?2,'owner','2020-01-01T00:00:00Z')",
        rusqlite::params![sid,profile]).unwrap();
    assert!(direct(sid.clone(),profile.clone(),future.clone()).await.is_none());
    db.execute("DELETE FROM followups WHERE id='fixture-pending'",[]).unwrap();
    #[cfg(unix)]
    {
        let (status, task) = s.post(&format!("/api/v1/sessions/{sid}/tasks"),
            json!({"command":"sleep 30"})).await;
        assert_eq!(status,StatusCode::CREATED,"{task}");
        assert!(direct(sid.clone(),profile.clone(),future.clone()).await.is_none());
        s.post(&format!("/api/v1/tasks/{}/cancel",task["id"].as_str().unwrap()),json!({})).await;
    }
}

#[tokio::test]
async fn clear_stops_fork_inheritance_and_old_summaries_but_later_compaction_uses_new_context() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("clear-fork").await;
    let pid = p["id"].as_str().unwrap();
    let parent = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    seed(&s, &parent, &profile).await;
    let (_, parent_state) = s.get(&format!("/api/v1/sessions/{parent}")).await;
    let (status, child) = s.post(&format!("/api/v1/sessions/{parent}/fork"),
        json!({"from_seq":parent_state["last_message_seq"],"inherit_context":true})).await;
    assert_eq!(status, StatusCode::CREATED, "{child}");
    let child = child["id"].as_str().unwrap();
    seed(&s, child, &profile).await;
    // 이미 있는 요약도 초기화 경계보다 앞이면 모델 context로 되살리지 않는다.
    let app = &s.server.as_ref().unwrap().app;
    let child_owned = child.to_string();
    app.db.call(move |c| {
        grove::sessions::append_message(c, "2020-01-01T00:00:00Z", &child_owned, "note",
            &json!({"type":"compaction","upto_seq":1,"summary":"OLD_SUMMARY_FIXTURE"}), None, None)?;
        Ok(())
    }).await.unwrap();
    setting(&s, pid, 0, 1).await;
    run(&s, &f, child, &profile, "new child question").await;
    let sent = f.requests()[0]["messages"].to_string();
    assert!(!sent.contains("OLD_SUMMARY_FIXTURE") && !sent.contains("OLD_HISTORY_FIXTURE"));
    setting(&s, pid, 1, 0).await;
    run(&s, &f, child, &profile, "new second question").await;
    f.push(fixture::text("NEW_SUMMARY_FIXTURE"));
    let (status, compacted) = s.post(&format!("/api/v1/sessions/{child}/compact"),json!({"profile_id":profile})).await;
    assert_eq!(status,StatusCode::CREATED,"{compacted}");
    let sent = f.requests().last().unwrap()["messages"].to_string();
    assert!(sent.contains("new child question") && !sent.contains("OLD_SUMMARY_FIXTURE") && !sent.contains("OLD_HISTORY_FIXTURE"));
    let (_, preview) = s.get(&format!("/api/v1/sessions/{child}/model-input")).await;
    assert!(preview.to_string().contains("NEW_SUMMARY_FIXTURE"));
    assert!(!preview.to_string().contains("OLD_SUMMARY_FIXTURE"));
    let (_, parent_preview) = s.get(&format!("/api/v1/sessions/{parent}/model-input")).await;
    assert!(parent_preview.to_string().contains("OLD_HISTORY_FIXTURE"), "자식 초기화는 원본 context를 바꾸지 않는다");
}

#[tokio::test]
async fn the_exact_idle_boundary_resets_measured_usage_and_session_override_can_disable_it() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("clear-boundary").await;
    let pid = project["id"].as_str().unwrap();
    setting(&s, pid, 0, 1).await;
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    seed(&s, &sid, &profile).await;
    let app = &s.server.as_ref().unwrap().app;
    let (session, model) = (sid.clone(), profile.clone());
    app.db.call(move |c| {
        let tx = c.transaction()?;
        let profile = grove::models::get_profile(&tx, &model)?;
        assert!(grove::context::maybe_auto_clear(&tx, "2020-01-01T00:00:59Z", &session, &profile)?.is_none());
        assert!(grove::context::maybe_auto_clear(&tx, "2020-01-01T00:01:00Z", &session, &profile)?.is_some());
        let usage = grove::context::usage(&tx, &session, Some(&model))?;
        assert_eq!(usage["estimated_tokens"], 0);
        assert_eq!(usage["basis"], "estimated");
        assert!(usage["measured_input_tokens"].is_null() && usage["compaction"].is_null());
        assert_eq!(usage["cleared"]["upto_seq"], 3);
        tx.commit()?;
        Ok(())
    }).await.unwrap();
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/settings/session/{sid}/context.auto_clear_minutes"),
        json!({"expected_revision":0,"value":0})).await;
    assert_eq!(status,StatusCode::OK);
    let (session, model) = (sid.clone(), profile.clone());
    app.db.call(move |c| {
        let profile = grove::models::get_profile(c, &model)?;
        assert_eq!(grove::context::auto_clear_minutes(c, &session, Some(&profile))?, 0);
        assert!(grove::context::maybe_auto_clear(c, "2021-01-01T00:00:00Z", &session, &profile)?.is_none());
        Ok(())
    }).await.unwrap();
}

#[tokio::test]
async fn idle_comparison_uses_instants_instead_of_lexical_timestamp_order() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("idle-offsets").await;
    let pid = p["id"].as_str().unwrap();
    setting(&s, pid, 0, 1).await;
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    seed(&s, &sid, &profile).await;
    s.server.as_ref().unwrap().app.db.call(move |c| {
        let tx = c.transaction()?;
        for timestamp in ["2020-01-01T09:00:00+09:00","2020-01-01T00:00:30.000Z"] {
            grove::sessions::append_message(&tx,timestamp,&sid,"note",&json!({"type":"fixture"}),None,None)?;
        }
        let profile = grove::models::get_profile(&tx,&profile)?;
        assert!(grove::context::maybe_auto_clear(&tx,"2020-01-01T00:01:00Z",&sid,&profile)?.is_none());
        assert!(grove::context::maybe_auto_clear(&tx,"2020-01-01T00:01:30Z",&sid,&profile)?.is_some());
        tx.commit()?;
        Ok(())
    }).await.unwrap();
}

#[tokio::test]
async fn a_manual_summary_finishing_during_a_new_turn_does_not_reset_its_native_context() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("summary-race").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    seed(&s, &sid, &profile).await;
    run(&s,&f,&sid,&profile,"recent question").await;
    let (step, release) = fixture::gated_text("STALE_SUMMARY_FIXTURE");
    f.push_for("You compress a conversation",step);
    let (client, url, token, chosen) = (s.client.clone(),format!("{}/api/v1/sessions/{sid}/compact",s.base),s.token.clone(),profile.clone());
    let summary = tokio::spawn(async move { client.post(url).bearer_auth(token).json(&json!({"profile_id":chosen})).send().await.unwrap() });
    tokio::time::timeout(std::time::Duration::from_secs(5),async {
        while !f.requests().iter().any(|r| r.to_string().contains("You compress a conversation")) {
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    f.push(fixture::hang_after("new turn working"));
    let (_, accepted) = s.post(&format!("/api/v1/sessions/{sid}/turns"),json!({"text":"new active request","profile_id":profile})).await;
    let tid = accepted["turn"]["id"].as_str().unwrap();
    s.wait_status(tid,"running").await;
    release.send(true).unwrap();
    let response = summary.await.unwrap();
    assert_eq!(response.status(),StatusCode::CONFLICT);
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM cli_sessions WHERE session_id=?1",[&sid],|r|r.get::<_,i64>(0)).unwrap(),1);
    let (_, preview) = s.get(&format!("/api/v1/sessions/{sid}/model-input")).await;
    assert!(!preview.to_string().contains("STALE_SUMMARY_FIXTURE"));
    assert!(preview.to_string().contains("OLD_HISTORY_FIXTURE"));
    s.post(&format!("/api/v1/turns/{tid}/cancel"),json!({})).await;
    s.wait_status(tid,"cancelled").await;
}
