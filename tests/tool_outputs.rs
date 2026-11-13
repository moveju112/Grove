//! CTX-012: 실제 도구 경로·권한·범위 조회·DB 정본 복구.
mod common;

use common::fixture::{self, Fixture};
use common::*;
use grove::tool_outputs::{EXCERPT_BYTES, INLINE_BYTES, MAX_READ_BYTES};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn request(s: &TestServer, sid: &str, name: &str, args: Value) -> Value {
    let (status, call) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"), json!({"name":name,"args":args})).await;
    assert_eq!(status, StatusCode::CREATED, "{call}");
    let id = call["id"].as_str().unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let (_, call) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
        if grove::approvals::TERMINAL.contains(&call["status"].as_str().unwrap()) { return call; }
        assert!(tokio::time::Instant::now() < deadline, "{call}");
        tokio::task::yield_now().await;
    }
}

async fn read(s: &TestServer, sid: &str, id: &str, offset: usize, limit: usize) -> Value {
    request(s, sid, "tool_output_read", json!({"call_id":id,"offset":offset,"limit":limit})).await
}

async fn seed(s: &TestServer, sid: &str, status: &str, result: Value, message: bool) -> String {
    let app = s.server.as_ref().unwrap().app.clone();
    let (sid, status, now) = (sid.to_string(), status.to_string(), app.now());
    app.db.call(move |c| {
        let tx = c.transaction()?;
        let session = grove::sessions::get(&tx, &sid)?;
        let root = grove::sessions::exec_root(&tx, &sid)?;
        let call = grove::approvals::create_call(&tx, &now, 1800, &sid, &session.project_id, &root, None, None, "list", &json!({}))?;
        let call = grove::approvals::finish(&tx, &now, &call.id, &["approved"], &status, Some(result))?.unwrap();
        if message {
            grove::sessions::append_message(&tx, &now, &sid, "tool",
                &json!({"call_id":call.id,"status":call.status,"output":call.result,"name":call.name}),
                None, None)?;
        }
        tx.commit()?;
        Ok(call.id)
    }).await.unwrap()
}

async fn fork(s: &TestServer, sid: &str, seq: i64, inherit: bool) -> String {
    let (status, child) = s.post(&format!("/api/v1/sessions/{sid}/fork"), json!({"from_seq":seq,"inherit_context":inherit})).await;
    assert_eq!(status, StatusCode::CREATED, "{child}");
    child["id"].as_str().unwrap().to_string()
}

fn copy_path(s: &TestServer, id: &str) -> std::path::PathBuf {
    s.data_dir().join("tool-outputs").join(format!("{}.txt", grove::util::sha256_hex(id.as_bytes())))
}

