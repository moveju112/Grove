//! 공식 CLI 인증을 등록 기기의 메모리 전용 작업으로 연결한다.
//! 인증 URL·코드·CLI 원문은 DB, 이벤트, 로그에 기록하지 않는다.
use crate::{App, auth::Principal, error::{ApiError, ApiResult}};
use axum::{Json, extract::{Path, State}, response::{IntoResponse, Response}};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, process::Stdio, sync::{Arc, Mutex}, time::Duration};
use tokio::{io::{AsyncRead, AsyncReadExt, AsyncWriteExt}, sync::{mpsc, watch}};
use crate::provider::cli::claude;

const TTL: Duration = Duration::from_secs(15 * 60);
const OUTPUT_LIMIT: usize = 32 * 1024;

#[derive(Clone, Serialize, ts_rs::TS)]
pub struct LoginAttempt {
    pub id: String,
    pub state: String,
    pub url: Option<String>,
    pub code: Option<String>,
}
impl LoginAttempt {
    fn active(&self) -> bool { matches!(self.state.as_str(), "starting" | "waiting" | "verifying") }
    fn finish(&mut self, state: &str) {
        self.state = state.into();
        self.url = None;
        self.code = None;
    }
}

#[derive(Serialize, ts_rs::TS)]
pub struct AgentAuthStatus {
    pub authenticated: Option<bool>,
    pub attempt: Option<LoginAttempt>,
}

struct Attempt {
    view: Arc<Mutex<LoginAttempt>>,
    input: mpsc::Sender<String>,
    cancel: watch::Sender<bool>,
}
#[derive(Default)]
pub struct Logins {
    // 백엔드당 하나. 작업 완료 전 새 로그인·로그아웃은 시작하지 않는다.
    attempts: tokio::sync::Mutex<HashMap<String, Attempt>>,
}
impl Logins {
    pub async fn active(&self, protocol: &str) -> bool {
        self.attempts.lock().await.get(auth_protocol(protocol)).is_some_and(|attempt| attempt.view.lock().expect("login").active())
    }
}

fn auth_protocol(protocol: &str) -> &str {
    if protocol == crate::provider::codex_oauth::PROTOCOL { "codex_cli" } else { protocol }
}

fn program(protocol: &str) -> ApiResult<&'static str> {
    match protocol {
        "codex_cli" => Ok("codex"),
        "claude_code" => Ok("claude"),
        _ => Err(ApiError::invalid("지원하지 않는 에이전트입니다")),
    }
}
fn busy() -> ApiError {
    ApiError::new(axum::http::StatusCode::CONFLICT, "busy", "진행 중인 인증이나 대화를 먼저 끝내 주세요")
}
fn response(value: AgentAuthStatus) -> Response {
    ([("cache-control", "no-store")], Json(value)).into_response()
}
fn command(program: &str) -> tokio::process::Command {
    let mut cmd = if program == "claude" {
        claude::command(program)
    } else {
        let mut cmd = tokio::process::Command::new(program);
        for (key, _) in std::env::vars_os() {
            if key.to_str().is_some_and(|key| key.starts_with("GROVE_")) { cmd.env_remove(key); }
        }
        cmd
    };
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // 공식 CLI의 브라우저 실행을 억제한다. 링크는 요청한 기기에만 전달한다.
    cmd.env("BROWSER", "/bin/true");
    cmd
}

struct Process {
    child: tokio::process::Child,
    owned: crate::procs::Owned,
}
impl Drop for Process {
    fn drop(&mut self) { self.owned.kill_tree(self.child.id().is_some()); }
}

async fn bounded<R: AsyncRead + Unpin>(reader: R) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    reader.take((OUTPUT_LIMIT + 1) as u64).read_to_end(&mut output).await?;
    if output.len() > OUTPUT_LIMIT { return Err(std::io::Error::other("output limit")); }
    Ok(output)
}

