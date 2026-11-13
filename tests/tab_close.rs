//! PC-005: 관찰 연결의 수명과 서버 작업의 수명을 분리한다. 실제 HTTP·WS·PTY와 로컬 모델 fixture를 쓴다.
#![cfg(unix)]
mod common;

use bytes::Bytes;
use common::fixture::{self, Fixture};
use common::*;
use futures_util::{SinkExt, Stream, StreamExt};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::path::Path;
use std::pin::Pin;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message as WsMsg;

struct Observer {
    stream: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
    buffer: Vec<u8>,
    frames: VecDeque<(String, Value)>,
    cursor: i64,
}

impl Observer {
    async fn open(s: &TestServer, sid: &str, cursor: Option<i64>) -> Self {
        let mut request = s.client.get(format!("{}/api/v1/events?sessions={sid}", s.base)).bearer_auth(&s.token);
        if let Some(cursor) = cursor {
            request = request.header("Last-Event-ID", cursor);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut observer = Self { stream: Box::pin(response.bytes_stream()), buffer: vec![], frames: VecDeque::new(), cursor: 0 };
        let hello = observer.until(|name, _| name == "hello").await;
        observer.cursor = hello["cursor"].as_i64().unwrap();
        observer
    }

    async fn until(&mut self, predicate: impl Fn(&str, &Value) -> bool) -> Value {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                while let Some((name, value)) = self.frames.pop_front() {
                    if name == "event" {
                        let seq = value["seq"].as_i64().unwrap();
                        assert!(seq > self.cursor, "영속 이벤트는 중복 없이 순서대로 복구한다");
                        self.cursor = seq;
                    }
                    assert_ne!(name, "resync", "유효한 cursor는 replay 경로를 사용한다");
                    if predicate(&name, &value) {
                        return value;
                    }
                }
                let chunk = self.stream.next().await.expect("SSE 연결 유지").expect("SSE 읽기");
                self.buffer.extend_from_slice(&chunk);
                while let Some(end) = self.buffer.windows(2).position(|w| w == b"\n\n") {
                    let frame = String::from_utf8(self.buffer.drain(..end + 2).collect()).unwrap();
                    let name = frame.lines().find_map(|l| l.strip_prefix("event:")).unwrap_or("message").trim().to_string();
                    if let Some(data) = frame.lines().find_map(|l| l.strip_prefix("data:")) {
                        self.frames.push_back((name, serde_json::from_str(data.trim()).unwrap()));
                    }
                }
            }
        }).await.expect("SSE 상태 대기 시간 초과")
    }
}

async fn setup() -> (TestServer, Fixture, String, Value, String) {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("tab-close").await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    (s, f, profile, project, session["id"].as_str().unwrap().to_string())
}

async fn start(s: &TestServer, sid: &str, profile: &str, tools: bool) -> String {
    let (status, body) = s.post(&format!("/api/v1/sessions/{sid}/turns"),
        json!({"text":"keep working without a browser", "profile_id":profile, "tools":tools})).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    body["turn"]["id"].as_str().unwrap().to_string()
}

async fn wait_file(path: &Path) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.expect("실제 프로세스의 표식 파일 대기");
}

#[tokio::test]
async fn dropping_sse_preserves_partial_and_explicit_cancel_still_works() {
    let (mut s, f, profile, _, sid) = setup().await;
    let mut observer = Observer::open(&s, &sid, None).await;
    f.push(fixture::hang_after("계속 실행 중"));
    let tid = start(&s, &sid, &profile, false).await;
    observer.until(|name, v| name == "partial" && v["snapshot"]["text"] == "계속 실행 중").await;
    let cursor = observer.cursor;
    drop(observer);

    assert_eq!(s.get(&format!("/api/v1/turns/{tid}")).await.1["status"], "running");
    let mut reopened = Observer::open(&s, &sid, Some(cursor)).await;
    reopened.until(|name, v| name == "partial" && v["snapshot"]["text"] == "계속 실행 중").await;
    let (status, _) = s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let cancelled = s.wait_status(&tid, "cancelled").await;
    assert_eq!(cancelled["error"]["code"], "user_stop");
    reopened.until(|name, v| name == "partial" && v["snapshot"].is_null()).await;
    let (_, messages) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert!(!messages["items"].as_array().unwrap().iter().any(|m| m["role"] == "assistant"));
    assert_eq!(f.requests().len(), 1, "재연결은 모델 호출을 재실행하지 않는다");
    drop(reopened);
    s.stop().await;
}