#[cfg(unix)]
#[tokio::test]
async fn real_model_flow_preserves_original_pair_identity_and_reads_every_remaining_byte() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("outputs").await;
    let sid = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    std::fs::write(std::path::Path::new(project["root_path"].as_str().unwrap()).join("output.txt"),
        format!("시작😀{}OUTPUT-END", "x".repeat(45000))).unwrap();
    let (st, _) = s.send(Method::PUT, &format!("/api/v1/settings/project/{}/tools.allow", project["id"].as_str().unwrap()),
        json!({"expected_revision":0,"value":"shell"})).await;
    assert_eq!(st, StatusCode::OK);
    f.push(fixture::tool_calls(&[("provider-large", "shell", json!({
        "command":"printf run >> executions; cat output.txt"
    }))]));
    f.push(fixture::text("stored"));
    let (_, turn) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"large","profile_id":profile,"tools":true})).await;
    let turn = s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
    let call = &turn["tool_calls"][0];
    assert_eq!(call["status"], "succeeded");
    assert_eq!(call["provider_call_id"], "provider-large");
    let id = call["id"].as_str().unwrap();
    let original = grove::provider::tool_content_string(&call["result"]);
    assert!(original.len() > INLINE_BYTES);
    let (_, messages) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let msg = messages["items"].as_array().unwrap().iter().find(|m| m["role"] == "tool").unwrap();
    assert_eq!(msg["content"]["output"], call["result"]);
    assert_eq!(msg["content"]["is_error"], false);
    let sent = f.requests();
    let tool = sent[1]["messages"].as_array().unwrap().iter().find(|m| m["role"] == "tool").unwrap();
    assert_eq!(tool["tool_call_id"], "provider-large");
    let reference: Value = serde_json::from_str(tool["content"].as_str().unwrap()).unwrap();
    assert_eq!(reference["kind"], "tool_output_reference");
    assert_eq!(reference["call_id"], id);
    assert_eq!(reference["total_bytes"], original.len());
    assert_eq!(reference["complete"], false);
    assert!(reference["excerpt"].as_str().unwrap().len() <= EXCERPT_BYTES);
    assert!(!tool["content"].as_str().unwrap().contains("OUTPUT-END"));
    assert!(tool["content"].as_str().unwrap().len() < grove::tools::MAX_OUTPUT);
    let mut rebuilt = reference["excerpt"].as_str().unwrap().to_string();
    let mut offset = reference["next_offset"].as_u64().unwrap() as usize;
    loop {
        let chunk = read(&s, &sid, id, offset, MAX_READ_BYTES).await;
        assert_eq!(chunk["status"], "succeeded", "{chunk}");
        assert!(chunk["result"].to_string().len() <= grove::tools::MAX_OUTPUT);
        let result = &chunk["result"];
        assert_eq!(result["call_id"], id);
        assert_eq!(result["offset"], offset);
        rebuilt.push_str(result["text"].as_str().unwrap());
        if result["next_offset"].is_null() { break; }
        let next = result["next_offset"].as_u64().unwrap() as usize;
        assert!(next > offset);
        offset = next;
    }
    assert_eq!(rebuilt, original);
    assert_eq!(std::fs::read_to_string(copy_path(&s, id)).unwrap(), original);
    // 모델이 실제 registry 도구로 참조를 읽고 다음 provider 요청에 제한된 결과를 받는다.
    f.push(fixture::tool_calls(&[("provider-read", "tool_output_read", reference["read"]["arguments"].clone())]));
    f.push(fixture::text("retrieved"));
    let (_, t) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"read reference","profile_id":profile,"tools":true})).await;
    let t = s.wait_status(t["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(t["tool_calls"][0]["status"], "succeeded");
    let sent = f.requests();
    let retrieved = sent.last().unwrap()["messages"].as_array().unwrap().iter().find(|m| m["tool_call_id"] == "provider-read").unwrap();
    let retrieved: Value = serde_json::from_str(retrieved["content"].as_str().unwrap()).unwrap();
    assert_eq!(retrieved["call_id"], id);
    assert_eq!(retrieved["text"], original[EXCERPT_BYTES..EXCERPT_BYTES + MAX_READ_BYTES]);
    assert_eq!(std::fs::read_to_string(std::path::Path::new(project["root_path"].as_str().unwrap()).join("executions")).unwrap(), "run");
}

#[tokio::test]
async fn fork_visibility_excludes_future_rewound_uninherited_and_other_session_or_project_calls() {
    let s = TestServer::start().await;
    let project = s.create_project("visibility").await;
    let parent = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let id = seed(&s, &parent, "succeeded", json!("가😀".repeat(5000)), true).await;
    let child = fork(&s, &parent, 1, true).await;
    let nested = fork(&s, &child, 0, true).await;
    for sid in [&parent, &child, &nested] { assert_eq!(read(&s, sid, &id, 0, 100).await["status"], "succeeded"); }
    let late = seed(&s, &parent, "succeeded", json!("future"), true).await;
    assert_eq!(read(&s, &child, &late, 0, 100).await["result"]["error"]["code"], "not_found");
    let early = fork(&s, &parent, 0, true).await;
    let no_context = fork(&s, &parent, 2, false).await;
    let sibling = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let other_project = s.create_project("other").await;
    let other = s.create_session(other_project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    for sid in [&early, &no_context, &sibling, &other] {
        assert_eq!(read(&s, sid, &id, 0, 100).await["result"]["error"]["code"], "not_found");
    }
    // 직접 요청에는 상속할 tool 메시지가 없으므로 자식에 노출하지 않는다.
    let direct = seed(&s, &parent, "succeeded", json!("direct"), false).await;
    assert_eq!(read(&s, &parent, &direct, 0, 100).await["status"], "succeeded");
    assert_eq!(read(&s, &child, &direct, 0, 100).await["result"]["error"]["code"], "not_found");
    let app = s.server.as_ref().unwrap().app.clone();
    let rewound = id.clone();
    app.db.call(move |c| {
        c.execute("UPDATE messages SET rewound_at='2026-01-01' WHERE json_extract(content,'$.call_id')=?1", [rewound])?;
        Ok(())
    }).await.unwrap();
    assert_eq!(read(&s, &child, &id, 0, 100).await["result"]["error"]["code"], "not_found");
}

#[tokio::test]
async fn unicode_ranges_and_escaped_responses_are_finite_and_under_the_existing_output_limit() {
    let s = TestServer::start().await;
    let project = s.create_project("unicode").await;
    let sid = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let text = format!("가😀{}", "\0\n\"".repeat(6000));
    let id = seed(&s, &sid, "succeeded", json!(text), false).await;
    for (offset, limit) in [(0, 3), (3, 4), (7, MAX_READ_BYTES), (text.len(), 1)] {
        let call = read(&s, &sid, &id, offset, limit).await;
        assert_eq!(call["status"], "succeeded", "{call}");
        assert!(call["result"]["text"].as_str().unwrap().len() <= limit);
        assert!(call["result"].to_string().len() < grove::tools::MAX_OUTPUT);
        assert_eq!(call["result"]["text"], text[offset..call["result"]["end_offset"].as_u64().unwrap() as usize]);
    }
    for (offset, limit) in [(1, 10), (0, 1), (text.len() + 1, 100), (0, 0), (0, MAX_READ_BYTES + 1)] {
        assert_eq!(read(&s, &sid, &id, offset, limit).await["status"], "failed");
    }
    let (_, call) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"),
        json!({"name":"tool_output_read","args":{"call_id":id,"path":"/etc/passwd"}})).await;
    assert_eq!(call["status"], "failed");
    assert_eq!(read(&s, &sid, &"x".repeat(129), 0, 10).await["status"], "failed");
    // 조회 결과는 자기 자신을 offload하지 않는다. 재조회해도 한 응답 상한은 동일하다.
    let chunk = read(&s, &sid, &id, 7, MAX_READ_BYTES).await;
    let nested = read(&s, &sid, chunk["id"].as_str().unwrap(), 0, MAX_READ_BYTES).await;
    assert_eq!(nested["status"], "succeeded");
    assert!(nested["result"].to_string().len() < grove::tools::MAX_OUTPUT);
    assert_eq!(nested["result"]["copy"], "not_needed");
}

#[tokio::test]
async fn missing_corrupt_or_unwritable_copies_restart_and_snapshot_restore_keep_db_results() {
    let mut s = TestServer::start().await;
    let project = s.create_project("recovery").await;
    let sid = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let original = json!({"text":"original😀".repeat(5000),"truncated":true});
    let id = seed(&s, &sid, "succeeded", original.clone(), false).await;
    let canonical = grove::provider::tool_content_string(&original);
    assert_eq!(read(&s, &sid, &id, 0, 100).await["result"]["copy"], "ready");
    let path = copy_path(&s, &id);
    std::fs::write(&path, "tampered copy").unwrap();
    assert_eq!(read(&s, &sid, &id, 0, 100).await["result"]["text"], canonical[..100]);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), canonical);
    std::fs::remove_file(&path).unwrap();
    s.restart().await;
    assert_eq!(read(&s, &sid, &id, 0, 100).await["result"]["copy"], "ready");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), canonical);
    std::fs::remove_file(&path).unwrap();
    // root 실행에서도 실패를 재현하도록 전용 디렉터리 대신 일반 파일을 둔다.
    std::fs::remove_dir(s.data_dir().join("tool-outputs")).unwrap();
    std::fs::write(s.data_dir().join("tool-outputs"), "blocked").unwrap();
    let read_call = read(&s, &sid, &id, 0, 100).await;
    assert_eq!(read_call["status"], "succeeded");
    assert_eq!(read_call["result"]["copy"], "unavailable");
    assert_eq!(read_call["result"]["text"], canonical[..100]);
    let (_, stored) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
    assert_eq!(stored["result"], original);
    assert_eq!(stored["status"], "succeeded");
    let snapshot = s.dir.path().join("snapshot.db");
    grove::backup::snapshot_to(&s.data_dir().join("grove.db"), &snapshot).unwrap();
    let restored = s.dir.path().join("restored");
    grove::backup::restore_into(&snapshot, &restored).unwrap();
    let recovered = grove::server::start(config(&restored), std::sync::Arc::new(grove::util::SystemClock)).await.unwrap();
    let result = recovered.app.db.call(move |c| {
        assert_eq!(grove::approvals::get(c, &id)?.result, original);
        assert_eq!(grove::approvals::get(c, &id)?.status, "succeeded");
        Ok(())
    }).await;
    result.unwrap();
    // 복원된 서버에도 캐시 없는 실제 HTTP 조회 경로를 사용한다.
    let response = s.client.post(format!("http://{}/api/v1/sessions/{sid}/tool-requests", recovered.addr))
        .bearer_auth(&recovered.owner_token).header("idempotency-key", "restored-read")
        .json(&json!({"name":"tool_output_read","args":{"call_id":stored["id"],"limit":100}})).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let call = response.json::<Value>().await.unwrap();
    let call_id = call["id"].as_str().unwrap().to_string();
    let mut events = recovered.app.seq_tx.subscribe();
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let id = call_id.clone();
            let call = recovered.app.db.call(move |c| grove::approvals::get(c, &id)).await.unwrap();
            if grove::approvals::TERMINAL.contains(&call.status.as_str()) { break call; }
            events.changed().await.unwrap();
        }
    }).await.unwrap();
    assert_eq!(result.status, "succeeded");
    assert_eq!(result.result["text"], canonical[..100]);
    assert_eq!(result.result["copy"], "ready");
    recovered.stop().await;
}