async fn run_short(protocol: &str, logout: bool) -> ApiResult<Option<bool>> {
    let executable = program(protocol)?;
    if crate::deps::find_in_path(executable).is_none() { return Err(crate::deps::missing(executable)); }
    if protocol == "claude_code" && !logout {
        let settings = claude::settings(serde_json::json!({}));
        return Ok(claude::authenticated(std::path::Path::new(executable), None, &settings, None).await.ok().flatten());
    }
    let mut cmd = command(executable);
    if protocol == "codex_cli" {
        if logout { cmd.arg("logout"); } else { cmd.args(["login", "status"]); }
    } else { cmd.args(["auth", "logout"]); }
    let tag = crate::util::new_id();
    crate::procs::prepare(&mut cmd, &tag);
    let mut child = cmd.spawn().map_err(|_| ApiError::invalid("인증 상태를 확인하지 못했습니다"))?;
    let owned = crate::procs::adopt(&mut child, &tag).map_err(|_| ApiError::invalid("인증 프로세스를 격리하지 못했습니다"))?;
    let stdout = child.stdout.take().expect("stdout");
    let stderr = child.stderr.take().expect("stderr");
    let mut process = Process { child, owned };
    let result = tokio::time::timeout(Duration::from_secs(8), async {
        tokio::try_join!(process.child.wait(), bounded(stdout), bounded(stderr))
    }).await;
    let Ok(Ok((status, stdout, stderr))) = result else { return Ok(None); };
    if logout { return Ok(status.success().then_some(false)); }
    let text = format!("{}{}", String::from_utf8_lossy(&stdout), String::from_utf8_lossy(&stderr));
    Ok(if status.success() && text.contains("Logged in") { Some(true) }
        else if text.contains("Not logged in") { Some(false) } else { None })
}

/// 자격 파일을 읽지 않고 공식 CLI의 인증 상태만 확인한다.
pub(crate) async fn authenticated(protocol: &str) -> ApiResult<Option<bool>> {
    run_short(protocol, false).await
}

async fn ensure_idle(app: &App, protocol: &str) -> ApiResult<()> {
    let protocol = protocol.to_string();
    let active = app.db.call(move |c| {
        Ok(c.query_row(
            "SELECT EXISTS(SELECT 1 FROM turns t JOIN model_profiles p ON p.id=t.profile_id \
             WHERE (p.protocol=?1 OR (?1='codex_cli' AND p.protocol='codex_oauth'))
             AND t.status IN ('queued','running','awaiting_approval'))",
            [&protocol], |row| row.get::<_, bool>(0))?)
    }).await?;
    if active { return Err(busy()); }
    Ok(())
}

pub async fn status(State(app): State<App>, _p: Principal, Path(protocol): Path<String>) -> ApiResult<Response> {
    let protocol = auth_protocol(&protocol);
    program(protocol)?;
    let attempts = app.agent_logins.attempts.lock().await;
    let attempt = attempts.get(protocol).map(|attempt| attempt.view.lock().expect("login").clone());
    let authenticated = if attempt.as_ref().is_some_and(LoginAttempt::active) { None }
        else { authenticated(protocol).await? };
    Ok(response(AgentAuthStatus { authenticated, attempt }))
}

#[derive(Deserialize)]
pub struct Start {
    id: String,
    previous_id: Option<String>,
}

pub async fn start(State(app): State<App>, _p: Principal, Path(protocol): Path<String>, Json(req): Json<Start>) -> ApiResult<Response> {
    if app.is_shutting_down() { return Err(busy()); }
    let protocol = auth_protocol(&protocol).to_owned();
    let executable = program(&protocol)?;
    if uuid::Uuid::parse_str(&req.id).is_err() { return Err(ApiError::invalid("잘못된 로그인 요청 ID입니다")); }
    if !cfg!(unix) { return Err(ApiError::invalid("이 서버 OS에서는 터미널에서 로그인해 주세요")); }
    let mut attempts = app.agent_logins.attempts.lock().await;
    if let Some(existing) = attempts.get(&protocol) {
        let view = existing.view.lock().expect("login").clone();
        if view.id == req.id {
            return Ok(response(AgentAuthStatus { authenticated: None, attempt: Some(view) }));
        }
        if view.active() || req.previous_id.as_deref() != Some(&view.id) { return Err(busy()); }
    } else if req.previous_id.is_some() {
        return Err(ApiError::invalid("서버가 재시작됐습니다. 인증 상태를 다시 확인해 주세요"));
    }
    ensure_idle(&app, &protocol).await?;
    if crate::deps::find_in_path(executable).is_none() { return Err(crate::deps::missing(executable)); }
    let mut cmd = command(executable);
    if protocol == "codex_cli" { cmd.args(["login", "--device-auth"]); }
    else {
        app.claude_sessions.clear();
        cmd.arg("--settings").arg(claude::settings(serde_json::json!({}))).args(["auth", "login"]);
    }
    cmd.stdin(Stdio::piped());
    let tag = crate::util::new_id();
    crate::procs::prepare(&mut cmd, &tag);
    let mut child = cmd.spawn().map_err(|_| ApiError::invalid("로그인을 시작하지 못했습니다"))?;
    let owned = crate::procs::adopt(&mut child, &tag).map_err(|_| ApiError::invalid("인증 프로세스를 격리하지 못했습니다"))?;
    let initial = LoginAttempt { id: req.id, state: "starting".into(), url: None, code: None };
    let view = Arc::new(Mutex::new(initial.clone()));
    let (input, rx) = mpsc::channel(1);
    let (cancel, cancel_rx) = watch::channel(false);
    attempts.insert(protocol.clone(), Attempt { view: view.clone(), input, cancel });
    let cache = app.account_usage.clone();
    let shutdown = app.shutdown_rx.clone();
    tokio::spawn(async move {
        login_process(protocol.clone(), Process { child, owned }, view, rx, cancel_rx, shutdown).await;
        cache.clear(&protocol).await;
    });
    Ok(response(AgentAuthStatus { authenticated: None, attempt: Some(initial) }))
}

