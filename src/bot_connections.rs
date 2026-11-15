//! 외부 서비스는 기존 MCP 자격·승인·결과 불명 경계를 재사용한다.
//! 봇의 연결 지정은 호출 승인이 아니며, 접수 snapshot과 현재 허용 목록의 교집합만 쓴다.
use crate::{App, auth::{Owner, Principal}, error::{ApiError, ApiResult}, idem};
use axum::{Json, extract::{Path, State}, http::{HeaderMap, StatusCode}, response::Response};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

#[derive(Serialize, TS)]
pub struct BotConnection {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub selected: bool,
}

#[derive(Serialize, TS)]
pub struct BotConnections {
    pub revision: i64,
    pub servers: Vec<BotConnection>,
}

pub(crate) fn selected(c: &Connection, bot: &str) -> ApiResult<Vec<String>> {
    let mut st = c.prepare("SELECT server_id FROM bot_connections WHERE bot_id=?1 ORDER BY server_id")?;
    Ok(st.query_map([bot], |r| r.get(0))?.collect::<Result<_, _>>()?)
}

fn view(c: &Connection, id: &str) -> ApiResult<BotConnections> {
    let bot = crate::bots::get(c, id)?;
    let mut st = c.prepare("SELECT m.id,m.name,m.enabled,EXISTS(SELECT 1 FROM bot_connections b WHERE b.bot_id=?1 AND b.server_id=m.id) FROM mcp_servers m ORDER BY m.name,m.id")?;
    let servers = st.query_map([id], |r| Ok(BotConnection { id: r.get(0)?, name: r.get(1)?, enabled: r.get(2)?, selected: r.get(3)? }))?
        .collect::<Result<_, _>>()?;
    Ok(BotConnections { revision: bot.revision, servers })
}

pub async fn show(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<BotConnections>> {
    Ok(Json(app.db.call(move |c| view(c, &id)).await?))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SaveConnections {
    pub expected_revision: i64,
    pub server_ids: Vec<String>,
}

pub async fn save(State(app): State<App>, Owner(p): Owner, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<SaveConnections>) -> ApiResult<Response> {
    let h = idem::body_hash("bot.connections", &json!({"id":id,"body":b}));
    let actor = p.clone();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let bot = crate::bots::get(tx, &id)?;
        if bot.revision != b.expected_revision { return Err(ApiError::revision_conflict(serde_json::to_value(bot)?)); }
        if bot.status == "deleted" { return Err(ApiError::conflict("deleted", "삭제된 봇은 복원 후 수정하세요")); }
        if b.server_ids.len() > 64 { return Err(ApiError::invalid("연결은 64개 이하여야 합니다")); }
        for server in &b.server_ids { crate::mcp::get(tx, server)?; }
        tx.execute("DELETE FROM bot_connections WHERE bot_id=?1", [&id])?;
        for server in &b.server_ids {
            tx.execute("INSERT OR IGNORE INTO bot_connections(bot_id,server_id) VALUES(?1,?2)", params![id,server])?;
        }
        tx.execute("UPDATE bots SET revision=revision+1,updated_at=?2 WHERE id=?1", params![id,now])?;
        crate::events::append(tx, now, "bot.changed", Some(&bot.project_id), bot.home_session_id.as_deref(), &json!({"id":id}))?;
        crate::audit::record(tx, now, &actor, "bot.connections", &id, json!({"server_ids":b.server_ids}))?;
        Ok((StatusCode::OK, serde_json::to_value(view(tx, &id)?)?))
    }).await
}

/// 자식 에이전트도 부모 봇의 연결 범위를 벗어나지 못한다.
pub(crate) fn execution_bot(c: &Connection, session: &str, turn: Option<&str>) -> ApiResult<Option<Value>> {
    let mut session = session.to_string();
    let mut turn = turn.map(str::to_string);
    for _ in 0..32 {
        let def: Option<String> = match &turn {
            Some(id) => c.query_row("SELECT definition_snapshot FROM turns WHERE id=?1 AND session_id=?2", params![id,session], |r| r.get(0)).optional()?,
            None => c.query_row("SELECT definition_snapshot FROM turns WHERE session_id=?1 AND status IN ('queued','running','awaiting_approval') ORDER BY created_at DESC LIMIT 1", [&session], |r| r.get(0)).optional()?,
        };
        if let Some(def) = def {
            let def: Value = serde_json::from_str(&def)?;
            if def["bot"].is_object() { return Ok(Some(def["bot"].clone())); }
        }
        if let Some(bot) = crate::bots::by_session(c, &session)? {
            return Ok(Some(json!({"id":bot.id})));
        }
        let parent: Option<(String, Option<String>)> = c.query_row(
            "SELECT parent_session_id,parent_turn_id FROM agent_runs WHERE child_session_id=?1",
            [&session], |r| Ok((r.get(0)?,r.get(1)?)),
        ).optional()?;
        match parent {
            Some((sid, tid)) => { session = sid; turn = tid; }
            None => return Ok(None),
        }
    }
    Err(ApiError::conflict("bot_scope_invalid", "봇 연결 범위를 확인할 수 없습니다"))
}

pub(crate) fn check_access(c: &Connection, session: &str, turn: Option<&str>, server: &str) -> ApiResult<()> {
    let Some(bot) = execution_bot(c, session, turn)? else { return Ok(()); };
    let id = bot["id"].as_str().ok_or_else(|| ApiError::invalid("봇 실행 정보가 없습니다"))?;
    let live = crate::bots::get(c, id)?;
    if live.status != "active" { return Err(ApiError::conflict("bot_inactive", "봇이 비활성화돼 연결을 사용하지 않았습니다")); }
    let allowed = selected(c, id)?.iter().any(|s| s == server)
        && bot.get("connections").is_none_or(|v| v.as_array().is_some_and(|a| a.iter().any(|s| s == server)));
    if !allowed { return Err(ApiError::conflict("bot_connection_denied", "이 봇에 허용되지 않은 외부 연결입니다")); }
    Ok(())
}
