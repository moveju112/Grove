//! RUN-005/006: 백그라운드 작업·모델 도구·UI 파일/Git가 공유하는 프로젝트 자원 경계.
#![cfg(unix)]
mod common;

use common::*;
use common::fixture::{self,Fixture};
use reqwest::{Method, StatusCode};
use serde_json::json;

#[tokio::test]
async fn a_background_writer_blocks_same_project_file_mutations_but_not_another_project() {
    let s = TestServer::start().await;
    let project = s.create_project("owned-root").await;
    let other = s.create_project("independent-root").await;
    let pid = project["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    let root = std::path::Path::new(project["root_path"].as_str().unwrap());
    std::fs::write(root.join("shared.txt"),b"original").unwrap();
    let (status, task) = s.post(&format!("/api/v1/sessions/{sid}/tasks"),json!({"command":"sleep 10"})).await;
    assert_eq!(status,StatusCode::CREATED,"{task}");
    let task_id = task["id"].as_str().unwrap();
    let key = s.key();
    let request = json!({"path":"shared.txt","expected_sha256":grove::util::sha256_hex(b"original"),"text":"mine"});
    let path = format!("/api/v1/projects/{pid}/files/content");
    let response = s.raw(Method::PUT,&path,Some(request.clone()),Some(&key),None).await;
    assert_eq!(response.status(),StatusCode::CONFLICT,"백그라운드 writer의 수명 동안 같은 프로젝트 원문을 바꾸면 안 된다");
    assert_eq!(response.json::<serde_json::Value>().await.unwrap()["error"]["code"],"resource_busy");
    assert_eq!(std::fs::read(root.join("shared.txt")).unwrap(),b"original");
    let other_pid = other["id"].as_str().unwrap();
    let (status, body) = s.send(Method::PUT,&format!("/api/v1/projects/{other_pid}/files/content"),
        json!({"path":"independent.txt","expected_sha256":null,"text":"independent"})).await;
    assert_eq!(status,StatusCode::OK,"{body}");
    s.post(&format!("/api/v1/tasks/{task_id}/cancel"),json!({})).await;
    let stopped = s.get(&format!("/api/v1/tasks/{task_id}/wait?timeout_ms=5000")).await.1;
    assert_ne!(stopped["status"],"running");
    let response = s.raw(Method::PUT,&path,Some(request),Some(&key),None).await;
    assert_eq!(response.status(),StatusCode::OK);
    assert_eq!(std::fs::read(root.join("shared.txt")).unwrap(),b"mine");
}

#[tokio::test]
async fn model_tools_share_the_project_boundary_across_sessions_and_waiting_is_cancellable() {
    for cancel in [false,true] {
        let s = TestServer::start().await;
        let f = Fixture::start().await;
        let profile = s.fixture_profile(&f.base).await;
        let project = s.create_project("shared-tools").await;
        let pid = project["id"].as_str().unwrap();
        let root = std::path::Path::new(project["root_path"].as_str().unwrap());
        std::fs::write(root.join("shared.txt"),b"old").unwrap();
        s.send(Method::PUT,&format!("/api/v1/settings/project/{pid}/tools.allow"),json!({"expected_revision":0,"value":"shell"})).await;
        let writer = s.create_session(pid).await["id"].as_str().unwrap().to_string();
        let reader = s.create_session(pid).await["id"].as_str().unwrap().to_string();
        f.push_for("WRITER_MARK",fixture::tool_calls(&[("writer","shell",json!({
            "command":"printf entered > entered; while [ ! -f release ]; do sleep 0.02; done; printf 'new from writer' > shared.txt","timeout_ms":10000
        }))]));
        f.push_for("WRITER_MARK",fixture::text("writer finished"));
        let (_,t) = s.post(&format!("/api/v1/sessions/{writer}/turns"),json!({"text":"WRITER_MARK","profile_id":profile,"tools":true})).await;
        let writer_turn = t["turn"]["id"].as_str().unwrap();
        s.wait_turn(writer_turn,|_|root.join("entered").exists()).await;
        f.push_for("READER_MARK",fixture::tool_calls(&[("reader","read",json!({"path":"shared.txt"}))]));
        f.push_for("READER_MARK",fixture::text("reader finished"));
        let (_,t) = s.post(&format!("/api/v1/sessions/{reader}/turns"),json!({"text":"READER_MARK","profile_id":profile,"tools":true})).await;
        let reader_turn = t["turn"]["id"].as_str().unwrap();
        s.wait_turn(reader_turn,|t|t["tool_calls"].as_array().is_some_and(|calls|calls.iter().any(|c|c["status"]=="running"))).await;
        assert_eq!(f.requests().iter().filter(|r|r["messages"].to_string().contains("READER_MARK")).count(),1,"writer 결과 전에는 read 결과로 모델을 다시 부르지 않는다");

        // 다른 프로젝트의 도구는 같은 서버에서도 이 writer를 기다리지 않는다.
        let other = s.create_project("other-tools").await;
        std::fs::write(std::path::Path::new(other["root_path"].as_str().unwrap()).join("independent.txt"),b"independent").unwrap();
        let other_sid=s.create_session(other["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
        f.push_for("OTHER_MARK",fixture::tool_calls(&[("other","read",json!({"path":"independent.txt"}))]));
        f.push_for("OTHER_MARK",fixture::text("other done"));
        let (_,t)=s.post(&format!("/api/v1/sessions/{other_sid}/turns"),json!({"text":"OTHER_MARK","profile_id":profile,"tools":true})).await;
        s.wait_status(t["turn"]["id"].as_str().unwrap(),"completed").await;
        if cancel {
            s.post(&format!("/api/v1/turns/{reader_turn}/cancel"),json!({})).await;
            let done=s.wait_status(reader_turn,"cancelled").await;
            assert_eq!(done["tool_calls"][0]["status"],"cancelled");
            assert!(!done["tool_calls"][0]["result"].to_string().contains("old"));
        }
        std::fs::write(root.join("release"),b"go").unwrap();
        s.wait_status(writer_turn,"completed").await;
        if !cancel {
            let done=s.wait_status(reader_turn,"completed").await;
            assert!(done["tool_calls"][0]["result"].to_string().contains("new from writer"),"{done}");
        }
    }
}

#[tokio::test]
async fn an_automatic_read_waits_for_a_background_process_and_cancellation_keeps_the_independent_process() {
    let s=TestServer::start().await;
    let f=Fixture::start().await;
    let profile=s.fixture_profile(&f.base).await;
    let project=s.create_project("background-read").await;
    let pid=project["id"].as_str().unwrap();
    std::fs::write(std::path::Path::new(project["root_path"].as_str().unwrap()).join("shared.txt"),b"original").unwrap();
    let sid=s.create_session(pid).await["id"].as_str().unwrap().to_string();
    let (_,task)=s.post(&format!("/api/v1/sessions/{sid}/tasks"),json!({"command":"sleep 10"})).await;
    let task=task["id"].as_str().unwrap();
    f.push(fixture::tool_calls(&[("reader","read",json!({"path":"shared.txt"}))]));
    let (_,turn)=s.post(&format!("/api/v1/sessions/{sid}/turns"),json!({"text":"read","profile_id":profile,"tools":true})).await;
    let tid=turn["turn"]["id"].as_str().unwrap();
    s.wait_turn(tid,|t|t["tool_calls"].as_array().is_some_and(|calls|calls.iter().any(|c|c["status"]=="running"))).await;
    s.post(&format!("/api/v1/turns/{tid}/cancel"),json!({})).await;
    let done=s.wait_status(tid,"cancelled").await;
    assert_eq!(done["tool_calls"][0]["status"],"cancelled");
    assert_eq!(s.get(&format!("/api/v1/tasks/{task}")).await.1["status"],"running");
    s.post(&format!("/api/v1/tasks/{task}/cancel"),json!({})).await;
}

#[tokio::test]
async fn git_mutations_do_not_overlap_a_background_process_and_retry_the_same_unaccepted_request_afterwards() {
    let s=TestServer::start().await;
    let project=s.create_project("git-background").await;
    let pid=project["id"].as_str().unwrap();
    let root=std::path::Path::new(project["root_path"].as_str().unwrap());
    let init=std::process::Command::new("git").args(["init","-q"]).current_dir(root).output().unwrap();
    assert!(init.status.success());
    std::fs::write(root.join("shared.txt"),b"original").unwrap();
    let (status,state)=s.get(&format!("/api/v1/projects/{pid}/git/status")).await;
    assert_eq!(status,StatusCode::OK,"{state}");
    let sid=s.create_session(pid).await["id"].as_str().unwrap().to_string();
    let (_,task)=s.post(&format!("/api/v1/sessions/{sid}/tasks"),json!({"command":"sleep 10"})).await;
    let task=task["id"].as_str().unwrap();
    let path=format!("/api/v1/projects/{pid}/git/stage");
    let request=json!({"paths":["shared.txt"],"expected_fingerprint":state["fingerprint"]});
    let key=s.key();
    let response=s.raw(Method::POST,&path,Some(request.clone()),Some(&key),None).await;
    assert_eq!(response.status(),StatusCode::CONFLICT);
    assert_eq!(response.json::<serde_json::Value>().await.unwrap()["error"]["code"],"resource_busy");
    let cached=std::process::Command::new("git").args(["diff","--cached","--name-only"]).current_dir(root).output().unwrap();
    assert!(cached.status.success() && cached.stdout.is_empty());
    s.post(&format!("/api/v1/tasks/{task}/cancel"),json!({})).await;
    s.get(&format!("/api/v1/tasks/{task}/wait?timeout_ms=5000")).await;
    let response=s.raw(Method::POST,&path,Some(request),Some(&key),None).await;
    assert_eq!(response.status(),StatusCode::OK);
}

#[tokio::test]
async fn permissions_revoked_during_project_wait_are_checked_before_foreground_or_background_payloads() {
    for background in [false,true] {
        let s=TestServer::start().await;
        let f=Fixture::start().await;
        let profile=s.fixture_profile(&f.base).await;
        let project=s.create_project("revoked-wait").await;
        let pid=project["id"].as_str().unwrap();
        let root=std::path::Path::new(project["root_path"].as_str().unwrap());
        s.send(Method::PUT,&format!("/api/v1/settings/project/{pid}/tools.allow"),json!({"expected_revision":0,"value":"shell"})).await;
        let sid=s.create_session(pid).await["id"].as_str().unwrap().to_string();
        let (_,task)=s.post(&format!("/api/v1/sessions/{sid}/tasks"),json!({"command":"sleep 10"})).await;
        let task=task["id"].as_str().unwrap();
        f.push(fixture::tool_calls(&[("writer","shell",json!({
            "command":"printf forbidden > forbidden.txt","background":background,"timeout_ms":5000
        }))]));
        f.push(fixture::text("write blocked"));
        let (_,turn)=s.post(&format!("/api/v1/sessions/{sid}/turns"),json!({"text":"write","profile_id":profile,"tools":true})).await;
        let tid=turn["turn"]["id"].as_str().unwrap();
        s.wait_turn(tid,|t|t["tool_calls"].as_array().is_some_and(|calls|calls.iter().any(|c|c["status"]=="running"))).await;
        let (status,body)=s.send(Method::PUT,&format!("/api/v1/settings/project/{pid}/tools.mode"),json!({"expected_revision":0,"value":"read_only"})).await;
        assert_eq!(status,StatusCode::OK,"{body}");
        s.post(&format!("/api/v1/tasks/{task}/cancel"),json!({})).await;
        let done=s.wait_status(tid,"completed").await;
        assert_eq!(done["tool_calls"][0]["status"],"failed","{done}");
        assert_eq!(done["tool_calls"][0]["result"]["error"]["code"],"read_only","{done}");
        assert!(!root.join("forbidden.txt").exists());
        let tasks=s.get(&format!("/api/v1/sessions/{sid}/tasks")).await.1;
        assert_eq!(tasks["tasks"].as_array().unwrap().len(),1,"권한 없는 모델 task를 접수하지 않았다");
    }
}

#[tokio::test]
async fn queued_ui_access_revalidates_the_device_after_the_project_guard_becomes_available() {
    let s=TestServer::start().await;
    let project=s.create_project("queued-access").await;
    let pid=project["id"].as_str().unwrap();
    let app=s.server.as_ref().unwrap().app.clone();
    let headers=|token:&str| {
        let mut h=reqwest::header::HeaderMap::new();
        h.insert("authorization",format!("Bearer {token}").parse().unwrap());
        h
    };
    let owner=grove::auth::authenticate(&app,&headers(&s.token)).await.unwrap();
    let (_,device)=s.post("/api/v1/devices",json!({"name":"queued device"})).await;
    let principal=grove::auth::authenticate(&app,&headers(device["token"].as_str().unwrap())).await.unwrap();
    let held=app.project_resources.ui_write(&app,pid,&owner).await.unwrap();
    let waiting=app.project_resources.ui_write(&app,pid,&principal);
    tokio::pin!(waiting);
    assert!(futures_util::poll!(&mut waiting).is_pending());
    let (status,_)=s.send(Method::DELETE,&format!("/api/v1/devices/{}",device["id"].as_str().unwrap()),json!({})).await;
    assert_eq!(status,StatusCode::OK);
    drop(held);
    let error=match waiting.await { Err(error)=>error,Ok(_)=>panic!("폐기된 기기에 대기 후 파일 권한을 주면 안 된다") };
    let response=axum::response::IntoResponse::into_response(error);
    assert_eq!(response.status(),StatusCode::UNAUTHORIZED);
}
