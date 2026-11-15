//! 프로젝트 안의 봇들이 하나의 세션을 공유한다. 명시한 수신자만 순서대로 답한다.
//! 다음 답변은 직전 턴의 성공 확정 뒤에만 접수하며 실패·취소·재시작 뒤 자동 재전송하지 않는다.
use crate::{App, auth::Principal, error::{ApiError, ApiResult}, idem};
use axum::{Json, extract::{Path, State}, http::{HeaderMap, StatusCode}, response::Response};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

#[derive(Clone, Serialize, TS)]
pub struct RoomMember {
    pub id: String,
    pub name: String,
    pub profile_id: Option<String>,
    pub status: String,
}

#[derive(Serialize, TS)]
pub struct BotRoom {
    pub session_id: String,
    pub project_id: String,
    pub name: String,
    pub members: Vec<RoomMember>,
}

fn member_ids(c: &Connection, sid: &str) -> ApiResult<Option<Vec<String>>> {
    let raw: Option<String> = c.query_row("SELECT member_ids FROM bot_rooms WHERE session_id=?1", [sid], |r| r.get(0)).optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(Into::into)).transpose()
}

pub(crate) fn is_room(c: &Connection, sid: &str) -> ApiResult<bool> {
    Ok(member_ids(c, sid)?.is_some())
}

fn room(c: &Connection, sid: &str) -> ApiResult<Option<BotRoom>> {
    let Some(ids) = member_ids(c, sid)? else { return Ok(None); };
    let s = crate::sessions::get(c, sid)?;
    let members = ids.iter().map(|id| {
        let b = crate::bots::get(c, id)?;
        Ok(RoomMember { id: b.id, name: b.name, profile_id: b.profile_id, status: b.status })
    }).collect::<ApiResult<Vec<_>>>()?;
    Ok(Some(BotRoom { session_id: s.id, project_id: s.project_id, name: s.title, members }))
}

pub async fn show(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Option<BotRoom>>> {
    Ok(Json(app.db.call(move |c| { crate::sessions::get(c, &id)?; room(c, &id) }).await?))
}

pub async fn list(State(app): State<App>, _p: Principal) -> ApiResult<Json<Vec<BotRoom>>> {
    Ok(Json(app.db.call(|c| {
        let mut st = c.prepare("SELECT b.session_id FROM bot_rooms b JOIN sessions s ON s.id=b.session_id JOIN projects p ON p.id=s.project_id WHERE s.archived_at IS NULL AND p.archived_at IS NULL ORDER BY s.updated_at DESC")?;
        let ids = st.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        ids.iter().map(|id| room(c, id)?.ok_or_else(|| ApiError::not_found("그룹이 없습니다"))).collect()
    }).await?))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRoom {
    pub name: String,
    pub project_id: String,
    pub member_ids: Vec<String>,
}

pub async fn create(State(app): State<App>, p: Principal, headers: HeaderMap, Json(b): Json<CreateRoom>) -> ApiResult<Response> {
    let h = idem::body_hash("bot_room.create", &serde_json::to_value(&b)?);
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        if b.name.trim().is_empty() || b.name.chars().count() > 120 { return Err(ApiError::invalid("그룹 이름은 1~120자여야 합니다")); }
        if !(2..=8).contains(&b.member_ids.len()) { return Err(ApiError::invalid("참여 봇은 2~8개여야 합니다")); }
        crate::projects::active_root(tx, &b.project_id)?;
        let mut seen = std::collections::HashSet::new();
        for id in &b.member_ids {
            if !seen.insert(id) { return Err(ApiError::invalid("같은 봇을 중복으로 넣을 수 없습니다")); }
            let bot = crate::bots::get(tx, id)?;
            if bot.project_id != b.project_id { return Err(ApiError::invalid("같은 프로젝트의 봇만 참여할 수 있습니다")); }
            if bot.status != "active" { return Err(ApiError::conflict("bot_inactive", "활성 봇만 그룹에 추가할 수 있습니다")); }
        }
        let sid = crate::util::new_id();
        tx.execute("INSERT INTO sessions(id,project_id,title,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)", params![sid,b.project_id,b.name.trim(),now])?;
        tx.execute("INSERT INTO bot_rooms(session_id,member_ids,created_at) VALUES(?1,?2,?3)", params![sid,serde_json::to_string(&b.member_ids)?,now])?;
        let s = crate::sessions::get(tx, &sid)?;
        crate::events::append(tx, now, "session.created", Some(&b.project_id), Some(&sid), &serde_json::to_value(s)?)?;
        crate::events::append(tx, now, "bot_room.changed", Some(&b.project_id), Some(&sid), &json!({"session_id":sid}))?;
        Ok((StatusCode::CREATED, serde_json::to_value(room(tx, &sid)?.unwrap())?))
    }).await
}

