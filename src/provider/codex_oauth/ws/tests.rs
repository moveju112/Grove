use super::*;
use crate::provider::{ChatMsg, ModelRequest, Profile, ToolDef, stream_with_service_tier};
use serde_json::json;
use tokio::sync::watch;

fn request() -> ModelRequest {
    ModelRequest {
        system: "Call get_fixture exactly once, then reply with exactly the value returned by the tool.".into(),
        messages: vec![ChatMsg::User { text: "Use get_fixture and return its value.".into(), images: vec![] }],
        tools: vec![ToolDef { name: "get_fixture".into(), description: "Returns a test value.".into(),
            schema: json!({"type":"object","properties":{},"additionalProperties":false}) }],
        max_tokens: None, temperature: None, effort: None, cli: None,
    }
}

fn profile(model: &str) -> Profile {
    Profile { protocol: super::super::PROTOCOL.into(), base_url: BASE.into(), model: model.into(),
        api_key: None, extra_headers: vec![], sensitive_headers: vec![], timeout: Duration::from_secs(45) }
}

fn append_tool_result(req: &mut ModelRequest, out: ModelOutput) {
    assert_eq!(out.tool_calls.len(), 1);
    let call = &out.tool_calls[0];
    assert_eq!(call.name, "get_fixture");
    let result = ChatMsg::Tool { call_id: call.id.clone(), name: call.name.clone(),
        content: "GROVE_FIXTURE_731".into(), is_error: false };
    req.messages.push(ChatMsg::Assistant { text: out.text, tool_calls: out.tool_calls, native: out.native });
    req.messages.push(result);
}

fn tool_reply() -> Value {
    json!({"type":"response.completed","response":{"id":"resp_tool","output":[
        {"type":"reasoning","id":"rs_one","summary":[],"encrypted_content":"fixture"},
        {"type":"function_call","call_id":"call_one","name":"get_fixture","arguments":"{}","status":"completed"}
    ]}})
}

fn final_reply() -> Value {
    json!({"type":"response.completed","response":{"id":"resp_final","output":[
        {"type":"message","role":"assistant","content":[{"type":"output_text","text":"GROVE_FIXTURE_731"}]}
    ]}})
}

#[derive(Clone, Copy)]
enum Scenario { Happy, Stale, Overloaded, Partial, LinkDown, LinkDownAfterPartial, ChangedPrefix }

#[derive(Default)]
struct Requests {
    websockets: usize,
    frames: Vec<Value>,
    sse: Vec<Value>,
}

#[derive(Clone)]
struct Fixture {
    scenario: Scenario,
    requests: std::sync::Arc<std::sync::Mutex<Requests>>,
}

async fn start(scenario: Scenario) -> (Session, Fixture, tokio::task::JoinHandle<()>) {
    use axum::{
        Json, Router,
        extract::{State, ws::{Message, WebSocketUpgrade}},
        http::HeaderMap,
        routing::get,
    };
    async fn ws(State(f): State<Fixture>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> impl axum::response::IntoResponse {
        assert_eq!(headers["authorization"], "Bearer fixture");
        assert_eq!(headers["chatgpt-account-id"], "test-account");
        assert_eq!(headers["openai-beta"], "responses_websockets=2026-02-06");
        f.requests.lock().unwrap().websockets += 1;
        upgrade.on_upgrade(move |mut socket| async move {
            while let Some(Ok(Message::Text(text))) = socket.recv().await {
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                assert_eq!(value["type"], "response.create");
                assert_eq!(value["store"], false);
                assert_eq!(value["instructions"], request().system);
                let n = {
                    let mut requests = f.requests.lock().unwrap();
                    requests.frames.push(value);
                    requests.frames.len()
                };
                if n == 2 && matches!(f.scenario, Scenario::Partial | Scenario::LinkDownAfterPartial) {
                    socket.send(Message::Text(json!({"type":"response.output_text.delta","delta":"partial"}).to_string().into())).await.unwrap();
                }
                let reply = match (n, f.scenario) {
                    (1, _) => tool_reply(),
                    (2, Scenario::Stale) => json!({"type":"error","error":{"code":"previous_response_not_found"}}),
                    (2, Scenario::Overloaded | Scenario::Partial) => json!({"type":"error","code":"server_is_overloaded","message":"private"}),
                    (2, Scenario::LinkDown | Scenario::LinkDownAfterPartial) => {
                        socket.send(Message::Close(None)).await.unwrap();
                        return;
                    }
                    _ => final_reply(),
                };
                socket.send(Message::Text(reply.to_string().into())).await.unwrap();
            }
        })
    }
    async fn sse(State(f): State<Fixture>, headers: HeaderMap, Json(value): Json<Value>) -> impl axum::response::IntoResponse {
        assert_eq!(headers["authorization"], "Bearer fixture");
        f.requests.lock().unwrap().sse.push(value);
        ([("content-type", "text/event-stream")], format!("data: {}\n\n", final_reply()))
    }
    let fixture = Fixture { scenario, requests: Default::default() };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let session = Session { fixture: Some(listener.local_addr().unwrap().to_string()), ..Default::default() };
    let server = Router::new().route("/responses", get(ws).post(sse)).with_state(fixture.clone());
    let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap(); });
    (session, fixture, task)
}

