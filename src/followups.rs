//! 실행 중에 보낸 추가 메시지(RUN-007·008, UI-021).
//!
//! - queue: 지금 턴이 completed로 끝나면 순서대로 새 턴으로 시작한다. 실패·취소·중단으로 끝나면 멈춘 채 남고
//!   사용자가 시작하거나 지운다(실패한 흐름을 자동으로 이어 가지 않는다).
//! - steer: 실행 중인 턴의 다음 모델 호출 직전, 그 턴의 도구 호출이 모두 끝난 경계에서 user 메시지로 넣는다.
//!   도구 없는 응답 뒤에도 같은 턴을 이어 반영한다. 반영과 삭제는 같은 transaction이며, 중단돼 남은 항목은 queue로 보존한다.
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

pub(crate) mod live;

/// 대화당 대기 항목 상한.
pub const MAX_ITEMS: i64 = 20;
const TERMINAL: &[&str] = &["completed", "failed", "cancelled", "interrupted"];

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
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
    pub model: Option<String>,
    pub service_tier: Option<String>,
    pub native_command: Option<String>,
    /// 자동 시작이 막힌 이유(예: 결과 불명 작업 검토 필요). 사용자가 시작하거나 지울 때까지 남는다.
    #[ts(type = "{ code: string, message: string } | null")]
    pub last_error: Option<Value>,
    #[ts(type = "unknown[]")]
    pub attachments: Vec<Value>,
    #[ts(type = "\"pending\" | \"sending\" | \"rejected\" | \"unknown\"")]
    pub delivery_state: String,
}

const COLS: &str = "id, session_id, kind, text, profile_id, agent_id, tools, created_at, last_error, effort, attachments, model, service_tier, native_command, delivery_state";

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
        model: r.get(11)?,
        service_tier: r.get(12)?,
        native_command: r.get(13)?,
        delivery_state: r.get(14)?,
        attachments: serde_json::from_str(&r.get::<_,String>(10)?).map_err(|e|rusqlite::Error::FromSqlConversionFailure(10,rusqlite::types::Type::Text,Box::new(e)))?,
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
pub fn apply_steers(tx: &Connection, now: &str, turn_id: &str, data: &std::path::Path) -> ApiResult<usize> {
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
    let items: Vec<_> = list(tx, &session_id)?.into_iter().filter(|f| f.kind == "steer" && f.delivery_state == "pending").collect();
    let mut applied = 0;
    for f in &items {
        tx.execute_batch("SAVEPOINT steer_attachment")?;
        let result = (|| -> ApiResult<()> {
            let owner = owner_of(tx, &f.id)?;
            let prepared = prepare_item(tx, data, f, &owner)?;
            let turn = crate::runner::get_turn(tx, turn_id)?;
            let profile = crate::models::get_enabled_profile(tx, turn.profile_id.as_deref().ok_or_else(|| ApiError::invalid("모델 프로필이 없습니다"))?)?;
            profile.check_capabilities(false, None, prepared.model_input["images"].as_array().is_some_and(|v| !v.is_empty()))?;
            append_steer(tx, now, turn_id, f, &prepared)
        })();
        match result {
            Ok(()) => {
                tx.execute_batch("RELEASE steer_attachment")?;
                applied += 1;
            }
            Err(e) => {
                tx.execute_batch("ROLLBACK TO steer_attachment; RELEASE steer_attachment")?;
                tx.execute(
                    "UPDATE followups SET kind='queue',last_error=?2 WHERE id=?1",
                    params![f.id, json!({"code":e.code,"message":e.message}).to_string()],
                )?;
            }
        }
    }
    if !items.is_empty() {
        emit(tx, now, &session_id)?;
    }
    Ok(applied)
}

