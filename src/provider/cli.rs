//! 서버에 설치된 에이전트 CLI를 모델 백엔드로 쓰는 어댑터(protocol `claude_code`, `codex_cli`).
//!
//! - CLI는 자기 안에서 도구를 실행한다. Grove는 CLI의 도구 호출을 `tool_calls`로 받지 않는다(받으면 runner가 다시 실행하려 함).
//!   대신 표시 전용 `activity`로 기록한다.
//! - CLI 자체 도구로 프로젝트 파일을 수정하고 검사 명령을 실행한다. Grove 도구 루프와 중복 실행하지 않는다.
//!   두 CLI 모두 sandbox·권한 확인 없이 서버 계정 권한으로 실행한다.
//!   전역·프로젝트 지침·기억·hook·MCP는 CLI 기본 로더와 사용자 설정에 맡긴다.
//! - 대화 연속성: Grove 대화×프로필마다 CLI 세션 ID를 저장하고(runner) 다음 요청에서 resume한다. 저장된 세션이 없으면
//!   지금까지의 user/assistant 텍스트를 프롬프트에 넣는다. 실행 문맥이 없는 호출(제목·요약)은 빈 임시 디렉터리에서 세션을 남기지 않는다.
//! - 취소·timeout: 새 process group으로 띄우고, future가 버려지면(취소) group 전체를 종료한다.
//! - CLI의 인증은 CLI 자신이 처리한다. Grove는 CLI 자격증명 파일을 읽지 않는다.

use super::{ChatMsg, ContextUsage, ModelOutput, ModelRequest, OnDelta, Profile, ProviderError, Usage};
use serde_json::{Value, json};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ACTIVITY: usize = 512;

mod codex;
mod account_limits;
pub mod commands;

pub async fn account_limits() -> Result<Value, &'static str> {
    account_limits::read(std::path::Path::new("codex")).await
}

pub(super) async fn refresh_codex_account() -> Result<(), &'static str> {
    let account = account_limits::request(std::path::Path::new("codex"), "account/read", json!({"refreshToken":true})).await?;
    if account["account"]["type"] == "chatgpt" { Ok(()) } else { Err("authentication_required") }
}

/// 실행 문맥: 작업 디렉터리(프로젝트 root)와 이어 쓸 CLI 세션 ID.
#[derive(Debug, Clone, Default)]
pub struct CliContext {
    pub cwd: std::path::PathBuf,
    pub resume: Option<String>,
    pub service_tier: Option<String>,
    pub computer: Option<crate::computer::bridge::Link>,
    pub continuations: Option<crate::continuations::bridge::Link>,
    pub native_command: Option<String>,
    pub(crate) steers: Option<crate::followups::live::LiveSteers>,
}

impl CliContext {
    fn waiting_for_grove_tool(&self)->bool {
        use std::sync::atomic::Ordering;
        self.computer.as_ref().is_some_and(|c|c.waiting.load(Ordering::Acquire))
            || self.continuations.as_ref().is_some_and(|c|c.waiting.load(Ordering::Acquire)>0)
    }
}

/// CLI 연결 확인: 실행 파일이 있고 버전을 출력하는지(로그인 상태는 실제 호출에서 드러난다).
pub async fn check(profile: &Profile) -> Result<serde_json::Value, ProviderError> {
    let prog = program(&profile.protocol);
    let out = tokio::time::timeout(std::time::Duration::from_secs(15), tokio::process::Command::new(prog).arg("--version").stdin(Stdio::null()).kill_on_drop(true).output())
        .await
        .map_err(|_| ProviderError::new("cli_timeout", format!("{prog} --version이 15초 안에 끝나지 않았습니다")))?
        .map_err(|e| {
            if crate::deps::is_missing(prog, Some(&e)) {
                // 설치 안내만 하고 자동 설치하지 않는다(ARCH-018).
                ProviderError::new("cli_not_found", crate::deps::message(prog))
            } else {
                ProviderError::new("cli_failed", format!("{prog} 실행 실패: {e}"))
            }
        })?;
    if !out.status.success() {
        return Err(ProviderError::new("cli_failed", format!("{prog} --version 실패(종료 코드 {:?})", out.status.code())));
    }
    let v = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim().chars().take(100).collect::<String>();
    Ok(serde_json::json!({ "cli_version": v }))
}

pub fn is_cli(protocol: &str) -> bool {
    matches!(protocol, "claude_code" | "codex_cli")
}

fn program(protocol: &str) -> &'static str {
    if protocol == "claude_code" { "claude" } else { "codex" }
}

fn current_text(req: &ModelRequest) -> &str {
    req.messages.iter().rev().find_map(|message| match message {
        ChatMsg::User { text, .. } => Some(text.as_str()), _ => None,
    }).unwrap_or_default()
}

/// 프롬프트: resume이면 마지막 사용자 요청만, 아니면 이전 대화 텍스트와 함께.
fn prompt(req: &ModelRequest, resume: bool, with_system: bool) -> String {
    let last_user = req.messages.iter().rposition(|m| matches!(m, ChatMsg::User { .. }));
    let current = match last_user.map(|i| &req.messages[i]) {
        Some(ChatMsg::User { text, .. }) => text.clone(),
        _ => String::new(),
    };
    let mut out = String::new();
    if with_system && !req.system.trim().is_empty() {
        out.push_str("<instructions>\n");
        out.push_str(req.system.trim());
        out.push_str("\n</instructions>\n\n");
    }
    if !resume && let Some(i) = last_user {
        let prev: Vec<String> = req.messages[..i]
            .iter()
            .filter_map(|m| match m {
                ChatMsg::User { text, .. } if !text.trim().is_empty() => Some(format!("[user]\n{text}")),
                ChatMsg::Assistant { text, .. } if !text.trim().is_empty() => Some(format!("[assistant]\n{text}")),
                _ => None,
            })
            .collect();
        if !prev.is_empty() {
            out.push_str("<previous_conversation>\n");
            out.push_str(&prev.join("\n\n"));
            out.push_str("\n</previous_conversation>\n\n");
        }
    }
    out.push_str(&current);
    out
}

/// CLI 인자. 시험에서 신규 실행·재개의 권한 모드를 검사할 수 있게 분리한다.
pub fn args(profile: &Profile, req: &ModelRequest, new_session: &str) -> (Vec<String>, String) {
    if profile.protocol == "codex_cli" && req.cli.is_some() {
        return (codex::args(req), program(&profile.protocol).into());
    }
    let resume = req.cli.as_ref().and_then(|c| c.resume.clone());
    let persist = req.cli.is_some();
    let s = |x: &str| x.to_string();
    if profile.protocol == "claude_code" {
        let mut a = vec![s("-p"), s("--output-format"), s("stream-json"), s("--verbose"), s("--include-partial-messages")];
        if profile.model != "default" {
            a.extend([s("--model"), profile.model.clone()]);
        }
        // 파일 경계·Bash sandbox·대화형 권한 확인을 적용하지 않는다.
        a.extend([s("--dangerously-skip-permissions"), s("--tools"), s(if persist { "default" } else { "" })]);
        let settings = if persist { json!({"sandbox": {"enabled": false}}) }
            else { json!({"sandbox": {"enabled": false}, "disableAllHooks": true}) };
        a.extend([s("--settings"), settings.to_string()]);
        // 일반 대화는 CLI 설정을 그대로 쓴다. 제목·요약만 사용자 hook·MCP·설정을 제외한다.
        if !persist {
            a.extend([s("--setting-sources"), s(""), s("--strict-mcp-config")]);
        }
        let mut servers=serde_json::Map::new();
        let mut allowed=Vec::new();
        let exe=std::env::current_exe().expect("running executable");
        if let Some(link)=req.cli.as_ref().and_then(|c|c.computer.as_ref()) {
            servers.insert("grove_computer".into(),json!({"command":exe,"args":["computer-mcp",link.file]}));
            allowed.push("mcp__grove_computer__computer");
        }
        if let Some(link)=req.cli.as_ref().and_then(|c|c.continuations.as_ref()) {
            servers.insert("grove_continuations".into(),json!({"command":exe,"args":["continuation-mcp",link.file]}));
            // Actual shell execution still passes through Grove's policy and approvals.
            allowed.extend(["mcp__grove_continuations__continue_later","mcp__grove_continuations__shell"]);
        }
        if !servers.is_empty() {
            a.extend([s("--mcp-config"),json!({"mcpServers":servers}).to_string(),s("--allowedTools"),allowed.join(",")]);
        }
        if !req.system.trim().is_empty() {
            a.extend([s("--append-system-prompt"), req.system.clone()]);
        }
        match (&resume, persist) {
            (Some(id), _) => a.extend([s("--resume"), id.clone()]),
            (None, true) => a.extend([s("--session-id"), new_session.to_string()]),
            (None, false) => a.push(s("--no-session-persistence")),
        }
        (a, s(program(&profile.protocol)))
    } else {
        let mut a = vec![s("exec")];
        if resume.is_some() {
            a.push(s("resume"));
        }
        a.extend([s("--json"), s("--skip-git-repo-check")]);
        if !persist { a.push(s("--ignore-user-config")); }
        if profile.model != "default" {
            a.extend([s("-m"), profile.model.clone()]);
        }
        // resume에도 파일·네트워크 sandbox와 대화형 권한 확인을 적용하지 않는다.
        a.push(s("--dangerously-bypass-approvals-and-sandbox"));
        for (key, value) in codex_config(req) { a.extend([s("-c"), format!("{key}={value}")]); }
        if !persist {
            a.push(s("--ephemeral"));
        }
        if let Some(id) = &resume {
            a.push(id.clone());
        }
        // 사용자 메시지·대화 이력은 argv 크기 한도와 프로세스 목록 노출을 피하도록 stdin으로 전달한다.
        a.push(s("-"));
        (a, s(program(&profile.protocol)))
    }
}

