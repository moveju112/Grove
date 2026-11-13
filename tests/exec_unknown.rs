//! ONCE-008: 실제 단발 CLI의 MCP 부작용 후 응답 유실과 읽기 전용 재조회.
//! /proc 조회는 이 시험이 띄운 CLI의 loopback listener만 식별한다.
#![cfg(target_os = "linux")]

mod common;

use axum::{Json, Router, body::Body, extract::State, response::{IntoResponse, Response}, routing::post};
use common::fixture::{self, Fixture, Step};
use reqwest::{Client, Method, StatusCode};
use serde_json::{Value, json};
use std::{collections::{BTreeMap, HashSet}, io::Write, path::{Path, PathBuf}, process::Stdio, sync::{Arc, atomic::{AtomicUsize, Ordering}}, time::Duration};
use tokio::sync::{Notify, watch};

const PRIVATE: &str = "exec-unknown-private-canary";

#[derive(Clone)]
struct Remote {
    marker: PathBuf,
    calls: Arc<AtomicUsize>,
    invoked: Arc<Notify>,
    lose_reply: watch::Receiver<bool>,
}

async fn rpc(State(remote): State<Remote>, Json(q): Json<Value>) -> Response {
    let result = match q["method"].as_str().unwrap() {
        "initialize" => json!({
            "protocolVersion": "2025-06-18",
            "serverInfo": { "name": "exec-fixture", "version": "1" },
            "capabilities": { "tools": {} },
        }),
        "notifications/initialized" | "notifications/cancelled" => return StatusCode::ACCEPTED.into_response(),
        "tools/list" => json!({ "tools": [{
            "name": "mark", "description": "Append one owned disposable marker",
            "inputSchema": { "type": "object" },
        }] }),
        "tools/call" => {
            assert_eq!(q["params"]["name"], "mark");
            remote.calls.fetch_add(1, Ordering::SeqCst);
            let mut marker = std::fs::OpenOptions::new().create(true).append(true).open(&remote.marker).unwrap();
            marker.write_all(b"invoked\n").unwrap();
            marker.sync_all().unwrap();
            remote.invoked.notify_one();
            // 부작용은 끝났지만 확정 JSON-RPC 응답은 없다. HTTP 오류가 아니라
            // 200 응답 본문을 일부 보낸 뒤 실제 transport를 끊는다.
            let partial = format!("{{\"private\":\"{PRIVATE}\",\"path\":\"{}\",", remote.marker.display());
            let stream = futures_util::stream::unfold((0, remote.lose_reply.clone(), partial), |(stage, mut gate, partial)| async move {
                match stage {
                    0 => Some((Ok(bytes::Bytes::from(partial)), (1, gate, String::new()))),
                    1 => {
                        gate.wait_for(|v| *v).await.unwrap();
                        Some((Err(std::io::Error::new(std::io::ErrorKind::ConnectionReset, PRIVATE)), (2, gate, String::new())))
                    }
                    _ => None,
                }
            });
            return ([( "content-type", "application/json")], Body::from_stream(stream)).into_response();
        }
        method => panic!("unexpected fixture method: {method}"),
    };
    Json(json!({ "jsonrpc": "2.0", "id": q["id"], "result": result })).into_response()
}

struct RemoteServer {
    state: Remote,
    endpoint: String,
    task: tokio::task::JoinHandle<()>,
}

impl RemoteServer {
    async fn start(marker: PathBuf, lose_reply: watch::Receiver<bool>) -> Self {
        let state = Remote { marker, calls: Arc::default(), invoked: Arc::default(), lose_reply };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
        let router = Router::new().route("/mcp", post(rpc)).with_state(state.clone());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap(); });
        Self { state, endpoint, task }
    }
}

impl Drop for RemoteServer {
    fn drop(&mut self) { self.task.abort(); }
}

struct Api {
    client: Client,
    base: String,
    token: String,
}

impl Api {
    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Value {
        let mut request = self.client.request(method.clone(), format!("{}{path}", self.base)).bearer_auth(&self.token);
        if method != Method::GET {
            request = request.header("Idempotency-Key", grove::util::new_id());
        }
        if let Some(body) = body { request = request.json(&body); }
        let response = request.send().await.unwrap();
        assert!(response.status().is_success(), "fixture API status: {}", response.status());
        response.json().await.unwrap()
    }
}

fn cli(project: &Path, run: &Path, model: &Fixture) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_grove"));
    command.arg("exec").args(["--base-url", &model.base, "--model", "fixture-model", "--prompt", PRIVATE,
        "--tools", "--allow-tool", "mcp_call", "--api-key-env", "EXEC_UNKNOWN_TEST_KEY"])
        .arg("--project").arg(project).arg("--run-dir").arg(run)
        .env("EXEC_UNKNOWN_TEST_KEY", PRIVATE).env("GROVE_DATA_DIR", run.with_extension("personal"))
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    command
}