fn append_steer(tx: &Connection, now: &str, turn_id: &str, f: &Followup, prepared: &crate::attachments::Prepared) -> ApiResult<()> {
    let mut content = json!({"text":f.text,"source":{"kind":"steer","followup_id":f.id}});
    if !prepared.items.is_empty() { content["attachments"] = json!(prepared.items); }
    let m = crate::sessions::append_message(tx, now, &f.session_id, "user", &content, Some(turn_id),
        (!prepared.items.is_empty()).then_some(&prepared.model_input))?;
    crate::attachments::bind(tx, now, &m.id, prepared)?;
    tx.execute("UPDATE turns SET definition_snapshot=json_remove(definition_snapshot,'$.native_command') WHERE id=?1", [turn_id])?;
    tx.execute("DELETE FROM followups WHERE id=?1", [&f.id])?;
    Ok(())
}

// 큐 참조를 메시지 참조로 바꾸는 같은 transaction/savepoint 안에서만 호출한다.
fn prepare_item(tx: &Connection, data: &std::path::Path, f: &Followup, owner: &str) -> ApiResult<crate::attachments::Prepared> {
    let s = crate::sessions::get_active(tx, &f.session_id)?;
    let ids: Vec<String> = f
        .attachments
        .iter()
        .map(|a| a["id"].as_str().map(str::to_string).ok_or_else(|| ApiError::gone("대기 첨부 ID가 잘못되었습니다")))
        .collect::<ApiResult<_>>()?;
    tx.execute("DELETE FROM followup_attachment_refs WHERE followup_id=?1", [&f.id])?;
    crate::attachments::prepare(tx, data, owner.strip_prefix("token:").unwrap_or(owner), &s.project_id, &f.text, &ids)
}