pub(crate) const STANDARD_SERVICE_TIER: &str = "default";

fn service_tier(req: &ModelRequest) -> Option<&str> {
    match &req.cli {
        Some(context) => context.service_tier.as_deref(),
        None => Some(STANDARD_SERVICE_TIER),
    }
}

fn codex_config(req: &ModelRequest) -> Vec<(String, Value)> {
    let mut config = Vec::new();
    if let Some(link) = req.cli.as_ref().and_then(|c| c.computer.as_ref()) {
        let exe = std::env::current_exe().expect("running executable");
        for (key, value) in [
            ("command", json!(exe)), ("args", json!(["computer-mcp", link.file])),
            ("startup_timeout_sec", json!(30)), ("tool_timeout_sec", json!(360)),
            // CLI의 승인과 별개로 bridge는 Grove의 단발 승인을 기다린다.
            ("required", json!(true)), ("enabled_tools", json!(["computer"])),
            ("tools.computer.approval_mode", json!("approve")),
        ] { config.push((format!("mcp_servers.grove_computer.{key}"), value)); }
    }
    if let Some(link)=req.cli.as_ref().and_then(|c|c.continuations.as_ref()) {
        let exe=std::env::current_exe().expect("running executable");
        for (key,value) in [
            ("command",json!(exe)),("args",json!(["continuation-mcp",link.file])),
            ("startup_timeout_sec",json!(30)),("tool_timeout_sec",json!(360)),
            ("required",json!(true)),("enabled_tools",json!(["continue_later","shell"])),
        ] { config.push((format!("mcp_servers.grove_continuations.{key}"),value)); }
    }
    if let Some(effort) = &req.effort { config.push(("model_reasoning_effort".into(), json!(effort))); }
    if let Some(tier) = service_tier(req) {
        config.push(("service_tier".into(), json!(tier)));
    }
    config
}

/// 한 줄(JSONL 이벤트)을 누적기에 반영한다.
pub fn apply_event(protocol: &str, e: &Value, out: &mut ModelOutput, final_text: &mut Option<String>) -> Result<(), ProviderError> {
    if protocol == "claude_code" {
        match e["type"].as_str().unwrap_or("") {
            "system" if e["subtype"] == "init" => {
                if let Some(id) = e["session_id"].as_str() {
                    out.native_session = Some(id.to_string());
                }
            }
            "assistant" => {
                if e["parent_tool_use_id"].is_null() {
                    if let Some(tokens) = claude_context_tokens(&e["message"]["usage"]) {
                        out.context_usage.get_or_insert_with(ContextUsage::default).tokens = Some(tokens);
                    }
                }
                let mut text = String::new();
                for c in e["message"]["content"].as_array().into_iter().flatten() {
                    match c["type"].as_str().unwrap_or("") {
                        "text" => {
                            if !out.text.is_empty() {
                                out.text.push_str("\n\n");
                            }
                            out.text.push_str(c["text"].as_str().unwrap_or(""));
                            if !text.is_empty() { text.push_str("\n\n"); }
                            text.push_str(c["text"].as_str().unwrap_or(""));
                        }
                        "thinking" => out.reasoning.push_str(c["thinking"].as_str().unwrap_or("")),
                        "tool_use" => out.activity.push(json!({ "kind": "tool", "name": c["name"], "input": summarize(&c["input"]) })),
                        _ => {}
                    }
                }
                if !text.is_empty() { out.response_parts.push(text); }
            }
            "result" => {
                if let Some(id) = e["session_id"].as_str() {
                    out.native_session = Some(id.to_string());
                }
                let u = &e["usage"];
                let context = out.context_usage.get_or_insert_with(ContextUsage::default);
                if let Some(window) = e["modelUsage"].as_object().into_iter().flat_map(|models| models.values())
                    .filter_map(|model| model["contextWindow"].as_u64().filter(|n| *n > 0)).max()
                {
                    context.context_window = Some(window);
                }
                // result.usage는 한 턴 안의 여러 요청을 합산하므로 현재 점유량으로 쓰지 않는다.
                if context.tokens.is_none() {
                    context.tokens = u["iterations"].as_array().and_then(|iterations| iterations.last()).and_then(claude_context_tokens);
                }
                out.usage = Usage {
                    input_tokens: u["input_tokens"].as_u64().unwrap_or(0) + u["cache_creation_input_tokens"].as_u64().unwrap_or(0) + u["cache_read_input_tokens"].as_u64().unwrap_or(0),
                    output_tokens: u["output_tokens"].as_u64().unwrap_or(0),
                    cache_read_tokens: u["cache_read_input_tokens"].as_u64().unwrap_or(0),
                    cache_write_tokens: u["cache_creation_input_tokens"].as_u64(),
                    reasoning_tokens: u["output_tokens_details"]["thinking_tokens"].as_u64(),
                };
                for d in e["permission_denials"].as_array().into_iter().flatten() {
                    out.activity.push(json!({ "kind": "denied", "name": d["tool_name"], "input": summarize(&d["tool_input"]) }));
                }
                if e["is_error"] == true {
                    return Err(ProviderError::new("cli_failed", format!("claude: {}", e["result"].as_str().unwrap_or("오류"))));
                }
                if let Some(r) = e["result"].as_str().filter(|r| !r.is_empty()) {
                    *final_text = Some(r.to_string());
                }
                out.finish_reason = "stop".into();
            }
            _ => {}
        }
    } else {
        match e["type"].as_str().unwrap_or("") {
            "thread.started" => out.native_session = e["thread_id"].as_str().map(String::from),
            "item.completed" => {
                let it = &e["item"];
                match it["type"].as_str().unwrap_or("") {
                    "agent_message" => {
                        if !out.text.is_empty() {
                            out.text.push_str("\n\n");
                        }
                        out.text.push_str(it["text"].as_str().unwrap_or(""));
                        out.response_parts.push(it["text"].as_str().unwrap_or("").to_string());
                    }
                    "reasoning" => out.reasoning.push_str(it["text"].as_str().unwrap_or("")),
                    "command_execution" => out.activity.push(json!({ "kind": "command", "name": "shell", "input": it["command"], "status": it["status"], "exit_code": it["exit_code"] })),
                    "file_change" => out.activity.push(json!({ "kind": "file_change", "name": "file_change", "input": summarize(&it["changes"]), "status": it["status"] })),
                    other => out.activity.push(json!({ "kind": other, "name": other, "input": summarize(it) })),
                }
            }
            "turn.completed" => {
                let u = &e["usage"];
                out.usage = Usage {
                    input_tokens: u["input_tokens"].as_u64().unwrap_or(0),
                    output_tokens: u["output_tokens"].as_u64().unwrap_or(0),
                    cache_read_tokens: u["cached_input_tokens"].as_u64().unwrap_or(0),
                    cache_write_tokens: u["cache_write_input_tokens"].as_u64(),
                    reasoning_tokens: u["reasoning_output_tokens"].as_u64(),
                };
                out.finish_reason = "stop".into();
            }
            "turn.failed" => return Err(ProviderError::new("cli_failed", format!("codex: {}", e["error"]["message"].as_str().unwrap_or("실패")))),
            "error" => return Err(ProviderError::new("cli_failed", format!("codex: {}", e["message"].as_str().unwrap_or("오류")))),
            _ => {}
        }
    }
    Ok(())
}

fn claude_context_input(usage: &Value) -> Option<u64> {
    usage["input_tokens"].as_u64()?
        .checked_add(usage["cache_creation_input_tokens"].as_u64().unwrap_or(0))?
        .checked_add(usage["cache_read_input_tokens"].as_u64().unwrap_or(0))
}

fn claude_context_tokens(usage: &Value) -> Option<u64> {
    claude_context_input(usage)?.checked_add(usage["output_tokens"].as_u64().unwrap_or(0))
}

/// 표시용 요약(큰 입력은 자른다).
fn summarize(v: &Value) -> Value {
    let s = v.to_string();
    if s.chars().count() > 300 { json!(s.chars().take(300).collect::<String>() + "…") } else { v.clone() }
}

/// 제공자별 부분 이벤트와 최종 snapshot을 한 응답으로 정규화한다.
/// 전송 계층·DB에는 기존 ModelOutput 계약만 넘기고 provider 임시 상태는 저장하지 않는다.
#[derive(Default)]
struct CliStream {
    output: ModelOutput,
    final_text: Option<String>,
    claude_partial: Option<(usize, usize, bool)>,
    claude_context_input: Option<u64>,
    codex_messages: Vec<(String, String)>,
    codex_reasoning: Vec<(String, String)>,
    native_activity: Vec<(String, Value)>,
}

