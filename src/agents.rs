//! 자식 에이전트 작업(AGENT-001, 006~012, 014, 019).
//!
//! - 소유권: 자식 작업(run)은 부모 세션·부모 턴·부모 도구 호출에 묶인다. 다른 세션의 run은 조작할 수 없다.
//! - 실행: 자식은 같은 프로젝트의 자식 세션에서 일반 턴으로 돈다(승인·취소·재시작 복구를 그대로 쓴다).
//! - 결과: 에이전트가 지시한 턴(last_turn_id)이 끝나면 `finish_turn`과 같은 transaction에서 부모 세션에 note를 한 번 남긴다.
//!   사용자가 자식 세션에서 직접 보낸 턴은 보고하지 않는다(reportsBack은 에이전트 지시 턴만).
//! - 한도: 깊이(MAX_DEPTH), 부모 세션당 동시 실행(MAX_PER_PARENT), 서버 전체 동시 실행(MAX_RUNNING).
//! - 부모 턴 취소 시 그 턴이 띄운 자식도 취소한다. 서버 종료·재시작 시 자식 턴은 interrupted로 끝나고 그대로 보고된다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::tools::ToolError;
use axum::Json;
use axum::extract::{Path, State};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::watch;

pub const MAX_DEPTH: i64 = 2;
pub const MAX_PER_PARENT: i64 = 4;
pub const MAX_RUNNING: i64 = 16;
/// note에 넣는 결과 텍스트 상한(문자).
const MAX_RESULT_CHARS: usize = 16_000;

#[derive(Debug, Clone, Serialize)]
pub struct AgentRun {
    pub id: String,
    pub parent_session_id: String,
    pub parent_turn_id: Option<String>,
    pub parent_call_id: Option<String>,
    pub child_session_id: String,
    pub agent_id: String,
    pub profile_id: String,
    pub tools_enabled: bool,
    pub depth: i64,
    pub status: String,
    pub last_turn_id: Option<String>,
    pub delivered_turn_id: Option<String>,
    pub result: Option<String>,
    pub error: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
    pub ended_at: Option<String>,
    /// 마지막 자식 턴의 상태(SESSION-012: 접수·실행·승인 대기·완료 구분)
    pub turn_status: Option<String>,
}

const COLS: &str = "id, parent_session_id, parent_turn_id, parent_call_id, child_session_id, agent_id, profile_id, tools_enabled, depth, status, \
                    last_turn_id, delivered_turn_id, result, error, created_at, updated_at, ended_at, \
                    (SELECT CASE WHEN t.status = 'awaiting_approval' \
                        AND EXISTS (SELECT 1 FROM tool_calls q WHERE q.turn_id = t.id AND q.status = 'awaiting_input') \
                        AND NOT EXISTS (SELECT 1 FROM tool_calls a WHERE a.turn_id = t.id AND a.status = 'pending_approval') \
                        THEN 'awaiting_input' ELSE t.status END FROM turns t WHERE t.id = agent_runs.last_turn_id)";

/// 자식 턴의 상태가 바뀌면(접수·실행·승인/질문 대기) 부모 대화의 작업 목록도 갱신한다(WORKFLOW-007).
/// 종료는 `on_turn_finished`가 결과 전달과 함께 알린다.
pub fn on_turn_changed(c: &Connection, now: &str, turn_id: &str) -> ApiResult<()> {
    let run = c.query_row(&format!("SELECT {COLS} FROM agent_runs WHERE last_turn_id = ?1 AND status = 'running'"), params![turn_id], from_row).optional()?;
    if let Some(run) = run {
        emit(c, now, &run)?;
    }
    Ok(())
}

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<AgentRun> {
    let err: Option<String> = r.get(13)?;
    Ok(AgentRun {
        id: r.get(0)?,
        parent_session_id: r.get(1)?,
        parent_turn_id: r.get(2)?,
        parent_call_id: r.get(3)?,
        child_session_id: r.get(4)?,
        agent_id: r.get(5)?,
        profile_id: r.get(6)?,
        tools_enabled: r.get(7)?,
        depth: r.get(8)?,
        status: r.get(9)?,
        last_turn_id: r.get(10)?,
        delivered_turn_id: r.get(11)?,
        result: r.get(12)?,
        error: err.and_then(|e| serde_json::from_str(&e).ok()),
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
        ended_at: r.get(16)?,
        turn_status: r.get(17)?,
    })
}

