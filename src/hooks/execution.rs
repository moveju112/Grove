//! 이벤트는 원래 작업과 같은 transaction에서 한 번 접수하고, 실행은 tool_calls가 소유한다.
use super::{COLS, SUPPORTED_EVENTS, row, sensitive};
use crate::{
    App, approvals,
    error::{ApiError, ApiResult},
    tools::{Planned, ToolError, ToolResult, shell},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, time::Duration};
use tokio::{io::{AsyncRead, AsyncReadExt}, sync::watch};

fn conflict(code: &'static str, message: &str) -> ApiError {
    ApiError::conflict(code, message)
}

/// 비차단 알림형 이벤트. source는 원래 session/message/turn/tool call ID다.
/// 재전송·중복 종료는 새 승인 요청이나 부작용을 만들지 않는다.
pub fn capture(c: &Connection, now: &str, session: &str, event: &str, source: &str, matcher: &str) -> ApiResult<()> {
    if !SUPPORTED_EVENTS.contains(&event) { return Ok(()); }
    let s = crate::sessions::get(c, session)?;
    let id = crate::util::new_id();
    if c.execute(
        "INSERT OR IGNORE INTO hook_events(id,session_id,event,source_id,match_target,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
        params![id, session, event, source, matcher, now],
    )? == 0 { return Ok(()); }
    crate::events::append(c, now, "hook.event", Some(&s.project_id), Some(session),
        &json!({"id":id,"event":event,"source_id":source,"match_target":matcher}))?;
    let hooks = c.prepare(&format!(
        "SELECT {COLS} FROM hook_definitions WHERE enabled=1 AND event=?1 AND (project_id IS NULL OR project_id=?2) ORDER BY id"
    ))?.query_map(params![event, s.project_id], row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    let ttl = approvals::approval_ttl(c, 1800)?;
    for hook in hooks {
        if globset::Glob::new(&hook.matcher).map_err(|_| ApiError::invalid("저장된 hook matcher가 유효하지 않습니다"))?
            .compile_matcher().is_match(matcher)
        {
            approvals::create_call(c, now, ttl, session, &s.project_id, Path::new("."), None, None, "hook",
                &json!({"hook_id":hook.id,"event_id":id}))?;
        }
    }
    Ok(())
}

fn no_unknown(c: &Connection, session: &str) -> ApiResult<()> {
    let pending: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM tool_calls WHERE session_id=?1 AND status='unknown' AND reviewed_at IS NULL)",
        [session], |r| r.get(0),
    )?;
    if pending { return Err(conflict("unknown_pending_review", "결과 불명 작업을 검토하기 전에는 hook을 실행하지 않습니다")); }
    Ok(())
}

fn shell_policy(c: &Connection, project: &str, session: &str) -> ApiResult<()> {
    if let approvals::PolicyDecision::Deny(code, message) =
        approvals::tool_policy(c, project, session, &crate::tools::spec("shell").expect("shell registry"))?
    {
        return Err(ApiError::conflict(code, message));
    }
    Ok(())
}

fn occurrence(c: &Connection, id: &str, session: &str) -> ApiResult<(String, String)> {
    c.query_row("SELECT event,match_target FROM hook_events WHERE id=?1 AND session_id=?2",
        params![id, session], |r| Ok((r.get(0)?, r.get(1)?))).optional()?
        .ok_or_else(|| ApiError::not_found("이 세션에서 접수한 hook 이벤트가 없습니다"))
}

