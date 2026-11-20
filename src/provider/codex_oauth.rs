//! Codex Responses 호출. 대화와 도구 실행은 Grove가 소유한다.
use super::{AvailableModel, ChatMsg, ModelOutput, ModelRequest, ModelServiceTier, NativeContent, OnDelta,
    Profile, ProviderError, ToolCall, Usage, parse_arguments};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashSet, path::PathBuf, time::Duration};
use tokio::io::AsyncReadExt;

mod ws;
pub(crate) use ws::Session;

pub(crate) const PROTOCOL: &str = "codex_oauth";
pub(crate) const BASE: &str = "https://chatgpt.com/backend-api/codex";
// 모델 목록은 Codex backend가 이해하는 client_version을 요구한다.
const CLIENT_VERSION: &str = "0.169.1";

#[derive(Deserialize)]
struct AuthFile {
    auth_mode: Option<String>,
    tokens: Option<Credentials>,
}

#[derive(Deserialize)]
struct Credentials {
    access_token: String,
    account_id: Option<String>,
}

impl Credentials {
    fn scope(&self) -> Option<String> {
        self.account_id.as_ref().map(|id| crate::util::sha256_hex(id.as_bytes()))
    }
}

fn auth_required() -> ProviderError {
    ProviderError::new("auth_failed", "Codex 계정 로그인이 필요합니다. Grove의 Codex 계정 설정에서 로그인하세요")
}

fn decode_credentials(bytes: &[u8]) -> Result<Credentials, ProviderError> {
    let auth: AuthFile = serde_json::from_slice(bytes).map_err(|_| auth_required())?;
    if auth.auth_mode.as_deref().is_some_and(|mode| mode != "chatgpt") {
        return Err(auth_required());
    }
    auth.tokens.filter(|tokens| !tokens.access_token.is_empty()).ok_or_else(auth_required)
}

async fn credentials() -> Result<Credentials, ProviderError> {
    let home = std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()).map(PathBuf::from)
        .or_else(|| std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .filter(|value| !value.is_empty()).map(|path| PathBuf::from(path).join(".codex")))
        .filter(|path| path.is_absolute()).ok_or_else(auth_required)?;
    let mut bytes = Vec::new();
    tokio::fs::File::open(home.join("auth.json")).await.map_err(|_| auth_required())?
        .take(128 * 1024 + 1).read_to_end(&mut bytes).await.map_err(|_| auth_required())?;
    if bytes.len() > 128 * 1024 { return Err(auth_required()); }
    decode_credentials(&bytes)
}

fn authorize(request: reqwest::RequestBuilder, auth: &Credentials) -> reqwest::RequestBuilder {
    let request = request.bearer_auth(&auth.access_token)
        .header("originator", "codex_cli_rs")
        .header("user-agent", format!("codex_cli_rs/{CLIENT_VERSION}"))
        .header("openai-beta", "responses=experimental");
    match &auth.account_id {
        Some(account) => request.header("chatgpt-account-id", account),
        None => request,
    }
}

async fn send_authorized(request: reqwest::RequestBuilder, auth: &Credentials, request_id: &mut Option<String>) -> Result<reqwest::Response, ProviderError> {
    let response = super::send(authorize(request, auth)).await?;
    *request_id = response.headers().get("x-request-id").and_then(|id| id.to_str().ok())
        .and_then(safe_request_id).map(str::to_owned);
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let mut error = super::http_error(response).await;
        // 분류와 Retry-After만 쓰고 OAuth 자격이 반사될 수 있는 원문은 반환하지 않는다.
        error.message = if status == 401 { auth_required().message }
            else { format!("Codex API 요청이 실패했습니다 (HTTP {status})") };
        return Err(error);
    }
    Ok(response)
}

