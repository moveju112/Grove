//! 서버에 설치된 에이전트 CLI를 모델 백엔드로 쓰는 어댑터(protocol `claude_code`, `codex_cli`).
//!
//! - CLI는 자기 안에서 도구를 실행한다. Grove는 CLI의 도구 호출을 `tool_calls`로 받지 않는다(받으면 runner가 다시 실행하려 함).
//!   대신 표시 전용 `activity`로 기록한다.
//! - **권한은 사용자 CLI 설정과 무관하게 읽기 전용으로 강제한다**(사용자 설정에 bypassPermissions가 있어도 Grove 승인 없이 변경 금지).
//!   claude: `--permission-mode default --tools Read,Glob,Grep --setting-sources "" --strict-mcp-config`(사용자 hook·MCP 미사용)
//!   codex: `--sandbox read-only -c approval_policy="never"`
//! - 대화 연속성: Grove 대화×프로필마다 CLI 세션 ID를 저장하고(runner) 다음 요청에서 resume한다. 저장된 세션이 없으면
//!   지금까지의 user/assistant 텍스트를 프롬프트에 넣는다. 실행 문맥이 없는 호출(제목·요약)은 빈 임시 디렉터리에서 세션을 남기지 않는다.
//! - 취소·timeout: 새 process group으로 띄우고, future가 버려지면(취소) group 전체를 종료한다.
//! - CLI의 인증은 CLI 자신이 처리한다. Grove는 CLI 자격증명 파일을 읽지 않는다.

use super::{ChatMsg, ModelOutput, ModelRequest, OnDelta, Profile, ProviderError, Usage};
use serde_json::{Value, json};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ACTIVITY: usize = 512;

