//! 다른 기기의 revision·승인 경합(NET-013). 같은 화면을 본 두 토큰으로 동시에 요청한다.
use crate::common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn devices(s: &TestServer) -> [String; 2] {
    let mut tokens = [String::new(), String::new()];
    for (index, name) in ["desktop", "phone"].into_iter().enumerate() {
        let device = s.registered_device(name).await;
        tokens[index] = device["token"].as_str().unwrap().to_string();
    }
    tokens
}

async fn send(s: &TestServer, token: &str, method: Method, path: &str, key: &str, body: Value) -> (StatusCode, Value) {
    let r = s.raw(method, path, Some(body), Some(key), Some(token)).await;
    (r.status(), r.json().await.unwrap())
}

#[tokio::test]
async fn concurrent_settings_keep_the_winner_and_idempotency_is_scoped_to_each_device() {
    let s = TestServer::start().await;
    let tokens = devices(&s).await;
    let path = "/api/v1/settings/server/-/output.style";
    let bodies = [json!({ "expected_revision": 0, "value": "concise" }), json!({ "expected_revision": 0, "value": "detailed" })];
    let (a, b) = tokio::join!(
        send(&s, &tokens[0], Method::PUT, path, "shared-key", bodies[0].clone()),
        send(&s, &tokens[1], Method::PUT, path, "shared-key", bodies[1].clone()),
    );
    let results = [a, b];
    let winner = results.iter().position(|r| r.0 == StatusCode::OK).unwrap();
    let loser = 1 - winner;
    assert_eq!(results[loser].0, StatusCode::CONFLICT);
    assert_eq!(results[loser].1["error"]["code"], "revision_conflict");
    assert_eq!(results[loser].1["error"]["details"]["current"]["effective"], bodies[winner]["value"]);
    assert_eq!(results[loser].1["error"]["details"]["current"]["layers"]["server"]["revision"], 1);
    let replay = send(&s, &tokens[winner], Method::PUT, path, "shared-key", bodies[winner].clone()).await;
    assert_eq!(replay, results[winner], "같은 기기의 재전송은 이전 성공 응답");
    // 다른 기기가 같은 문자열 key를 써도 원래 기기의 저장된 응답을 받지 않는다.
    let (status, updated) = send(&s, &tokens[loser], Method::PUT, path, "shared-key", json!({
        "expected_revision": 1, "value": "default",
    })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["item"]["layers"]["server"]["revision"], 2);
    assert_eq!(updated["item"]["effective"], "default");
}

#[cfg(unix)]
#[tokio::test]
async fn concurrent_approvals_have_one_winner_and_never_repeat_the_side_effect() {
    let s = TestServer::start().await;
    let tokens = devices(&s).await;
    let project = s.create_project("approval-race").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    let sid = session["id"].as_str().unwrap();
    for (index, decisions) in [["approve", "approve"], ["approve", "deny"]].into_iter().enumerate() {
        let marker = format!("decision-{index}.txt");
        let (status, call) = s.post(&format!("/api/v1/sessions/{sid}/tool-requests"), json!({
            "name": "shell", "args": { "command": format!("printf once >> {marker}") },
        })).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(call["status"], "pending_approval");
        let id = call["id"].as_str().unwrap();
        let path = format!("/api/v1/tool-calls/{id}/decision");
        let bodies = decisions.map(|decision| json!({ "decision": decision, "expected_revision": call["revision"] }));
        let mut events = s.server.as_ref().unwrap().app.seq_tx.subscribe();
        let key = format!("decision-{index}");
        let (a, b) = tokio::join!(
            send(&s, &tokens[0], Method::POST, &path, &key, bodies[0].clone()),
            send(&s, &tokens[1], Method::POST, &path, &key, bodies[1].clone()),
        );
        let results = [a, b];
        let winner = results.iter().position(|r| r.0 == StatusCode::OK).unwrap();
        assert_eq!(results[1 - winner].0, StatusCode::CONFLICT);
        assert_eq!(results[1 - winner].1["error"]["code"], "already_decided");
        let expected = if decisions[winner] == "deny" { "denied" } else { "succeeded" };
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let (_, state) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
                if grove::approvals::TERMINAL.contains(&state["status"].as_str().unwrap()) {
                    assert_eq!(state["status"], expected, "{state}");
                    break;
                }
                events.changed().await.unwrap();
            }
        }).await.unwrap();
        let replay = send(&s, &tokens[winner], Method::POST, &path, &key, bodies[winner].clone()).await;
        assert_eq!(replay, results[winner]);
        let file = std::path::Path::new(project["root_path"].as_str().unwrap()).join(marker);
        if expected == "succeeded" { assert_eq!(std::fs::read_to_string(file).unwrap(), "once"); }
        else { assert!(!file.exists()); }
    }
}
