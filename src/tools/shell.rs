//! 승인형 foreground 셸 실행(EXEC-001~006, PROCESS-001/003/005).
//! - Linux: `bash -c`, 새 process group으로 실행하고 취소·timeout 시 그룹 전체를 종료한다.
//! - Windows: PowerShell. 프로세스 트리 정리는 `taskkill /T`로 수행한다. TODO(port): Job Object 기반 격리.
//! - 출력은 stream별 상한까지만 메모리에 두고 잘림을 표시한다.

use super::fs::{rel_display, resolve};
use super::{Planned, ToolError, ToolResult};
use serde_json::{Value, json};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::watch;

pub const MAX_CAPTURE: usize = 128 * 1024;
pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
/// 백그라운드 작업 hard timeout 상한(24시간).
pub const MAX_BACKGROUND_TIMEOUT_MS: u64 = 24 * 3600 * 1000;
/// foreground hold 상한(10분).
pub const MAX_HOLD_MS: u64 = 600_000;

pub fn plan(args: &Value, root: &Path) -> ToolResult<Planned> {
    let command = args["command"].as_str().unwrap_or("").to_string();
    if command.trim().is_empty() {
        return Err(ToolError::new("invalid_arguments", "command가 비어 있습니다"));
    }
    if command.len() > 64 * 1024 {
        return Err(ToolError::new("invalid_arguments", "command가 너무 깁니다"));
    }
    let cwd = resolve(root, args["cwd"].as_str().unwrap_or("."))?;
    if !cwd.is_dir() {
        return Err(ToolError::new("not_found", "cwd 디렉터리가 없습니다"));
    }
    // hard timeout(프로세스 종료)과 hold(결과를 기다리는 시간)는 별개다(EXEC-007).
    // background=true: 즉시 백그라운드. hold_ms: 그 시간 안에 안 끝나면 백그라운드로 전환(EXEC-004).
    let background = args["background"].as_bool().unwrap_or(false);
    let hold = args["hold_ms"].as_u64();
    let default_timeout = if background || hold.is_some() { MAX_BACKGROUND_TIMEOUT_MS } else { DEFAULT_TIMEOUT_MS };
    let timeout = args["timeout_ms"].as_u64().unwrap_or(default_timeout).clamp(100, MAX_BACKGROUND_TIMEOUT_MS);
    let mut target = json!({ "command": command, "cwd": rel_display(root, &cwd), "shell": shell_name(), "timeout_ms": timeout });
    if background || hold.is_some() {
        target["hold_ms"] = json!(if background { 0 } else { hold.unwrap_or(0).min(MAX_HOLD_MS) });
    }
    Ok(Planned { target, precondition: None })
}

fn shell_name() -> &'static str {
    if cfg!(windows) { "powershell" } else { "bash" }
}

async fn capture<R: AsyncRead + Unpin>(mut r: R) -> (Vec<u8>, usize) {
    let mut kept = Vec::new();
    let mut total = 0usize;
    let mut buf = [0u8; 8192];
    loop {
        match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                total += n;
                // 상한을 넘어도 계속 읽어 pipe가 막혀 자식이 멈추지 않게 한다.
                if kept.len() < MAX_CAPTURE {
                    let take = n.min(MAX_CAPTURE - kept.len());
                    kept.extend_from_slice(&buf[..take]);
                }
            }
        }
    }
    (kept, total)
}

#[cfg(unix)]
pub fn kill_group(pid: u32) {
    // SAFETY: 이 프로세스가 생성한 process group에만 신호를 보낸다(pid == pgid).
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(windows)]
pub fn kill_group(pid: u32) {
    let _ = std::process::Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).output();
}

/// OS 기본 셸 명령. 새 process group, stdin 없음, stdout/stderr pipe.
/// 모델이 실행하는 명령에 넘기지 않을 환경변수인가(SEC-013).
/// 자격증명처럼 보이는 이름과 서버 내부 설정(GROVE_*)을 뺀다. 사용자가 직접 여는 터미널에는 적용하지 않는다.
pub fn is_sensitive_env(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    if n.starts_with("GROVE_") {
        return true;
    }
    const EXACT: &[&str] = &["SSH_AUTH_SOCK", "GPG_AGENT_INFO", "AWS_ACCESS_KEY_ID", "GIT_ASKPASS", "SSH_ASKPASS"];
    const PARTS: &[&str] = &["TOKEN", "SECRET", "PASSWORD", "PASSWD", "API_KEY", "APIKEY", "PRIVATE_KEY", "CREDENTIAL", "SESSION_KEY", "AUTH"];
    EXACT.contains(&n.as_str()) || PARTS.iter().any(|p| n.contains(p))
}

