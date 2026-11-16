//! RUN-005: 같은 모델 응답의 도구는 읽기 전용 그룹만 병렬로 실행한다.
#![cfg(unix)]
mod common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn setup(allow_shell: bool) -> (TestServer, Fixture, String, String, Value) {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("batch").await;
    let sid = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    if allow_shell {
        let (status, body) = s.send(Method::PUT, &format!("/api/v1/settings/project/{}/tools.allow", project["id"].as_str().unwrap()),
            json!({"expected_revision":0,"value":"shell"})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    (s,f,profile,sid,project)
}

async fn turn(s: &TestServer, sid: &str, profile: &str) -> String {
    let (status, body) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"run batch","profile_id":profile,"tools":true})).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    body["turn"]["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn mutating_tools_in_one_response_never_overlap_even_when_both_are_preapproved() {
    let (s,f,profile,sid,_) = setup(true).await;
    f.push(fixture::tool_calls(&[
        ("first","shell",json!({"command":"sleep 0.3; printf first"})),
        ("second","shell",json!({"command":"printf second"})),
    ]));
    f.push(fixture::text("finished"));
    let tid = turn(&s,&sid,&profile).await;
    let t = s.wait_status(&tid,"completed").await;
    let calls = t["tool_calls"].as_array().unwrap();
    let first = calls.iter().find(|c| c["provider_call_id"]=="first").unwrap();
    let second = calls.iter().find(|c| c["provider_call_id"]=="second").unwrap();
    assert_eq!(first["status"],"succeeded");
    assert_eq!(second["status"],"succeeded");
    assert!(second["started_at"].as_str().unwrap() >= first["finished_at"].as_str().unwrap(),
        "독립성을 확인하지 못한 mutation은 겹치면 안 된다: {calls:?}");
}

#[tokio::test]
async fn approval_barriers_preserve_order_and_denial_does_not_block_later_authorized_reads() {
    let (s,f,profile,sid,project) = setup(false).await;
    let root = std::path::Path::new(project["root_path"].as_str().unwrap());
    std::fs::write(root.join("seed.txt"), b"safe read").unwrap();
    f.push(fixture::tool_calls(&[
        ("write","shell",json!({"command":"printf forbidden > forbidden.txt"})),
        ("read","read",json!({"path":"seed.txt"})),
    ]));
    f.push(fixture::text("denied write, read only"));
    let tid = turn(&s,&sid,&profile).await;
    let t = s.wait_status(&tid,"awaiting_approval").await;
    let calls = t["tool_calls"].as_array().unwrap();
    let write = calls.iter().find(|c| c["provider_call_id"]=="write").unwrap();
    s.post(&format!("/api/v1/tool-calls/{}/decision",write["id"].as_str().unwrap()),
        json!({"decision":"deny","expected_revision":write["revision"]})).await;
    let t = s.wait_status(&tid,"completed").await;
    let calls = t["tool_calls"].as_array().unwrap();
    let write = calls.iter().find(|c| c["provider_call_id"]=="write").unwrap();
    let read = calls.iter().find(|c| c["provider_call_id"]=="read").unwrap();
    assert_eq!(write["status"],"denied");
    assert_eq!(read["status"],"succeeded");
    assert!(read["started_at"].as_str().unwrap() >= write["finished_at"].as_str().unwrap());
    assert!(!root.join("forbidden.txt").exists());
}

#[tokio::test]
async fn queued_tools_revalidate_revoked_permissions_and_turn_cancellation_before_starting() {
    for mode in ["read_only","revoke","cancel","full_access","full_access_with_allow"] {
        let (s,f,profile,sid,project) = setup(mode!="full_access").await;
        if mode.starts_with("full_access") {
            let (st,body) = s.send(Method::PUT,&format!("/api/v1/settings/project/{}/tools.full_access",project["id"].as_str().unwrap()),
                json!({"expected_revision":0,"value":true})).await;
            assert_eq!(st,StatusCode::OK,"{body}");
        }
        let root = std::path::Path::new(project["root_path"].as_str().unwrap());
        f.push(fixture::tool_calls(&[
            ("first","shell",json!({"command":"while [ ! -f release ]; do sleep 0.02; done; printf first","timeout_ms":10000})),
            ("second","shell",json!({"command":"printf forbidden > forbidden.txt"})),
        ]));
        f.push(fixture::text("no unauthorized side effect"));
        let tid = turn(&s,&sid,&profile).await;
        s.wait_turn(&tid,|t| t["tool_calls"].as_array().is_some_and(|calls|
            calls.iter().any(|c| c["provider_call_id"]=="first" && c["status"]=="running"))).await;
        if mode=="cancel" {
            s.post(&format!("/api/v1/turns/{tid}/cancel"),json!({})).await;
        } else {
            let (key,revision,value) = if mode=="read_only" { ("tools.mode",0,json!("read_only")) }
                else if mode.starts_with("full_access") { ("tools.full_access",1,json!(false)) }
                else { ("tools.allow",1,json!("")) };
            let (st,body) = s.send(Method::PUT,&format!("/api/v1/settings/project/{}/{key}",project["id"].as_str().unwrap()),
                json!({"expected_revision":revision,"value":value})).await;
            assert_eq!(st,StatusCode::OK,"{body}");
            std::fs::write(root.join("release"),b"go").unwrap();
        }
        let t = s.wait_status(&tid,if mode=="cancel" { "cancelled" } else { "completed" }).await;
        let calls=t["tool_calls"].as_array().unwrap();
        let second=calls.iter().find(|c| c["provider_call_id"]=="second").unwrap();
        assert!(second["started_at"].is_null(),"{mode}: {second}");
        if mode!="cancel" {
            assert_eq!(second["status"],"failed");
            assert_eq!(second["result"]["error"]["code"],if mode=="read_only" {"read_only"} else {"approval_revoked"});
        } else {
            assert_eq!(second["status"],"cancelled");
        }
        assert!(!root.join("forbidden.txt").exists(),"{mode}");
    }
}
