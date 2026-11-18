//! 공식 HTTP 계약의 로컬 인수. 실제 공급자 계정·모델 품질·과금 검증이 아니다.
mod common;

use axum::{Router, body::{Body, Bytes}, http::{HeaderMap, StatusCode, Uri, header}, response::Response, routing::post};
use common::TestServer;
use serde_json::{Value, json};
use std::{collections::VecDeque, sync::{Arc, Mutex}};

const KEY: &str = "synthetic-provider-key-1234";

enum Reply { Events(Vec<String>), Error }
struct State { requests: Vec<(String, Value, bool)>, replies: VecDeque<Reply> }
struct Provider { base: String, state: Arc<Mutex<State>>, task: tokio::task::JoinHandle<()> }

impl Provider {
    async fn start(protocol: &str, replies: Vec<Reply>) -> Self {
        let protocol = protocol.to_string();
        let state = Arc::new(Mutex::new(State { requests: vec![], replies: replies.into() }));
        let shared = state.clone();
        let app = Router::new().fallback(post(move |uri: Uri, headers: HeaderMap, bytes: Bytes| {
            let (shared, protocol) = (shared.clone(), protocol.clone());
            async move {
                let body: Value = serde_json::from_slice(&bytes).unwrap();
                let auth = match protocol.as_str() {
                    "anthropic" => headers.get("x-api-key").is_some_and(|h| h == KEY),
                    "gemini" => headers.get("x-goog-api-key").is_some_and(|h| h == KEY),
                    _ => headers.get("authorization").and_then(|h| h.to_str().ok()) == Some(format!("Bearer {KEY}").as_str()),
                };
                let reply = {
                    let mut state = shared.lock().unwrap();
                    state.requests.push((uri.to_string(), body, auth));
                    state.replies.pop_front()
                };
                match reply {
                    Some(Reply::Events(frames)) => {
                        // UTF-8·SSE 경계와 무관한 전송 조각. 실제 TCP 수신 경계의 고정은 가정하지 않는다.
                        let chunks: Vec<Result<Bytes, std::convert::Infallible>> = frames.concat().as_bytes().chunks(3).map(|b| Ok(Bytes::copy_from_slice(b))).collect();
                        Response::builder().header(header::CONTENT_TYPE, "text/event-stream").body(Body::from_stream(futures_util::stream::iter(chunks))).unwrap()
                    }
                    Some(Reply::Error) => Response::builder().status(StatusCode::UNAUTHORIZED).header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(json!({ "error": { "message": format!("bad credential {KEY}") } }).to_string())).unwrap(),
                    None => Response::builder().status(StatusCode::BAD_REQUEST).body(Body::from("unexpected fixture call")).unwrap(),
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        Self { base, state, task }
    }
}
impl Drop for Provider { fn drop(&mut self) { self.task.abort(); } }

fn data(value: Value) -> String { format!("data: {value}\n\n") }
fn anthropic(values: Vec<Value>) -> Vec<String> {
    values.into_iter().map(|value| format!("event: {}\ndata: {value}\n\n", value["type"].as_str().unwrap())).collect()
}

fn steps(protocol: &str) -> Vec<Reply> {
    match protocol {
        "anthropic" => vec![
            Reply::Events(anthropic(vec![
                json!({ "type": "message_start", "message": { "usage": { "input_tokens": 7, "cache_read_input_tokens": 2, "cache_creation_input_tokens": 1, "output_tokens": 0 } } }),
                json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "", "signature": "" } }),
                json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "계획" } }),
                json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "fixture-signature" } }),
                json!({ "type": "content_block_stop", "index": 0 }),
                json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "redacted_thinking", "data": "fixture-redacted" } }),
                json!({ "type": "content_block_stop", "index": 1 }),
                json!({ "type": "content_block_start", "index": 2, "content_block": { "type": "text", "text": "" } }),
                json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "text_delta", "text": "읽을게" } }),
                json!({ "type": "content_block_stop", "index": 2 }),
                json!({ "type": "content_block_start", "index": 3, "content_block": { "type": "tool_use", "id": "native-read", "name": "read", "input": {} } }),
                json!({ "type": "content_block_delta", "index": 3, "delta": { "type": "input_json_delta", "partial_json": "{\"path\":" } }),
                json!({ "type": "content_block_delta", "index": 3, "delta": { "type": "input_json_delta", "partial_json": "\"notes.txt\"}" } }),
                json!({ "type": "content_block_stop", "index": 3 }),
                json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 5 } }),
                json!({ "type": "message_stop" }),
            ])),
            Reply::Events(anthropic(vec![
                json!({ "type": "message_start", "message": { "usage": { "input_tokens": 11, "cache_read_input_tokens": 3, "cache_creation_input_tokens": 0 } } }),
                json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "완료" } }),
                json!({ "type": "content_block_stop", "index": 0 }),
                json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 4 } }),
                json!({ "type": "message_stop" }),
            ])),
        ],
        "gemini" => vec![
            Reply::Events(vec![
                data(json!({ "candidates": [{ "content": { "role": "model", "parts": [{ "text": "계획", "thought": true }, { "text": "읽을게" }] } }] })),
                data(json!({ "candidates": [{ "content": { "role": "model", "parts": [
                    { "functionCall": { "id": "native-read", "name": "read", "args": { "path": "notes.txt" } }, "thoughtSignature": "fixture-signature" },
                    { "text": "", "thoughtSignature": "fixture-empty-signature" }
                ] }, "finishReason": "STOP" }], "usageMetadata": { "promptTokenCount": 7, "candidatesTokenCount": 5, "thoughtsTokenCount": 2, "cachedContentTokenCount": 2 } })),
            ]),
            Reply::Events(vec![data(json!({ "candidates": [{ "content": { "role": "model", "parts": [{ "text": "완료" }] }, "finishReason": "STOP" }],
                "usageMetadata": { "promptTokenCount": 11, "candidatesTokenCount": 4, "thoughtsTokenCount": 1, "cachedContentTokenCount": 3 } }))]),
        ],
        _ => vec![
            Reply::Events(vec![
                data(json!({ "choices": [{ "delta": { "reasoning_content": "계획", "content": "읽을게", "tool_calls": [{ "index": 0, "id": "native-read", "type": "function", "function": { "name": "read", "arguments": "{\"path\":" } }] } }] })),
                data(json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "\"notes.txt\"}" } }] }, "finish_reason": "tool_calls" }],
                    "usage": { "prompt_tokens": 7, "completion_tokens": 5, "prompt_tokens_details": { "cached_tokens": 2, "cache_write_tokens": 1 } } })),
                "data: [DONE]\n\n".into(),
            ]),
            Reply::Events(vec![
                data(json!({ "choices": [{ "delta": { "content": "완료" }, "finish_reason": "stop" }],
                    "usage": { "prompt_tokens": 11, "completion_tokens": 4, "prompt_tokens_details": { "cached_tokens": 3, "cache_write_tokens": 0 } } })),
                "data: [DONE]\n\n".into(),
            ]),
        ],
    }
}