async fn send_with_refresh(request: reqwest::RequestBuilder, auth: &mut Credentials, request_id: &mut Option<String>) -> Result<reqwest::Response, ProviderError> {
    let first = request.try_clone().ok_or_else(invalid)?;
    match send_authorized(first, auth, request_id).await {
        Err(error) if error.status == Some(401) => {
            // Desktop과 같은 refresh token을 직접 갱신하지 않는다. 공식 계정 경로만 사용한다.
            static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
            let lock = REFRESH.lock().await;
            let mut current = credentials().await?;
            if current.account_id != auth.account_id { return Err(error); }
            if current.access_token == auth.access_token {
                super::cli::refresh_codex_account().await.map_err(|_| auth_required())?;
                current = credentials().await?;
            }
            if current.access_token == auth.access_token || current.account_id != auth.account_id {
                return Err(error);
            }
            *auth = current;
            drop(lock);
            *request_id = None;
            send_authorized(request, auth, request_id).await
        }
        result => result,
    }
}

fn catalog_invalid() -> ProviderError {
    ProviderError::new("catalog_invalid", "Codex 모델 목록 응답 형식이 올바르지 않습니다")
}

fn decode_catalog(value: &Value) -> Result<Vec<AvailableModel>, ProviderError> {
    let rows = value["models"].as_array().ok_or_else(catalog_invalid)?;
    if rows.len() > 2000 { return Err(catalog_invalid()); }
    let mut visible = rows.iter().filter(|row| row["visibility"] != "hide" && row["hidden"] != true).collect::<Vec<_>>();
    visible.sort_by_key(|row| row["priority"].as_i64().unwrap_or(i64::MAX));
    let mut ids = HashSet::new();
    let mut models = Vec::new();
    for row in visible {
        let id = row["slug"].as_str().or_else(|| row["id"].as_str())
            .filter(|id| !id.is_empty() && id.len() <= 200 && !id.contains(char::is_whitespace))
            .ok_or_else(catalog_invalid)?;
        if !ids.insert(id) { continue; }
        let reasoning_efforts = row["supported_reasoning_levels"].as_array().map(|levels| {
            levels.iter().filter_map(|level| level["effort"].as_str())
                .filter(|effort| super::parse_effort(Some(effort)).is_ok_and(|value| value.is_some()))
                .map(str::to_owned).collect()
        });
        let service_tiers = row["service_tiers"].as_array().map(|tiers| tiers.iter().filter_map(|tier| {
            let id = tier["id"].as_str()?;
            super::parse_service_tier(Some(id)).ok()?;
            Some(ModelServiceTier {
                id: id.into(),
                name: tier["name"].as_str().unwrap_or(id).chars().take(200).collect(),
                description: tier["description"].as_str().unwrap_or("").chars().take(2000).collect(),
            })
        }).take(20).collect());
        models.push(AvailableModel {
            id: id.into(),
            name: row["display_name"].as_str().unwrap_or(id).chars().take(200).collect(),
            reasoning_efforts, service_tiers,
            default_reasoning_effort: row["default_reasoning_level"].as_str().map(str::to_owned),
            is_default: Some(models.is_empty()),
        });
    }
    Ok(models)
}

pub(super) async fn list_models() -> Result<Vec<AvailableModel>, ProviderError> {
    catalog(&mut credentials().await?).await
}

async fn catalog(auth: &mut Credentials) -> Result<Vec<AvailableModel>, ProviderError> {
    let client = super::http_client(Duration::from_secs(15));
    let mut response = send_with_refresh(client.get(format!("{BASE}/models")).query(&[("client_version", CLIENT_VERSION)]), auth, &mut None).await?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(super::transport_error)? {
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 { return Err(catalog_invalid()); }
        bytes.extend_from_slice(&chunk);
    }
    let models = decode_catalog(&serde_json::from_slice(&bytes).map_err(|_| catalog_invalid())?)?;
    if serde_json::to_string(&models).map_err(|_| catalog_invalid())?.contains(&auth.access_token) {
        return Err(catalog_invalid());
    }
    Ok(models)
}

