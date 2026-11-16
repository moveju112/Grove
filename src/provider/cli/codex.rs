//! 일반 Codex 대화의 stdio app-server 연결. 제목·요약용 exec와 달리 실제 text delta를 받는다.

use super::{
    MAX_ACTIVITY, ModelOutput, ModelRequest, OnDelta, Profile, ProviderError, Usage, read_line,
    summarize,
};
use serde_json::{Value, json};
use std::path::PathBuf;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

pub(super) fn args(req: &ModelRequest) -> Vec<String> {
    let mut args = vec!["app-server".into(), "--listen".into(), "stdio://".into()];
    // exec의 --dangerously-bypass-approvals-and-sandbox와 같은 권한 계약이다.
    for (key, value) in [
        ("sandbox_mode".into(), json!("danger-full-access")),
        ("approval_policy".into(), json!("never")),
    ]
    .into_iter()
    .chain(super::codex_config(req))
    {
        args.extend(["-c".into(), format!("{key}={value}")]);
    }
    args
}

fn thread_params(profile: &Profile, req: &ModelRequest) -> Value {
    let context = req.cli.as_ref().expect("Codex 대화 문맥");
    let mut params = json!({
        "cwd": context.cwd, "approvalPolicy": "never", "sandbox": "danger-full-access",
    });
    if profile.model != "default" {
        params["model"] = json!(profile.model);
    }
    if let Some(tier) = &context.service_tier {
        params["serviceTier"] = json!(tier);
    }
    if let Some(id) = &context.resume {
        params["threadId"] = json!(id);
        // 이어쓰기 결과에 과거 전체 응답을 다시 싣지 않는다.
        params["excludeTurns"] = json!(true);
    }
    params
}

fn turn_params(profile: &Profile, req: &ModelRequest, thread: &str, images: &[PathBuf]) -> Value {
    let context = req.cli.as_ref().expect("Codex 대화 문맥");
    let mut input = vec![json!({
        "type": "text", "text": super::prompt(req, context.resume.is_some(), context.resume.is_none()),
    })];
    input.extend(
        images
            .iter()
            .map(|path| json!({"type": "localImage", "path": path})),
    );
    let mut params = json!({
        "threadId": thread, "input": input, "cwd": context.cwd,
        "approvalPolicy": "never", "sandboxPolicy": {"type": "dangerFullAccess"},
    });
    if profile.model != "default" {
        params["model"] = json!(profile.model);
    }
    if let Some(effort) = &req.effort {
        params["effort"] = json!(effort);
    }
    if let Some(tier) = &context.service_tier {
        params["serviceTier"] = json!(tier);
    }
    params
}

#[derive(Default)]
struct State {
    output: ModelOutput,
    thread: String,
    turn: Option<String>,
    messages: Vec<(String, String)>,
    reasoning: Vec<(String, Vec<String>)>,
    activity: Vec<(String, Value)>,
    completed: bool,
}

fn text_slot<'a>(items: &'a mut Vec<(String, String)>, id: &str) -> &'a mut String {
    let index = items
        .iter()
        .position(|(key, _)| key == id)
        .unwrap_or_else(|| {
            items.push((id.into(), String::new()));
            items.len() - 1
        });
    &mut items[index].1
}

