//! 격리된 실제 HTTP fixture로 Maintainer의 실행·철회·재시작 경계를 검사한다.
use crate::common;
use common::{*, fixture::{self, Fixture}};
use reqwest::Method;
use serde_json::{Value,json};
use std::time::Duration;

async fn setting(s: &TestServer, pid: &str, key: &str, value: Value) {
    let (_,all) = s.get(&format!("/api/v1/settings/effective?project_id={pid}")).await;
    let (scope, id) = if matches!(key, "memory.profile" | "memory.fallback") { ("server", "-") } else { ("project", pid) };
    let rev = all["items"].as_array().unwrap().iter().find(|i|i["key"]==key).unwrap()["layers"][scope]["revision"].clone();
    let (status,result) = s.send(Method::PUT,&format!("/api/v1/settings/{scope}/{id}/{key}"),json!({"expected_revision":rev,"value":value})).await;
    assert!(status.is_success(),"{result}");
}
async fn completed(s: &TestServer, f: &Fixture, sid: &str, profile: &str) {
    f.push(fixture::text("기존 코드를 확인한 결과"));
    let (_,t) = s.post(&format!("/api/v1/sessions/{sid}/turns"),json!({"text":"설계 선택을 검토해줘","profile_id":profile})).await;
    s.wait_status(t["turn"]["id"].as_str().unwrap(),"completed").await;
}
async fn records(s: &TestServer, pid: &str) -> Value {
    s.get(&format!("/api/v1/memory?project_id={pid}")).await.1
}
async fn setup() -> (TestServer,Fixture,Fixture,String,String,String,String) {
    let s = TestServer::start().await;
    let main=Fixture::start().await;
    let aux=Fixture::start().await;
    let profile=s.fixture_profile(&main.base).await;
    let aux_profile=s.fixture_profile(&aux.base).await;
    let pid=s.create_project("memory").await["id"].as_str().unwrap().to_string();
    let sid=s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    completed(&s,&main,&sid,&profile).await;
    (s,main,aux,profile,aux_profile,pid,sid)
}

#[tokio::test]
async fn maintainer_runs_in_solo_with_own_model_and_persists_recall_checkpoint() {
    let (s,main,aux,_profile,model,pid,sid)=setup().await;
    for (key,value) in [("agents.orchestration",json!("solo")),("agents.delegation",json!("off")),("memory.enabled",json!(true)),("memory.profile",json!({"profile_id":model,"model":"memory-small","effort":"medium"}))] { setting(&s,&pid,key,value).await; }
    aux.push(fixture::text("결정: 별빛 보관소를 사용한다."));
    let app=&s.server.as_ref().unwrap().app;
    grove::memory::tick(app).await.unwrap();
    let data=records(&s,&pid).await;
    assert_eq!(data["items"].as_array().unwrap().len(),1,"{data}");
    assert_eq!(data["checkpoints"][0]["error_code"],Value::Null);
    grove::memory::tick(app).await.unwrap();
    assert_eq!(aux.requests().len(),1,"처리한 근거를 중복 호출하지 않는다");
    assert_eq!(main.requests().len(),1);
    let request=&aux.requests()[0];
    assert_eq!(request["model"],"memory-small");
    assert_eq!(request["reasoning_effort"],"medium");
    assert!(request["messages"][0]["content"].as_str().unwrap().contains("untrusted"));
    let (_,recall)=s.get(&format!("/api/v1/recall?q=별빛&project_id={pid}")).await;
    assert_eq!(recall["items"].as_array().unwrap().len(),0);
    assert_eq!(recall["memories"][0]["session_id"],sid);
    // 새 App도 영속 처리 위치를 이어가며 같은 입력을 다시 생성하지 않는다.
    let reopened=grove::App::new(common::config(&s.data_dir()),std::sync::Arc::new(grove::util::SystemClock)).unwrap();
    let sid2=sid.clone();
    let count=reopened.db.call(move |c| Ok(c.query_row("SELECT COUNT(*) FROM memory_notes WHERE session_id=?1",[sid2],|r| r.get::<_,i64>(0))?)).await.unwrap();
    assert_eq!(count,1,"실제 영속 DB를 다시 연다");
    grove::memory::tick(&reopened).await.unwrap();
    assert_eq!(aux.requests().len(),1);
}

/// Maintainer 모델이 계정 한도로 거절되면 같은 처리 위치에서 고른 대체 모델로 한 번만 다시 부른다.
#[tokio::test]
async fn maintainer_usage_limit_retries_once_on_fallback() {
    let (s,_main,aux,_profile,model,pid,sid)=setup().await;
    let backup=Fixture::start().await;
    let backup_prof=s.fixture_profile(&backup.base).await;
    for (key,value) in [("agents.orchestration",json!("solo")),("agents.delegation",json!("off")),("memory.enabled",json!(true)),
        ("memory.profile",json!(model)),("memory.fallback",json!(backup_prof))] { setting(&s,&pid,key,value).await; }
    aux.push(fixture::Step::ErrorCode(429,"usage_limit_reached"));
    backup.push(fixture::text("결정: 대체 모델로 정리한다."));
    let app=&s.server.as_ref().unwrap().app;
    grove::memory::tick(app).await.unwrap();
    let data=records(&s,&pid).await;
    assert_eq!(data["items"].as_array().unwrap().len(),1,"{data}");
    assert_eq!(data["checkpoints"][0]["error_code"],Value::Null);
    assert_eq!((aux.requests().len(),backup.requests().len()),(1,1));
    let sid2=sid.clone();
    let used=app.db.call(move |c| Ok(c.query_row("SELECT profile_id FROM memory_notes WHERE session_id=?1",[sid2],|r| r.get::<_,String>(0))?)).await.unwrap();
    assert_eq!(used,backup_prof,"정리 기록은 실제로 쓴 모델을 남긴다");
}