impl CliStream {
    fn activity(&mut self, id: &str, item: Value) {
        if let Some((_, value)) = self.native_activity.iter_mut().find(|(key, _)| key == id) { *value = item; }
        else { self.native_activity.push((id.into(), item)); }
        self.output.activity = self.native_activity.iter().map(|(_, value)| value.clone()).collect();
    }

    fn apply(&mut self, protocol: &str, event: &Value) -> Result<(), ProviderError> {
        if protocol == "claude_code" && event["type"] == "stream_event" {
            let e = &event["event"];
            if event["parent_tool_use_id"].is_null() {
                if e["type"] == "message_start" {
                    self.claude_context_input = claude_context_input(&e["message"]["usage"]);
                    self.output.context_usage.get_or_insert_with(ContextUsage::default).tokens = self.claude_context_input;
                } else if e["type"] == "message_delta" {
                    if let Some(tokens) = self.claude_context_input.zip(e["usage"]["output_tokens"].as_u64())
                        .and_then(|(input, output)| input.checked_add(output))
                    {
                        self.output.context_usage.get_or_insert_with(ContextUsage::default).tokens = Some(tokens);
                    }
                }
            }
            if e["type"] == "content_block_start" && e["content_block"]["type"] == "tool_use"
                && let Some(id) = e["content_block"]["id"].as_str()
            {
                let c = &e["content_block"];
                self.activity(id, json!({"kind":"tool","name":c["name"],"input":summarize(&c["input"]),"status":"running"}));
            }
            if e["type"] == "message_start" {
                self.claude_partial = Some((self.output.text.len(), self.output.reasoning.len(), false));
                self.output.response_parts.push(String::new());
            }
            let text = if e["type"] == "content_block_delta" { e["delta"]["text"].as_str() }
                else if e["type"] == "content_block_start" { e["content_block"]["text"].as_str() } else { None };
            let thinking = if e["type"] == "content_block_delta" { e["delta"]["thinking"].as_str() }
                else if e["type"] == "content_block_start" { e["content_block"]["thinking"].as_str() } else { None };
            let state = self.claude_partial.get_or_insert((self.output.text.len(), self.output.reasoning.len(), false));
            if let Some(text) = text.filter(|text| !text.is_empty()) {
                if self.output.response_parts.is_empty() { self.output.response_parts.push(String::new()); }
                self.output.response_parts.last_mut().unwrap().push_str(text);
                if !state.2 && !self.output.text.is_empty() { self.output.text.push_str("\n\n"); }
                state.2 = true;
                self.output.text.push_str(text);
            }
            if let Some(thinking) = thinking { self.output.reasoning.push_str(thinking); }
        } else if protocol == "codex_cli" && matches!(event["type"].as_str(), Some("item.started" | "item.updated" | "item.completed"))
            && matches!(event["item"]["type"].as_str(), Some("agent_message" | "reasoning"))
            && event["item"]["id"].is_string()
        {
            let item = &event["item"];
            let id = item["id"].as_str().unwrap();
            let messages = if item["type"] == "reasoning" { &mut self.codex_reasoning } else { &mut self.codex_messages };
            let text = item["text"].as_str().unwrap_or("");
            if let Some((_, value)) = messages.iter_mut().find(|(key, _)| key == id) { *value = text.into(); }
            else { messages.push((id.into(), text.into())); }
            let combined = messages.iter().map(|(_, text)| text.as_str()).collect::<Vec<_>>().join("\n\n");
            if item["type"] == "reasoning" { self.output.reasoning = combined; } else {
                self.output.text = combined;
                self.output.response_parts = messages.iter().map(|(_, text)| text.clone()).collect();
            }
        } else if protocol == "codex_cli" && matches!(event["type"].as_str(), Some("item.started" | "item.updated" | "item.completed"))
            && let Some(id) = event["item"]["id"].as_str()
        {
            // 실행 시작도 남겨야 완료 이벤트 전 취소·종료를 '실행 안 함'으로 오해하지 않는다.
            let mut activity = ModelOutput::default();
            apply_event(protocol, &json!({"type":"item.completed","item":event["item"]}), &mut activity, &mut None)?;
            if let Some(item) = activity.activity.pop() { self.activity(id, item); }
        } else {
            if protocol == "claude_code" && event["type"] == "assistant"
                && let Some((text, reasoning, _)) = self.claude_partial.take()
            {
                self.output.text.truncate(text);
                self.output.reasoning.truncate(reasoning);
                self.output.response_parts.pop();
            }
            let mut snapshot = event.clone();
            if protocol == "claude_code" && event["type"] == "assistant"
                && let Some(content) = snapshot["message"]["content"].as_array_mut()
            {
                for c in content.iter().filter(|c| c["type"] == "tool_use") {
                    if let Some(id) = c["id"].as_str() {
                        self.activity(id, json!({"kind":"tool","name":c["name"],"input":summarize(&c["input"]),"status":"running"}));
                    }
                }
                content.retain(|c| c["type"] != "tool_use" || !c["id"].is_string());
            }
            if protocol == "claude_code" && event["type"] == "user" {
                for c in event["message"]["content"].as_array().into_iter().flatten() {
                    if c["type"] == "tool_result" && let Some(id) = c["tool_use_id"].as_str()
                        && let Some((_, item)) = self.native_activity.iter().find(|(key, _)| key == id)
                    {
                        let mut item = item.clone();
                        item["status"] = json!(if c["is_error"] == true { "failed" } else { "completed" });
                        self.activity(id, item);
                    }
                }
            }
            apply_event(protocol, &snapshot, &mut self.output, &mut self.final_text)?;
        }
        if protocol == "claude_code" && event["type"] == "result"
            && let Some(text) = &self.final_text
        {
            if let Some(last) = self.output.response_parts.last_mut() { *last = text.clone(); }
            else { self.output.response_parts.push(text.clone()); }
        }
        if self.output.text.len() + self.output.reasoning.len() > super::MAX_OUTPUT_BYTES
            || self.final_text.as_ref().is_some_and(|text| text.len() > super::MAX_OUTPUT_BYTES)
            || self.output.activity.len() > MAX_ACTIVITY
            || self.codex_messages.len() + self.codex_reasoning.len() > MAX_ACTIVITY
            || self.native_activity.len() > MAX_ACTIVITY || self.output.response_parts.len() > MAX_ACTIVITY
        {
            return Err(ProviderError::new("output_too_large", "에이전트 응답 한도를 초과했습니다"));
        }
        Ok(())
    }
}

/// 개행이 없는 출력도 메모리 한도를 넘기기 전에 중단한다.
async fn read_line<R: tokio::io::AsyncRead + Unpin>(reader: &mut BufReader<R>) -> Result<Option<Vec<u8>>, ProviderError> {
    read_line_limited(reader, MAX_LINE_BYTES).await
}

async fn read_line_limited<R: tokio::io::AsyncRead + Unpin>(reader: &mut BufReader<R>, max: usize) -> Result<Option<Vec<u8>>, ProviderError> {
    let mut line = Vec::new();
    loop {
        let bytes = reader.fill_buf().await.map_err(|e| ProviderError::new("cli_failed", e.to_string()))?;
        if bytes.is_empty() { return Ok((!line.is_empty()).then_some(line)); }
        let len = bytes.iter().position(|b| *b == b'\n').map_or(bytes.len(), |i| i + 1);
        if line.len() + len > max { return Err(ProviderError::new("output_too_large", "에이전트 출력 줄이 너무 큽니다")); }
        let complete = bytes[len - 1] == b'\n';
        line.extend_from_slice(&bytes[..len]);
        reader.consume(len);
        if complete { return Ok(Some(line)); }
    }
}

/// 끝나거나 취소(future drop)·timeout되면 소유 프로세스 트리 전체를 종료한다.
/// leader 회수 여부를 모르므로 표식으로 소유를 확인하는 경로를 쓴다(SEC-016).
struct GroupGuard(crate::procs::Owned);
impl Drop for GroupGuard {
    fn drop(&mut self) {
        self.0.kill_tree(false);
    }
}

/// 공식 CLI의 초기화/control 응답만 읽는다. 사용자 prompt·생성 요청·프로젝트 설정은 보내지 않는다.
pub async fn list_models(protocol: &str) -> Result<Vec<super::AvailableModel>, ProviderError> {
    list_models_with(protocol, None).await
}

fn claude_catalog_name(row: &Value, id: &str) -> String {
    let name = row["displayName"].as_str().unwrap_or(id);
    let version = row["resolvedModel"].as_str().map(|resolved| {
        resolved.split(['-', '.'])
            .skip_while(|part| !part.starts_with(|c: char| c.is_ascii_digit()))
            .take_while(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()))
            .take(2).collect::<Vec<_>>().join(".")
    }).unwrap_or_default();
    // 선택 값은 CLI alias 그대로 두고, 표시 이름에만 CLI가 해석한 실제 버전을 붙인다.
    let name = if version.is_empty() || name.contains(&version) { name.to_string() }
        else { format!("{name} {version}") };
    name.chars().take(200).collect()
}

