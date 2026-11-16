//! 영속 이벤트(outbox)와 SSE 전달.
//! - 상태 변경과 같은 transaction에서 `append`로 기록한다(STORE-003).
//! - 클라이언트는 `Last-Event-ID` 또는 `cursor`로 이어받는다(NET-006).
//! - 보존 범위 밖 cursor는 `resync` 이벤트 후 종료한다(NET-008).
//! - 모델 중간 응답(partial)은 DB에 저장하지 않고 구독한 세션에만 보낸다(NET-009).

use crate::App;
use crate::auth::Principal;
use crate::error::ApiResult;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::stream::Stream;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, watch};

/// 보존할 최근 이벤트 수. 이보다 오래된 cursor는 재동기화가 필요하다.
pub const RETAIN_EVENTS: i64 = 50_000;
const BATCH: i64 = 200;

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct EventRecord {
    pub seq: i64,
    pub created_at: String,
    pub kind: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    #[ts(type = "unknown")]
    pub payload: Value,
}

pub fn append(
    conn: &Connection,
    now: &str,
    kind: &str,
    project_id: Option<&str>,
    session_id: Option<&str>,
    payload: &Value,
) -> ApiResult<i64> {
    conn.execute(
        "INSERT INTO events (created_at, kind, project_id, session_id, payload) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![now, kind, project_id, session_id, payload.to_string()],
    )?;
    let seq = conn.last_insert_rowid();
    crate::web_push::enqueue(conn, now, kind, project_id, session_id, payload)?;
    Ok(seq)
}

