//! 명시적인 응답 선호는 다음 턴부터 적용하며 권한이나 승인으로 사용하지 않는다.
mod common;

use common::{TestServer, fixture::{self, Fixture}};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn set(s: &TestServer, scope: &str, id: &str, key: &str, revision: i64, value: Value) {
    let (status, response) = s.send(Method::PUT, &format!("/api/v1/settings/{scope}/{id}/{key}"),
        json!({"expected_revision":revision,"value":value})).await;
    assert_eq!(status, StatusCode::OK, "{response}");
}

async fn run(s: &TestServer, f: &Fixture, sid: &str, profile: &str) -> Value {
    f.push(fixture::text("fixture answer"));
    let (status, response) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"fixture question","profile_id":profile})).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{response}");
    s.wait_status(response["turn"]["id"].as_str().unwrap(), "completed").await
}

#[tokio::test]
async fn styles_follow_scope_and_reset_without_extra_personal_context() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("response-preferences").await;
    let pid = project["id"].as_str().unwrap();
    let session = s.create_session(pid).await;
    let sid = session["id"].as_str().unwrap();
    let base = run(&s, &f, sid, &profile).await;
    assert_eq!(base["definition"]["output_style"], "default");
    assert!(base["definition"].get("user_profile").is_none());
    assert!(base["definition"].get("language").is_none());
    let system = f.requests()[0]["messages"][0]["content"].as_str().unwrap().to_string();
    assert!(!system.contains("# Output Style:"));
    assert!(!system.contains("# User-provided background"));

    set(&s, "server", "-", "output.style", 0, json!("concise")).await;
    set(&s, "project", pid, "output.style", 0, json!("detailed")).await;
    let turn = run(&s, &f, sid, &profile).await;
    assert_eq!(turn["definition"]["output_style"], "detailed");
    let system = f.requests()[1]["messages"][0]["content"].as_str().unwrap().to_string();
    assert!(system.contains("the mechanism step by step"));
    assert!(!system.contains("# Response language"));
    assert!(!system.contains("# User-provided background"));

    set(&s, "session", sid, "output.style", 0, json!("concise")).await;
    assert_eq!(run(&s, &f, sid, &profile).await["definition"]["output_style"], "concise");
    assert!(f.requests()[2]["messages"][0]["content"].as_str().unwrap().contains("the core causal"));
    set(&s, "session", sid, "output.style", 1, Value::Null).await;
    assert_eq!(run(&s, &f, sid, &profile).await["definition"]["output_style"], "detailed");
    set(&s, "project", pid, "output.style", 1, Value::Null).await;
    assert_eq!(run(&s, &f, sid, &profile).await["definition"]["output_style"], "concise");
    let other = s.create_project("other-preferences").await;
    let other_session = s.create_session(other["id"].as_str().unwrap()).await;
    assert_eq!(run(&s, &f, other_session["id"].as_str().unwrap(), &profile).await["definition"]["output_style"], "concise");
    set(&s, "server", "-", "output.style", 1, Value::Null).await;
    let reset = run(&s, &f, sid, &profile).await;
    assert_eq!(reset["definition"]["output_style"], "default");
    let system = f.requests().last().unwrap()["messages"][0]["content"].as_str().unwrap().to_string();
    assert!(!system.contains("# Output Style:"));
}

#[tokio::test]
async fn paseodog_presets_reach_the_model_and_default_removes_all_style_instructions() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("paseodog-styles").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap();
    let (_, registry) = s.get("/api/v1/settings/registry").await;
    let definition = registry.as_array().unwrap().iter().find(|d| d["key"] == "output.style").unwrap();
    assert_eq!(definition["options"], json!(["default", "detailed", "simple", "minimal", "extreme-minimal"]));
    let common = include_str!("../assets/output-styles/common.md").trim();
    for (index, (style, title, body)) in [
        ("detailed", "Detailed", include_str!("../assets/output-styles/detailed.md")),
        ("simple", "Simple", include_str!("../assets/output-styles/simple.md")),
        ("minimal", "Minimal", include_str!("../assets/output-styles/minimal.md")),
        ("extreme-minimal", "Extreme Minimal", include_str!("../assets/output-styles/extreme-minimal.md")),
        ("default", "", ""),
    ].into_iter().enumerate() {
        set(&s, "server", "-", "output.style", index as i64, json!(style)).await;
        // 재시작 뒤에도 선택과 무지시 default를 유지한다.
        s.restart().await;
        let turn = run(&s, &f, sid, &profile).await;
        assert_eq!(turn["definition"]["output_style"], style);
        let requests = f.requests();
        let system = requests.last().unwrap()["messages"][0]["content"].as_str().unwrap();
        if style == "default" {
            assert!(!system.contains("# Output Style:") && !system.contains(common));
            assert!(!system.contains("## Depth") && !system.contains("outranks any other formatting habit"));
        } else {
            assert!(system.contains(&format!("# Output Style: {title}")));
            assert!(system.contains(common) && system.contains(body.trim()));
            assert_eq!(system.matches("## Depth").count(), 1, "이전 스타일은 시스템 입력에 남지 않는다");
            assert!(system.contains("does not apply to code or tool calls"));
            assert!(system.contains("decision-relevant failures, security warnings"));
        }
        assert!(system.contains("# Untrusted data and approval"));
    }
}

