//! 최근 항목(RECENT/RECENCY)·기기별 분할 배치(LAYOUT/PANE)·서버 초안(RECENCY-005).

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::idem;
use crate::util::parse_time;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

// ---------------- 최근 항목 ----------------

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct RecentItem {
    pub id: String,
    pub kind: String,
    pub project_id: String,
    pub project_name: String,
    pub resource_id: String,
    pub title: String,
    pub last_access_at: String,
    pub pinned: bool,
    pub hidden: bool,
    #[ts(type = "unknown")]
    pub view_state: Value,
    pub revision: i64,
    /// 서버 상태로 계산한 값: active | running | awaiting_approval | awaiting_input | unknown_result | archived | missing | project_unavailable
    pub status: String,
    pub unread: bool,
    /// 대화의 마지막 사용자 메시지 시각(되돌린 메시지 제외). 다른 종류는 없음.
    pub last_user_message_at: Option<String>,
    /// 정렬·시간 범위 기준: 마지막 접근과 마지막 사용자 메시지 중 늦은 시각.
    pub last_activity_at: String,
}

const RCOLS: &str = "r.id, r.kind, r.project_id, p.name, r.resource_id, r.title, r.last_access_at, r.pinned, r.hidden, r.view_state, r.revision, \
    p.archived_at, p.root_path, s.id, s.archived_at, s.last_message_seq, \
    (SELECT CASE WHEN t.status = 'awaiting_approval' \
        AND EXISTS (SELECT 1 FROM tool_calls q WHERE q.session_id = s.id AND q.turn_id = t.id AND q.status = 'awaiting_input') \
        AND NOT EXISTS (SELECT 1 FROM tool_calls a WHERE a.session_id = s.id AND a.turn_id = t.id AND a.status = 'pending_approval') \
        THEN 'awaiting_input' ELSE t.status END \
        FROM turns t WHERE t.session_id = s.id AND t.status IN ('queued','running','awaiting_approval')), \
    (SELECT COUNT(*) FROM tool_calls c WHERE c.session_id = s.id AND c.status = 'pending_approval'), \
    (SELECT COUNT(*) FROM tool_calls c WHERE c.session_id = s.id AND c.status = 'unknown' AND c.reviewed_at IS NULL), \
    COALESCE(s.title, r.title), r.hidden_at, \
    (SELECT m.created_at FROM messages m WHERE m.session_id = s.id AND m.role = 'user' AND m.rewound_at IS NULL ORDER BY m.seq DESC LIMIT 1)";

/// 늦은 시각. 형식이 다른 RFC3339 문자열도 실제 시각으로 비교한다.
fn later(a: &str, b: Option<&str>) -> String {
    match b {
        Some(b) if parse_time(b).zip(parse_time(a)).is_some_and(|(b, a)| b > a) => b.to_string(),
        _ => a.to_string(),
    }
}

const RFROM: &str = "FROM recent_items r JOIN projects p ON p.id = r.project_id \
    LEFT JOIN sessions s ON r.kind = 'session' AND s.id = r.resource_id";