pub fn get(c: &Connection, id: &str) -> ApiResult<AgentRun> {
    c.query_row(&format!("SELECT {COLS} FROM agent_runs WHERE id = ?1"), params![id], from_row)
        .optional()?
        .ok_or_else(|| ApiError::not_found("자식 에이전트 작업이 없습니다"))
}

pub fn run_by_child(c: &Connection, child_session_id: &str) -> ApiResult<Option<AgentRun>> {
    Ok(c.query_row(&format!("SELECT {COLS} FROM agent_runs WHERE child_session_id = ?1"), params![child_session_id], from_row).optional()?)
}

pub fn running_for_parent(c: &Connection, parent_session_id: &str) -> ApiResult<i64> {
    Ok(c.query_row("SELECT COUNT(*) FROM agent_runs WHERE parent_session_id = ?1 AND status = 'running'", params![parent_session_id], |r| r.get(0))?)
}

fn list_for_parent(c: &Connection, parent_session_id: &str) -> ApiResult<Vec<AgentRun>> {
    let mut st = c.prepare(&format!("SELECT {COLS} FROM agent_runs WHERE parent_session_id = ?1 ORDER BY (status = 'running') DESC, created_at DESC LIMIT 100"))?;
    let v = st.query_map(params![parent_session_id], from_row)?.collect::<Result<_, _>>()?;
    Ok(v)
}

fn session_depth(c: &Connection, session_id: &str) -> ApiResult<i64> {
    Ok(run_by_child(c, session_id)?.map(|r| r.depth).unwrap_or(0))
}

/// 모델에 보여 줄 사용 가능 에이전트(최대 깊이면 빈 목록).
pub fn available_for(c: &Connection, session_id: &str) -> ApiResult<Value> {
    if session_depth(c, session_id)? >= MAX_DEPTH {
        return Ok(json!([]));
    }
    let policy = crate::agent_policy::Policy::for_session(c, session_id)?;
    let defs = crate::definitions::list_all(c, "agent")?;
    Ok(defs
        .into_iter()
        .filter(|d| d.enabled && policy.allows(&d.id))
        .map(|d| json!({ "id": d.id, "name": d.name, "description": d.description.chars().take(200).collect::<String>() }))
        .collect())
}

/// 승인 정책: Some(true)=승인 필요, Some(false)=자동, None=금지.
pub fn approval_policy(c: &Connection, project_id: &str, session_id: &str, target: &Value) -> ApiResult<Option<bool>> {
    match target["action"].as_str() {
        Some("spawn" | "send") => {}
        // 조회·대기·취소는 부작용을 늘리지 않으므로 바로 실행한다.
        _ => return Ok(Some(false)),
    }
    let session = crate::sessions::get(c, session_id)?;
    if session.project_id != project_id {
        return Err(ApiError::not_found("이 프로젝트의 대화가 아닙니다"));
    }
    let policy = crate::agent_policy::Policy::for_session(c, session_id)?;
    let id = if target["action"] == "send" {
        let run = match get(c, target["run_id"].as_str().unwrap_or("")) {
            Ok(run) if run.parent_session_id == session_id => run,
            // 소유권 오류는 기존 실행 경로가 not_found 도구 결과로 돌려준다.
            Ok(_) => return Ok(Some(false)),
            Err(error) if error.code == "not_found" => return Ok(Some(false)),
            Err(error) => return Err(error),
        };
        if run.depth > MAX_DEPTH {
            return Ok(None);
        }
        run.agent_id
    } else {
        if session_depth(c, session_id)? >= MAX_DEPTH {
            return Ok(None);
        }
        target["agent_id"].as_str().unwrap_or("").to_string()
    };
    Ok(policy.allows_defined(c, &id)?.then_some(policy.needs_approval))
}