impl State {
    fn item(&mut self, item: &Value) -> Result<(), ProviderError> {
        let id = item["id"].as_str().ok_or_else(invalid)?;
        match item["type"].as_str().unwrap_or("") {
            "agentMessage" => {
                *text_slot(&mut self.messages, id) = item["text"].as_str().unwrap_or("").into()
            }
            "reasoning" => {
                let summary = item["summary"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect();
                self.reasoning_slot(id).clone_from(&summary);
            }
            kind => {
                let status = match item["status"].as_str().unwrap_or("") {
                    "inProgress" => "in_progress",
                    other => other,
                };
                let value = match kind {
                    "commandExecution" => {
                        json!({"kind":"command","name":"shell","input":item["command"],
                        "status":status,"exit_code":item["exitCode"]})
                    }
                    "fileChange" => json!({"kind":"file_change","name":"file_change",
                        "input":summarize(&item["changes"]),"status":status}),
                    "mcpToolCall" => json!({"kind":"mcp_tool_call","name":item["tool"],
                        "input":summarize(&item["arguments"]),"status":status}),
                    "webSearch" => {
                        json!({"kind":"web_search","name":"web_search","input":summarize(&item["query"])})
                    }
                    // 새 item 종류를 Grove 도구 호출로 실행하지 않는다.
                    _ => return Ok(()),
                };
                if let Some((_, previous)) = self.activity.iter_mut().find(|(key, _)| key == id) {
                    *previous = value;
                } else {
                    self.activity.push((id.into(), value));
                }
            }
        }
        Ok(())
    }

    fn reasoning_slot(&mut self, id: &str) -> &mut Vec<String> {
        let index = self
            .reasoning
            .iter()
            .position(|(key, _)| key == id)
            .unwrap_or_else(|| {
                self.reasoning.push((id.into(), Vec::new()));
                self.reasoning.len() - 1
            });
        &mut self.reasoning[index].1
    }

    fn rebuild(&mut self) -> Result<(), ProviderError> {
        self.output.response_parts = self.messages.iter().map(|(_, text)| text.clone()).collect();
        self.output.text = self.output.response_parts.join("\n\n");
        self.output.reasoning = self
            .reasoning
            .iter()
            .flat_map(|(_, parts)| parts.iter().cloned())
            .collect::<Vec<_>>()
            .join("\n\n");
        self.output.activity = self.activity.iter().map(|(_, item)| item.clone()).collect();
        if self.messages.len() + self.reasoning.len() + self.activity.len() > MAX_ACTIVITY
            || self.output.text.len() + self.output.reasoning.len() > super::super::MAX_OUTPUT_BYTES
        {
            return Err(ProviderError::new(
                "output_too_large",
                "에이전트 응답 한도를 초과했습니다",
            ));
        }
        Ok(())
    }

    fn notification(&mut self, event: &Value) -> Result<bool, ProviderError> {
        let method = event["method"].as_str().unwrap_or("");
        let p = &event["params"];
        if p["threadId"].as_str() != Some(self.thread.as_str()) {
            return Ok(false);
        }
        if method == "turn/started" {
            let id = p["turn"]["id"].as_str().ok_or_else(invalid)?;
            if self.turn.as_deref().is_some_and(|current| current != id) {
                return Err(invalid());
            }
            self.turn = Some(id.into());
            return Ok(false);
        }
        let event_turn = if method == "turn/completed" {
            p["turn"]["id"].as_str()
        } else {
            p["turnId"].as_str()
        };
        if event_turn != self.turn.as_deref() || self.turn.is_none() {
            return Ok(false);
        }
        match method {
            "item/agentMessage/delta" => {
                let id = p["itemId"].as_str().ok_or_else(invalid)?;
                let delta = p["delta"].as_str().ok_or_else(invalid)?;
                text_slot(&mut self.messages, id).push_str(delta);
            }
            "item/reasoning/summaryTextDelta" => {
                let id = p["itemId"].as_str().ok_or_else(invalid)?;
                let index = p["summaryIndex"].as_u64().ok_or_else(invalid)?;
                if index >= MAX_ACTIVITY as u64 {
                    return Err(invalid());
                }
                let delta = p["delta"].as_str().ok_or_else(invalid)?;
                let parts = self.reasoning_slot(id);
                parts.resize_with(parts.len().max(index as usize + 1), String::new);
                parts[index as usize].push_str(delta);
            }
            // 원시 reasoning text가 아니라 CLI가 공개한 요약만 표시한다.
            "item/started" | "item/completed" => self.item(&p["item"])?,
            "thread/tokenUsage/updated" => {
                // 기존 exec와 같은 CLI thread 누적 사용량 계약을 유지한다.
                let u = &p["tokenUsage"]["total"];
                self.output.usage = Usage {
                    input_tokens: u["inputTokens"].as_u64().unwrap_or(0),
                    output_tokens: u["outputTokens"].as_u64().unwrap_or(0),
                    cache_read_tokens: u["cachedInputTokens"].as_u64().unwrap_or(0),
                    cache_write_tokens: u["cacheWriteInputTokens"].as_u64(),
                    reasoning_tokens: u["reasoningOutputTokens"].as_u64(),
                };
            }
            "error" if p["willRetry"] != true => {
                return Err(ProviderError::new(
                    "cli_failed",
                    "Codex 실행 중 오류가 발생했습니다",
                ));
            }
            "turn/completed" => {
                match p["turn"]["status"].as_str() {
                    Some("completed") => {}
                    Some("interrupted") => {
                        return Err(ProviderError::new(
                            "cli_exited",
                            "Codex 실행이 중단되었습니다",
                        ));
                    }
                    _ => {
                        return Err(ProviderError::new(
                            "cli_failed",
                            "Codex 실행이 실패했습니다",
                        ));
                    }
                }
                for item in p["turn"]["items"].as_array().into_iter().flatten() {
                    self.item(item)?;
                }
                self.output.finish_reason = "stop".into();
                self.completed = true;
            }
            _ => return Ok(false),
        }
        self.rebuild()?;
        Ok(true)
    }
}

fn invalid() -> ProviderError {
    ProviderError::new(
        "cli_protocol_error",
        "Codex app-server 응답 형식이 올바르지 않습니다",
    )
}

async fn send<W: AsyncWrite + Unpin>(writer: &mut W, value: &Value) -> Result<(), ProviderError> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| invalid())?;
    bytes.push(b'\n');
    writer
        .write_all(&bytes)
        .await
        .map_err(|_| ProviderError::new("cli_exited", "Codex 입력 연결이 종료되었습니다"))?;
    writer
        .flush()
        .await
        .map_err(|_| ProviderError::new("cli_exited", "Codex 입력을 전달하지 못했습니다"))
}