pub fn plan_call(c: &Connection, args: &Value, project: &str, session: &str, call_id: &str) -> ApiResult<Planned> {
    no_unknown(c, session)?;
    shell_policy(c, project, session)?;
    let s = crate::sessions::get_active(c, session)?;
    if s.project_id != project { return Err(conflict("hook_scope_changed", "hook 실행 범위가 다릅니다")); }
    let id = args["hook_id"].as_str().ok_or_else(|| ApiError::invalid("hook_id가 필요합니다"))?;
    let event_id = args["event_id"].as_str().ok_or_else(|| ApiError::invalid("event_id가 필요합니다"))?;
    let (event, match_target) = occurrence(c, event_id, session)?;
    if !SUPPORTED_EVENTS.contains(&event.as_str()) {
        return Err(conflict("hook_event_unsupported", "이 hook 이벤트·플랫폼은 실행 미지원입니다"));
    }
    let hook = c.query_row(&format!("SELECT {COLS} FROM hook_definitions WHERE id=?1"), [id], row)
        .optional()?.ok_or_else(|| ApiError::not_found("hook이 없습니다"))?;
    if !hook.enabled || hook.event != event || hook.project_id.as_deref().is_some_and(|p| p != project)
        || !globset::Glob::new(&hook.matcher).map_err(|_| ApiError::invalid("hook matcher 오류"))?.compile_matcher().is_match(&match_target)
    {
        return Err(conflict("hook_not_applicable", "활성 hook의 범위·이벤트·matcher가 일치하지 않습니다"));
    }
    let used: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM hook_runs WHERE event_id=?1 AND hook_id=?2)",
        params![event_id, id], |r| r.get(0))?;
    if used { return Err(conflict("hook_already_planned", "이 이벤트의 hook은 이미 접수됐습니다. 자동 반복하지 않습니다")); }
    let root = crate::sessions::exec_root(c, session)?.canonicalize()
        .map_err(|_| conflict("hook_cwd_changed", "hook 실행 위치를 확인할 수 없습니다"))?;
    let choice = crate::settings::effective(c, "exec.shell", Some(project), Some(session))?;
    let shell = shell::resolve_shell(choice.as_str().unwrap_or("default"));
    if !matches!(shell, "bash" | "sh") {
        return Err(conflict("hook_shell_unsupported", "hook 환경 격리는 Linux bash·sh만 지원합니다. 이 셸의 hook은 실행하지 않습니다"));
    }
    let limits = crate::procs::Limits::effective(c, Some(project), Some(session))?;
    let timeout = args["timeout_ms"].as_u64().unwrap_or(shell::DEFAULT_TIMEOUT_MS);
    let environment = BTreeMap::from([
        ("PATH", "/usr/bin:/bin".to_string()),
        ("LANG", "C.UTF-8".to_string()),
        ("GROVE_SHELL", "1".to_string()),
        (crate::procs::OWNER_ENV, call_id.to_string()),
        ("GROVE_HOOK_EVENT", event.clone()),
        ("GROVE_HOOK_SESSION_ID", session.to_string()),
        ("GROVE_HOOK_MATCH_TARGET", match_target.clone()),
    ]);
    let target = json!({
        "hook_id":id,"event_id":event_id,"event":event,"match_target":match_target,
        "hook_revision":hook.revision,"hook_scope":hook.project_id,"matcher":hook.matcher,
        "command":if sensitive(&hook.command) { "[redacted]" } else { &hook.command },
        "command_sha256":crate::util::sha256_hex(hook.command.as_bytes()),
        "cwd":root.to_string_lossy(),"shell":shell,
        "environment":environment,"timeout_ms":timeout,"limits":limits.to_json(),
        "mode":"independent_notification"
    });
    // 원문은 기존 private precondition에만 보관한다. 응답·이벤트·idempotency에는 반사하지 않는다.
    let precondition = json!({"command":hook.command,"binding":crate::idem::body_hash("hook.plan",&target)});
    c.execute("INSERT INTO hook_runs(event_id,hook_id,call_id) VALUES(?1,?2,?3)", params![event_id, id, call_id])?;
    Ok(Planned { target, precondition: Some(precondition) })
}

