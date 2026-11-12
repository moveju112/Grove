//! 선택 범위 복원은 계층·revision을 확인하고 한 transaction으로 접수한다.
mod common;
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn put(s: &TestServer,scope: &str,id: &str,key: &str,revision: i64,value: Value) {
    let (status,result)=s.send(Method::PUT,&format!("/api/v1/settings/{scope}/{id}/{key}"),json!({"expected_revision":revision,"value":value})).await;
    assert_eq!(status,StatusCode::OK,"{result}");
}
async fn preview(s: &TestServer,scope: &str,id: &str,project: &str,keys: &str) -> Value {
    let (status,result)=s.get(&format!("/api/v1/settings/reset-preview?scope={scope}&scope_id={id}&project_id={project}&keys={keys}")).await;
    assert_eq!(status,StatusCode::OK,"{result}");
    result
}
fn body(plan: &Value) -> Value {
    json!({"target":plan["target"],"expected_fingerprint":plan["fingerprint"],"expected_owner":plan["owner"]})
}
fn item<'a>(plan: &'a Value,key: &str) -> &'a Value {
    plan["items"].as_array().unwrap().iter().find(|item|item["key"]==key).unwrap()
}

#[tokio::test]
async fn preview_is_read_only_reset_inherits_and_replays_without_clearing_newer_values() {
    let s=TestServer::start().await;
    let project=s.create_project("reset").await;
    let other=s.create_project("other").await;
    let pid=project["id"].as_str().unwrap();
    let session=s.create_session(pid).await;
    let sid=session["id"].as_str().unwrap();
    put(&s,"server","-","output.language",0,json!("server-language")).await;
    put(&s,"project",pid,"output.language",0,json!("project-language")).await;
    put(&s,"session",sid,"output.language",0,json!("session-language")).await;
    put(&s,"project",pid,"output.style",0,json!("detailed")).await;
    let plan=preview(&s,"project",pid,pid,"output.style,output.language").await;
    assert_eq!(item(&plan,"output.language")["before"]["effective"],"project-language");
    assert_eq!(item(&plan,"output.language")["after"]["effective"],"server-language");
    assert_eq!(item(&plan,"output.language")["after"]["source"],"server");
    assert_eq!(item(&plan,"output.style")["after"]["source"],"default");
    let same=preview(&s,"project",pid,pid,"output.language,output.style,output.language").await;
    assert_eq!(same["fingerprint"],plan["fingerprint"]);
    let current=preview(&s,"project",pid,pid,"output.language").await;
    assert_eq!(item(&current,"output.language")["before"]["effective"],"project-language","미리보기는 쓰지 않는다");
    let response=s.raw(Method::POST,"/api/v1/settings/reset",Some(body(&plan)),Some("reset-once"),None).await;
    assert_eq!(response.status(),StatusCode::OK);
    let accepted: Value=response.json().await.unwrap();
    assert_eq!(accepted["changed"].as_array().unwrap().len(),2);
    let (_,effective)=s.get(&format!("/api/v1/settings/effective?session_id={sid}")).await;
    assert_eq!(item(&effective,"output.language")["effective"],"session-language","하위 대화 override 유지");
    let (_,effective)=s.get(&format!("/api/v1/settings/effective?project_id={}",other["id"].as_str().unwrap())).await;
    assert_eq!(item(&effective,"output.language")["effective"],"server-language","다른 프로젝트는 그대로 상속");
    put(&s,"project",pid,"output.language",2,json!("new-value")).await;
    let replay=s.raw(Method::POST,"/api/v1/settings/reset",Some(body(&plan)),Some("reset-once"),None).await;
    assert_eq!(replay.status(),StatusCode::OK);
    assert_eq!(replay.headers()["idempotent-replayed"],"true");
    assert_eq!(replay.json::<Value>().await.unwrap(),accepted);
    let current=preview(&s,"project",pid,pid,"output.language").await;
    assert_eq!(item(&current,"output.language")["before"]["effective"],"new-value");
}

#[tokio::test]
async fn changed_parent_or_any_selected_key_rejects_the_whole_reset() {
    let s=TestServer::start().await;
    let p=s.create_project("conflict").await;
    let pid=p["id"].as_str().unwrap();
    put(&s,"project",pid,"output.language",0,json!("local")).await;
    put(&s,"project",pid,"output.style",0,json!("detailed")).await;
    let plan=preview(&s,"project",pid,pid,"output.language,output.style").await;
    put(&s,"server","-","output.language",0,json!("changed-parent")).await;
    let (status,error)=s.post("/api/v1/settings/reset",body(&plan)).await;
    assert_eq!(status,StatusCode::CONFLICT,"{error}");
    assert_eq!(error["error"]["code"],"reset_conflict");
    let next=preview(&s,"project",pid,pid,"output.language,output.style").await;
    assert_eq!(item(&next,"output.language")["before"]["effective"],"local");
    assert_eq!(item(&next,"output.style")["before"]["effective"],"detailed");
    put(&s,"project",pid,"output.style",1,json!("concise")).await;
    assert_eq!(s.post("/api/v1/settings/reset",body(&next)).await.0,StatusCode::CONFLICT);
    let current=preview(&s,"project",pid,pid,"output.language").await;
    assert_eq!(item(&current,"output.language")["before"]["layers"]["project"]["revision"],1);
}

