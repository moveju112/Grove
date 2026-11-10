//! 실행 중에 보낸 추가 메시지(RUN-007·008, UI-021).
//!
//! - queue: 지금 턴이 completed로 끝나면 순서대로 새 턴으로 시작한다. 실패·취소·중단으로 끝나면 멈춘 채 남고
//!   사용자가 시작하거나 지운다(실패한 흐름을 자동으로 이어 가지 않는다).
//! - steer: 실행 중인 턴의 다음 모델 호출 직전, 그 턴의 도구 호출이 모두 끝난 경계에서 user 메시지로 넣는다.
//!   반영과 삭제가 같은 transaction이라 입력을 잃거나 두 번 넣지 않는다. 그 경계 없이 턴이 끝나면 queue로 바뀐다.
//! - interrupt: 지금 턴을 취소하고 그 메시지를 맨 앞에서 바로 시작한다.
//! - 보낼 때 실행 중인 턴이 없으면(그 사이 끝남) 종류와 관계없이 바로 새 턴으로 시작한다(입력 유실 방지).

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::idem;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// 대화당 대기 항목 상한.
pub const MAX_ITEMS: i64 = 20;
const TERMINAL: &[&str] = &["completed", "failed", "cancelled", "interrupted"];

#[derive(Debug, Clone, Serialize)]
pub struct Followup {
    pub id: String,
    pub session_id: String,
    pub kind: String,
    pub text: String,
    pub profile_id: String,
    pub agent_id: Option<String>,
    pub tools: bool,
    pub created_at: String,
    pub effort: Option<String>,
    /// 자동 시작이 막힌 이유(예: 결과 불명 작업 검토 필요). 사용자가 시작하거나 지울 때까지 남는다.
    pub last_error: Option<Value>,
}

const COLS: &str = "id, session_id, kind, text, profile_id, agent_id, tools, created_at, last_error, effort";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Followup> {
    let err: Option<String> = r.get(8)?;
    Ok(Followup {
        id: r.get(0)?,
        session_id: r.get(1)?,
        kind: r.get(2)?,
        text: r.get(3)?,
        profile_id: r.get(4)?,
        agent_id: r.get(5)?,
        tools: r.get(6)?,
        created_at: r.get(7)?,
        effort: r.get(9)?,
        last_error: err.and_then(|s| serde_json::from_str(&s).ok()),
    })
}

/// 시작 순서: interrupt 먼저, 그다음 들어온 순서.
pub fn list(c: &Connection, session_id: &str) -> ApiResult<Vec<Followup>> {
    let mut st = c.prepare(&format!("SELECT {COLS} FROM followups WHERE session_id = ?1 ORDER BY kind = 'interrupt' DESC, rowid"))?;
    Ok(st.query_map(params![session_id], row)?.collect::<Result<Vec<_>, _>>()?)
}

fn emit(c: &Connection, now: &str, session_id: &str) -> ApiResult<()> {
    let pid: String = c.query_row("SELECT project_id FROM sessions WHERE id = ?1", params![session_id], |r| r.get(0))?;
    events::append(c, now, "followups.changed", Some(&pid), Some(session_id), &json!({ "items": list(c, session_id)? }))?;
    Ok(())
}