pub fn validate_call(c: &Connection, call: &approvals::ToolCallRow) -> ApiResult<()> {
    no_unknown(c, &call.session_id)?;
    shell_policy(c, &call.project_id, &call.session_id)?;
    let s = crate::sessions::get_active(c, &call.session_id)?;
    let t = &call.target;
    let pre = call.precondition.as_ref().ok_or_else(|| conflict("hook_plan_changed", "hook 계획이 없습니다"))?;
    if pre["binding"] != crate::idem::body_hash("hook.plan", t) {
        return Err(conflict("hook_plan_changed", "승인한 hook 계획이 바뀌었습니다"));
    }
    let bound: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM hook_runs WHERE event_id=?1 AND hook_id=?2 AND call_id=?3)",
        params![t["event_id"].as_str(), t["hook_id"].as_str(), call.id], |r| r.get(0),
    )?;
    if !bound || s.project_id != call.project_id {
        return Err(conflict("hook_scope_changed", "hook 실행 범위·접수 기록이 바뀌었습니다"));
    }
    let (event, match_target) = occurrence(c, t["event_id"].as_str().unwrap_or(""), &call.session_id)?;
    let hook = c.query_row(&format!("SELECT {COLS} FROM hook_definitions WHERE id=?1"),
        [t["hook_id"].as_str().unwrap_or("")], row).optional()?
        .ok_or_else(|| conflict("hook_config_changed", "승인 대기 중 hook이 삭제됐습니다"))?;
    if !hook.enabled || t["hook_revision"] != hook.revision || t["hook_scope"] != json!(hook.project_id)
        || t["event"] != event || hook.event != event || t["match_target"] != match_target
        || t["matcher"] != hook.matcher || pre["command"] != hook.command
        || hook.project_id.as_deref().is_some_and(|p| p != call.project_id)
    {
        return Err(conflict("hook_config_changed", "승인한 hook revision·활성·범위·matcher가 바뀌었습니다"));
    }
    let root = crate::sessions::exec_root(c, &call.session_id)?.canonicalize()
        .map_err(|_| conflict("hook_cwd_changed", "hook 실행 위치가 없습니다"))?;
    if t["cwd"] != root.to_string_lossy().as_ref() {
        return Err(conflict("hook_cwd_changed", "승인한 hook 실행 위치가 바뀌었습니다"));
    }
    if t["limits"] != crate::procs::Limits::effective(c, Some(&call.project_id), Some(&call.session_id))?.to_json() {
        return Err(conflict("hook_limits_changed", "승인 이후 자원 한도가 바뀌었습니다"));
    }
    Ok(())
}

/// running receipt의 ID가 프로세스 소유 표식이다. 상태는 기존 복구기가 unknown으로 확정한다.
pub fn recover(c: &Connection) -> ApiResult<()> {
    let ids = c.prepare("SELECT id FROM tool_calls WHERE name='hook' AND status='running'")?
        .query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    crate::procs::reap_leftovers(&ids);
    Ok(())
}

// JSON escape의 최악 크기를 포함해 일반 도구 출력 한도 안에 들어가게 보관한다.
const CAPTURE_BYTES: usize = crate::tools::MAX_OUTPUT / 16;
async fn capture_output<R: AsyncRead + Unpin>(mut reader: R) -> std::io::Result<(Vec<u8>, usize)> {
    let mut kept = Vec::new();
    let mut total = 0;
    let mut buf = [0; 4096];
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 { return Ok((kept, total)); }
        total += n;
        let take = n.min(CAPTURE_BYTES - kept.len());
        kept.extend_from_slice(&buf[..take]);
    }
}

struct Cleanup { owned: crate::procs::Owned, tag: String }
impl Drop for Cleanup {
    fn drop(&mut self) {
        self.owned.kill_tree(false);
        crate::procs::reap_leftovers(std::slice::from_ref(&self.tag));
    }
}

