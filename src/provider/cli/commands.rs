//! CLI가 보고한 명령·스킬 metadata만 조회한다. 모델 턴·hook·MCP 실행은 하지 않는다.
use super::{GroupGuard, ProviderError, program, read_line};
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::{Path, PathBuf}, process::Stdio, time::Duration};
use tokio::io::{AsyncWriteExt, BufReader};

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct NativeCommand {
    pub id: String,
    pub name: String,
    pub description: String,
    pub argument_hint: String,
}

#[derive(Debug, Clone)]
pub struct Command {
    pub info: NativeCommand,
    pub native_name: String,
    pub path: Option<PathBuf>,
    scope: String,
}

pub struct Catalog {
    pub commands: Vec<Command>,
    pub has_errors: bool,
}

fn invalid() -> ProviderError {
    ProviderError::new("native_commands_invalid", "CLI 명령 목록 형식이 올바르지 않습니다")
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 200
        && name.chars().all(|c| c.is_alphanumeric() || "-_.:".contains(c))
}

pub fn parse_id(value: Option<&str>) -> Result<Option<String>, &'static str> {
    value.map(|id| {
        if id.len() == 68 && id.starts_with("cmd_") && id[4..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
            Ok(id.to_string())
        } else { Err("CLI 명령 식별자가 올바르지 않습니다") }
    }).transpose()
}

/// 클라이언트에는 경로 대신 실행 위치·CLI·원본 명령에 결합된 식별자만 보낸다.
pub fn decode(protocol: &str, cwd: &Path, value: &Value) -> Result<Catalog, ProviderError> {
    let (rows, has_errors) = if protocol == "codex_cli" {
        let entries = value["data"].as_array().ok_or_else(invalid)?;
        let entry = entries.iter().find(|entry| entry["cwd"].as_str().is_some_and(|path| Path::new(path) == cwd)).ok_or_else(invalid)?;
        (entry["skills"].as_array().ok_or_else(invalid)?, !entry["errors"].as_array().ok_or_else(invalid)?.is_empty())
    } else {
        (value["commands"].as_array().ok_or_else(invalid)?, false)
    };
    if rows.len() > 2048 { return Err(ProviderError::new("native_commands_limit", "CLI 명령 목록이 크기 한도를 넘었습니다")); }
    let mut commands = BTreeMap::new();
    for row in rows {
        if protocol == "codex_cli" && !row["enabled"].as_bool().ok_or_else(invalid)? { continue; }
        let name = row["name"].as_str().ok_or_else(invalid)?;
        if !valid_name(name) { return Err(invalid()); }
        let description = row["description"].as_str().ok_or_else(invalid)?;
        let argument_hint = row["argumentHint"].as_str().unwrap_or_default();
        if description.len() > 16 * 1024 || argument_hint.len() > 4096 { return Err(invalid()); }
        let path = if protocol == "codex_cli" {
            let path = PathBuf::from(row["path"].as_str().ok_or_else(invalid)?);
            if !path.is_absolute() { return Err(invalid()); }
            Some(path)
        } else { None };
        let id = format!("cmd_{}", crate::util::sha256_hex(
            &serde_json::to_vec(&(protocol, cwd, name, &path)).map_err(|_| invalid())?));
        commands.insert(id.clone(), Command {
            info: NativeCommand { id, name: name.into(), description: description.into(), argument_hint: argument_hint.into() },
            native_name: name.into(), path,
            scope: row["scope"].as_str().filter(|scope| valid_name(scope)).unwrap_or("skill").into(),
        });
    }
    let mut commands: Vec<_> = commands.into_values().collect();
    let mut names = BTreeMap::<String, usize>::new();
    for command in &commands { *names.entry(command.info.name.to_lowercase()).or_default() += 1; }
    for command in &mut commands {
        if names[&command.info.name.to_lowercase()] > 1 {
            command.info.name = format!("{}:{}", command.scope, command.native_name);
        }
    }
    names.clear();
    for command in &commands { *names.entry(command.info.name.to_lowercase()).or_default() += 1; }
    for command in &mut commands {
        if names[&command.info.name.to_lowercase()] > 1 {
            command.info.name = format!("{}:{}", command.info.name, &command.info.id[4..]);
        }
    }
    commands.sort_by(|a, b| a.info.name.cmp(&b.info.name).then(a.info.id.cmp(&b.info.id)));
    Ok(Catalog { commands, has_errors })
}