fn recent_from_row(r: &Row) -> rusqlite::Result<RecentItem> {
    let kind: String = r.get(1)?;
    let view: String = r.get(9)?;
    let view_state: Value = serde_json::from_str(&view).unwrap_or(json!({}));
    let project_archived: Option<String> = r.get(11)?;
    let root: String = r.get(12)?;
    let sid: Option<String> = r.get(13)?;
    let s_archived: Option<String> = r.get(14)?;
    let last_seq: Option<i64> = r.get(15)?;
    let active: Option<String> = r.get(16)?;
    let pending: i64 = r.get(17)?;
    let unknown: i64 = r.get(18)?;
    let status = if project_archived.is_some() || !std::path::Path::new(&root).is_dir() {
        "project_unavailable"
    } else if kind == "session" && sid.is_none() {
        "missing"
    } else if s_archived.is_some() {
        "archived"
    } else if pending > 0 || active.as_deref() == Some("awaiting_approval") {
        "awaiting_approval"
    } else if active.as_deref() == Some("awaiting_input") {
        "awaiting_input"
    } else if active.is_some() {
        "running"
    } else if unknown > 0 {
        "unknown_result"
    } else {
        "active"
    };
    let seen = view_state.get("last_seen_seq").and_then(Value::as_i64).unwrap_or(0);
    let last_access: String = r.get(6)?;
    let hidden_at: Option<String> = r.get(20)?;
    let last_user: Option<String> = r.get(21)?;
    // 원본 최근 탭처럼 숨긴 뒤 새 사용자 메시지가 오면 다시 보인다. 숨긴 시각이 없는 이전 숨김은 유지한다.
    let revived = hidden_at.as_deref().and_then(parse_time).zip(last_user.as_deref().and_then(parse_time)).is_some_and(|(h, m)| m > h);
    let hidden: bool = r.get::<_, bool>(8)? && !revived;
    Ok(RecentItem {
        id: r.get(0)?,
        kind,
        project_id: r.get(2)?,
        project_name: r.get(3)?,
        resource_id: r.get(4)?,
        title: r.get(19)?,
        last_activity_at: later(&last_access, last_user.as_deref()),
        last_access_at: last_access,
        pinned: r.get(7)?,
        hidden,
        view_state,
        revision: r.get(10)?,
        status: status.into(),
        unread: last_seq.is_some_and(|s| s > seen),
        last_user_message_at: last_user,
    })
}

fn get_recent(conn: &Connection, id: &str) -> ApiResult<RecentItem> {
    conn.query_row(&format!("SELECT {RCOLS} {RFROM} WHERE r.id = ?1"), params![id], recent_from_row)
        .optional()?
        .ok_or_else(|| ApiError::not_found("최근 항목이 없습니다"))
}

#[derive(Deserialize)]
pub struct Touch {
    pub kind: String,
    pub project_id: String,
    pub resource_id: String,
    pub title: Option<String>,
    pub view_state: Option<Value>,
}

fn validate_view_state(v: &Value) -> ApiResult<()> {
    if !v.is_object() || v.to_string().len() > 16 * 1024 {
        return Err(ApiError::invalid("view_state는 16KiB 이하 객체여야 합니다"));
    }
    Ok(())
}

/// 자원을 열 때 호출한다. 같은 자원은 항목 하나만 유지하고 접근 시각만 갱신한다(RECENCY-002).
pub async fn touch(State(app): State<App>, p: Principal, headers: HeaderMap, Json(b): Json<Touch>) -> ApiResult<Response> {
    if !matches!(b.kind.as_str(), "session" | "file" | "terminal" | "project") {
        return Err(ApiError::invalid("알 수 없는 항목 종류입니다"));
    }
    if b.resource_id.is_empty() || b.resource_id.len() > 4096 {
        return Err(ApiError::invalid("resource_id가 올바르지 않습니다"));
    }
    if let Some(v) = &b.view_state {
        validate_view_state(v)?;
    }
    let h = idem::body_hash("recent.touch", &json!({ "k": b.kind, "p": b.project_id, "r": b.resource_id, "t": b.title, "v": b.view_state }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        crate::projects::get(tx, &b.project_id)?;
        let title = match b.kind.as_str() {
            "session" => {
                let s = crate::sessions::get(tx, &b.resource_id)?;
                if s.project_id != b.project_id {
                    return Err(ApiError::invalid("세션이 다른 프로젝트에 속합니다"));
                }
                s.title
            }
            "project" => crate::projects::get(tx, &b.resource_id)?.name,
            _ => b.title.clone().unwrap_or_else(|| b.resource_id.clone()),
        };
        let id = crate::util::new_id();
        tx.execute(
            "INSERT INTO recent_items (id, kind, project_id, resource_id, title, last_access_at, view_state) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(kind, project_id, resource_id) DO UPDATE SET last_access_at = ?6, hidden = 0, hidden_at = NULL, title = ?5, \
             view_state = CASE WHEN ?8 THEN ?7 ELSE view_state END, revision = revision + 1",
            params![id, b.kind, b.project_id, b.resource_id, title, now, b.view_state.clone().unwrap_or(json!({})).to_string(), b.view_state.is_some()],
        )?;
        let rid: String = tx.query_row(
            "SELECT id FROM recent_items WHERE kind = ?1 AND project_id = ?2 AND resource_id = ?3",
            params![b.kind, b.project_id, b.resource_id],
            |r| r.get(0),
        )?;
        let item = get_recent(tx, &rid)?;
        events::append(tx, now, "recent.updated", Some(&b.project_id), None, &serde_json::to_value(&item)?)?;
        Ok((StatusCode::OK, serde_json::to_value(item)?))
    })
    .await
}