#[tokio::test]
async fn model_finishes_without_observers_and_replays_its_durable_result() {
    let (mut s, f, profile, _, sid) = setup().await;
    let observer = Observer::open(&s, &sid, None).await;
    let cursor = observer.cursor;
    let (step, release) = fixture::gated_text("닫힌 동안 완료");
    f.push(step);
    let tid = start(&s, &sid, &profile, false).await;
    s.wait_status(&tid, "running").await;
    drop(observer);
    release.send_replace(true);
    s.wait_status(&tid, "completed").await;

    let mut reopened = Observer::open(&s, &sid, Some(cursor)).await;
    reopened.until(|name, v| name == "event" && v["kind"] == "turn.updated"
        && v["payload"]["id"] == tid && v["payload"]["status"] == "completed").await;
    let (_, messages) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let answers: Vec<_> = messages["items"].as_array().unwrap().iter().filter(|m| m["role"] == "assistant").collect();
    assert_eq!(answers.len(), 1);
    assert_eq!(answers[0]["content"]["text"], "닫힌 동안 완료");
    assert_eq!(f.requests().len(), 1);
    drop(reopened);
    s.stop().await;
}

async fn shell_survives_disconnect(background: bool) {
    let (mut s, f, profile, project, sid) = setup().await;
    let root = Path::new(project["root_path"].as_str().unwrap());
    let observer = Observer::open(&s, &sid, None).await;
    let cursor = observer.cursor;
    f.push(fixture::tool_calls(&[("shell-close", "shell", json!({
        "command":"printf x >> executions; touch started; while [ ! -f release ]; do sleep 0.02; done; printf 'offline shell result'; printf 'offline stderr' >&2",
        "background":background, "timeout_ms":20000
    }))]));
    if background {
        f.push(fixture::text("작업 결과 대기"));
    }
    f.push(fixture::text("셸 결과 확인 완료"));
    let tid = start(&s, &sid, &profile, true).await;
    let turn = s.wait_status(&tid, "awaiting_approval").await;
    let call = &turn["tool_calls"][0];
    let (status, _) = s.post(&format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()),
        json!({"decision":"approve","expected_revision":call["revision"]})).await;
    assert_eq!(status, StatusCode::OK);
    wait_file(&root.join("started")).await;
    // background 도구가 반환하고 턴이 결과 대기에 들어간 뒤 연결을 끊는다.
    if background {
        s.wait_turn(&tid, |t| t["status"] == "running" && t["tool_calls"][0]["status"] == "succeeded").await;
    }
    drop(observer);
    let active = s.get(&format!("/api/v1/turns/{tid}")).await.1;
    assert_eq!(active["status"], if background { "running" } else { "awaiting_approval" });
    assert_eq!(active["tool_calls"][0]["status"], if background { "succeeded" } else { "running" });
    std::fs::write(root.join("release"), b"go").unwrap();
    let done = s.wait_status(&tid, "completed").await;
    assert_eq!(done["tool_calls"][0]["status"], "succeeded");

    let mut reopened = Observer::open(&s, &sid, Some(cursor)).await;
    reopened.until(|name, v| name == "event" && v["kind"] == "turn.updated"
        && v["payload"]["id"] == tid && v["payload"]["status"] == "completed").await;
    if background {
        let (_, list) = s.get(&format!("/api/v1/sessions/{sid}/tasks")).await;
        let tasks = list["tasks"].as_array().unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["status"], "completed");
        let (_, result) = s.get(&format!("/api/v1/tasks/{}", tasks[0]["id"].as_str().unwrap())).await;
        assert_eq!(result["stdout_tail"], "offline shell result");
        assert_eq!(result["stderr_tail"], "offline stderr");
        let (_, messages) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
        assert_eq!(messages["items"].as_array().unwrap().iter().filter(|m| m["content"]["type"] == "task_result").count(), 1);
    } else {
        assert_eq!(done["tool_calls"][0]["result"]["stdout"], "offline shell result");
        assert_eq!(done["tool_calls"][0]["result"]["stderr"], "offline stderr");
    }
    assert_eq!(std::fs::read(root.join("executions")).unwrap(), b"x", "복원은 명령을 재실행하지 않는다");
    assert_eq!(f.requests().len(), if background { 3 } else { 2 });
    drop(reopened);
    s.stop().await;
}