// 문서화된 exec 서버 주소 옵션을 추가하지 않는다. 시작과 모델 접수가 끝난
// 소유 CLI의 socket inode만 대조하며 다른 프로세스·서비스를 탐색/접속하지 않는다.
fn owned_listener(pid: u32) -> String {
    let sockets: HashSet<String> = std::fs::read_dir(format!("/proc/{pid}/fd")).unwrap()
        .filter_map(|entry| match std::fs::read_link(entry.unwrap().path()) {
            Ok(link) => Some(link.to_string_lossy().into_owned()),
            // listener는 유지되지만 동시에 닫힌 outbound fd는 snapshot에서 빠진다.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => panic!("owned CLI fd inspection: {error}"),
        })
        .filter_map(|link| link.strip_prefix("socket:[").and_then(|s| s.strip_suffix(']')).map(str::to_string))
        .collect();
    let tcp = std::fs::read_to_string(format!("/proc/{pid}/net/tcp")).unwrap();
    let listeners: Vec<_> = tcp.lines().skip(1).filter_map(|line| {
        let columns: Vec<_> = line.split_whitespace().collect();
        if columns[3] != "0A" || !sockets.contains(columns[9]) { return None; }
        let (address, port) = columns[1].split_once(':').unwrap();
        assert_eq!(address, "0100007F", "owned listener must be loopback");
        Some(format!("http://127.0.0.1:{}", u16::from_str_radix(port, 16).unwrap()))
    }).collect();
    assert_eq!(listeners.len(), 1, "exactly one owned exec listener");
    listeners[0].clone()
}

fn snapshot(root: &Path) -> BTreeMap<PathBuf, String> {
    fn visit(root: &Path, path: &Path, files: &mut BTreeMap<PathBuf, String>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                visit(root, &entry.path(), files);
            } else {
                files.insert(entry.path().strip_prefix(root).unwrap().to_path_buf(), common::file_sha(&entry.path()));
            }
        }
    }
    let mut files = BTreeMap::new();
    visit(root, root, &mut files);
    files
}

async fn show_repeatedly(run: &Path, receipt: &Value) {
    let before = snapshot(run);
    for _ in 0..3 {
        let output = tokio::time::timeout(Duration::from_secs(10),
            tokio::process::Command::new(env!("CARGO_BIN_EXE_grove"))
                .args(["exec", "show"]).arg(run).env_remove("EXEC_UNKNOWN_TEST_KEY")
                .env("GROVE_DATA_DIR", run.with_extension("personal")).kill_on_drop(true).output()
        ).await.unwrap().unwrap();
        assert_eq!(output.status.code(), Some(7));
        assert_eq!(serde_json::from_slice::<Value>(&output.stdout).unwrap(), *receipt);
        assert!(output.stderr.is_empty());
    }
    assert_eq!(snapshot(run), before, "show neither changes nor deletes retained artifacts");
}