#[derive(Deserialize)]
pub struct Submit { id: String, code: String }
pub async fn submit(State(app): State<App>, _p: Principal, Path(protocol): Path<String>, Json(req): Json<Submit>) -> ApiResult<Response> {
    if protocol != "claude_code" || req.code.len() > 4096 || req.code.trim().is_empty()
        || req.code.chars().any(|c| c.is_whitespace() || c.is_control())
    { return Err(ApiError::invalid("올바른 일회용 코드를 입력해 주세요")); }
    let attempts = app.agent_logins.attempts.lock().await;
    let attempt = attempts.get(&protocol).ok_or_else(|| ApiError::invalid("로그인을 먼저 시작해 주세요"))?;
    let mut view = attempt.view.lock().expect("login");
    if view.id != req.id { return Err(busy()); }
    // 응답 유실로 같은 코드가 다시 와도 stdin에 두 번 쓰지 않는다.
    if view.state == "waiting" {
        attempt.input.try_send(req.code).map_err(|_| busy())?;
        view.state = "verifying".into();
        view.url = None;
    } else if view.state != "verifying" && view.state != "completed" { return Err(busy()); }
    Ok(response(AgentAuthStatus { authenticated: None, attempt: Some(view.clone()) }))
}

#[derive(Deserialize)]
pub struct Cancel { id: String }
pub async fn cancel(State(app): State<App>, _p: Principal, Path(protocol): Path<String>, Json(req): Json<Cancel>) -> ApiResult<Response> {
    let protocol = auth_protocol(&protocol);
    program(protocol)?;
    let attempts = app.agent_logins.attempts.lock().await;
    let attempt = attempts.get(protocol).ok_or_else(|| ApiError::invalid("진행 중인 로그인이 없습니다"))?;
    let view = attempt.view.lock().expect("login").clone();
    if view.id != req.id { return Err(busy()); }
    if view.active() { attempt.cancel.send_replace(true); }
    Ok(response(AgentAuthStatus { authenticated: None, attempt: Some(view) }))
}

#[derive(Deserialize)]
pub struct Logout { attempt_id: Option<String> }
pub async fn logout(State(app): State<App>, _p: Principal, Path(protocol): Path<String>, Json(req): Json<Logout>) -> ApiResult<Response> {
    let protocol = auth_protocol(&protocol).to_owned();
    program(&protocol)?;
    let attempts = app.agent_logins.attempts.lock().await;
    let current = attempts.get(&protocol).map(|a| a.view.lock().expect("login").clone());
    // 늦게 도착한 이전 화면의 로그아웃이 새 로그인 계정을 지우지 않는다.
    if current.as_ref().is_some_and(LoginAttempt::active)
        || current.as_ref().map(|a| &a.id) != req.attempt_id.as_ref() { return Err(busy()); }
    ensure_idle(&app, &protocol).await?;
    if protocol == "claude_code" { app.claude_sessions.clear(); }
    let authenticated = run_short(&protocol, true).await?;
    app.account_usage.clear(&protocol).await;
    if authenticated.is_none() { return Err(ApiError::invalid("로그아웃 결과를 확인하지 못했습니다. 상태를 다시 확인해 주세요")); }
    let authenticated = run_short(&protocol, false).await?;
    if authenticated == Some(true) {
        return Err(ApiError::invalid("CLI 인증이 아직 남아 있습니다. 서버의 CLI 인증 설정을 확인해 주세요"));
    }
    Ok(response(AgentAuthStatus { authenticated, attempt: None }))
}