pub fn invocation<'a>(text: &'a str, command: &Command) -> Result<&'a str, ProviderError> {
    let input = text.trim_start().strip_prefix('/').ok_or_else(invalid)?;
    let end = input.find(char::is_whitespace).unwrap_or(input.len());
    let mut name = &input[..end];
    loop {
        if name.to_lowercase() == command.info.name.to_lowercase() { return Ok(input[end..].trim_start()); }
        let Some(rest) = name.strip_prefix("cli:") else { break };
        name = rest;
    }
    Err(ProviderError::new("native_command_changed", "선택한 CLI 명령과 입력이 다릅니다. 목록에서 다시 선택하세요"))
}

pub async fn list(protocol: &str, cwd: &Path) -> Result<Catalog, ProviderError> {
    list_with(protocol, cwd, None).await
}

pub(super) async fn list_with(protocol: &str, cwd: &Path, executable: Option<&Path>) -> Result<Catalog, ProviderError> {
    if !super::is_cli(protocol) { return Err(ProviderError::new("native_commands_unsupported", "CLI 모델에서만 스킬·명령을 사용할 수 있습니다")); }
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        let prog = executable.map(|path| path.to_string_lossy().into_owned()).unwrap_or_else(|| program(protocol).into());
        let mut cmd = tokio::process::Command::new(&prog);
        if protocol == "claude_code" {
            cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                "--tools", "", "--settings", r#"{"disableAllHooks":true}"#, "--strict-mcp-config", "--no-session-persistence"]);
        } else { cmd.arg("app-server"); }
        cmd.current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        for (key, _) in std::env::vars_os() {
            if key.to_str().is_some_and(|key| key.starts_with("GROVE_")) { cmd.env_remove(key); }
        }
        let tag = crate::util::new_id();
        let limits = crate::procs::Limits::default();
        crate::procs::prepare(&mut cmd, &tag, limits);
        let mut child = cmd.spawn().map_err(|error| {
            if crate::deps::is_missing(&prog, Some(&error)) { ProviderError::new("cli_not_found", crate::deps::message(&prog)) }
            else { ProviderError::new("native_commands_failed", "CLI 명령 목록 프로세스를 시작하지 못했습니다") }
        })?;
        let _guard = GroupGuard(crate::procs::adopt(&mut child, &tag, limits).map_err(|e| ProviderError::new("native_commands_failed", e))?);
        let mut input = child.stdin.take().expect("stdin");
        let mut output = BufReader::new(child.stdout.take().expect("stdout"));
        let claude = protocol == "claude_code";
        let init = if claude {
            json!({"type":"control_request","request_id":"grove-commands","request":{"subtype":"initialize"}})
        } else {
            json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"grove","version":crate::VERSION}}})
        };
        input.write_all(format!("{init}\n").as_bytes()).await.map_err(|_| invalid())?;
        let mut bytes = 0;
        while let Some(line) = read_line(&mut output).await? {
            bytes += line.len();
            if bytes > 8 * 1024 * 1024 { return Err(ProviderError::new("native_commands_limit", "CLI 명령 목록이 크기 한도를 넘었습니다")); }
            let value: Value = serde_json::from_slice(&line).map_err(|_| invalid())?;
            if !claude && value["id"] == 1 {
                if value.get("error").is_some() { return Err(invalid()); }
                let request = json!({"id":2,"method":"skills/list","params":{"cwds":[cwd],"forceReload":true}});
                input.write_all(format!("{{\"method\":\"initialized\"}}\n{request}\n").as_bytes()).await.map_err(|_| invalid())?;
            } else if (!claude && value["id"] == 2)
                || (claude && value["type"] == "control_response" && value["response"]["request_id"] == "grove-commands") {
                let response = if claude {
                    if value["response"]["subtype"] != "success" { return Err(invalid()); }
                    &value["response"]["response"]
                } else {
                    if value.get("error").is_some() { return Err(invalid()); }
                    &value["result"]
                };
                return decode(protocol, cwd, response);
            }
        }
        Err(ProviderError::new("native_commands_failed", "CLI가 명령 목록을 반환하지 않았습니다"))
    }).await;
    result.map_err(|_| ProviderError::new("native_commands_timeout", "CLI 명령 목록 조회 시간이 초과됐습니다"))?
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod tests;