#[tokio::test]
async fn foreground_tool_finishes_after_sse_disconnect() {
    shell_survives_disconnect(false).await;
}

#[tokio::test]
async fn background_tool_finishes_after_sse_disconnect() {
    shell_survives_disconnect(true).await;
}

#[tokio::test]
async fn explicit_turn_cancel_after_reconnect_still_stops_the_foreground_process() {
    let (mut s, f, profile, project, sid) = setup().await;
    let root = Path::new(project["root_path"].as_str().unwrap());
    let observer = Observer::open(&s, &sid, None).await;
    f.push(fixture::tool_calls(&[("cancel-shell", "shell", json!({
        "command":"touch started; while [ ! -f release ]; do sleep 0.02; done; touch must-not-run",
        "timeout_ms":20000
    }))]));
    let tid = start(&s, &sid, &profile, true).await;
    let turn = s.wait_status(&tid, "awaiting_approval").await;
    let call = &turn["tool_calls"][0];
    let (status, _) = s.post(&format!("/api/v1/tool-calls/{}/decision", call["id"].as_str().unwrap()),
        json!({"decision":"approve","expected_revision":call["revision"]})).await;
    assert_eq!(status, StatusCode::OK);
    wait_file(&root.join("started")).await;
    let cursor = observer.cursor;
    drop(observer);
    let mut reopened = Observer::open(&s, &sid, Some(cursor)).await;
    let active = s.get(&format!("/api/v1/turns/{tid}")).await.1;
    assert_eq!(active["tool_calls"][0]["status"], "running");
    assert_eq!(s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await.0, StatusCode::ACCEPTED);
    let stopped = s.wait_turn(&tid, |t| t["status"] == "cancelled" && t["tool_calls"][0]["status"] == "cancelled").await;
    assert_eq!(stopped["error"]["code"], "user_stop");
    reopened.until(|name, v| name == "event" && v["kind"] == "tool_call.updated"
        && v["payload"]["status"] == "cancelled").await;
    std::fs::write(root.join("release"), b"go").unwrap();
    assert!(!root.join("must-not-run").exists());
    assert_eq!(f.requests().len(), 1);
    drop(reopened);
    s.stop().await;
}

