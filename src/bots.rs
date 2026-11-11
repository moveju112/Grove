//! 봇(BOT-001~008).
//!
//! - 봇은 위임 역할(definitions의 agent)과 별도로 저장한다. 기본 에이전트 원문은 변환하지 않는다.
//! - home 대화는 봇마다 하나다. 조건부 갱신(`home_session_id IS NULL`)과 UNIQUE 제약으로 동시 요청에도 하나만 만든다.
//! - 생성·편집만으로 모델을 부르지 않는다(인사 호출 없음). 모델이 없으면 실행만 거부한다.
//! - 모델·persona 변경은 다음 턴부터 적용한다(턴 접수 시 정의 snapshot에 고정).
//! - 숨김은 기기별 화면 상태이고(서버 저장 없음), 비활성화는 새 실행 거부, 삭제는 보관·복원 가능한 상태다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::{events, idem};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize)]
pub struct Bot {
    pub id: String,
    pub name: String,
    pub description: String,
    pub persona: String,
    pub instructions: String,
    pub profile_id: Option<String>,
    pub project_id: String,
    pub featured: bool,
    pub avatar_color: String,
    pub status: String,
    pub home_session_id: Option<String>,
    pub home_seen_seq: i64,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

const COLS: &str = "id, name, description, persona, instructions, profile_id, project_id, featured, avatar_color, status, home_session_id, home_seen_seq, \
                    revision, created_at, updated_at, deleted_at";

fn from_row(r: &Row) -> rusqlite::Result<Bot> {
    Ok(Bot {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        persona: r.get(3)?,
        instructions: r.get(4)?,
        profile_id: r.get(5)?,
        project_id: r.get(6)?,
        featured: r.get(7)?,
        avatar_color: r.get(8)?,
        status: r.get(9)?,
        home_session_id: r.get(10)?,
        home_seen_seq: r.get(11)?,
        revision: r.get(12)?,
        created_at: r.get(13)?,
        updated_at: r.get(14)?,
        deleted_at: r.get(15)?,
    })
}

/// 목록 응답: 저장값 + 서버 상태로 계산한 값.
#[derive(Debug, Clone, Serialize)]
pub struct BotView {
    #[serde(flatten)]
    pub bot: Bot,
    /// 모델 프로필이 설정되어 있고 존재하며 활성인지
    pub runnable: bool,
    /// idle | running | awaiting_approval
    pub home_status: String,
    pub unread: bool,
}

pub fn get(c: &Connection, id: &str) -> ApiResult<Bot> {
    c.query_row(&format!("SELECT {COLS} FROM bots WHERE id = ?1"), params![id], from_row)
        .optional()?
        .ok_or_else(|| ApiError::not_found("봇이 없습니다"))
}

/// 세션이 봇 대화면 그 봇(턴 접수 시 사용).
pub fn by_session(c: &Connection, session_id: &str) -> ApiResult<Option<Bot>> {
    Ok(c.query_row(&format!("SELECT {} FROM bots b JOIN sessions s ON s.bot_id = b.id WHERE s.id = ?1", prefixed()), params![session_id], from_row)
        .optional()?)
}

fn prefixed() -> String {
    COLS.split(", ").map(|c| format!("b.{}", c.trim())).collect::<Vec<_>>().join(", ")
}

fn view(c: &Connection, b: Bot) -> ApiResult<BotView> {
    let runnable = match &b.profile_id {
        Some(p) => crate::models::get_profile(c, p).is_ok_and(|profile| profile.enabled),
        None => false,
    };
    let (home_status, unread) = match &b.home_session_id {
        Some(sid) => {
            let s = crate::sessions::get(c, sid)?;
            let st = if s.pending_approvals > 0 || s.active_turn.as_deref() == Some("awaiting_approval") {
                "awaiting_approval"
            } else if s.active_turn.as_deref() == Some("awaiting_input") {
                "awaiting_input"
            } else if s.active_turn.is_some() {
                "running"
            } else {
                "idle"
            };
            (st.to_string(), s.last_message_seq > b.home_seen_seq)
        }
        None => ("idle".into(), false),
    };
    Ok(BotView { bot: b, runnable, home_status, unread })
}

fn emit(c: &Connection, now: &str, b: &Bot) -> ApiResult<()> {
    events::append(c, now, "bot.changed", Some(&b.project_id), b.home_session_id.as_deref(), &serde_json::to_value(b)?)?;
    Ok(())
}

fn check_rev(b: &Bot, rev: i64) -> ApiResult<()> {
    if b.revision != rev {
        return Err(ApiError::revision_conflict(serde_json::to_value(b)?));
    }
    Ok(())
}

fn name_conflict(e: rusqlite::Error) -> ApiError {
    match &e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
            ApiError::conflict("name_taken", "같은 이름의 봇이 이미 있습니다")
        }
        _ => e.into(),
    }
}

