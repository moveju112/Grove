//! 일반 Codex 대화의 stdio app-server 연결. 제목·요약용 exec와 달리 실제 text delta를 받는다.

use super::{
    MAX_ACTIVITY, ChatMsg, ContextUsage, ModelOutput, ModelRequest, OnDelta, Profile, ProviderError, Usage,
    summarize,
};
use serde_json::{Value, json};
use std::path::PathBuf;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

// turn/completed는 이미지 원문도 다시 포함한다. 텍스트 CLI의 줄 제한과 분리한다.
const MAX_IMAGE_EVENT_BYTES: usize = (crate::attachments::MAX_MESSAGE_BYTES as usize).div_ceil(3)
    * 4 + super::super::MAX_OUTPUT_BYTES + super::MAX_LINE_BYTES;

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
    usage_baseline: Usage,
    thread: String,
    cwd: PathBuf,
    turn: Option<String>,
    messages: Vec<(String, String)>,
    reasoning: Vec<(String, Vec<String>)>,
    activity: Vec<(String, Value)>,
    viewed_images: std::collections::HashSet<String>,
    completed: bool,
}

fn token_usage(value: &Value) -> Usage {
    Usage {
        input_tokens: value["inputTokens"].as_u64().unwrap_or(0),
        output_tokens: value["outputTokens"].as_u64().unwrap_or(0),
        cache_read_tokens: value["cachedInputTokens"].as_u64().unwrap_or(0),
        cache_write_tokens: value["cacheWriteInputTokens"].as_u64(),
        reasoning_tokens: value["reasoningOutputTokens"].as_u64(),
    }
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

fn generated_image_root() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(||
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(|home| PathBuf::from(home).join(".codex")))
        .filter(|home| home.is_absolute()).map(|home| home.join("generated_images"))
}