/// 실행 중인 턴의 모델 호출 직전에 steer를 user 메시지로 넣는다. 도구 호출이 하나라도 끝나지 않았으면
/// (도구 호출과 결과 사이에 끼우면 짝이 깨진다) 다음 경계로 미룬다. 넣은 개수를 돌려준다.
pub fn apply_steers(tx: &Connection, now: &str, turn_id: &str) -> ApiResult<usize> {
    let Some((session_id, status)) = tx
        .query_row("SELECT session_id, status FROM turns WHERE id = ?1", params![turn_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .optional()?
    else {
        return Ok(0);
    };
    if status != "running" {
        return Ok(0);
    }
    let open: i64 = tx.query_row(
        "SELECT COUNT(*) FROM tool_calls WHERE turn_id = ?1 AND status IN ('pending_approval','awaiting_input','approved','running')",
        params![turn_id],
        |r| r.get(0),
    )?;
    if open > 0 {
        return Ok(0);
    }
    let mut st = tx.prepare("SELECT id, text FROM followups WHERE session_id = ?1 AND kind = 'steer' ORDER BY rowid")?;
    let items = st.query_map(params![session_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.collect::<Result<Vec<_>, _>>()?;
    drop(st);
    for (id, text) in &items {
        crate::sessions::append_message(tx, now, &session_id, "user", &json!({ "text": text, "source": { "kind": "steer", "followup_id": id } }), Some(turn_id), None)?;
        tx.execute("DELETE FROM followups WHERE id = ?1", params![id])?;
    }
    if !items.is_empty() {
        emit(tx, now, &session_id)?;
    }
    Ok(items.len())
}

/// 항목 하나를 새 턴으로 시작한다. 실패하면 아무것도 쓰지 않고(savepoint) 이유를 항목에 남긴다.
fn start_item(tx: &Connection, now: &str, epoch: &str, f: &Followup, owner: &str) -> ApiResult<Result<String, ApiError>> {
    tx.execute_batch("SAVEPOINT followup_start")?;
    match crate::runner::enqueue_turn(tx, now, epoch, owner, &f.session_id, &f.text, &f.profile_id, f.agent_id.as_deref(), f.tools, None) {
        Ok((t, _)) => {
            crate::runner::set_turn_effort(tx, &t.id, f.effort.as_deref())?;
            tx.execute("DELETE FROM followups WHERE id = ?1", params![f.id])?;
            tx.execute_batch("RELEASE followup_start")?;
            Ok(Ok(t.id))
        }
        Err(e) => {
            tx.execute_batch("ROLLBACK TO followup_start; RELEASE followup_start")?;
            tx.execute("UPDATE followups SET last_error = ?2 WHERE id = ?1", params![f.id, json!({ "code": e.code, "message": e.message }).to_string()])?;
            Ok(Err(e))
        }
    }
}

/// 대화에서 진행 중인 턴 ID(`Session.active_turn`은 상태 문자열이라 ID가 아니다).
fn active_turn_id(c: &Connection, session_id: &str) -> ApiResult<Option<String>> {
    Ok(c
        .query_row(
            "SELECT id FROM turns WHERE session_id = ?1 AND status IN ('queued','running','awaiting_approval') ORDER BY created_at DESC LIMIT 1",
            params![session_id],
            |r| r.get(0),
        )
        .optional()?)
}

fn owner_of(tx: &Connection, id: &str) -> ApiResult<String> {
    Ok(tx.query_row("SELECT owner_key FROM followups WHERE id = ?1", params![id], |r| r.get(0))?)
}

/// 턴이 끝난 뒤 다음 항목을 정한다. 여러 경로에서 불려도 같은 결과가 되도록 현재 상태만 보고 결정한다.
pub async fn after_turn(app: &App, turn_id: &str) {
    let (tid, epoch) = (turn_id.to_string(), app.epoch.clone());
    let started = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let now = crate::util::fmt_time(time::OffsetDateTime::now_utc());
            let Some((session_id, status)) = tx
                .query_row("SELECT session_id, status FROM turns WHERE id = ?1", params![tid], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .optional()?
            else {
                return Ok(false);
            };
            if !TERMINAL.contains(&status.as_str()) {
                return Ok(false);
            }
            if active_turn_id(&tx, &session_id)?.is_some() {
                return Ok(false);
            }
            // 반영 경계 없이 끝난 steer는 다음 턴이 된다(잃지 않음).
            let converted = tx.execute("UPDATE followups SET kind = 'queue' WHERE session_id = ?1 AND kind = 'steer'", params![session_id])?;
            let items = list(&tx, &session_id)?;
            let next = match status.as_str() {
                "completed" => items.first().cloned(),
                "cancelled" => items.iter().find(|f| f.kind == "interrupt").cloned(),
                _ => None,
            };
            let mut started = false;
            if let Some(f) = next {
                let owner = owner_of(&tx, &f.id)?;
                started = start_item(&tx, &now, &epoch, &f, &owner)?.is_ok();
                emit(&tx, &now, &session_id)?;
            } else if converted > 0 {
                emit(&tx, &now, &session_id)?;
            }
            tx.commit()?;
            Ok(started)
        })
        .await
        .unwrap_or(false);
    app.notify_events().await;
    if started {
        crate::runner::kick_queued(app).await;
    }
}

// ---------------- API ----------------

#[derive(Deserialize)]
pub struct AddBody {
    pub kind: String,
    pub text: String,
    pub profile_id: String,
    pub agent_id: Option<String>,
    pub tools: Option<bool>,
    pub effort: Option<String>,
}

pub async fn get_list(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(app.db.call(move |c| Ok(json!({ "items": list(c, &id)? }))).await?))
}

/// 추가 메시지 접수. 실행 중인 턴이 없으면 바로 새 턴으로 시작한다(`started_turn`).
pub async fn post_add(State(app): State<App>, p: Principal, headers: HeaderMap, Path(session_id): Path<String>, Json(b): Json<AddBody>) -> ApiResult<Response> {
    crate::sessions::validate_text(&b.text)?;
    if !["queue", "steer", "interrupt"].contains(&b.kind.as_str()) {
        return Err(ApiError::invalid("kind는 queue·steer·interrupt 중 하나입니다"));
    }
    let tools = b.tools.unwrap_or(false);
    if tools && !app.cfg.enable_tool_loop {
        return Err(ApiError::unsupported("이 서버에서는 모델 도구 실행이 꺼져 있습니다(GROVE_ENABLE_TOOL_LOOP=1)"));
    }
    let effort = crate::provider::parse_effort(b.effort.as_deref()).map_err(ApiError::invalid)?;
    let h = idem::body_hash("followup.add", &json!({ "s": session_id, "k": b.kind, "t": b.text, "p": b.profile_id, "a": b.agent_id, "tools": tools, "e": effort }));
    let owner = format!("token:{}", p.root_id);
    let epoch = app.epoch.clone();
    let kind = b.kind.clone();
    let session_for_interrupt = session_id.clone();
    let resp = idem::run(&app, &p, &headers, &h, move |tx, now| {
        let s = crate::sessions::get_active(tx, &session_id)?;
        crate::models::get_profile(tx, &b.profile_id)?;
        let _ = s;
        let Some(active) = active_turn_id(tx, &session_id)? else {
            // 그 사이 턴이 끝났다: 바로 시작한다.
            let (t, msg) = crate::runner::enqueue_turn(tx, now, &epoch, &owner, &session_id, &b.text, &b.profile_id, b.agent_id.as_deref(), tools, None)?;
            crate::runner::set_turn_effort(tx, &t.id, effort.as_deref())?;
            let t = crate::runner::get_turn(tx, &t.id)?;
            return Ok((StatusCode::ACCEPTED, json!({ "started_turn": t, "message": msg })));
        };
        let n: i64 = tx.query_row("SELECT COUNT(*) FROM followups WHERE session_id = ?1", params![session_id], |r| r.get(0))?;
        if n >= MAX_ITEMS {
            return Err(ApiError::conflict("followup_limit", format!("대기 메시지는 대화당 {MAX_ITEMS}개까지입니다")));
        }
        let id = crate::util::new_id();
        tx.execute(
            "INSERT INTO followups (id, session_id, kind, text, profile_id, agent_id, tools, owner_key, created_at, effort) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![id, session_id, b.kind, b.text, b.profile_id, b.agent_id, tools, owner, now, effort],
        )?;
        emit(tx, now, &session_id)?;
        let item = tx.query_row(&format!("SELECT {COLS} FROM followups WHERE id = ?1"), params![id], row)?;
        Ok((StatusCode::CREATED, json!({ "followup": item, "active_turn": active })))
    })
    .await?;
    app.notify_events().await;
    crate::runner::kick_queued(&app).await;
    // interrupt: 아직 시작되지 않은 interrupt 항목이 있을 때만 지금 턴을 취소한다. 같은 key 재전송(replay)은
    // 항목이 이미 시작되어 없으므로, 새로 시작한 턴을 다시 취소하지 않는다. 취소로 끝나면 after_turn이 항목을 시작한다.
    if kind == "interrupt" {
        let sid = session_for_interrupt;
        let active = app
            .db
            .call(move |c| {
                let pending: i64 = c.query_row("SELECT COUNT(*) FROM followups WHERE session_id = ?1 AND kind = 'interrupt'", params![sid], |r| r.get(0))?;
                Ok(active_turn_id(c, &sid)?.filter(|_| pending > 0))
            })
            .await?;
        if let Some(active) = active {
            let _ = crate::runner::cancel_turn(&app, &active, crate::runner::CancelCause::Interrupt).await;
            after_turn(&app, &active).await;
        }
    }
    Ok(resp)
}

/// 항목 삭제. 이미 반영·시작된 항목이면 404.
pub async fn delete(State(app): State<App>, _p: Principal, Path((session_id, fid)): Path<(String, String)>) -> ApiResult<StatusCode> {
    app.db
        .call(move |c| {
            let tx = c.transaction()?;
            let now = crate::util::fmt_time(time::OffsetDateTime::now_utc());
            if tx.execute("DELETE FROM followups WHERE id = ?1 AND session_id = ?2", params![fid, session_id])? == 0 {
                return Err(ApiError::not_found("대기 메시지가 없습니다(이미 반영·시작되었을 수 있습니다)"));
            }
            emit(&tx, &now, &session_id)?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    app.notify_events().await;
    Ok(StatusCode::NO_CONTENT)
}

/// 멈춘 항목을 지금 시작한다(실행 중인 턴이 없을 때만).
pub async fn post_start(State(app): State<App>, _p: Principal, Path((session_id, fid)): Path<(String, String)>) -> ApiResult<(StatusCode, Json<Value>)> {
    let epoch = app.epoch.clone();
    let res = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let now = crate::util::fmt_time(time::OffsetDateTime::now_utc());
            let f = tx
                .query_row(&format!("SELECT {COLS} FROM followups WHERE id = ?1 AND session_id = ?2"), params![fid, session_id], row)
                .optional()?
                .ok_or_else(|| ApiError::not_found("대기 메시지가 없습니다"))?;
            let owner = owner_of(&tx, &f.id)?;
            let r = start_item(&tx, &now, &epoch, &f, &owner)?;
            emit(&tx, &now, &session_id)?;
            tx.commit()?;
            r
        })
        .await?;
    app.notify_events().await;
    crate::runner::kick_queued(&app).await;
    Ok((StatusCode::ACCEPTED, Json(json!({ "turn_id": res }))))
}
