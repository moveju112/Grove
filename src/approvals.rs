//! 도구 호출의 영속 승인·실행 receipt·결과 불명 검토(RUN, SEC-008, DB-009, RUN-018).
//!
//! 상태 전이:
//!   pending_approval → approved → running → succeeded | failed | cancelled
//!   pending_approval → denied | expired | cancelled
//!   running --(서버 비정상 종료)--> unknown --(사용자 검토 기록)--> unknown + reviewed_at
//! `running`은 부작용 시작 전에 commit한다. 따라서 crash 후 `running`이면 결과를 알 수 없다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::idem;
use crate::tools::{self, Planned};
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::task::JoinHandle;

pub const TERMINAL: &[&str] = &["succeeded", "failed", "denied", "expired", "cancelled", "unknown"];

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct ToolCallRow {
    pub id: String,
    pub session_id: String,
    pub project_id: String,
    pub turn_id: Option<String>,
    pub provider_call_id: Option<String>,
    pub name: String,
    #[ts(type = "unknown")]
    pub args: Value,
    #[ts(type = "unknown")]
    pub target: Value,
    pub status: String,
    pub needs_approval: bool,
    pub revision: i64,
    #[ts(type = "unknown")]
    pub result: Value,
    pub expires_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub decided_at: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub reviewed_at: Option<String>,
    #[ts(type = "unknown")]
    pub review: Value,
    #[serde(skip)]
    pub precondition: Option<Value>,
    /// 실행을 허락한 범위: once(이번만) | session(이 대화에서 계속) | policy(tools.allow) | null(승인 불필요·미결정)
    pub approval_scope: Option<String>,
}

const COLS: &str = "id, session_id, project_id, turn_id, provider_call_id, name, args, target, status, needs_approval, revision, result, \
    expires_at, created_at, updated_at, decided_at, started_at, finished_at, reviewed_at, review, precondition, approval_scope";

fn row(r: &Row) -> rusqlite::Result<ToolCallRow> {
    let j = |i: usize| -> rusqlite::Result<Value> {
        let s: Option<String> = r.get(i)?;
        Ok(s.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null))
    };
    Ok(ToolCallRow {
        id: r.get(0)?,
        session_id: r.get(1)?,
        project_id: r.get(2)?,
        turn_id: r.get(3)?,
        provider_call_id: r.get(4)?,
        name: r.get(5)?,
        args: j(6)?,
        target: j(7)?,
        status: r.get(8)?,
        needs_approval: r.get(9)?,
        revision: r.get(10)?,
        result: j(11)?,
        expires_at: r.get(12)?,
        created_at: r.get(13)?,
        updated_at: r.get(14)?,
        decided_at: r.get(15)?,
        started_at: r.get(16)?,
        finished_at: r.get(17)?,
        reviewed_at: r.get(18)?,
        review: j(19)?,
        precondition: {
            let v = j(20)?;
            if v.is_null() { None } else { Some(v) }
        },
        approval_scope: r.get(21)?,
    })
}

pub fn get(c: &Connection, id: &str) -> ApiResult<ToolCallRow> {
    c.query_row(&format!("SELECT {COLS} FROM tool_calls WHERE id = ?1"), params![id], row)
        .optional()?
        .ok_or_else(|| ApiError::not_found("도구 호출이 없습니다"))
}

