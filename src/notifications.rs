//! 영속 알림(AUTO-011/012). 기기가 접속하지 않아도 서버에 남고, 접속하면 목록·이벤트로 받는다.
//! 알림은 모델을 다시 부르지 않는다(완료 알림과 모델 후속 호출 분리).

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::events;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct Notification {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub ref_id: Option<String>,
    pub created_at: String,
    pub delivered_at: Option<String>,
    pub read_at: Option<String>,
}

/// 같은 transaction에서 알림과 이벤트를 기록한다.
#[allow(clippy::too_many_arguments)]
pub fn push(c: &Connection, now: &str, kind: &str, title: &str, body: &str, project_id: Option<&str>, session_id: Option<&str>, ref_id: Option<&str>) -> ApiResult<Notification> {
    let id = crate::util::new_id();
    let body: String = body.chars().take(2000).collect();
    c.execute(
        "INSERT INTO notifications (id, kind, title, body, project_id, session_id, ref_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, kind, title, body, project_id, session_id, ref_id, now],
    )?;
    let n = Notification {
        id,
        kind: kind.into(),
        title: title.into(),
        body,
        project_id: project_id.map(String::from),
        session_id: session_id.map(String::from),
        ref_id: ref_id.map(String::from),
        created_at: now.into(),
        delivered_at: None,
        read_at: None,
    };
    events::append(c, now, "notification.created", project_id, session_id, &serde_json::to_value(&n)?)?;
    Ok(n)
}

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub unread: bool,
    pub limit: Option<i64>,
    /// 이전 페이지의 next_cursor. 그보다 오래된 알림부터 돌려준다.
    pub before: Option<String>,
    /// 명령 receipt의 run ID 등 결과 참조로 전달 상태를 확인한다.
    pub ref_id: Option<String>,
}

/// cursor = "<created_at>|<id>" (새 알림이 생겨도 페이지가 밀리지 않는 keyset).
fn split_cursor(s: &str) -> ApiResult<(String, String)> {
    s.split_once('|').map(|(a, b)| (a.to_string(), b.to_string())).ok_or_else(|| ApiError::invalid("cursor 형식이 올바르지 않습니다"))
}

pub async fn list(State(app): State<App>, _p: Principal, Query(q): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let (bt, bid) = match q.before.as_deref() {
        Some(c) => {
            let (t, i) = split_cursor(c)?;
            (Some(t), Some(i))
        }
        None => (None, None),
    };
    let v = app
        .db
        .call(move |c| {
            let unread = if q.unread { " AND read_at IS NULL" } else { "" };
            let before = if bt.is_some() { " AND (created_at, id) < (?1, ?2)" } else { "" };
            let reference = if q.ref_id.is_some() { " AND ref_id = ?3" } else { "" };
            let mut st = c.prepare_cached(&format!(
                "SELECT id, kind, title, body, project_id, session_id, ref_id, created_at, delivered_at, read_at FROM notifications \
                 WHERE 1=1{unread}{before}{reference} ORDER BY created_at DESC, id DESC LIMIT ?4"
            ))?;
            let mut rows: Vec<Notification> = st
                .query_map(params![bt, bid, q.ref_id, limit + 1], |r| {
                    Ok(Notification {
                        id: r.get(0)?,
                        kind: r.get(1)?,
                        title: r.get(2)?,
                        body: r.get(3)?,
                        project_id: r.get(4)?,
                        session_id: r.get(5)?,
                        ref_id: r.get(6)?,
                        created_at: r.get(7)?,
                        delivered_at: r.get(8)?,
                        read_at: r.get(9)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
            let next_cursor = if rows.len() as i64 > limit {
                rows.truncate(limit as usize);
                rows.last().map(|n| format!("{}|{}", n.created_at, n.id))
            } else {
                None
            };
            let unread: i64 = c.query_row("SELECT COUNT(*) FROM notifications WHERE read_at IS NULL", [], |r| r.get(0))?;
            Ok(json!({ "items": rows, "unread": unread, "next_cursor": next_cursor }))
        })
        .await?;
    Ok(Json(v))
}

/// 읽음 표시(멱등: 이미 읽은 알림은 그대로).
pub async fn read(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let now = app.now();
    let n = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let n = tx.execute("UPDATE notifications SET delivered_at = COALESCE(delivered_at, ?2), read_at = ?2 WHERE id = ?1 AND read_at IS NULL", params![id, now])?;
            if n > 0 {
                events::append(&tx, &now, "notification.read", None, None, &json!({ "id": id }))?;
            }
            tx.commit()?;
            Ok(n)
        })
        .await?;
    app.notify_events().await;
    Ok(Json(json!({ "updated": n })))
}

pub async fn read_all(State(app): State<App>, _p: Principal) -> ApiResult<Json<Value>> {
    let now = app.now();
    let n = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let n = tx.execute("UPDATE notifications SET delivered_at = COALESCE(delivered_at, ?1), read_at = ?1 WHERE read_at IS NULL", params![now])?;
            if n > 0 { events::append(&tx, &now, "notification.read", None, None, &json!({ "all": true }))?; }
            tx.commit()?;
            Ok(n)
        })
        .await?;
    app.notify_events().await;
    Ok(Json(json!({ "updated": n })))
}

#[derive(Deserialize)]
pub struct Delivered {
    pub ids: Vec<String>,
}

/// 목록 조회·SSE 전송만으로 전달을 추정하지 않는다. 수신한 앱의 명시적 확인만 기록한다.
pub async fn delivered(State(app): State<App>, p: Principal, headers: HeaderMap, Json(mut body): Json<Delivered>) -> ApiResult<Response> {
    if body.ids.is_empty() || body.ids.len() > 100 || body.ids.iter().any(|id| id.is_empty() || id.len() > 128) {
        return Err(ApiError::invalid("확인할 알림 ID는 1~100개, 각 128바이트 이하로 지정하세요"));
    }
    body.ids.sort();
    body.ids.dedup();
    let hash = crate::idem::body_hash("notification.delivered", &json!({ "ids": body.ids }));
    crate::idem::run(&app, &p, &headers, &hash, move |tx, now| {
        let mut changed = Vec::new();
        for id in body.ids {
            let n = tx.execute("UPDATE notifications SET delivered_at=?2 WHERE id=?1 AND delivered_at IS NULL", params![id, now])?;
            if n > 0 { changed.push(id); }
        }
        if !changed.is_empty() {
            events::append(tx, now, "notification.delivered", None, None, &json!({ "ids": changed }))?;
        }
        let count = changed.len();
        Ok((StatusCode::OK, json!({ "updated": count })))
    }).await
}