fn last_assistant_text(c: &Connection, turn_id: &str) -> ApiResult<Option<String>> {
    let s: Option<String> = c
        .query_row("SELECT content FROM message_history WHERE turn_id = ?1 AND role = 'assistant' ORDER BY seq DESC LIMIT 1", params![turn_id], |r| r.get(0))
        .optional()?;
    Ok(s.and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v["text"].as_str().map(str::to_string)))
}

fn emit(c: &Connection, now: &str, run: &AgentRun) -> ApiResult<()> {
    let pid: String = c.query_row("SELECT project_id FROM sessions WHERE id = ?1", params![run.parent_session_id], |r| r.get(0))?;
    events::append(c, now, "agent_run.changed", Some(&pid), Some(&run.parent_session_id), &serde_json::to_value(run)?)?;
    Ok(())
}

/// 자식 턴 종료 hook(`runner::finish_turn`에서 같은 transaction으로 호출).
pub fn on_turn_finished(c: &Connection, now: &str, turn_id: &str, to: &str) -> ApiResult<()> {
    let Some(run) = c.query_row(&format!("SELECT {COLS} FROM agent_runs WHERE last_turn_id = ?1"), params![turn_id], from_row).optional()? else {
        return Ok(());
    };
    if run.delivered_turn_id.as_deref() == Some(turn_id) {
        return Ok(());
    }
    let status = match to {
        "completed" | "failed" | "cancelled" | "interrupted" => to,
        _ => return Ok(()),
    };
    let text = last_assistant_text(c, turn_id)?;
    let error: Option<String> = c.query_row("SELECT error FROM turns WHERE id = ?1", params![turn_id], |r| r.get(0))?;
    let error = error.filter(|e| e != "null");
    c.execute(
        "UPDATE agent_runs SET status = ?2, result = ?3, error = ?4, delivered_turn_id = ?5, updated_at = ?6, ended_at = ?6 WHERE id = ?1",
        params![run.id, status, text, error, turn_id, now],
    )?;
    let run = get(c, &run.id)?;
    let full = run.result.clone().unwrap_or_default();
    let truncated = full.chars().count() > MAX_RESULT_CHARS;
    let shown: String = full.chars().take(MAX_RESULT_CHARS).collect();
    let content = json!({
        "type": "agent_result",
        "run_id": run.id, "agent_id": run.agent_id, "child_session_id": run.child_session_id, "turn_id": turn_id,
        "status": run.status, "text": shown, "truncated": truncated, "error": run.error,
    });
    crate::sessions::append_message(c, now, &run.parent_session_id, "note", &content, None, None)?;
    emit(c, now, &run)?;
    Ok(())
}

/// note를 모델·사람이 읽을 텍스트로.
pub fn note_text(c: &Value) -> String {
    let mut s = format!(
        "agent run {} ({}) finished with status {}",
        c["run_id"].as_str().unwrap_or(""),
        c["agent_id"].as_str().unwrap_or(""),
        c["status"].as_str().unwrap_or("")
    );
    if let Some(m) = c["error"]["message"].as_str() {
        s.push_str(&format!(" — error: {m}"));
    }
    let t = c["text"].as_str().unwrap_or("");
    if !t.is_empty() {
        s.push_str(&format!("\n[result]\n{t}"));
    }
    if c["truncated"].as_bool() == Some(true) {
        s.push_str("\n(결과 일부만 표시. 전체는 자식 대화에서 확인)");
    }
    s
}

fn tool_err(e: ApiError) -> ToolError {
    let code: &'static str = match e.code {
        "not_found" => "not_found",
        "busy" => "busy",
        "limit" => "limit",
        "delegation_disabled" => "delegation_disabled",
        "approval_revoked" => "approval_revoked",
        "cancelled" => "cancelled",
        "disabled" => "disabled",
        _ => "agent_failed",
    };
    ToolError::new(code, e.message)
}

/// 기본 보조 역할은 재귀 위임이나 Grove 쓰기 도구를 실행하지 않는다.
pub(crate) fn is_helper_session(c: &Connection, session_id: &str) -> ApiResult<bool> {
    let role: Option<String> = c.query_row("SELECT agent_id FROM agent_runs WHERE child_session_id=?1", [session_id], |r| r.get(0)).optional()?;
    Ok(role.is_some_and(|id| crate::definitions::execution("agent", &id)=="helper"))
}