pub fn list_for_turn(c: &Connection, turn_id: &str) -> ApiResult<Vec<ToolCallRow>> {
    let mut st = c.prepare(&format!("SELECT {COLS} FROM tool_calls WHERE turn_id = ?1 ORDER BY created_at, id"))?;
    let v = st.query_map(params![turn_id], row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(v)
}

fn emit(c: &Connection, now: &str, call: &ToolCallRow) -> ApiResult<()> {
    events::append(c, now, "tool_call.updated", Some(&call.project_id), Some(&call.session_id), &serde_json::to_value(call)?)?;
    Ok(())
}

/// 승인 만료 시간: 서버 설정이 있으면 그 값, 없으면 실행 설정(환경변수) 기본값.
pub fn approval_ttl(c: &Connection, fallback: i64) -> ApiResult<i64> {
    let v = crate::settings::effective(c, "approval.ttl_secs", None, None)?;
    let configured = c
        .query_row("SELECT value FROM settings WHERE scope = 'server' AND key = 'approval.ttl_secs' AND value IS NOT NULL", [], |r| r.get::<_, String>(0))
        .optional()?;
    Ok(if configured.is_some() { v.as_i64().unwrap_or(fallback) } else { fallback })
}

/// 이 대화에서 계속 허용한 도구 목록(SEC-009).
pub async fn list_grants(State(app): State<App>, _p: Principal, Path(sid): Path<String>) -> ApiResult<Json<Value>> {
    let v = app
        .db
        .call(move |c| {
            let mut st = c.prepare("SELECT tool, granted_at FROM session_tool_grants WHERE session_id = ?1 ORDER BY tool")?;
            let rows = st
                .query_map(params![sid], |r| Ok(json!({ "tool": r.get::<_, String>(0)?, "granted_at": r.get::<_, String>(1)? })))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(json!({ "items": rows }))
        })
        .await?;
    Ok(Json(v))
}

/// 대화 범위 허용 해제. 다음 호출부터 다시 승인을 묻는다(멱등).
pub async fn revoke_grant(State(app): State<App>, p: Principal, Path((sid, tool)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let now = app.now();
    let v = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let project: Option<String> = tx.query_row("SELECT project_id FROM sessions WHERE id = ?1", params![sid], |r| r.get(0)).optional()?;
            let project = project.ok_or_else(|| ApiError::not_found("대화가 없습니다"))?;
            let n = tx.execute("DELETE FROM session_tool_grants WHERE session_id = ?1 AND tool = ?2", params![sid, tool])?;
            if n > 0 {
                events::append(&tx, &now, "tool_grant.changed", Some(&project), Some(&sid), &json!({ "tool": tool, "granted": false }))?;
                crate::audit::record(&tx, &now, &p, "tool_grant.revoked", &format!("{sid}:{tool}"), json!({}))?;
            }
            tx.commit()?;
            Ok(json!({ "revoked": n > 0 }))
        })
        .await?;
    app.notify_events().await;
    Ok(Json(v))
}

