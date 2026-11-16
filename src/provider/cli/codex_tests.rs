use super::*;
use crate::provider::{ChatMsg, ImageInput, cli::CliContext};
use std::time::Duration;

fn profile() -> Profile {
    Profile {
        protocol: "codex_cli".into(),
        model: "fixture-model".into(),
        base_url: String::new(),
        api_key: None,
        timeout: Duration::from_secs(3),
        extra_headers: vec![],
        sensitive_headers: vec![],
    }
}

fn request(root: &std::path::Path, resume: Option<&str>, text: &str) -> ModelRequest {
    ModelRequest {
        system: "system fixture".into(),
        messages: vec![
            ChatMsg::User {
                text: "previous user".into(),
                images: vec![],
            },
            ChatMsg::Assistant {
                text: "previous assistant".into(),
                tool_calls: vec![],
                native: None,
            },
            ChatMsg::User {
                text: text.into(),
                images: vec![],
            },
        ],
        tools: vec![],
        max_tokens: None,
        temperature: None,
        effort: Some("xhigh".into()),
        cli: Some(CliContext {
            cwd: root.into(),
            resume: resume.map(String::from),
            service_tier: Some("priority".into()),
            computer: None,
        }),
    }
}

#[cfg(unix)]
fn fixture(root: &std::path::Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let file = root.join("fake-codex");
    std::fs::write(
        &file,
        include_str!("../../../tests/fixtures/codex_app_server.py"),
    )
    .unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
    file
}