async fn receive<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    profile: &Profile,
    req: &ModelRequest,
) -> Result<Value, ProviderError> {
    let line = loop {
        match tokio::time::timeout(profile.timeout, read_line(reader)).await {
            Ok(result) => break result?,
            Err(_)
                if req
                    .cli
                    .as_ref()
                    .and_then(|c| c.computer.as_ref())
                    .is_some_and(|link| {
                        link.waiting.load(std::sync::atomic::Ordering::Acquire)
                    }) =>
            {
                continue;
            }
            Err(_) => {
                return Err(ProviderError::new(
                    "idle_timeout",
                    "Codex app-server의 출력이 없어 중단했습니다",
                ));
            }
        }
    }
    .ok_or_else(|| {
        ProviderError::new("cli_exited", "Codex app-server가 결과 없이 종료되었습니다")
    })?;
    serde_json::from_slice(&line).map_err(|_| invalid())
}

async fn notification<W: AsyncWrite + Unpin>(
    writer: &mut W,
    event: &Value,
    state: &mut State,
    on_delta: OnDelta<'_>,
) -> Result<(), ProviderError> {
    if event.get("id").is_some() && event.get("method").is_some() {
        // 답변·승인을 지어내거나 관리 정책을 우회하지 않고 지원하지 않는 요청을 명시적으로 끝낸다.
        send(writer, &json!({"id":event["id"],"error":{"code":-32601,"message":"Grove does not support interactive app-server requests"}})).await?;
        return Err(ProviderError::new(
            "cli_interaction_required",
            "Codex가 현재 지원하지 않는 대화형 확인을 요청했습니다",
        ));
    }
    if state.notification(event)? {
        on_delta(&state.output);
    }
    Ok(())
}

struct Call<'a> {
    id: u64,
    method: &'a str,
    params: Value,
}

async fn call<W: AsyncWrite + Unpin, R: AsyncRead + Unpin>(
    writer: &mut W,
    reader: &mut BufReader<R>,
    profile: &Profile,
    req: &ModelRequest,
    request: Call<'_>,
    state: &mut State,
    on_delta: OnDelta<'_>,
) -> Result<Value, ProviderError> {
    send(
        writer,
        &json!({"id":request.id,"method":request.method,"params":request.params}),
    )
    .await?;
    loop {
        let event = receive(reader, profile, req).await?;
        if event["id"].as_u64() == Some(request.id) && event.get("method").is_none() {
            if event.get("error").is_some() {
                // 인증·프로젝트 경로 등이 포함될 수 있는 원문 오류는 복제하지 않는다. 자동 재접수도 하지 않는다.
                return Err(ProviderError::new(
                    "cli_failed",
                    format!("Codex {} 요청이 거절되었습니다", request.method),
                ));
            }
            return event.get("result").cloned().ok_or_else(invalid);
        }
        notification(writer, &event, state, on_delta).await?;
    }
}

pub(super) async fn run<W: AsyncWrite + Unpin, R: AsyncRead + Unpin>(
    writer: &mut W,
    reader: &mut BufReader<R>,
    profile: &Profile,
    req: &ModelRequest,
    images: &[PathBuf],
    on_delta: OnDelta<'_>,
) -> Result<ModelOutput, ProviderError> {
    let mut state = State::default();
    call(
        writer,
        reader,
        profile,
        req,
        Call {
            id: 1,
            method: "initialize",
            params: json!({
                "clientInfo":{"name":"grove","title":"Grove","version":crate::VERSION},
                "capabilities":{"experimentalApi":true},
            }),
        },
        &mut state,
        on_delta,
    )
    .await?;
    send(writer, &json!({"method":"initialized"})).await?;
    let method = if req.cli.as_ref().and_then(|c| c.resume.as_ref()).is_some() {
        "thread/resume"
    } else {
        "thread/start"
    };
    let result = call(
        writer,
        reader,
        profile,
        req,
        Call {
            id: 2,
            method,
            params: thread_params(profile, req),
        },
        &mut state,
        on_delta,
    )
    .await?;
    state.thread = result["thread"]["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(invalid)?
        .into();
    state.output.native_session = Some(state.thread.clone());
    let params = turn_params(profile, req, &state.thread, images);
    let result = call(
        writer,
        reader,
        profile,
        req,
        Call {
            id: 3,
            method: "turn/start",
            params,
        },
        &mut state,
        on_delta,
    )
    .await?;
    let turn = result["turn"]["id"].as_str().ok_or_else(invalid)?;
    if state.turn.as_deref().is_some_and(|id| id != turn) {
        return Err(invalid());
    }
    state.turn = Some(turn.into());
    while !state.completed {
        let event = receive(reader, profile, req).await?;
        notification(writer, &event, &mut state, on_delta).await?;
    }
    Ok(state.output)
}

#[cfg(test)]
#[path = "codex_tests.rs"]
mod tests;
