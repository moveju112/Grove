//! 로컬 HTTP 모델 fixture. 재현성과 장애 주입용이며 실제 provider·모델 품질의 증거가 아니다.
//! 응답 대본(script)을 순서대로 소비하고 받은 요청 본문을 기록한다.
#![allow(dead_code)]

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use bytes::Bytes;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Debug)]
pub enum Step {
    /// SSE 프레임 목록(각 프레임 사이 지연 ms)
    Frames(Vec<String>, u64),
    /// 일부 프레임 후 연결을 끊지 않고 멈춘다(취소 시험용)
    Hang(Vec<String>),
    /// 요청 접수 후 시험이 관찰한 상태를 근거로 해제할 때까지 응답을 보류한다.
    Gated(Vec<String>, tokio::sync::watch::Receiver<bool>),
    /// HTTP 오류 응답
    Error(u16, String),
}

#[derive(Default)]
pub struct Inner {
    pub script: VecDeque<Step>,
    /// 요청 본문에 표식 문자열이 있으면 그 대본을 먼저 쓴다(동시에 도는 부모·자식 턴 구분용).
    pub routed: Vec<(String, VecDeque<Step>)>,
    pub requests: Vec<(HeaderMap, Value)>,
}

#[derive(Clone, Default)]
pub struct Fixture {
    pub inner: Arc<Mutex<Inner>>,
    pub base: String,
}

impl Fixture {
    pub async fn start() -> Self {
        let mut f = Fixture::default();
        let app = Router::new()
            .route("/v1/chat/completions", post(openai))
            .route("/v1/messages", post(openai))
            // 연결 확인(AUTH-001): 모델 목록. /bad는 인증 헤더를 오류 본문에 되돌려 비밀 가림을 시험한다.
            .route("/v1/models", axum::routing::get(|| async { axum::Json(json!({ "data": [{ "id": "fixture-model" }, { "id": "other" }] })) }))
            .route(
                "/bad/models",
                axum::routing::get(|h: HeaderMap| async move {
                    let auth = h.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                    (StatusCode::UNAUTHORIZED, axum::Json(json!({ "error": { "message": format!("invalid key: {auth}") } })))
                }),
            )
            .with_state(f.clone());
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        f.base = format!("http://{}/v1", l.local_addr().unwrap());
        tokio::spawn(axum::serve(l, app).into_future());
        f
    }
    pub fn push(&self, s: Step) {
        self.inner.lock().unwrap().script.push_back(s);
    }
    /// 요청 본문에 `marker`가 들어 있을 때만 쓰는 대본.
    pub fn push_for(&self, marker: &str, s: Step) {
        let mut i = self.inner.lock().unwrap();
        match i.routed.iter_mut().find(|(m, _)| m == marker) {
            Some((_, q)) => q.push_back(s),
            None => i.routed.push((marker.to_string(), VecDeque::from([s]))),
        }
    }
    pub fn requests(&self) -> Vec<Value> {
        self.inner.lock().unwrap().requests.iter().map(|r| r.1.clone()).collect()
    }
    pub fn headers(&self, i: usize) -> HeaderMap {
        self.inner.lock().unwrap().requests[i].0.clone()
    }
}

async fn openai(State(f): State<Fixture>, headers: HeaderMap, body: String) -> Response {
    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let step = {
        let mut i = f.inner.lock().unwrap();
        // 표식이 등록된 요청은 그 대본만 쓴다(비었으면 일반 대본으로 넘어가지 않고 실패).
        let routed = i.routed.iter_mut().find(|(m, _)| body.contains(m.as_str())).map(|(_, q)| q.pop_front());
        i.requests.push((headers, v));
        match routed {
            Some(step) => step,
            None => i.script.pop_front(),
        }
    };
    match step {
        None => (StatusCode::INTERNAL_SERVER_ERROR, "fixture script exhausted").into_response(),
        Some(Step::Error(code, msg)) => (StatusCode::from_u16(code).unwrap(), axum::Json(json!({ "error": { "message": msg } }))).into_response(),
        Some(Step::Frames(frames, delay)) => {
            let stream = async_stream(frames, delay, false);
            Response::builder().header("content-type", "text/event-stream").body(Body::from_stream(stream)).unwrap()
        }
        Some(Step::Hang(frames)) => {
            let stream = async_stream(frames, 0, true);
            Response::builder().header("content-type", "text/event-stream").body(Body::from_stream(stream)).unwrap()
        }
        Some(Step::Gated(frames, mut gate)) => {
            gate.wait_for(|ready| *ready).await.expect("fixture gate sender");
            Response::builder().header("content-type", "text/event-stream").body(Body::from_stream(async_stream(frames, 0, false))).unwrap()
        }
    }
}