#[derive(Debug, PartialEq)]
pub enum PolicyDecision {
    Deny(&'static str, String),
    Allow,
    Default,
}

/// 도구 정책(SEC-006, 007). 우선순위: deny(어느 범위든) > read_only(어느 범위든) > allow(server·project) > 기본.
/// 계획 단계에서 확정된 정식 도구 이름(spec.name)으로 판단하므로 별칭·재시도·승인 후 실행에도 같은 결과다.
pub fn tool_policy(c: &Connection, project_id: &str, session_id: &str, spec: &tools::ToolSpec) -> ApiResult<PolicyDecision> {
    use crate::settings::{all_layers, tool_names};
    let (p, s) = (Some(project_id), Some(session_id));
    let listed = |key: &str| -> ApiResult<bool> {
        Ok(all_layers(c, key, p, s)?.iter().any(|v| v.as_str().is_some_and(|x| tool_names(x).any(|n| n == spec.name))))
    };
    if listed("tools.deny")? {
        return Ok(PolicyDecision::Deny("policy_denied", format!("도구 정책(tools.deny)으로 {}을(를) 쓸 수 없습니다", spec.name)));
    }
    let read_only = all_layers(c, "tools.mode", p, s)?.iter().any(|v| v == "read_only");
    if read_only && !matches!(spec.effect, tools::Effect::Read | tools::Effect::Conversation) {
        return Ok(PolicyDecision::Deny("read_only", format!("읽기 전용 모드(tools.mode=read_only)라 {}을(를) 실행할 수 없습니다", spec.name)));
    }
    if listed("tools.allow")? {
        return Ok(PolicyDecision::Allow);
    }
    Ok(PolicyDecision::Default)
}

/// 새 호출을 계획·기록한다. 계획 실패(잘못된 인자·경계 위반·미지원 도구)는 실행 없이 failed로 남긴다.
#[allow(clippy::too_many_arguments)]
pub fn create_call(
    c: &Connection,
    now: &str,
    ttl_secs: i64,
    session_id: &str,
    project_id: &str,
    root: &std::path::Path,
    turn_id: Option<&str>,
    provider_call_id: Option<&str>,
    name: &str,
    args: &Value,
) -> ApiResult<ToolCallRow> {
    let id = crate::util::new_id();
    let mut scope: Option<&str> = None;
    let (status, needs, target, pre, result) = match tools::plan(name, args, root) {
        Ok((spec, mut planned)) => {
            // 셸은 범위별 설정으로 정해 승인 대상에 고정한다. 승인 후 설정이 바뀌어도 승인한 셸로 실행한다(EXEC-001).
            if spec.name == "shell" {
                let choice = crate::settings::effective(c, "exec.shell", Some(project_id), Some(session_id))?;
                planned.target["shell"] = json!(tools::shell::resolve_shell(choice.as_str().unwrap_or("default")));
            }
            // agent 도구는 동작과 위임 정책으로 승인 여부를 정한다. None이면 정책상 금지.
            let base = if spec.name == "agent" {
                crate::agents::approval_policy(c, project_id, session_id, &planned.target)?
            } else {
                Some(tools::needs_approval(spec.effect))
            };
            let policy = tool_policy(c, project_id, session_id, &spec)?;
            // 이 대화에서 계속 허용한 도구(SEC-009). 금지·읽기 전용이 먼저이고, 위임(agent)에는 쓰지 않는다.
            let granted = spec.name != "agent"
                && c.query_row("SELECT 1 FROM session_tool_grants WHERE session_id = ?1 AND tool = ?2", params![session_id, spec.name], |_| Ok(()))
                    .optional()?
                    .is_some();
            let decision = match (&policy, base) {
                (PolicyDecision::Deny(..), _) => None,
                (PolicyDecision::Allow, Some(true)) => {
                    scope = Some("policy");
                    Some(false)
                }
                (_, Some(true)) if granted => {
                    scope = Some("session");
                    Some(false)
                }
                (_, b) => b,
            };
            match decision {
                // 질문은 실행하지 않고 사용자 답을 기다린다(승인 대기와 다른 상태, RUN-014).
                Some(_) if spec.name == "ask_user" => ("awaiting_input", false, planned.target, None, None),
                Some(needs) => (if needs { "pending_approval" } else { "approved" }, needs, planned.target, planned.precondition, None),
                None if matches!(policy, PolicyDecision::Deny(..)) => {
                    let PolicyDecision::Deny(code, msg) = policy else { unreachable!() };
                    ("failed", false, planned.target, None, Some(tools::ToolError::new(code, msg).to_json()))
                }
                None => (
                    "failed",
                    false,
                    planned.target,
                    None,
                    Some(tools::ToolError::new("delegation_disabled", "위임 정책(agents.delegation=off)으로 자식 에이전트를 쓸 수 없습니다").to_json()),
                ),
            }
        }
        Err(e) => ("failed", false, json!({}), None, Some(e.to_json())),
    };
    let expires = needs.then(|| {
        let t = crate::util::parse_time(now).unwrap_or_else(time::OffsetDateTime::now_utc) + time::Duration::seconds(ttl_secs);
        crate::util::fmt_time(t)
    });
    c.execute(
        "INSERT INTO tool_calls (id, session_id, project_id, turn_id, provider_call_id, name, args, target, status, needs_approval, precondition, result, expires_at, created_at, updated_at, finished_at, approval_scope) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, ?15, ?16)",
        params![
            id, session_id, project_id, turn_id, provider_call_id, name, args.to_string(), target.to_string(), status, needs,
            pre.map(|p| p.to_string()), result.as_ref().map(|r| r.to_string()), expires, now,
            (status == "failed").then_some(now), scope
        ],
    )?;
    let call = get(c, &id)?;
    if status == "failed" {
        append_tool_message(c, now, &call)?;
    }
    emit(c, now, &call)?;
    Ok(call)
}

/// 턴에 속한 호출이 종료 상태가 되면 같은 transaction에서 tool 메시지를 기록한다(모델 입력의 근거).
fn append_tool_message(c: &Connection, now: &str, call: &ToolCallRow) -> ApiResult<()> {
    if call.turn_id.is_none() {
        return Ok(());
    }
    let is_error = call.status != "succeeded";
    let output = match call.status.as_str() {
        "succeeded" => call.result.clone(),
        "denied" => json!({ "error": { "code": "denied", "message": "사용자가 이 도구 실행을 거부했습니다" } }),
        "expired" => json!({ "error": { "code": "expired", "message": "승인 대기 시간이 지나 실행하지 않았습니다" } }),
        _ => call.result.clone(),
    };
    let content = json!({
        "call_id": call.id, "provider_call_id": call.provider_call_id, "name": call.name,
        "status": call.status, "is_error": is_error, "output": output,
        // 표시용(모델 입력에는 output·is_error만 쓴다): 승인 범위·인자 요약·소요 시간·잘림(UI-014)
        "approval_scope": call.approval_scope,
        "args": args_preview(&call.args),
        "duration_ms": duration_ms(call.started_at.as_deref(), call.finished_at.as_deref()),
        "truncated": output_truncated(&output),
    });
    crate::sessions::append_message(c, now, &call.session_id, "tool", &content, call.turn_id.as_deref(), None)?;
    Ok(())
}

/// 표시용 인자 요약: 긴 문자열 값(파일 내용 등)은 앞부분만.
fn args_preview(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), args_preview(x))).collect()),
        Value::Array(a) => Value::Array(a.iter().take(20).map(args_preview).collect()),
        Value::String(s) if s.chars().count() > 300 => json!(format!("{}… ({}자)", s.chars().take(300).collect::<String>(), s.chars().count())),
        other => other.clone(),
    }
}

