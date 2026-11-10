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
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

/// 실행 문맥: 작업 디렉터리(프로젝트 root)와 이어 쓸 CLI 세션 ID.
#[derive(Debug, Clone, Default)]
pub struct CliContext {
    pub cwd: std::path::PathBuf,
    pub resume: Option<String>,
}

/// CLI 연결 확인: 실행 파일이 있고 버전을 출력하는지(로그인 상태는 실제 호출에서 드러난다).
pub async fn check(profile: &Profile) -> Result<serde_json::Value, ProviderError> {
    let prog = program(&profile.protocol);
    let out = tokio::time::timeout(std::time::Duration::from_secs(15), tokio::process::Command::new(prog).arg("--version").stdin(Stdio::null()).kill_on_drop(true).output())
        .await
        .map_err(|_| ProviderError::new("cli_timeout", format!("{prog} --version이 15초 안에 끝나지 않았습니다")))?
        .map_err(|e| ProviderError::new("cli_not_found", format!("{prog} 실행 파일을 찾을 수 없습니다: {e}")))?;
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
        Some(ChatMsg::User { text }) => text.clone(),
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
                ChatMsg::User { text } if !text.trim().is_empty() => Some(format!("[user]\n{text}")),
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
        let mut a = vec![s("-p"), prompt(req, resume.is_some(), false), s("--output-format"), s("stream-json"), s("--verbose")];
        a.extend([s("--model"), profile.model.clone()]);
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
        a.extend([s("--json"), s("-m"), profile.model.clone(), s("--skip-git-repo-check")]);
        // 읽기 전용 강제(resume에도 같은 정책). resume 하위 명령은 -C·--sandbox를 받지 않으므로 -c로 지정한다.
        a.extend([s("-c"), s("sandbox_mode=\"read-only\""), s("-c"), s("approval_policy=\"never\"")]);
        if let Some(e) = &req.effort {
            a.extend([s("-c"), format!("model_reasoning_effort=\"{e}\"")]);
        }
        if !persist {
            a.push(s("--ephemeral"));
        }
        if let Some(id) = &resume {
            a.push(id.clone());
        }
        a.push(prompt(req, resume.is_some(), resume.is_none()));
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

pub async fn stream(profile: &Profile, req: &ModelRequest, on_delta: OnDelta<'_>) -> Result<ModelOutput, ProviderError> {
    let new_session = uuid::Uuid::new_v4().to_string();
    let (argv, prog) = args(profile, req, &new_session);
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
    cmd.args(&argv).current_dir(&cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
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
        let code = if e.kind() == std::io::ErrorKind::NotFound { "cli_not_found" } else { "cli_failed" };
        ProviderError::new(code, format!("{prog} 실행 실패: {e}"))
    })?;
    let _guard = GroupGuard(crate::procs::adopt(&mut child, &tag, limits).map_err(|e| ProviderError::new("cli_failed", e))?);
    let stdout = child.stdout.take().expect("stdout");
    let mut stderr = child.stderr.take().expect("stderr");
    let err_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = (&mut stderr).take(16 * 1024).read_to_end(&mut buf).await;
        String::from_utf8_lossy(&buf).to_string()
    });
    let mut out = ModelOutput::default();
    let mut final_text = None;
    let mut lines = BufReader::new(stdout).lines();
    let body = async {
        while let Some(line) = lines.next_line().await.map_err(|e| ProviderError::new("cli_failed", e.to_string()))? {
            let Ok(e) = serde_json::from_str::<Value>(&line) else { continue };
            apply_event(&profile.protocol, &e, &mut out, &mut final_text)?;
            on_delta(&out);
            if out.text.len() > super::MAX_OUTPUT_BYTES {
                return Err(ProviderError::new("output_too_large", "응답이 너무 큽니다"));
            }
        }
        Ok::<(), ProviderError>(())
    };
    match tokio::time::timeout(profile.timeout, body).await {
        Err(_) => return Err(ProviderError { code: "timeout", message: format!("{prog}가 {}초 안에 끝나지 않았습니다", profile.timeout.as_secs()), status: None, retryable: true, retry_after_secs: None }),
        Ok(r) => r?,
    }
    let status = child.wait().await.map_err(|e| ProviderError::new("cli_failed", e.to_string()))?;
    let stderr_text = err_task.await.unwrap_or_default();
    if out.finish_reason.is_empty() {
        let tail: String = stderr_text.lines().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" / ");
        return Err(ProviderError::new("cli_failed", format!("{prog}가 결과 없이 끝났습니다(종료 {status}): {tail}")));
    }
    if let Some(t) = final_text {
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
        Profile { protocol: p.into(), base_url: String::new(), model: "m".into(), api_key: None, timeout: Duration::from_secs(5), extra_headers: vec![] }
    }
    fn req(resume: Option<&str>) -> ModelRequest {
        ModelRequest {
            system: "sys".into(),
            messages: vec![
                ChatMsg::User { text: "첫 질문".into() },
                ChatMsg::Assistant { text: "첫 답".into(), tool_calls: vec![] },
                ChatMsg::User { text: "다음 질문".into() },
            ],
            tools: vec![],
            max_tokens: None,
            temperature: None,
            effort: None,
            cli: Some(CliContext { cwd: "/tmp".into(), resume: resume.map(String::from) }),
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
    fn prompt_includes_history_only_without_resume() {
        let (a, _) = args(&prof("claude_code"), &req(None), "s");
        let p = &a[1];
        assert!(p.contains("[user]\n첫 질문") && p.contains("[assistant]\n첫 답") && p.ends_with("다음 질문"));
        let (a, _) = args(&prof("claude_code"), &req(Some("r")), "s");
        assert_eq!(a[1], "다음 질문", "resume이면 마지막 요청만");
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
}
