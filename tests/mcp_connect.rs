mod common;

use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response, Sse, sse::Event};
use axum::routing::{get, post};
use common::TestServer;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

const SECRET: &str = "Bearer fixture-mcp-check-private";
#[derive(Clone, Copy, PartialEq)]
enum Mode { Json, Sse, Legacy, ForeignEndpoint, Auth, BadVersion, BadId, RpcError, Duplicate, SchemaBad, RepeatedCursor, Redirect, Hang }
#[derive(Clone)]
struct Remote {
    mode: Mode,
    requests: Arc<Mutex<Vec<(HeaderMap,Value)>>>,
    channel: Arc<Mutex<Option<mpsc::Sender<Result<Event,Infallible>>>>>,
    deletes: Arc<Mutex<usize>>,
}
struct Fixture {
    base: String,
    state: Remote,
    task: tokio::task::JoinHandle<()>,
}
impl Fixture {
    async fn start(mode: Mode) -> Self {
        let state = Remote { mode, requests: Arc::default(), channel: Arc::default(), deletes: Arc::default() };
        let router = axum::Router::new().route("/mcp",get(legacy).post(rpc).delete(end)).route("/messages",post(rpc)).with_state(state.clone());
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}",socket.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(socket,router).await.unwrap(); });
        Self { base,state,task }
    }
}
impl Drop for Fixture { fn drop(&mut self) { self.task.abort(); } }

async fn legacy(State(s): State<Remote>) -> Response {
    let (tx,rx) = mpsc::channel(16);
    tx.send(Ok(Event::default().event("endpoint").data(if s.mode==Mode::ForeignEndpoint { "http://127.0.0.1:1/steal" } else { "/messages?session=fixture" }))).await.unwrap();
    *s.channel.lock().unwrap() = Some(tx);
    Sse::new(ReceiverStream::new(rx)).into_response()
}
async fn end(State(s): State<Remote>) -> StatusCode {
    *s.deletes.lock().unwrap() += 1;
    StatusCode::OK
}
async fn rpc(State(s): State<Remote>, headers: HeaderMap, Json(q): Json<Value>) -> Response {
    s.requests.lock().unwrap().push((headers,q.clone()));
    if s.mode == Mode::Auth { return StatusCode::UNAUTHORIZED.into_response(); }
    if s.mode == Mode::Redirect { return (StatusCode::TEMPORARY_REDIRECT,[("location","http://127.0.0.1:1/steal")]).into_response(); }
    if s.mode == Mode::Hang { return std::future::pending().await; }
    let method = q["method"].as_str().unwrap_or("");
    if method.is_empty() || method == "notifications/initialized" || method == "notifications/cancelled" { return StatusCode::ACCEPTED.into_response(); }
    let result = match method {
        "initialize" => json!({
            "protocolVersion": if s.mode == Mode::BadVersion { "2099-01-01" } else if s.mode==Mode::Legacy { "2024-11-05" } else { "2025-06-18" },
            "serverInfo": { "name": SECRET, "version": "fixture" }, "capabilities": { "tools": { "listChanged": true } },
        }),
        "tools/list" => {
            let second = q["params"]["cursor"] == "next";
            let name = if !second || s.mode == Mode::Duplicate { "read" } else { "write" };
            let mut result = json!({ "tools": [{
                "name": name, "description": "fixture-mcp-check-private",
                "inputSchema": { "type": if s.mode == Mode::SchemaBad { "array" } else { "object" } },
                "annotations": { "readOnlyHint": true },
            }] });
            if !second || s.mode == Mode::RepeatedCursor { result["nextCursor"] = json!("next"); }
            result
        }
        _ => panic!("unexpected remote method"),
    };
    let mut response = json!({ "jsonrpc": "2.0", "id": if s.mode == Mode::BadId { json!(9000) } else { q["id"].clone() }, "result": result });
    if s.mode == Mode::RpcError {
        response.as_object_mut().unwrap().remove("result");
        response["error"] = json!({ "code": -32603, "message": SECRET, "data": SECRET });
    }
    if s.mode == Mode::Legacy {
        let tx = s.channel.lock().unwrap().as_ref().unwrap().clone();
        tx.send(Ok(Event::default().event("message").data(response.to_string()))).await.unwrap();
        StatusCode::ACCEPTED.into_response()
    } else if s.mode == Mode::Sse {
        let stream = format!("data: {}\n\ndata: {}\n\n",
            json!({ "jsonrpc": "2.0", "id": "server-ping", "method": "ping" }), response);
        let chunks = stream.into_bytes().into_iter().map(|b| Ok::<_,Infallible>(bytes::Bytes::from(vec![b])));
        ([( "content-type","text/event-stream"),("mcp-session-id","fixture-session")],
            Body::from_stream(tokio_stream::iter(chunks))).into_response()
    } else {
        ([("mcp-session-id","fixture-session")],Json(response)).into_response()
    }
}