fn image_cache_root(env: impl Fn(&str) -> Option<std::ffi::OsString>) -> Option<PathBuf> {
    let absolute = |key: &str| env(key).map(PathBuf::from).filter(|path| path.is_absolute()
        && path.file_name().is_some()
        && !path.components().any(|part| matches!(part, std::path::Component::ParentDir)));
    // 공용 view_image 훅의 기본 위치와 명시적으로 설정한 캐시만 허용한다.
    absolute("AGENTS_IMAGE_CACHE").or_else(|| absolute(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(|home| home.join(".cache/agents/image-downscale")))
}

fn image_path(raw: &str) -> Option<PathBuf> {
    if raw.starts_with("file:") {
        let url = reqwest::Url::parse(raw).ok()?;
        if !url.username().is_empty() || url.password().is_some() || url.query().is_some()
            || url.fragment().is_some() || url.host_str().is_some_and(|host| host != "localhost") { return None; }
        let path = url.to_file_path().ok()?;
        return (!path.to_string_lossy().contains('\0')).then_some(path);
    }
    // URL을 프로젝트 상대 파일명으로 해석하지 않는다.
    (!raw.contains("://")).then(|| PathBuf::from(raw))
}

impl State {
    fn preview_unavailable(&mut self, id: &str) {
        self.output.generated_images.retain(|image| image.id != id);
        self.activity.push((format!("{id}/preview"), json!({
            "kind":"image_view", "name":"이미지 미리보기 첨부", "status":"failed",
            "input":"조회한 이미지의 미리보기 사본을 보관하지 못했습니다",
        })));
        tracing::warn!(code="image_preview_unavailable", "조회 이미지 미리보기 보관 실패");
    }

    /// 완료 알림 직후 capability 경계 안에서 사본을 확보한다. 턴 종료 때 임시 파일을 다시 읽지 않는다.
    async fn snapshot_images(&mut self) -> Result<(), ProviderError> {
        use crate::provider::GeneratedImageSource;
        use base64::{Engine, engine::general_purpose::STANDARD};
        let files: Vec<_> = self.output.generated_images.iter().filter_map(|image| match &image.source {
            GeneratedImageSource::File { root, path } => Some((image.id.clone(), root.clone(), path.clone())),
            _ => None,
        }).collect();
        for (id, root, path) in files {
            let result = tokio::task::spawn_blocking(move || {
                let bytes = crate::project_fs::ProjectFs::open(&root)
                    .and_then(|fs| fs.read(&path, crate::attachments::MAX_FILE_BYTES as u64))?;
                // 조회용 사본의 형식 오류도 최종 답변 transaction을 실패시키지 않는다.
                if !matches!(crate::attachments::sniff(&bytes), "image/png" | "image/jpeg" | "image/gif" | "image/webp") {
                    return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid image"));
                }
                crate::attachments::model_image(&bytes)
                    .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid image"))?;
                Ok::<_, std::io::Error>(STANDARD.encode(bytes))
            }).await.map_err(|_| ProviderError::new("image_output_unavailable", "이미지 사본을 확보하지 못했습니다"))?;
            let encoded = match result {
                Ok(encoded) => encoded,
                Err(_) if self.viewed_images.contains(&id) => { self.preview_unavailable(&id); continue; }
                Err(_) => return Err(ProviderError::new("image_output_unavailable", "생성 이미지 원문을 확보하지 못했습니다")),
            };
            let used: usize = self.output.generated_images.iter().map(|image| match &image.source {
                GeneratedImageSource::Base64(data) => data.len(), _ => 0,
            }).sum();
            if used + encoded.len() > (crate::attachments::MAX_MESSAGE_BYTES as usize).div_ceil(3) * 4 {
                if self.viewed_images.contains(&id) { self.preview_unavailable(&id); continue; }
                return Err(ProviderError::new("output_too_large", "이미지 크기가 첨부 한도를 넘었습니다"));
            }
            if let Some(image) = self.output.generated_images.iter_mut().find(|image| image.id == id) {
                image.source = GeneratedImageSource::Base64(encoded);
            }
        }
        Ok(())
    }

    fn image(&mut self, id: String, source: super::super::GeneratedImageSource) -> Result<(), ProviderError> {
        use super::super::GeneratedImageSource;
        if self.output.generated_images.iter().any(|image| image.id == id) { return Ok(()); }
        if self.output.generated_images.len() >= crate::attachments::MAX_ATTACHMENTS {
            if self.viewed_images.contains(&id) { self.preview_unavailable(&id); return Ok(()); }
            if let Some(preview) = self.output.generated_images.iter().find(|image| self.viewed_images.contains(&image.id)).map(|image| image.id.clone()) {
                // 조회용 사본이 실제 생성 결과의 첨부 자리를 차지하지 않는다.
                self.preview_unavailable(&preview);
            } else {
                return Err(ProviderError::new("output_too_large", "답변 이미지는 8개까지 지원합니다"));
            }
        }
        if let GeneratedImageSource::Base64(data) = &source {
            let previous: usize = self.output.generated_images.iter().map(|image| match &image.source {
                GeneratedImageSource::Base64(value) => value.len(),
                _ => 0,
            }).sum();
            if data.len() > crate::attachments::MAX_FILE_BYTES.div_ceil(3) * 4
                || previous + data.len() > (crate::attachments::MAX_MESSAGE_BYTES as usize).div_ceil(3) * 4 {
                return Err(ProviderError::new("output_too_large", "이미지 크기가 첨부 한도를 넘었습니다"));
            }
        }
        self.output.generated_images.push(super::super::GeneratedImage { id, source });
        Ok(())
    }

    fn tool_images(&mut self, item: &Value, id: &str) -> Result<(), ProviderError> {
        if item["status"] != "completed" || !item["error"].is_null()
            || item["success"] == false || item["result"]["isError"] == true { return Ok(()); }
        let content = match item["type"].as_str() {
            Some("mcpToolCall") => &item["result"]["content"],
            Some("dynamicToolCall") => &item["contentItems"],
            _ => return Ok(()),
        };
        for (index, part) in content.as_array().into_iter().flatten().enumerate() {
            // 텍스트·structuredContent의 경로/URL은 해석하지 않고 typed 이미지 원문만 받는다.
            let data = match part["type"].as_str() {
                Some("image") if matches!(part["mimeType"].as_str(),
                    Some("image/png" | "image/jpeg" | "image/gif" | "image/webp")) => part["data"].as_str(),
                Some("inputImage") => part["imageUrl"].as_str().and_then(|url| {
                    let (mime, data) = url.strip_prefix("data:")?.split_once(";base64,")?;
                    matches!(mime, "image/png" | "image/jpeg" | "image/gif" | "image/webp").then_some(data)
                }),
                _ => None,
            };
            if let Some(data) = data.filter(|data| !data.is_empty()) {
                self.image(format!("{id}/image/{index}"), super::super::GeneratedImageSource::Base64(data.into()))?;
            }
        }
        Ok(())
    }

    fn item(&mut self, item: &Value) -> Result<(), ProviderError> {
        let id = item["id"].as_str().ok_or_else(invalid)?;
        self.tool_images(item, id)?;
        match item["type"].as_str().unwrap_or("") {
            "imageGeneration" => {
                if item["status"] != "completed" || !item["failure"].is_null()
                    || self.output.generated_images.iter().any(|image| image.id == id) {
                    return Ok(());
                }
                let source = if let Some(data) = item["result"].as_str().filter(|data| !data.is_empty()) {
                    super::super::GeneratedImageSource::Base64(data.into())
                } else {
                    // 사용자 본문·도구 설명의 경로를 해석하지 않고, CLI의 완료 항목만 사용한다.
                    let path = item["savedPath"].as_str().and_then(image_path).ok_or_else(||
                        ProviderError::new("image_output_unavailable", "생성 이미지 원문을 가져오지 못했습니다"))?;
                    let thread = std::path::Path::new(&self.thread);
                    if thread.components().count() != 1 || !matches!(thread.components().next(), Some(std::path::Component::Normal(_))) {
                        return Err(invalid());
                    }
                    let root = generated_image_root().ok_or_else(invalid)?;
                    if !path.is_absolute() || !path.starts_with(root.join(thread))
                        || path.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
                        return Err(ProviderError::new("image_output_unavailable", "생성 이미지 저장 경로가 올바르지 않습니다"));
                    }
                    super::super::GeneratedImageSource::File { root, path }
                };
                self.image(id.into(), source)?;
            }
            "imageView" => {
                if self.viewed_images.contains(id) { return Ok(()); }
                let Some(path) = item["path"].as_str().and_then(image_path) else { return Ok(()); };
                let path = if path.is_absolute() { path } else { self.cwd.join(path) };
                if !path.is_absolute() || path.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
                    return Ok(());
                }
                // 이전 생성 결과와 view_image 훅의 축소본도 같은 첨부 경로로 가져온다.
                let root = generated_image_root().filter(|root| path.starts_with(root))
                    .or_else(|| image_cache_root(|key| std::env::var_os(key)).filter(|root| path.starts_with(root)))
                    .or_else(|| (self.cwd.is_absolute() && path.starts_with(&self.cwd)).then(|| self.cwd.clone()));
                if let Some(root) = root {
                    self.viewed_images.insert(id.into());
                    self.image(id.into(), super::super::GeneratedImageSource::File { root, path })?;
                }
            }
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
                    "mcpToolCall" | "dynamicToolCall" => json!({"kind":"mcp_tool_call","name":item["tool"],
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
        // resume은 이전 턴의 누적 사용량을 replay한다. 새 턴 전의 기준값만 보관한다.
        if method == "thread/tokenUsage/updated" && self.turn.is_none() {
            self.usage_baseline = token_usage(&p["tokenUsage"]["total"]);
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
            // imageView에는 status가 없으므로 완료 알림에서만 파일을 첨부한다.
            "item/started" if p["item"]["type"] == "imageView" => return Ok(false),
            "item/started" | "item/completed" => self.item(&p["item"])?,
            "thread/tokenUsage/updated" => {
                // last는 가장 최근 요청의 점유량이며, total은 과금용 누적 사용량이다.
                self.output.context_usage = Some(ContextUsage {
                    tokens: p["tokenUsage"]["last"]["totalTokens"].as_u64(),
                    context_window: p["tokenUsage"]["modelContextWindow"].as_u64().filter(|n| *n > 0),
                });
                // total은 thread 전체 누적값이므로 이번 호출에서 증가한 양만 기록한다.
                // 한 턴의 여러 모델 호출·반복 알림도 같은 기준값으로 차감한다.
                let usage = token_usage(&p["tokenUsage"]["total"]);
                let base = &self.usage_baseline;
                self.output.usage = Usage {
                    input_tokens: usage.input_tokens.saturating_sub(base.input_tokens),
                    output_tokens: usage.output_tokens.saturating_sub(base.output_tokens),
                    cache_read_tokens: usage.cache_read_tokens.saturating_sub(base.cache_read_tokens),
                    cache_write_tokens: usage.cache_write_tokens.map(|n| n.saturating_sub(base.cache_write_tokens.unwrap_or(0))),
                    reasoning_tokens: usage.reasoning_tokens.map(|n| n.saturating_sub(base.reasoning_tokens.unwrap_or(0))),
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
        match tokio::time::timeout(profile.timeout, super::read_line_limited(reader, MAX_IMAGE_EVENT_BYTES)).await {
            Ok(result) => break result?,
            Err(_)
                if req.cli.as_ref().is_some_and(super::CliContext::waiting_for_grove_tool) =>
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
        state.snapshot_images().await?;
        state.rebuild()?;
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

async fn next_steer(live: &Option<crate::followups::live::LiveSteers>) -> Result<String, ProviderError> {
    match live {
        Some(live) => live.next().await.map_err(|e| ProviderError::new(e.code, e.message)),
        None => std::future::pending().await,
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
    let mut state = State {
        cwd: req.cli.as_ref().expect("Codex 대화 문맥").cwd.clone(),
        ..State::default()
    };
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
    let command = if let Some(id) = req.cli.as_ref().and_then(|context| context.native_command.as_ref()) {
        let cwd = &req.cli.as_ref().expect("CLI context").cwd;
        let result = call(writer, reader, profile, req, Call {
            id: 4, method: "skills/list", params: json!({"cwds":[cwd],"forceReload":true}),
        }, &mut state, on_delta).await?;
        let catalog = super::commands::decode("codex_cli", cwd, &result)?;
        Some(catalog.commands.into_iter().find(|command| &command.info.id == id)
            .ok_or_else(|| ProviderError::new("native_command_changed", "스킬이 없어졌거나 비활성화됐습니다. 목록을 다시 확인하세요"))?)
    } else { None };
    let prepared;
    let req = if let Some(command) = &command {
        let arguments = super::commands::invocation(super::current_text(req), command)?;
        let mut next = req.clone();
        if let Some(ChatMsg::User { text, .. }) = next.messages.iter_mut().rev().find(|m| matches!(m, ChatMsg::User { .. })) {
            *text = format!("${}{}{}", command.native_name, if arguments.is_empty() { "" } else { " " }, arguments);
        }
        prepared = next;
        &prepared
    } else { req };
    let method = if req.cli.as_ref().and_then(|c| c.resume.as_ref()).is_some() {
        "thread/resume"
    } else {
        "thread/start"
    };
    // resume 응답보다 먼저 도착하는 사용량 replay도 현재 thread로 식별한다.
    state.thread = req.cli.as_ref().and_then(|context| context.resume.clone()).unwrap_or_default();
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
    let mut params = turn_params(profile, req, &state.thread, images);
    if let Some(command) = command {
        params["input"].as_array_mut().expect("turn input").push(json!({
            "type":"skill", "name":command.native_name, "path":command.path.expect("Codex skill path"),
        }));
    }
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
    let live = req.cli.as_ref().and_then(|context| context.steers.clone());
    let mut next = Box::pin(next_steer(&live));
    let mut pending: Option<(u64, crate::followups::live::Delivery)> = None;
    let mut request_id = 10u64;
    let mut retained_images = Vec::new();
    while !state.completed || pending.is_some() {
        // receive는 개행 전까지 버퍼를 소유한다. 합치기가 와도 이 future를 버리지 않는다.
        let event = {
            let read = receive(reader, profile, req);
            tokio::pin!(read);
            loop {
                tokio::select! {
                    biased;
                    event = &mut read => break event?,
                    id = &mut next, if pending.is_none() && !state.completed => {
                        let link = live.as_ref().expect("합치기 연결");
                        if let Some(delivery) = link.claim(&id?).await.map_err(|e| ProviderError::new(e.code, e.message))? {
                            let id = request_id;
                            request_id += 1;
                            // 기대 실행 ID를 포함해 다른 native 턴에 입력이 섞이지 않게 한다.
                            let message = json!({"id":id,"method":"turn/steer","params":{
                                "threadId":state.thread, "expectedTurnId":state.turn,
                                "clientUserMessageId":delivery.id, "input":delivery.input,
                            }});
                            pending = Some((id, delivery));
                            // 보내기 전의 sending 접수가 commit된 뒤에만 wire에 쓴다. 오류는 재전송하지 않는다.
                            send(writer, &message).await?;
                        }
                        next = Box::pin(next_steer(&live));
                    }
                }
            }
        };
        if pending.as_ref().is_some_and(|(id, _)| event["id"].as_u64() == Some(*id))
            && event.get("method").is_none()
        {
            let (_, delivery) = pending.take().expect("전달 확인");
            let accepted = event.get("error").is_none();
            if accepted && event["result"]["turnId"].as_str() != state.turn.as_deref() {
                return Err(invalid());
            }
            let boundary = accepted.then(|| (delivery.id.clone(), state.messages.len()));
            let images = live.as_ref().expect("합치기 연결").acknowledge(delivery, accepted).await
                .map_err(|e| ProviderError::new(e.code, e.message))?;
            if let Some(boundary) = boundary {
                retained_images.push(images);
                state.output.response_steers.push(boundary);
                on_delta(&state.output);
            }
            continue;
        }
        notification(writer, &event, &mut state, on_delta).await?;
    }
    Ok(state.output)
}

#[cfg(test)]
#[path = "codex_tests.rs"]
mod tests;