fn duration_ms(start: Option<&str>, end: Option<&str>) -> Option<i64> {
    let (s, e) = (crate::util::parse_time(start?)?, crate::util::parse_time(end?)?);
    Some(((e - s).whole_milliseconds() as i64).max(0))
}

/// 도구 결과가 잘렸는지(출력 한도·줄 상한·배치 한도).
fn output_truncated(v: &Value) -> bool {
    v["truncated"] == true || !v["limit_clamped"].is_null() || v["files"].as_array().is_some_and(|f| f.iter().any(|x| x["truncated"] == true || !x["skipped"].is_null()))
}

/// 종료 상태로 전이(조건부). 이미 다른 상태면 false.
pub fn finish(c: &Connection, now: &str, id: &str, from: &[&str], to: &str, result: Option<Value>) -> ApiResult<Option<ToolCallRow>> {
    let placeholders = from.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(",");
    let n = c.execute(
        &format!(
            "UPDATE tool_calls SET status = ?2, result = COALESCE(?3, result), updated_at = ?4, finished_at = ?4, revision = revision + 1 \
             WHERE id = ?1 AND status IN ({placeholders})"
        ),
        params![id, to, result.map(|r| r.to_string()), now],
    )?;
    if n == 0 {
        return Ok(None);
    }
    let call = get(c, id)?;
    append_tool_message(c, now, &call)?;
    emit(c, now, &call)?;
    Ok(Some(call))
}

/// 승인된 호출을 실행한다. running receipt를 먼저 commit하고 결과를 기록한다.
pub fn spawn_execute(app: &App, call_id: String) -> JoinHandle<()> {
    let app = app.clone();
    tokio::spawn(async move {
        let id = call_id.clone();
        let started = app
            .db
            .call(move |c| {
                let tx = c.transaction()?;
                let now = crate::util::fmt_time(time::OffsetDateTime::now_utc());
                let n = tx.execute(
                    "UPDATE tool_calls SET status = 'running', started_at = ?2, updated_at = ?2, revision = revision + 1 WHERE id = ?1 AND status = 'approved'",
                    params![id, now],
                )?;
                if n == 0 {
                    return Ok(None);
                }
                let call = get(&tx, &id)?;
                let root = crate::projects::active_root(&tx, &call.project_id);
                emit(&tx, &now, &call)?;
                tx.commit()?;
                Ok(Some((call, root)))
            })
            .await;
        app.notify_events().await;
        let Ok(Some((call, root))) = started else { return };
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        app.cancels.register(&call.id, cancel_tx);
        if let Some(t) = &call.turn_id {
            // 턴이 이미 취소 요청되었으면 도구도 즉시 취소 신호를 받는다.
            if app.cancels.is_cancelled(t) {
                app.cancels.cancel(&call.id);
            }
        }
        let outcome = match root {
            Err(e) => Err(tools::ToolError::new("project_unavailable", e.message)),
            Ok(_) if call.name == "agent" => crate::agents::execute_tool(&app, &call, cancel_rx).await,
            Ok(_) if call.name == "goal" => {
                let (sid, args, now) = (call.session_id.clone(), call.target.clone(), app.now());
                app.db
                    .call(move |c| {
                        let tx = c.transaction()?;
                        let v = crate::goals::execute_tool(&tx, &now, &sid, &args)?;
                        tx.commit()?;
                        Ok(v)
                    })
                    .await
                    .map_err(|e| tools::ToolError::new(if e.code == "not_found" { "not_found" } else { "invalid_arguments" }, e.message))
            }
            // hold_ms가 있는 셸은 백그라운드 작업으로 실행한다(EXEC-004).
            Ok(_) if call.name == "shell" && call.target.get("hold_ms").is_some() => {
                let s = crate::tasks::Spawn {
                    session_id: call.session_id.clone(),
                    call_id: Some(call.id.clone()),
                    shell: call.target["shell"].as_str().unwrap_or("default").to_string(),
                    command: call.target["command"].as_str().unwrap_or("").to_string(),
                    cwd_rel: call.target["cwd"].as_str().unwrap_or(".").to_string(),
                    timeout_ms: call.target["timeout_ms"].as_u64().unwrap_or(tools::shell::MAX_BACKGROUND_TIMEOUT_MS),
                    detached: false,
                };
                crate::tasks::run_with_hold(&app, s, call.target["hold_ms"].as_u64().unwrap_or(0), cancel_rx).await
            }
            Ok(root) => {
                let planned = Planned { target: call.target.clone(), precondition: call.precondition.clone() };
                tools::execute(&call.name, &call.args, &planned, &root, cancel_rx).await
            }
        };
        app.cancels.remove(&call.id);
        let id = call.id.clone();
        let turn = call.turn_id.clone();
        let _ = app
            .db
            .call(move |c| {
                let tx = c.transaction()?;
                let now = crate::util::fmt_time(time::OffsetDateTime::now_utc());
                let (to, result) = match outcome {
                    Ok(v) => ("succeeded", v),
                    Err(e) if e.code == "cancelled" => ("cancelled", e.to_json()),
                    Err(e) => ("failed", e.to_json()),
                };
                finish(&tx, &now, &id, &["running"], to, Some(result))?;
                tx.commit()?;
                Ok(())
            })
            .await;
        app.notify_events().await;
        if let Some(t) = turn {
            crate::runner::maybe_resume(&app, &t).await;
        }
    })
}

