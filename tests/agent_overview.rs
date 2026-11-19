mod common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn overview(s: &TestServer, suffix: &str) -> Value {
    let (status, value) = s.get(&format!("/api/v1/agent-overview{suffix}")).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}

fn role<'a>(v: &'a Value, id: &str) -> &'a Value {
    v["roles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == id)
        .unwrap()
}

async fn setting(s: &TestServer, scope: &str, id: &str, key: &str, value: Value) {
    let query = match scope {
        "project" => format!("?project_id={id}"),
        "session" => format!("?session_id={id}"),
        _ => String::new(),
    };
    let (_, effective) = s.get(&format!("/api/v1/settings/effective{query}")).await;
    let item = effective["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["key"] == key)
        .unwrap();
    let (status, value) = s
        .send(
            Method::PUT,
            &format!("/api/v1/settings/{scope}/{id}/{key}"),
            json!({"expected_revision":item["layers"][scope]["revision"],"value":value}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{value}");
}

#[tokio::test]
async fn resolver_roles_redaction_and_read_only_snapshot() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let body = "실제 적용 지침\n복사된 sk-test-secret-value-1234\nAuthorization: hidden-auth\n/home/private-user/project\nC:\\Users\\private-user\\x\nhttps://user:password@host/path?token=hidden\n-----BEGIN PRIVATE KEY-----\nhidden-pem\n-----END PRIVATE KEY-----";
    let (st, _) = s
        .send(
            Method::PUT,
            "/api/v1/definitions/agent/worker",
            json!({"expected_revision":0,"body":body,"enabled":false}),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = s
        .post(
            "/api/v1/definitions/agent",
            json!({"id":"overview-custom","name":"내 역할","body":"내 지침"}),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED);
    setting(&s, "server", "-", "model.default_profile", json!(profile)).await;
    let app = &s.server.as_ref().unwrap().app;
    let mut before: Value = app
        .db
        .call(|c| {
            Ok(json!({
                "changes":c.total_changes(),
                "events":c.query_row("SELECT COUNT(*) FROM events", [], |r| r.get::<_, i64>(0))?,
                "turns":c.query_row("SELECT COUNT(*) FROM turns", [], |r| r.get::<_, i64>(0))?,
            }))
        })
        .await
        .unwrap();
    let value = overview(&s, "").await;
    let worker = role(&value, "worker");
    assert_eq!(worker["builtin"], true);
    assert_eq!(worker["enabled"], false);
    assert_eq!(worker["availability"], "disabled");
    assert_eq!(worker["modified_fields"], json!(["body"]));
    assert!(
        worker["body"]
            .as_str()
            .unwrap()
            .starts_with("실제 적용 지침\n복사된 [redacted]\n")
    );
    assert_eq!(role(&value, "overview-custom")["body"], "내 지침");
    assert_eq!(role(&value, "overview-custom")["builtin"], false);
    assert_eq!(value["parent"]["status"], "no_session");
    assert_eq!(value["next_request_default"]["status"], "configured");
    assert_eq!(
        value["limits"],
        json!({"max_depth":grove::agents::MAX_DEPTH,"max_per_parent":grove::agents::MAX_PER_PARENT,"max_running":grove::agents::MAX_RUNNING})
    );
    let serialized = value.to_string();
    for private in [
        "sk-test-secret-value-1234",
        "hidden-auth",
        "private-user",
        "hidden-pem",
        "user:password",
        &f.base,
    ] {
        assert!(!serialized.contains(private), "개요에 민감정보가 포함됨");
    }
    for key in ["base_url", "options", "secret_id", "last_check"] {
        assert!(!serialized.contains(key));
    }
    let after: Value = app
        .db
        .call(|c| {
            Ok(json!({
                "changes":c.total_changes(),
                "events":c.query_row("SELECT COUNT(*) FROM events", [], |r| r.get::<_, i64>(0))?,
                "turns":c.query_row("SELECT COUNT(*) FROM turns", [], |r| r.get::<_, i64>(0))?,
            }))
        })
        .await
        .unwrap();
    // 기존 Bearer 인증(auth::authenticate)이 tokens.last_used_at 한 행만 갱신한다.
    before["changes"] = json!(before["changes"].as_u64().unwrap() + 1);
    assert_eq!(before, after);
    assert!(f.requests().is_empty());
}

#[tokio::test]
async fn scoped_policy_uses_actual_deny_allow_delegation_and_depth() {
    let s = TestServer::start().await;
    let p = s.create_project("overview-policy").await;
    let pid = p["id"].as_str().unwrap();
    let session = s.create_session(pid).await;
    let sid = session["id"].as_str().unwrap();
    let query = format!("?session_id={sid}");
    let initial = overview(&s, &query).await;
    assert_eq!(initial["project_id"], pid);
    assert_eq!(initial["delegation"]["approval"], "ask");
    assert_eq!(role(&initial, "worker")["availability"], "available");
    setting(&s, "server", "-", "tools.allow", json!("agent")).await;
    assert_eq!(overview(&s, &query).await["delegation"]["approval"], "auto");
    setting(&s, "project", pid, "agents.delegation", json!("off")).await;
    assert_eq!(
        role(&overview(&s, &query).await, "worker")["availability"],
        "delegation_off"
    );
    setting(&s, "session", sid, "agents.delegation", json!("auto")).await;
    let restricted = overview(&s, &query).await;
    assert_eq!(restricted["delegation"]["mode"], "off");
    assert_eq!(restricted["delegation"]["approval"], "blocked");
    assert_eq!(role(&restricted, "worker")["availability"], "delegation_off");
    setting(&s, "project", pid, "agents.delegation", json!("ask")).await;
    let automatic = overview(&s, &query).await;
    assert_eq!(automatic["delegation"]["mode"], "auto");
    assert_eq!(automatic["delegation"]["source"], "session");
    setting(&s, "project", pid, "tools.mode", json!("bypass")).await;
    assert_eq!(
        role(&overview(&s, &query).await, "worker")["availability"],
        "available"
    );
    setting(&s, "project", pid, "tools.deny", json!("agent")).await;
    assert_eq!(
        overview(&s, &query).await["delegation"]["approval"],
        "blocked"
    );
    setting(&s, "project", pid, "tools.deny", json!("")).await;
    setting(&s, "project", pid, "agents.allowed_roles", json!("reviewer")).await;
    let limited = overview(&s, &query).await;
    assert_eq!(role(&limited, "worker")["availability"], "policy_denied");
    assert_eq!(role(&limited, "reviewer")["availability"], "available");
    assert_eq!(limited["delegation"]["approval"], "auto");
    setting(&s, "session", sid, "agents.orchestration", json!("solo")).await;
    let solo = overview(&s, &query).await;
    assert_eq!(solo["delegation"]["approval"], "blocked");
    assert_eq!(role(&solo, "reviewer")["availability"], "policy_denied");
    setting(&s, "session", sid, "agents.orchestration", json!("delegated")).await;
    setting(&s, "project", pid, "agents.allowed_roles", json!("*")).await;
    let parent = s.create_session(pid).await;
    let parent_id = parent["id"].as_str().unwrap().to_owned();
    let child_id = sid.to_owned();
    s.server.as_ref().unwrap().app.db.call(move |c| {
        c.execute("INSERT INTO agent_runs (id,parent_session_id,child_session_id,agent_id,profile_id,tools_enabled,depth,status,created_at,updated_at) VALUES ('overview-depth',?1,?2,'worker','fixture',1,?3,'completed','2026-01-01','2026-01-01')",
            rusqlite::params![parent_id,child_id,grove::agents::MAX_DEPTH])?;
        Ok(())
    }).await.unwrap();
    assert_eq!(
        role(&overview(&s, &query).await, "worker")["availability"],
        "depth_limit"
    );
    assert_eq!(overview(&s, &query).await["delegation"]["approval"], "blocked");
}

#[tokio::test]
async fn parent_turn_inheritance_is_not_next_request_default_and_read_does_not_run() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let parent_profile = s.fixture_profile(&f.base).await;
    let default_profile = s.fixture_profile(&f.base).await;
    let (st, _) = s
        .send(
            Method::PUT,
            &format!("/api/v1/model-profiles/{default_profile}"),
            json!({"expected_revision":1,"name":"next-request-only"}),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let p = s.create_project("overview-parent").await;
    let pid = p["id"].as_str().unwrap();
    let session = s.create_session(pid).await;
    let sid = session["id"].as_str().unwrap();
    let (gated, release) = fixture::gated_text("parent only");
    f.push(gated);
    let (st, turn) = s
        .post(
            &format!("/api/v1/sessions/{sid}/turns"),
            json!({"text":"parent fixture","profile_id":parent_profile,"tools":false}),
        )
        .await;
    assert_eq!(st, StatusCode::ACCEPTED);
    let tid = turn["turn"]["id"].as_str().unwrap();
    s.wait_turn(tid, |t| {
        t["status"] == "running" && !f.requests().is_empty()
    })
    .await;
    setting(
        &s,
        "project",
        pid,
        "model.default_profile",
        json!(default_profile),
    )
    .await;
    let requests = f.requests().len();
    let value = overview(&s, &format!("?session_id={sid}")).await;
    assert_eq!(value["parent"]["status"], "active");
    assert_eq!(value["parent"]["profile"]["status"], "configured");
    assert_eq!(value["parent"]["profile"]["name"], "fixture");
    assert_eq!(value["parent"]["tools_enabled"], false);
    assert_eq!(value["next_request_default"]["name"], "next-request-only");
    assert_eq!(value["next_request_default"]["source"], "project");
    assert_eq!(role(&value, "worker")["availability"], "tools_disabled");
    assert_eq!(f.requests().len(), requests);
    release.send_replace(true);
    s.wait_status(tid, "completed").await;
    assert_eq!(
        overview(&s, &format!("?session_id={sid}")).await["parent"]["status"],
        "no_active_turn"
    );
}

#[tokio::test]
async fn unset_disabled_missing_and_unknown_are_not_model_success() {
    let s = TestServer::start().await;
    assert_eq!(
        overview(&s, "").await["next_request_default"]["status"],
        "unset"
    );
    let profile = s.fixture_profile("http://127.0.0.1:9/v1").await;
    setting(&s, "server", "-", "model.default_profile", json!(profile)).await;
    for (sql, expected) in [
        ("UPDATE model_profiles SET enabled=0", "disabled"),
        (
            "UPDATE model_profiles SET deleted_at='2026-01-01'",
            "missing",
        ),
        (
            "UPDATE settings SET value='42' WHERE key='model.default_profile'",
            "unknown",
        ),
    ] {
        s.server
            .as_ref()
            .unwrap()
            .app
            .db
            .call(move |c| {
                c.execute(sql, [])?;
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(
            overview(&s, "").await["next_request_default"]["status"],
            expected
        );
    }
    s.server.as_ref().unwrap().app.db.call(|c| {
        c.execute("INSERT INTO settings(scope,scope_id,key,value,revision,updated_at) VALUES ('server','-','agents.delegation','\"unexpected\"',1,'2026-01-01')", [])?;
        Ok(())
    }).await.unwrap();
    assert_eq!(
        role(&overview(&s, "").await, "worker")["availability"],
        "unknown"
    );
}

#[tokio::test]
async fn authentication_target_validation_and_device_read_contract() {
    let s = TestServer::start().await;
    let p = s.create_project("overview-auth").await;
    let session = s.create_session(p["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap();
    let response = s
        .raw(Method::GET, "/api/v1/agent-overview", None, None, Some(""))
        .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let device = s.registered_device("overview-device").await;
    let response = s
        .raw(
            Method::GET,
            "/api/v1/agent-overview",
            None,
            None,
            device["token"].as_str(),
        )
        .await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "기존 definitions와 같은 Principal 조회 경계"
    );
    for (suffix, expected) in [
        ("?root=/home/private".to_string(), StatusCode::BAD_REQUEST),
        ("?project_id=".to_string(), StatusCode::BAD_REQUEST),
        ("?session_id=missing".to_string(), StatusCode::NOT_FOUND),
        (
            format!("?session_id={sid}&project_id=other"),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        assert_eq!(
            s.get(&format!("/api/v1/agent-overview{suffix}")).await.0,
            expected
        );
    }
    let (_, _) = s
        .send(
            Method::DELETE,
            &format!("/api/v1/devices/{}", device["id"].as_str().unwrap()),
            json!({}),
        )
        .await;
    let response = s
        .raw(
            Method::GET,
            "/api/v1/agent-overview",
            None,
            None,
            device["token"].as_str(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}
