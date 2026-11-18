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
/// 오래 걸리는 명령은 강제 종료하지 않고 이 시간이 지나면 백그라운드로 넘긴다.
pub const DEFAULT_HOLD_MS: u64 = 60_000;
/// foreground hold 상한(10분).
pub const MAX_HOLD_MS: u64 = 600_000;
/// 영속 작업·웹 API에서 손실 없이 표현하는 정수 범위. 0은 종료 시한 없음이다.
pub const MAX_EXPLICIT_TIMEOUT_MS: u64 = (1 << 53) - 1;

pub(crate) async fn wait_deadline(timeout_ms: u64) {
    if timeout_ms == 0 {
        std::future::pending().await
    } else {
        tokio::time::sleep(Duration::from_millis(timeout_ms)).await
    }
}

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
    if let Some(prompt)=args["follow_up"].as_str() {
        if !background { return Err(ToolError::new("invalid_arguments","follow_up은 background=true와 함께 사용하세요")); }
        crate::continuations::validate_prompt(prompt).map_err(|e|ToolError::new(e.code,e.message))?;
    }
    let timeout = args["timeout_ms"].as_u64().unwrap_or(0);
    let hold_ms = if background { 0 } else { hold.unwrap_or(DEFAULT_HOLD_MS) };
    let mut target = json!({ "command": command, "cwd": rel_display(root, &cwd), "shell": shell_name(),
        "timeout_ms": timeout, "hold_ms": hold_ms });
    if let Some(prompt)=args["follow_up"].as_str() { target["follow_up"]=json!(prompt); }
    Ok(Planned { target, precondition: None })
}

/// `exec.shell` 설정의 선택지(EXEC-001). 임의 실행 파일 대신 명령 전달 인자가 알려진 셸만 허용한다.
pub const SHELL_CHOICES: &[&str] = &["default", "bash", "sh", "zsh", "pwsh", "powershell", "cmd"];

/// OS 기본 셸 이름.
fn shell_name() -> &'static str {
    if cfg!(windows) { "powershell" } else { "bash" }
}

/// 설정값을 실제 셸 이름으로. 알 수 없는 값은 OS 기본 셸이다.
pub fn resolve_shell(choice: &str) -> &'static str {
    SHELL_CHOICES.iter().copied().find(|c| *c == choice && *c != "default").unwrap_or_else(shell_name)
}

/// 셸별 실행 파일과 명령 전달 인자.
fn shell_argv(shell: &str) -> (&'static str, &'static [&'static str]) {
    match resolve_shell(shell) {
        "sh" => ("sh", &["-c"]),
        "zsh" => ("zsh", &["-c"]),
        "pwsh" => ("pwsh", &["-NoProfile", "-NonInteractive", "-Command"]),
        "powershell" => ("powershell", &["-NoProfile", "-NonInteractive", "-Command"]),
        "cmd" => ("cmd", &["/D", "/S", "/C"]),
        _ => ("bash", &["-c"]),
    }
}

/// 셸 선택값의 실행 파일 이름(설치 안내용)
pub fn program_of(shell: &str) -> &'static str {
    shell_argv(shell).0
}

/// 셸 실행 실패 메시지: 실행 파일이 없으면 설치·셸 변경 안내(ARCH-018).
pub fn spawn_message(shell: &str, e: &std::io::Error) -> (&'static str, String) {
    let program = program_of(shell);
    if crate::deps::is_missing(program, Some(e)) {
        ("dependency_missing", crate::deps::message(program))
    } else {
        ("spawn_failed", format!("셸 실행 실패: {e}"))
    }
}

/// 대화형 터미널용 셸 실행 파일. `default`면 None(터미널의 로그인 셸 규칙을 따른다).
pub fn interactive_program(choice: &str) -> Option<&'static str> {
    (choice != "default" && SHELL_CHOICES.contains(&choice)).then(|| shell_argv(choice).0)
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

fn remove_env(name: &str, inherit_credentials: bool) -> bool {
    if inherit_credentials { name.to_ascii_uppercase().starts_with("GROVE_") } else { is_sensitive_env(name) }
}