#[tokio::test]
async fn lost_in_flight_tool_response_is_unknown_and_retained_results_never_reexecute() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let run = dir.path().join("run");
    let marker = project.join("effects.txt");
    let (lose_reply, gate) = watch::channel(false);
    let remote = RemoteServer::start(marker.clone(), gate).await;
    let model = Fixture::start().await;
    // CLI의 첫 실제 모델 요청을 보류한 상태에서 자기 서버의 공개 API로만
    // MCP를 등록한다. DB seed나 runner/승인 우회는 하지 않는다.
    let (release, gate) = watch::channel(false);
    let Step::Frames(frames, _) = fixture::tool_calls(&[("catalog", "mcp_tools", json!({}))]) else { unreachable!() };
    model.push(Step::Gated(frames, gate));
    let child = cli(&project, &run, &model).spawn().unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        while model.requests().is_empty() { tokio::time::sleep(Duration::from_millis(20)).await; }
    }).await.expect("CLI model request");
    let api = Api {
        client: Client::new(), base: owned_listener(child.id().unwrap()),
        token: std::fs::read_to_string(run.join("data/owner-token")).unwrap().trim().into(),
    };
    let server = api.call(Method::POST, "/api/v1/mcp/servers", Some(json!({
        "name": "exec-fixture", "enabled": true, "timeout_secs": 30,
        "config": { "transport": "http", "endpoint": remote.endpoint },
    }))).await;
    let check = api.call(Method::POST, &format!("/api/v1/mcp/servers/{}/check", server["id"].as_str().unwrap()),
        Some(json!({ "expected_revision": server["revision"], "confirmed": true }))).await;
    assert_eq!(check["status"], "ready");
    assert_eq!(remote.state.calls.load(Ordering::SeqCst), 0, "connection check never invokes the tool");
    model.push(fixture::tool_calls(&[("mutation", "mcp_call", json!({
        "server_id": server["id"], "tool": "exec-fixture/mark", "arguments": {},
    }))]));
    // 모델이 성공처럼 답해도 도구 unknown을 성공으로 바꾸면 안 된다.
    model.push(fixture::text("model says done"));
    release.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(15), remote.state.invoked.notified()).await.expect("actual MCP invocation");
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "invoked\n");
    assert_eq!(remote.state.calls.load(Ordering::SeqCst), 1);
    assert!(!run.join("result.json").exists(), "no receipt while invocation is in flight");
    let db = rusqlite::Connection::open_with_flags(run.join("data/grove.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let (call_id, turn_id): (String, String) = db.query_row(
        "SELECT id,turn_id FROM tool_calls WHERE name='mcp_call' AND status='running'",
        [], |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap();
    drop(db);
    let running = api.call(Method::GET, &format!("/api/v1/tool-calls/{call_id}"), None).await;
    assert_eq!(running["status"], "running");
    assert_eq!(running["approval_scope"], "policy");
    // 위의 부작용·running 관측을 근거로 응답을 실제로 끊는다.
    lose_reply.send(true).unwrap();
    let output = tokio::time::timeout(Duration::from_secs(20), child.wait_with_output()).await.expect("CLI ends after response loss").unwrap();
    assert_eq!(output.status.code(), Some(7), "{}", String::from_utf8_lossy(&output.stderr));
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["schema"], "grove.exec.v1");
    assert_eq!(receipt["status"], "unknown");
    assert_eq!(receipt["exit_code"], 7);
    assert_eq!(receipt["turn_id"], turn_id);
    assert_eq!(receipt["run_dir"], run.to_string_lossy().as_ref());
    let run_id = receipt["run_id"].as_str().unwrap();
    assert!(!run_id.is_empty() && run_id != turn_id);
    assert_eq!(receipt["tool_calls"], json!([
        { "name": "mcp_tools", "status": "succeeded", "approval_scope": null },
        { "name": "mcp_call", "status": "unknown", "approval_scope": "policy" },
    ]));
    assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(run.join("result.json")).unwrap()).unwrap(), receipt);
    assert!(run.join("data/grove.db").exists());
    assert!(!run.with_extension("personal").exists());
    for forbidden in [PRIVATE, marker.to_str().unwrap(), project.to_str().unwrap()] {
        assert!(!receipt.to_string().contains(forbidden), "receipt must not expose private input or tool paths");
        assert!(!String::from_utf8_lossy(&output.stderr).contains(forbidden), "stderr redaction");
    }
    assert_eq!(model.requests().len(), 3);
    assert_eq!(remote.state.calls.load(Ordering::SeqCst), 1);
    show_repeatedly(&run, &receipt).await;
    let before_restart = snapshot(&run);
    let repeat = cli(&project, &run, &model).output().await.unwrap();
    assert_eq!(repeat.status.code(), Some(2), "nonempty run cannot be submitted again");
    assert_eq!(snapshot(&run), before_restart);

    // 보존된 자기 run만 실제 서버 코어로 재시작해 결과와 승인 기록을 조회한다.
    let restarted = grove::server::start(common::config(&run.join("data")), Arc::new(grove::util::SystemClock)).await.unwrap();
    let api = Api { client: Client::new(), base: format!("http://{}", restarted.addr), token: restarted.owner_token.clone() };
    let call = api.call(Method::GET, &format!("/api/v1/tool-calls/{call_id}"), None).await;
    assert_eq!(call["status"], "unknown");
    assert_eq!(call["result"]["error"]["code"], "result_unknown");
    assert_eq!(call["approval_scope"], "policy");
    assert_eq!(call["revision"].as_i64().unwrap(), running["revision"].as_i64().unwrap() + 1, "only one terminal transition");
    let turn = api.call(Method::GET, &format!("/api/v1/turns/{turn_id}"), None).await;
    assert_eq!(turn["status"], "completed", "tool unknown outranks a completed turn in CLI output");
    assert_eq!(turn["tool_calls"].as_array().unwrap().len(), 2);
    for _ in 0..3 {
        assert_eq!(api.call(Method::GET, &format!("/api/v1/tool-calls/{call_id}"), None).await, call);
    }
    restarted.stop().await;
    show_repeatedly(&run, &receipt).await;
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "invoked\n");
    assert_eq!(remote.state.calls.load(Ordering::SeqCst), 1, "lookup/restart never repeats side effects");
    assert_eq!(model.requests().len(), 3, "lookup/restart never calls the model");
    assert!(!run.with_extension("personal").exists());
}