pub fn command(command: &str, cwd: &Path) -> tokio::process::Command {
    let mut cmd = if cfg!(windows) {
        let mut c = tokio::process::Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-Command", command]);
        c
    } else {
        let mut c = tokio::process::Command::new("bash");
        c.args(["-c", command]);
        c
    };
    cmd.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for (k, _) in std::env::vars_os() {
        if k.to_str().is_none_or(is_sensitive_env) {
            cmd.env_remove(&k);
        }
    }
    cmd.env("GROVE_SHELL", "1");
    #[cfg(unix)]
    cmd.process_group(0);
    cmd
}

pub async fn execute(planned: &Planned, root: &Path, mut cancel: watch::Receiver<bool>) -> ToolResult<Value> {
    let cwd = resolve(root, planned.target["cwd"].as_str().unwrap_or("."))?;
    let command = planned.target["command"].as_str().unwrap_or("");
    let timeout = Duration::from_millis(planned.target["timeout_ms"].as_u64().unwrap_or(DEFAULT_TIMEOUT_MS));
    let mut cmd = self::command(command, &cwd);
    let started = std::time::Instant::now();
    let mut child = cmd.spawn().map_err(|e| ToolError::new("spawn_failed", format!("셸 실행 실패: {e}")))?;
    let pid = child.id().unwrap_or(0);
    let out_h = tokio::spawn(capture(child.stdout.take().expect("stdout")));
    let err_h = tokio::spawn(capture(child.stderr.take().expect("stderr")));
    enum End {
        Exit(std::process::ExitStatus),
        Timeout,
        Cancelled,
        WaitErr(String),
    }
    let end = tokio::select! {
        r = child.wait() => match r { Ok(s) => End::Exit(s), Err(e) => End::WaitErr(e.to_string()) },
        _ = tokio::time::sleep(timeout) => End::Timeout,
        _ = cancel.wait_for(|c| *c) => End::Cancelled,
    };
    if !matches!(end, End::Exit(_)) && pid != 0 {
        kill_group(pid);
        let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    } else if pid != 0 {
        // 셸은 끝났지만 같은 그룹에 남은 background 자식도 정리한다(detach한 setsid 자식은 범위 밖).
        kill_group(pid);
    }
    let (stdout, out_total) = tokio::time::timeout(Duration::from_secs(5), out_h).await.ok().and_then(Result::ok).unwrap_or_default();
    let (stderr, err_total) = tokio::time::timeout(Duration::from_secs(5), err_h).await.ok().and_then(Result::ok).unwrap_or_default();
    let mut v = json!({
        "command": command,
        "cwd": planned.target["cwd"],
        "stdout": String::from_utf8_lossy(&stdout),
        "stderr": String::from_utf8_lossy(&stderr),
        "stdout_bytes": out_total, "stderr_bytes": err_total,
        "truncated": out_total > MAX_CAPTURE || err_total > MAX_CAPTURE,
        "duration_ms": started.elapsed().as_millis() as u64,
    });
    match end {
        End::Exit(s) => {
            v["exit_code"] = json!(s.code());
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                v["signal"] = json!(s.signal());
            }
            Ok(v)
        }
        End::Timeout => Err(ToolError::new("timeout", format!("{}ms 안에 끝나지 않아 종료했습니다. 부분 실행됐을 수 있습니다", timeout.as_millis()))
            .with_output(v)),
        End::Cancelled => Err(ToolError::new("cancelled", "사용자 취소로 종료했습니다. 부분 실행됐을 수 있습니다").with_output(v)),
        End::WaitErr(e) => Err(ToolError::new("wait_failed", e).with_output(v)),
    }
}