async fn create_profile(s: &TestServer, provider: &Provider, protocol: &str) -> String {
    let (_, secret) = s.post("/api/v1/secrets", json!({ "label": "provider", "value": KEY })).await;
    let (status, profile) = s.post("/api/v1/model-profiles", json!({
        "name": protocol, "protocol": protocol, "base_url": provider.base, "model": "fixture",
        "secret_id": secret["id"], "options": { "max_tokens": 32768, "context_window": 1000000 },
    })).await;
    assert_eq!(status, StatusCode::CREATED);
    profile["id"].as_str().unwrap().into()
}

async fn configure(s: &TestServer, provider: &Provider, protocol: &str) -> (String, String) {
    let profile = create_profile(s, provider, protocol).await;
    let project = s.create_project("provider").await;
    std::fs::write(std::path::Path::new(project["root_path"].as_str().unwrap()).join("notes.txt"), "문서\n").unwrap();
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    (profile, session["id"].as_str().unwrap().into())
}

async fn roundtrip(protocol: &str) {
    let mut s = TestServer::start().await;
    let provider = Provider::start(protocol, steps(protocol)).await;
    let (profile, session) = configure(&s, &provider, protocol).await;
    let (status, turn) = s.post(&format!("/api/v1/sessions/{session}/turns"),
        json!({ "profile_id": profile, "text": "read notes", "tools": true, "effort": "high" })).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let done = s.wait_turn(turn["turn"]["id"].as_str().unwrap(), |turn| matches!(turn["status"].as_str(), Some("completed" | "failed"))).await;
    assert_eq!(done["status"], "completed");
    let requests = provider.state.lock().unwrap().requests.clone();
    assert_eq!(requests.len(), 2);
    assert!(requests.iter().all(|(_, _, auth)| *auth));
    let second = &requests[1].1;
    match protocol {
        "anthropic" => {
            assert!(requests[0].0.starts_with("/v1/messages"));
            assert_eq!(second["messages"][1]["content"], json!([
                { "type": "thinking", "thinking": "계획", "signature": "fixture-signature" },
                { "type": "redacted_thinking", "data": "fixture-redacted" },
                { "type": "text", "text": "읽을게" },
                { "type": "tool_use", "id": "native-read", "name": "read", "input": { "path": "notes.txt" } }
            ]));
            assert_eq!(second["messages"][2]["content"][0]["tool_use_id"], "native-read");
            assert!(second["messages"][2]["content"][0]["content"].as_str().unwrap().contains("문서"));
            assert_eq!(done["usage"]["input_tokens"], 24);
            assert_eq!(done["usage"]["output_tokens"], 9);
            assert_eq!(done["usage"]["cache_write_tokens"], 1);
        }
        "gemini" => {
            assert!(requests[0].0.starts_with("/v1beta/models/fixture:streamGenerateContent?alt=sse"));
            assert_eq!(second["contents"][1]["parts"], json!([
                { "text": "계획", "thought": true }, { "text": "읽을게" },
                { "functionCall": { "id": "native-read", "name": "read", "args": { "path": "notes.txt" } }, "thoughtSignature": "fixture-signature" },
                { "text": "", "thoughtSignature": "fixture-empty-signature" }
            ]));
            assert_eq!(second["contents"][2]["parts"][0]["functionResponse"]["id"], "native-read");
            assert!(second["contents"][2]["parts"][0]["functionResponse"]["response"]["output"].as_str().unwrap().contains("문서"));
            assert_eq!(done["usage"]["input_tokens"], 18);
            assert_eq!(done["usage"]["output_tokens"], 12);
        }
        _ => {
            assert!(requests[0].0.starts_with("/chat/completions"));
            assert!(requests.iter().all(|(_, body, _)| body.get("prompt_cache_key").is_none() && body.get("cache_control").is_none()),
                "호환 endpoint에는 공식 공급자 전용 캐시 필드를 보내지 않는다");
            assert_eq!(second["messages"][2]["tool_calls"][0]["id"], "native-read");
            assert_eq!(second["messages"][3]["tool_call_id"], "native-read");
            assert!(second["messages"][3]["content"].as_str().unwrap().contains("문서"));
            assert_eq!(done["usage"]["input_tokens"], 18);
            assert_eq!(done["usage"]["output_tokens"], 9);
            assert_eq!(done["usage"]["cache_write_tokens"], 1);
        }
    }
    assert_eq!(done["usage"]["cache_read_tokens"], 5);
    let (_, messages) = s.get(&format!("/api/v1/sessions/{session}/messages")).await;
    assert!(messages["items"].as_array().unwrap().iter().any(|message| message["role"] == "assistant" && message["content"]["text"] == "완료"));
    let (_, preview) = s.get(&format!("/api/v1/sessions/{session}/model-input")).await;
    let events = s.read_events(Some(0), &session, 100, 300).await;
    for visible in [messages.to_string(), preview.to_string(), serde_json::to_string(&events).unwrap()] {
        assert!(!visible.contains("fixture-signature") && !visible.contains("fixture-redacted"));
    }
    if protocol != "openai" {
        // 재시작 뒤에도 DB의 모델 전용 입력에서 서명·빈 part를 복구한다.
        s.restart().await;
        provider.state.lock().unwrap().replies.push_back(steps(protocol).pop().unwrap());
        let (_, turn) = s.post(&format!("/api/v1/sessions/{session}/turns"), json!({ "profile_id": profile, "text": "next", "tools": false })).await;
        s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
        let third = provider.state.lock().unwrap().requests[2].1.clone();
        let (messages_key, content_key) = if protocol == "anthropic" { ("messages", "content") } else { ("contents", "parts") };
        assert_eq!(third[messages_key][1][content_key], second[messages_key][1][content_key]);
        // 모델을 바꾸면 같은 공급자라도 이전 모델의 서명은 보내지 않는다.
        let (_, profiles) = s.get("/api/v1/model-profiles").await;
        let revision = profiles.as_array().unwrap().iter().find(|p| p["id"] == profile).unwrap()["revision"].clone();
        let (status, _) = s.send(reqwest::Method::PUT, &format!("/api/v1/model-profiles/{profile}"), json!({ "expected_revision": revision, "model": "different" })).await;
        assert_eq!(status, StatusCode::OK);
        provider.state.lock().unwrap().replies.push_back(steps(protocol).pop().unwrap());
        let (_, turn) = s.post(&format!("/api/v1/sessions/{session}/turns"), json!({ "profile_id": profile, "text": "switch", "tools": false })).await;
        s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
        let wire = provider.state.lock().unwrap().requests[3].1.to_string();
        assert!(!wire.contains("fixture-signature") && !wire.contains("fixture-redacted") && !wire.contains("fixture-empty-signature"));
        assert!(wire.contains("읽을게"), "다른 모델에서도 일반 대화 이력은 보존한다");
    }
}

