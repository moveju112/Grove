//! Claude Code 인증은 설치된 CLI의 구독 로그인에만 맡긴다.
use super::{GroupGuard, ProviderError};
use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

// CLI의 비대화형 모드는 로그인보다 외부 키·토큰을 우선할 수 있다.
const PROVIDER_OVERRIDES: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_PROFILE",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FD",
    "CLAUDE_CODE_API_KEY_FD",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
];

pub(crate) fn command(executable: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = super::command(executable);
    for key in PROVIDER_OVERRIDES {
        cmd.env_remove(key);
    }
    cmd.env_remove("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST")
        .env_remove("CLAUDECODE").env_remove("CLAUDE_CODE_ENTRYPOINT");
    cmd
}

pub(crate) fn settings(mut settings: Value) -> String {
    // --settings가 사용자·프로젝트 settings.json의 env와 key helper도 덮어쓴다.
    // 관리 정책은 CLI의 자체 우선순위에 맡기고, 실행 전에 인증 방식이 일치하는지 확인한다.
    settings["forceLoginMethod"] = json!("claudeai");
    settings["apiKeyHelper"] = json!("");
    settings["env"] = Value::Object(PROVIDER_OVERRIDES.iter()
        .map(|&key| (key.into(), json!(""))).collect());
    settings.to_string()
}

fn subscription(status: &Value) -> Option<bool> {
    Some(status["loggedIn"].as_bool()?
        && status["authMethod"] == "claude.ai"
        && status["apiProvider"] == "firstParty"
        && status["subscriptionType"].as_str().is_some_and(|plan| !plan.is_empty() && plan != "free"))
}

/// 프롬프트를 보내기 전에 동일한 cwd·설정에서 공식 CLI가 선택한 인증 방식을 확인한다.
/// 계정 정보가 포함된 원문은 반환하거나 기록하지 않는다.
pub(crate) async fn authenticated(
    executable: &Path, cwd: Option<&Path>, settings: &str, setting_sources: Option<&str>,
) -> Result<Option<bool>, ProviderError> {
    let mut cmd = command(executable);
    cmd.args(["--settings", settings]);
    if let Some(sources) = setting_sources { cmd.args(["--setting-sources", sources]); }
    if let Some(cwd) = cwd { cmd.current_dir(cwd); }
    cmd.args(["auth", "status", "--json"])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let tag = crate::util::new_id();
    crate::procs::prepare(&mut cmd, &tag);
    let mut child = cmd.spawn().map_err(|error| {
        let executable = executable.to_string_lossy();
        if crate::deps::is_missing(&executable, Some(&error)) {
            ProviderError::new("cli_not_found", crate::deps::message(&executable))
        } else {
            ProviderError::new("cli_failed", "Claude Code 인증 상태를 확인하지 못했습니다")
        }
    })?;
    let _guard = GroupGuard(crate::procs::adopt(&mut child, &tag).map_err(|e| ProviderError::new("cli_failed", e))?);
    let stdout = child.stdout.take().expect("stdout");
    let report = tokio::time::timeout(Duration::from_secs(8), async {
        let mut bytes = Vec::new();
        stdout.take(32 * 1024 + 1).read_to_end(&mut bytes).await.ok()?;
        if bytes.len() > 32 * 1024 { return None; }
        let exit = child.wait().await.ok()?;
        if !exit.success() && exit.code() != Some(1) { return None; }
        let report: Value = serde_json::from_slice(&bytes).ok()?;
        let logged_in = subscription(&report)?;
        if logged_in && !exit.success() { return None; }
        Some(logged_in)
    }).await.ok().flatten();
    Ok(report)
}

pub(super) fn require_subscription(authenticated: Option<bool>) -> Result<(), ProviderError> {
    match authenticated {
        Some(true) => Ok(()),
        Some(false) => Err(ProviderError::new("auth_failed", "서버의 Claude Code에 구독 계정으로 로그인하세요 (`claude auth login`). API 키·Console·게이트웨이 연결은 사용하지 않습니다")),
        None => Err(ProviderError::new("auth_failed", "Claude Code 구독 로그인을 확인할 수 없습니다. CLI를 업데이트하고 `claude auth status`를 확인하세요")),
    }
}