fn async_stream(frames: Vec<String>, delay: u64, hang: bool) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> {
    futures_util::stream::unfold((frames.into_iter(), hang, false), move |(mut it, hang, first)| async move {
        if first && delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        match it.next() {
            Some(f) => Some((Ok(Bytes::from(format!("data: {f}\n\n"))), (it, hang, true))),
            None if hang => {
                tokio::time::sleep(Duration::from_secs(3600)).await;
                None
            }
            None => None,
        }
    })
}

// ---- OpenAI 형식 대본 도우미 ----

pub fn text(t: &str) -> Step {
    Step::Frames(text_frames(t), 0)
}

pub fn gated_text(t: &str) -> (Step, tokio::sync::watch::Sender<bool>) {
    let (release, gate) = tokio::sync::watch::channel(false);
    (Step::Gated(text_frames(t), gate), release)
}

fn text_frames(t: &str) -> Vec<String> {
    vec![
        json!({ "choices": [{ "delta": { "content": t } }] }).to_string(),
        json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] }).to_string(),
        json!({ "choices": [], "usage": { "prompt_tokens": 11, "completion_tokens": 3 } }).to_string(),
        "[DONE]".into(),
    ]
}

/// reasoning(생각) 조각 뒤에 답을 보낸다(OpenAI 호환 `reasoning_content`).
pub fn reasoning_text(reasoning: &str, t: &str) -> Step {
    Step::Frames(
        vec![
            json!({ "choices": [{ "delta": { "reasoning_content": reasoning } }] }).to_string(),
            json!({ "choices": [{ "delta": { "content": t } }] }).to_string(),
            json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] }).to_string(),
            "[DONE]".into(),
        ],
        0,
    )
}

pub fn slow_text(parts: &[&str], delay_ms: u64) -> Step {
    let mut frames: Vec<String> = parts.iter().map(|p| json!({ "choices": [{ "delta": { "content": p } }] }).to_string()).collect();
    frames.push(json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] }).to_string());
    frames.push("[DONE]".into());
    Step::Frames(frames, delay_ms)
}

pub fn tool_calls(calls: &[(&str, &str, Value)]) -> Step {
    let mut frames = vec![];
    for (i, (id, name, args)) in calls.iter().enumerate() {
        let a = args.to_string();
        // 두 조각으로 나눠 보내되 UTF-8 문자 경계에서 자른다.
        let mid = a.char_indices().nth(a.chars().count() / 2).map(|(i, _)| i).unwrap_or(0);
        let (h1, h2) = a.split_at(mid);
        frames.push(json!({ "choices": [{ "delta": { "tool_calls": [{ "index": i, "id": id, "type": "function", "function": { "name": name, "arguments": h1 } }] } }] }).to_string());
        frames.push(json!({ "choices": [{ "delta": { "tool_calls": [{ "index": i, "function": { "arguments": h2 } }] } }] }).to_string());
    }
    frames.push(json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] }).to_string());
    frames.push("[DONE]".into());
    Step::Frames(frames, 0)
}

pub fn truncated() -> Step {
    Step::Frames(vec![json!({ "choices": [{ "delta": { "content": "부분" } }] }).to_string()], 0)
}

pub fn hang_after(t: &str) -> Step {
    Step::Hang(vec![json!({ "choices": [{ "delta": { "content": t } }] }).to_string()])
}