#[derive(Deserialize)]
pub struct RecentQuery {
    /// all | pinned | running | awaiting_approval | awaiting_input | unread | hidden
    pub filter: Option<String>,
    pub q: Option<String>,
    pub project_id: Option<String>,
    /// 시간 범위(RFC3339). 이 시각 이후 활동한 항목과, 범위와 무관하게 고정·실행 중·승인/답변 대기 항목을 보여 준다.
    pub since: Option<String>,
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Serialize, ts_rs::TS)]
pub struct RecentPage {
    pub items: Vec<RecentItem>,
    pub next_offset: Option<i64>,
    pub total: i64,
}

pub async fn list(State(app): State<App>, _p: Principal, Query(q): Query<RecentQuery>) -> ApiResult<Json<RecentPage>> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).max(0);
    let filter = q.filter.unwrap_or_else(|| "all".into());
    if !matches!(filter.as_str(), "all" | "pinned" | "running" | "awaiting_approval" | "awaiting_input" | "unread" | "hidden") {
        return Err(ApiError::invalid("알 수 없는 필터입니다"));
    }
    let needle = q.q.unwrap_or_default().to_lowercase();
    let project = q.project_id;
    let since = match q.since.as_deref() {
        None | Some("") => None,
        Some(s) => Some(parse_time(s).ok_or_else(|| ApiError::invalid("since는 RFC3339 시각이어야 합니다"))?),
    };
    let page = app
        .db
        .call(move |c| {
            // 상태 필터는 서버 상태로 계산하므로 전체를 정렬한 뒤 걸러낸다. PERF(port): 항목 수가 매우 많으면 SQL 조건으로 내린다.
            let sql = format!(
                "SELECT {RCOLS} {RFROM} WHERE (?1 IS NULL OR r.project_id = ?1) \
                 ORDER BY r.pinned DESC, r.last_access_at DESC, r.id DESC"
            );
            let mut st = c.prepare(&sql)?;
            let mut all = st.query_map(params![project], recent_from_row)?.collect::<Result<Vec<_>, _>>()?;
            // 고정 먼저, 그다음 마지막 활동(접근·사용자 메시지) 최신순. 같은 시각은 SQL 순서를 유지한다.
            let activity = |i: &RecentItem| parse_time(&i.last_activity_at);
            all.sort_by(|a, b| b.pinned.cmp(&a.pinned).then_with(|| activity(b).cmp(&activity(a))));
            let filtered: Vec<RecentItem> = all
                .into_iter()
                .filter(|i| match filter.as_str() {
                    "hidden" => i.hidden,
                    _ if i.hidden => false,
                    "pinned" => i.pinned,
                    "running" => i.status == "running",
                    "awaiting_approval" => i.status == "awaiting_approval",
                    "awaiting_input" => i.status == "awaiting_input",
                    "unread" => i.unread,
                    _ => true,
                })
                .filter(|i| {
                    let Some(since) = since else { return true };
                    i.pinned
                        || matches!(i.status.as_str(), "running" | "awaiting_approval" | "awaiting_input")
                        || parse_time(&i.last_activity_at).is_some_and(|t| t >= since)
                })
                .filter(|i| {
                    needle.is_empty()
                        || i.title.to_lowercase().contains(&needle)
                        || i.project_name.to_lowercase().contains(&needle)
                        // 파일·터미널은 경로/이름으로 찾되, 세션·프로젝트의 내부 UUID는 검색 대상이 아니다.
                        || (matches!(i.kind.as_str(), "file" | "terminal") && i.resource_id.to_lowercase().contains(&needle))
                })
                .collect();
            let total = filtered.len() as i64;
            let items: Vec<RecentItem> = filtered.into_iter().skip(offset as usize).take(limit as usize).collect();
            let next = (offset + (items.len() as i64) < total).then_some(offset + items.len() as i64);
            Ok(RecentPage { items, next_offset: next, total })
        })
        .await?;
    Ok(Json(page))
}