fn role_profile(c: &Connection, session: &crate::sessions::Session, role: &str, fallback: &str) -> ApiResult<crate::models::ModelSelection> {
    let chosen = crate::definitions::profile_key(role)
        .map(|key| crate::settings::effective(c, key, Some(&session.project_id), Some(&session.id))).transpose()?;
    let selection = chosen.as_ref().map(crate::models::ModelSelection::parse).transpose()?.flatten()
        .unwrap_or_else(|| crate::models::ModelSelection::from_profile(fallback.into()));
    crate::models::get_enabled_profile(c, &selection.profile_id)?;
    Ok(selection)
}

/// 새 자식 턴을 실행 상태로 만들기 전 동시 실행 한도(부모별·서버 전체). spawn과 send가 같은 transaction에서 검사한다.
fn check_running_limits(tx: &Connection, parent_session_id: &str) -> ApiResult<()> {
    if running_for_parent(tx, parent_session_id)? >= MAX_PER_PARENT {
        return Err(ApiError::new(axum::http::StatusCode::CONFLICT, "limit", format!("한 대화에서 자식 에이전트는 동시에 {MAX_PER_PARENT}개까지 실행할 수 있습니다")));
    }
    let total: i64 = tx.query_row("SELECT COUNT(*) FROM agent_runs WHERE status = 'running'", [], |r| r.get(0))?;
    if total >= MAX_RUNNING {
        return Err(ApiError::new(axum::http::StatusCode::CONFLICT, "limit", format!("서버 전체 자식 에이전트 동시 실행 한도({MAX_RUNNING})에 도달했습니다")));
    }
    Ok(())
}

/// spawn: 자식 세션·run·첫 턴을 한 transaction에서 만든다.
#[allow(clippy::too_many_arguments)]
fn spawn_in_tx(tx: &Connection, now: &str, epoch: &str, parent_session_id: &str, parent_turn_id: &str, parent_call_id: &str, agent_id: &str, brief: &str) -> ApiResult<AgentRun> {
    let parent = crate::sessions::get_active(tx, parent_session_id)?;
    // 승인 후 실행 claim과 이 transaction 사이의 철회도 새 자식 생성 전에 재검사한다.
    crate::approvals::check_running_execution(tx, parent_call_id)?;
    let depth = session_depth(tx, parent_session_id)? + 1;
    if depth > MAX_DEPTH {
        return Err(ApiError::new(axum::http::StatusCode::CONFLICT, "limit", format!("자식 에이전트는 {MAX_DEPTH}단계까지만 만들 수 있습니다")));
    }
    check_running_limits(tx, parent_session_id)?;
    let def = crate::definitions::resolve(tx, "agent", agent_id)?;
    if !def.def.enabled {
        return Err(ApiError::conflict("disabled", format!("비활성화된 에이전트입니다: {agent_id}")));
    }
    let pt = crate::runner::get_turn(tx, parent_turn_id)?;
    let selection = role_profile(tx, &parent, agent_id, pt.profile_id.as_deref().ok_or_else(|| ApiError::invalid("부모 턴에 모델 프로필이 없습니다"))?)?;
    let profile = &selection.profile_id;
    let child_id = crate::util::new_id();
    let first = brief.lines().next().unwrap_or("").chars().take(50).collect::<String>();
    let title = format!("{}: {}", def.def.name, first);
    tx.execute(
        // 자식 에이전트는 부모 대화와 같은 위치(프로젝트 폴더 또는 같은 worktree)에서 일한다.
        "INSERT INTO sessions (id, project_id, title, created_at, updated_at, worktree_id) VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
        params![child_id, parent.project_id, title, now, parent.worktree_id],
    )?;
    let cs = crate::sessions::get(tx, &child_id)?;
    events::append(tx, now, "session.created", Some(&parent.project_id), Some(&child_id), &serde_json::to_value(&cs)?)?;
    let run_id = crate::util::new_id();
    tx.execute(
        "INSERT INTO agent_runs (id, parent_session_id, parent_turn_id, parent_call_id, child_session_id, agent_id, profile_id, tools_enabled, depth, status, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'running', ?10, ?10)",
        params![run_id, parent_session_id, parent_turn_id, parent_call_id, child_id, agent_id, profile, pt.tools_enabled, depth, now],
    )?;
    let src = json!({ "kind": "agent_run", "run_id": run_id, "parent_session_id": parent_session_id, "parent_turn_id": parent_turn_id,
        "limits":pt.definition["limits"] });
    // 자식은 부모 턴의 소유자를 물려받는다(위임으로 한도를 우회하지 못하게).
    let owner = parent_owner(tx, parent_session_id)?;
    let (t, _) = crate::runner::enqueue_turn(tx, now, epoch, &owner, &child_id, brief, &profile, Some(agent_id), pt.tools_enabled, Some(&src))?;
    crate::runner::set_turn_model(tx, &t.id, selection.model.as_deref())?;
    crate::runner::set_turn_effort(tx, &t.id, selection.effort.as_deref())?;
    tx.execute("UPDATE agent_runs SET last_turn_id = ?2 WHERE id = ?1", params![run_id, t.id])?;
    let run = get(tx, &run_id)?;
    emit(tx, now, &run)?;
    Ok(run)
}