fn challenge(protocol: &str, output: &str) -> (Option<String>, Option<String>) {
    let ansi = regex::Regex::new(r"\x1b\[[0-9;]*[A-Za-z]").expect("ansi");
    let text = ansi.replace_all(output, "");
    let urls = regex::Regex::new(r#"https://[^\s<>"']+"#).expect("url");
    let url = urls.find_iter(&text).filter(|m| m.end() < text.len()).map(|m| m.as_str()).find(|candidate| {
        let Ok(url) = reqwest::Url::parse(candidate) else { return false; };
        if !url.username().is_empty() || url.password().is_some() || url.port().is_some() { return false; }
        match protocol {
            "codex_cli" => url.host_str() == Some("auth.openai.com") && url.path() == "/codex/device",
            "claude_code" => matches!((url.host_str(), url.path()),
                (Some("claude.com"), "/cai/oauth/authorize") | (Some("claude.ai"), "/oauth/authorize")),
            _ => false,
        }
    }).map(str::to_owned);
    let code = if protocol == "codex_cli" && url.is_some() {
        // 공식 CLI가 URL 다음에 출력하는 별도 코드 행만 취한다.
        text.lines().map(str::trim).find(|line| {
            (8..=32).contains(&line.len()) && line.contains('-')
                && line.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
        }).map(str::to_owned)
    } else { None };
    (url, code)
}

async fn login_process(
    protocol: String, mut process: Process,
    view: Arc<Mutex<LoginAttempt>>, mut input: mpsc::Receiver<String>,
    mut cancel: watch::Receiver<bool>, mut shutdown: watch::Receiver<bool>,
) {
    let mut stdout = process.child.stdout.take().expect("stdout");
    let mut stderr = process.child.stderr.take().expect("stderr");
    let mut stdin = process.child.stdin.take().expect("stdin");
    let result = tokio::time::timeout(TTL, async {
        let mut output = Vec::new();
        let (mut out_open, mut err_open) = (true, true);
        let (mut out_buf, mut err_buf) = ([0u8; 2048], [0u8; 2048]);
        loop {
            let bytes = tokio::select! {
                biased;
                _ = cancel.changed() => return "cancelled",
                _ = shutdown.changed() => return "cancelled",
                code = input.recv() => {
                    let Some(code) = code else { return "cancelled"; };
                    if stdin.write_all(format!("{code}\n").as_bytes()).await.is_err() { return "failed"; }
                    continue;
                }
                chunk = stdout.read(&mut out_buf), if out_open => {
                    match chunk { Ok(0) => { out_open = false; continue; }, Ok(n) => out_buf[..n].to_vec(), Err(_) => return "failed" }
                }
                chunk = stderr.read(&mut err_buf), if err_open => {
                    match chunk { Ok(0) => { err_open = false; continue; }, Ok(n) => err_buf[..n].to_vec(), Err(_) => return "failed" }
                }
                status = process.child.wait(), if !out_open && !err_open => {
                    return if status.is_ok_and(|s| s.success()) { "completed" } else { "failed" };
                }
            };
            if output.len() + bytes.len() > OUTPUT_LIMIT { return "failed"; }
            output.extend_from_slice(&bytes);
            let (url, code) = challenge(&protocol, &String::from_utf8_lossy(&output));
            if url.is_some() && (protocol != "codex_cli" || code.is_some()) {
                let mut view = view.lock().expect("login");
                if view.state != "verifying" {
                    view.state = "waiting".into();
                    view.url = url;
                    view.code = code;
                }
            }
        }
    }).await.unwrap_or("expired");
    process.owned.kill_tree(process.child.id().is_some());
    let _ = process.child.wait().await;
    view.lock().expect("login").finish(result);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_official_challenges_are_exposed() {
        let (url, code) = challenge("codex_cli", "\x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n ABCD-12345 \n");
        assert_eq!(url.as_deref(), Some("https://auth.openai.com/codex/device"));
        assert_eq!(code.as_deref(), Some("ABCD-12345"));
        for url in ["https://auth.openai.com.evil.test/codex/device", "https://evil@auth.openai.com/codex/device",
            "https://auth.openai.com:1234/codex/device", "https://auth.openai.com/other"] {
            assert_eq!(challenge("codex_cli", &format!("{url}\n")), (None, None));
        }
        assert!(challenge("claude_code", "https://claude.com/cai/oauth/authorize?state=fixture\n").0.is_some());
        assert!(challenge("claude_code", "https://claude.com/cai/oauth/authorize?state=part").0.is_none());
    }
    #[test]
    fn terminal_state_removes_challenge() {
        let mut view = LoginAttempt { id: "fixture".into(), state: "waiting".into(), url: Some("private".into()), code: Some("private".into()) };
        view.finish("cancelled");
        assert!(!view.active());
        assert!(view.url.is_none() && view.code.is_none());
    }
}