#[tokio::test]
async fn disabled_unconfigured_and_failed_maintainer_never_borrow_main_model() {
    let (s,main,aux,_profile,model,pid,_sid)=setup().await;
    let app=&s.server.as_ref().unwrap().app;
    grove::memory::tick(app).await.unwrap();
    setting(&s,&pid,"memory.enabled",json!(true)).await;
    grove::memory::tick(app).await.unwrap();
    assert!(aux.requests().is_empty());
    setting(&s,&pid,"memory.profile",json!(model)).await;
    let (_,def)=s.get("/api/v1/definitions/agent/maintainer").await;
    s.send(Method::PUT,"/api/v1/definitions/agent/maintainer",json!({"expected_revision":def["revision"],"enabled":false})).await;
    grove::memory::tick(app).await.unwrap();
    assert!(aux.requests().is_empty());
    let (_,def)=s.get("/api/v1/definitions/agent/maintainer").await;
    s.send(Method::PUT,"/api/v1/definitions/agent/maintainer",json!({"expected_revision":def["revision"],"enabled":true,"body":"Project memory custom instructions"})).await;
    aux.push(fixture::Step::Error(400,"model unavailable".into()));
    grove::memory::tick(app).await.unwrap();
    grove::memory::tick(app).await.unwrap();
    assert_eq!(aux.requests().len(),1);
    assert_eq!(main.requests().len(),1);
    assert!(aux.requests()[0]["messages"][0]["content"].as_str().unwrap().contains("Project memory custom instructions"));
    let data=records(&s,&pid).await;
    assert_eq!(data["checkpoints"][0]["error_code"],"model_error");
    assert!(data["items"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn revoking_memory_while_model_runs_discards_late_result() {
    let (s,_main,aux,_profile,model,pid,_sid)=setup().await;
    setting(&s,&pid,"memory.enabled",json!(true)).await;
    setting(&s,&pid,"memory.profile",json!(model)).await;
    let (gate,rx)=tokio::sync::watch::channel(false);
    let fixture::Step::Frames(frames,_) = fixture::text("저장하면 안 되는 요약") else { panic!() };
    aux.push(fixture::Step::Gated(frames,rx));
    let app=s.server.as_ref().unwrap().app.clone();
    let task=tokio::spawn(async move { grove::memory::tick(&app).await.unwrap() });
    tokio::time::timeout(Duration::from_secs(3),async { while aux.requests().is_empty() { tokio::time::sleep(Duration::from_millis(10)).await; } }).await.unwrap();
    setting(&s,&pid,"memory.enabled",json!(false)).await;
    gate.send_replace(true);
    task.await.unwrap();
    assert!(records(&s,&pid).await["items"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn recall_memory_respects_unrelated_session_and_rewind_boundaries() {
    let (s,_main,aux,_profile,model,pid,sid)=setup().await;
    setting(&s,&pid,"memory.enabled",json!(true)).await;
    setting(&s,&pid,"memory.profile",json!(model)).await;
    aux.push(fixture::text(&format!("BoundaryFixture 기억 {}", "가".repeat(2000))));
    let app=&s.server.as_ref().unwrap().app;
    grove::memory::tick(app).await.unwrap();
    assert!(records(&s,&pid).await["items"][0]["summary"].as_str().unwrap().chars().count()>640);
    let (status,error)=s.get("/api/v1/memory?unexpected=value").await;
    assert_eq!(status,reqwest::StatusCode::BAD_REQUEST);
    assert_eq!(error["error"]["code"],"invalid_request");
    let other=s.create_session(&pid).await["id"].as_str().unwrap().to_string();
    let source=sid.clone();
    app.db.call(move |c| {
        let args=json!({"q":"BoundaryFixture"});
        let result=grove::recall::execute_tool(c,&source,&args)?;
        assert_eq!(result["memories"].as_array().unwrap().len(),1);
        assert_eq!(result["memories"][0]["truncated"],true);
        assert!(result["memories"][0]["summary"].as_str().unwrap().chars().count()<=640);
        assert_eq!(grove::recall::execute_tool(c,&other,&args)?["memories"].as_array().unwrap().len(),0);
        Ok(())
    }).await.unwrap();
    let (_,messages)=s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let first=&messages["items"][0];
    let (_,current)=s.get(&format!("/api/v1/sessions/{sid}")).await;
    let (status,result)=s.post(&format!("/api/v1/sessions/{sid}/rewind"),json!({"message_id":first["id"],"expected_revision":current["revision"],"expected_last_message_seq":current["last_message_seq"]})).await;
    assert!(status.is_success(),"{result}");
    assert!(records(&s,&pid).await["items"].as_array().unwrap().is_empty());
    assert!(s.get(&format!("/api/v1/recall?q=BoundaryFixture&project_id={pid}")).await.1["memories"].as_array().unwrap().is_empty());
}