async fn register(s: &TestServer, config: Value, timeout: i64) -> Value {
    let (status,server) = s.post("/api/v1/mcp/servers",json!({ "name": "fixture", "config": config, "timeout_secs": timeout })).await;
    assert_eq!(status,StatusCode::CREATED,"{server}");
    server
}
async fn check(s: &TestServer, server: &Value, key: &str) -> Value {
    let path = format!("/api/v1/mcp/servers/{}/check",server["id"].as_str().unwrap());
    let response = s.raw(Method::POST,&path,Some(json!({ "expected_revision": server["revision"], "confirmed": true })),Some(key),None).await;
    assert_eq!(response.status(),StatusCode::OK);
    response.json().await.unwrap()
}

#[tokio::test]
async fn http_json_sse_and_legacy_negotiate_page_namespace_and_close_without_executing_tools() {
    for mode in [Mode::Json,Mode::Sse,Mode::Legacy] {
        let s = TestServer::start().await;
        let f = Fixture::start(mode).await;
        let (_,secret) = s.post("/api/v1/secrets",json!({ "label": "remote", "value": SECRET })).await;
        let server = register(&s,json!({ "transport": if mode==Mode::Legacy { "sse" } else { "http" },
            "endpoint": format!("{}/mcp",f.base), "header_secrets": { "Authorization": secret["id"] } }),5).await;
        let key = s.key();
        let result = check(&s,&server,&key).await;
        assert_eq!(result["status"],"ready","{result}");
        assert_eq!(result["detail"]["protocol_version"],if mode==Mode::Legacy { "2024-11-05" } else { "2025-06-18" });
        assert_eq!(result["detail"]["tool_count"],2);
        assert_eq!(result["detail"]["tools"][0]["namespace"],"fixture/read");
        assert_eq!(result["detail"]["tools"][0]["callable"],false);
        assert!(!result.to_string().contains("fixture-mcp-check-private"));
        let before = f.state.requests.lock().unwrap().len();
        assert_eq!(check(&s,&server,&key).await,result);
        assert_eq!(f.state.requests.lock().unwrap().len(),before);
        let requests = f.state.requests.lock().unwrap();
        assert_eq!(requests[0].1["method"],"initialize");
        assert_eq!(requests[0].1["params"]["capabilities"],json!({}));
        let mut initialized=false;
        for (headers,q) in requests.iter() {
            initialized |= q["method"]=="notifications/initialized";
            assert_eq!(headers["authorization"],SECRET);
            assert_ne!(q["method"],"tools/call");
            if mode!=Mode::Legacy && q["method"]!="initialize" {
                assert_eq!(headers["mcp-session-id"],"fixture-session");
                if initialized { assert_eq!(headers["mcp-protocol-version"],"2025-06-18"); }
            }
        }
        assert_eq!(*f.state.deletes.lock().unwrap(),usize::from(mode!=Mode::Legacy));
        drop(requests);
        let list = s.get("/api/v1/mcp/servers").await.1;
        assert_eq!(list[0]["connection_state"],"disabled");
        assert_eq!(list[0]["last_check"]["status"],"ready");
        assert_eq!(s.get(&format!("/api/v1/mcp/servers/{}/check",server["id"].as_str().unwrap())).await.1["detail"],result["detail"]);
    }
}

