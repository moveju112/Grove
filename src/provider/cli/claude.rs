//! 설치된 Claude Code가 사용자의 CLI 인증과 모델 공급자 설정을 관리한다.
use super::{GroupGuard, ProviderError};
use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

pub(crate) fn command(executable: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = super::command(executable);
    cmd.env_remove("CLAUDECODE").env_remove("CLAUDE_CODE_ENTRYPOINT");
    // CLI 내장 백그라운드 작업은 Grove 턴이 끝나면 추적·보고되지 않는다. 턴을 넘기는 작업은 Grove 셸로만 연다.
    cmd.env("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1");
    cmd
}

pub(crate) fn settings(mut settings: Value) -> String {
    settings["env"] = json!({"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS":"1"});
    settings.to_string()
}

/// 공식 CLI가 선택한 인증 방식을 확인한다. 구독 한도 조회는 구독 인증에만 해당한다.
/// 계정 정보가 포함된 원문은 반환하거나 기록하지 않는다.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Account {
    SignedOut,
    Subscription,
    OtherProvider,
}

pub(crate) async fn account(
    executable: &Path, cwd: Option<&Path>, settings: &str, setting_sources: Option<&str>,
) -> Result<Option<Account>, ProviderError> {
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
        if !report["loggedIn"].as_bool()? { return Some(Account::SignedOut); }
        if !exit.success() { return None; }
        if report["authMethod"] == "claude.ai" && report["apiProvider"] == "firstParty"
            && report["subscriptionType"].as_str().is_some_and(|plan| !plan.is_empty() && plan != "free")
        {
            Some(Account::Subscription)
        } else {
            Some(Account::OtherProvider)
        }
    }).await.ok().flatten();
    Ok(report)
}