/// send: 끝난 run에 후속 지시. 실행 중이면 거부(이중 실행 금지).
fn send_in_tx(tx: &Connection, now: &str, epoch: &str, run_id: &str, brief: &str, parent_turn_id: Option<&str>, parent_call_id: &str) -> ApiResult<AgentRun> {
    let run = get(tx, run_id)?;
    crate::approvals::check_running_execution(tx, parent_call_id)?;
    if run.status == "running" {
        return Err(ApiError::busy("자식 작업이 아직 실행 중입니다. wait로 기다리거나 cancel 후 다시 지시하세요"));
    }
    check_running_limits(tx, &run.parent_session_id)?;
    let parent = crate::sessions::get_active(tx, &run.parent_session_id)?;
    let parent_turn = parent_turn_id.map(|id| crate::runner::get_turn(tx,id)).transpose()?;
    let fallback = parent_turn.as_ref().and_then(|t| t.profile_id.clone()).unwrap_or_else(||run.profile_id.clone());
    let selection = role_profile(tx, &parent, &run.agent_id, &fallback)?;
    let profile = &selection.profile_id;
    let limits = parent_turn.as_ref().map(|t| &t.definition["limits"]).filter(|v| v.is_object());
    let src = json!({ "kind": "agent_run", "run_id": run.id, "parent_session_id": run.parent_session_id, "parent_turn_id": parent_turn_id,
        "limits":limits });
    let owner = parent_owner(tx, &run.parent_session_id)?;
    let tools = run.tools_enabled && parent_turn.as_ref().is_none_or(|t| !t.definition["limits"].is_object() || t.tools_enabled);
    let (t, _) = crate::runner::enqueue_turn(tx, now, epoch, &owner, &run.child_session_id, brief, &profile, Some(&run.agent_id), tools, Some(&src))?;
    crate::runner::set_turn_model(tx, &t.id, selection.model.as_deref())?;
    crate::runner::set_turn_effort(tx, &t.id, selection.effort.as_deref())?;
    tx.execute(
        "UPDATE agent_runs SET status = 'running', last_turn_id = ?2, result = NULL, error = NULL, ended_at = NULL, updated_at = ?3, \
         parent_turn_id=?4, parent_call_id=?5, profile_id=?6 WHERE id = ?1",
        params![run_id, t.id, now, parent_turn_id, parent_call_id, profile],
    )?;
    let run = get(tx, run_id)?;
    emit(tx, now, &run)?;
    Ok(run)
}

/// 진행 단계(SESSION-012): accepted(접수됨, 실행 차례 대기) · running(실행 중) · awaiting_approval(사용자 승인 대기)
/// · awaiting_input(사용자 답변 대기) · done(끝남).
pub fn phase(run: &AgentRun) -> &'static str {
    if run.status != "running" {
        return "done";
    }
    match run.turn_status.as_deref() {
        Some("queued") | None => "accepted",
        Some("awaiting_approval") => "awaiting_approval",
        Some("awaiting_input") => "awaiting_input",
        _ => "running",
    }
}