#[tokio::test]
async fn legacy_endpoint_cannot_forward_secret_headers_to_another_origin() {
    let s=TestServer::start().await;
    let f=Fixture::start(Mode::ForeignEndpoint).await;
    let (_,secret)=s.post("/api/v1/secrets",json!({ "label":"legacy","value":SECRET })).await;
    let server=register(&s,json!({ "transport":"sse","endpoint":format!("{}/mcp",f.base),"header_secrets":{"Authorization":secret["id"]} }),1).await;
    let result=check(&s,&server,&s.key()).await;
    assert_eq!(result["detail"]["error"]["code"],"mcp_protocol","{result}");
    assert!(f.state.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn shutdown_interrupts_an_inflight_check_without_waiting_for_its_timeout() {
    let s=TestServer::start().await;
    let f=Fixture::start(Mode::Hang).await;
    let server=register(&s,json!({ "transport":"http","endpoint":format!("{}/mcp",f.base) }),60).await;
    let key=s.key();
    let request=check(&s,&server,&key);
    let shutdown=async {
        tokio::time::timeout(std::time::Duration::from_secs(3),async {
            loop {
                if !f.state.requests.lock().unwrap().is_empty() { break; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        s.server.as_ref().unwrap().app.shutdown_tx.send_replace(true);
    };
    let (result,())=tokio::time::timeout(std::time::Duration::from_secs(5),async { tokio::join!(request,shutdown) }).await.unwrap();
    assert_eq!(result["status"],"interrupted","{result}");
}

#[tokio::test]
async fn failed_final_commit_keeps_unknown_receipt_and_startup_never_repeats_the_probe() {
    let mut s=TestServer::start().await;
    let f=Fixture::start(Mode::Json).await;
    let server=register(&s,json!({ "transport":"http","endpoint":format!("{}/mcp",f.base) }),5).await;
    s.server.as_ref().unwrap().app.db.call(|c| {
        c.execute_batch("CREATE TRIGGER fail_mcp_finish BEFORE UPDATE ON mcp_checks WHEN NEW.status='ready' BEGIN SELECT RAISE(FAIL,'fixture mcp commit failure'); END;")?;
        Ok(())
    }).await.unwrap();
    let key=s.key();
    let path=format!("/api/v1/mcp/servers/{}/check",server["id"].as_str().unwrap());
    let body=json!({ "expected_revision":1,"confirmed":true });
    let response=s.raw(Method::POST,&path,Some(body.clone()),Some(&key),None).await;
    assert_eq!(response.status(),StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(s.get(&path).await.1["status"],"checking");
    let response=s.raw(Method::POST,&path,Some(body),Some(&key),None).await;
    assert_eq!(response.status(),StatusCode::CONFLICT);
    assert_eq!(response.json::<Value>().await.unwrap()["error"]["code"],"result_unknown");
    let before=f.state.requests.lock().unwrap().len();
    s.server.as_ref().unwrap().app.db.call(|c| { c.execute_batch("DROP TRIGGER fail_mcp_finish;")?; Ok(()) }).await.unwrap();
    s.restart().await;
    let result=check(&s,&server,&key).await;
    assert_eq!(result["status"],"interrupted");
    assert_eq!(f.state.requests.lock().unwrap().len(),before);
}

#[tokio::test]
async fn remote_protocol_auth_redirect_and_schema_errors_are_bounded_and_do_not_reflect_secrets() {
    for (mode,code) in [
        (Mode::Auth,"mcp_auth_required"),(Mode::BadVersion,"mcp_protocol"),(Mode::BadId,"mcp_protocol"),
        (Mode::RpcError,"mcp_rpc"),(Mode::Duplicate,"mcp_protocol"),(Mode::SchemaBad,"mcp_protocol"),
        (Mode::RepeatedCursor,"mcp_protocol"),(Mode::Redirect,"mcp_http"),(Mode::Hang,"mcp_timeout"),
    ] {
        let s = TestServer::start().await;
        let f = Fixture::start(mode).await;
        let server = register(&s,json!({ "transport": "http", "endpoint": format!("{}/mcp",f.base) }),1).await;
        let result = check(&s,&server,&s.key()).await;
        assert_eq!(result["status"],"failed","{result}");
        assert_eq!(result["detail"]["error"]["code"],code,"{result}");
        assert!(!result.to_string().contains(SECRET));
    }
}

#[tokio::test]
async fn checks_require_owner_confirmation_revision_and_busy_settings_preserve_secret_and_prior_values() {
    let s = TestServer::start().await;
    let f = Fixture::start(Mode::Hang).await;
    let (_,secret) = s.post("/api/v1/secrets",json!({ "label": "remote", "value": SECRET })).await;
    let server = register(&s,json!({ "transport":"http", "endpoint":format!("{}/mcp",f.base), "header_secrets": { "Authorization": secret["id"] } }),1).await;
    let path = format!("/api/v1/mcp/servers/{}/check",server["id"].as_str().unwrap());
    for (body,status) in [(json!({ "expected_revision":1,"confirmed":false }),StatusCode::BAD_REQUEST),
        (json!({ "expected_revision":2,"confirmed":true }),StatusCode::CONFLICT)] {
        assert_eq!(s.post(&path,body).await.0,status);
    }
    let (_,device) = s.post("/api/v1/devices",json!({ "name":"device" })).await;
    for method in [Method::POST,Method::GET] {
        assert_eq!(s.raw(method.clone(),&path,if method==Method::POST { Some(json!({ "expected_revision":1,"confirmed":true })) } else { None },
            Some(&s.key()),Some(device["token"].as_str().unwrap())).await.status(),StatusCode::FORBIDDEN);
    }
    let key=s.key();
    let request = s.raw(Method::POST,&path,Some(json!({ "expected_revision":1,"confirmed":true })),Some(&key),None);
    let observe = async {
        tokio::time::timeout(std::time::Duration::from_secs(3),async {
            loop {
                if s.get(&path).await.1["status"]=="checking" { break; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        let same=s.raw(Method::POST,&path,Some(json!({ "expected_revision":1,"confirmed":true })),Some(&key),None).await;
        assert_eq!(same.status(),StatusCode::CONFLICT);
        assert_eq!(same.json::<Value>().await.unwrap()["error"]["code"],"result_unknown");
        assert_eq!(s.post(&path,json!({ "expected_revision":1,"confirmed":true })).await.0,StatusCode::CONFLICT);
        let update=json!({ "expected_revision":1,"server":{ "name":"changed","config":server["config"] } });
        assert_eq!(s.send(Method::PUT,&path.trim_end_matches("/check"),update).await.0,StatusCode::CONFLICT);
        assert_eq!(s.send(Method::PUT,&format!("/api/v1/secrets/{}",secret["id"].as_str().unwrap()),
            json!({ "label":"remote","value":"Bearer replacement-fixture" })).await.0,StatusCode::CONFLICT);
        assert_eq!(s.get("/api/v1/admin/update-readiness").await.1["busy"]["running_mcp_checks"],1);
    };
    let (response,())=tokio::join!(request,observe);
    assert_eq!(response.status(),StatusCode::OK);
    let completed:Value=response.json().await.unwrap();
    assert_eq!(check(&s,&server,&key).await,completed);
    let changed=s.send(Method::PUT,&format!("/api/v1/secrets/{}",secret["id"].as_str().unwrap()),
        json!({ "label":"remote","value":"Bearer replacement-fixture" })).await;
    assert_eq!(changed.0,StatusCode::OK);
    let list=s.get("/api/v1/mcp/servers").await.1;
    assert_eq!(list[0]["revision"],2);
    assert!(list[0]["last_check"].is_null());
}

#[tokio::test]
async fn startup_marks_preaccepted_check_interrupted_and_replays_without_any_network() {
    let mut s=TestServer::start().await;
    let server=register(&s,json!({ "transport":"http","endpoint":"http://127.0.0.1:1/mcp" }),1).await;
    let id=server["id"].as_str().unwrap().to_string();
    let key=s.key();
    let hash=grove::idem::body_hash("mcp.check",&json!({ "id":id,"revision":1 }));
    let check_id=grove::util::new_id();
    let owner=s.server.as_ref().unwrap().app.db.call(|c| Ok(c.query_row("SELECT id FROM tokens WHERE kind='owner'",[],|r|r.get::<_,String>(0))?)).await.unwrap();
    s.stop().await;
    {
        let c=rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
        c.execute("INSERT INTO mcp_checks(server_id,id,status,started_at,owner_id,idem_key,request_hash) VALUES(?1,?2,'checking','t',?3,?4,?5)",
            rusqlite::params![id,check_id,owner,key,hash]).unwrap();
        c.execute("INSERT INTO idempotency(owner_id,key,request_hash,status,response,created_at) VALUES(?1,?2,?3,409,?4,'t')",
            rusqlite::params![owner,key,hash,json!({ "error":{"code":"result_unknown"},"check_id":check_id }).to_string()]).unwrap();
    }
    s.restart().await;
    let result=check(&s,&server,&key).await;
    assert_eq!(result["status"],"interrupted","{result}");
    assert_eq!(result["detail"]["error"]["code"],"mcp_interrupted");
}

#[cfg(target_os="linux")]
const STDIO_FIXTURE:&str=r#"
import json, os, sys, subprocess, time
mode, marker = sys.argv[1:3]
child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(60)"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
with open(marker,"a") as f:
    f.write(json.dumps({"pid":os.getpid(),"child":child.pid,"cwd":os.getcwd(),"env":list(os.environ),"has_token":bool(os.getenv("TOKEN"))})+"\n")
for line in sys.stdin:
    q=json.loads(line)
    method=q.get("method")
    if method=="initialize":
        if mode=="hang": time.sleep(60)
        if mode=="crash": sys.exit(1)
        if mode=="large":
            print("x"*(1024*1024+1),flush=True)
            continue
        result={"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}
    elif method=="tools/list":
        result={"tools":[{"name":"read","description":os.getenv("TOKEN",""),"inputSchema":{"type":"object"}}]}
    else: continue
    print(json.dumps({"jsonrpc":"2.0","id":q["id"],"result":result}),flush=True)
"#;

#[cfg(target_os="linux")]
#[tokio::test]
async fn stdio_handles_success_crash_timeout_and_size_limit_and_always_reaps_its_owned_tree() {
    for (mode,status,code) in [("ok","ready",None),("crash","failed",Some("mcp_transport")),
        ("hang","failed",Some("mcp_timeout")),("large","failed",Some("mcp_limit"))] {
        let s=TestServer::start().await;
        let script=s.dir.path().join("mcp_fixture.py");
        let marker=s.dir.path().join("launches.jsonl");
        std::fs::write(&script,STDIO_FIXTURE).unwrap();
        let (_,secret)=s.post("/api/v1/secrets",json!({ "label":"stdio","value":SECRET })).await;
        let server=register(&s,json!({ "transport":"stdio","command":"python3","args":[script,mode,marker],"env_secrets":{"TOKEN":secret["id"]} }),1).await;
        let key=s.key();
        let result=check(&s,&server,&key).await;
        assert_eq!(result["status"],status,"{result}");
        if let Some(code)=code { assert_eq!(result["detail"]["error"]["code"],code,"{result}"); }
        assert!(!result.to_string().contains(SECRET));
        assert_eq!(check(&s,&server,&key).await,result);
        let records=std::fs::read_to_string(&marker).unwrap();
        assert_eq!(records.lines().count(),1);
        let record:Value=serde_json::from_str(records.lines().next().unwrap()).unwrap();
        assert_eq!(record["has_token"],true);
        for name in record["env"].as_array().unwrap() {
            let name=name.as_str().unwrap();
            assert!(["PATH","HOME","USERPROFILE","SystemRoot","COMSPEC","TEMP","TMP","TMPDIR","TOKEN","GROVE_TASK_ID","LC_CTYPE"].contains(&name),"unexpected inherited environment key");
        }
        assert!(!std::path::Path::new(record["cwd"].as_str().unwrap()).exists());
        tokio::time::timeout(std::time::Duration::from_secs(3),async {
            loop {
                let alive=|pid:&Value| std::fs::read_to_string(format!("/proc/{}/stat",pid.as_u64().unwrap())).ok()
                    .is_some_and(|s|s.rsplit_once(')').is_some_and(|(_,s)|s.split_whitespace().next()!=Some("Z")));
                if !alive(&record["pid"]) && !alive(&record["child"]) { break; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
    }
}