async fn list_models_with(protocol: &str, executable: Option<&std::path::Path>) -> Result<Vec<super::AvailableModel>, ProviderError> {
    let scratch = tempfile::Builder::new().prefix("grove-catalog-").tempdir()
        .map_err(|_| ProviderError::new("catalog_failed", "목록 조회 임시 디렉터리를 만들지 못했습니다"))?;
    let prog = executable.map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| program(protocol).into());
    let mut cmd = tokio::process::Command::new(&prog);
    if protocol == "claude_code" {
        cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence"]);
    } else {
        cmd.arg("app-server");
    }
    cmd.current_dir(scratch.path()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    for (key, _) in std::env::vars_os() {
        if key.to_str().is_some_and(|key| key.starts_with("GROVE_")) { cmd.env_remove(key); }
    }
    let tag = crate::util::new_id();
    let limits = crate::procs::Limits::default();
    crate::procs::prepare(&mut cmd, &tag, limits);
    let mut child = cmd.spawn().map_err(|error| {
        if crate::deps::is_missing(&prog, Some(&error)) { ProviderError::new("cli_not_found", crate::deps::message(&prog)) }
        else { ProviderError::new("catalog_failed", "모델 목록용 CLI를 실행하지 못했습니다") }
    })?;
    let _guard = GroupGuard(crate::procs::adopt(&mut child, &tag, limits).map_err(|e| ProviderError::new("catalog_failed", e))?);
    let mut input = child.stdin.take().expect("stdin");
    let mut output = BufReader::new(child.stdout.take().expect("stdout"));
    let claude = protocol == "claude_code";
    let init = if claude {
        json!({"type":"control_request","request_id":"grove-models","request":{"subtype":"initialize"}})
    } else {
        json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"grove","version":env!("CARGO_PKG_VERSION")}}})
    };
    input.write_all(format!("{init}\n").as_bytes()).await.map_err(|_| ProviderError::new("catalog_failed", "CLI 목록 조회가 끊겼습니다"))?;
    let mut models = std::collections::BTreeMap::new();
    let mut pages = 0;
    let mut bytes = 0;
    let mut cursors = std::collections::HashSet::new();
    while let Some(line) = read_line(&mut output).await? {
        bytes += line.len();
        if bytes > 8 * 1024 * 1024 { return Err(ProviderError::new("catalog_too_large", "CLI 모델 목록 크기 제한을 넘었습니다")); }
        let value: Value = serde_json::from_slice(&line).map_err(|_| ProviderError::new("catalog_invalid", "CLI 목록 응답 형식 오류"))?;
        if !claude && value["id"] == 1 {
            if value.get("error").is_some() { return Err(ProviderError::new("catalog_failed", "CLI 초기화에 실패했습니다")); }
            input.write_all(b"{\"method\":\"initialized\"}\n{\"id\":2,\"method\":\"model/list\",\"params\":{}}\n").await
                .map_err(|_| ProviderError::new("catalog_failed", "CLI 목록 조회가 끊겼습니다"))?;
            continue;
        }
        let result = if claude {
            if value["type"] != "control_response" || value["response"]["request_id"] != "grove-models" { continue; }
            if value["response"]["subtype"] != "success" { return Err(ProviderError::new("catalog_failed", "CLI 모델 목록을 확인하지 못했습니다")); }
            &value["response"]["response"]
        } else {
            if value["id"] != 2 { continue; }
            if value.get("error").is_some() { return Err(ProviderError::new("catalog_failed", "CLI 모델 목록을 확인하지 못했습니다")); }
            &value["result"]
        };
        let rows = result[if claude { "models" } else { "data" }].as_array()
            .ok_or_else(|| ProviderError::new("catalog_invalid", "CLI 모델 목록 형식 오류"))?;
        for row in rows {
            let id = row[if claude { "value" } else { "model" }].as_str()
                .filter(|id| !id.is_empty() && id.len() <= 200 && !id.contains(char::is_whitespace))
                .ok_or_else(|| ProviderError::new("catalog_invalid", "CLI 모델 식별자 형식 오류"))?;
            let name = if claude { claude_catalog_name(row, id) }
                else { row["displayName"].as_str().unwrap_or(id).chars().take(200).collect() };
            let mut model = super::AvailableModel { id: id.into(), name, ..Default::default() };
            if !claude {
                if let Some(efforts) = row.get("supportedReasoningEfforts") {
                    let efforts = efforts.as_array().ok_or_else(|| ProviderError::new("catalog_invalid", "CLI 추론 옵션 형식 오류"))?;
                    let parsed = efforts.iter().map(|e| e["reasoningEffort"].as_str()
                        .filter(|e| super::parse_effort(Some(e)).is_ok_and(|value| value.is_some()))
                        .map(str::to_string).ok_or_else(|| ProviderError::new("catalog_invalid", "CLI 추론 옵션 형식 오류")))
                        .collect::<Result<Vec<_>, _>>()?;
                    model.reasoning_efforts = Some(parsed);
                }
                model.default_reasoning_effort = row["defaultReasoningEffort"].as_str().map(str::to_string);
                model.is_default = row["isDefault"].as_bool();
                if let Some(tiers) = row.get("serviceTiers") {
                    let tiers: Vec<super::ModelServiceTier> = serde_json::from_value(tiers.clone())
                        .map_err(|_| ProviderError::new("catalog_invalid", "CLI 속도 옵션 형식 오류"))?;
                    if tiers.len() > 20 || tiers.iter().any(|tier| super::parse_service_tier(Some(&tier.id)).is_err()
                        || tier.name.len() > 200 || tier.description.len() > 2000) {
                        return Err(ProviderError::new("catalog_invalid", "CLI 속도 옵션 형식 오류"));
                    }
                    model.service_tiers = Some(tiers);
                }
            }
            models.insert(id.to_string(), model);
        }
        if models.len() > 2000 { return Err(ProviderError::new("catalog_too_large", "CLI 모델 목록 개수 제한을 넘었습니다")); }
        let next = result["nextCursor"].as_str().filter(|cursor| !cursor.is_empty());
        if claude || next.is_none() { return Ok(models.into_values().collect()); }
        pages += 1;
        let cursor = next.unwrap();
        if pages >= 20 || !cursors.insert(cursor.to_string()) { return Err(ProviderError::new("catalog_invalid", "CLI 모델 목록의 다음 페이지가 반복되거나 제한을 넘었습니다")); }
        let request = json!({"id":2,"method":"model/list","params":{"cursor":cursor}});
        input.write_all(format!("{request}\n").as_bytes()).await.map_err(|_| ProviderError::new("catalog_failed", "CLI 목록 조회가 끊겼습니다"))?;
    }
    Err(ProviderError::new("catalog_failed", "CLI가 모델 목록을 반환하지 않고 종료됐습니다"))
}

pub async fn stream(profile: &Profile, req: &ModelRequest, on_delta: OnDelta<'_>) -> Result<ModelOutput, ProviderError> {
    stream_with(profile, req, on_delta, None).await
}