fn request_body(model: &str, req: &ModelRequest, service_tier: Option<&str>, scope: Option<&str>) -> Value {
    let mut input = Vec::new();
    // 도구가 현재 컨텍스트 창 앞에서 잘렸으면 짝 없는 결과를 보내지 않는다.
    let mut calls = HashSet::new();
    for message in &req.messages {
        match message {
            ChatMsg::User { text, images } => {
                let mut parts = Vec::new();
                if !text.is_empty() { parts.push(json!({"type":"input_text","text":text})); }
                parts.extend(images.iter().map(|image| json!({"type":"input_image",
                    "image_url":format!("data:{};base64,{}",image.mime,image.data)})));
                if !parts.is_empty() { input.push(json!({"role":"user","content":parts})); }
            }
            ChatMsg::Assistant { text, tool_calls, native } => {
                // API 호출에서 만든 암호화 reasoning은 같은 모델에만 돌려준다.
                if let (Some(native), Some(scope)) = (native.as_ref().filter(|native| native.protocol == PROTOCOL), scope) {
                    input.extend(native.blocks.iter().filter(|item| item["model"] == model && item["scope"] == scope)
                        .filter_map(|item| item.get("reasoning")).cloned());
                }
                if !text.is_empty() { input.push(json!({"role":"assistant","content":[{"type":"output_text","text":text}]})); }
                for call in tool_calls {
                    calls.insert(call.id.as_str());
                    input.push(json!({"type":"function_call","call_id":call.id,"name":call.name,"arguments":call.arguments.to_string()}));
                }
            }
            ChatMsg::Tool { call_id, content, is_error, .. } if calls.remove(call_id.as_str()) => {
                let output = if *is_error { format!("도구 실행 실패: {content}") } else { content.clone() };
                input.push(json!({"type":"function_call_output","call_id":call_id,"output":output}));
            }
            ChatMsg::Tool { .. } => {}
        }
    }
    let tools = req.tools.iter().map(|tool| json!({"type":"function","name":tool.name,
        "description":tool.description,"parameters":tool.schema,"strict":false})).collect::<Vec<_>>();
    let instructions = if req.system.trim().is_empty() { "You are a helpful assistant." } else { &req.system };
    let mut body = json!({"model":model,"instructions":instructions,"input":input,"tools":tools,
        "tool_choice":"auto","parallel_tool_calls":true,"stream":true,"store":false,
        "include":["reasoning.encrypted_content"]});
    if let Some(effort) = &req.effort { body["reasoning"] = json!({"effort":effort,"summary":"auto"}); }
    if let Some(tier) = service_tier.filter(|tier| *tier != "default") { body["service_tier"] = json!(tier); }
    body
}

fn invalid() -> ProviderError {
    ProviderError::new("bad_frame", "Codex 응답 형식이 올바르지 않습니다")
}