/// 항목 하나를 새 턴으로 시작한다. 실패하면 참조까지 되돌리고 이유를 항목에 남긴다.
fn start_item(tx: &Connection, now: &str, epoch: &str, f: &Followup, owner: &str, data: &std::path::Path) -> ApiResult<Result<String, ApiError>> {
    if f.delivery_state != "pending" {
        return Ok(Err(ApiError::conflict("steer_delivery_unresolved", "전달 중이거나 결과 확인이 필요한 메시지입니다. 대화를 확인한 뒤 새 메시지로 보내세요")));
    }
    tx.execute_batch("SAVEPOINT followup_start")?;
    let result = (|| -> ApiResult<String> {
        let prepared = prepare_item(tx, data, f, owner)?;
        let (t, _) = crate::runner::enqueue_with_attachments(
            tx,
            now,
            epoch,
            owner,
            &f.session_id,
            &f.text,
            &f.profile_id,
            f.agent_id.as_deref(),
            Some(f.tools),
            None,
            (!prepared.items.is_empty()).then_some(&prepared),
        )?;
        crate::runner::set_turn_model(tx, &t.id, f.model.as_deref())?;
        crate::runner::set_turn_effort(tx, &t.id, f.effort.as_deref())?;
        crate::runner::set_turn_service_tier(tx, &t.id, f.service_tier.as_deref())?;
        crate::runner::set_turn_native_command(tx, &t.id, f.native_command.as_deref())?;
        tx.execute("DELETE FROM followups WHERE id=?1", [&f.id])?;
        Ok(t.id)
    })();
    match result {
        Ok(tid) => {
            tx.execute_batch("RELEASE followup_start")?;
            Ok(Ok(tid))
        }
        Err(e) => {
            tx.execute_batch("ROLLBACK TO followup_start; RELEASE followup_start")?;
            tx.execute("UPDATE followups SET last_error=?2 WHERE id=?1", params![f.id, json!({"code":e.code,"message":e.message}).to_string()])?;
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
    let data=app.cfg.data_dir.clone();
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
            // 이미 종료된 턴에 남은 steer도 잃지 않는다. 실패·취소 뒤에는 대기열로 남겨 직접 재시작한다.
            let converted = tx.execute("UPDATE followups SET kind = 'queue' WHERE session_id = ?1 AND kind = 'steer'", params![session_id])?;
            let items = list(&tx, &session_id)?;
            let next = match status.as_str() {
                "completed" => items.first().filter(|f| f.delivery_state == "pending").cloned(),
                "cancelled" => items.iter().find(|f| f.kind == "interrupt" && f.delivery_state == "pending").cloned(),
                _ => None,
            };
            let mut started = false;
            if let Some(f) = next {
                let owner = owner_of(&tx, &f.id)?;
                started = start_item(&tx, &now, &epoch, &f, &owner, &data)?.is_ok();
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
    pub model: Option<String>,
    pub service_tier: Option<String>,
    pub native_command: Option<String>,
    #[serde(default)]
    pub attachments: Vec<String>,
}

pub async fn get_list(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(app.db.call(move |c| Ok(json!({ "items": list(c, &id)? }))).await?))
}

/// 추가 메시지 접수. 실행 중인 턴이 없으면 바로 새 턴으로 시작한다(`started_turn`).
pub async fn post_add(State(app): State<App>, p: Principal, headers: HeaderMap, Path(session_id): Path<String>, Json(b): Json<AddBody>) -> ApiResult<Response> {
    crate::sessions::validate_message(&b.text,&b.attachments)?;
    if !["queue", "steer", "interrupt"].contains(&b.kind.as_str()) {
        return Err(ApiError::invalid("kind는 queue·steer·interrupt 중 하나입니다"));
    }
    let effort = crate::provider::parse_effort(b.effort.as_deref()).map_err(ApiError::invalid)?;
    let service_tier = crate::provider::parse_service_tier(b.service_tier.as_deref()).map_err(ApiError::invalid)?;
    let model = crate::runner::parse_model(b.model.as_deref())?;
    let native_command = crate::provider::cli::commands::parse_id(b.native_command.as_deref()).map_err(ApiError::invalid)?;
    if native_command.is_some() && b.kind == "steer" {
        return Err(ApiError::invalid("CLI 스킬은 대기열에 추가하거나 중단하고 보내기를 선택하세요"));
    }
    let mut hash_body=json!({ "s": session_id, "k": b.kind, "t": b.text, "p": b.profile_id, "a": b.agent_id, "tools": b.tools.unwrap_or(false), "e": effort });
    if b.tools.is_none() { hash_body["tools_default"] = json!(true); }
    if !b.attachments.is_empty() {hash_body["attachments"]=json!(b.attachments);}
    if let Some(model) = &model { hash_body["model"] = json!(model); }
    if let Some(tier) = &service_tier { hash_body["service_tier"] = json!(tier); }
    if let Some(command) = &native_command { hash_body["native_command"] = json!(command); }
    let h = idem::body_hash("followup.add", &hash_body);
    let root_owner=p.root_id.clone();
    let data=app.cfg.data_dir.clone();
    let owner = format!("token:{}", p.root_id);
    let epoch = app.epoch.clone();
    let kind = b.kind.clone();
    let session_for_interrupt = session_id.clone();
    let resp = idem::run(&app, &p, &headers, &h, move |tx, now| {
        let s = crate::sessions::get_active(tx, &session_id)?;
        let binding = crate::bots::turn_binding(tx, &session_id)?;
        let room = crate::bot_rooms::request_binding(tx, &session_id, &b.text)?;
        if (binding.is_some() || room.is_some()) && model.is_some() { return Err(ApiError::invalid("봇 모델은 봇 설정에서 변경하세요")); }
        let profile_id = room.as_ref().map(|(_,profile)| profile.as_str())
            .or_else(|| binding.as_ref().map(|(profile,_)|profile.as_str())).unwrap_or(&b.profile_id);
        let profile = crate::models::get_enabled_profile(tx, profile_id)?;
        if let Some(a) = &b.agent_id { crate::definitions::resolve_turn_agent(tx, a)?; }
        let tools = profile.turn_tools(b.tools);
        if native_command.is_some() && !crate::provider::cli::is_cli(&profile.protocol) {
            return Err(ApiError::unsupported("CLI 모델에서만 스킬·명령을 사용할 수 있습니다"));
        }
        if service_tier.is_some() && (!crate::model_capabilities::is_codex(&profile.protocol) || !profile.capabilities.fast) {
            return Err(ApiError::unsupported("선택한 모델 프로필은 속도 선택을 지원하지 않습니다"));
        }
        let prepared=crate::attachments::prepare(tx,&data,&root_owner,&s.project_id,&b.text,&b.attachments)?;
        profile.check_model_capabilities(model.as_deref().unwrap_or(&profile.model), tools, effort.as_deref(), prepared.model_input["images"].as_array().is_some_and(|v| !v.is_empty()))?;
        let Some(active) = active_turn_id(tx, &session_id)? else {
            // 그 사이 턴이 끝났다: 바로 시작한다.
            let (t, msg) = crate::runner::enqueue_with_attachments(tx, now, &epoch, &owner, &session_id, &b.text, &b.profile_id, b.agent_id.as_deref(), Some(tools), None, (!prepared.items.is_empty()).then_some(&prepared))?;
            crate::runner::set_turn_model(tx, &t.id, model.as_deref())?;
            crate::runner::set_turn_effort(tx, &t.id, effort.as_deref())?;
            crate::runner::set_turn_service_tier(tx, &t.id, service_tier.as_deref())?;
            crate::runner::set_turn_native_command(tx, &t.id, native_command.as_deref())?;
            let t = crate::runner::get_turn(tx, &t.id)?;
            return Ok((StatusCode::ACCEPTED, json!({ "started_turn": t, "message": msg })));
        };
        if b.kind == "steer" && let Some((ids, _)) = &room {
            let turn = crate::runner::get_turn(tx, &active)?;
            if ids.len() != 1 || turn.definition["bot"]["id"].as_str() != Some(ids[0].as_str()) {
                return Err(ApiError::invalid("다른 봇에게 보낼 때는 대기열에 추가하거나 중단하고 보내기를 선택하세요"));
            }
        }
        if b.kind == "steer" && let Some(model) = &model {
            let turn = crate::runner::get_turn(tx, &active)?;
            let current = crate::model_fallback::runtime(tx, &turn.definition, turn.profile_id.as_deref().unwrap_or(""))?.1;
            if current.model != *model {
                return Err(ApiError::invalid("실행 중인 모델을 바꾸려면 대기열에 추가하거나 중단하고 보내기를 선택하세요"));
            }
        }
        if b.kind == "steer" {
            let turn = crate::runner::get_turn(tx, &active)?;
            if service_tier.as_deref().is_some_and(|tier| turn.definition["service_tier"].as_str() != Some(tier))
                || effort.as_deref().is_some_and(|effort| turn.definition["effort"].as_str() != Some(effort)) {
                return Err(ApiError::invalid("실행 중 추론·속도를 바꾸려면 대기열에 추가하거나 중단하고 보내기를 선택하세요"));
            }
        }
        let n: i64 = tx.query_row("SELECT COUNT(*) FROM followups WHERE session_id = ?1", params![session_id], |r| r.get(0))?;
        if n >= MAX_ITEMS {
            return Err(ApiError::conflict("followup_limit", format!("대기 메시지는 대화당 {MAX_ITEMS}개까지입니다")));
        }
        let id = crate::util::new_id();
        tx.execute(
            "INSERT INTO followups (id, session_id, kind, text, profile_id, agent_id, tools, owner_key, created_at, effort, attachments, model, service_tier, native_command) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![id, session_id, b.kind, b.text, profile.id, b.agent_id, tools, owner, now, effort, json!(prepared.items).to_string(), model, service_tier, native_command],
        )?;
        for item in &prepared.items {tx.execute("INSERT INTO followup_attachment_refs(attachment_id,followup_id) VALUES (?1,?2)",params![item["id"].as_str().unwrap(),id])?;}
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
            let sending: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM followups WHERE id=?1 AND session_id=?2 AND delivery_state='sending')",
                params![fid, session_id], |r| r.get(0),
            )?;
            if sending { return Err(ApiError::conflict("steer_delivery_in_progress", "에이전트에 전달 중입니다. 결과를 확인한 뒤 삭제하세요")); }
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
    let data=app.cfg.data_dir.clone();
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
            let r = start_item(&tx, &now, &epoch, &f, &owner, &data)?;
            emit(&tx, &now, &session_id)?;
            tx.commit()?;
            r
        })
        .await?;
    app.notify_events().await;
    crate::runner::kick_queued(&app).await;
    Ok((StatusCode::ACCEPTED, Json(json!({ "turn_id": res }))))
}