#[tokio::test]
async fn failed_unknown_and_unreadable_originals_never_become_successful_original_calls() {
    let mut s = TestServer::start().await;
    let project = s.create_project("outcomes").await;
    let sid = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let mut originals = vec![];
    for status in ["failed", "unknown", "cancelled"] {
        let value = json!({"error":{"code":status,"message":"오류".repeat(9000)}});
        let id = seed(&s, &sid, status, value.clone(), false).await;
        originals.push((id, status, value));
    }
    s.restart().await;
    for (id, status, value) in &originals {
        let call = read(&s, &sid, id, 0, 100).await;
        assert_eq!(call["status"], "succeeded");
        assert_eq!(call["result"]["status"], *status);
        assert_eq!(call["result"]["is_error"], true);
        let (_, original) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
        assert_eq!(original["status"], *status);
        assert_eq!(original["result"], *value);
    }
    let corrupt = originals[0].0.clone();
    let missing = originals[1].0.clone();
    let app = s.server.as_ref().unwrap().app.clone();
    app.db.call(move |c| {
        c.execute("UPDATE tool_calls SET result='{' WHERE id=?1", [corrupt])?;
        c.execute("UPDATE tool_calls SET result=NULL WHERE id=?1", [missing])?;
        Ok(())
    }).await.unwrap();
    assert_eq!(read(&s, &sid, &originals[0].0, 0, 100).await["result"]["error"]["code"], "output_unreadable");
    assert_eq!(read(&s, &sid, &originals[1].0, 0, 100).await["result"]["error"]["code"], "output_unavailable");
}