// ---------------- API ----------------

#[derive(Deserialize)]
pub struct CreateRequest {
    pub name: String,
    pub args: Value,
}

/// 사용자가 직접 만드는 도구 요청(모델 없이). 읽기 전용은 즉시 실행, 부작용 도구는 승인 대기.
pub async fn create_request(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(b): Json<CreateRequest>,
) -> ApiResult<Response> {
    let h = idem::body_hash("tool.request", &json!({ "s": session_id, "n": b.name, "a": b.args }));
    let ttl = app.cfg.approval_ttl_secs;
    let resp = idem::run(&app, &p, &headers, &h, move |tx, now| {
        let s = crate::sessions::get_active(tx, &session_id)?;
        let root = crate::projects::active_root(tx, &s.project_id)?;
        let ttl = approval_ttl(tx, ttl)?;
        let call = create_call(tx, now, ttl, &session_id, &s.project_id, &root, None, None, &b.name, &b.args)?;
        Ok((StatusCode::CREATED, serde_json::to_value(call)?))
    })
    .await?;
    // 즉시 실행할 수 있는 호출(approved)을 실행한다. 재전송(replay)이면 spawn_execute가 조건부 전이로 무시한다.
    kick_approved(&app).await;
    Ok(resp)
}

/// approved 상태로 남은 호출을 실행한다(턴 밖 요청 포함).
pub async fn kick_approved(app: &App) {
    let ids: Vec<String> = app
        .db
        .call(|c| {
            let mut st = c.prepare("SELECT id FROM tool_calls WHERE status = 'approved' ORDER BY created_at")?;
            let v = st.query_map([], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            Ok(v)
        })
        .await
        .unwrap_or_default();
    for id in ids {
        spawn_execute(app, id);
    }
}

pub async fn show(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<ToolCallRow>> {
    Ok(Json(app.db.call(move |c| get(c, &id)).await?))
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub session_id: Option<String>,
    pub status: Option<String>,
    pub limit: Option<i64>,
}

pub async fn list(State(app): State<App>, _p: Principal, Query(q): Query<ListQuery>) -> ApiResult<Json<Vec<ToolCallRow>>> {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    Ok(Json(
        app.db
            .call(move |c| {
                let mut st = c.prepare(&format!(
                    "SELECT {COLS} FROM tool_calls WHERE (?1 IS NULL OR session_id = ?1) AND (?2 IS NULL OR status = ?2) ORDER BY created_at DESC, id DESC LIMIT ?3"
                ))?;
                let v = st.query_map(params![q.session_id, q.status, limit], row)?.collect::<Result<Vec<_>, _>>()?;
                Ok(v)
            })
            .await?,
    ))
}

#[derive(Deserialize)]
pub struct Decision {
    pub decision: String,
    pub expected_revision: i64,
}

/// 승인/거부(FLOW-03). 승인은 화면에 보인 revision(=대상)과 결합된다.
pub async fn decide(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<Decision>,
) -> ApiResult<Response> {
    if !matches!(b.decision.as_str(), "approve" | "approve_session" | "deny") {
        return Err(ApiError::invalid("decision은 approve, approve_session 또는 deny여야 합니다"));
    }
    let approving = b.decision != "deny";
    let actor = p.clone();
    let h = idem::body_hash("tool.decide", &json!({ "id": id, "d": b.decision, "r": b.expected_revision }));
    let call_id = id.clone();
    let resp = idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get(tx, &id)?;
        if cur.status != "pending_approval" {
            return Err(ApiError::conflict("already_decided", format!("이미 처리된 요청입니다({})", cur.status))
                .with_details(json!({ "current": serde_json::to_value(&cur)? })));
        }
        if cur.revision != b.expected_revision {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        if cur.expires_at.as_deref().is_some_and(|e| e <= now) {
            let c = finish(tx, now, &id, &["pending_approval"], "expired", None)?;
            return Ok((StatusCode::CONFLICT, json!({ "error": { "code": "expired", "message": "승인 시간이 지났습니다", "retryable": false }, "call": c })));
        }
        // 승인 대기 중에 정책이 바뀌었으면(금지·읽기 전용) 승인해도 실행하지 않는다(SEC-007).
        if b.decision == "approve_session" && cur.name == "agent" {
            return Err(ApiError::invalid("자식 에이전트 위임은 대화 범위로 허용할 수 없습니다(위임 정책 agents.delegation을 쓰세요)"));
        }
        if approving
            && let Some(spec) = tools::spec(&cur.name)
            && let PolicyDecision::Deny(code, msg) = tool_policy(tx, &cur.project_id, &cur.session_id, &spec)?
        {
            tx.execute("UPDATE tool_calls SET decided_at = ?2 WHERE id = ?1", params![id, now])?;
            let c = finish(tx, now, &id, &["pending_approval"], "failed", Some(tools::ToolError::new(code, msg.clone()).to_json()))?
                .expect("pending → failed");
            crate::audit::record(tx, now, &actor, "tool_call.decision_blocked", &id, json!({ "tool": cur.name, "decision": b.decision, "reason": code }))?;
            return Ok((StatusCode::CONFLICT, json!({ "error": { "code": code, "message": msg, "retryable": false }, "call": c })));
        }
        let call = if approving {
            let scope = if b.decision == "approve_session" { "session" } else { "once" };
            tx.execute(
                "UPDATE tool_calls SET status = 'approved', decided_at = ?2, updated_at = ?2, revision = revision + 1, approval_scope = ?3 WHERE id = ?1",
                params![id, now, scope],
            )?;
            if scope == "session" {
                tx.execute(
                    "INSERT OR IGNORE INTO session_tool_grants (session_id, tool, granted_at) VALUES (?1, ?2, ?3)",
                    params![cur.session_id, cur.name, now],
                )?;
                events::append(tx, now, "tool_grant.changed", Some(&cur.project_id), Some(&cur.session_id), &json!({ "tool": cur.name, "granted": true }))?;
            }
            let c = get(tx, &id)?;
            emit(tx, now, &c)?;
            c
        } else {
            tx.execute("UPDATE tool_calls SET decided_at = ?2 WHERE id = ?1", params![id, now])?;
            finish(tx, now, &id, &["pending_approval"], "denied", None)?.expect("pending → denied")
        };
        // 승인 대상(target)은 화면에 보인 계획 요약이다. 인자 원문은 남기지 않는다(파일 내용 등이 클 수 있음).
        crate::audit::record(
            tx,
            now,
            &actor,
            "tool_call.decided",
            &id,
            json!({ "tool": cur.name, "decision": b.decision, "session_id": cur.session_id, "revision": cur.revision }),
        )?;
        Ok((StatusCode::OK, serde_json::to_value(call)?))
    })
    .await?;
    // 재전송(replay)이어도 현재 상태 기준으로 후속 처리한다. 실행은 조건부 전이(approved→running)라 중복되지 않는다.
    if let Ok(call) = app.db.call(move |c| get(c, &call_id)).await {
        match call.status.as_str() {
            "approved" => {
                spawn_execute(&app, call.id.clone());
            }
            _ => {
                if let Some(t) = &call.turn_id {
                    crate::runner::maybe_resume(&app, t).await;
                }
            }
        }
    }
    Ok(resp)
}

#[derive(Deserialize)]
pub struct Answer {
    pub expected_revision: i64,
    #[serde(default)]
    pub choices: Vec<String>,
    pub text: Option<String>,
    #[serde(default)]
    pub cancel: bool,
}

/// 질문 도구 답변(RUN-013). 화면에 보인 revision의 질문에만 답하고, 고른 값은 질문의 선택지 안에서만 받는다.
/// 답하면 succeeded(결과=선택·입력), 닫으면 cancelled(모델은 사용자가 답하지 않았음을 안다). 그 뒤 턴을 재개한다.
pub async fn answer(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<Answer>) -> ApiResult<Response> {
    let actor = p.clone();
    let h = idem::body_hash("tool.answer", &json!({ "id": id, "r": b.expected_revision, "c": b.choices, "t": b.text, "x": b.cancel }));
    let call_id = id.clone();
    let resp = idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get(tx, &id)?;
        if cur.status != "awaiting_input" {
            return Err(ApiError::conflict("not_awaiting_input", format!("답을 기다리는 질문이 아닙니다({})", cur.status))
                .with_details(json!({ "current": serde_json::to_value(&cur)? })));
        }
        if cur.revision != b.expected_revision {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        let q = &cur.target;
        let (to, result) = if b.cancel {
            ("cancelled", json!({ "cancelled": true, "message": "사용자가 답하지 않고 질문을 닫았습니다" }))
        } else {
            let labels: Vec<&str> = q["options"].as_array().into_iter().flatten().filter_map(|o| o["label"].as_str()).collect();
            if let Some(x) = b.choices.iter().find(|c| !labels.contains(&c.as_str())) {
                return Err(ApiError::invalid(format!("선택지에 없는 답입니다: {x}")));
            }
            let mut uniq = b.choices.clone();
            uniq.dedup();
            if uniq.len() != b.choices.len() || (q["multi_select"] != true && b.choices.len() > 1) {
                return Err(ApiError::invalid("이 질문은 하나만 고를 수 있습니다"));
            }
            let text = b.text.as_deref().map(str::trim).filter(|t| !t.is_empty());
            if text.is_some() && q["allow_free_text"] == false {
                return Err(ApiError::invalid("이 질문은 직접 입력을 받지 않습니다"));
            }
            if text.is_some_and(|t| t.chars().count() > 10_000) {
                return Err(ApiError::invalid("입력이 너무 깁니다(최대 10000자)"));
            }
            if b.choices.is_empty() && text.is_none() {
                return Err(ApiError::invalid("선택하거나 입력해야 합니다(답하지 않으려면 닫기)"));
            }
            ("succeeded", json!({ "question": q["question"], "choices": b.choices, "text": text }))
        };
        tx.execute("UPDATE tool_calls SET decided_at = ?2 WHERE id = ?1", params![id, now])?;
        let call = finish(tx, now, &id, &["awaiting_input"], to, Some(result))?.expect("awaiting_input → 종료");
        crate::audit::record(tx, now, &actor, "tool_call.answered", &id, json!({ "session_id": cur.session_id, "cancelled": b.cancel, "revision": cur.revision }))?;
        Ok((StatusCode::OK, serde_json::to_value(call)?))
    })
    .await?;
    // 재전송이어도 현재 상태 기준으로 재개한다(재개는 조건부 전이라 중복되지 않음).
    if let Ok(call) = app.db.call(move |c| get(c, &call_id)).await
        && let Some(t) = &call.turn_id
    {
        crate::runner::maybe_resume(&app, t).await;
    }
    Ok(resp)
}

