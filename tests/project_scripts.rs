//! 프로젝트 script CRUD·실행 대상 고정·재전송(실제 Linux bash, 유료 모델 없음).
#![cfg(unix)]
mod common;
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn setup() -> (TestServer, Value, Value, Value) {
    let s = TestServer::start().await;
    let project = s.create_project("scripts").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    let (status, script) = s.post(&format!("/api/v1/projects/{}/scripts", project["id"].as_str().unwrap()),
        json!({"name":"check","command":"printf 'script fixture\\n'; printf x >> counter"})).await;
    assert_eq!(status, StatusCode::CREATED, "{script}");
    (s,project,session,script)
}
async fn request(s: &TestServer, project: &Value, script: &Value) -> Value {
    let (status, list) = s.get(&format!("/api/v1/projects/{}/scripts", project["id"].as_str().unwrap())).await;
    assert_eq!(status, StatusCode::OK);
    json!({"command":script["command"],"expected_revision":script["revision"],"expected_execution":list["execution"]["fingerprint"],"expected_owner":list["owner"]})
}

#[tokio::test]
async fn crud_is_project_scoped_revisioned_and_never_executes() {
    let (s,p,_session,script) = setup().await;
    let other = s.create_project("other").await;
    let pid = p["id"].as_str().unwrap();
    let id = script["id"].as_str().unwrap();
    assert!(!std::path::Path::new(p["root_path"].as_str().unwrap()).join("counter").exists());
    let (_, list) = s.get(&format!("/api/v1/projects/{}/scripts",other["id"].as_str().unwrap())).await;
    assert_eq!(list["scripts"],json!([]));
    let path = format!("/api/v1/projects/{pid}/scripts/{id}");
    let body = json!({"expected_revision":1,"name":"updated","command":"printf updated"});
    let (status, updated) = s.send(Method::PUT,&path,body.clone()).await;
    assert_eq!(status,StatusCode::OK);
    assert_eq!(updated["revision"],2);
    assert_eq!(s.send(Method::PUT,&path,body).await.0,StatusCode::CONFLICT);
    assert_eq!(s.send(Method::PUT,&format!("/api/v1/projects/{}/scripts/{id}",other["id"].as_str().unwrap()),
        json!({"expected_revision":2,"name":"stolen","command":"false"})).await.0,StatusCode::NOT_FOUND);
    assert_eq!(s.raw(Method::DELETE,&format!("{path}?expected_revision=1"),None,Some("old-delete"),None).await.status(),StatusCode::CONFLICT);
    assert_eq!(s.raw(Method::DELETE,&format!("{path}?expected_revision=2"),None,Some("delete-script"),None).await.status(),StatusCode::OK);
    let (_, list) = s.get(&format!("/api/v1/projects/{pid}/scripts")).await;
    assert_eq!(list["scripts"],json!([]));
}

#[tokio::test]
async fn accepted_script_replays_after_edit_and_keeps_one_result_and_snapshot() {
    let (s,p,session,script) = setup().await;
    let body = request(&s,&p,&script).await;
    let path = format!("/api/v1/sessions/{}/scripts/{}/run",session["id"].as_str().unwrap(),script["id"].as_str().unwrap());
    let response = s.raw(Method::POST,&path,Some(body.clone()),Some("run-script"),None).await;
    assert_eq!(response.status(),StatusCode::CREATED);
    let task: Value = response.json().await.unwrap();
    assert_eq!(task["script"]["name"],"check");
    assert_eq!(task["script"]["revision"],1);
    let (_, done) = s.get(&format!("/api/v1/tasks/{}/wait?timeout_ms=10000",task["id"].as_str().unwrap())).await;
    assert_eq!(done["status"],"completed","{done}");
    s.send(Method::PUT,&format!("/api/v1/projects/{}/scripts/{}",p["id"].as_str().unwrap(),script["id"].as_str().unwrap()),
        json!({"expected_revision":1,"name":"changed","command":"printf y >> counter"})).await;
    let replay = s.raw(Method::POST,&path,Some(body),Some("run-script"),None).await;
    assert_eq!(replay.status(),StatusCode::CREATED);
    assert_eq!(replay.headers()["idempotent-replayed"],"true");
    let replayed: Value = replay.json().await.unwrap();
    assert_eq!(replayed["id"],task["id"]);
    let (_, tasks) = s.get(&format!("/api/v1/sessions/{}/tasks",session["id"].as_str().unwrap())).await;
    assert_eq!(tasks["tasks"].as_array().unwrap().len(),1);
    let (_, messages) = s.get(&format!("/api/v1/sessions/{}/messages",session["id"].as_str().unwrap())).await;
    let notes: Vec<_> = messages["items"].as_array().unwrap().iter().filter(|message|message["content"]["type"]=="task_result").collect();
    assert_eq!(notes.len(),1);
    assert_eq!(notes[0]["content"]["script"]["name"],"check");
    assert_eq!(std::fs::read_to_string(std::path::Path::new(p["root_path"].as_str().unwrap()).join("counter")).unwrap(),"x");
}