/// 실행 문맥: 작업 디렉터리(프로젝트 root)와 이어 쓸 CLI 세션 ID.
#[derive(Debug, Clone, Default)]
pub struct CliContext {
    pub cwd: std::path::PathBuf,
    pub resume: Option<String>,
    pub service_tier: Option<String>,
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

/// CLI 인자. 시험에서 강제 권한 플래그를 검사할 수 있게 분리한다.
pub fn args(profile: &Profile, req: &ModelRequest, new_session: &str) -> (Vec<String>, String) {
    let resume = req.cli.as_ref().and_then(|c| c.resume.clone());
    let persist = req.cli.is_some();
    let s = |x: &str| x.to_string();
    if profile.protocol == "claude_code" {
        let mut a = vec![s("-p"), s("--output-format"), s("stream-json"), s("--verbose"), s("--include-partial-messages")];
        if profile.model != "default" {
            a.extend([s("--model"), profile.model.clone()]);
        }
        // 읽기 전용 강제: 사용자 설정(bypassPermissions·hook)과 MCP를 쓰지 않는다.
        a.extend([s("--permission-mode"), s("default"), s("--tools"), s("Read,Glob,Grep"), s("--setting-sources"), s(""), s("--strict-mcp-config")]);
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
        if profile.model != "default" {
            a.extend([s("-m"), profile.model.clone()]);
        }
        // 읽기 전용 강제(resume에도 같은 정책). resume 하위 명령은 -C·--sandbox를 받지 않으므로 -c로 지정한다.
        a.extend([s("-c"), s("sandbox_mode=\"read-only\""), s("-c"), s("approval_policy=\"never\"")]);
        if let Some(e) = &req.effort {
            a.extend([s("-c"), format!("model_reasoning_effort=\"{e}\"")]);
        }
        if let Some(tier) = req.cli.as_ref().and_then(|c| c.service_tier.as_deref()) {
            a.extend([s("-c"), format!("service_tier={}", json!(tier))]);
        }
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
                for c in e["message"]["content"].as_array().into_iter().flatten() {
                    match c["type"].as_str().unwrap_or("") {
                        "text" => {
                            if !out.text.is_empty() {
                                out.text.push_str("\n\n");
                            }
                            out.text.push_str(c["text"].as_str().unwrap_or(""));
                        }
                        "thinking" => out.reasoning.push_str(c["thinking"].as_str().unwrap_or("")),
                        "tool_use" => out.activity.push(json!({ "kind": "tool", "name": c["name"], "input": summarize(&c["input"]) })),
                        _ => {}
                    }
                }
            }
            "result" => {
                if let Some(id) = e["session_id"].as_str() {
                    out.native_session = Some(id.to_string());
                }
                let u = &e["usage"];
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
    codex_messages: Vec<(String, String)>,
    codex_reasoning: Vec<(String, String)>,
}

impl CliStream {
    fn apply(&mut self, protocol: &str, event: &Value) -> Result<(), ProviderError> {
        if protocol == "claude_code" && event["type"] == "stream_event" {
            let e = &event["event"];
            if e["type"] == "message_start" {
                self.claude_partial = Some((self.output.text.len(), self.output.reasoning.len(), false));
            }
            let text = if e["type"] == "content_block_delta" { e["delta"]["text"].as_str() }
                else if e["type"] == "content_block_start" { e["content_block"]["text"].as_str() } else { None };
            let thinking = if e["type"] == "content_block_delta" { e["delta"]["thinking"].as_str() }
                else if e["type"] == "content_block_start" { e["content_block"]["thinking"].as_str() } else { None };
            let state = self.claude_partial.get_or_insert((self.output.text.len(), self.output.reasoning.len(), false));
            if let Some(text) = text.filter(|text| !text.is_empty()) {
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
            if item["type"] == "reasoning" { self.output.reasoning = combined; } else { self.output.text = combined; }
        } else {
            if protocol == "claude_code" && event["type"] == "assistant"
                && let Some((text, reasoning, _)) = self.claude_partial.take()
            {
                self.output.text.truncate(text);
                self.output.reasoning.truncate(reasoning);
            }
            apply_event(protocol, event, &mut self.output, &mut self.final_text)?;
        }
        if self.output.text.len() + self.output.reasoning.len() > super::MAX_OUTPUT_BYTES
            || self.final_text.as_ref().is_some_and(|text| text.len() > super::MAX_OUTPUT_BYTES)
            || self.output.activity.len() > MAX_ACTIVITY
            || self.codex_messages.len() + self.codex_reasoning.len() > MAX_ACTIVITY
        {
            return Err(ProviderError::new("output_too_large", "에이전트 응답 한도를 초과했습니다"));
        }
        Ok(())
    }
}

/// 개행이 없는 출력도 메모리 한도를 넘기기 전에 중단한다.
async fn read_line<R: tokio::io::AsyncRead + Unpin>(reader: &mut BufReader<R>) -> Result<Option<Vec<u8>>, ProviderError> {
    let mut line = Vec::new();
    loop {
        let bytes = reader.fill_buf().await.map_err(|e| ProviderError::new("cli_failed", e.to_string()))?;
        if bytes.is_empty() { return Ok((!line.is_empty()).then_some(line)); }
        let len = bytes.iter().position(|b| *b == b'\n').map_or(bytes.len(), |i| i + 1);
        if line.len() + len > MAX_LINE_BYTES { return Err(ProviderError::new("output_too_large", "에이전트 출력 줄이 너무 큽니다")); }
        let complete = bytes[len - 1] == b'\n';
        line.extend_from_slice(&bytes[..len]);
        reader.consume(len);
        if complete { return Ok(Some(line)); }
    }
}

/// 이 호출이 만든 고유 임시 디렉터리(끝나면 지운다).
struct ScratchDir(std::path::PathBuf);
impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
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

async fn list_models_with(protocol: &str, executable: Option<&std::path::Path>) -> Result<Vec<super::AvailableModel>, ProviderError> {
    let dir = std::env::temp_dir().join(format!("grove-catalog-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).map_err(|_| ProviderError::new("catalog_failed", "목록 조회 임시 디렉터리를 만들지 못했습니다"))?;
    let scratch = ScratchDir(dir);
    let prog = executable.map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| program(protocol).into());
    let mut cmd = tokio::process::Command::new(&prog);
    if protocol == "claude_code" {
        cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence"]);
    } else {
        cmd.args(["app-server", "-c", "sandbox_mode=\"read-only\"", "-c", "approval_policy=\"never\""]);
    }
    cmd.current_dir(&scratch.0).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
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
            let name = row["displayName"].as_str().unwrap_or(id).chars().take(200).collect();
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
    let new_session = uuid::Uuid::new_v4().to_string();
    let (argv, name) = args(profile, req, &new_session);
    let prog = program.map(|p| p.to_string_lossy().to_string()).unwrap_or(name);
    // 실행 문맥이 없으면(제목·요약) 빈 임시 디렉터리에서 실행한다.
    let scratch = match req.cli {
        Some(_) => None,
        None => {
            let d = std::env::temp_dir().join(format!("grove-cli-{new_session}"));
            std::fs::create_dir(&d).map_err(|e| ProviderError::new("cli_failed", format!("임시 디렉터리: {e}")))?;
            Some(ScratchDir(d))
        }
    };
    let cwd = req.cli.as_ref().map(|c| c.cwd.clone()).unwrap_or_else(|| scratch.as_ref().expect("scratch").0.clone());
    let mut cmd = tokio::process::Command::new(&prog);
    cmd.args(&argv).current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // 서버 내부 설정은 넘기지 않는다. CLI 인증은 CLI가 자기 설정에서 읽는다.
    for (k, _) in std::env::vars_os() {
        if k.to_str().is_some_and(|k| k.starts_with("GROVE_")) {
            cmd.env_remove(&k);
        }
    }
    // Claude Code는 생각 token 상한 환경 변수로 effort를 받는다.
    if profile.protocol == "claude_code"
        && let Some(e) = &req.effort
    {
        cmd.env("MAX_THINKING_TOKENS", super::effort_budget(e).to_string());
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
    let resumed = req.cli.as_ref().and_then(|context| context.resume.as_ref()).is_some();
    let input = prompt(req, resumed, profile.protocol == "codex_cli" && !resumed);
    let input_task = tokio::spawn(async move {
        stdin.write_all(input.as_bytes()).await?;
        stdin.shutdown().await
    });
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
    let mut stream = CliStream::default();
    let mut lines = BufReader::new(stdout);
    // 무진행 감시(RUN-022): 전체 실행 시간이 아니라 출력 줄 사이의 무응답 시간만 프로필 timeout으로 제한한다.
    // 출력이 계속 오는 긴 작업은 끊지 않는다(HTTP provider의 read timeout과 같은 기준).
    let idle = profile.timeout;
    let body = async {
        loop {
            let next = match tokio::time::timeout(idle, read_line(&mut lines)).await {
                Err(_) => {
                    return Err(ProviderError {
                        code: "idle_timeout",
                        message: format!("{prog}가 {}초 동안 아무 출력도 없어 중단했습니다", idle.as_secs()),
                        status: None,
                        retryable: true,
                        retry_after_secs: None,
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
    async fn catalog_initializes_without_user_messages_and_reads_both_official_control_shapes() {
        use std::os::unix::fs::PermissionsExt;
        for (protocol, script) in [
            ("claude_code", r#"read -r init
[[ "$init" == *'"subtype":"initialize"'* ]] || exit 7
echo '{"type":"control_response","response":{"request_id":"grove-models","subtype":"success","response":{"models":[{"value":"fixture-claude","displayName":"Claude fixture"}]}}}'
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
            if protocol == "codex_cli" {
                assert_eq!(result[0].reasoning_efforts.as_ref().unwrap(), &["low", "xhigh", "max"]);
                assert_eq!(result[0].default_reasoning_effort.as_deref(), Some("medium"));
                assert_eq!(result[0].is_default, Some(true));
                let tiers = result[0].service_tiers.as_ref().unwrap();
                assert_eq!((&tiers[0].id[..], &tiers[0].name[..]), ("priority", "Fast"));
            }
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
            cli: Some(CliContext { cwd: "/tmp".into(), resume: resume.map(String::from), service_tier: None }),
        }
    }

    /// 사용자 CLI 설정과 무관하게 읽기 전용 권한을 강제한다.
    #[test]
    fn read_only_flags_are_always_forced() {
        let (a, p) = args(&prof("claude_code"), &req(None), "sid-1");
        assert_eq!(p, "claude");
        let j = a.join(" ");
        assert!(j.contains("--permission-mode default") && j.contains("--tools Read,Glob,Grep") && j.contains("--strict-mcp-config"), "{j}");
        assert!(a.windows(2).any(|w| w[0] == "--setting-sources" && w[1].is_empty()));
        assert!(j.contains("--session-id sid-1"));
        assert!(!j.contains("bypass") && !j.contains("dangerously"));
        let (a, _) = args(&prof("claude_code"), &req(Some("abc")), "x");
        assert!(a.windows(2).any(|w| w[0] == "--resume" && w[1] == "abc"));
        assert!(a.join(" ").contains("--permission-mode default"), "resume에도 같은 강제");
        for r in [None, Some("t1")] {
            let (a, p) = args(&prof("codex_cli"), &req(r), "x");
            assert_eq!(p, "codex");
            let j = a.join(" ");
            assert!(j.contains("sandbox_mode=\"read-only\"") && j.contains("approval_policy=\"never\""), "{j}");
            assert!(!j.contains("dangerously") && !j.contains("workspace-write"));
        }
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
                    assert!(args.contains(&"sandbox_mode=\"read-only\"".into()));
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