#[tokio::test]
async fn openai_chat_stream_tool_and_usage_roundtrip() { roundtrip("openai").await; }
#[tokio::test]
async fn anthropic_signed_content_survives_tool_roundtrip() { roundtrip("anthropic").await; }
#[tokio::test]
async fn gemini_signed_parts_survive_tool_roundtrip() { roundtrip("gemini").await; }

#[tokio::test]
async fn provider_error_echo_does_not_leak_credentials_into_turns_or_events() {
    for protocol in ["openai", "anthropic", "gemini"] {
        let s = TestServer::start().await;
        let provider = Provider::start(protocol, vec![Reply::Error]).await;
        let (profile, session) = configure(&s, &provider, protocol).await;
        let (_, turn) = s.post(&format!("/api/v1/sessions/{session}/turns"), json!({ "profile_id": profile, "text": "error", "tools": false })).await;
        let done = s.wait_status(turn["turn"]["id"].as_str().unwrap(), "failed").await;
        assert_eq!(done["error"]["code"], "auth_failed");
        assert!(!done.to_string().contains(KEY), "{protocol}: 공급자 오류가 키를 되돌려도 저장·전달하지 않는다");
        let (_, messages) = s.get(&format!("/api/v1/sessions/{session}/messages")).await;
        assert!(!messages.to_string().contains(KEY));
        let events = s.read_events(Some(0), &session, 100, 300).await;
        assert!(!serde_json::to_string(&events).unwrap().contains(KEY));
    }
}