/// 결과 불명 호출의 읽기 전용 관찰. 반환된 fingerprint는 검토 기록 시 현재 상태와 다시 대조한다.
pub async fn observe(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let call = app.db.call(move |c| get(c, &id)).await?;
    let obs = observe_now(&app, &call).await?;
    Ok(Json(obs))
}

async fn observe_now(app: &App, call: &ToolCallRow) -> ApiResult<Value> {
    let pid = call.project_id.clone();
    let root = app.db.call(move |c| Ok(crate::projects::get(c, &pid)?.root_path)).await?;
    let planned = Planned { target: call.target.clone(), precondition: call.precondition.clone() };
    let name = call.name.clone();
    let observation = tokio::task::spawn_blocking(move || tools::observe(&name, &planned, std::path::Path::new(&root)))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let fingerprint = crate::util::sha256_hex(format!("{}|{}|{}", call.id, call.revision, observation).as_bytes());
    Ok(json!({ "call_id": call.id, "status": call.status, "revision": call.revision, "observation": observation, "fingerprint": fingerprint, "observed_at": app.now() }))
}

#[derive(Deserialize)]
pub struct Review {
    pub expected_revision: i64,
    /// observe 응답의 fingerprint. 관찰 이후 상태가 바뀌었으면 거절한다.
    pub fingerprint: String,
    /// 사용자가 확인한 내용: applied | not_applied | partial | unsure
    pub outcome: String,
    pub note: Option<String>,
}