pub async fn execute_call(app: &App, call: &approvals::ToolCallRow, mut cancel: watch::Receiver<bool>) -> ToolResult<Value> {
    let snapshot = call.clone();
    app.db.call(move |c| {
        approvals::check_running_execution(c, &snapshot.id)?;
        validate_call(c, &snapshot)
    }).await.map_err(|e| ToolError::new(e.code, e.message))?;
    let mut shutdown = app.shutdown_rx.clone();
    if *cancel.borrow() || *shutdown.borrow() {
        return Err(ToolError::new("cancelled", "실행 전에 취소됐습니다"));
    }
    let t = &call.target;
    let command = call.precondition.as_ref().and_then(|p| p["command"].as_str())
        .ok_or_else(|| ToolError::new("hook_plan_changed", "hook 명령 계획이 없습니다"))?;
    let shell = t["shell"].as_str().unwrap_or("bash");
    let limits = crate::procs::Limits::from_json(&t["limits"]);
    let mut cmd = shell::command(shell, command, Path::new(t["cwd"].as_str().unwrap_or("")), &call.id, limits);
    // BASH_ENV/ENV, HOME, credentials, server settings 및 host PATH를 모두 차단한다.
    cmd.env_clear();
    let env: BTreeMap<String, String> = serde_json::from_value(t["environment"].clone())
        .map_err(|_| ToolError::new("hook_plan_changed", "hook 환경 계획이 유효하지 않습니다"))?;
    cmd.envs(env);
    let mut child = cmd.spawn().map_err(|e| {
        let (code, message) = shell::spawn_message(shell, &e);
        ToolError::new(code, message)
    })?;
    let cleanup = Cleanup {
        owned: crate::procs::adopt(&mut child, &call.id, limits).map_err(|e| ToolError::new("isolation_failed", e))?,
        tag: call.id.clone(),
    };
    let stdout = child.stdout.take().expect("hook stdout pipe");
    let stderr = child.stderr.take().expect("hook stderr pipe");
    // 소유 future를 함께 drop하므로 detached reader task를 남기지 않는다.
    let output = async { tokio::try_join!(capture_output(stdout), capture_output(stderr)) };
    tokio::pin!(output);
    let timeout = Duration::from_millis(t["timeout_ms"].as_u64().unwrap_or(shell::DEFAULT_TIMEOUT_MS));
    let started = std::time::Instant::now();
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let mut captured = None;
    let status = loop {
        tokio::select! {
            r = child.wait() => break r.map_err(|_| ToolError::new("result_unknown", "hook 종료 상태를 확인할 수 없습니다")),
            r = &mut output, if captured.is_none() => captured = Some(r),
            _ = &mut deadline => break Err(ToolError::new("timeout", "hook timeout으로 종료했습니다. 부분 실행됐을 수 있습니다")),
            _ = cancel.wait_for(|v| *v) => break Err(ToolError::new("cancelled", "사용자 취소로 hook을 종료했습니다. 부분 실행됐을 수 있습니다")),
            _ = shutdown.wait_for(|v| *v) => break Err(ToolError::new("cancelled", "서버 종료로 hook을 종료했습니다. 부분 실행됐을 수 있습니다")),
        }
    };
    if status.is_err() {
        cleanup.owned.kill_tree(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    }
    drop(cleanup);
    let captured = match captured {
        Some(result) => Ok(result),
        None => tokio::time::timeout(Duration::from_secs(5), &mut output).await,
    };
    let output_error = || status.as_ref().err().cloned().unwrap_or_else(||
        ToolError::new("output_unavailable", "hook 출력을 회수하지 못했습니다. 부작용을 반복하지 마세요"));
    let ((out, out_total), (err, err_total)) = captured.map_err(|_| output_error())?.map_err(|_| output_error())?;
    let redact = |bytes: &[u8]| {
        let text = String::from_utf8_lossy(bytes);
        if sensitive(command) || sensitive(&text) { "[redacted]".to_string() } else { text.into_owned() }
    };
    let result = json!({"stdout":redact(&out),"stderr":redact(&err),
        "stdout_bytes":out_total,"stderr_bytes":err_total,
        "truncated":out_total>CAPTURE_BYTES || err_total>CAPTURE_BYTES,
        "duration_ms":started.elapsed().as_millis() as u64});
    let status = status.map_err(|e| e.with_output(result.clone()))?;
    if !status.success() {
        return Err(ToolError::new("hook_exit_failed", format!("hook이 실패 종료했습니다: {status}")).with_output(result));
    }
    Ok(json!({"exit_code":status.code(),"output":result,"event":t["event"],"hook_id":t["hook_id"]}))
}