fn safe_request_id(id: &str) -> Option<&str> {
    (id.len() <= 80 && (id.strip_prefix("req_").is_some_and(|tail| !tail.is_empty()
        && tail.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')))
        || uuid::Uuid::parse_str(id).is_ok())).then_some(id)
}

fn observe_request_id(slot: &mut Option<String>, event: &Value) {
    if slot.is_none() {
        *slot = [&event["request_id"], &event["error"]["request_id"], &event["response"]["request_id"]]
            .into_iter().filter_map(Value::as_str).find_map(safe_request_id).map(str::to_owned);
    }
}

#[derive(Default)]
struct RequestDiagnostics {
    frame_input_items: Option<usize>,
    request_id: Option<String>,
}

impl RequestDiagnostics {
    fn log_failure(&self, transport: &'static str, body: &Value, model: &str, auth: &Credentials, error: &ProviderError) {
        // 마지막 JSON의 구조만 기록한다. 지침·본문·도구 인자/출력·reasoning은 기록하지 않는다.
        let input = body["input"].as_array().map_or(&[][..], Vec::as_slice);
        let (mut users, mut assistants, mut calls, mut results, mut reasoning, mut images) = (0, 0, 0, 0, 0, 0);
        for item in input {
            match (item["type"].as_str(), item["role"].as_str()) {
                (Some("function_call"), _) => calls += 1,
                (Some("function_call_output"), _) => results += 1,
                (Some("reasoning"), _) => reasoning += 1,
                (_, Some("assistant")) => assistants += 1,
                (_, Some("user")) => {
                    users += 1;
                    images += item["content"].as_array().into_iter().flatten()
                        .filter(|part| part["type"] == "input_image").count();
                }
                _ => {}
            }
        }
        let contains_credential = |value: &str| value == auth.access_token
            || (auth.access_token.len() >= 16 && value.contains(&auth.access_token))
            || auth.account_id.as_deref().is_some_and(|id| !id.is_empty() && value.contains(id));
        let model = (model.len() <= 200 && model.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b':'))
            && !model.starts_with("sk-") && !model.starts_with("sk_") && !contains_credential(model)).then_some(model);
        let stream = error.stream_failure.as_ref();
        tracing::warn!(transport, model, provider_request_id = self.request_id.as_deref().filter(|id| !contains_credential(id)),
            error_code = error.code, http_status = error.status, retryable = error.retryable,
            provider_event = stream.map(|f| f.event),
            provider_code = stream.and_then(|f| f.code.as_deref()).filter(|code| !contains_credential(code)),
            incomplete_reason = stream.and_then(|f| f.incomplete_reason.as_deref()).filter(|reason| !contains_credential(reason)),
            context_input_items = input.len(), frame_input_items = self.frame_input_items,
            frame_input_start = self.frame_input_items.map(|n| input.len() - n),
            user_items = users, assistant_items = assistants, tool_calls = calls, tool_results = results,
            reasoning_items = reasoning, image_parts = images, tool_defs = body["tools"].as_array().map_or(0, Vec::len),
            "Codex 요청 실패");
    }
}

/// 자유 형식 메시지·URL·토큰을 제외하고 짧은 기계 식별자만 기록한다.
fn failure_identifier(value: &Value) -> Option<&str> {
    let text = value.as_str()?;
    (text.len() <= 64 && text.starts_with(|c: char| c.is_ascii_lowercase())
        && !text.starts_with("sk_") && !text.starts_with("sess_")
        && text.split('_').all(|part| !part.is_empty() && part.len() <= 24
            && part.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())))
        .then_some(text)
}

fn response_failure(event: &'static str, value: &Value) -> ProviderError {
    let response = &value["response"];
    let code = failure_identifier(&response["error"]["code"])
        .or_else(|| failure_identifier(&value["error"]["code"]))
        .or_else(|| failure_identifier(&value["code"]));
    let reason = failure_identifier(&response["incomplete_details"]["reason"])
        .or_else(|| failure_identifier(&value["incomplete_details"]["reason"]));
    let mut error = match code.or(reason) {
        Some("context_length_exceeded" | "context_window_exceeded") => ProviderError::new("context_length_exceeded", "Codex 모델의 문맥 용량을 초과했습니다"),
        Some("content_filter") => ProviderError::new("blocked", "Codex가 응답을 차단했습니다"),
        Some("server_is_overloaded") => ProviderError::new("provider_failed", "Codex 서버가 일시적으로 과부하 상태입니다"),
        _ => ProviderError::new("provider_failed", "Codex API가 응답을 완료하지 못했습니다"),
    };
    error.retryable = matches!(code, Some("server_is_overloaded" | "server_error" | "temporarily_unavailable"));
    error.stream_failure = Some(super::StreamFailure {
        event,
        code: code.map(str::to_owned),
        incomplete_reason: reason.map(str::to_owned),
    });
    error
}