#[tokio::test]
async fn transaction_failure_keeps_all_values_and_same_key_can_finish_after_recovery() {
    let s=TestServer::start().await;
    let p=s.create_project("atomic").await;
    let pid=p["id"].as_str().unwrap();
    put(&s,"project",pid,"output.language",0,json!("local")).await;
    put(&s,"project",pid,"output.style",0,json!("detailed")).await;
    let plan=preview(&s,"project",pid,pid,"output.language,output.style").await;
    let events_before=s.server.as_ref().unwrap().app.db.call(|c| {
        Ok(c.query_row("SELECT COUNT(*) FROM events WHERE kind='setting.changed'",[],|row|row.get::<_,i64>(0))?)
    }).await.unwrap();
    s.server.as_ref().unwrap().app.db.call(|c| {
        c.execute_batch("CREATE TRIGGER reset_failure BEFORE UPDATE ON settings WHEN NEW.key='output.style' AND NEW.value IS NULL BEGIN SELECT RAISE(ABORT,'fixture reset failure'); END;")?;
        Ok(())
    }).await.unwrap();
    let response=s.raw(Method::POST,"/api/v1/settings/reset",Some(body(&plan)),Some("recover-reset"),None).await;
    assert_eq!(response.status(),StatusCode::INTERNAL_SERVER_ERROR);
    let current=preview(&s,"project",pid,pid,"output.language,output.style").await;
    assert_eq!(current["fingerprint"],plan["fingerprint"],"값과 revision을 모두 rollback한다");
    let events_after=s.server.as_ref().unwrap().app.db.call(|c| {
        Ok(c.query_row("SELECT COUNT(*) FROM events WHERE kind='setting.changed'",[],|row|row.get::<_,i64>(0))?)
    }).await.unwrap();
    assert_eq!(events_after,events_before,"실패한 복원의 이벤트도 rollback한다");
    s.server.as_ref().unwrap().app.db.call(|c| { c.execute_batch("DROP TRIGGER reset_failure")?; Ok(()) }).await.unwrap();
    let response=s.raw(Method::POST,"/api/v1/settings/reset",Some(body(&plan)),Some("recover-reset"),None).await;
    assert_eq!(response.status(),StatusCode::OK);
    let current=preview(&s,"project",pid,pid,"output.language,output.style").await;
    assert!(current["items"].as_array().unwrap().iter().all(|item|item["changed"]==false));
    assert_eq!(s.post("/api/v1/settings/reset",body(&current)).await.0,StatusCode::OK);
    assert_eq!(preview(&s,"project",pid,pid,"output.language,output.style").await["fingerprint"],current["fingerprint"],"이미 상속 중이면 revision을 올리지 않는다");
}

#[tokio::test]
async fn scope_authentication_and_unknown_keys_are_checked_without_partial_mutation() {
    let s=TestServer::start().await;
    let p=s.create_project("validation").await;
    let other=s.create_project("other").await;
    let pid=p["id"].as_str().unwrap();
    put(&s,"server","-","user.profile",0,json!("fixture private profile")).await;
    let plan=preview(&s,"server","-",pid,"user.profile").await;
    let (_,device)=s.post("/api/v1/devices",json!({"name":"fixture second auth"})).await;
    assert_eq!(s.raw(Method::POST,"/api/v1/settings/reset",Some(body(&plan)),Some("different-auth"),device["token"].as_str()).await.status(),StatusCode::FORBIDDEN);
    assert_eq!(s.raw(Method::GET,"/api/v1/settings/reset-preview?scope=server&scope_id=-&keys=user.profile",None,None,Some("")).await.status(),StatusCode::UNAUTHORIZED);
    assert_eq!(s.raw(Method::POST,"/api/v1/settings/reset",Some(body(&plan)),None,None).await.status(),StatusCode::BAD_REQUEST);
    for (suffix,expected) in [
        ("scope=server&scope_id=wrong&keys=output.language".to_string(),StatusCode::BAD_REQUEST),
        (format!("scope=project&scope_id={pid}&keys=nope,output.language"),StatusCode::NOT_FOUND),
        (format!("scope=project&scope_id={pid}&keys=approval.ttl_secs,output.language"),StatusCode::BAD_REQUEST),
        (format!("scope=project&scope_id={pid}&keys=output.language&project_id={}",other["id"].as_str().unwrap()),StatusCode::BAD_REQUEST),
    ] {
        assert_eq!(s.get(&format!("/api/v1/settings/reset-preview?{suffix}")).await.0,expected);
    }
    let current=preview(&s,"server","-",pid,"user.profile").await;
    assert_eq!(current["fingerprint"],plan["fingerprint"]);
    assert_eq!(s.post("/api/v1/settings/reset",body(&plan)).await.0,StatusCode::OK);
    s.server.as_ref().unwrap().app.db.call(|c| {
        let audit: String=c.query_row("SELECT detail FROM audit_log WHERE action='settings.reset' LIMIT 1",[],|row|row.get(0))?;
        assert!(!audit.contains("fixture private profile"));
        Ok(())
    }).await.unwrap();
}