/// 공백이 든 이름은 @{봇 이름}. 일반 @이름은 긴 이름부터 단어 경계를 확인한다.
fn recipients(text: &str, members: &[RoomMember]) -> ApiResult<Vec<String>> {
    let mut found = Vec::new();
    let mut end = 0;
    let mut ordered: Vec<_> = members.iter().collect();
    ordered.sort_by_key(|m| std::cmp::Reverse(m.name.len()));
    for (at, ch) in text.char_indices() {
        if at < end || ch != '@' || (at > 0 && !text[..at].chars().next_back().unwrap().is_whitespace()) { continue; }
        let rest = &text[at + 1..];
        let (member, used) = if let Some(rest) = rest.strip_prefix('{') {
            let stop = rest.find('}').ok_or_else(|| ApiError::invalid("@{봇 이름}의 닫는 괄호가 없습니다"))?;
            (members.iter().find(|m| m.name == rest[..stop]), stop + 2)
        } else {
            let member = ordered.iter().find(|m| rest.starts_with(&m.name)
                && rest[m.name.len()..].chars().next().is_none_or(|c| c.is_whitespace() || ",.!?:;".contains(c))).copied();
            let used = member.map_or(0, |m| m.name.len());
            (member, used)
        };
        let member = member.ok_or_else(|| ApiError::invalid("그룹에 없는 봇을 멘션했어요. @{봇 이름}으로 지정하세요"))?;
        if !found.contains(&member.id) { found.push(member.id.clone()); }
        end = at + 1 + used;
    }
    if found.is_empty() { found.push(members[0].id.clone()); }
    Ok(found)
}

pub(crate) struct Binding {
    pub room: BotRoom,
    pub recipients: Vec<String>,
    pub profile: String,
    pub bot: Value,
    pub reuse_message: Option<crate::sessions::Message>,
}

fn checked_members(c: &Connection, room: &BotRoom, ids: &[String]) -> ApiResult<(String, Value)> {
    for id in ids {
        if !room.members.iter().any(|m| &m.id == id) { return Err(ApiError::invalid("그룹에 없는 봇입니다")); }
        let b = crate::bots::get(c, id)?;
        if b.project_id != room.project_id { return Err(ApiError::conflict("bot_project_changed", "참여 봇의 프로젝트가 바뀌었습니다")); }
        crate::bots::binding_for(c, id)?;
    }
    crate::bots::binding_for(c, &ids[0])
}

/// 실행 중 추가 메시지도 본문에서 지정한 봇의 모델·경계를 검사한다.
pub(crate) fn request_binding(c: &Connection, sid: &str, text: &str) -> ApiResult<Option<(Vec<String>, String)>> {
    let Some(room) = room(c, sid)? else { return Ok(None); };
    let ids = recipients(text, &room.members)?;
    let (profile, _) = checked_members(c, &room, &ids)?;
    Ok(Some((ids, profile)))
}

pub(crate) fn binding(c: &Connection, sid: &str, text: &str, source: Option<&Value>) -> ApiResult<Option<Binding>> {
    let Some(room) = room(c, sid)? else { return Ok(None); };
    if source.is_some_and(|s| s["kind"] == "schedule") {
        return Err(ApiError::invalid("그룹 대화 대신 담당 봇을 지정해 예약하세요"));
    }
    let continuation = source.and_then(|s| s.get("room_dispatch")).and_then(Value::as_str);
    let (ids, reuse_message) = if let Some(mid) = continuation {
        let (tid, status): (String, String) = c.query_row(
            "SELECT current_turn_id,status FROM bot_room_dispatches WHERE message_id=?1 AND session_id=?2", params![mid,sid], |r| Ok((r.get(0)?,r.get(1)?)))?;
        if status != "active" || crate::runner::get_turn(c, &tid)?.status != "completed" { return Err(ApiError::busy("그룹의 답변이 이미 종료됐습니다")); }
        let id = source.and_then(|s| s["room_bot_id"].as_str()).ok_or_else(|| ApiError::invalid("답변할 봇이 없습니다"))?;
        let m = c.query_row("SELECT id,session_id,seq,role,content,turn_id,created_at FROM messages WHERE id=?1 AND session_id=?2 AND rewound_at IS NULL", params![mid,sid], |r| {
            Ok(crate::sessions::Message { id:r.get(0)?,session_id:r.get(1)?,seq:r.get(2)?,role:r.get(3)?,content:serde_json::from_str(&r.get::<_,String>(4)?).unwrap_or(Value::Null),turn_id:r.get(5)?,created_at:r.get(6)? })
        })?;
        (vec![id.to_string()], Some(m))
    } else {
        let busy: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM bot_room_dispatches WHERE session_id=?1 AND status='active')", [sid], |r| r.get(0))?;
        if busy { return Err(ApiError::busy("그룹에서 아직 답변 중입니다")); }
        let ids = match source.and_then(|s| s["room_retry_bot"].as_str()) {
            Some(id) => vec![id.to_string()],
            None => recipients(text, &room.members)?,
        };
        (ids, None)
    };
    let (profile, bot) = checked_members(c, &room, &ids)?;
    Ok(Some(Binding { room, recipients: ids, profile, bot, reuse_message }))
}