fn complete(out: &mut ModelOutput, response: &Value, model: &str, scope: Option<&str>) -> Result<(), ProviderError> {
    let items = response["output"].as_array().ok_or_else(invalid)?;
    let mut ids = HashSet::new();
    let mut reasoning = Vec::new();
    out.text.clear();
    for item in items {
        match item["type"].as_str() {
            Some("message") => {
                for part in item["content"].as_array().ok_or_else(invalid)? {
                    match part["type"].as_str() {
                        Some("output_text") => out.text.push_str(part["text"].as_str().ok_or_else(invalid)?),
                        Some("refusal") => out.text.push_str(part["refusal"].as_str().ok_or_else(invalid)?),
                        _ => {}
                    }
                }
            }
            Some("function_call") => {
                let id = item["call_id"].as_str().filter(|id| !id.is_empty()).ok_or_else(invalid)?;
                if !ids.insert(id) || item["status"].as_str().is_some_and(|status| status != "completed") { return Err(invalid()); }
                out.tool_calls.push(ToolCall { id: id.into(),
                    name: item["name"].as_str().filter(|name| !name.is_empty()).ok_or_else(invalid)?.into(),
                    arguments: parse_arguments(item["arguments"].as_str().ok_or_else(invalid)?),
                });
            }
            Some("reasoning") if scope.is_some() && item["encrypted_content"].is_string()
                && item["id"].is_string() && item["summary"].is_array() => {
                reasoning.push(json!({"model":model,"scope":scope,"reasoning":{
                    "type":"reasoning","id":item["id"],"summary":item["summary"],
                    "encrypted_content":item["encrypted_content"],
                }}));
            }
            _ => {}
        }
    }
    if out.text.is_empty() && out.tool_calls.is_empty() { return Err(invalid()); }
    let usage = &response["usage"];
    let input = usage["input_tokens"].as_u64();
    out.usage = Usage {
        input_tokens: input.unwrap_or(0),
        output_tokens: usage["output_tokens"].as_u64().unwrap_or(0),
        cache_read_tokens: usage["input_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0),
        reasoning_tokens: usage["output_tokens_details"]["reasoning_tokens"].as_u64(),
        ..Default::default()
    };
    // input_tokens는 이 요청의 입력량이다. 현재 문맥 점유량(CLI의 context_usage)으로 보고하지 않고,
    // context 계산의 실측 경로(실측 입력 + 이후 메시지 추정)가 usage로 처리한다.
    if !reasoning.is_empty() {
        // protocol·endpoint·프로필 모델은 공용 provider stream에서 채운다.
        out.native = Some(NativeContent { protocol: String::new(), base_url: String::new(), model: String::new(), blocks: reasoning });
    }
    out.finish_reason = if out.tool_calls.is_empty() { "stop" } else { "tool_calls" }.into();
    Ok(())
}

// 한 응답이 완료되기 전에는 도구 호출을 runner에 넘기지 않는다.
fn read_event(value: &Value, out: &mut ModelOutput, model: &str, scope: Option<&str>, on_delta: OnDelta<'_>) -> Result<bool, ProviderError> {
    match value["type"].as_str() {
        Some("response.completed") => {
            complete(out, &value["response"], model, scope)?;
            return Ok(true);
        }
        Some("response.failed") => return Err(response_failure("response.failed", value)),
        Some("response.incomplete") => return Err(response_failure("response.incomplete", value)),
        Some("error") => return Err(response_failure("error", value)),
        Some("response.output_text.delta" | "response.refusal.delta") => {
            out.text.push_str(value["delta"].as_str().ok_or_else(invalid)?);
        }
        Some("response.reasoning_summary_text.delta") => {
            out.reasoning.push_str(value["delta"].as_str().ok_or_else(invalid)?);
        }
        _ => return Ok(false),
    }
    on_delta(out);
    Ok(false)
}

async fn read_response(resp: reqwest::Response, model: &str, scope: Option<&str>, request_id: &mut Option<String>, mut on_delta: OnDelta<'_>) -> Result<ModelOutput, ProviderError> {
    let mut out = ModelOutput::default();
    let completed = super::sse::read_events(resp, |frame| {
        if frame.data.is_empty() || frame.data == "[DONE]" { return Ok(false); }
        let value: Value = serde_json::from_str(&frame.data).map_err(|_| invalid())?;
        observe_request_id(request_id, &value);
        read_event(&value, &mut out, model, scope, &mut on_delta)
    }).await?;
    if !completed {
        return Err(ProviderError::new("stream_incomplete", "Codex 응답이 완료 신호 없이 끊겼습니다"));
    }
    Ok(out)
}

pub(super) async fn stream(client: &reqwest::Client, profile: &Profile, req: &ModelRequest,
    service_tier: Option<&str>, session: &mut Session, on_delta: OnDelta<'_>) -> Result<ModelOutput, ProviderError> {
    #[cfg(test)]
    let fixture = session.fixture.clone();
    #[cfg(test)]
    let mut auth = match &fixture {
        Some(_) => Credentials { access_token: "fixture".into(), account_id: Some("test-account".into()) },
        None => credentials().await?,
    };
    #[cfg(not(test))]
    let mut auth = credentials().await?;
    let resolved;
    let model = if profile.model == "default" {
        resolved = catalog(&mut auth).await?;
        &resolved.first().ok_or_else(catalog_invalid)?.id
    } else { &profile.model };
    let scope = auth.scope();
    let body = request_body(model, req, service_tier, scope.as_deref());
    if let Some(out) = session.send(&auth, &body, model, scope.as_deref(), profile.timeout, on_delta).await? {
        return Ok(out);
    }
    stream_sse(client, &mut auth, &body, model, scope.as_deref(), &session.sse_url(), on_delta).await
}

async fn stream_sse(client: &reqwest::Client, auth: &mut Credentials, body: &Value, model: &str,
    scope: Option<&str>, url: &str, on_delta: OnDelta<'_>) -> Result<ModelOutput, ProviderError> {
    let mut diagnostics = RequestDiagnostics {
        frame_input_items: body["input"].as_array().map(Vec::len), ..Default::default()
    };
    let result = async {
        let response = send_with_refresh(client.post(url).header("accept", "text/event-stream").json(body), auth, &mut diagnostics.request_id).await?;
        read_response(response, model, scope, &mut diagnostics.request_id, on_delta).await
    }.await;
    if let Err(error) = &result {
        diagnostics.log_failure("sse", body, model, auth, error);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{ImageInput, ToolDef};

    #[test]
    fn request_uses_grove_history_and_disables_response_storage() {
        let mut request = ModelRequest {
            system: "instructions, not first user text".into(),
            messages: vec![
                ChatMsg::Tool { call_id: "orphan".into(), name: "read".into(), content: "old".into(), is_error: false },
                ChatMsg::User { text: "first message".into(), images: vec![] },
                ChatMsg::Assistant { text: "checking".into(), native: None,
                    tool_calls: vec![ToolCall { id: "call_read".into(), name: "read".into(), arguments: json!({"path":"README.md"}) }] },
                ChatMsg::Tool { call_id: "call_read".into(), name: "read".into(), content: "file content".into(), is_error: false },
                ChatMsg::User { text: "follow-up".into(), images: vec![ImageInput {
                    id: "image".into(), sha256: "fixture".into(), width: 1, height: 1,
                    mime: "image/png".into(), data: "AAAA".into(),
                }] },
            ],
            tools: vec![ToolDef { name: "read".into(), description: "Read a file".into(), schema: json!({"type":"object"}) }],
            max_tokens: None, temperature: None, effort: Some("high".into()), cli: None,
        };
        let body = request_body("gpt-test", &request, Some("priority"), None);
        assert_eq!(body["store"], false);
        assert_eq!(body["include"][0], "reasoning.encrypted_content");
        assert_eq!(body["instructions"], "instructions, not first user text");
        assert_eq!(body["input"].as_array().unwrap().len(), 5);
        assert_eq!(body["input"][0]["content"][0]["text"], "first message");
        assert_eq!(body["input"][2]["call_id"], "call_read");
        assert_eq!(body["input"][3]["output"], "file content");
        assert_eq!(body["input"][4]["content"][1]["image_url"], "data:image/png;base64,AAAA");
        assert_eq!(body["tools"][0]["parameters"], json!({"type":"object"}));
        assert_eq!(body["reasoning"]["effort"], "high");
        assert_eq!(body["service_tier"], "priority");
        assert!(body.get("previous_response_id").is_none());
        assert!(request_body("gpt-test", &request, Some("default"), None).get("service_tier").is_none());
        let ChatMsg::Assistant { native, .. } = &mut request.messages[2] else { unreachable!() };
        *native = Some(NativeContent { protocol: PROTOCOL.into(), base_url: String::new(), model: "default".into(),
            blocks: vec![json!({"model":"gpt-test","scope":"fixture-scope","reasoning":{"type":"reasoning","encrypted_content":"fixture-ciphertext"}})] });
        assert_eq!(request_body("gpt-test", &request, None, Some("fixture-scope"))["input"][1]["type"], "reasoning");
        assert_eq!(request_body("other-model", &request, None, Some("fixture-scope"))["input"].as_array().unwrap().len(), 5);
        assert_eq!(request_body("gpt-test", &request, None, Some("other-scope"))["input"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn oauth_file_and_catalog_distinguish_auth_modes_and_hidden_models() {
        let auth = decode_credentials(br#"{"auth_mode":"chatgpt","tokens":{"access_token":"fixture","account_id":"test-account"}}"#).unwrap();
        assert_eq!(auth.account_id.as_deref(), Some("test-account"));
        assert!(decode_credentials(br#"{"auth_mode":"apikey","OPENAI_API_KEY":"fixture"}"#).is_err());
        let models = decode_catalog(&json!({"models":[
            {"slug":"old","priority":3},
            {"slug":"hidden","visibility":"hide","priority":0},
            {"slug":"new","priority":1,"supported_reasoning_levels":[{"effort":"high"}],
             "service_tiers":[{"id":"priority","name":"Fast"}]}
        ]})).unwrap();
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["new", "old"]);
        assert_eq!(models[0].is_default, Some(true));
        assert_eq!(models[0].reasoning_efforts.as_deref().unwrap(), ["high"]);
        assert_eq!(models[0].service_tiers.as_ref().unwrap()[0].id, "priority");
    }

    #[test]
    fn failure_details_accept_identifiers_but_not_provider_text() {
        let error = response_failure("response.incomplete", &json!({"response":{
            "error":{"code":"context_window_exceeded","message":"private request text"},
            "incomplete_details":{"reason":"max_output_tokens"}
        }}));
        assert_eq!(error.code, "context_length_exceeded");
        assert!(!error.retryable);
        assert_eq!(error.to_json()["provider_stream"], json!({
            "event":"response.incomplete", "code":"context_window_exceeded", "incomplete_reason":"max_output_tokens"
        }));
        assert!(!error.to_json().to_string().contains("private request text"));
        for unsafe_value in ["Bearer not-a-code", "https://example.test", "aaa.bbb.ccc", "sk_fixture", "sess_fixture",
            "abcdefghijklmnopqrstuvwxyz0123456789", "<img>", ""] {
            let error = response_failure("error", &json!({
                "code":unsafe_value, "incomplete_details":{"reason":unsafe_value}, "message":"private request text"
            }));
            assert_eq!(error.to_json()["provider_stream"], json!({"event":"error"}), "{unsafe_value:?}");
        }
    }

    #[tokio::test]
    async fn publishes_text_deltas_but_returns_tools_only_on_completed_response() {
        use axum::{Router, extract::Path, http::HeaderMap, response::IntoResponse, routing::post};
        async fn fixture(Path(mode): Path<String>, headers: HeaderMap) -> impl IntoResponse {
            assert_eq!(headers["authorization"], "Bearer fixture");
            assert_eq!(headers["chatgpt-account-id"], "test-account");
            let mut stream = format!("data: {}\n\n", json!({"type":"response.output_text.delta","delta":"checking"}));
            if mode == "complete" {
                stream.push_str(&format!("data: {}\n\n", json!({"type":"response.completed","response":{
                    "output":[{"type":"reasoning","id":"rs_fixture","summary":[],"encrypted_content":"fixture-ciphertext"},
                        {"type":"message","content":[{"type":"output_text","text":"checking"}]},
                        {"type":"function_call","call_id":"call_read","name":"read","arguments":"{}","status":"completed"}],
                    "usage":{"input_tokens":100,"output_tokens":9,"input_tokens_details":{"cached_tokens":80}}
                }})));
            } else if mode == "failed" {
                stream.push_str(&format!("data: {}\n\n", json!({"type":"response.failed","response":{
                    "error":{"code":"server_error","message":"private provider text"}
                }})));
            } else if mode == "incomplete" {
                stream.push_str(&format!("data: {}\n\n", json!({"type":"response.incomplete","response":{
                    "error":null,"incomplete_details":{"reason":"max_output_tokens"}
                }})));
            } else if mode == "error" {
                stream.push_str(&format!("data: {}\n\n", json!({"type":"error","code":"rate_limit_exceeded"})));
            }
            ([("content-type", "text/event-stream")], stream)
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, Router::new().route("/{mode}", post(fixture))).await.unwrap(); });
        let auth = Credentials { access_token: "fixture".into(), account_id: Some("test-account".into()) };
        let client = super::super::http_client(Duration::from_secs(5));
        let resp = send_authorized(client.post(format!("http://{addr}/complete")), &auth, &mut None).await.unwrap();
        let mut deltas = 0;
        let out = read_response(resp, "gpt-test", Some("fixture-scope"), &mut None, &mut |delta| {
            deltas += 1;
            assert_eq!(delta.text, "checking");
            assert!(delta.tool_calls.is_empty());
        }).await.unwrap();
        assert_eq!(deltas, 1);
        assert_eq!(out.tool_calls[0].id, "call_read");
        assert_eq!(out.usage.cache_read_tokens, 80);
        assert!(out.native_session.is_none());
        assert_eq!(out.native.unwrap().blocks[0]["reasoning"]["encrypted_content"], "fixture-ciphertext");
        for (mode, detail) in [
            ("failed", json!({"event":"response.failed","code":"server_error"})),
            ("incomplete", json!({"event":"response.incomplete","incomplete_reason":"max_output_tokens"})),
            ("error", json!({"event":"error","code":"rate_limit_exceeded"})),
        ] {
            let resp = send_authorized(client.post(format!("http://{addr}/{mode}")), &auth, &mut None).await.unwrap();
            let error = read_response(resp, "gpt-test", Some("fixture-scope"), &mut None, &mut |_| {}).await.unwrap_err();
            let stored = error.to_json();
            assert_eq!(stored["code"], "provider_failed");
            assert_eq!(stored["provider_stream"], detail);
            assert!(!stored.to_string().contains("private provider text"));
        }
        let resp = send_authorized(client.post(format!("http://{addr}/eof")), &auth, &mut None).await.unwrap();
        let error = read_response(resp, "gpt-test", Some("fixture-scope"), &mut None, &mut |_| {}).await.unwrap_err();
        assert_eq!(error.code, "stream_incomplete");
        assert!(error.to_json().get("provider_stream").is_none());
        server.abort();
    }
}