fn summary(run: &AgentRun) -> Value {
    let phase = phase(run);
    json!({
        "run_id": run.id, "agent_id": run.agent_id, "status": run.status, "phase": phase, "child_session_id": run.child_session_id,
        "depth": run.depth, "result": run.result, "error": run.error,
        "note": match (run.status.as_str(), phase) {
            (_, "accepted") => "접수만 되었고 아직 시작하지 않았습니다. 완료로 보고하지 마세요.",
            (_, "awaiting_approval") => "사용자 승인을 기다리는 중입니다. 완료로 보고하지 마세요.",
            (_, "awaiting_input") => "자식 대화의 질문에 사용자 답변을 기다리는 중입니다. 완료로 보고하지 마세요.",
            ("running", _) => "아직 실행 중입니다. 완료로 보고하지 마세요.",
            ("completed", _) => "완료되었습니다.",
            _ => "완료되지 않았습니다(실패·취소·중단).",
        }
    })
}

/// 실행 중이 아니게 될 때까지 기다린다. 이벤트 seq 변화에만 깨어나므로 busy polling이 없다.
async fn wait_run(app: &App, run_id: &str, timeout: Duration, cancel: &mut watch::Receiver<bool>) -> ApiResult<(AgentRun, bool)> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut seq = app.seq_tx.subscribe();
    loop {
        let id = run_id.to_string();
        let run = app.db.call(move |c| get(c, &id)).await?;
        if run.status != "running" {
            return Ok((run, false));
        }
        tokio::select! {
            r = seq.changed() => if r.is_err() { return Ok((run, true)) },
            _ = tokio::time::sleep_until(deadline) => return Ok((run, true)),
            _ = async { let _ = cancel.wait_for(|c| *c).await; } => return Err(ApiError::new(axum::http::StatusCode::CONFLICT, "cancelled", "대기가 취소되었습니다")),
        }
    }
}

/// run의 진행 중 턴을 취소한다(재귀 cascade 포함).
pub async fn cancel_run(app: &App, run: &AgentRun) {
    if run.status != "running" {
        return;
    }
    if let Some(t) = &run.last_turn_id {
        let _ = Box::pin(crate::runner::cancel_turn(app, t, crate::runner::CancelCause::ParentCancelled)).await;
    }
}

/// 부모 턴이 취소되면 그 턴이 띄운 실행 중 자식도 취소한다(AGENT-008).
pub async fn cascade_cancel(app: &App, parent_turn_id: &str) {
    let tid = parent_turn_id.to_string();
    let runs: Vec<AgentRun> = app
        .db
        .call(move |c| {
            let mut st = c.prepare(&format!("SELECT {COLS} FROM agent_runs WHERE parent_turn_id = ?1 AND status = 'running'"))?;
            let v = st.query_map(params![tid], from_row)?.collect::<Result<_, _>>()?;
            Ok(v)
        })
        .await
        .unwrap_or_default();
    for r in runs {
        cancel_run(app, &r).await;
    }
}

