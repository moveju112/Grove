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

/// PROJECT-010: 초기 설정 script 지정은 실행하지 않고, 실행 위치별 상태·실패·재시도를 작업 상태로 기록한다.
#[tokio::test]
async fn setup_script_status_failure_and_retry_are_tracked_per_location() {
    let s = TestServer::start().await;
    let p = s.create_project("setup").await;
    let pid = p["id"].as_str().unwrap().to_string();
    let root = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
    let git = |dir: &std::path::Path, args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(dir).status().unwrap().success());
    git(&root, &["init", "-q", "-b", "main"]);
    std::fs::write(root.join(".gitignore"), "ok\n").unwrap();
    git(&root, &["add", ".gitignore"]);
    git(&root, &["-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-q", "-m", "init"]);
    // 처음에는 표식 파일을 만들고 실패, 두 번째에 성공한다.
    let (_, script) = s.post(&format!("/api/v1/projects/{pid}/scripts"), json!({"name":"setup","command":"test -f ok || { touch ok; exit 3; }"})).await;
    let sid_script = script["id"].as_str().unwrap().to_string();
    let (_, st0) = s.get(&format!("/api/v1/projects/{pid}/setup")).await;
    assert!(st0["script"].is_null());
    assert_eq!(st0["targets"][0]["status"], "not_run");
    let session = s.create_session(&pid).await;
    let sess = session["id"].as_str().unwrap().to_string();
    let run = |sess: String, fp: Value, setup: bool| {
        let body = json!({"command":script["command"],"expected_revision":script["revision"],"expected_execution":fp,"expected_owner":"owner","setup":setup});
        (format!("/api/v1/sessions/{sess}/scripts/{sid_script}/run"), body)
    };
    let (_, list) = s.get(&format!("/api/v1/projects/{pid}/scripts")).await;
    let owner = list["owner"].clone();
    let with_owner = |(path, mut body): (String, Value)| { body["expected_owner"] = owner.clone(); (path, body) };
    // 지정하지 않은 script로 설정 실행은 거절하고 작업을 만들지 않는다
    let (path, body) = with_owner(run(sess.clone(), st0["targets"][0]["fingerprint"].clone(), true));
    let (code, e) = s.post(&path, body).await;
    assert_eq!((code, e["error"]["code"].as_str()), (StatusCode::CONFLICT, Some("setup_script_changed")), "{e}");
    assert!(!root.join("ok").exists());
    // 지정: 실행하지 않는다
    let (code, v) = s.send(Method::PATCH, &format!("/api/v1/projects/{pid}"), json!({"expected_revision":p["revision"],"setup_script_id":sid_script})).await;
    assert_eq!(code, StatusCode::OK, "{v}");
    assert_eq!(v["setup_script_id"], sid_script.as_str());
    assert!(!root.join("ok").exists());
    let (_, st1) = s.get(&format!("/api/v1/projects/{pid}/setup")).await;
    assert_eq!(st1["script"]["name"], "setup");
    // 일반 script 실행은 설정 시도로 세지 않는다
    let (path, body) = with_owner(run(sess.clone(), st1["targets"][0]["fingerprint"].clone(), false));
    let (_, t) = s.post(&path, body).await;
    s.get(&format!("/api/v1/tasks/{}/wait?timeout_ms=10000", t["id"].as_str().unwrap())).await;
    std::fs::remove_file(root.join("ok")).unwrap();
    let (_, st) = s.get(&format!("/api/v1/projects/{pid}/setup")).await;
    assert_eq!((st["targets"][0]["status"].as_str(), st["targets"][0]["attempts"].as_i64()), (Some("not_run"), Some(0)));
    // 실패 → 재시도 성공
    for (want, n) in [("failed", 1), ("completed", 2)] {
        let (path, body) = with_owner(run(sess.clone(), st1["targets"][0]["fingerprint"].clone(), true));
        let (code, t) = s.post(&path, body).await;
        assert_eq!(code, StatusCode::CREATED, "{t}");
        s.get(&format!("/api/v1/tasks/{}/wait?timeout_ms=10000", t["id"].as_str().unwrap())).await;
        let (_, st) = s.get(&format!("/api/v1/projects/{pid}/setup")).await;
        let target = &st["targets"][0];
        assert_eq!((target["status"].as_str(), target["attempts"].as_i64()), (Some(want), Some(n)), "{st}");
        assert_eq!(target["task_id"], t["id"]);
        if want == "failed" { assert_eq!(target["exit_code"], 3); }
    }
    // worktree는 따로 센다: 그 worktree의 대화에서 그 위치의 확인값으로 실행한다
    s.use_workspaces(&pid).await;
    let (_, w) = s.post(&format!("/api/v1/projects/{pid}/worktrees"), json!({"name":"wt"})).await;
    let (_, st) = s.get(&format!("/api/v1/projects/{pid}/setup")).await;
    let wt = st["targets"].as_array().unwrap().iter().find(|t| t["worktree_id"] == w["id"]).unwrap().clone();
    assert_eq!(wt["status"], "not_run");
    assert_ne!(wt["fingerprint"], st["targets"][0]["fingerprint"]);
    let (_, ws) = s.post(&format!("/api/v1/projects/{pid}/sessions"), json!({"worktree_id": w["id"]})).await;
    let (path, body) = with_owner(run(sess.clone(), wt["fingerprint"].clone(), true));
    assert_eq!(s.post(&path, body).await.0, StatusCode::CONFLICT, "프로젝트 폴더 대화에서 worktree 확인값으로는 실행하지 않는다");
    let (path, body) = with_owner(run(ws["id"].as_str().unwrap().to_string(), wt["fingerprint"].clone(), true));
    let (_, t) = s.post(&path, body).await;
    s.get(&format!("/api/v1/tasks/{}/wait?timeout_ms=10000", t["id"].as_str().unwrap())).await;
    let (_, st) = s.get(&format!("/api/v1/projects/{pid}/setup")).await;
    let wt = st["targets"].as_array().unwrap().iter().find(|t| t["worktree_id"] == w["id"]).unwrap();
    assert_eq!((wt["status"].as_str(), wt["attempts"].as_i64()), (Some("failed"), Some(1)));
    assert_eq!(st["targets"][0]["attempts"], 2, "프로젝트 폴더 기록은 그대로");
    // 설정을 실행한 대화를 영구 삭제하면 그 위치의 설정 기록도 함께 지워진다
    let wsid = ws["id"].as_str().unwrap();
    let (_, cur) = s.get(&format!("/api/v1/sessions/{wsid}")).await;
    let (code, v) = s.send(Method::PATCH, &format!("/api/v1/sessions/{wsid}"), json!({"expected_revision":cur["revision"],"archived":true})).await;
    assert_eq!(code, StatusCode::OK, "{v}");
    let (code, v) = s.post(&format!("/api/v1/sessions/{wsid}/delete"), json!({"expected_revision":v["revision"],"confirm_title":v["title"]})).await;
    assert!(code.is_success(), "{v}");
    let (_, st) = s.get(&format!("/api/v1/projects/{pid}/setup")).await;
    let wt = st["targets"].as_array().unwrap().iter().find(|t| t["worktree_id"] == w["id"]).unwrap();
    assert_eq!((wt["status"].as_str(), wt["attempts"].as_i64()), (Some("not_run"), Some(0)));
    // 지정 해제는 기록을 지우지 않고 상태 표시만 비운다
    let (_, cur) = s.get(&format!("/api/v1/projects/{pid}")).await;
    let (_, v) = s.send(Method::PATCH, &format!("/api/v1/projects/{pid}"), json!({"expected_revision":cur["revision"],"setup_script_id":null})).await;
    assert!(v["setup_script_id"].is_null(), "{v}");
    let (code, _) = s.send(Method::PATCH, &format!("/api/v1/projects/{pid}"), json!({"expected_revision":v["revision"],"setup_script_id":"nope"})).await;
    assert_eq!(code, StatusCode::NOT_FOUND);
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
    let device=s.registered_device("fixture other device").await;
    let path=format!("/api/v1/sessions/{}/scripts/{}/run",session["id"].as_str().unwrap(),script["id"].as_str().unwrap());
    let response=s.raw(Method::POST,&path,Some(body),Some("original-owner-run"),device["token"].as_str()).await;
    assert_eq!(response.status(),StatusCode::FORBIDDEN);
    let error: Value=response.json().await.unwrap();
    assert_eq!(error["error"]["code"],"actor_changed");
    let (_,tasks)=s.get(&format!("/api/v1/sessions/{}/tasks",session["id"].as_str().unwrap())).await;
    assert_eq!(tasks["tasks"],json!([]));
    assert!(!std::path::Path::new(p["root_path"].as_str().unwrap()).join("counter").exists());
}
