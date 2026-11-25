//! 모델의 대화 간 조회는 실제 상속 경계와 사용자가 설정한 허용을 따른다.
use crate::common;

use common::{TestServer, fixture::{self, Fixture}};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn message(s: &TestServer, sid: &str, text: &str) {
    assert_eq!(s.post(&format!("/api/v1/sessions/{sid}/messages"),json!({"text":text})).await.0,StatusCode::CREATED);
}

async fn fork(s: &TestServer, sid: &str, inherit: bool) -> String {
    let (_,session) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    let (status,child) = s.post(&format!("/api/v1/sessions/{sid}/fork"),json!({"from_seq":session["last_message_seq"],"inherit_context":inherit})).await;
    assert_eq!(status,StatusCode::CREATED,"{child}");
    child["id"].as_str().unwrap().into()
}

async fn recall(s: &TestServer, sid: &str, args: Value) -> Result<Value,grove::error::ApiError> {
    let sid = sid.to_string();
    s.server.as_ref().unwrap().app.db.call(move |c|grove::recall::execute_tool(c,&sid,&args)).await
}

async fn allow(s: &TestServer, scope: &str, id: &str, revision: i64, allowed: bool) {
    let (status,value) = s.send(Method::PUT,&format!("/api/v1/settings/{scope}/{id}/sessions.allow_unrelated"),
        json!({"expected_revision":revision,"value":allowed})).await;
    assert_eq!(status,StatusCode::OK,"{value}");
}

#[tokio::test]
async fn default_recall_is_limited_to_current_and_pinned_inherited_history_while_manual_search_is_explicit() {
    let s = TestServer::start().await;
    let a = s.create_project("access-a").await;
    let b = s.create_project("access-b").await;
    let pid = a["id"].as_str().unwrap();
    let parent = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    message(&s,&parent,"AccessFixture parent before fork").await;
    let child = fork(&s,&parent,true).await;
    message(&s,&parent,"AccessFixture parent after fork PRIVATE").await;
    message(&s,&child,"AccessFixture own message").await;
    let unrelated = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    message(&s,&unrelated,"AccessFixture unrelated PRIVATE").await;
    let other = s.create_session(b["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    message(&s,&other,"AccessFixture other project PRIVATE").await;
    let result = recall(&s,&child,json!({"q":"AccessFixture"})).await.unwrap();
    assert_eq!(result["total"],2,"기본 범위는 자기 대화와 분기 시 실제 상속한 구간이다: {result}");
    assert!(!result.to_string().contains("PRIVATE"));
    let non_inheriting = fork(&s,&parent,false).await;
    message(&s,&non_inheriting,"AccessFixture non-inheriting own").await;
    assert_eq!(recall(&s,&non_inheriting,json!({"q":"AccessFixture"})).await.unwrap()["total"],1);
    let denied = recall(&s,&child,json!({"q":"AccessFixture","scope":"all","allow_unrelated":true})).await.unwrap_err();
    assert_eq!(denied.code,"unrelated_sessions_disabled","모델 인자가 사용자 설정을 대신하지 못한다");
    let (_,manual) = s.get("/api/v1/recall?q=AccessFixture").await;
    assert_eq!(manual["total"],6,"인증된 사용자가 직접 하는 검색은 모델 자동 조회와 구분한다");
    allow(&s,"project",pid,0,true).await;
    assert_eq!(recall(&s,&child,json!({"q":"AccessFixture"})).await.unwrap()["total"],5);
    assert_eq!(recall(&s,&child,json!({"q":"AccessFixture","scope":"all"})).await.unwrap()["total"],6);
    allow(&s,"session",&child,0,false).await;
    assert_eq!(recall(&s,&child,json!({"q":"AccessFixture"})).await.unwrap()["total"],2,"대화 범위에서 다시 제한할 수 있다");
    assert_eq!(recall(&s,&non_inheriting,json!({"q":"AccessFixture"})).await.unwrap()["total"],5,"다른 대화의 override는 인수하지 않는다");
}

#[tokio::test]
async fn unrelated_access_is_rechecked_after_an_earlier_tool_waits_for_user_approval() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("access-recheck").await;
    let pid = p["id"].as_str().unwrap();
    let unrelated = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    message(&s,&unrelated,"PrivateAccessFixture PRIVATE_UNRELATED_BODY").await;
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    allow(&s,"project",pid,0,true).await;
    f.push(fixture::tool_calls(&[
        ("barrier","write",json!({"path":"not-approved.txt","content":"blocked"})),
        ("recall-after-wait","recall",json!({"q":"PrivateAccessFixture","scope":"all"})),
    ]));
    f.push(fixture::text("denied access acknowledged"));
    let (_,accepted) = s.post(&format!("/api/v1/sessions/{sid}/turns"),json!({"text":"Find allowed evidence.","profile_id":profile,"tools":true})).await;
    let tid = accepted["turn"]["id"].as_str().unwrap();
    let waiting = s.wait_status(tid,"awaiting_approval").await;
    let barrier = waiting["tool_calls"].as_array().unwrap().iter().find(|c|c["provider_call_id"]=="barrier").unwrap();
    allow(&s,"project",pid,1,false).await;
    s.post(&format!("/api/v1/tool-calls/{}/decision",barrier["id"].as_str().unwrap()),
        json!({"decision":"deny","expected_revision":barrier["revision"]})).await;
    let turn = s.wait_status(tid,"completed").await;
    let call = turn["tool_calls"].as_array().unwrap().iter().find(|c|c["provider_call_id"]=="recall-after-wait").unwrap();
    assert_eq!(call["status"],"failed");
    assert_eq!(call["result"]["error"]["code"],"unrelated_sessions_disabled");
    assert!(!f.requests().last().unwrap().to_string().contains("PRIVATE_UNRELATED_BODY"));
}

#[tokio::test]
async fn nested_forks_keep_each_ancestors_own_pinned_boundary() {
    let s = TestServer::start().await;
    let p = s.create_project("nested-session-access").await;
    let root = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    message(&s,&root,"NestedAccessFixture root inherited").await;
    let child = fork(&s,&root,true).await;
    message(&s,&root,"NestedAccessFixture ROOT_PRIVATE_AFTER_FORK").await;
    message(&s,&child,"NestedAccessFixture child inherited").await;
    let grandchild = fork(&s,&child,true).await;
    message(&s,&child,"NestedAccessFixture CHILD_PRIVATE_AFTER_FORK").await;
    message(&s,&grandchild,"NestedAccessFixture current").await;
    let result = recall(&s,&grandchild,json!({"q":"NestedAccessFixture"})).await.unwrap();
    assert_eq!(result["total"],3);
    assert!(!result.to_string().contains("PRIVATE_AFTER_FORK"),"각 원본 대화는 자기 분기 seq까지만 허용한다");
}