#[tokio::test]
async fn existing_auth_policy_read_only_and_execution_root_guards_apply_to_retrieval() {
    let s = TestServer::start().await;
    let project = s.create_project("guards").await;
    let pid = project["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    let id = seed(&s, &sid, "succeeded", json!("allowed"), false).await;
    let path = format!("/api/v1/sessions/{sid}/tool-requests");
    let body = json!({"name":"tool_output_read","args":{"call_id":id}});
    let unauth = s.raw(Method::POST, &path, Some(body), Some("unauth"), Some("")).await;
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/tools.mode"),
        json!({"expected_revision":0,"value":"read_only"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read(&s, &sid, &id, 0, 100).await["status"], "succeeded");
    s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/tools.deny"),
        json!({"expected_revision":0,"value":"tool_output_read"})).await;
    assert_eq!(read(&s, &sid, &id, 0, 100).await["result"]["error"]["code"], "policy_denied");
    s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/tools.deny"),
        json!({"expected_revision":1,"value":""})).await;
    // 실제 활성 root 검사를 우회하지 않는다.
    std::fs::rename(project["root_path"].as_str().unwrap(), s.dir.path().join("moved-root")).unwrap();
    let (status, _) = s.post(&path, json!({"name":"tool_output_read","args":{"call_id":id}})).await;
    assert!(!status.is_success());
}