const COLORS: [&str; 8] = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#4b5563"];

fn valid_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SpecBody {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub persona: String,
    #[serde(default)]
    pub instructions: String,
    pub profile_id: Option<String>,
    pub project_id: String,
    #[serde(default)]
    pub featured: bool,
    pub avatar_color: Option<String>,
}

fn validate(c: &Connection, b: &SpecBody) -> ApiResult<()> {
    let n = b.name.trim();
    if n.is_empty() || n.chars().count() > 50 {
        return Err(ApiError::invalid("이름은 1~50자여야 합니다"));
    }
    if b.description.chars().count() > 500 {
        return Err(ApiError::invalid("설명은 500자 이하여야 합니다"));
    }
    if b.persona.len() > 16_000 || b.instructions.len() > 32_000 {
        return Err(ApiError::invalid("persona는 16KB, 작업 지침은 32KB 이하여야 합니다"));
    }
    if let Some(p) = &b.profile_id {
        crate::models::get_profile(c, p)?;
    }
    crate::projects::active_root(c, &b.project_id)?;
    if b.avatar_color.as_deref().is_some_and(|c| !valid_color(c)) {
        return Err(ApiError::invalid("아바타 색은 #RRGGBB 형식이어야 합니다"));
    }
    Ok(())
}

/// 대표 봇은 하나다.
fn set_featured(c: &Connection, now: &str, id: &str, on: bool) -> ApiResult<()> {
    if on {
        let others: Vec<String> = {
            let mut st = c.prepare("SELECT id FROM bots WHERE featured = 1 AND id != ?1")?;
            st.query_map(params![id], |r| r.get(0))?.collect::<Result<_, _>>()?
        };
        for o in others {
            c.execute("UPDATE bots SET featured = 0, revision = revision + 1, updated_at = ?2 WHERE id = ?1", params![o, now])?;
            emit(c, now, &get(c, &o)?)?;
        }
    }
    c.execute("UPDATE bots SET featured = ?2 WHERE id = ?1", params![id, on])?;
    Ok(())
}

fn order_ids(c: &Connection) -> ApiResult<(Vec<String>, i64)> {
    let (ids, rev): (String, i64) = c.query_row("SELECT ids, revision FROM bot_order WHERE singleton = 1", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok((serde_json::from_str(&ids).unwrap_or_default(), rev))
}

// ---- API ----

pub async fn list(State(app): State<App>, _p: Principal) -> ApiResult<Json<Value>> {
    let v = app
        .db
        .call(|c| {
            let bots: Vec<Bot> = {
                let mut st = c.prepare(&format!("SELECT {COLS} FROM bots ORDER BY created_at"))?;
                st.query_map([], from_row)?.collect::<Result<_, _>>()?
            };
            let (order, order_revision) = order_ids(c)?;
            let pos = |id: &str| order.iter().position(|x| x == id).unwrap_or(usize::MAX);
            let mut views = bots.into_iter().map(|b| view(c, b)).collect::<ApiResult<Vec<_>>>()?;
            // 대표 → 사용자 순서 → 생성 순(정렬 안정)
            views.sort_by_key(|v| (!v.bot.featured, pos(&v.bot.id)));
            Ok(json!({ "bots": views, "order_revision": order_revision }))
        })
        .await?;
    Ok(Json(v))
}

pub async fn show(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<BotView>> {
    Ok(Json(app.db.call(move |c| view(c, get(c, &id)?)).await?))
}

pub async fn create(State(app): State<App>, p: Principal, headers: HeaderMap, Json(b): Json<SpecBody>) -> ApiResult<Response> {
    let h = idem::body_hash("bot.create", &serde_json::to_value(&b)?);
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        validate(tx, &b)?;
        let id = crate::util::new_id();
        let n: i64 = tx.query_row("SELECT COUNT(*) FROM bots", [], |r| r.get(0))?;
        let color = b.avatar_color.clone().unwrap_or_else(|| COLORS[n as usize % COLORS.len()].to_string());
        tx.execute(
            "INSERT INTO bots (id, name, description, persona, instructions, profile_id, project_id, avatar_color, status, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?9)",
            params![id, b.name.trim(), b.description, b.persona, b.instructions, b.profile_id, b.project_id, color, now],
        )
        .map_err(name_conflict)?;
        set_featured(tx, now, &id, b.featured)?;
        let bot = get(tx, &id)?;
        emit(tx, now, &bot)?;
        Ok((StatusCode::CREATED, serde_json::to_value(view(tx, bot)?)?))
    })
    .await
}

#[derive(Deserialize)]
pub struct UpdateBody {
    pub expected_revision: i64,
    #[serde(flatten)]
    pub spec: SpecBody,
}