#[tokio::test]
async fn signed_content_is_not_sent_to_a_different_endpoint_or_protocol() {
    use grove::provider::{self, ChatMsg, ModelRequest, NativeContent, Profile};
    for protocol in ["anthropic", "gemini"] {
        let provider = Provider::start(protocol, vec![steps(protocol).pop().unwrap(), steps(protocol).pop().unwrap()]).await;
        let profile = Profile {
            protocol: protocol.into(), base_url: provider.base.clone(), model: "fixture".into(),
            api_key: Some(KEY.into()), timeout: std::time::Duration::from_secs(2), extra_headers: vec![], sensitive_headers: vec![],
        };
        for other_protocol in [false, true] {
            let native = NativeContent {
                protocol: if other_protocol { "other".into() } else { protocol.into() },
                base_url: if other_protocol { profile.base_url.clone() } else { "http://other.invalid".into() },
                model: profile.model.clone(), blocks: vec![json!({ "signature": "must-not-leave", "text": "must-not-leave" })],
            };
            let request = ModelRequest {
                system: String::new(), messages: vec![
                    ChatMsg::User { text: "q".into(), images: vec![] },
                    ChatMsg::Assistant { text: "public history".into(), tool_calls: vec![], native: Some(native) },
                    ChatMsg::User { text: "next".into(), images: vec![] },
                ], tools: vec![], max_tokens: None, temperature: None, effort: None, cli: None,
            };
            let (_cancel, mut rx) = tokio::sync::watch::channel(false);
            provider::stream(&profile, &request, &mut rx, &mut |_| {}).await.unwrap();
        }
        let requests = &provider.state.lock().unwrap().requests;
        assert_eq!(requests.len(), 2);
        for (_, body, _) in requests {
            assert!(!body.to_string().contains("must-not-leave"));
            assert!(body.to_string().contains("public history"));
        }
    }
}

