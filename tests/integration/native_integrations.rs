//! 기억·hook·MCP는 외부 CLI가 소유한다. Grove의 이전 저장본은 실행·주입하지 않고 보존한다.
use crate::common;

use common::{TestServer, fixture::{self, Fixture}};
use reqwest::{Method, StatusCode};
use serde_json::json;

#[tokio::test]
async fn retired_features_are_not_advertised_or_routable() {
    let s = TestServer::start().await;
    let (_, health) = s.get("/api/v1/health").await;
    for capability in ["user_memories_v1", "mcp_settings_v1", "mcp_check_v1", "mcp_tools_v1", "bot_connections_v1", "computer_use_v1"] {
        assert!(!health["capabilities"].as_array().unwrap().iter().any(|value| value == capability));
    }
    for (method, path) in [
        (Method::GET, "/api/v1/memories"), (Method::POST, "/api/v1/memories"),
        (Method::PUT, "/api/v1/memories/old"), (Method::POST, "/api/v1/memories/old/delete"),
        (Method::GET, "/api/v1/hooks"), (Method::POST, "/api/v1/hooks"),
        (Method::GET, "/api/v1/hooks/executions"), (Method::PUT, "/api/v1/hooks/old"),
        (Method::GET, "/api/v1/mcp/servers"), (Method::POST, "/api/v1/mcp/servers"),
        (Method::POST, "/api/v1/mcp/servers/old/check"), (Method::POST, "/api/v1/mcp/servers/old/oauth/connect"),
        (Method::GET, "/api/v1/bots/old/connections"), (Method::PUT, "/api/v1/bots/old/connections"),
        (Method::GET, "/api/mcp-oauth/callback/old"), (Method::GET, "/api/v1/computer/status"),
    ] {
        let response = s.raw(method, path, Some(json!({})), Some("retired-route"), None).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
    for name in ["hook", "mcp_tools", "mcp_call", "memory", "computer"] {
        assert!(grove::tools::spec(name).is_none());
    }
}

#[tokio::test]
async fn legacy_records_survive_restart_without_model_injection_or_hook_execution() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("native-integrations").await;
    let pid = project["id"].as_str().unwrap().to_string();
    let root = std::path::PathBuf::from(project["root_path"].as_str().unwrap());
    let project_id = pid.clone();
    s.server.as_ref().unwrap().app.db.call(move |c| {
        let now = "2026-01-01T00:00:00Z";
        for (id, scope) in [("global", None), ("project", Some(project_id.as_str()))] {
            c.execute("INSERT INTO memories(id,project_id,body,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)",
                rusqlite::params![id, scope, format!("legacy-memory-canary-{id}"), now])?;
        }
        c.execute("INSERT INTO hook_definitions(id,name,event,matcher,command,enabled,created_at,updated_at) VALUES ('old-hook','old-hook','UserPromptSubmit','*','printf retired > legacy-hook-ran',1,?1,?1)", [now])?;
        c.execute("INSERT INTO mcp_servers(id,name,config,enabled,timeout_secs,created_at,updated_at) VALUES ('old-mcp','old-mcp',?1,1,30,?2,?2)",
            rusqlite::params![json!({"transport":"stdio","command":"legacy-mcp-must-not-run"}).to_string(), now])?;
        c.execute("INSERT INTO mcp_checks(server_id,id,status,started_at,owner_id,idem_key,request_hash) VALUES ('old-mcp','old-check','checking',?1,'old-owner','old-key','old-hash')", [now])?;
        Ok(())
    }).await.unwrap();
    s.restart().await;
    let (_, readiness) = s.get("/api/v1/admin/update-readiness").await;
    assert_eq!(readiness["idle"], true, "폐기한 MCP 확인 기록이 업데이트를 막지 않는다");
    assert!(readiness["busy"].get("running_mcp_checks").is_none());
    let session = s.create_session(&pid).await;
    let sid = session["id"].as_str().unwrap();
    let (_, usage) = s.get(&format!("/api/v1/sessions/{sid}/context?profile_id={profile}")).await;
    assert_eq!(usage["estimated_tokens"], 0, "기억 테이블은 context 추정에 더하지 않는다");
    assert!(usage.get("memory_input_tokens").is_none());
    f.push(fixture::text("native integration answer"));
    let (status, accepted) = s.post(&format!("/api/v1/sessions/{sid}/turns"),
        json!({"text":"fixture question","profile_id":profile})).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{accepted}");
    let tid = accepted["turn"]["id"].as_str().unwrap();
    let completed = s.wait_status(tid, "completed").await;
    assert!(completed["definition"].get("memories").is_none());
    assert!(!f.requests()[0].to_string().contains("legacy-memory-canary"));
    assert!(!root.join("legacy-hook-ran").exists());

    // 과거 snapshot은 DB에 보존하지만 API·모델 입력에는 되살리지 않는다.
    let old = json!({"memories":[{"body":"legacy-memory-canary-old-turn","sha256":"historical"}]});
    assert!(!grove::runner::system_prompt(&old, "/fixture", false).contains("legacy-memory-canary"));
    let id = tid.to_string();
    s.server.as_ref().unwrap().app.db.call(move |c| {
        assert_eq!(c.query_row("SELECT COUNT(*) FROM memories", [], |row| row.get::<_, i64>(0))?, 2);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM hook_definitions WHERE enabled=1", [], |row| row.get::<_, i64>(0))?, 1);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM hook_events", [], |row| row.get::<_, i64>(0))?, 0);
        assert_eq!(c.query_row("SELECT status FROM mcp_checks WHERE id='old-check'", [], |row| row.get::<_, String>(0))?, "checking");
        c.execute("UPDATE turns SET definition_snapshot=?2 WHERE id=?1", rusqlite::params![id, old.to_string()])?;
        Ok(())
    }).await.unwrap();
    let (_, historical) = s.get(&format!("/api/v1/turns/{tid}")).await;
    assert!(historical["definition"].get("memories").is_none());
}

#[tokio::test]
async fn retired_tool_requests_fail_and_legacy_pending_calls_cannot_be_approved() {
    let s = TestServer::start().await;
    let p = s.create_project("retired-tools").await;
    let session = s.create_session(p["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap();
    for name in ["hook", "mcp_call", "mcp_tools"] {
        let (status, call) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"), json!({"name":name,"args":{}})).await;
        assert_eq!(status, StatusCode::CREATED, "{call}");
        assert_eq!(call["status"], "failed");
        assert_eq!(call["result"]["error"]["code"], "unsupported_tool");
        let id = call["id"].as_str().unwrap().to_string();
        let stored_id = id.clone();
        s.server.as_ref().unwrap().app.db.call(move |c| {
            c.execute("UPDATE tool_calls SET status='pending_approval',needs_approval=1,result=NULL,expires_at='2099-01-01T00:00:00Z' WHERE id=?1", [&stored_id])?;
            Ok(())
        }).await.unwrap();
        let (status, error) = s.post(&format!("/api/v1/tool-calls/{id}/decision"),
            json!({"decision":"approve","expected_revision":call["revision"]})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["error"]["code"], "unsupported_tool");
        let (_, unchanged) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
        assert_eq!(unchanged["status"], "pending_approval");
        let (status, denied) = s.post(&format!("/api/v1/tool-calls/{id}/decision"),
            json!({"decision":"deny","expected_revision":call["revision"]})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(denied["status"], "denied");
    }
}