#[tokio::test]
async fn stale_command_target_and_cross_project_requests_never_start_a_task() {
    let (s,p,session,script) = setup().await;
    let body = request(&s,&p,&script).await;
    let path = format!("/api/v1/sessions/{}/scripts/{}/run",session["id"].as_str().unwrap(),script["id"].as_str().unwrap());
    let mut wrong_command=body.clone();
    wrong_command["command"]=json!("printf injected");
    assert_eq!(s.post(&path,wrong_command).await.0,StatusCode::CONFLICT);
    let other=s.create_project("other").await;
    let other_session=s.create_session(other["id"].as_str().unwrap()).await;
    assert_eq!(s.post(&format!("/api/v1/sessions/{}/scripts/{}/run",other_session["id"].as_str().unwrap(),script["id"].as_str().unwrap()),body.clone()).await.0,StatusCode::NOT_FOUND);
    // 실행 셸이 바뀌면 같은 프로젝트·명령이어도 새 확인이 필요하다.
    assert_eq!(s.send(Method::PUT,&format!("/api/v1/settings/project/{}/exec.shell",p["id"].as_str().unwrap()),
        json!({"expected_revision":0,"value":"sh"})).await.0,StatusCode::OK);
    assert_eq!(s.post(&path,body).await.0,StatusCode::CONFLICT);
    let current = request(&s,&p,&script).await;
    s.send(Method::PUT,&format!("/api/v1/projects/{}/scripts/{}",p["id"].as_str().unwrap(),script["id"].as_str().unwrap()),
        json!({"expected_revision":1,"name":"edited","command":"printf new"})).await;
    assert_eq!(s.post(&path,current).await.0,StatusCode::CONFLICT);
    let (_, tasks)=s.get(&format!("/api/v1/sessions/{}/tasks",session["id"].as_str().unwrap())).await;
    assert_eq!(tasks["tasks"],json!([]));
    assert!(!std::path::Path::new(p["root_path"].as_str().unwrap()).join("counter").exists());
}

#[tokio::test]
async fn definitions_reject_duplicate_invalid_and_oversized_values_without_mutation() {
    let (s,p,_,_) = setup().await;
    let path=format!("/api/v1/projects/{}/scripts",p["id"].as_str().unwrap());
    assert_eq!(s.post(&path,json!({"name":" check ","command":"other"})).await.0,StatusCode::CONFLICT);
    for body in [json!({"name":"","command":"true"}),json!({"name":"bad\nname","command":"true"}),
        json!({"name":"empty","command":" "}),json!({"name":"large","command":"x".repeat(65537)})] {
        assert_eq!(s.post(&path,body).await.0,StatusCode::BAD_REQUEST);
    }
    assert_eq!(s.post(&path,json!({"name":"unknown","command":"true","cwd":"../outside"})).await.0,StatusCode::UNPROCESSABLE_ENTITY);
    let (_,list)=s.get(&path).await;
    assert_eq!(list["scripts"].as_array().unwrap().len(),1);
}

#[tokio::test]
async fn another_authentication_cannot_turn_result_confirmation_into_a_new_execution() {
    let (s,p,session,script)=setup().await;
    let body=request(&s,&p,&script).await;
    let (_,device)=s.post("/api/v1/devices",json!({"name":"fixture other device"})).await;
    let path=format!("/api/v1/sessions/{}/scripts/{}/run",session["id"].as_str().unwrap(),script["id"].as_str().unwrap());
    let response=s.raw(Method::POST,&path,Some(body),Some("original-owner-run"),device["token"].as_str()).await;
    assert_eq!(response.status(),StatusCode::FORBIDDEN);
    let error: Value=response.json().await.unwrap();
    assert_eq!(error["error"]["code"],"actor_changed");
    let (_,tasks)=s.get(&format!("/api/v1/sessions/{}/tasks",session["id"].as_str().unwrap())).await;
    assert_eq!(tasks["tasks"],json!([]));
    assert!(!std::path::Path::new(p["root_path"].as_str().unwrap()).join("counter").exists());
}