async fn run(scenario: Scenario) {
    let (mut session, fixture, task) = start(scenario).await;
    let mut req = request();
    let profile = profile("gpt-fixture");
    let (_tx, mut rx) = watch::channel(false);
    let out = stream_with_service_tier(&profile, &req, None, &mut session, &mut rx, &mut |_| {}).await.unwrap();
    append_tool_result(&mut req, out);
    if matches!(scenario, Scenario::ChangedPrefix) {
        req.messages[0] = ChatMsg::User { text: "changed input".into(), images: vec![] };
    }
    let mut deltas = Vec::new();
    let result = stream_with_service_tier(&profile, &req, None, &mut session, &mut rx,
        &mut |out| deltas.push(out.text.clone())).await;
    match scenario {
        Scenario::Partial | Scenario::LinkDownAfterPartial => {
            let error = result.unwrap_err();
            assert_eq!(deltas, ["partial"]);
            if matches!(scenario, Scenario::Partial) {
                assert_eq!(error.to_json()["provider_stream"]["code"], "server_is_overloaded");
            } else {
                assert_eq!(error.code, "stream_incomplete");
            }
        }
        _ => {
            let out = result.unwrap();
            assert_eq!(out.text, "GROVE_FIXTURE_731");
            assert!(out.tool_calls.is_empty(), "확정된 도구를 다시 실행하지 않는다");
            assert!(deltas.is_empty());
        }
    }
    let r = fixture.requests.lock().unwrap();
    let first = &r.frames[0];
    assert!(first.get("previous_response_id").is_none());
    assert_eq!(first["input"].as_array().unwrap().len(), 1);
    let second = &r.frames[1];
    let assert_full = |value: &Value| {
        assert!(value.get("previous_response_id").is_none());
        assert_eq!(value["input"].as_array().unwrap().len(), 4);
        assert_eq!(value["input"][3]["output"], "GROVE_FIXTURE_731");
    };
    if matches!(scenario, Scenario::ChangedPrefix) {
        assert_full(second);
        assert_eq!(second["input"][0]["content"][0]["text"], "changed input");
    } else {
        assert_eq!(second["previous_response_id"], "resp_tool");
        assert_eq!(second["input"], json!([{"type":"function_call_output","call_id":"call_one","output":"GROVE_FIXTURE_731"}]));
    }
    match scenario {
        Scenario::Stale | Scenario::Overloaded => {
            assert_eq!((r.websockets, r.frames.len(), r.sse.len()), (2, 3, 0));
            assert_full(&r.frames[2]);
        }
        Scenario::LinkDown => {
            assert_eq!((r.websockets, r.frames.len(), r.sse.len()), (1, 2, 1));
            assert_full(&r.sse[0]);
        }
        _ => assert_eq!((r.websockets, r.frames.len(), r.sse.len()), (1, 2, 0)),
    }
    task.abort();
}

#[tokio::test]
async fn reuses_socket_and_sends_only_the_new_tool_result() { run(Scenario::Happy).await; }

#[tokio::test]
async fn changed_prefix_is_sent_in_full_on_the_same_socket() { run(Scenario::ChangedPrefix).await; }

#[tokio::test]
async fn stale_anchor_reconnects_and_resends_full_history() { run(Scenario::Stale).await; }

#[tokio::test]
async fn retries_overloaded_step_with_the_existing_tool_result() { run(Scenario::Overloaded).await; }

#[tokio::test]
async fn partial_text_prevents_overload_retry() { run(Scenario::Partial).await; }

#[tokio::test]
async fn connection_loss_before_text_falls_back_to_sse() { run(Scenario::LinkDown).await; }

#[tokio::test]
async fn connection_loss_after_text_does_not_fall_back_to_sse() { run(Scenario::LinkDownAfterPartial).await; }

#[tokio::test]
#[ignore = "실제 Codex 구독을 사용하는 수동 검증"]
async fn live_codex_oauth_tool_loop() {
    tracing_subscriber::fmt().with_env_filter("off,grove::provider::codex_oauth::ws=debug")
        .with_test_writer().try_init().unwrap();
    let model = std::env::var("GROVE_CODEX_SMOKE_MODEL").expect("GROVE_CODEX_SMOKE_MODEL");
    let profile = profile(&model);
    let mut session = Session::default();
    let mut req = request();
    let (_tx, mut rx) = watch::channel(false);
    let out = stream_with_service_tier(&profile, &req, None, &mut session, &mut rx, &mut |_| {}).await.unwrap();
    assert!(matches!(session.transport, Transport::WebSocket(_)), "첫 요청이 WebSocket으로 완료되지 않음");
    append_tool_result(&mut req, out);
    let out = stream_with_service_tier(&profile, &req, None, &mut session, &mut rx, &mut |_| {}).await.unwrap();
    assert!(matches!(session.transport, Transport::WebSocket(_)), "후속 요청이 WebSocket으로 완료되지 않음");
    assert!(out.tool_calls.is_empty());
    assert!(out.text.trim() == "GROVE_FIXTURE_731", "실제 응답에서 도구 결과를 확인하지 못함");
}