#[tokio::test]
async fn switching_http_providers_keeps_display_history_and_translates_tool_pairs_without_foreign_signatures() {
    for source_protocol in ["openai", "anthropic", "gemini"] {
        let s = TestServer::start().await;
        let source = Provider::start(source_protocol, steps(source_protocol)).await;
        let (profile, session) = configure(&s, &source, source_protocol).await;
        let (_, turn) = s.post(&format!("/api/v1/sessions/{session}/turns"),
            json!({ "profile_id":profile, "text":"read notes", "tools":true, "effort":"high" })).await;
        s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
        let (_, original) = s.get(&format!("/api/v1/sessions/{session}/messages")).await;
        for target_protocol in ["openai", "anthropic", "gemini"] {
            let target = Provider::start(target_protocol, vec![steps(target_protocol).pop().unwrap()]).await;
            let target_profile = create_profile(&s, &target, target_protocol).await;
            let (_, turn) = s.post(&format!("/api/v1/sessions/{session}/turns"),
                json!({ "profile_id":target_profile, "text":format!("new turn in {target_protocol}"), "tools":false })).await;
            let done = s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
            assert_eq!(done["profile_id"], target_profile);
            let requests = &target.state.lock().unwrap().requests;
            assert_eq!(requests.len(), 1);
            assert!(requests[0].2);
            let body = &requests[0].1;
            let wire = body.to_string();
            assert!(wire.contains("읽을게") && wire.contains("문서") && wire.contains("notes.txt"));
            assert!(!wire.contains("fixture-signature") && !wire.contains("fixture-redacted") && !wire.contains("fixture-empty-signature"));
            match target_protocol {
                "openai" => {
                    let messages = body["messages"].as_array().unwrap();
                    assert!(messages.iter().any(|m| m["role"] == "tool" && m["tool_call_id"] == "native-read"));
                    assert!(messages.iter().any(|m| m["tool_calls"][0]["id"] == "native-read"));
                }
                "anthropic" => {
                    let blocks: Vec<_> = body["messages"].as_array().unwrap().iter().flat_map(|m| m["content"].as_array().unwrap()).collect();
                    assert!(blocks.iter().any(|b| b["type"] == "tool_use" && b["id"] == "native-read"));
                    assert!(blocks.iter().any(|b| b["type"] == "tool_result" && b["tool_use_id"] == "native-read"));
                }
                _ => {
                    let parts: Vec<_> = body["contents"].as_array().unwrap().iter().flat_map(|m| m["parts"].as_array().unwrap()).collect();
                    assert!(parts.iter().any(|p| p["functionCall"]["name"] == "read" && p["functionCall"]["args"]["path"] == "notes.txt"));
                    assert!(parts.iter().any(|p| p["functionResponse"]["name"] == "read"));
                }
            }
        }
        let (_, after) = s.get(&format!("/api/v1/sessions/{session}/messages")).await;
        let original = original["items"].as_array().unwrap();
        assert_eq!(&after["items"].as_array().unwrap()[..original.len()], original.as_slice(), "표시용 원래 메시지를 고쳐 쓰지 않는다");
    }
}