#[tokio::test]
async fn user_background_task_and_cancel_survive_observer_replacement() {
    let (mut s, _, _, project, sid) = setup().await;
    let root = Path::new(project["root_path"].as_str().unwrap());
    let observer = Observer::open(&s, &sid, None).await;
    let (status, task) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({
        "command":"touch started; while [ ! -f release ]; do sleep 0.02; done; touch must-not-run",
        "timeout_ms":20000
    })).await;
    assert_eq!(status, StatusCode::CREATED, "{task}");
    let id = task["id"].as_str().unwrap();
    wait_file(&root.join("started")).await;
    let cursor = observer.cursor;
    drop(observer);
    assert_eq!(s.get(&format!("/api/v1/tasks/{id}")).await.1["status"], "running");
    let mut reopened = Observer::open(&s, &sid, Some(cursor)).await;
    let (status, cancelled) = s.post(&format!("/api/v1/tasks/{id}/cancel"), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cancelled["cancelled"], true);
    assert_eq!(cancelled["task"]["status"], "cancelled");
    reopened.until(|name, v| name == "event" && v["kind"] == "task.changed"
        && v["payload"]["id"] == id && v["payload"]["status"] == "cancelled").await;
    std::fs::write(root.join("release"), b"go").unwrap();
    assert!(!root.join("must-not-run").exists());
    drop(reopened);
    s.stop().await;
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn open_terminal(s: &TestServer, tid: &str) -> Ws {
    let (status, ticket) = s.post(&format!("/api/v1/terminals/{tid}/ticket"), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let url = format!("{}{}", s.base.replace("http://", "ws://"), ticket["url"].as_str().unwrap());
    tokio_tungstenite::connect_async(url).await.unwrap().0
}

async fn terminal_output(ws: &mut Ws, needle: &str) -> String {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut text = String::new();
        while !text.contains(needle) {
            match ws.next().await.expect("WS 연결").expect("WS 출력") {
                WsMsg::Binary(bytes) => text.push_str(&String::from_utf8_lossy(&bytes)),
                WsMsg::Close(_) => panic!("출력 전에 터미널 연결 종료"),
                _ => {}
            }
        }
        text
    }).await.expect("PTY 출력 대기")
}

#[tokio::test]
async fn graceful_and_abrupt_websocket_close_preserve_pty_and_offline_screen() {
    let (mut s, _, _, project, _) = setup().await;
    let pid = project["id"].as_str().unwrap();
    let root = Path::new(project["root_path"].as_str().unwrap());
    let (status, terminal) = s.post(&format!("/api/v1/projects/{pid}/terminals"), json!({})).await;
    assert_eq!(status, StatusCode::CREATED);
    let tid = terminal["id"].as_str().unwrap();
    let mut ws = open_terminal(&s, tid).await;
    for (i, graceful) in [true, false].into_iter().enumerate() {
        let command = format!("stty -echo; printf '%s' \"$$\" > pid-{i}; printf x >> executions; printf '\\nready-%s\\n' \"$((100+{i}))\"; while [ ! -f release-{i} ]; do sleep 0.02; done; printf '\\noffline-%s\\n' \"$((100+{i}))\"; touch done-{i}\n");
        ws.send(WsMsg::Text(json!({"type":"input","data":command}).to_string().into())).await.unwrap();
        terminal_output(&mut ws, &format!("ready-{}", 100 + i)).await;
        if graceful {
            ws.close(None).await.unwrap();
        }
        drop(ws);
        std::fs::write(root.join(format!("release-{i}")), b"go").unwrap();
        wait_file(&root.join(format!("done-{i}"))).await;
        assert_eq!(s.get(&format!("/api/v1/projects/{pid}/terminals")).await.1["terminals"][0]["status"], "running");
        ws = open_terminal(&s, tid).await;
        let snapshot = terminal_output(&mut ws, &format!("offline-{}", 100 + i)).await;
        assert!(snapshot.contains("ready-100"), "연결 전 출력도 snapshot으로 복원한다");
    }
    assert_eq!(std::fs::read(root.join("pid-0")).unwrap(), std::fs::read(root.join("pid-1")).unwrap(), "같은 셸 PTY에 다시 붙는다");
    assert_eq!(std::fs::read(root.join("executions")).unwrap(), b"xx");
    let (status, killed) = s.post(&format!("/api/v1/terminals/{tid}/kill"), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(killed["status"], "exited");
    assert_eq!(killed["reason"], "사용자가 종료함");
    assert_eq!(s.post(&format!("/api/v1/terminals/{tid}/ticket"), json!({})).await.0, StatusCode::CONFLICT);
    let screen = s.raw(Method::GET, &format!("/api/v1/terminals/{tid}/screen"), None, None, None).await.text().await.unwrap();
    assert!(screen.contains("offline-101"), "명시적 종료 후에도 저장 화면은 남는다");
    drop(ws);
    s.stop().await;
}
