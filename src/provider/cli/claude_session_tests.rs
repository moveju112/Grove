use super::*;
use crate::provider::{ChatMsg, cli::CliContext};
use std::os::unix::fs::PermissionsExt;

fn fixture(root: &Path) -> PathBuf {
    let path = root.join("claude");
    std::fs::write(&path, include_str!("../../../tests/fixtures/claude_session.py")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    path
}

fn handle() -> Handle {
    Handle { sessions: Arc::default(), session: "grove-session".into(), profile: "profile".into() }
}

fn profile(timeout: Duration) -> Profile {
    Profile { protocol: "claude_code".into(), base_url: String::new(), model: "default".into(),
        api_key: None, timeout, extra_headers: vec![], sensitive_headers: vec![] }
}

fn request(root: &Path, resume: Option<String>, text: &str) -> ModelRequest {
    ModelRequest {
        messages: vec![ChatMsg::User { text: text.into(), images: vec![] }],
        cli: Some(CliContext { cwd: root.into(), resume, ..Default::default() }),
        tools: vec![], system: "instructions".into(), max_tokens: None, temperature: None, effort: None,
    }
}

fn records(root: &Path) -> Vec<Value> {
    std::fs::read_to_string(root.join("wire.jsonl")).unwrap().lines()
        .map(|line| serde_json::from_str(line).unwrap()).collect()
}

#[tokio::test]
async fn reuses_one_process_and_replaces_turn_mcp_then_resumes_with_changed_effort() {
    let root = tempfile::tempdir().unwrap();
    let cli = fixture(root.path());
    let handle = handle();
    let profile = profile(Duration::from_secs(3));
    let mut req = request(root.path(), None, "first");
    let set_link = |req: &mut ModelRequest, name| {
        req.cli.as_mut().unwrap().continuations = Some(crate::continuations::bridge::Link {
            file: root.path().join(name), exe: std::env::current_exe().unwrap(), waiting: Arc::default(), tools: vec!["continue_later", "shell", "agent"],
        });
    };
    set_link(&mut req, "turn-one");
    let first = run(&handle, &profile, &req, &mut |_| {}, Some(&cli)).await.unwrap();
    req = request(root.path(), first.native_session.clone(), "second");
    set_link(&mut req, "turn-two");
    let second = run(&handle, &profile, &req, &mut |_| {}, Some(&cli)).await.unwrap();
    assert_eq!(second.native_session, first.native_session);
    assert_eq!(second.text, "second");
    assert_eq!(second.usage.output_tokens, 1);
    assert_eq!(first.usage.model_request_ms, Some(10));
    assert_eq!(second.usage.model_request_ms, Some(10));
    let wire = records(root.path());
    assert_eq!(wire.iter().map(|e| e["event"].as_str().unwrap()).collect::<Vec<_>>(),
        ["spawn", "mcp", "user", "mcp", "mcp", "user", "mcp"]);
    assert!(wire.iter().all(|entry| entry["pid"] == wire[0]["pid"]));
    assert_eq!(wire[2]["link"], root.path().join("turn-one").to_str().unwrap());
    assert_eq!(wire[5]["link"], root.path().join("turn-two").to_str().unwrap());
    assert!(wire[3]["link"].is_null() && wire[6]["link"].is_null());

    req.effort = Some("high".into());
    let reconfigured = run(&handle, &profile, &req, &mut |_| {}, Some(&cli)).await.unwrap();
    assert_eq!(reconfigured.native_session, first.native_session);
    let wire = records(root.path());
    assert_eq!(wire[7]["resumed"], true);
    assert_ne!(wire[7]["pid"], wire[0]["pid"]);

    req.system = "changed instructions".into();
    req.cli.as_mut().unwrap().resume = None; // runner는 지침 hash가 달라지면 resume을 내주지 않는다.
    let changed = run(&handle, &profile, &req, &mut |_| {}, Some(&cli)).await.unwrap();
    assert_ne!(changed.native_session, first.native_session);
    handle.sessions.close();
    assert_eq!(run(&handle, &profile, &req, &mut |_| {}, Some(&cli)).await.unwrap_err().code, "cancelled");
}

#[tokio::test]
async fn missing_api_time_keeps_tokens_but_does_not_invent_speed() {
    let root = tempfile::tempdir().unwrap();
    let cli = fixture(root.path());
    let handle = handle();
    let profile = profile(Duration::from_secs(3));
    let mut resume = None;
    for (prompt, ms) in [("first", Some(10)), ("untimed", None), ("recover baseline", None), ("timed again", Some(10))] {
        let out = run(&handle, &profile, &request(root.path(), resume, prompt), &mut |_| {}, Some(&cli)).await.unwrap();
        assert_eq!(out.usage.output_tokens, 1);
        assert_eq!(out.usage.model_request_ms, ms, "{prompt}");
        resume = out.native_session;
    }
    assert_eq!(records(root.path()).iter().filter(|row| row["event"] == "spawn").count(), 1);
}

#[tokio::test]
async fn cancellation_and_timeout_discard_the_process_without_replaying_the_turn() {
    let root = tempfile::tempdir().unwrap();
    let cli = fixture(root.path());
    let handle = handle();
    let profile = profile(Duration::from_secs(2));
    let first = run(&handle, &profile, &request(root.path(), None, "first"), &mut |_| {}, Some(&cli)).await.unwrap();
    let hold = request(root.path(), first.native_session.clone(), "hold");
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    let mut tx = Some(tx);
    let mut delta = |output: &ModelOutput| {
        if output.text == "started" && let Some(tx) = tx.take() { tx.send(()).unwrap(); }
    };
    {
        let mut pending = std::pin::pin!(run(&handle, &profile, &hold, &mut delta, Some(&cli)));
        tokio::select! {
            result = &mut pending => panic!("취소 전 종료됨: {}", result.unwrap_err().code),
            ready = &mut rx => ready.unwrap(),
        }
    }
    assert!(handle.sessions.0.lock().unwrap().idle.is_empty());
    let err = run(&handle, &profile, &hold, &mut |_| {}, Some(&cli)).await.unwrap_err();
    assert_eq!(err.code, "idle_timeout");
    let next = request(root.path(), first.native_session, "next");
    run(&handle, &profile, &next, &mut |_| {}, Some(&cli)).await.unwrap();
    let wire = records(root.path());
    let pids: Vec<_> = wire.iter().filter(|e| e["event"] == "spawn").map(|e| e["pid"].as_u64().unwrap()).collect();
    assert_eq!(pids.len(), 3);
    assert_ne!(pids[0], pids[1]);
    assert_ne!(pids[1], pids[2]);
    assert_eq!(wire.iter().filter(|e| e["event"] == "user").count(), 4);
}

#[tokio::test]
async fn native_session_accepts_non_subscription_cli_authentication() {
    let profile = profile(Duration::from_secs(3));
    for method in ["api_key", "api_key_helper", "third_party"] {
        let root = tempfile::tempdir().unwrap();
        let cli = fixture(root.path());
        std::fs::write(root.path().join("auth-method"), method).unwrap();
        run(&handle(), &profile, &request(root.path(), None, "send"), &mut |_| {}, Some(&cli)).await.unwrap();
        assert!(records(root.path()).iter().any(|e| e["event"] == "user" && e["text"] == "send"));
    }
}

#[tokio::test]
async fn live_steer_reaches_the_running_turn_at_a_tool_boundary_or_the_next_cli_turn() {
    for (prompt, parts, output_tokens) in [("steer-tool", 1, 1), ("steer-after", 1, 3)] {
        let root = tempfile::tempdir().unwrap();
        let cli = fixture(root.path());
        let (app, tid) = crate::provider::cli::codex::tests::live_app(root.path());
        let mut req = request(root.path(), None, prompt);
        req.cli.as_mut().unwrap().steers = Some(crate::followups::live::LiveSteers::new(&app, &tid));
        let (ready, started) = tokio::sync::oneshot::channel();
        let mut ready = Some(ready);
        let task = tokio::spawn(async move {
            run(&handle(), &profile(Duration::from_secs(3)), &req, &mut |out| {
                if out.text == "started" && let Some(ready) = ready.take() { let _ = ready.send(()); }
            }, Some(&cli)).await
        });
        started.await.unwrap();
        let id = crate::util::new_id();
        crate::provider::cli::codex::tests::live_followup(&app, &id, "addition").await;
        let out = task.await.unwrap().unwrap();
        assert_eq!(out.response_steers, [(id.clone(), parts)], "{prompt}");
        assert_eq!(out.response_parts.last().map(String::as_str), Some("merged"), "{prompt}");
        assert_eq!(out.usage.output_tokens, output_tokens, "{prompt}");
        assert_eq!(out.usage.model_request_ms, Some(if prompt == "steer-after" { 30 } else { 10 }), "{prompt}");
        let wire = records(root.path());
        let steer = wire.iter().find(|e| e["event"] == "steer").unwrap();
        assert_eq!((steer["text"].as_str(), steer["uuid"].as_str()), (Some("addition"), Some(id.as_str())));
        app.db.call(move |c| {
            assert!(crate::followups::list(c, "live-session")?.is_empty());
            let count: i64 = c.query_row("SELECT COUNT(*) FROM messages WHERE turn_id=?1 AND json_extract(content,'$.source.followup_id')=?2",
                rusqlite::params![tid, id], |r| r.get(0))?;
            assert_eq!(count, 1);
            Ok(())
        }).await.unwrap();
    }
}

#[tokio::test]
async fn parked_claude_exports_late_usage_without_another_turn() {
    let root = tempfile::tempdir().unwrap();
    let cli = fixture(root.path());
    let handle = handle();
    let mut req = request(root.path(), None, "usage-after-result");
    req.cli.as_mut().unwrap().usage_data_dir = Some(root.path().into());
    let result = run(&handle, &profile(Duration::from_secs(3)), &req, &mut |_| {}, Some(&cli)).await.unwrap();
    assert_eq!(result.text, "usage-after-result");
    let path = root.path().join("usage/v1/claude.json");
    tokio::time::timeout(Duration::from_secs(3), async {
        while !path.is_file() { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.unwrap();
    let snap: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(snap["windows"]["seven_day"]["used_percent"], 25.0);
}