/// agent 도구 실행(approvals::spawn_execute에서 호출).
pub async fn execute_tool(app: &App, call: &crate::approvals::ToolCallRow, mut cancel: watch::Receiver<bool>) -> Result<Value, ToolError> {
    let t = &call.target;
    let action = t["action"].as_str().unwrap_or("");
    let owned = |run: &AgentRun| -> Result<(), ToolError> {
        if run.parent_session_id != call.session_id {
            return Err(ToolError::new("not_found", "이 대화가 만든 자식 작업이 아닙니다"));
        }
        Ok(())
    };
    let get_run = |id: String| async move { app.db.call(move |c| get(c, &id)).await.map_err(tool_err) };
    match action {
        "spawn" => {
            let parent_turn = call.turn_id.clone().ok_or_else(|| ToolError::new("invalid_context", "자식 에이전트는 모델 턴 안에서만 만들 수 있습니다"))?;
            let (sid, cid, aid, brief, epoch) =
                (call.session_id.clone(), call.id.clone(), t["agent_id"].as_str().unwrap_or("").to_string(), t["brief"].as_str().unwrap_or("").to_string(), app.epoch.clone());
            let now = app.now();
            let run = app
                .db
                .call(move |c| {
                    let tx = c.transaction()?;
                    let r = spawn_in_tx(&tx, &now, &epoch, &sid, &parent_turn, &cid, &aid, &brief)?;
                    tx.commit()?;
                    Ok(r)
                })
                .await
                .map_err(tool_err)?;
            app.notify_events().await;
            crate::runner::kick_queued(app).await;
            Ok(summary(&run))
        }
        "send" => {
            let run = get_run(t["run_id"].as_str().unwrap_or("").to_string()).await?;
            owned(&run)?;
            let (rid, brief, epoch, now) = (run.id.clone(), t["brief"].as_str().unwrap_or("").to_string(), app.epoch.clone(), app.now());
            let (parent_turn, parent_call) = (call.turn_id.clone(), call.id.clone());
            let run = app
                .db
                .call(move |c| {
                    let tx = c.transaction()?;
                    let r = send_in_tx(&tx, &now, &epoch, &rid, &brief, parent_turn.as_deref(), &parent_call)?;
                    tx.commit()?;
                    Ok(r)
                })
                .await
                .map_err(tool_err)?;
            app.notify_events().await;
            crate::runner::kick_queued(app).await;
            Ok(summary(&run))
        }
        "status" => {
            let run = get_run(t["run_id"].as_str().unwrap_or("").to_string()).await?;
            owned(&run)?;
            Ok(summary(&run))
        }
        "list" => {
            let sid = call.session_id.clone();
            let runs = app.db.call(move |c| list_for_parent(c, &sid)).await.map_err(tool_err)?;
            Ok(json!({ "runs": runs.iter().map(summary).collect::<Vec<_>>() }))
        }
        "wait" => {
            let run = get_run(t["run_id"].as_str().unwrap_or("").to_string()).await?;
            owned(&run)?;
            // Native MCP still owns a model slot. The runner waits for owned children after
            // releasing that slot, so this call returns the current state immediately.
            let native_bridge = call.provider_call_id.as_deref().is_some_and(|id| id.starts_with("continuation-cli:"));
            let timeout = if native_bridge { Duration::ZERO } else {
                Duration::from_millis(t["timeout_ms"].as_u64().unwrap_or(60_000).min(600_000))
            };
            let (run, timed_out) = wait_run(app, &run.id, timeout, &mut cancel).await.map_err(|e| ToolError::new("cancelled", e.message))?;
            let mut v = summary(&run);
            v["wait_timed_out"] = json!(timed_out);
            Ok(v)
        }
        "cancel" => {
            let run = get_run(t["run_id"].as_str().unwrap_or("").to_string()).await?;
            owned(&run)?;
            cancel_run(app, &run).await;
            let run = get_run(run.id.clone()).await?;
            Ok(summary(&run))
        }
        _ => Err(ToolError::new("invalid_arguments", "알 수 없는 action")),
    }
}

// ---------------- API ----------------

pub async fn list(State(app): State<App>, _p: Principal, Path(session_id): Path<String>) -> ApiResult<Json<Value>> {
    let v = app
        .db
        .call(move |c| {
            crate::sessions::get(c, &session_id)?;
            Ok(json!({ "runs": list_for_parent(c, &session_id)?, "parent": run_by_child(c, &session_id)? }))
        })
        .await?;
    Ok(Json(v))
}

