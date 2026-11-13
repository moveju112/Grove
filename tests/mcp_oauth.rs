mod common;

use axum::{Json, Form, Router, body::Body, extract::{Query, State}, http::HeaderMap, response::{IntoResponse, Response}, routing::{get, post}};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use common::TestServer;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}}};

// 합성 자격만 사용한다. 로컬 issuer·MCP 이외의 네트워크는 필요 없다.
const ACCESS: &str = "synthetic-oauth-access-private";
const REFRESH: &str = "synthetic-oauth-refresh-private";
#[derive(Clone)]
struct Issuer {
    base: String,
    mode: Arc<AtomicUsize>,
    tokens: Arc<AtomicUsize>,
    calls: Arc<AtomicUsize>,
    challenge: Arc<Mutex<String>>,
    client_secret: Arc<Mutex<Option<String>>>,
    entered: Arc<tokio::sync::Notify>,
    finish: Arc<tokio::sync::Notify>,
}
struct Fixture { issuer: Issuer, task: tokio::task::JoinHandle<()> }
impl Drop for Fixture { fn drop(&mut self) { self.task.abort(); } }
impl Fixture {
    async fn start() -> Self {
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let issuer = Issuer { base:format!("http://{}",socket.local_addr().unwrap()),mode:Arc::default(),tokens:Arc::default(),
            calls:Arc::default(),challenge:Arc::default(),client_secret:Arc::default(),entered:Arc::default(),finish:Arc::default() };
        let router = Router::new().route("/.well-known/oauth-protected-resource/mcp",get(resource))
            .route("/.well-known/oauth-authorization-server",get(metadata))
            .route("/authorize",get(authorize)).route("/token",post(token)).route("/mcp",post(rpc).delete(||async { StatusCode::OK }))
            .with_state(issuer.clone());
        let task = tokio::spawn(async move { axum::serve(socket,router).await.unwrap(); });
        Self { issuer,task }
    }
}
async fn resource(State(s): State<Issuer>) -> Json<Value> {
    Json(json!({"resource":format!("{}/mcp",s.base),"authorization_servers":[s.base]}))
}
async fn metadata(State(s): State<Issuer>) -> Json<Value> {
    Json(json!({"issuer":s.base,"authorization_endpoint":format!("{}/authorize",s.base),
        "token_endpoint":format!("{}/token",s.base),"code_challenge_methods_supported":if s.mode.load(Ordering::SeqCst)==6 {json!(["plain"])} else {json!(["S256"])},
        "response_types_supported":["code"],"token_endpoint_auth_methods_supported":["none","client_secret_post"],
        "authorization_response_iss_parameter_supported":true}))
}
async fn authorize(State(s): State<Issuer>, Query(q): Query<HashMap<String,String>>) -> Json<Value> {
    assert_eq!(q["code_challenge_method"],"S256");
    assert_eq!(q["resource"],format!("{}/mcp",s.base));
    assert_eq!(q["client_id"],"registered-fixture");
    assert!(!q.contains_key("client_secret"));
    *s.challenge.lock().unwrap() = q["code_challenge"].clone();
    Json(json!({"code":"synthetic-one-use-code","state":q["state"],"iss":s.base}))
}
async fn token(State(s): State<Issuer>, Form(q): Form<HashMap<String,String>>) -> Response {
    s.tokens.fetch_add(1,Ordering::SeqCst);
    assert_eq!(q["resource"],format!("{}/mcp",s.base));
    assert_eq!(q["client_id"],"registered-fixture");
    assert_eq!(q.get("client_secret"),s.client_secret.lock().unwrap().as_ref());
    if q["grant_type"]=="authorization_code" {
        assert_eq!(URL_SAFE_NO_PAD.encode(Sha256::digest(q["code_verifier"].as_bytes())),*s.challenge.lock().unwrap());
        assert!(q["redirect_uri"].contains("/api/mcp-oauth/callback/"));
        assert_eq!(q["code"],"synthetic-one-use-code");
    } else { assert_eq!(q["refresh_token"],REFRESH); }
    let mode=s.mode.load(Ordering::SeqCst);
    s.entered.notify_one();
    if mode==2 { s.finish.notified().await; }
    if mode==1 {
        let chunks=vec![Ok(bytes::Bytes::from_static(b"{")),Err(std::io::Error::new(std::io::ErrorKind::ConnectionReset,"local fixture lost response"))];
        return ([( "content-type","application/json")],Body::from_stream(tokio_stream::iter(chunks))).into_response();
    }
    if mode==3 { return (StatusCode::BAD_REQUEST,Json(json!({"error":"invalid_grant","error_description":ACCESS}))).into_response(); }
    if mode==4 { return Json(json!({"access_token":ACCESS,"token_type":"Bearer","expires_in":3600,"scope":"unrequested"})).into_response(); }
    if mode==5 { return (StatusCode::TEMPORARY_REDIRECT,[("location","http://127.0.0.1:1/steal")]).into_response(); }
    Json(json!({"access_token":ACCESS,"refresh_token":REFRESH,"token_type":"Bearer","expires_in":3600,"scope":"tools"})).into_response()
}
async fn rpc(State(s): State<Issuer>, headers: HeaderMap, Json(q): Json<Value>) -> Response {
    if headers.get("authorization").and_then(|v|v.to_str().ok())!=Some(&format!("Bearer {ACCESS}")) { return StatusCode::UNAUTHORIZED.into_response(); }
    let result=match q["method"].as_str().unwrap() {
        "notifications/initialized" => return StatusCode::ACCEPTED.into_response(),
        "initialize" => json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}),
        "tools/list" => json!({"tools":[{"name":"echo","description":ACCESS,"inputSchema":{"type":"object"}}]}),
        "tools/call" => { s.calls.fetch_add(1,Ordering::SeqCst);json!({"content":[{"type":"text","text":format!("result {ACCESS} {REFRESH}")}]}) },
        _ => panic!("unexpected MCP request"),
    };
    Json(json!({"jsonrpc":"2.0","id":q["id"],"result":result})).into_response()
}
fn path(server: &Value) -> String { format!("/api/v1/mcp/servers/{}",server["id"].as_str().unwrap()) }
async fn registered(s: &TestServer, f: &Fixture) -> Value {
    let (st,mut server)=s.post("/api/v1/mcp/servers",json!({"name":"oauth-fixture","enabled":true,
        "config":{"transport":"http","endpoint":format!("{}/mcp",f.issuer.base)}})).await;
    assert_eq!(st,StatusCode::CREATED);
    let id=server["id"].as_str().unwrap().to_string();
    server["config"]["oauth"]=json!({"issuer":f.issuer.base,"authorization_endpoint":format!("{}/authorize",f.issuer.base),
        "token_endpoint":format!("{}/token",f.issuer.base),"client_id":"registered-fixture","scopes":["tools"],
        "redirect_uri":format!("{}/api/mcp-oauth/callback/{id}",s.base)});
    let (st,server)=s.send(Method::PUT,&path(&server),json!({"expected_revision":1,"server":{
        "name":"oauth-fixture","enabled":true,"config":server["config"]}})).await;
    assert_eq!(st,StatusCode::OK,"{server}");
    server
}
async fn current(s: &TestServer, id: &str) -> Value {
    s.get("/api/v1/mcp/servers").await.1.as_array().unwrap().iter().find(|v|v["id"]==id).unwrap().clone()
}
async fn begin(s: &TestServer, server: &Value) -> (Value,Value) {
    let (st,start)=s.post(&format!("{}/oauth/connect",path(server)),json!({"expected_revision":server["revision"],"confirmed":true})).await;
    assert_eq!(st,StatusCode::CREATED,"{start}");
    let callback:Value=s.client.get(start["authorization_url"].as_str().unwrap()).send().await.unwrap().json().await.unwrap();
    let mut callback=callback.as_object().unwrap().clone();
    callback.insert("expected_revision".into(),server["revision"].clone());
    callback.insert("attempt_id".into(),start["attempt_id"].clone());
    callback.insert("error".into(),Value::Null);
    (start,Value::Object(callback))
}
async fn completed(s: &TestServer, f: &Fixture, server: &Value) -> Value {
    let (_,callback)=begin(s,server).await;
    let (st,result)=s.post(&format!("{}/oauth/complete",path(server)),callback).await;
    assert_eq!(st,StatusCode::OK,"{result}");
    assert_eq!(result["status"],"completed");
    assert!(f.issuer.tokens.load(Ordering::SeqCst)>0);
    current(s,server["id"].as_str().unwrap()).await
}
async fn check(s: &TestServer, server: &Value) {
    let (st,result)=s.post(&format!("{}/check",path(server)),json!({"expected_revision":server["revision"],"confirmed":true})).await;
    assert_eq!(st,StatusCode::OK,"{result}");
    assert_eq!(result["status"],"ready","{result}");
    assert!(!result.to_string().contains(ACCESS));
}
async fn tool(s: &TestServer, session: &str, server: &Value) -> Value {
    let (st,result)=s.post(&format!("/api/v1/sessions/{session}/tool-requests"),json!({"name":"mcp_call",
        "args":{"server_id":server["id"],"tool":"oauth-fixture/echo","arguments":{}}})).await;
    assert_eq!(st,StatusCode::CREATED,"{result}");
    result
}
async fn approve(s: &TestServer, call: &Value) -> (StatusCode,Value) {
    s.post(&format!("/api/v1/tool-calls/{}/decision",call["id"].as_str().unwrap()),
        json!({"decision":"approve","expected_revision":call["revision"]})).await
}
async fn wait_call(s: &TestServer, call: &Value, expected: &str) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(5),async {
        loop {
            let value=s.get(&format!("/api/v1/tool-calls/{}",call["id"].as_str().unwrap())).await.1;
            if value["status"]==expected { return value; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap()
}

#[tokio::test]
async fn preregistered_pkce_connect_check_approved_execution_refresh_and_identity() {
    let s=TestServer::start().await;
    let f=Fixture::start().await;
    let server=registered(&s,&f).await;
    let server=completed(&s,&f,&server).await;
    assert_eq!(server["revision"],4);
    assert!(server["last_check"].is_null(),"OAuth completion is not MCP connection success");
    check(&s,&server).await;
    let project=s.create_project("oauth").await;
    let session=s.create_session(project["id"].as_str().unwrap()).await;
    let session=session["id"].as_str().unwrap();
    let stale=tool(&s,session,&server).await;
    assert_eq!(f.issuer.calls.load(Ordering::SeqCst),0);
    let (st,result)=s.post(&format!("{}/oauth/refresh",path(&server)),json!({"expected_revision":server["revision"],"confirmed":true})).await;
    assert_eq!(st,StatusCode::OK,"{result}");
    assert_eq!(result["status"],"completed");
    let server=current(&s,server["id"].as_str().unwrap()).await;
    assert!(server["last_check"].is_null());
    assert_eq!(approve(&s,&stale).await.0,StatusCode::OK);
    let rejected=wait_call(&s,&stale,"failed").await;
    assert_eq!(rejected["result"]["error"]["code"],"mcp_auth_changed");
    assert_eq!(f.issuer.calls.load(Ordering::SeqCst),0);
    check(&s,&server).await;
    let call=tool(&s,session,&server).await;
    assert_eq!(approve(&s,&call).await.0,StatusCode::OK);
    let result=wait_call(&s,&call,"succeeded").await;
    assert_eq!(result["status"],"succeeded","{result}");
    assert!(!result.to_string().contains(ACCESS));
    assert!(!result.to_string().contains(REFRESH));
    assert_eq!(f.issuer.calls.load(Ordering::SeqCst),1);
    let id=server["id"].as_str().unwrap().to_string();
    s.server.as_ref().unwrap().app.db.call(move |c| {
        let (access,refresh):(String,String)=c.query_row("SELECT access_token,refresh_token FROM mcp_oauth_credentials WHERE server_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?)))?;
        assert!(access.starts_with("v1:") && refresh.starts_with("v1:"));
        for query in ["SELECT response FROM idempotency","SELECT detail FROM mcp_checks","SELECT payload FROM events","SELECT detail FROM audit_log"] {
            let mut st=c.prepare(query)?;
            for row in st.query_map([],|r|r.get::<_,String>(0))? {
                let row=row?;
                assert!(!row.contains(ACCESS) && !row.contains(REFRESH) && !row.contains("synthetic-one-use-code"));
            }
        }
        Ok(())
    }).await.unwrap();
}

#[tokio::test]
async fn one_use_state_owner_issuer_server_revision_cancel_expiry_and_restart() {
    let mut s=TestServer::start().await;
    let f=Fixture::start().await;
    let server=registered(&s,&f).await;
    let endpoint=format!("{}/oauth",path(&server));
    assert_eq!(s.raw(Method::GET,&endpoint,None,None,Some("")).await.status(),StatusCode::UNAUTHORIZED);
    let (_,device)=s.post("/api/v1/devices",json!({"name":"oauth-device"})).await;
    assert_eq!(s.raw(Method::GET,&endpoint,None,None,device["token"].as_str()).await.status(),StatusCode::FORBIDDEN);
    let (start,callback)=begin(&s,&server).await;
    for (field,value) in [("state",json!("forged")),("iss",json!("https://other.example")),("expected_revision",json!(999))] {
        let mut forged=callback.clone();forged[field]=value;
        assert_eq!(s.post(&format!("{endpoint}/complete"),forged).await.0,StatusCode::CONFLICT);
    }
    let (_,browser)=s.post("/api/v1/auth/browser-login",json!({"token":s.token,"name":"another-browser"})).await;
    assert_eq!(s.raw(Method::POST,&format!("{endpoint}/complete"),Some(callback.clone()),Some(&s.key()),browser["access_token"].as_str()).await.status(),StatusCode::CONFLICT);
    let (st,_)=s.post(&format!("{endpoint}/cancel"),json!({"expected_revision":2,"attempt_id":start["attempt_id"]})).await;
    assert_eq!(st,StatusCode::OK);
    assert_eq!(s.post(&format!("{endpoint}/complete"),callback).await.0,StatusCode::CONFLICT);
    let (_,expired)=begin(&s,&server).await;
    s.server.as_ref().unwrap().app.db.call(|c| {
        c.execute("UPDATE mcp_oauth_attempts SET expires_at='2000-01-01T00:00:00Z' WHERE status='pending'",[])?;Ok(())
    }).await.unwrap();
    assert_eq!(s.get(&endpoint).await.1["attempt"]["status"],"expired");
    assert_eq!(s.post(&format!("{endpoint}/complete"),expired).await.0,StatusCode::CONFLICT);
    let (_,interrupted)=begin(&s,&server).await;
    s.restart().await;
    assert_eq!(s.get(&endpoint).await.1["attempt"]["status"],"interrupted");
    assert_eq!(s.post(&format!("{endpoint}/complete"),interrupted).await.0,StatusCode::CONFLICT);
    assert_eq!(f.issuer.tokens.load(Ordering::SeqCst),0);
}

#[tokio::test]
async fn lost_token_response_and_lost_refresh_response_remain_unknown_without_retries() {
    let mut s=TestServer::start().await;
    let f=Fixture::start().await;
    let server=registered(&s,&f).await;
    let (_,callback)=begin(&s,&server).await;
    let endpoint=format!("{}/oauth/complete",path(&server));
    f.issuer.mode.store(1,Ordering::SeqCst);
    let key=s.key();
    for _ in 0..2 {
        let r=s.raw(Method::POST,&endpoint,Some(callback.clone()),Some(&key),None).await;
        assert_eq!(r.status(),StatusCode::OK);
        assert_eq!(r.json::<Value>().await.unwrap()["status"],"unknown");
    }
    assert_eq!(f.issuer.tokens.load(Ordering::SeqCst),1);
    assert_eq!(s.post(&endpoint,callback).await.0,StatusCode::CONFLICT);
    let mut server=current(&s,server["id"].as_str().unwrap()).await;
    f.issuer.mode.store(0,Ordering::SeqCst);
    server=completed(&s,&f,&server).await;
    f.issuer.mode.store(1,Ordering::SeqCst);
    let body=json!({"expected_revision":server["revision"],"confirmed":true});
    let key=s.key();
    let endpoint=format!("{}/oauth/refresh",path(&server));
    for _ in 0..2 {
        let r=s.raw(Method::POST,&endpoint,Some(body.clone()),Some(&key),None).await;
        assert_eq!(r.json::<Value>().await.unwrap()["status"],"unknown");
    }
    assert_eq!(f.issuer.tokens.load(Ordering::SeqCst),3);
    let server=current(&s,server["id"].as_str().unwrap()).await;
    assert_eq!(s.post(&endpoint,json!({"expected_revision":server["revision"],"confirmed":true})).await.0,StatusCode::CONFLICT);
    s.restart().await;
    let r=s.raw(Method::POST,&endpoint,Some(body),Some(&key),None).await;
    assert_eq!(r.json::<Value>().await.unwrap()["status"],"unknown");
    assert_eq!(f.issuer.tokens.load(Ordering::SeqCst),3);
    assert_eq!(s.get(&format!("{}/oauth",path(&server))).await.1["credential"]["usable"],false);
}

#[tokio::test]
async fn cancellation_during_exchange_and_shutdown_never_activate_late_credentials() {
    let mut s=TestServer::start().await;
    let f=Fixture::start().await;
    let server=registered(&s,&f).await;
    let (_,callback)=begin(&s,&server).await;
    f.issuer.mode.store(2,Ordering::SeqCst);
    let client=s.client.clone();
    let url=format!("{}{}/oauth/complete",s.base,path(&server));
    let token=s.token.clone();
    let request=tokio::spawn(async move { client.post(url).bearer_auth(token).header("idempotency-key","cancel-exchange").json(&callback).send().await.unwrap().json::<Value>().await.unwrap() });
    f.issuer.entered.notified().await;
    let status=s.get(&format!("{}/oauth",path(&server))).await.1;
    let (_,busy)=s.send(Method::PUT,&path(&server),json!({"expected_revision":status["revision"],"server":{
        "name":"oauth-fixture","enabled":true,"config":server["config"]}})).await;
    assert_eq!(busy["error"]["code"],"busy");
    assert_eq!(s.post(&format!("{}/oauth/cancel",path(&server)),json!({"expected_revision":status["revision"],"attempt_id":status["attempt"]["id"]})).await.0,StatusCode::OK);
    f.issuer.finish.notify_one();
    assert_eq!(request.await.unwrap()["status"],"unknown");
    assert!(s.get(&format!("{}/oauth",path(&server))).await.1["credential"].is_null());
    let server=current(&s,server["id"].as_str().unwrap()).await;
    let (_,callback)=begin(&s,&server).await;
    let client=s.client.clone();let token=s.token.clone();let url=format!("{}{}/oauth/complete",s.base,path(&server));
    let request=tokio::spawn(async move { client.post(url).bearer_auth(token).header("idempotency-key","shutdown-exchange").json(&callback).send().await });
    f.issuer.entered.notified().await;
    s.restart().await;
    let _ = request.await.unwrap(); // shutdown 후 HTTP 연결 자체는 종료될 수 있다.
    f.issuer.finish.notify_one();
    let status=s.get(&format!("{}/oauth",path(&server))).await.1;
    assert_eq!(status["attempt"]["status"],"unknown");
    assert!(status["credential"].is_null());
    assert_eq!(f.issuer.tokens.load(Ordering::SeqCst),2);
}

#[tokio::test]
async fn metadata_redirect_errors_revision_changes_and_client_secret_protection() {
    let s=TestServer::start().await;
    let f=Fixture::start().await;
    let server=registered(&s,&f).await;
    f.issuer.mode.store(6,Ordering::SeqCst);
    assert_eq!(s.post(&format!("{}/oauth/connect",path(&server)),json!({"expected_revision":2,"confirmed":true})).await.0,StatusCode::CONFLICT);
    assert_eq!(f.issuer.tokens.load(Ordering::SeqCst),0);
    f.issuer.mode.store(0,Ordering::SeqCst);
    let (_,callback)=begin(&s,&server).await;
    let (_,secret)=s.post("/api/v1/secrets",json!({"label":"preregistered client secret","value":"synthetic-client-secret"})).await;
    let mut cfg=server["config"].clone();
    cfg["oauth"]["client_secret_id"]=secret["id"].clone();
    let (st,server)=s.send(Method::PUT,&path(&server),json!({"expected_revision":2,"server":{"name":"oauth-fixture","enabled":true,"config":cfg}})).await;
    assert_eq!(st,StatusCode::OK);
    assert_eq!(s.post(&format!("{}/oauth/complete",path(&server)),callback).await.0,StatusCode::CONFLICT);
    assert_eq!(s.send(Method::DELETE,&format!("/api/v1/secrets/{}",secret["id"].as_str().unwrap()),Value::Null).await.0,StatusCode::CONFLICT);
    let (_,callback)=begin(&s,&server).await;
    let (st,server)=s.send(Method::PUT,&format!("/api/v1/secrets/{}",secret["id"].as_str().unwrap()),json!({"label":"preregistered client secret","value":"synthetic-new-client-secret"})).await;
    assert_eq!(st,StatusCode::OK,"{server}");
    *f.issuer.client_secret.lock().unwrap()=Some("synthetic-new-client-secret".into());
    let server=s.get("/api/v1/mcp/servers").await.1[0].clone();
    assert_eq!(s.post(&format!("{}/oauth/complete",path(&server)),callback).await.0,StatusCode::CONFLICT);
    for mode in [3,4,5] {
        f.issuer.mode.store(mode,Ordering::SeqCst);
        let server=current(&s,server["id"].as_str().unwrap()).await;
        let (_,callback)=begin(&s,&server).await;
        let (_,result)=s.post(&format!("{}/oauth/complete",path(&server)),callback).await;
        assert_eq!(result["status"],if mode==3 {"failed"} else {"unknown"});
        assert!(!result.to_string().contains(ACCESS));
    }
    let callback=s.client.get(format!("{}/api/mcp-oauth/callback/unused?code=not-reflected&state=not-reflected",s.base))
        .header("sec-fetch-site","cross-site").send().await.unwrap();
    assert_eq!(callback.status(),StatusCode::OK);
    assert_eq!(callback.headers()["referrer-policy"],"no-referrer");
    assert!(callback.headers()["content-security-policy"].to_str().unwrap().contains("default-src 'none'"));
    assert!(!callback.text().await.unwrap().contains("not-reflected"));
}

#[tokio::test]
async fn timeout_is_unknown_and_same_key_never_redeems_again() {
    let s=TestServer::start().await;
    let f=Fixture::start().await;
    let server=registered(&s,&f).await;
    let (_,callback)=begin(&s,&server).await;
    f.issuer.mode.store(2,Ordering::SeqCst);
    let key=s.key();
    let endpoint=format!("{}/oauth/complete",path(&server));
    let response=tokio::time::timeout(std::time::Duration::from_secs(20),
        s.raw(Method::POST,&endpoint,Some(callback.clone()),Some(&key),None)).await.unwrap();
    assert_eq!(response.json::<Value>().await.unwrap()["status"],"unknown");
    f.issuer.finish.notify_one();
    let replay=s.raw(Method::POST,&endpoint,Some(callback),Some(&key),None).await;
    assert_eq!(replay.headers()["idempotent-replayed"],"true");
    assert_eq!(replay.json::<Value>().await.unwrap()["status"],"unknown");
    assert_eq!(f.issuer.tokens.load(Ordering::SeqCst),1);
    assert!(s.get(&format!("{}/oauth",path(&server))).await.1["credential"].is_null());
}

#[tokio::test]
async fn callback_reuse_cross_server_binding_concurrent_refresh_and_expired_access() {
    let s=TestServer::start().await;
    let f=Fixture::start().await;
    let server=registered(&s,&f).await;
    let (start,callback)=begin(&s,&server).await;
    let (st,other)=s.post("/api/v1/mcp/servers",json!({"name":"other","enabled":true,"config":server["config"]})).await;
    assert_eq!(st,StatusCode::CREATED);
    let mut wrong=callback.clone();wrong["expected_revision"]=other["revision"].clone();
    assert_eq!(s.post(&format!("{}/oauth/complete",path(&other)),wrong).await.0,StatusCode::CONFLICT);
    assert_eq!(f.issuer.tokens.load(Ordering::SeqCst),0);
    let key=s.key();
    let endpoint=format!("{}/oauth/complete",path(&server));
    for _ in 0..2 {
        let r=s.raw(Method::POST,&endpoint,Some(callback.clone()),Some(&key),None).await;
        assert_eq!(r.json::<Value>().await.unwrap()["status"],"completed");
    }
    assert_eq!(f.issuer.tokens.load(Ordering::SeqCst),1);
    let server=current(&s,server["id"].as_str().unwrap()).await;
    let mut reused=callback;reused["expected_revision"]=server["revision"].clone();
    assert_eq!(s.post(&endpoint,reused).await.0,StatusCode::CONFLICT);
    assert_eq!(s.post(&format!("{}/oauth/cancel",path(&server)),json!({"expected_revision":server["revision"],"attempt_id":start["attempt_id"]})).await.0,StatusCode::CONFLICT);
    s.server.as_ref().unwrap().app.db.call(|c| {
        c.execute("UPDATE mcp_oauth_credentials SET expires_at='2000-01-01T00:00:00Z'",[])?;Ok(())
    }).await.unwrap();
    let (_,check)=s.post(&format!("{}/check",path(&server)),json!({"expected_revision":server["revision"],"confirmed":true})).await;
    assert_eq!(check["status"],"failed");
    assert_eq!(check["detail"]["error"]["code"],"mcp_auth_expired");
    f.issuer.mode.store(2,Ordering::SeqCst);
    // 이전 교환의 notify permit은 이미 발급됐으므로 소비한다.
    f.issuer.entered.notified().await;
    let client=s.client.clone();let token=s.token.clone();let url=format!("{}{}/oauth/refresh",s.base,path(&server));
    let body=json!({"expected_revision":server["revision"],"confirmed":true});
    let request=tokio::spawn(async move { client.post(url).bearer_auth(token).header("idempotency-key","serialized-refresh")
        .json(&body).send().await.unwrap().json::<Value>().await.unwrap() });
    f.issuer.entered.notified().await;
    let status=s.get(&format!("{}/oauth",path(&server))).await.1;
    let (_,busy)=s.post(&format!("{}/oauth/refresh",path(&server)),json!({"expected_revision":status["revision"],"confirmed":true})).await;
    assert_eq!(busy["error"]["code"],"busy");
    f.issuer.finish.notify_one();
    assert_eq!(request.await.unwrap()["status"],"completed");
    assert_eq!(f.issuer.tokens.load(Ordering::SeqCst),2);
}

#[tokio::test]
async fn enabling_same_registered_config_preserves_tokens_but_endpoint_changes_invalidate_them() {
    let s=TestServer::start().await;
    let f=Fixture::start().await;
    let server=registered(&s,&f).await;
    let (st,disabled)=s.send(Method::PUT,&path(&server),json!({"expected_revision":server["revision"],"server":{
        "name":"oauth-fixture","enabled":false,"config":server["config"]}})).await;
    assert_eq!(st,StatusCode::OK);
    let connected=completed(&s,&f,&disabled).await;
    let (st,enabled)=s.send(Method::PUT,&path(&connected),json!({"expected_revision":connected["revision"],"server":{
        "name":"oauth-fixture","enabled":true,"config":connected["config"]}})).await;
    assert_eq!(st,StatusCode::OK);
    assert_eq!(s.get(&format!("{}/oauth",path(&enabled))).await.1["credential"]["usable"],true);
    check(&s,&enabled).await;
    let mut config=enabled["config"].clone();
    config["endpoint"]=json!(format!("{}/other-resource",f.issuer.base));
    let (st,changed)=s.send(Method::PUT,&path(&enabled),json!({"expected_revision":enabled["revision"],"server":{
        "name":"oauth-fixture","enabled":true,"config":config}})).await;
    assert_eq!(st,StatusCode::OK);
    assert!(s.get(&format!("{}/oauth",path(&changed))).await.1["credential"].is_null());
    assert_eq!(f.issuer.tokens.load(Ordering::SeqCst),1);
}