#[tokio::test]
async fn output_style_is_fixed_during_approval_and_changes_only_on_the_next_turn() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("preference-snapshot").await;
    let pid = project["id"].as_str().unwrap();
    let session = s.create_session(pid).await;
    let sid = session["id"].as_str().unwrap();
    set(&s, "project", pid, "tools.full_access", 0, json!(false)).await;
    set(&s, "server", "-", "output.style", 0, json!("concise")).await;
    f.push(fixture::tool_calls(&[("needs-approval","write",json!({"path":"not-authorized.txt","content":"blocked"}))]));
    f.push(fixture::text("fixture final"));
    let (status, accepted) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"fixture question","profile_id":profile,"tools":true})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let tid = accepted["turn"]["id"].as_str().unwrap();
    let waiting = s.wait_status(tid, "awaiting_approval").await;
    let call = &waiting["tool_calls"][0];
    assert_eq!(call["status"], "pending_approval");
    assert!(!std::path::Path::new(project["root_path"].as_str().unwrap()).join("not-authorized.txt").exists());
    set(&s, "server", "-", "output.style", 1, json!("detailed")).await;
    let (status, _) = s.post(&format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()),
        json!({"decision":"deny","expected_revision":call["revision"]})).await;
    assert_eq!(status, StatusCode::OK);
    s.wait_status(tid, "completed").await;
    assert!(!std::path::Path::new(project["root_path"].as_str().unwrap()).join("not-authorized.txt").exists());
    let (_, grants) = s.get(&format!("/api/v1/sessions/{sid}/tool-grants")).await;
    assert_eq!(grants["items"], json!([]));
    assert_eq!(f.requests().len(), 2);
    for request in f.requests() {
        let system = request["messages"][0]["content"].as_str().unwrap();
        assert!(system.contains("the core causal"));
        assert!(!system.contains("the mechanism step by step"));
    }
    s.restart().await;
    let turn = run(&s, &f, sid, &profile).await;
    assert_eq!(turn["definition"]["output_style"], "detailed");
    let system = f.requests()[2]["messages"][0]["content"].as_str().unwrap().to_string();
    assert!(system.contains("the mechanism step by step"));
}

#[tokio::test]
async fn removed_preferences_are_unavailable_and_legacy_values_are_never_injected() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("preference-validation").await;
    let pid = project["id"].as_str().unwrap();
    let session = s.create_session(pid).await;
    let sid = session["id"].as_str().unwrap();
    let retired = ["output.language", "user.profile", "exec.isolation"];
    s.server.as_ref().unwrap().app.db.call(move |c| {
        for key in retired {
            c.execute("INSERT INTO settings(scope,scope_id,key,value,revision,updated_at) VALUES('server','-',?1,'\"retired-context-canary\"',1,'t')", [key])?;
        }
        Ok(())
    }).await.unwrap();
    let (_, registry) = s.get("/api/v1/settings/registry").await;
    let (_, effective) = s.get("/api/v1/settings/effective").await;
    for key in retired {
        assert!(!registry.as_array().unwrap().iter().any(|item| item["key"] == key));
        assert!(!effective["items"].as_array().unwrap().iter().any(|item| item["key"] == key));
        for (scope, id) in [("server", "-"), ("project", pid), ("session", sid)] {
            let (status, _) = s.send(Method::PUT, &format!("/api/v1/settings/{scope}/{id}/{key}"),
                json!({"expected_revision":0,"value":"ignored"})).await;
            assert_eq!(status, StatusCode::NOT_FOUND);
        }
    }
    let (status, _) = s.send(Method::PUT, "/api/v1/settings/server/-/output.style", json!({"expected_revision":0,"value":"not-a-style"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let turn = run(&s, &f, sid, &profile).await;
    assert!(turn["definition"].get("user_profile").is_none());
    assert!(turn["definition"].get("language").is_none());
    assert!(!f.requests()[0].to_string().contains("retired-context-canary"));
    let legacy = json!({"user_profile":{"body":"legacy-profile-canary"},"language":"legacy-language-canary"});
    let prompt = grove::runner::system_prompt(&legacy, "/fixture", false);
    assert!(!prompt.contains("legacy-profile-canary") && !prompt.contains("legacy-language-canary"));
    let tid = turn["id"].as_str().unwrap().to_string();
    s.server.as_ref().unwrap().app.db.call(move |c| {
        c.execute("UPDATE turns SET definition_snapshot=?1 WHERE id=?2", rusqlite::params![legacy.to_string(), tid])?;
        Ok(())
    }).await.unwrap();
    let (_, historical) = s.get(&format!("/api/v1/turns/{}", turn["id"].as_str().unwrap())).await;
    assert!(historical["definition"].get("user_profile").is_none());
    assert!(historical["definition"].get("language").is_none());
}