pub async fn show(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<AgentRun>> {
    Ok(Json(app.db.call(move |c| get(c, &id)).await?))
}

/// 사용자가 자식 작업을 취소한다.
pub async fn cancel(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<AgentRun>> {
    let i = id.clone();
    let run = app.db.call(move |c| get(c, &i)).await?;
    cancel_run(&app, &run).await;
    Ok(Json(app.db.call(move |c| get(c, &id)).await?))
}

/// 부모 대화의 가장 최근 턴 소유자(FAIR-002). 없으면 소유자 기본값.
fn parent_owner(tx: &rusqlite::Connection, parent_session_id: &str) -> ApiResult<String> {
    Ok(tx
        .query_row("SELECT owner_key FROM turns WHERE session_id = ?1 ORDER BY created_at DESC LIMIT 1", rusqlite::params![parent_session_id], |r| r.get(0))
        .optional()?
        .unwrap_or_else(|| "owner".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(status: &str, turn: Option<&str>) -> AgentRun {
        AgentRun {
            id: "r".into(),
            parent_session_id: "p".into(),
            parent_turn_id: None,
            parent_call_id: None,
            child_session_id: "c".into(),
            agent_id: "a".into(),
            profile_id: "m".into(),
            tools_enabled: false,
            depth: 1,
            status: status.into(),
            last_turn_id: Some("t".into()),
            delivered_turn_id: None,
            result: None,
            error: None,
            created_at: String::new(),
            updated_at: String::new(),
            ended_at: None,
            turn_status: turn.map(String::from),
        }
    }

    /// SESSION-012: 접수·실행·승인 대기·완료를 구분하고, 끝나지 않은 단계는 완료로 보고하지 않게 안내한다.
    #[test]
    fn phase_distinguishes_accepted_running_waiting_and_done() {
        assert_eq!(phase(&run("running", Some("queued"))), "accepted");
        assert_eq!(phase(&run("running", None)), "accepted");
        assert_eq!(phase(&run("running", Some("running"))), "running");
        assert_eq!(phase(&run("running", Some("awaiting_approval"))), "awaiting_approval");
        assert_eq!(phase(&run("running", Some("awaiting_input"))), "awaiting_input");
        assert_eq!(phase(&run("completed", Some("completed"))), "done");
        assert_eq!(phase(&run("failed", Some("failed"))), "done");
        for (s, t) in [("running", "queued"), ("running", "running"), ("running", "awaiting_approval"), ("running", "awaiting_input")] {
            assert!(summary(&run(s, Some(t)))["note"].as_str().unwrap().contains("완료로 보고하지 마세요"), "{s}/{t}");
        }
        assert_eq!(summary(&run("completed", Some("completed")))["note"], "완료되었습니다.");
    }

    fn database() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        for migration in crate::store::MIGRATIONS {
            c.execute_batch(migration).unwrap();
        }
        c.execute("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES('p','agents','/fixture','t','t')", []).unwrap();
        c
    }

    fn insert_run(c: &Connection, id: &str, parent: &str, status: &str, created_at: &str) {
        for sid in [parent, id] {
            c.execute("INSERT OR IGNORE INTO sessions(id,project_id,title,created_at,updated_at) VALUES(?1,'p',?1,'t','t')", [sid]).unwrap();
        }
        c.execute(
            "INSERT INTO agent_runs(id,parent_session_id,child_session_id,agent_id,profile_id,tools_enabled,depth,status,created_at,updated_at) \
             VALUES(?1,?2,?1,'reviewer','prof',1,1,?3,?4,?4)",
            params![id, parent, status, created_at],
        ).unwrap();
    }

    /// AGENT-007: 후속 지시(send)도 spawn과 같은 한도 검사를 거친다. 다른 부모의 실행으로 서버 전체 한도가 차면 부모별 여유가 있어도 거절한다.
    #[test]
    fn running_limits_count_whole_server_not_only_parent() {
        let c = database();
        check_running_limits(&c, "idle").unwrap();
        for i in 0..MAX_RUNNING {
            insert_run(&c, &format!("busy-{i}"), &format!("parent-{}", i / MAX_PER_PARENT), "running", "t");
        }
        let err = check_running_limits(&c, "idle").unwrap_err();
        assert_eq!(err.code, "limit");
        assert!(err.message.contains(&MAX_RUNNING.to_string()), "{}", err.message);
    }

    /// 진행 중 자식은 종료 이력이 많아도 부모 목록에서 빠지지 않는다(확인·취소 가능).
    #[test]
    fn parent_list_keeps_running_runs_beyond_recent_history() {
        let c = database();
        insert_run(&c, "old-running", "parent", "running", "2026-01-01T00:00:00Z");
        for i in 0..100 {
            insert_run(&c, &format!("done-{i:03}"), "parent", "completed", &format!("2026-01-02T00:00:{:02}.{i:03}Z", i % 60));
        }
        let list = list_for_parent(&c, "parent").unwrap();
        assert_eq!(list.len(), 100);
        assert_eq!(list[0].id, "old-running");
    }
}