impl ToolError {
    /// 오류에도 지금까지의 출력을 붙인다(오류가 후속 성공에 가려지지 않게, TOOL-024).
    pub fn with_output(mut self, v: Value) -> Self {
        let tail = |s: &str| -> String {
            let c: Vec<char> = s.chars().collect();
            if c.len() > 4000 { c[c.len() - 4000..].iter().collect() } else { s.to_string() }
        };
        self.message = format!(
            "{}\n[stdout]\n{}\n[stderr]\n{}",
            self.message,
            tail(v["stdout"].as_str().unwrap_or("")),
            tail(v["stderr"].as_str().unwrap_or(""))
        );
        self
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn planned(cmd: &str, root: &Path, timeout: u64) -> Planned {
        plan(&json!({ "command": cmd, "timeout_ms": timeout }), root).unwrap()
    }

    #[test]
    fn sensitive_env_names() {
        for n in ["OPENAI_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "GROVE_DATA_DIR", "SSH_AUTH_SOCK", "npm_config__authToken"] {
            assert!(is_sensitive_env(n), "{n}");
        }
        for n in ["PATH", "HOME", "LANG", "TERM", "CARGO_HOME", "USER"] {
            assert!(!is_sensitive_env(n), "{n}");
        }
    }

    #[tokio::test]
    async fn child_env_has_no_sensitive_vars() {
        let d = tempfile::tempdir().unwrap();
        let (_t, rx) = watch::channel(false);
        // 값에 줄바꿈이 있을 수 있어 NUL로 나눈다(tr로 바꿔 JSON 출력에 안전하게).
        let v = execute(&planned("env -0 | tr '\\0' '\\036'", d.path(), 5000), d.path(), rx).await.unwrap();
        let out = v["stdout"].as_str().unwrap();
        let names: Vec<&str> = out.split('\u{1e}').filter_map(|l| l.split_once('=').map(|x| x.0)).collect();
        assert!(names.contains(&"PATH"), "일반 변수는 유지");
        let leaked: Vec<_> = names.iter().filter(|n| **n != "GROVE_SHELL" && is_sensitive_env(n)).collect();
        assert!(leaked.is_empty(), "자식에 남은 민감 변수: {leaked:?}");
    }

    #[tokio::test]
    async fn runs_and_captures() {
        let d = tempfile::tempdir().unwrap();
        let (_t, rx) = watch::channel(false);
        let v = execute(&planned("echo out; echo err >&2; exit 3", d.path(), 5000), d.path(), rx).await.unwrap();
        assert_eq!(v["stdout"], "out\n");
        assert_eq!(v["stderr"], "err\n");
        assert_eq!(v["exit_code"], 3);
    }

    #[tokio::test]
    async fn timeout_kills_process_group() {
        let d = tempfile::tempdir().unwrap();
        let marker = d.path().join("child-alive");
        let (_t, rx) = watch::channel(false);
        let cmd = format!("(sleep 1.5; touch {}) & sleep 30", marker.display());
        let e = execute(&planned(&cmd, d.path(), 300), d.path(), rx).await.unwrap_err();
        assert_eq!(e.code, "timeout");
        tokio::time::sleep(Duration::from_millis(2000)).await;
        assert!(!marker.exists(), "자식 프로세스도 종료되어야 한다");
    }

    #[tokio::test]
    async fn cancel_stops_command() {
        let d = tempfile::tempdir().unwrap();
        let (tx, rx) = watch::channel(false);
        let p = planned("sleep 30", d.path(), 60_000);
        let root = d.path().to_path_buf();
        let h = tokio::spawn(async move { execute(&p, &root, rx).await });
        tokio::time::sleep(Duration::from_millis(200)).await;
        tx.send_replace(true);
        let e = tokio::time::timeout(Duration::from_secs(5), h).await.unwrap().unwrap().unwrap_err();
        assert_eq!(e.code, "cancelled");
    }

    #[tokio::test]
    async fn large_output_is_bounded() {
        let d = tempfile::tempdir().unwrap();
        let (_t, rx) = watch::channel(false);
        let v = execute(&planned("head -c 1000000 /dev/zero | tr '\\0' a", d.path(), 10_000), d.path(), rx).await.unwrap();
        assert_eq!(v["truncated"], true);
        assert_eq!(v["stdout_bytes"], 1_000_000);
        assert_eq!(v["stdout"].as_str().unwrap().len(), MAX_CAPTURE);
    }
}