#[tokio::test]
async fn final_storage_failure_does_not_change_execution_or_replay_after_restart() {
    let mut s = TestServer::start().await;
    let project = s.create_project("copy-failure").await;
    let root = std::path::Path::new(project["root_path"].as_str().unwrap());
    let text = format!("{}END", "가😀\n".repeat(4000));
    std::fs::write(root.join("output.txt"), &text).unwrap();
    std::fs::write(s.data_dir().join("tool-outputs"), "blocked").unwrap();
    let sid = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let call = request(&s, &sid, "read", json!({"path":"output.txt","limit":5000})).await;
    assert_eq!(call["status"], "succeeded");
    assert!(grove::provider::tool_content_string(&call["result"]).len() > INLINE_BYTES);
    let id = call["id"].as_str().unwrap();
    assert_eq!(read(&s, &sid, id, 0, 100).await["result"]["copy"], "unavailable");
    // 입력 파일이 바뀌어도 재시작에서 원래 read를 재실행하지 않는다.
    std::fs::write(root.join("output.txt"), "changed").unwrap();
    s.restart().await;
    let (_, original) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
    assert_eq!(original["result"], call["result"]);
    assert_eq!(original["revision"], call["revision"]);
    assert_eq!(original["status"], "succeeded");
    assert_eq!(read(&s, &sid, id, 0, 100).await["result"]["status"], "succeeded");
}

#[cfg(unix)]
#[tokio::test]
async fn copy_symlinks_never_read_or_overwrite_outside_data_directory() {
    let s = TestServer::start().await;
    let project = s.create_project("copy-links").await;
    let sid = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let id = seed(&s, &sid, "succeeded", json!("DB [redacted] ".repeat(2000)), false).await;
    let outside = s.dir.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    let sentinel = outside.join(format!("{}.txt", grove::util::sha256_hex(id.as_bytes())));
    std::fs::write(&sentinel, "untouched").unwrap();
    let directory = s.data_dir().join("tool-outputs");
    std::os::unix::fs::symlink(&outside, &directory).unwrap();
    let call = read(&s, &sid, &id, 0, 100).await;
    assert_eq!(call["status"], "succeeded");
    assert_eq!(call["result"]["copy"], "unavailable");
    assert!(call["result"]["text"].as_str().unwrap().contains("[redacted]"));
    assert_eq!(std::fs::read_to_string(&sentinel).unwrap(), "untouched");
    std::fs::remove_file(&directory).unwrap();
    std::fs::create_dir(&directory).unwrap();
    std::os::unix::fs::symlink(&sentinel, copy_path(&s, &id)).unwrap();
    let call = read(&s, &sid, &id, 0, 100).await;
    assert_eq!(call["result"]["copy"], "ready");
    assert_eq!(std::fs::read_to_string(&sentinel).unwrap(), "untouched");
    assert!(!std::fs::symlink_metadata(copy_path(&s, &id)).unwrap().file_type().is_symlink());
}

#[tokio::test]
async fn legacy_large_history_gets_a_usable_reference_without_changing_its_original() {
    let s = TestServer::start().await;
    let project = s.create_project("legacy").await;
    let sid = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let value = json!({"content":format!("{}LEGACY-END", "가".repeat(60000)),"truncated":true});
    let id = seed(&s, &sid, "failed", value.clone(), false).await;
    let app = s.server.as_ref().unwrap().app.clone();
    let (session, identity, original, now) = (sid.clone(), id.clone(), value.clone(), app.now());
    app.db.call(move |c| {
        let tx = c.transaction()?;
        grove::sessions::append_message(&tx, &now, &session, "assistant",
            &json!({"tool_calls":[{"id":"legacy-provider","name":"list","arguments":{}}]}), None, None)?;
        grove::sessions::append_message(&tx, &now, &session, "tool",
            &json!({"call_id":identity,"provider_call_id":"legacy-provider","name":"list","status":"failed","is_error":true,"output":original}), None, None)?;
        tx.commit()?;
        Ok(())
    }).await.unwrap();
    let (_, preview) = s.get(&format!("/api/v1/sessions/{sid}/model-input")).await;
    let tool = preview["items"].as_array().unwrap().iter().find(|m| m["role"]=="tool").unwrap();
    assert_eq!(tool["call_id"], "legacy-provider");
    assert_eq!(tool["is_error"], true);
    let reference: Value = serde_json::from_str(tool["content"]["text"].as_str().unwrap()).unwrap();
    assert_eq!(reference["call_id"], id);
    assert_eq!(reference["status"], "failed");
    assert_eq!(reference["total_bytes"], grove::provider::tool_content_string(&value).len());
    let (_, messages) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert_eq!(messages["items"][1]["content"]["output"], value);
    let canonical = grove::provider::tool_content_string(&value);
    let offset = canonical.find("LEGACY-END").unwrap();
    let read = read(&s, &sid, &id, offset, 100).await;
    assert_eq!(read["result"]["text"], canonical[offset..]);
    assert_eq!(read["result"]["status"], "failed");
}