#[derive(Deserialize)]
pub struct UpdateRecent {
    pub expected_revision: i64,
    pub pinned: Option<bool>,
    pub hidden: Option<bool>,
    pub view_state: Option<Value>,
}

pub async fn update(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<UpdateRecent>,
) -> ApiResult<Response> {
    if let Some(v) = &b.view_state {
        validate_view_state(v)?;
    }
    let h = idem::body_hash("recent.update", &json!({ "id": id, "rev": b.expected_revision, "p": b.pinned, "h": b.hidden, "v": b.view_state }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get_recent(tx, &id)?;
        if cur.revision != b.expected_revision {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        // 숨김을 바꿀 때만 숨긴 시각을 새로 기록한다. 다른 수정은 기존 숨김 기준을 유지한다.
        let hidden = b.hidden.unwrap_or(cur.hidden);
        tx.execute(
            "UPDATE recent_items SET pinned = ?2, hidden = ?3, view_state = ?4, revision = revision + 1, \
             hidden_at = CASE WHEN ?5 THEN (CASE WHEN ?3 THEN ?6 ELSE NULL END) ELSE hidden_at END WHERE id = ?1",
            params![
                id,
                b.pinned.unwrap_or(cur.pinned),
                hidden,
                b.view_state.unwrap_or(cur.view_state).to_string(),
                b.hidden.is_some(),
                now
            ],
        )?;
        let item = get_recent(tx, &id)?;
        events::append(tx, now, "recent.updated", Some(&item.project_id), None, &serde_json::to_value(&item)?)?;
        Ok((StatusCode::OK, serde_json::to_value(item)?))
    })
    .await
}

// ---------------- 기기별 레이아웃 ----------------

pub const LAYOUT_SCHEMA: i64 = 1;
const MAX_LEAVES: usize = 16;
const MAX_TABS: usize = 64;

/// split tree 검증(PANE-001, PANE-002, PANE-008).
/// node = {type:"split", direction:"row"|"column", ratio:0.1..0.9, children:[node,node]}
///      | {type:"leaf", id, tabs:[{id, kind, project_id, resource_id}], active_tab}
pub fn validate_layout(v: &Value) -> ApiResult<()> {
    if v["schema"].as_i64() != Some(LAYOUT_SCHEMA) {
        return Err(ApiError::invalid(format!("layout.schema는 {LAYOUT_SCHEMA}이어야 합니다")));
    }
    let mut leaves = 0;
    let mut tabs = 0;
    let mut ids = std::collections::HashSet::new();
    fn walk(n: &Value, depth: usize, leaves: &mut usize, tabs: &mut usize, ids: &mut std::collections::HashSet<String>) -> ApiResult<()> {
        if depth > 8 {
            return Err(ApiError::invalid("분할 깊이는 8 이하여야 합니다"));
        }
        match n["type"].as_str() {
            Some("split") => {
                if !matches!(n["direction"].as_str(), Some("row" | "column")) {
                    return Err(ApiError::invalid("direction은 row 또는 column이어야 합니다"));
                }
                let r = n["ratio"].as_f64().unwrap_or(-1.0);
                if !(0.1..=0.9).contains(&r) {
                    return Err(ApiError::invalid("ratio는 0.1~0.9여야 합니다"));
                }
                let ch = n["children"].as_array().ok_or_else(|| ApiError::invalid("children이 필요합니다"))?;
                if ch.len() != 2 {
                    return Err(ApiError::invalid("split은 자식 두 개여야 합니다"));
                }
                for c in ch {
                    walk(c, depth + 1, leaves, tabs, ids)?;
                }
                Ok(())
            }
            Some("leaf") => {
                *leaves += 1;
                let id = n["id"].as_str().ok_or_else(|| ApiError::invalid("leaf.id가 필요합니다"))?;
                if !ids.insert(id.to_string()) {
                    return Err(ApiError::invalid("leaf ID가 중복되었습니다"));
                }
                let ts = n["tabs"].as_array().ok_or_else(|| ApiError::invalid("leaf.tabs가 필요합니다"))?;
                for t in ts {
                    *tabs += 1;
                    let tid = t["id"].as_str().ok_or_else(|| ApiError::invalid("tab.id가 필요합니다"))?;
                    if !ids.insert(format!("tab:{tid}")) {
                        return Err(ApiError::invalid("tab ID가 중복되었습니다"));
                    }
                    if !matches!(t["kind"].as_str(), Some("session" | "file" | "terminal" | "project" | "settings")) {
                        return Err(ApiError::invalid("tab.kind가 올바르지 않습니다"));
                    }
                    if t["kind"] != "settings" && t["project_id"].as_str().is_none_or(str::is_empty) {
                        return Err(ApiError::invalid("tab은 project_id에 고정되어야 합니다"));
                    }
                }
                if let Some(a) = n["active_tab"].as_str() {
                    if !ts.iter().any(|t| t["id"] == a) {
                        return Err(ApiError::invalid("active_tab이 tabs에 없습니다"));
                    }
                }
                Ok(())
            }
            _ => Err(ApiError::invalid("node.type은 split 또는 leaf여야 합니다")),
        }
    }
    walk(&v["root"], 0, &mut leaves, &mut tabs, &mut ids)?;
    if leaves > MAX_LEAVES || tabs > MAX_TABS {
        return Err(ApiError::invalid(format!("pane은 {MAX_LEAVES}개, tab은 {MAX_TABS}개 이하여야 합니다")));
    }
    if let Some(f) = v["focused_leaf"].as_str() {
        if !ids.contains(f) {
            return Err(ApiError::invalid("focused_leaf가 없습니다"));
        }
    }
    Ok(())
}

fn valid_device_id(id: &str) -> ApiResult<()> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err(ApiError::invalid("device_id 형식이 올바르지 않습니다"));
    }
    Ok(())
}

