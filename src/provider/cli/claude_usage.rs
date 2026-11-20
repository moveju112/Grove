use super::{GroupGuard, claude, read_line};
use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncWriteExt, BufReader};

const MAX_OUTPUT: usize = 1024 * 1024;
const INIT_ID: &str = "grove-usage";

/// 공식 Claude Code `/usage`의 구조화된 출력만 사용한다. 세션이나 모델 턴을 만들지 않는다.
/// https://code.claude.com/docs/en/agent-sdk/typescript#sdkusagereport
pub(crate) async fn read(executable: &Path) -> Result<Value, &'static str> {
    tokio::time::timeout(Duration::from_secs(12), async {
        let scratch = tempfile::Builder::new().prefix("grove-usage-").tempdir().map_err(|_| "unavailable")?;
        let settings = claude::settings(json!({"disableAllHooks":true}));
        match claude::authenticated(executable, Some(scratch.path()), &settings, Some("")).await {
            Ok(Some(true)) => (),
            Ok(Some(false)) => return Err("authentication_required"),
            _ => return Err("unavailable"),
        }
        {
            let (mut child, _guard) = command(executable, scratch.path(), &["--version"])?;
            let mut output = BufReader::new(child.stdout.take().expect("stdout"));
            let line = read_line(&mut output).await.map_err(|_| "unavailable")?.ok_or("unsupported")?;
            if !supported_version(&line) { return Err("unsupported"); }
            drop(output);
            if !child.wait().await.is_ok_and(|status| status.success()) { return Err("unavailable"); }
        }

        let (mut child, _guard) = command(executable, scratch.path(), &[
            "-p", "--safe-mode", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config",
            "--settings", &settings, "--tools", "", "--permission-prompts", "none",
            "--max-turns", "0", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        ])?;
        let mut input = Some(child.stdin.take().expect("stdin"));
        send(input.as_mut().expect("stdin"), json!({"type":"control_request", "request_id":INIT_ID,
            "request":{"subtype":"initialize"}})).await?;
        let mut output = BufReader::new(child.stdout.take().expect("stdout"));
        let mut bytes = 0;
        let mut report = None;
        let mut completed = false;
        while let Some(line) = read_line(&mut output).await.map_err(|_| "unavailable")? {
            bytes += line.len();
            if bytes > MAX_OUTPUT { return Err("unavailable"); }
            let mut event: Value = serde_json::from_slice(&line).map_err(|_| "unavailable")?;
            if let Some(mut stdin) = input.take() {
                if event["type"] == "control_response" && event["response"]["request_id"] == INIT_ID {
                    let response = &event["response"];
                    if response["subtype"] != "success" { return Err("unavailable"); }
                    // 지원하지 않는 `/usage`가 일반 프롬프트로 전송되면 안 된다.
                    if !response["response"]["commands"].as_array().is_some_and(|commands| commands.iter().any(|cmd|
                        cmd["name"] == "usage" && cmd["builtin"] == true)) { return Err("unsupported"); }
                    send(&mut stdin, json!({"type":"user", "parent_tool_use_id":null,
                        "message":{"role":"user", "content":[{"type":"text", "text":"/usage"}]}})).await?;
                    stdin.shutdown().await.map_err(|_| "unavailable")?;
                } else {
                    input = Some(stdin);
                }
                continue;
            }
            if event["type"] == "assistant" && let Some(value) = event.get_mut("usage_report") {
                report = Some(value.take());
            }
            if event["type"] == "result" {
                // 구독 한도 조회가 일반 모델 응답으로 바뀌어도 그 출력을 사용하지 않는다.
                if event["subtype"] != "success" || event["is_error"] == true
                    || event["num_turns"] != 0 || event["duration_api_ms"] != 0
                { return Err("unavailable"); }
                completed = true;
            }
        }
        if !child.wait().await.is_ok_and(|status| status.success()) || !completed { return Err("unavailable"); }
        report.ok_or("unsupported")
    }).await.map_err(|_| "timeout")?
}

async fn send(input: &mut tokio::process::ChildStdin, message: Value) -> Result<(), &'static str> {
    input.write_all(format!("{message}\n").as_bytes()).await.map_err(|_| "unavailable")
}

fn supported_version(line: &[u8]) -> bool {
    // SDK v0.3.273(Claude Code v2.1.273)부터 구조화된 `/usage`가 문서화되어 있다.
    let Ok(line) = std::str::from_utf8(line) else { return false; };
    let Some(version) = line.split_ascii_whitespace().next() else { return false; };
    let mut parts = version.split('.');
    let mut number = || parts.next()?.parse::<u32>().ok();
    matches!((number(), number(), number()), (Some(major), Some(minor), Some(patch))
        if (major, minor, patch) >= (2, 1, 273)) && parts.next().is_none()
}

fn command(executable: &Path, cwd: &Path, args: &[&str]) -> Result<(tokio::process::Child, GroupGuard), &'static str> {
    let mut cmd = claude::command(executable);
    cmd.args(args).current_dir(cwd).stdin(if args == ["--version"] { Stdio::null() } else { Stdio::piped() })
        .stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let tag = crate::util::new_id();
    crate::procs::prepare(&mut cmd, &tag);
    let mut child = cmd.spawn().map_err(|_| "unavailable")?;
    let guard = GroupGuard(crate::procs::adopt(&mut child, &tag).map_err(|_| "unavailable")?);
    Ok((child, guard))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_usage_requires_cli_with_structured_usage() {
        for line in ["2.1.273 (Claude Code)", "2.1.328 (Claude Code)", "3.0.0"] {
            assert!(supported_version(line.as_bytes()));
        }
        for line in ["2.1.99 (Claude Code)", "2.1.272", "2.1.273-pre", "other CLI", ""] {
            assert!(!supported_version(line.as_bytes()));
        }
    }
}