/// 결과 불명 검토 기록. 원래 unknown 상태는 바꾸지 않고(성공으로 위장하지 않음) 검토 기록만 남긴다.
pub async fn review(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<Review>,
) -> ApiResult<Response> {
    if !matches!(b.outcome.as_str(), "applied" | "not_applied" | "partial" | "unsure") {
        return Err(ApiError::invalid("outcome은 applied, not_applied, partial, unsure 중 하나여야 합니다"));
    }
    let id2 = id.clone();
    let call = app.db.call(move |c| get(c, &id2)).await?;
    if call.status != "unknown" {
        return Err(ApiError::conflict("not_unknown", "결과 불명 상태가 아닙니다"));
    }
    let obs = observe_now(&app, &call).await?;
    let fingerprint_now = obs["fingerprint"].as_str().unwrap_or("").to_string();
    let h = idem::body_hash("tool.review", &json!({ "id": id, "r": b.expected_revision, "f": b.fingerprint, "o": b.outcome, "n": b.note }));
    let note: Option<String> = b.note.map(|n| n.chars().take(2000).collect());
    let reviewer = p.root_id.clone();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get(tx, &id)?;
        if cur.revision != b.expected_revision {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        if cur.reviewed_at.is_some() {
            return Err(ApiError::conflict("already_reviewed", "이미 검토되었습니다"));
        }
        if b.fingerprint != fingerprint_now {
            return Err(ApiError::conflict("observation_stale", "관찰 이후 대상 상태가 바뀌었습니다. 다시 확인하세요")
                .with_details(json!({ "observation": obs })));
        }
        let review = json!({ "outcome": b.outcome, "note": note, "observation": obs["observation"], "reviewer": reviewer, "at": now });
        tx.execute(
            "UPDATE tool_calls SET reviewed_at = ?2, review = ?3, revision = revision + 1, updated_at = ?2 WHERE id = ?1 AND status = 'unknown'",
            params![id, now, review.to_string()],
        )?;
        let c = get(tx, &id)?;
        emit(tx, now, &c)?;
        Ok((StatusCode::OK, serde_json::to_value(c)?))
    })
    .await
}