pub async fn get_layout(State(app): State<App>, _p: Principal, Path(device): Path<String>) -> ApiResult<Json<Value>> {
    valid_device_id(&device)?;
    let v = app
        .db
        .call(move |c| {
            let row: Option<(String, i64, String)> = c
                .query_row("SELECT layout, revision, updated_at FROM layouts WHERE device_id = ?1", params![device], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .optional()?;
            Ok(match row {
                Some((l, rev, at)) => json!({ "layout": serde_json::from_str::<Value>(&l)?, "revision": rev, "updated_at": at }),
                None => json!({ "layout": null, "revision": 0, "updated_at": null }),
            })
        })
        .await?;
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct PutLayout {
    pub expected_revision: i64,
    pub layout: Value,
}

pub async fn put_layout(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path(device): Path<String>,
    Json(b): Json<PutLayout>,
) -> ApiResult<Response> {
    valid_device_id(&device)?;
    validate_layout(&b.layout)?;
    if b.layout.to_string().len() > 64 * 1024 {
        return Err(ApiError::invalid("layout은 64KiB 이하여야 합니다"));
    }
    let h = idem::body_hash("layout.put", &json!({ "d": device, "rev": b.expected_revision, "l": b.layout }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur: Option<(i64, String)> = tx
            .query_row("SELECT revision, layout FROM layouts WHERE device_id = ?1", params![device], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        let cur_rev = cur.as_ref().map(|c| c.0).unwrap_or(0);
        if cur_rev != b.expected_revision {
            let layout = cur.map(|c| serde_json::from_str::<Value>(&c.1).unwrap_or(Value::Null)).unwrap_or(Value::Null);
            return Err(ApiError::revision_conflict(json!({ "layout": layout, "revision": cur_rev })));
        }
        tx.execute(
            "INSERT INTO layouts (device_id, layout, revision, updated_at) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(device_id) DO UPDATE SET layout = ?2, revision = ?3, updated_at = ?4",
            params![device, b.layout.to_string(), cur_rev + 1, now],
        )?;
        events::append(tx, now, "layout.updated", None, None, &json!({ "device_id": device, "revision": cur_rev + 1 }))?;
        Ok((StatusCode::OK, json!({ "layout": b.layout, "revision": cur_rev + 1, "updated_at": now })))
    })
    .await
}

// ---------------- 서버 초안 ----------------

fn check_resource_key(conn: &Connection, key: &str) -> ApiResult<()> {
    match key.split_once(':') {
        Some(("session", id)) => crate::sessions::get(conn, id).map(|_| ()),
        Some(("project", id)) => crate::projects::get(conn, id).map(|_| ()),
        _ => Err(ApiError::invalid("resource_key는 session:<id> 또는 project:<id>여야 합니다")),
    }
}

#[derive(Serialize, ts_rs::TS)]
pub struct Draft {
    pub resource_key: String,
    pub text: String,
    pub revision: i64,
    pub device_name: String,
    pub updated_at: Option<String>,
}

fn load_draft(conn: &Connection, key: &str) -> ApiResult<Draft> {
    Ok(conn
        .query_row("SELECT text, revision, device_name, updated_at FROM drafts WHERE resource_key = ?1", params![key], |r| {
            Ok(Draft { resource_key: key.into(), text: r.get(0)?, revision: r.get(1)?, device_name: r.get(2)?, updated_at: r.get(3)? })
        })
        .optional()?
        .unwrap_or(Draft { resource_key: key.into(), text: String::new(), revision: 0, device_name: String::new(), updated_at: None }))
}

pub async fn get_draft(State(app): State<App>, _p: Principal, Path(key): Path<String>) -> ApiResult<Json<Draft>> {
    Ok(Json(
        app.db
            .call(move |c| {
                check_resource_key(c, &key)?;
                load_draft(c, &key)
            })
            .await?,
    ))
}

#[derive(Deserialize)]
pub struct PutDraft {
    pub expected_revision: i64,
    pub text: String,
    pub device_name: String,
}

/// 명시적 기기 간 초안 저장. revision이 다르면 서버 값을 돌려주고 덮어쓰지 않는다(무음 덮어쓰기 금지).
pub async fn put_draft(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path(key): Path<String>,
    Json(b): Json<PutDraft>,
) -> ApiResult<Response> {
    if b.text.chars().count() > crate::sessions::MAX_MESSAGE_CHARS {
        return Err(ApiError::invalid("초안이 너무 깁니다"));
    }
    let device_name: String = b.device_name.chars().take(80).collect();
    let h = idem::body_hash("draft.put", &json!({ "k": key, "rev": b.expected_revision, "t": b.text, "d": device_name }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        check_resource_key(tx, &key)?;
        let cur = load_draft(tx, &key)?;
        if cur.revision != b.expected_revision {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        let rev = cur.revision + 1;
        tx.execute(
            "INSERT INTO drafts (resource_key, text, revision, device_name, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(resource_key) DO UPDATE SET text = ?2, revision = ?3, device_name = ?4, updated_at = ?5",
            params![key, b.text, rev, device_name, now],
        )?;
        let d = load_draft(tx, &key)?;
        events::append(tx, now, "draft.updated", None, None, &json!({ "resource_key": key, "revision": rev, "device_name": device_name }))?;
        Ok((StatusCode::OK, serde_json::to_value(d)?))
    })
    .await
}