#[cfg(unix)]
fn wire(root: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(root.join("wire.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[cfg(unix)]
#[tokio::test]
async fn real_process_streams_deltas_before_completion_and_preserves_resume_settings_and_images() {
    use base64::Engine;
    for resume in [None, Some("existing-exec-thread")] {
        let dir = tempfile::tempdir().unwrap();
        let mut req = request(dir.path(), resume, "current user");
        let mut image = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut image, image::ImageFormat::Png)
            .unwrap();
        let data = image.into_inner();
        let image = ImageInput {
            id: "image".into(),
            sha256: crate::util::sha256_hex(&data),
            width: 2,
            height: 2,
            mime: "image/png".into(),
            data: base64::engine::general_purpose::STANDARD.encode(data),
        };
        if let ChatMsg::User { images, .. } = &mut req.messages[0] {
            images.push(image.clone());
        }
        if let ChatMsg::User { images, .. } = req.messages.last_mut().unwrap() {
            images.push(image);
        }
        let mut snapshots = Vec::new();
        let output = super::super::stream_with(
            &profile(),
            &req,
            &mut |out| snapshots.push(out.clone()),
            Some(&fixture(dir.path())),
        )
        .await
        .unwrap();
        assert!(
            snapshots
                .iter()
                .any(|out| out.text == "첫" && out.finish_reason.is_empty())
        );
        assert!(
            snapshots
                .iter()
                .any(|out| out.text == "첫 답\n\n최종" && out.finish_reason.is_empty())
        );
        assert_eq!(output.text, "첫 답\n\n최종 답");
        assert_eq!(output.response_parts, ["첫 답", "최종 답"]);
        assert_eq!(output.reasoning, "요약");
        assert_eq!(
            output.native_session.as_deref(),
            Some(resume.unwrap_or("thread-new"))
        );
        assert!(
            output.tool_calls.is_empty(),
            "native 도구를 Grove가 다시 실행하지 않는다"
        );
        assert_eq!(output.activity.len(), 1);
        assert_eq!(output.activity[0]["status"], "completed");
        assert!(snapshots.iter().any(|out| {
            out.activity
                .first()
                .is_some_and(|item| item["status"] == "in_progress")
        }));
        assert_eq!(
            (
                output.usage.input_tokens,
                output.usage.output_tokens,
                output.usage.cache_read_tokens
            ),
            (100, 5, 60)
        );
        assert_eq!(output.usage.reasoning_tokens, Some(3));
        assert_eq!(output.finish_reason, "stop");
        let wire = wire(dir.path());
        assert_eq!(
            wire.iter()
                .filter_map(|row| row["method"].as_str())
                .collect::<Vec<_>>(),
            [
                "initialize",
                "initialized",
                if resume.is_some() {
                    "thread/resume"
                } else {
                    "thread/start"
                },
                "turn/start"
            ]
        );
        let thread = &wire[2]["params"];
        assert_eq!(thread["approvalPolicy"], "never");
        assert_eq!(thread["sandbox"], "danger-full-access");
        assert_eq!(thread["model"], "fixture-model");
        assert_eq!(thread["serviceTier"], "priority");
        if resume.is_some() {
            assert_eq!(thread["threadId"], "existing-exec-thread");
        }
        let turn = &wire[3]["params"];
        assert_eq!(turn["effort"], "xhigh");
        assert_eq!(turn["serviceTier"], "priority");
        assert_eq!(turn["sandboxPolicy"]["type"], "dangerFullAccess");
        let text = turn["input"][0]["text"].as_str().unwrap();
        if resume.is_some() {
            assert_eq!(text, "current user");
        } else {
            assert!(text.contains("system fixture") && text.contains("previous assistant"));
        }
        let images = turn["input"].as_array().unwrap();
        assert_eq!(images.len(), if resume.is_some() { 2 } else { 3 });
        for image in &images[1..] {
            assert_eq!(image["type"], "localImage");
            assert!(
                !std::path::Path::new(image["path"].as_str().unwrap()).exists(),
                "호출별 이미지 temp 정리"
            );
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn rejected_requests_and_terminal_failures_never_succeed_or_replay() {
    for (text, resume, code) in [
        ("RPC_FAIL", None, "cli_failed"),
        ("TURN_FAIL", None, "cli_failed"),
        ("INTERRUPTED", None, "cli_exited"),
        ("NO_FINAL", None, "cli_exited"),
        ("EXIT_FAIL", None, "cli_exited"),
        ("INTERACTION", None, "cli_interaction_required"),
        ("current", Some("missing-thread"), "cli_failed"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let req = request(dir.path(), resume, text);
        let result =
            super::super::stream_with(&profile(), &req, &mut |_| {}, Some(&fixture(dir.path())))
                .await;
        let error = result.unwrap_err();
        assert_eq!(error.code, code, "{text}: {error:?}");
        assert!(!error.retryable);
        assert_eq!(
            wire(dir.path())
                .iter()
                .filter(|row| row["method"] == "turn/start")
                .count(),
            usize::from(resume.is_none())
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn idle_and_output_limits_are_enforced_for_live_processes() {
    for (text, code) in [
        ("HANG", "idle_timeout"),
        ("HANG OVERSIZE", "output_too_large"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let req = request(dir.path(), None, text);
        let mut profile = profile();
        profile.timeout = Duration::from_millis(500);
        let result =
            super::super::stream_with(&profile, &req, &mut |_| {}, Some(&fixture(dir.path())))
                .await;
        assert_eq!(result.unwrap_err().code, code);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn cancellation_drops_the_owned_process_while_it_is_still_streaming() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(dir.path(), None, "HANG");
    let executable = fixture(dir.path());
    let (sent, received) = tokio::sync::oneshot::channel();
    let mut sent = Some(sent);
    let task = tokio::spawn(async move {
        super::super::stream_with(
            &profile(),
            &req,
            &mut |out| {
                if out.text == "첫"
                    && let Some(sent) = sent.take()
                {
                    let _ = sent.send(());
                }
            },
            Some(&executable),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(3), received)
        .await
        .unwrap()
        .unwrap();
    assert!(
        !task.is_finished(),
        "완료를 기다리지 않고 실제 부분 응답이 전달된다"
    );
    let pid: i32 = std::fs::read_to_string(dir.path().join("native-pid"))
        .unwrap()
        .parse()
        .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(3), async {
        // Child의 비동기 reaper가 종료한 leader를 회수할 때까지 기다린다.
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("취소 후 native 프로세스가 남으면 안 된다");
}

#[test]
fn final_snapshots_replace_deltas_and_summary_parts_keep_their_order() {
    let mut state = State {
        thread: "thread".into(),
        turn: Some("turn".into()),
        ..Default::default()
    };
    let notification = |method: &str, params: Value| {
        let mut params = params;
        params["threadId"] = json!("thread");
        params["turnId"] = json!("turn");
        json!({"method":method,"params":params})
    };
    for (method, params) in [
        (
            "item/agentMessage/delta",
            json!({"itemId":"m","delta":"일부"}),
        ),
        (
            "item/completed",
            json!({"item":{"id":"m","type":"agentMessage","text":"확정"}}),
        ),
        (
            "item/reasoning/summaryTextDelta",
            json!({"itemId":"r","summaryIndex":0,"delta":"첫 요약"}),
        ),
        (
            "item/reasoning/summaryTextDelta",
            json!({"itemId":"r","summaryIndex":1,"delta":"둘째 요약"}),
        ),
    ] {
        state.notification(&notification(method, params)).unwrap();
    }
    assert_eq!(state.output.text, "확정");
    assert_eq!(state.output.reasoning, "첫 요약\n\n둘째 요약");
    let error = state
        .notification(&notification(
            "item/reasoning/summaryTextDelta",
            json!({"itemId":"r","summaryIndex":MAX_ACTIVITY,"delta":"invalid"}),
        ))
        .unwrap_err();
    assert_eq!(error.code, "cli_protocol_error");
}

#[test]
fn model_default_and_auto_options_are_not_forced() {
    let dir = tempfile::tempdir().unwrap();
    let mut req = request(dir.path(), None, "current");
    req.effort = None;
    req.cli.as_mut().unwrap().service_tier = None;
    let mut profile = profile();
    profile.model = "default".into();
    let thread = thread_params(&profile, &req);
    let turn = turn_params(&profile, &req, "thread", &[]);
    assert!(thread.get("model").is_none() && thread.get("serviceTier").is_none());
    assert!(
        turn.get("model").is_none()
            && turn.get("effort").is_none()
            && turn.get("serviceTier").is_none()
    );
}

/// 설치된 CLI와 로컬 Responses fixture로 확인한다. 로그인·외부 모델 호출·사용자 설정은 쓰지 않는다.
#[cfg(unix)]
#[tokio::test]
#[ignore = "requires installed codex; only a test-owned loopback Responses server is used"]
async fn installed_cli_streams_local_responses_before_completion_and_resumes() {
    use axum::{
        Json, Router,
        response::sse::{Event, Sse},
        routing::post,
    };
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::sync::{Notify, mpsc};

    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("codex-home");
    std::fs::create_dir(&home).unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let gates = Arc::new([Notify::new(), Notify::new()]);
    let route = {
        let (count, requests, gates) = (count.clone(), requests.clone(), gates.clone());
        post(
            move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                let (count, requests, gates) = (count.clone(), requests.clone(), gates.clone());
                async move {
                    assert!(
                        !headers.contains_key("authorization"),
                        "실제 자격증명을 fixture에 보내지 않는다"
                    );
                    requests.lock().unwrap().push(body);
                    let index = count.fetch_add(1, Ordering::SeqCst);
                    let (tx, rx) = mpsc::channel::<Result<Event, std::convert::Infallible>>(16);
                    tokio::spawn(async move {
                        let emit = |name: &'static str, value: Value| {
                            let tx = tx.clone();
                            async move {
                                tx.send(Ok(Event::default().event(name).data(value.to_string())))
                                    .await
                                    .unwrap();
                            }
                        };
                        let id = format!("response_{index}");
                        let item = format!("message_{index}");
                        let message = json!({"id":item,"type":"message","role":"assistant","status":"completed",
                        "content":[{"type":"output_text","text":"STREAM_DONE","annotations":[]}]});
                        emit("response.created", json!({"type":"response.created","response":{"id":id,"status":"in_progress","output":[]}})).await;
                        emit("response.output_item.added", json!({"type":"response.output_item.added","output_index":0,
                        "item":{"id":item,"type":"message","role":"assistant","status":"in_progress","content":[]}})).await;
                        emit("response.content_part.added", json!({"type":"response.content_part.added","item_id":item,
                        "output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}})).await;
                        emit(
                            "response.output_text.delta",
                            json!({"type":"response.output_text.delta","item_id":item,
                        "output_index":0,"content_index":0,"delta":"STREAM"}),
                        )
                        .await;
                        // Grove가 실제 부분 출력을 받은 뒤에만 공급자가 나머지 결과를 보낸다.
                        gates[index].notified().await;
                        emit(
                            "response.output_text.delta",
                            json!({"type":"response.output_text.delta","item_id":item,
                        "output_index":0,"content_index":0,"delta":"_DONE"}),
                        )
                        .await;
                        emit(
                            "response.output_text.done",
                            json!({"type":"response.output_text.done","item_id":item,
                        "output_index":0,"content_index":0,"text":"STREAM_DONE"}),
                        )
                        .await;
                        emit("response.output_item.done", json!({"type":"response.output_item.done","output_index":0,"item":message})).await;
                        emit("response.completed", json!({"type":"response.completed","response":{"id":id,
                        "status":"completed","output":[message],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12,
                        "input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":0}}}})).await;
                    });
                    Sse::new(futures_util::stream::unfold(rx, |mut rx| async {
                        rx.recv().await.map(|event| (event, rx))
                    }))
                }
            },
        )
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, Router::new().route("/v1/responses", route))
            .await
            .unwrap();
    });
    let executable = dir.path().join("isolated-codex");
    let quoted_home = home.to_string_lossy().replace('\'', "'\\''");
    std::fs::write(&executable, format!(
        "#!/bin/sh\nexport CODEX_HOME='{quoted_home}'\nunset OPENAI_API_KEY CODEX_API_KEY\n\
         exec codex \"$@\" -c 'model_provider=\"grove_fixture\"' -c 'model_providers.grove_fixture={{name=\"Grove fixture\",base_url=\"{base}\",wire_api=\"responses\",requires_openai_auth=false,supports_websockets=false}}' -c 'web_search=\"disabled\"'\n"
    )).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut native = None;
    for index in 0..2 {
        let req = request(dir.path(), native.as_deref(), "local fixture only");
        let mut profile = profile();
        profile.timeout = Duration::from_secs(15);
        let mut observed = false;
        let output = super::super::stream_with(
            &profile,
            &req,
            &mut |out| {
                if out.text == "STREAM" && out.finish_reason.is_empty() {
                    observed = true;
                    gates[index].notify_one();
                }
            },
            Some(&executable),
        )
        .await
        .unwrap();
        assert!(
            observed,
            "실제 CLI가 공급자 완료 전에 delta를 전달해야 한다"
        );
        assert_eq!(output.text, "STREAM_DONE");
        assert_eq!(output.finish_reason, "stop");
        assert!(output.usage.output_tokens > 0);
        if index == 0 {
            native = output.native_session;
        } else {
            assert_eq!(output.native_session, native);
        }
    }
    server.abort();
    let requests = requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        2,
        "실패·완료한 모델 호출을 재접수하지 않는다"
    );
    assert!(
        requests[1]["input"].to_string().contains("STREAM_DONE"),
        "재개한 thread에 이전 응답이 보존된다"
    );
}