/// 실행 중 호출 취소(셸 등 취소 가능한 도구).
pub async fn cancel(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let id2 = id.clone();
    let call = app.db.call(move |c| get(c, &id2)).await?;
    match call.status.as_str() {
        "running" => {
            let sent = app.cancels.cancel(&id);
            Ok(Json(json!({ "id": id, "cancel_requested": sent, "status": "running" })))
        }
        "pending_approval" | "approved" => {
            let now = app.now();
            let id3 = id.clone();
            let c = app
                .db
                .call(move |c| {
                    let tx = c.transaction()?;
                    let r = finish(&tx, &now, &id3, &["pending_approval", "approved"], "cancelled", Some(json!({ "error": { "code": "cancelled", "message": "실행 전에 취소했습니다" } })))?;
                    tx.commit()?;
                    Ok(r)
                })
                .await?;
            app.notify_events().await;
            if let Some(t) = &call.turn_id {
                crate::runner::maybe_resume(&app, t).await;
            }
            Ok(Json(json!({ "id": id, "status": c.map(|c| c.status).unwrap_or(call.status) })))
        }
        s => Err(ApiError::conflict("already_finished", format!("이미 종료된 호출입니다({s})"))),
    }
}

/// 승인 대기 만료 처리 주기 작업.
pub fn spawn_expiry(app: App) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut rx = app.shutdown_rx.clone();
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(1000)) => {}
                _ = rx.changed() => break,
            }
            expire_due(&app).await;
        }
    })
}

pub async fn expire_due(app: &App) {
    let now = app.now();
    let turns: Vec<String> = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let mut st = tx.prepare("SELECT id FROM tool_calls WHERE status = 'pending_approval' AND expires_at IS NOT NULL AND expires_at <= ?1")?;
            let ids = st.query_map(params![now], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            drop(st);
            let mut turns = vec![];
            for id in ids {
                if let Some(c) = finish(&tx, &now, &id, &["pending_approval"], "expired", None)? {
                    if let Some(t) = c.turn_id {
                        turns.push(t);
                    }
                }
            }
            tx.commit()?;
            Ok(turns)
        })
        .await
        .unwrap_or_default();
    if !turns.is_empty() {
        app.notify_events().await;
    }
    for t in turns {
        crate::runner::maybe_resume(app, &t).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_helpers_summarize_args_duration_and_truncation() {
        let long = "가".repeat(400);
        let v = args_preview(&json!({ "path": "a.txt", "content": long, "n": 3 }));
        assert_eq!(v["path"], "a.txt");
        assert_eq!(v["n"], 3);
        let c = v["content"].as_str().unwrap();
        assert!(c.ends_with("… (400자)") && c.chars().count() < 320, "{c}");
        assert_eq!(duration_ms(Some("2026-01-01T00:00:00.000Z"), Some("2026-01-01T00:00:01.250Z")), Some(1250));
        assert_eq!(duration_ms(Some("2026-01-01T00:00:00.000Z"), None), None);
        assert!(output_truncated(&json!({ "truncated": true })));
        assert!(output_truncated(&json!({ "limit_clamped": 500 })));
        assert!(output_truncated(&json!({ "files": [{ "path": "a", "skipped": "too_large" }] })));
        assert!(!output_truncated(&json!({ "text": "x", "truncated": false })));
    }
}