pub async fn update(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<UpdateBody>) -> ApiResult<Response> {
    let h = idem::body_hash("bot.update", &json!({ "i": id, "r": b.expected_revision, "s": b.spec }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get(tx, &id)?;
        check_rev(&cur, b.expected_revision)?;
        if cur.status == "deleted" {
            return Err(ApiError::conflict("deleted", "삭제된 봇은 복원 후 수정하세요"));
        }
        let s = &b.spec;
        validate(tx, s)?;
        // home 대화가 생긴 뒤에는 프로젝트를 바꾸지 않는다(이력·도구 경계가 섞이지 않게).
        if cur.home_session_id.is_some() && s.project_id != cur.project_id {
            return Err(ApiError::conflict("project_locked", "대화가 있는 봇의 프로젝트는 바꿀 수 없습니다. 대화를 초기화한 뒤 바꾸세요"));
        }
        tx.execute(
            "UPDATE bots SET name = ?2, description = ?3, persona = ?4, instructions = ?5, profile_id = ?6, project_id = ?7, avatar_color = ?8, \
             revision = revision + 1, updated_at = ?9 WHERE id = ?1",
            params![id, s.name.trim(), s.description, s.persona, s.instructions, s.profile_id, s.project_id, s.avatar_color.clone().unwrap_or(cur.avatar_color.clone()), now],
        )
        .map_err(name_conflict)?;
        set_featured(tx, now, &id, s.featured)?;
        let bot = get(tx, &id)?;
        emit(tx, now, &bot)?;
        Ok((StatusCode::OK, serde_json::to_value(view(tx, bot)?)?))
    })
    .await
}

/// home 대화를 가져오거나 만든다. 동시에 여러 기기가 불러도 하나만 만든다.
pub fn ensure_home(c: &Connection, now: &str, id: &str) -> ApiResult<Bot> {
    let b = get(c, id)?;
    if b.status == "deleted" {
        return Err(ApiError::conflict("deleted", "삭제된 봇입니다"));
    }
    if b.home_session_id.is_some() {
        return Ok(b);
    }
    crate::projects::active_root(c, &b.project_id)?;
    let sid = crate::util::new_id();
    c.execute(
        "INSERT INTO sessions (id, project_id, title, created_at, updated_at, bot_id) VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
        params![sid, b.project_id, b.name, now, id],
    )?;
    let n = c.execute("UPDATE bots SET home_session_id = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?1 AND home_session_id IS NULL", params![id, sid, now])?;
    if n == 0 {
        // 다른 요청이 먼저 만들었다(직렬화된 쓰기에서는 일어나지 않지만 조건으로 막는다).
        return Err(ApiError::busy("home 대화를 만드는 중입니다. 다시 시도하세요"));
    }
    let s = crate::sessions::get(c, &sid)?;
    events::append(c, now, "session.created", Some(&b.project_id), Some(&sid), &serde_json::to_value(&s)?)?;
    let b = get(c, id)?;
    emit(c, now, &b)?;
    Ok(b)
}

/// home 열기: 멱등 키 없이 불러도 같은 대화를 돌려준다(GET 성격의 get-or-create).
pub async fn open_home(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<BotView>> {
    let now = app.now();
    let v = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let b = ensure_home(&tx, &now, &id)?;
            let v = view(&tx, b)?;
            tx.commit()?;
            Ok(v)
        })
        .await?;
    app.notify_events().await;
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct StatusBody {
    pub expected_revision: i64,
    /// disable | enable | delete | restore | reset
    pub action: String,
}