pub fn latest_seq(conn: &Connection) -> ApiResult<i64> {
    Ok(conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM events", [], |r| r.get(0))?)
}

pub fn read_after(conn: &Connection, after: i64, limit: i64) -> ApiResult<Vec<EventRecord>> {
    let mut stmt = conn.prepare_cached(
        "SELECT seq, created_at, kind, project_id, session_id, payload FROM events WHERE seq > ?1 ORDER BY seq LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![after, limit], |r| {
        let payload: String = r.get(5)?;
        Ok(EventRecord {
            seq: r.get(0)?,
            created_at: r.get(1)?,
            kind: r.get(2)?,
            project_id: r.get(3)?,
            session_id: r.get(4)?,
            payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 보존 한도를 넘는 오래된 이벤트와 idempotency 기록(7일 초과) 정리. 주기적으로 호출한다.
pub fn prune(conn: &Connection) -> ApiResult<usize> {
    let max = latest_seq(conn)?;
    let n = conn.execute("DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE seq <= ?1 ORDER BY seq LIMIT 2000)", params![max - RETAIN_EVENTS])?;
    let cutoff = crate::util::fmt_time(time::OffsetDateTime::now_utc() - time::Duration::days(7));
    // 결과 불명인 외부 작업의 재실행 방지 증거는 자동으로 지우지 않는다.
    let m = conn.execute("DELETE FROM idempotency WHERE rowid IN (SELECT rowid FROM idempotency WHERE created_at < ?1 AND COALESCE(json_extract(response, '$.error.code'), '') != 'result_unknown' ORDER BY created_at, rowid LIMIT 2000)", params![cutoff])?;
    Ok(n + m)
}

pub fn oldest_retained(conn: &Connection) -> ApiResult<Option<i64>> {
    Ok(conn.query_row("SELECT MIN(seq) FROM events", [], |r| r.get(0))?)
}

/// 세션별 모델 중간 응답 snapshot(메모리 전용). 서버 재시작 시 복원하지 않는다.
#[derive(Default)]
pub struct Partials {
    map: Mutex<HashMap<String, Value>>,
    tx: Option<broadcast::Sender<(String, Value)>>,
}

impl Partials {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { map: Mutex::new(HashMap::new()), tx: Some(tx) }
    }
    pub fn set(&self, session_id: &str, snapshot: Value) {
        self.map.lock().expect("partials").insert(session_id.to_string(), snapshot.clone());
        if let Some(tx) = &self.tx {
            let _ = tx.send((session_id.to_string(), snapshot));
        }
    }
    /// 재접속은 항상 최신 snapshot을 읽고, 기존 구독자 fanout은 별도로 묶어서 보낸다.
    pub fn stage(&self, session_id: &str, snapshot: Value) {
        self.map.lock().expect("partials").insert(session_id.to_string(), snapshot);
    }
    pub fn publish(&self, session_id: &str) {
        let map = self.map.lock().expect("partials");
        if let (Some(tx), Some(snapshot)) = (&self.tx, map.get(session_id)) {
            let _ = tx.send((session_id.to_string(), snapshot.clone()));
        }
    }
    pub fn clear(&self, session_id: &str) {
        let removed = self.map.lock().expect("partials").remove(session_id).is_some();
        if removed {
            if let Some(tx) = &self.tx {
                let _ = tx.send((session_id.to_string(), Value::Null));
            }
        }
    }
    pub fn get(&self, session_id: &str) -> Option<Value> {
        self.map.lock().expect("partials").get(session_id).cloned()
    }
    fn subscribe(&self) -> broadcast::Receiver<(String, Value)> {
        self.tx.as_ref().expect("partials tx").subscribe()
    }
}

#[derive(Deserialize)]
pub struct StreamQuery {
    pub cursor: Option<i64>,
    /// 상세(partial) 스트림을 받을 세션 ID 목록, 쉼표 구분.
    pub sessions: Option<String>,
}

enum Out {
    Event(Event),
    End,
}

pub async fn stream(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Query(q): Query<StreamQuery>,
) -> ApiResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let header_cursor = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<i64>().ok());
    let start = header_cursor.or(q.cursor);
    let sessions: HashSet<String> =
        q.sessions.unwrap_or_default().split(',').filter(|s| !s.is_empty()).map(String::from).collect();

    let (tx, rx) = mpsc::channel::<Out>(64);
    let db = app.db.clone();
    let mut seq_rx: watch::Receiver<i64> = app.seq_tx.subscribe();
    let mut partial_rx = app.partials.subscribe();
    let partials = app.partials.clone();
    let mut shutdown = app.shutdown_rx.clone();
    let partials_now: Vec<(String, Value)> =
        sessions.iter().filter_map(|s| app.partials.get(s).map(|v| (s.clone(), v))).collect();

    let invalid = crate::auth::wait_until_invalid(app.clone(), p.clone());
    let producer = async move {
        // 시작 cursor 결정과 보존 범위 검사
        let mut cursor = match start {
            Some(c) => c,
            None => match db.call(|c| latest_seq(c)).await {
                Ok(s) => s,
                Err(_) => return,
            },
        };
        let hello = json!({ "cursor": cursor, "protocol": crate::PROTOCOL_VERSION, "capabilities": crate::CAPABILITIES });
        if tx.send(Out::Event(Event::default().event("hello").data(hello.to_string()))).await.is_err() {
            return;
        }
        if start.is_some() {
            let oldest = db.call(|c| oldest_retained(c)).await.ok().flatten();
            let latest = db.call(|c| latest_seq(c)).await.unwrap_or(0);
            let too_old = match oldest {
                Some(o) => cursor < o - 1,
                None => cursor < latest,
            };
            if too_old || cursor > latest {
                let data = json!({ "reason": if cursor > latest { "cursor_ahead" } else { "cursor_expired" }, "latest": latest });
                let _ = tx.send(Out::Event(Event::default().event("resync").data(data.to_string()))).await;
                let _ = tx.send(Out::End).await;
                return;
            }
        }
        for (sid, snap) in partials_now {
            let ev = Event::default().event("partial").data(json!({ "session_id": sid, "snapshot": snap }).to_string());
            if tx.send(Out::Event(ev)).await.is_err() {
                return;
            }
        }
        loop {
            // 영속 이벤트를 모두 따라잡는다. bounded channel이 느린 클라이언트의 backpressure가 된다.
            loop {
                let after = cursor;
                let batch = match db.call(move |c| read_after(c, after, BATCH)).await {
                    Ok(b) => b,
                    Err(_) => return,
                };
                let n = batch.len() as i64;
                for ev in batch {
                    cursor = ev.seq;
                    let data = serde_json::to_string(&ev).unwrap_or_default();
                    let e = Event::default().id(ev.seq.to_string()).event("event").data(data);
                    if tx.send(Out::Event(e)).await.is_err() {
                        return;
                    }
                }
                if n < BATCH {
                    break;
                }
            }
            tokio::select! {
                _ = tx.closed() => return,
                changed = seq_rx.changed() => { if changed.is_err() { return; } }
                msg = partial_rx.recv() => {
                    match msg {
                        Ok((sid, snap)) => {
                            if sessions.contains(&sid) {
                                let ev = Event::default().event("partial").data(json!({ "session_id": sid, "snapshot": snap }).to_string());
                                if tx.send(Out::Event(ev)).await.is_err() { return; }
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            // 놓친 partial은 현재 snapshot으로 대체한다.
                            for sid in &sessions {
                                let snap = partials.get(sid).unwrap_or(Value::Null);
                                let ev = Event::default().event("partial").data(json!({ "session_id": sid, "snapshot": snap, "lagged": true }).to_string());
                                if tx.send(Out::Event(ev)).await.is_err() { return; }
                            }
                        }
                        Err(_) => return,
                    }
                }
                _ = shutdown.changed() => {
                    let _ = tx.send(Out::Event(Event::default().event("shutdown").data("{}"))).await;
                    let _ = tx.send(Out::End).await;
                    return;
                }
            }
        }
    };
    tokio::spawn(async move {
        // 큐 backpressure 중이어도 폐기·만료를 받으면 생산자를 취소하고 연결을 끝낸다.
        tokio::select! { biased; _ = invalid => {}, _ = producer => {} }
    });

    let stream = futures_util::stream::unfold((rx, app, p), |(mut rx, app, p)| async move {
        match rx.recv().await {
            Some(Out::Event(e)) if crate::auth::revalidate(&app, &p).await.is_ok() => Some((Ok(e), (rx, app, p))),
            _ => None,
        }
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("hb")))
}