/// 셸 명령. 전체 권한을 명시한 계획만 계정 자격증명을 상속하며 Grove 내부 환경변수는 항상 제거한다.
/// 소유권 표식·process group·Job Object는 `procs::prepare`/`procs::adopt`가 맡는다(`tag`는 실행 표식).
pub fn command(shell: &str, command: &str, cwd: &Path, tag: &str, limits: crate::procs::Limits, inherit_credentials: bool) -> tokio::process::Command {
    let (program, args) = shell_argv(shell);
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args).arg(command);
    cmd.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for (k, _) in std::env::vars_os() {
        if k.to_str().is_none_or(|name| remove_env(name, inherit_credentials)) {
            cmd.env_remove(&k);
        }
    }
    cmd.env("GROVE_SHELL", "1");
    crate::procs::prepare(&mut cmd, tag, limits);
    cmd
}

pub async fn execute(planned: &Planned, root: &Path, mut cancel: watch::Receiver<bool>) -> ToolResult<Value> {
    let cwd = resolve(root, planned.target["cwd"].as_str().unwrap_or("."))?;
    let command = planned.target["command"].as_str().unwrap_or("");
    let timeout_ms = planned.target["timeout_ms"].as_u64().unwrap_or(0);
    let tag = crate::util::new_id();
    let limits = crate::procs::Limits::from_json(&planned.target["limits"]);
    let shell = planned.target["shell"].as_str().unwrap_or("default");
    let mut cmd = self::command(shell, command, &cwd, &tag, limits, planned.target["inherit_credentials"].as_bool().unwrap_or(false));
    let started = std::time::Instant::now();
    let mut child = cmd.spawn().map_err(|e| {
        let (code, msg) = spawn_message(shell, &e);
        ToolError::new(code, msg)
    })?;
    let owned = crate::procs::adopt(&mut child, &tag, limits).map_err(|e| ToolError::new("isolation_failed", e))?;
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
        _ = wait_deadline(timeout_ms) => End::Timeout,
        _ = cancel.wait_for(|c| *c) => End::Cancelled,
    };
    if !matches!(end, End::Exit(_)) {
        owned.kill_tree(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    } else {
        // 셸은 끝났지만 같은 트리에 남은 background 자식도 정리한다(Linux: setsid로 그룹을 떠난 자식은 범위 밖).
        owned.kill_tree(false);
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
        End::Timeout => Err(ToolError::new("timeout", format!("{timeout_ms}ms 안에 끝나지 않아 종료했습니다. 부분 실행됐을 수 있습니다"))
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
    fn plan_waits_one_minute_without_killing_and_keeps_explicit_deadlines() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::util::canonical(dir.path()).unwrap();
        let ordinary = plan(&json!({"command":"echo done"}), &root).unwrap();
        assert_eq!(ordinary.target["hold_ms"], 60_000);
        assert_eq!(ordinary.target["timeout_ms"], 0);
        let detached = plan(&json!({"command":"echo done","background":true}), &root).unwrap();
        assert_eq!(detached.target["hold_ms"], 0);
        assert_eq!(detached.target["timeout_ms"], 0);
        let explicit = plan(&json!({"command":"echo done","timeout_ms":90_000_000,"hold_ms":200}), &root).unwrap();
        assert_eq!(explicit.target["hold_ms"], 200);
        assert_eq!(explicit.target["timeout_ms"], 90_000_000);
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

    #[test]
    fn full_access_keeps_account_credentials_but_not_server_environment() {
        for name in ["SSH_AUTH_SOCK", "GPG_AGENT_INFO", "GIT_ASKPASS", "GH_TOKEN", "AWS_SECRET_ACCESS_KEY"] {
            assert!(remove_env(name, false), "{name}");
            assert!(!remove_env(name, true), "{name}");
        }
        for name in ["GROVE_DATA_DIR", "GROVE_MODEL_KEY", "grove_internal"] {
            assert!(remove_env(name, false), "{name}");
            assert!(remove_env(name, true), "{name}");
        }
        for name in ["PATH", "HOME", "LANG"] {
            assert!(!remove_env(name, false), "{name}");
            assert!(!remove_env(name, true), "{name}");
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
        // GROVE_SHELL·실행 표식(GROVE_TASK_ID)은 서버가 의도적으로 넣는 비밀 아닌 값이다.
        let leaked: Vec<_> = names.iter().filter(|n| **n != "GROVE_SHELL" && **n != crate::procs::OWNER_ENV && is_sensitive_env(n)).collect();
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