pub async fn set_status(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<StatusBody>) -> ApiResult<Response> {
    let h = idem::body_hash("bot.status", &json!({ "i": id, "r": b.expected_revision, "a": b.action }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get(tx, &id)?;
        check_rev(&cur, b.expected_revision)?;
        match (b.action.as_str(), cur.status.as_str()) {
            ("disable", "active") => {
                tx.execute("UPDATE bots SET status = 'disabled' WHERE id = ?1", params![id])?;
            }
            ("enable", "disabled") => {
                tx.execute("UPDATE bots SET status = 'active' WHERE id = ?1", params![id])?;
            }
            ("delete", "active" | "disabled") => {
                // 대화는 지우지 않고 보관한다. 보관할 수 없으면(실행 중 등) 삭제도 하지 않는다.
                if let Some(sid) = &cur.home_session_id {
                    crate::sessions::archive_checked(tx, now, sid)?;
                }
                tx.execute("UPDATE bots SET status = 'deleted', featured = 0, deleted_at = ?2 WHERE id = ?1", params![id, now])?;
            }
            ("restore", "deleted") => {
                tx.execute("UPDATE bots SET status = 'active', deleted_at = NULL WHERE id = ?1", params![id]).map_err(name_conflict)?;
                if let Some(sid) = &cur.home_session_id {
                    tx.execute("UPDATE sessions SET archived_at = NULL, revision = revision + 1, updated_at = ?2 WHERE id = ?1", params![sid, now])?;
                    let s = crate::sessions::get(tx, sid)?;
                    events::append(tx, now, "session.updated", Some(&s.project_id), Some(sid), &serde_json::to_value(&s)?)?;
                }
            }
            ("reset", "active" | "disabled") => {
                // 초기화 = 현재 대화 보관 성공 → 연결 해제. 보관이 실패하면 아무것도 바꾸지 않는다(같은 transaction).
                let Some(sid) = &cur.home_session_id else {
                    return Err(ApiError::conflict("no_home", "초기화할 대화가 없습니다"));
                };
                crate::sessions::archive_checked(tx, now, sid)?;
                tx.execute("UPDATE bots SET home_session_id = NULL, home_seen_seq = 0 WHERE id = ?1", params![id])?;
            }
            (a, s) => return Err(ApiError::conflict("invalid_state", format!("{s} 상태에서는 {a}를 할 수 없습니다"))),
        }
        tx.execute("UPDATE bots SET revision = revision + 1, updated_at = ?2 WHERE id = ?1", params![id, now])?;
        let bot = get(tx, &id)?;
        emit(tx, now, &bot)?;
        Ok((StatusCode::OK, serde_json::to_value(view(tx, bot)?)?))
    })
    .await
}

#[derive(Deserialize)]
pub struct SeenBody {
    pub seq: i64,
}

/// 읽음 위치(뒤로 가지 않음).
pub async fn seen(State(app): State<App>, _p: Principal, Path(id): Path<String>, Json(b): Json<SeenBody>) -> ApiResult<Json<Value>> {
    let now = app.now();
    app.db
        .call(move |c| {
            let n = c.execute("UPDATE bots SET home_seen_seq = ?2 WHERE id = ?1 AND home_seen_seq < ?2", params![id, b.seq])?;
            if n > 0 {
                let bot = get(c, &id)?;
                events::append(c, &now, "bot.seen", Some(&bot.project_id), None, &json!({ "id": id, "seq": b.seq }))?;
            }
            Ok(())
        })
        .await?;
    app.notify_events().await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct OrderBody {
    pub expected_revision: i64,
    pub ids: Vec<String>,
}

pub async fn reorder(State(app): State<App>, p: Principal, headers: HeaderMap, Json(b): Json<OrderBody>) -> ApiResult<Response> {
    let h = idem::body_hash("bot.order", &json!({ "r": b.expected_revision, "i": b.ids }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let (cur, rev) = order_ids(tx)?;
        if rev != b.expected_revision {
            return Err(ApiError::revision_conflict(json!({ "ids": cur, "revision": rev })));
        }
        let mut seen = std::collections::HashSet::new();
        for i in &b.ids {
            if !seen.insert(i) {
                return Err(ApiError::invalid("중복된 봇 ID가 있습니다"));
            }
            get(tx, i)?;
        }
        tx.execute("UPDATE bot_order SET ids = ?1, revision = revision + 1 WHERE singleton = 1", params![serde_json::to_string(&b.ids)?])?;
        events::append(tx, now, "bot.order", None, None, &json!({ "ids": b.ids, "revision": rev + 1 }))?;
        Ok((StatusCode::OK, json!({ "ids": b.ids, "revision": rev + 1 })))
    })
    .await
}

/// 턴 접수 시 봇 대화 확인: 실행 가능한 봇이면 (프로필, snapshot) 반환.
pub fn turn_binding(c: &Connection, session_id: &str) -> ApiResult<Option<(String, Value)>> {
    let Some(b) = by_session(c, session_id)? else {
        return Ok(None);
    };
    match b.status.as_str() {
        "active" => {}
        "disabled" => return Err(ApiError::conflict("bot_disabled", "비활성화된 봇입니다. 다시 켠 뒤 보내세요")),
        _ => return Err(ApiError::conflict("deleted", "삭제된 봇입니다")),
    }
    let profile = b.profile_id.clone().ok_or_else(|| ApiError::conflict("model_not_configured", "이 봇에 모델이 설정되지 않아 실행할 수 없습니다"))?;
    crate::models::get_profile(c, &profile).map_err(|_| ApiError::conflict("model_not_configured", "이 봇의 모델 프로필이 없습니다"))?;
    Ok(Some((
        profile,
        json!({ "id": b.id, "name": b.name, "revision": b.revision, "persona": b.persona, "instructions": b.instructions }),
    )))
}

#[cfg(test)]
mod tests {
    #[test]
    fn color_validation() {
        assert!(super::valid_color("#00aaFF"));
        assert!(!super::valid_color("red"));
        assert!(!super::valid_color("#12345g"));
        assert!(!super::valid_color("javascript:x"));
    }
}