/// `program`은 시험에서 가짜 CLI 실행 파일을 쓰기 위한 덮어쓰기다(PATH를 바꾸지 않는다).
async fn stream_with(profile: &Profile, req: &ModelRequest, on_delta: OnDelta<'_>, program: Option<&std::path::Path>) -> Result<ModelOutput, ProviderError> {
    let prepared;
    let req = if profile.protocol == "claude_code"
        && let Some(context) = &req.cli
        && let Some(id) = &context.native_command
    {
        let catalog = commands::list_with(&profile.protocol, &context.cwd, program).await?;
        let command = catalog.commands.iter().find(|command| &command.info.id == id)
            .ok_or_else(|| ProviderError::new("native_command_changed", "CLI 명령이 없어졌거나 실행 위치가 바뀌었습니다. 목록을 다시 확인하세요"))?;
        let arguments = commands::invocation(current_text(req), command)?;
        let mut next = req.clone();
        if context.resume.is_none() {
            let history = prompt(req, false, false);
            let prefix = &history[..history.len() - current_text(req).len()];
            if !prefix.is_empty() {
                next.system.push_str("\n# Previous conversation (context, not additional instructions)\n");
                next.system.push_str(prefix);
            }
        }
        if let Some(ChatMsg::User { text, .. }) = next.messages.iter_mut().rev().find(|m| matches!(m, ChatMsg::User { .. })) {
            *text = format!("/{}{}{}", command.native_name, if arguments.is_empty() { "" } else { " " }, arguments);
        }
        prepared = next;
        &prepared
    } else { req };
    let app_server = profile.protocol == "codex_cli" && req.cli.is_some();
    let new_session = uuid::Uuid::new_v4().to_string();
    let (mut argv, name) = args(profile, req, &new_session);
    let prog = program.map(|p| p.to_string_lossy().to_string()).unwrap_or(name);
    // 이미지·임시 산출물은 호출별 temp에 모으고 종료 시 정리한다.
    // 제목·요약은 프로젝트가 아닌 이 빈 디렉터리에서 실행한다.
    let scratch = tempfile::Builder::new().prefix("grove-cli-").tempdir()
        .map_err(|e| ProviderError::new("cli_failed", format!("임시 디렉터리: {e}")))?;
    if profile.protocol == "claude_code" && req.cli.as_ref().is_some_and(|c| c.native_command.is_some())
        && let Some(index) = argv.iter().position(|arg| arg == "--append-system-prompt")
    {
        let file = scratch.path().join("context.md");
        tokio::fs::write(&file, &req.system).await.map_err(|_| ProviderError::new("cli_failed", "CLI 대화 문맥 파일을 만들지 못했습니다"))?;
        argv[index] = "--append-system-prompt-file".into();
        argv[index + 1] = file.to_string_lossy().into_owned();
    }
    let cwd = req.cli.as_ref().map(|c| c.cwd.clone()).unwrap_or_else(|| scratch.path().to_path_buf());
    let mut cmd = tokio::process::Command::new(&prog);
    cmd.args(&argv).current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let resumed = req.cli.as_ref().and_then(|context| context.resume.as_ref()).is_some();
    let images: Vec<&super::ImageInput> = if resumed {
        req.messages.iter().rev().find_map(|m|match m { ChatMsg::User{images,..}=>Some(images.iter().collect()),_=>None }).unwrap_or_default()
    } else {
        req.messages.iter().flat_map(|m| match m { ChatMsg::User{images,..}=>images.as_slice(),_=>&[] }).collect()
    };
    if images.len()>32 || images.iter().map(|i|i.data.len()).sum::<usize>()>8*1024*1024 {
        return Err(ProviderError::new("image_input_limit","CLI 이미지 입력 한도를 넘었습니다"));
    }
    let mut image_paths = Vec::new();
    if profile.protocol=="codex_cli" {
        use base64::Engine;
        for (i,image) in images.iter().enumerate() {
            let bytes=base64::engine::general_purpose::STANDARD.decode(&image.data)
                .map_err(|_|ProviderError::new("unsupported_image","CLI 이미지 입력 형식이 잘못됐습니다"))?;
            let extension=match image.mime.as_str(){"image/png"=>"png","image/webp"=>"webp","image/gif"=>"gif",_=>"jpg"};
            let file=scratch.path().join(format!("input-{i}.{extension}"));
            std::fs::write(&file,bytes).map_err(|_|ProviderError::new("cli_failed","CLI 이미지 임시 파일을 만들지 못했습니다"))?;
            if !app_server { cmd.arg("--image").arg(&file); }
            image_paths.push(file);
        }
    } else if !images.is_empty() {
        cmd.args(["--input-format","stream-json"]);
    }
    // 서버 내부 설정은 넘기지 않는다. CLI 인증은 CLI가 자기 설정에서 읽는다.
    for (k, _) in std::env::vars_os() {
        if k.to_str().is_some_and(|k| k.starts_with("GROVE_")) {
            cmd.env_remove(&k);
        }
    }
    for key in ["TMPDIR", "TMP", "TEMP"] { cmd.env(key, scratch.path()); }
    if profile.protocol == "claude_code" {
        if service_tier(req) == Some(STANDARD_SERVICE_TIER) {
            cmd.env("CLAUDE_CODE_DISABLE_FAST_MODE", "1");
            cmd.env("CLAUDE_CODE_EFFORT_LEVEL", req.effort.as_deref().unwrap_or("auto"));
        }
        if let Some(e) = &req.effort {
            cmd.env("MAX_THINKING_TOKENS", super::effort_budget(e).to_string());
        }
    }
    let tag = crate::util::new_id();
    // 모델 런타임 자체라 셸 작업용 자원 한도는 적용하지 않는다.
    let limits = crate::procs::Limits::default();
    crate::procs::prepare(&mut cmd, &tag, limits);
    let mut child = cmd.spawn().map_err(|e| {
        if crate::deps::is_missing(&prog, Some(&e)) {
            ProviderError::new("cli_not_found", crate::deps::message(&prog))
        } else {
            ProviderError::new("cli_failed", format!("{prog} 실행 실패: {e}"))
        }
    })?;
    let _guard = GroupGuard(crate::procs::adopt(&mut child, &tag, limits).map_err(|e| ProviderError::new("cli_failed", e))?);
    let mut stdin = child.stdin.take().expect("stdin");
    let input = if profile.protocol == "claude_code" && req.cli.as_ref().is_some_and(|c| c.native_command.is_some()) {
        current_text(req).to_string()
    } else {
        let input = prompt(req, resumed, profile.protocol == "codex_cli" && !resumed);
        // 일반 글의 "/"는 CLI 명령으로 승격하지 않는다. 명시적으로 선택한 명령만 원문 dispatch한다.
        if profile.protocol == "claude_code" && req.cli.is_some() && input.trim_start().starts_with('/') {
            format!("<user_message>\n{input}\n</user_message>")
        } else { input }
    };
    let input = if profile.protocol=="claude_code" && !images.is_empty() {
        let mut content=vec![json!({"type":"text","text":input})];
        content.extend(images.iter().map(|image|json!({"type":"image","source":{"type":"base64","media_type":image.mime,"data":image.data}})));
        format!("{}\n",json!({"type":"user","message":{"role":"user","content":content}}))
    } else { input };
    let stdout = child.stdout.take().expect("stdout");
    let mut stderr = child.stderr.take().expect("stderr");
    let err_task = tokio::spawn(async move {
        let mut tail = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = stderr.read(&mut chunk).await?;
            if n == 0 { break; }
            tail.extend_from_slice(&chunk[..n]);
            if tail.len() > 16 * 1024 { tail.drain(..tail.len() - 16 * 1024); }
        }
        Ok::<_, std::io::Error>(String::from_utf8_lossy(&tail).to_string())
    });
    if app_server {
        let mut reader = BufReader::new(stdout);
        let out = codex::run(&mut stdin, &mut reader, profile, req, &image_paths, on_delta).await?;
        stdin.shutdown().await.map_err(|_| ProviderError::new("cli_exited", "Codex 입력 연결 종료에 실패했습니다"))?;
        drop(stdin);
        // app-server는 턴 종료 뒤에도 살아 있다. stdin EOF로 정상 종료시키면서 남은 stdout/stderr도 비운다.
        return tokio::time::timeout(profile.timeout, async {
            let drain = async {
                while read_line(&mut reader).await?.is_some() {}
                Ok::<(), ProviderError>(())
            };
            let wait = async { child.wait().await.map_err(|_| ProviderError::new("cli_exited", "Codex 프로세스 상태를 확인하지 못했습니다")) };
            let (_, status) = tokio::try_join!(drain, wait)?;
            err_task.await.map_err(|_| ProviderError::new("cli_failed", "Codex 오류 출력 정리에 실패했습니다"))?
                .map_err(|_| ProviderError::new("cli_failed", "Codex 오류 출력을 읽지 못했습니다"))?;
            if !status.success() { return Err(ProviderError::new("cli_exited", "Codex 프로세스가 비정상 종료되었습니다")); }
            Ok(out)
        }).await.map_err(|_| ProviderError::new("idle_timeout", "Codex 프로세스가 종료되지 않았습니다"))?;
    }
    let input_task = tokio::spawn(async move {
        stdin.write_all(input.as_bytes()).await?;
        stdin.shutdown().await
    });
    let mut stream = CliStream::default();
    let mut lines = BufReader::new(stdout);
    // 무진행 감시(RUN-022): 전체 실행 시간이 아니라 출력 줄 사이의 무응답 시간만 프로필 timeout으로 제한한다.
    // 출력이 계속 오는 긴 작업은 끊지 않는다(HTTP provider의 read timeout과 같은 기준).
    let idle = profile.timeout;
    let body = async {
        loop {
            let next = match tokio::time::timeout(idle, read_line(&mut lines)).await {
                Err(_) if req.cli.as_ref().is_some_and(CliContext::waiting_for_grove_tool) => continue,
                Err(_) => {
                    return Err(ProviderError {
                        code: "idle_timeout",
                        message: format!("{prog}가 {}초 동안 아무 출력도 없어 중단했습니다", idle.as_secs()),
                        status: None,
                        retryable: true,
                        retry_after_secs: None,
                        stream_failure: None,
                    });
                }
                Ok(r) => r?,
            };
            let Some(line) = next else { break };
            let Ok(e) = serde_json::from_slice::<Value>(&line) else { continue };
            stream.apply(&profile.protocol, &e)?;
            on_delta(&stream.output);
        }
        Ok::<(), ProviderError>(())
    };
    body.await?;
    let status = tokio::time::timeout(idle, child.wait()).await
        .map_err(|_| ProviderError::new("idle_timeout", "에이전트 프로세스가 종료되지 않았습니다"))?
        .map_err(|e| ProviderError::new("cli_failed", e.to_string()))?;
    let stderr_text = tokio::time::timeout(idle, err_task).await
        .map_err(|_| ProviderError::new("idle_timeout", "에이전트 출력 정리가 끝나지 않았습니다"))?
        .map_err(|e| ProviderError::new("cli_failed", e.to_string()))?
        .map_err(|e| ProviderError::new("cli_failed", e.to_string()))?;
    let mut out = stream.output;
    if !status.success() || out.finish_reason.is_empty() {
        // 결과 없이 끝난 프로세스는 일반 실패와 구분한다(RUN-023: 프로세스 종료 원인).
        let tail: String = stderr_text.lines().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" / ");
        #[cfg(unix)]
        let sig = {
            use std::os::unix::process::ExitStatusExt;
            status.signal()
        };
        #[cfg(not(unix))]
        let sig: Option<i32> = None;
        let how = match (status.code(), sig) {
            (_, Some(s)) => format!("신호 {s}"),
            (Some(c), _) => format!("종료 코드 {c}"),
            _ => status.to_string(),
        };
        return Err(ProviderError::new("cli_exited", format!("{prog} 프로세스가 결과 없이 끝났습니다({how}): {tail}")));
    }
    input_task.await.map_err(|e| ProviderError::new("cli_failed", e.to_string()))?
        .map_err(|e| ProviderError::new("cli_failed", format!("에이전트 입력 전달 실패: {e}")))?;
    if let Some(t) = stream.final_text {
        out.text = t;
    }
    // 이어 쓰지 않는 호출은 세션을 저장하지 않는다.
    if req.cli.is_none() {
        out.native_session = None;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn prof(p: &str) -> Profile {
        Profile { protocol: p.into(), base_url: String::new(), model: "m".into(), api_key: None, timeout: Duration::from_secs(5), extra_headers: vec![], sensitive_headers: vec![] }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn images_reach_claude_structured_input_on_new_and_resumed_calls(){
        use base64::Engine;
        let mut bytes=std::io::Cursor::new(vec![]);
        image::DynamicImage::new_rgb8(2,2).write_to(&mut bytes,image::ImageFormat::Png).unwrap();
        let bytes=bytes.into_inner();
        let image=super::super::ImageInput{id:"test".into(),sha256:crate::util::sha256_hex(&bytes),width:2,height:2,mime:"image/png".into(),data:base64::engine::general_purpose::STANDARD.encode(bytes)};
        for resume in [None,Some("native")] {
            let temp=tempfile::tempdir().unwrap();
            let mut request=req(resume);
            request.cli.as_mut().unwrap().cwd=temp.path().into();
            request.messages=vec![ChatMsg::User{text:"inspect the attached test image".into(),images:vec![image.clone()]}];
            let script=r#"[[ "$input" == *'"type":"user"'* && "$input" == *'"type":"image"'* && "$input" == *'"media_type":"image/png"'* ]] || exit 8
echo '{"type":"result","subtype":"success","result":"image received","usage":{"input_tokens":1,"output_tokens":1}}'"#;
            let out=stream_with(&prof("claude_code"),&request,&mut |_|{},Some(&fake_cli(temp.path(),script))).await.unwrap();
            assert_eq!(out.text,"image received");
        }
    }
    #[test]
    fn background_mcp_coexists_with_computer_on_both_native_backends() {
        for protocol in ["codex_cli","claude_code"] {
            let mut request=req(Some("native"));
            let context=request.cli.as_mut().unwrap();
            context.computer=Some(crate::computer::bridge::Link { file:"/turn-owned/computer.json".into(),waiting:std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)) });
            context.continuations=Some(crate::continuations::bridge::Link { file:"/turn-owned/continuations.json".into(),waiting:std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)) });
            assert!(!context.waiting_for_grove_tool());
            context.continuations.as_ref().unwrap().waiting.store(1,std::sync::atomic::Ordering::Release);
            assert!(context.waiting_for_grove_tool());
            let (args,_)=args(&prof(protocol),&request,"new");
            let joined=args.join(" ");
            assert!(joined.contains("grove_computer")&&joined.contains("grove_continuations")&&joined.contains("continuation-mcp"));
            assert!(joined.contains("continue_later")&&joined.contains("shell"));
            if protocol=="claude_code" {
                assert_eq!(args.iter().filter(|v|v.as_str()=="--mcp-config").count(),1);
                let i=args.iter().position(|v|v=="--mcp-config").unwrap();
                let config:Value=serde_json::from_str(&args[i+1]).unwrap();
                assert_eq!(config["mcpServers"].as_object().unwrap().len(),2);
            }
        }
    }

    #[test]
    fn computer_mcp_is_explicit_per_turn_with_unrestricted_cli_permissions(){
        for protocol in ["codex_cli","claude_code"] {
            let mut request=req(Some("native"));
            request.cli.as_mut().unwrap().computer=Some(crate::computer::bridge::Link{
                file:"/turn-owned/bridge.json".into(),waiting:std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false))
            });
            let (args,_)=args(&prof(protocol),&request,"unused");
            let joined=args.join(" ");
            assert!(joined.contains("grove_computer")&&joined.contains("computer-mcp")&&joined.contains("/turn-owned/bridge.json"));
            if protocol=="codex_cli"{
                assert!(args.contains(&"sandbox_mode=\"danger-full-access\"".into()));
                assert!(args.contains(&"approval_policy=\"never\"".into()));
                assert!(!args.contains(&"--ignore-user-config".into()));
                assert!(joined.contains("mcp_servers.grove_computer.tools.computer.approval_mode=\"approve\""));
                assert!(joined.contains("mcp_servers.grove_computer.enabled_tools=[\"computer\"]"));
            }
            else{assert!(args.contains(&"--dangerously-skip-permissions".into())&&!joined.contains("--strict-mcp-config")&&joined.contains("mcp__grove_computer__computer"));}
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn catalog_initializes_without_user_messages_and_reads_both_official_control_shapes() {
        use std::os::unix::fs::PermissionsExt;
        for (protocol, script) in [
            ("claude_code", r#"read -r init
[[ "$init" == *'"subtype":"initialize"'* ]] || exit 7
echo '{"type":"control_response","response":{"request_id":"grove-models","subtype":"success","response":{"models":[{"value":"fixture-claude","resolvedModel":"claude-opus-5-5","displayName":"Opus"}]}}}'
"#),
            ("codex_cli", r#"read -r init
[[ "$init" == *'"method":"initialize"'* ]] || exit 7
echo '{"id":1,"result":{}}'
read -r initialized
read -r listing
[[ "$listing" == *'"method":"model/list"'* ]] || exit 8
echo '{"id":2,"result":{"data":[{"model":"fixture-codex","displayName":"Codex fixture","isDefault":true,"defaultReasoningEffort":"medium","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"xhigh"},{"reasoningEffort":"max"}],"serviceTiers":[{"id":"priority","name":"Fast","description":"Increased usage"}]}],"nextCursor":"next"}}'
read -r listing
[[ "$listing" == *'"cursor":"next"'* ]] || exit 9
echo '{"id":2,"result":{"data":[{"model":"fixture-codex-2","displayName":"Second fixture"}]}}'
"#),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("cli");
            std::fs::write(&path, format!("#!/bin/bash\n{script}")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            let result = tokio::time::timeout(Duration::from_secs(5), list_models_with(protocol, Some(&path))).await.unwrap().unwrap();
            assert_eq!(result.len(), if protocol == "claude_code" { 1 } else { 2 });
            assert!(result.iter().all(|m| m.id.starts_with("fixture-")));
            if protocol == "claude_code" {
                assert_eq!(result[0].id, "fixture-claude");
                assert_eq!(result[0].name, "Opus 5.5");
            }
            if protocol == "codex_cli" {
                assert_eq!(result[0].reasoning_efforts.as_ref().unwrap(), &["low", "xhigh", "max"]);
                assert_eq!(result[0].default_reasoning_effort.as_deref(), Some("medium"));
                assert_eq!(result[0].is_default, Some(true));
                let tiers = result[0].service_tiers.as_ref().unwrap();
                assert_eq!((&tiers[0].id[..], &tiers[0].name[..]), ("priority", "Fast"));
            }
        }
    }
    #[test]
    fn claude_catalog_names_use_resolved_versions_without_guessing() {
        for (row, expected) in [
            (json!({"displayName":"Opus","resolvedModel":"claude-opus-5-5"}), "Opus 5.5"),
            (json!({"displayName":"Fable","resolvedModel":"claude-fable-5-2"}), "Fable 5.2"),
            (json!({"displayName":"Sonnet","resolvedModel":"claude-3-7-sonnet-20250219"}), "Sonnet 3.7"),
            (json!({"displayName":"Haiku 5.5","resolvedModel":"claude-haiku-5-5"}), "Haiku 5.5"),
            (json!({"displayName":"Opus","resolvedModel":"claude-opus-5.5"}), "Opus 5.5"),
            (json!({"displayName":"Opus"}), "Opus"),
            (json!({"displayName":"Opus","resolvedModel":"custom-opus"}), "Opus"),
            (json!({}), "opus"),
        ] {
            assert_eq!(claude_catalog_name(&row, "opus"), expected);
        }
    }
    fn req(resume: Option<&str>) -> ModelRequest {
        ModelRequest {
            system: "sys".into(),
            messages: vec![
                ChatMsg::User { text: "첫 질문".into(), images: vec![] },
                ChatMsg::Assistant { text: "첫 답".into(), tool_calls: vec![], native: None },
                ChatMsg::User { text: "다음 질문".into(), images: vec![] },
            ],
            tools: vec![],
            max_tokens: None,
            temperature: None,
            effort: None,
            cli: Some(CliContext { cwd: "/tmp".into(), resume: resume.map(String::from), service_tier: None, computer: None, continuations: None, native_command: None, steers: None }),
        }
    }

    /// 신규 실행과 resume 모두 CLI의 파일·네트워크 sandbox와 권한 확인을 생략한다.
    #[test]
    fn coding_permissions_are_unrestricted_on_start_and_resume() {
        for resume in [None, Some("abc")] {
            let (a, p) = args(&prof("claude_code"), &req(resume), "sid-1");
            assert_eq!(p, "claude");
            assert!(a.contains(&"--dangerously-skip-permissions".into()));
            assert!(!a.contains(&"--restricted".into()) && !a.contains(&"--permission-mode".into()));
            assert!(a.windows(2).any(|w| w[0] == "--tools" && w[1] == "default"));
            let settings: Value = serde_json::from_str(&a[a.iter().position(|v| v == "--settings").unwrap()+1]).unwrap();
            assert_eq!(settings, json!({"sandbox": {"enabled": false}}));
            assert!(!a.contains(&"--setting-sources".into()), "전역·프로젝트 지침의 기본 로딩을 막지 않는다");
            assert!(!a.contains(&"--strict-mcp-config".into()), "일반 대화의 사용자 MCP를 차단하지 않는다");
            let session_flag = if resume.is_some() { "--resume" } else { "--session-id" };
            assert!(a.windows(2).any(|w| w[0] == session_flag && w[1] == resume.unwrap_or("sid-1")));
        }
        let mut summary = req(None);
        summary.cli = None;
        let (a, _) = args(&prof("claude_code"), &summary, "x");
        assert!(a.windows(2).any(|w| w[0] == "--tools" && w[1].is_empty()), "제목·요약은 프로젝트 도구를 쓰지 않는다");
        assert!(a.contains(&"--no-session-persistence".into()));
        assert!(a.windows(2).any(|w| w[0] == "--setting-sources" && w[1].is_empty()));
        assert!(a.contains(&"--strict-mcp-config".into()), "제목·요약에는 사용자 MCP를 연결하지 않는다");
        let settings: Value = serde_json::from_str(&a[a.iter().position(|v| v == "--settings").unwrap()+1]).unwrap();
        assert_eq!(settings["disableAllHooks"], true, "제목·요약은 사용자 hook을 실행하지 않는다");
        for r in [None, Some("t1")] {
            let (a, p) = args(&prof("codex_cli"), &req(r), "x");
            assert_eq!(p, "codex");
            assert_eq!(&a[..3], ["app-server", "--listen", "stdio://"]);
            assert!(a.contains(&"sandbox_mode=\"danger-full-access\"".into()));
            assert!(a.contains(&"approval_policy=\"never\"".into()));
            assert!(!a.contains(&"--ignore-user-config".into()), "일반 대화는 CLI의 기억·hook·MCP 설정을 사용한다");
            assert!(!a.contains(&"exec".into()), "일반 대화는 실제 delta를 받는 app-server를 쓴다");
        }
        let (a, _) = args(&prof("codex_cli"), &summary, "x");
        assert!(a.contains(&"--dangerously-bypass-approvals-and-sandbox".into()));
        assert!(a.contains(&"--ephemeral".into()));
        assert!(a.contains(&"service_tier=\"default\"".into()));
    }

    #[test]
    fn codex_reasoning_and_speed_are_independent_and_preserved_on_resume() {
        for resume in [None, Some("thread")] {
            for effort in ["low", "medium", "high", "xhigh", "max", "ultra"] {
                for tier in ["default", "priority"] {
                    let mut request = req(resume);
                    request.effort = Some(effort.into());
                    request.cli.as_mut().unwrap().service_tier = Some(tier.into());
                    let (args, _) = args(&prof("codex_cli"), &request, "new");
                    assert!(args.contains(&format!("model_reasoning_effort=\"{effort}\"")));
                    assert!(args.contains(&format!("service_tier=\"{tier}\"")));
                    assert!(args.contains(&"sandbox_mode=\"danger-full-access\"".into()));
                    assert!(args.contains(&"approval_policy=\"never\"".into()));
                }
            }
        }
    }

    #[test]
    fn prompt_includes_history_only_without_resume() {
        let p = prompt(&req(None), false, false);
        assert!(p.contains("[user]\n첫 질문") && p.contains("[assistant]\n첫 답") && p.ends_with("다음 질문"));
        assert_eq!(prompt(&req(Some("r")), true, false), "다음 질문", "resume이면 마지막 요청만");
        let mut r = req(None);
        r.cli = None;
        let (a, _) = args(&prof("codex_cli"), &r, "s");
        assert!(a.contains(&"--ephemeral".to_string()), "문맥 없는 호출은 세션을 남기지 않는다");
    }

    #[test]
    fn events_map_text_usage_activity_and_session() {
        let mut o = ModelOutput::default();
        let mut f = None;
        for l in [
            r#"{"type":"system","subtype":"init","session_id":"S1"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"a"}}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"답"}]}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"최종 답","session_id":"S1","usage":{"input_tokens":4,"cache_read_input_tokens":10,"cache_creation_input_tokens":6,"output_tokens":7},"permission_denials":[{"tool_name":"Write","tool_input":{}}]}"#,
        ] {
            apply_event("claude_code", &serde_json::from_str(l).unwrap(), &mut o, &mut f).unwrap();
        }
        assert_eq!(o.native_session.as_deref(), Some("S1"));
        assert_eq!(f.as_deref(), Some("최종 답"));
        assert_eq!((o.usage.input_tokens, o.usage.output_tokens, o.usage.cache_read_tokens), (20, 7, 10));
        assert!(o.tool_calls.is_empty(), "CLI 도구는 Grove가 실행하지 않는다");
        assert_eq!(o.activity.len(), 2);
        assert_eq!(o.activity[1]["kind"], "denied");

        let mut o = ModelOutput::default();
        for l in [
            r#"{"type":"thread.started","thread_id":"T1"}"#,
            r#"{"type":"item.completed","item":{"type":"command_execution","command":"cat a","status":"completed","exit_code":0}}"#,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"KIWI"}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":5,"reasoning_output_tokens":2}}"#,
        ] {
            apply_event("codex_cli", &serde_json::from_str(l).unwrap(), &mut o, &mut f).unwrap();
        }
        assert_eq!((o.native_session.as_deref(), o.text.as_str(), o.usage.input_tokens, o.usage.cache_read_tokens), (Some("T1"), "KIWI", 100, 60));
        assert_eq!(o.activity[0]["kind"], "command");
        let e = apply_event("codex_cli", &json!({ "type": "turn.failed", "error": { "message": "quota" } }), &mut o, &mut f).unwrap_err();
        assert_eq!(e.code, "cli_failed");
    }

    #[test]
    fn claude_context_usage_tracks_last_main_request_with_cache_and_ignores_aggregate_result() {
        let mut stream = CliStream::default();
        for (input, cached, output) in [(80_000, 10_000, 500), (1_000, 2_000, 200)] {
            stream.apply("claude_code", &json!({"type":"stream_event","event":{"type":"message_start",
                "message":{"usage":{"input_tokens":input,"cache_read_input_tokens":cached,"cache_creation_input_tokens":300}}}})).unwrap();
            stream.apply("claude_code", &json!({"type":"stream_event","event":{"type":"message_delta",
                "usage":{"output_tokens":output}}})).unwrap();
        }
        stream.apply("claude_code", &json!({"type":"assistant","parent_tool_use_id":"agent",
            "message":{"usage":{"input_tokens":70_000,"output_tokens":10},"content":[]}})).unwrap();
        stream.apply("claude_code", &json!({"type":"result","usage":{"input_tokens":500_000,"output_tokens":40_000},
            "modelUsage":{"main":{"contextWindow":200_000}}})).unwrap();
        assert_eq!(stream.output.context_usage, Some(ContextUsage { tokens:Some(3_500), context_window:Some(200_000) }));
        assert_eq!(stream.output.usage.input_tokens, 500_000);

        let mut output = ModelOutput::default();
        apply_event("claude_code", &json!({"type":"assistant","message":{"content":[],
            "usage":{"input_tokens":100,"cache_read_input_tokens":200,"output_tokens":20}}}), &mut output, &mut None).unwrap();
        assert_eq!(output.context_usage.unwrap().tokens, Some(320));
        let mut output = ModelOutput::default();
        apply_event("claude_code", &json!({"type":"result","usage":{"input_tokens":900_000},
            "modelUsage":{"main":{"contextWindow":200_000}}}), &mut output, &mut None).unwrap();
        assert_eq!(output.context_usage.unwrap(), ContextUsage { tokens:None, context_window:Some(200_000) });
    }

    /// 가짜 CLI 실행 파일. 인자는 무시하고 스크립트대로 stream-json 줄을 낸다.
    #[cfg(unix)]
    fn fake_cli(dir: &std::path::Path, script: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join(format!("fake-{}", uuid::Uuid::new_v4()));
        std::fs::write(&p, format!("#!/bin/bash\ninput=\"$(cat)\"\n{script}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_result_does_not_override_failed_process() {
        let dir = tempfile::tempdir().unwrap();
        let script = "echo '{\"type\":\"turn.completed\",\"usage\":{}}'; exit 7";
        let mut request = req(None);
        request.cli = None;
        let result = stream_with(&prof("codex_cli"), &request, &mut |_| {}, Some(&fake_cli(dir.path(), script))).await;
        assert_eq!(result.unwrap_err().code, "cli_exited");
    }

    #[test]
    fn default_model_and_user_input_are_not_forced_into_argv() {
        for protocol in ["claude_code", "codex_cli"] {
            let mut profile = prof(protocol);
            profile.model = "default".into();
            let (args, _) = args(&profile, &req(None), "session");
            assert!(!args.iter().any(|arg| arg == "--model" || arg == "-m" || arg.contains("첫 질문") || arg.contains("다음 질문")));
        }
    }

    #[test]
    fn partial_messages_are_streamed_and_final_snapshots_do_not_duplicate_them() {
        let mut state = CliStream::default();
        state.apply("claude_code", &json!({"type":"stream_event","event":{"type":"message_start"}})).unwrap();
        state.apply("claude_code", &json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"첫"}}})).unwrap();
        assert_eq!(state.output.text, "첫");
        state.apply("claude_code", &json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":" 답"}}})).unwrap();
        assert_eq!(state.output.text, "첫 답");
        state.apply("claude_code", &json!({"type":"assistant","message":{"content":[{"type":"text","text":"첫 답"}]}})).unwrap();
        assert_eq!(state.output.text, "첫 답");
        state.apply("claude_code", &json!({"type":"assistant","message":{"content":[{"type":"text","text":"첫 답"}]}})).unwrap();
        assert_eq!(state.output.text, "첫 답\n\n첫 답", "서로 다른 최종 메시지는 내용이 같아도 유지한다");

        let mut state = CliStream::default();
        for (event, text) in [("item.started", ""), ("item.updated", "첫"), ("item.updated", "첫 답"), ("item.completed", "첫 답")] {
            state.apply("codex_cli", &json!({"type":event,"item":{"id":"m1","type":"agent_message","text":text}})).unwrap();
            assert_eq!(state.output.text, text);
        }
        state.apply("codex_cli", &json!({"type":"item.completed","item":{"id":"m2","type":"agent_message","text":"둘째 답"}})).unwrap();
        assert_eq!(state.output.text, "첫 답\n\n둘째 답");
        assert_eq!(state.output.response_parts, ["첫 답", "둘째 답"]);
    }

    #[test]
    fn cli_progress_stays_separate_from_reasoning_and_last_answer() {
        let mut state = CliStream::default();
        for item in [
            json!({"id":"r1","type":"reasoning","text":"링크 대상을 확인해야 한다"}),
            json!({"id":"m1","type":"agent_message","text":"심볼릭 링크인지 확인할게."}),
            json!({"id":"c1","type":"command_execution","command":"readlink a","status":"completed","exit_code":0}),
            json!({"id":"m2","type":"agent_message","text":"맞아. 확인 결과 심볼릭 링크야."}),
        ] {
            state.apply("codex_cli", &json!({"type":"item.completed","item":item})).unwrap();
        }
        assert_eq!(state.output.reasoning, "링크 대상을 확인해야 한다");
        assert_eq!(state.output.response_parts, ["심볼릭 링크인지 확인할게.", "맞아. 확인 결과 심볼릭 링크야."]);
        assert_eq!(state.output.text, "심볼릭 링크인지 확인할게.\n\n맞아. 확인 결과 심볼릭 링크야.");

        let mut state = CliStream::default();
        for text in ["확인할게.", "결과야."] {
            state.apply("claude_code", &json!({"type":"stream_event","event":{"type":"message_start"}})).unwrap();
            state.apply("claude_code", &json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":text}}})).unwrap();
            state.apply("claude_code", &json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"추론"},{"type":"text","text":text}]}})).unwrap();
        }
        state.apply("claude_code", &json!({"type":"result","result":"최종 결과야.","usage":{}})).unwrap();
        assert_eq!(state.output.reasoning, "추론추론");
        assert_eq!(state.output.response_parts, ["확인할게.", "최종 결과야."]);
    }

    #[test]
    fn native_activity_is_visible_before_completion_and_snapshots_do_not_duplicate_it() {
        let mut state = CliStream::default();
        for status in ["in_progress", "completed"] {
            state.apply("codex_cli", &json!({"type":if status=="completed" {"item.completed"} else {"item.started"},
                "item":{"id":"shell-1","type":"command_execution","command":"python3 -m unittest","status":status,"exit_code":0}})).unwrap();
            assert_eq!(state.output.activity.len(), 1);
            assert_eq!(state.output.activity[0]["status"], status);
        }
        let mut state = CliStream::default();
        let tool = json!({"id":"tool-1","type":"tool_use","name":"Bash","input":{"command":"python3 -m unittest"}});
        state.apply("claude_code", &json!({"type":"stream_event","event":{"type":"content_block_start","content_block":tool}})).unwrap();
        assert_eq!(state.output.activity[0]["status"], "running");
        state.apply("claude_code", &json!({"type":"assistant","message":{"content":[tool]}})).unwrap();
        assert_eq!(state.output.activity.len(), 1);
        state.apply("claude_code", &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","is_error":false,"content":"OK"}]}})).unwrap();
        assert_eq!(state.output.activity.len(), 1);
        assert_eq!(state.output.activity[0]["status"], "completed");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn large_input_and_stderr_do_not_block_the_stream() {
        let dir = tempfile::tempdir().unwrap();
        let script = "test \"${#input}\" -gt 200000 || exit 8; head -c 200000 /dev/zero >&2; echo '{\"type\":\"turn.completed\",\"usage\":{}}'";
        let mut request = req(None);
        request.cli = None;
        request.messages = vec![ChatMsg::User { text: "x".repeat(256 * 1024), images: vec![] }];
        let output = stream_with(&prof("codex_cli"), &request, &mut |_| {}, Some(&fake_cli(dir.path(), script))).await.unwrap();
        assert_eq!(output.finish_reason, "stop");
    }

    #[tokio::test]
    async fn unterminated_output_is_bounded_before_allocation_grows() {
        let bytes = vec![b'x'; MAX_LINE_BYTES + 1];
        let mut reader = BufReader::new(bytes.as_slice());
        assert_eq!(read_line(&mut reader).await.unwrap_err().code, "output_too_large");
    }

    /// 무진행 감시는 출력 사이 간격만 본다: 전체 시간이 timeout보다 길어도 출력이 계속 오면 끝까지 받고,
    /// 출력이 멈추면 idle_timeout, 결과 없이 프로세스가 끝나면 cli_exited로 구분한다(RUN-022, RUN-023).
    #[cfg(unix)]
    #[tokio::test]
    async fn idle_watch_and_process_exit_are_distinct() {
        let d = tempfile::tempdir().unwrap();
        let mut p = prof("claude_code");
        p.timeout = Duration::from_millis(800);
        let mut r = req(None);
        r.cli = None;
        let ev = |t: &str| format!("echo '{{\"type\":\"assistant\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"{t}\"}}]}}}}'");
        // 0.3초 간격 출력 8번 = 2.4초(> timeout 0.8초) 뒤 결과
        let steady = format!(
            "echo '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"S\"}}'; for i in 1 2 3 4 5 6 7 8; do sleep 0.3; {}; done; \
             echo '{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"끝\",\"usage\":{{}}}}'",
            ev("진행")
        );
        let started = std::time::Instant::now();
        let o = stream_with(&p, &r, &mut |_| {}, Some(&fake_cli(d.path(), &steady))).await.expect("진행 중인 긴 작업은 끊지 않는다");
        assert!(started.elapsed() > Duration::from_secs(2));
        assert_eq!(o.text, "끝");
        // 출력이 멈춤
        let e = stream_with(&p, &r, &mut |_| {}, Some(&fake_cli(d.path(), &format!("{}; sleep 5", ev("시작"))))).await.unwrap_err();
        assert_eq!(e.code, "idle_timeout", "{e:?}");
        // 결과 없이 종료(종료 코드)·신호
        let e = stream_with(&p, &r, &mut |_| {}, Some(&fake_cli(d.path(), "echo boom >&2; exit 3"))).await.unwrap_err();
        assert_eq!(e.code, "cli_exited", "{e:?}");
        assert!(e.message.contains("종료 코드 3") && e.message.contains("boom"), "{}", e.message);
        let e = stream_with(&p, &r, &mut |_| {}, Some(&fake_cli(d.path(), "kill -9 $$"))).await.unwrap_err();
        assert!(e.message.contains("신호 9"), "{}", e.message);
    }
}