pub(crate) fn record(c: &Connection, b: &Binding, message: &str, turn: &str) -> ApiResult<()> {
    if b.reuse_message.is_some() {
        c.execute("UPDATE bot_room_dispatches SET current_turn_id=?2 WHERE message_id=?1", params![message,turn])?;
    } else {
        c.execute("INSERT INTO bot_room_dispatches(message_id,session_id,current_turn_id,remaining_ids,status) VALUES(?1,?2,?3,?4,'active')",
            params![message,b.room.session_id,turn,serde_json::to_string(&b.recipients[1..])?])?;
    }
    Ok(())
}

pub(crate) fn on_turn_finished(c: &Connection, now: &str, tid: &str, status: &str) -> ApiResult<()> {
    let dispatch: Option<(String, String)> = c.query_row(
        "SELECT message_id,remaining_ids FROM bot_room_dispatches WHERE current_turn_id=?1 AND status='active'", [tid], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((mid, raw)) = dispatch else { return Ok(()); };
    let ids: Vec<String> = serde_json::from_str(&raw)?;
    if status != "completed" || ids.is_empty() {
        c.execute("UPDATE bot_room_dispatches SET status=?2 WHERE message_id=?1", params![mid,if status == "completed" {"completed"} else {"stopped"}])?;
        return Ok(());
    }
    let t = crate::runner::get_turn(c, tid)?;
    let (epoch, owner): (String, String) = c.query_row("SELECT owner_epoch,owner_key FROM turns WHERE id=?1", [tid], |r| Ok((r.get(0)?,r.get(1)?)))?;
    let text: String = c.query_row("SELECT json_extract(content,'$.text') FROM messages WHERE id=?1", [&mid], |r| r.get(0))?;
    c.execute_batch("SAVEPOINT room_next")?;
    let next = (|| -> ApiResult<()> {
        c.execute("UPDATE bot_room_dispatches SET remaining_ids=?2 WHERE message_id=?1", params![mid,serde_json::to_string(&ids[1..])?])?;
        let next_bot = crate::bots::get(c, &ids[0])?;
        crate::sessions::append_message(c, now, &t.session_id, "note", &json!({
            "type":"bot_room_next", "text":format!("{}에게 답변을 요청했어요",next_bot.name),
            "previous_bot":t.definition["bot"]["name"], "bot_name":next_bot.name,
        }), Some(tid), None)?;
        let source = json!({"kind":"bot_room","room_dispatch":mid,"room_bot_id":ids[0],"limits":t.definition["limits"]});
        let (next, _) = crate::runner::enqueue_turn(c, now, &epoch, &owner, &t.session_id, &text, "", None, t.tools_enabled, Some(&source))?;
        crate::runner::set_turn_effort(c, &next.id, t.definition["effort"].as_str())?;
        crate::runner::set_turn_service_tier(c, &next.id, t.definition["service_tier"].as_str())?;
        Ok(())
    })();
    match next {
        Ok(()) => c.execute_batch("RELEASE room_next")?,
        Err(e) => {
            c.execute_batch("ROLLBACK TO room_next; RELEASE room_next")?;
            c.execute("UPDATE bot_room_dispatches SET status='stopped' WHERE message_id=?1", [&mid])?;
            crate::sessions::append_message(c, now, &t.session_id, "note",
                &json!({"type":"bot_room_stopped","text":format!("다음 봇의 답변을 시작하지 못했어요: {}",e.message)}), Some(tid), None)?;
        }
    }
    Ok(())
}
