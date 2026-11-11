//! 세션·메시지(SESSION). 확정 대화만 저장하며 모델 중간 응답은 events::Partials에 둔다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::idem;
use crate::projects;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
    pub archived_at: Option<String>,
    pub parent_session_id: Option<String>,
    pub fork_message_seq: Option<i64>,
    pub fork_inherits_context: bool,
    pub workflow_id: Option<String>,
    pub last_message_seq: i64,
    /// 진행 중 턴 상태(없으면 null). 질문 답만 기다리면 awaiting_input(턴 자체 상태는 awaiting_approval, RUN-014).
    pub active_turn: Option<String>,
    pub pending_approvals: i64,
    pub unreviewed_unknown: i64,
    /// 봇 대화면 봇 ID(모델·persona는 봇 설정을 따른다)
    pub bot_id: Option<String>,
    /// 최근 사용자·assistant 메시지 앞부분
    pub preview: Option<String>,
    /// 최근 항목에 기록된 읽은 위치보다 새 메시지가 있는지(열어 본 적 없으면 메시지가 있을 때 true)
    pub unread: bool,
    /// 이 대화가 들어가 있는 Grove worktree(없으면 프로젝트 폴더에서 실행, GIT-008)
    pub worktree_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct Message {
    pub id: String,
    pub session_id: String,
    pub seq: i64,
    pub role: String,
    #[ts(type = "unknown")]
    pub content: Value,
    pub turn_id: Option<String>,
    pub created_at: String,
}

const COLS: &str = "s.id, s.project_id, s.title, s.created_at, s.updated_at, s.revision, s.archived_at, \
    s.parent_session_id, s.fork_message_seq, s.fork_inherits_context, s.workflow_id, s.last_message_seq, \
    (SELECT CASE WHEN t.status = 'awaiting_approval' \
        AND EXISTS (SELECT 1 FROM tool_calls q WHERE q.session_id = s.id AND q.turn_id = t.id AND q.status = 'awaiting_input') \
        AND NOT EXISTS (SELECT 1 FROM tool_calls a WHERE a.session_id = s.id AND a.turn_id = t.id AND a.status = 'pending_approval') \
        THEN 'awaiting_input' ELSE t.status END \
        FROM turns t WHERE t.session_id = s.id AND t.status IN ('queued','running','awaiting_approval')), \
    (SELECT COUNT(*) FROM tool_calls c WHERE c.session_id = s.id AND c.status = 'pending_approval'), \
    (SELECT COUNT(*) FROM tool_calls c WHERE c.session_id = s.id AND c.status = 'unknown' AND c.reviewed_at IS NULL), s.bot_id, \
    (SELECT substr(json_extract(m.content, '$.text'), 1, 120) FROM messages m WHERE m.session_id = s.id AND m.rewound_at IS NULL AND m.role IN ('user','assistant') \
       AND json_extract(m.content, '$.text') != '' ORDER BY m.seq DESC LIMIT 1), \
    COALESCE((SELECT json_extract(r.view_state, '$.last_seen_seq') FROM recent_items r WHERE r.kind = 'session' AND r.resource_id = s.id), 0), \
    s.worktree_id";

/// COLS 뒤에 붙이는 추가 열의 시작 번호.
const NCOLS: usize = 19;

fn from_row(r: &Row) -> rusqlite::Result<Session> {
    Ok(Session {
        id: r.get(0)?,
        project_id: r.get(1)?,
        title: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
        revision: r.get(5)?,
        archived_at: r.get(6)?,
        parent_session_id: r.get(7)?,
        fork_message_seq: r.get(8)?,
        fork_inherits_context: r.get(9)?,
        workflow_id: r.get(10)?,
        last_message_seq: r.get(11)?,
        active_turn: r.get(12)?,
        pending_approvals: r.get(13)?,
        unreviewed_unknown: r.get(14)?,
        bot_id: r.get(15)?,
        preview: r.get::<_, Option<String>>(16)?.map(|p| p.replace('\n', " ")),
        unread: r.get::<_, i64>(17)? < r.get::<_, i64>(11)?,
        worktree_id: r.get(18)?,
    })
}

pub fn get(conn: &Connection, id: &str) -> ApiResult<Session> {
    conn.query_row(&format!("SELECT {COLS} FROM sessions s WHERE s.id = ?1"), params![id], from_row)
        .optional()?
        .ok_or_else(|| ApiError::not_found("세션이 없습니다"))
}

/// 실행 중·승인 대기·미검토 결과 불명이 있으면 보관을 막는다.
/// 백그라운드 작업·자식 에이전트도 같다: 보관 전에 사용자가 명시적으로 취소해야 한다(EXEC-010).
pub fn ensure_archivable(c: &Connection, cur: &Session) -> ApiResult<()> {
    let running_tasks = crate::tasks::running_in_session(c, &cur.id)?;
    let running_agents = crate::agents::running_for_parent(c, &cur.id)?;
    if cur.active_turn.is_some() || cur.pending_approvals > 0 || cur.unreviewed_unknown > 0 || running_tasks > 0 || running_agents > 0 {
        return Err(ApiError::busy("실행 중이거나 승인 대기·미검토 작업이 있는 세션은 보관할 수 없습니다").with_details(json!({
            "active_turn": cur.active_turn, "pending_approvals": cur.pending_approvals, "unreviewed_unknown": cur.unreviewed_unknown,
            "running_tasks": running_tasks, "running_agents": running_agents
        })));
    }
    Ok(())
}

/// 검사 후 보관(이미 보관됐으면 그대로). 같은 transaction에서 이벤트를 남긴다.
pub fn archive_checked(c: &Connection, now: &str, id: &str) -> ApiResult<Session> {
    let cur = get(c, id)?;
    if cur.archived_at.is_some() {
        return Ok(cur);
    }
    ensure_archivable(c, &cur)?;
    c.execute("UPDATE sessions SET archived_at = ?2, revision = revision + 1, updated_at = ?2 WHERE id = ?1", params![id, now])?;
    let s = get(c, id)?;
    events::append(c, now, "session.updated", Some(&s.project_id), Some(id), &serde_json::to_value(&s)?)?;
    Ok(s)
}

/// 실행·쓰기 가능한 세션인지 확인한다(보관된 세션 거절).
pub fn get_active(conn: &Connection, id: &str) -> ApiResult<Session> {
    let s = get(conn, id)?;
    if s.archived_at.is_some() {
        return Err(ApiError::conflict("archived", "보관된 세션입니다. 복원 후 사용하세요"));
    }
    Ok(s)
}

/// 대화의 실행 루트(GIT-008): 대화가 worktree에 들어가 있으면 그 경로, 아니면 프로젝트 폴더.
/// 프로젝트가 보관·이동됐거나 worktree 경로가 없으면 실행을 거부한다(다른 폴더에서 실행하지 않는다).
pub fn exec_root(conn: &Connection, session_id: &str) -> ApiResult<std::path::PathBuf> {
    let (project_id, wt): (String, Option<String>) =
        conn.query_row("SELECT project_id, worktree_id FROM sessions WHERE id = ?1", params![session_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let root = projects::active_root(conn, &project_id)?;
    let Some(wt) = wt else { return Ok(root) };
    let (path, status): (String, String) = conn.query_row("SELECT path, status FROM worktrees WHERE id = ?1", params![wt], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let p = std::path::PathBuf::from(path);
    if status != "active" || !p.is_dir() {
        return Err(ApiError::gone("이 대화의 worktree 경로에 접근할 수 없습니다. 프로젝트 폴더로 돌아가거나 worktree를 다시 만드세요"));
    }
    Ok(p)
}

fn msg_from_row(r: &Row) -> rusqlite::Result<Message> {
    let content: String = r.get(4)?;
    Ok(Message {
        id: r.get(0)?,
        session_id: r.get(1)?,
        seq: r.get(2)?,
        role: r.get(3)?,
        content: serde_json::from_str(&content).unwrap_or(Value::Null),
        turn_id: r.get(5)?,
        created_at: r.get(6)?,
    })
}

/// 메시지 추가. 세션의 last_message_seq를 같은 transaction에서 올린다.
pub fn append_message(
    conn: &Connection,
    now: &str,
    session_id: &str,
    role: &str,
    content: &Value,
    turn_id: Option<&str>,
    model_input: Option<&Value>,
) -> ApiResult<Message> {
    let seq: i64 = conn.query_row(
        "UPDATE sessions SET last_message_seq = last_message_seq + 1, updated_at = ?2 WHERE id = ?1 RETURNING last_message_seq",
        params![session_id, now],
        |r| r.get(0),
    )?;
    let id = crate::util::new_id();
    conn.execute(
        "INSERT INTO messages (id, session_id, seq, role, content, turn_id, model_input, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, session_id, seq, role, content.to_string(), turn_id, model_input.map(|v| v.to_string()), now],
    )?;
    let m = Message {
        id,
        session_id: session_id.into(),
        seq,
        role: role.into(),
        content: content.clone(),
        turn_id: turn_id.map(String::from),
        created_at: now.into(),
    };
    let project_id: String = conn.query_row("SELECT project_id FROM sessions WHERE id = ?1", params![session_id], |r| r.get(0))?;
    events::append(conn, now, "message.created", Some(&project_id), Some(session_id), &serde_json::to_value(&m)?)?;
    Ok(m)
}

/// 필요한 모델 입력 구간만 한 행씩 읽는다. 표시용 content와 model_input을 중복해서 가져오지 않는다.
/// 분기 원본도 fork 경계 이전의 압축·상위 분기를 사용해 원래 전체 이력을 재적재하지 않는다(DB-012).
pub(crate) fn visit_model_history(
    conn: &Connection, session_id: &str, upto: Option<i64>, visit: &mut dyn FnMut(&str, &Value),
) -> ApiResult<()> {
    let mut segments = Vec::new();
    let (mut id, mut end) = (session_id.to_string(), upto);
    loop {
        let compaction = crate::context::latest_compaction(conn, &id, end)?;
        let parent = if compaction.is_none() {
            let session = get(conn, &id)?;
            match (session.parent_session_id, session.fork_message_seq, session.fork_inherits_context) {
                (Some(parent), Some(seq), true) => Some((parent, seq)),
                _ => None,
            }
        } else { None };
        segments.push((id, end, compaction));
        let Some((parent, seq)) = parent else { break };
        id = parent;
        end = Some(seq);
    }
    for (id, end, compaction) in segments.into_iter().rev() {
        let start = compaction.as_ref().map_or(0, |cp| cp.upto_seq);
        if let Some(cp) = compaction {
            visit("user", &json!({ "text": crate::context::summary_block(&cp.summary) }));
        }
        let mut statement = conn.prepare(
            "SELECT role, CASE WHEN model_input IS NOT NULL AND json_valid(model_input) THEN model_input ELSE content END \
             FROM messages WHERE session_id = ?1 AND rewound_at IS NULL AND seq > ?2 AND seq <= ?3 ORDER BY seq",
        )?;
        let rows = statement.query_map(params![id, start, end.unwrap_or(i64::MAX)], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (role, input) = row?;
            visit(&role, &serde_json::from_str(&input).unwrap_or(Value::Null));
        }
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct CreateSession {
    pub title: Option<String>,
    /// 새 대화를 실행할 위치(GIT-008): 없으면 프로젝트 폴더, 있으면 이 프로젝트의 Grove worktree.
    /// 자동 격리 기본값은 정하지 않았다(사용자 결정 대기). 지금은 명시해야만 worktree에서 실행한다.
    #[serde(default)]
    pub worktree_id: Option<String>,
}

fn clean_title(t: Option<String>) -> ApiResult<String> {
    let t = t.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).unwrap_or_else(|| "새 대화".into());
    if t.chars().count() > 200 {
        return Err(ApiError::invalid("제목은 200자 이하여야 합니다"));
    }
    Ok(t)
}

pub async fn create(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Json(body): Json<CreateSession>,
) -> ApiResult<Response> {
    let title = clean_title(body.title)?;
    let wt = body.worktree_id;
    let h = idem::body_hash("session.create", &json!({ "project": project_id, "title": title, "worktree": wt }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        projects::active_root(tx, &project_id)?;
        if let Some(w) = &wt {
            crate::worktrees::ensure_usable(tx, &project_id, w)?;
        }
        let id = crate::util::new_id();
        tx.execute(
            "INSERT INTO sessions (id, project_id, title, created_at, updated_at, worktree_id) VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
            params![id, project_id, title, now, wt],
        )?;
        let s = get(tx, &id)?;
        events::append(tx, now, "session.created", Some(&project_id), Some(&id), &serde_json::to_value(&s)?)?;
        Ok((StatusCode::CREATED, serde_json::to_value(s)?))
    })
    .await
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub archived: Option<bool>,
    /// 이전 페이지 마지막 항목의 `updated_at|id`
    pub cursor: Option<String>,
    pub limit: Option<i64>,
    pub q: Option<String>,
}

#[derive(Serialize, ts_rs::TS)]
pub struct SessionPage {
    pub items: Vec<Session>,
    pub next_cursor: Option<String>,
}

pub async fn list(
    State(app): State<App>,
    _p: Principal,
    Path(project_id): Path<String>,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<SessionPage>> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let archived = q.archived.unwrap_or(false);
    let (cur_t, cur_id) = match q.cursor.as_deref().and_then(|c| c.split_once('|')) {
        Some((t, i)) => (t.to_string(), i.to_string()),
        None => ("\u{10FFFF}".to_string(), String::new()),
    };
    let needle = q.q.unwrap_or_default().to_lowercase();
    let page = app
        .db
        .call(move |c| {
            projects::get(c, &project_id)?;
            let sql = format!(
                "SELECT {COLS} FROM sessions s WHERE s.project_id = ?1 AND (s.archived_at IS NOT NULL) = ?2 \
                 AND (s.updated_at < ?3 OR (s.updated_at = ?3 AND s.id < ?4)) \
                 AND (?5 = '' OR instr(lower(s.title), ?5) > 0) \
                 ORDER BY s.updated_at DESC, s.id DESC LIMIT ?6"
            );
            let mut st = c.prepare(&sql)?;
            let cursor_id = if cur_id.is_empty() { "\u{10FFFF}".to_string() } else { cur_id };
            let items = st
                .query_map(params![project_id, archived, cur_t, cursor_id, needle, limit + 1], from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(items)
        })
        .await?;
    let mut items = page;
    let next_cursor = if items.len() as i64 > limit {
        items.truncate(limit as usize);
        items.last().map(|s| format!("{}|{}", s.updated_at, s.id))
    } else {
        None
    };
    Ok(Json(SessionPage { items, next_cursor }))
}

#[derive(Deserialize)]
pub struct DeleteBody {
    pub expected_revision: i64,
    /// 실수 방지: 대화 제목을 그대로 입력해야 한다
    pub confirm_title: String,
}

/// 보관된 대화의 영구 삭제(SESSION-004, DB-018). 되돌릴 수 없으므로 보관 상태에서만, 다른 기록이 의존하지 않을 때만 허용한다.
/// 삭제 범위: 메시지·턴·도구 호출·작업·Goal·대화 범위 설정·초안·최근 항목·이 대화의 이벤트 payload·작업 로그 파일.
/// 예약 실행 기록·알림은 남기고 대화 연결만 끊는다.
pub async fn delete_permanently(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<DeleteBody>) -> ApiResult<Response> {
    let h = idem::body_hash("session.delete", &json!({ "i": id, "r": b.expected_revision }));
    let task_ids = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let tids = task_ids.clone();
    let resp = idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get(tx, &id)?;
        if cur.revision != b.expected_revision {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        if cur.archived_at.is_none() {
            return Err(ApiError::conflict("not_archived", "보관한 대화만 영구 삭제할 수 있습니다"));
        }
        if b.confirm_title != cur.title {
            return Err(ApiError::invalid("확인용 제목이 대화 제목과 다릅니다"));
        }
        let count = |sql: &str| -> ApiResult<i64> { Ok(tx.query_row(sql, params![id], |r| r.get(0))?) };
        let blockers = [
            ("forks", count("SELECT COUNT(*) FROM sessions WHERE parent_session_id = ?1")?, "이 대화에서 분기한 대화가 이력을 이어받고 있습니다"),
            ("agent_runs", count("SELECT COUNT(*) FROM agent_runs WHERE parent_session_id = ?1 OR child_session_id = ?1")?, "에이전트 위임 기록과 연결된 대화입니다"),
            ("bot_home", count("SELECT COUNT(*) FROM bots WHERE home_session_id = ?1")?, "봇의 현재 대화입니다. 봇 대화를 초기화한 뒤 삭제하세요"),
            ("schedules", count("SELECT COUNT(*) FROM schedules WHERE session_id = ?1 AND status != 'deleted'")?, "이 대화로 실행하는 예약이 있습니다"),
        ];
        if let Some((code, n, msg)) = blockers.iter().find(|x| x.1 > 0) {
            return Err(ApiError::conflict("delete_blocked", *msg).with_details(json!({ "reason": code, "count": n })));
        }
        ensure_archivable(tx, &cur)?;
        {
            let mut st = tx.prepare("SELECT id FROM tasks WHERE session_id = ?1")?;
            let ids = st.query_map(params![id], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            tids.lock().unwrap().extend(ids);
        }
        for sql in [
            "DELETE FROM goals WHERE session_id = ?1",
            "DELETE FROM tasks WHERE session_id = ?1",
            "DELETE FROM session_tool_grants WHERE session_id = ?1",
            "DELETE FROM cli_sessions WHERE session_id = ?1",
            "DELETE FROM followups WHERE session_id = ?1",
            "DELETE FROM tool_calls WHERE session_id = ?1",
            "DELETE FROM turns WHERE session_id = ?1",
            "DELETE FROM messages WHERE session_id = ?1",
            "DELETE FROM settings WHERE scope = 'session' AND scope_id = ?1",
            "DELETE FROM drafts WHERE resource_key = 'session:' || ?1",
            "DELETE FROM recent_items WHERE kind = 'session' AND resource_id = ?1",
            "DELETE FROM events WHERE session_id = ?1",
            "UPDATE schedule_runs SET session_id = NULL WHERE session_id = ?1",
            "UPDATE notifications SET session_id = NULL WHERE session_id = ?1",
            "DELETE FROM sessions WHERE id = ?1",
        ] {
            tx.execute(sql, params![id])?;
        }
        events::append(tx, now, "session.deleted", Some(&cur.project_id), None, &json!({ "id": id }))?;
        Ok((StatusCode::OK, json!({ "id": id, "deleted": true })))
    })
    .await?;
    // commit 뒤 로그 파일 정리. 실패해도 DB는 일관되며 남은 파일은 참조 없는 로그일 뿐이다.
    for t in task_ids.lock().unwrap().iter() {
        for s in ["out", "err"] {
            let _ = std::fs::remove_file(app.cfg.data_dir.join("tasks").join(format!("{t}.{s}")));
        }
    }
    Ok(resp)
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
    /// true면 메시지 본문도 검색한다
    #[serde(default)]
    pub body: bool,
    pub project_id: Option<String>,
    /// updated_at 범위(RFC 3339)
    pub from: Option<String>,
    pub to: Option<String>,
    /// active | running | awaiting_approval | awaiting_input | unknown_result | archived
    pub status: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Serialize)]
pub struct SearchHit {
    #[serde(flatten)]
    pub session: Session,
    pub project_name: String,
    /// 본문에서 찾았으면 그 메시지 seq와 앞뒤 발췌
    pub match_seq: Option<i64>,
    pub snippet: Option<String>,
}

fn excerpt(text: &str, needle: &str) -> String {
    let lower = text.to_lowercase();
    let chars: Vec<char> = text.chars().collect();
    // 소문자 변환으로 글자 수가 바뀌지 않는 범위에서 위치를 글자 단위로 잡는다
    let at = lower.find(needle).map(|b| lower[..b].chars().count()).unwrap_or(0).min(chars.len());
    let start = at.saturating_sub(40);
    let end = (at + needle.chars().count() + 80).min(chars.len());
    let mut s: String = chars[start..end].iter().collect();
    if start > 0 {
        s.insert(0, '…');
    }
    if end < chars.len() {
        s.push('…');
    }
    s.replace('\n', " ")
}

/// 프로젝트를 가로지르는 세션 검색(SESSION-005). 제목·본문·날짜·프로젝트·상태 필터.
pub async fn search(State(app): State<App>, _p: Principal, Query(q): Query<SearchQuery>) -> ApiResult<Json<Value>> {
    let limit = q.limit.unwrap_or(30).clamp(1, 100);
    let offset = q.offset.unwrap_or(0).max(0);
    let needle = q.q.clone().unwrap_or_default().trim().to_lowercase();
    if needle.chars().count() > 200 {
        return Err(ApiError::invalid("검색어는 200자 이하여야 합니다"));
    }
    for t in [&q.from, &q.to].into_iter().flatten() {
        if crate::util::parse_time(t).is_none() {
            return Err(ApiError::invalid("날짜는 RFC 3339 형식이어야 합니다"));
        }
    }
    let status = q.status.clone().unwrap_or_default();
    if !matches!(status.as_str(), "" | "active" | "running" | "awaiting_approval" | "unknown_result" | "archived") {
        return Err(ApiError::invalid("알 수 없는 상태 필터입니다"));
    }
    let v = app
        .db
        .call(move |c| {
            // 시간 비교는 문자열 대신 julianday로 해 소수 초 표기 차이에 영향받지 않게 한다.
            let sql = format!(
                "SELECT {COLS}, p.name, \
                   (SELECT m.seq FROM messages m WHERE ?2 = 1 AND ?1 != '' AND m.session_id = s.id AND m.rewound_at IS NULL AND m.role IN ('user','assistant') \
                      AND instr(lower(COALESCE(json_extract(m.content, '$.text'), '')), ?1) > 0 ORDER BY m.seq DESC LIMIT 1), \
                   (SELECT json_extract(m.content, '$.text') FROM messages m WHERE ?2 = 1 AND ?1 != '' AND m.session_id = s.id AND m.rewound_at IS NULL AND m.role IN ('user','assistant') \
                      AND instr(lower(COALESCE(json_extract(m.content, '$.text'), '')), ?1) > 0 ORDER BY m.seq DESC LIMIT 1) \
                 FROM sessions s JOIN projects p ON p.id = s.project_id \
                 WHERE p.archived_at IS NULL AND (?3 IS NULL OR s.project_id = ?3) \
                   AND (?4 IS NULL OR julianday(s.updated_at) >= julianday(?4)) AND (?5 IS NULL OR julianday(s.updated_at) < julianday(?5)) \
                 ORDER BY s.updated_at DESC, s.id DESC"
            );
            let mut st = c.prepare(&sql)?;
            let rows = st.query_map(params![needle, q.body, q.project_id, q.from, q.to], |r| {
                Ok((from_row(r)?, r.get::<_, String>(NCOLS)?, r.get::<_, Option<i64>>(NCOLS + 1)?, r.get::<_, Option<String>>(NCOLS + 2)?))
            })?;
            let mut hits = vec![];
            let mut total = 0i64;
            for row in rows {
                let (s, project_name, seq, text) = row?;
                let st = if s.archived_at.is_some() {
                    "archived"
                } else if s.pending_approvals > 0 || s.active_turn.as_deref() == Some("awaiting_approval") {
                    "awaiting_approval"
                } else if s.active_turn.as_deref() == Some("awaiting_input") {
                    "awaiting_input"
                } else if s.active_turn.is_some() {
                    "running"
                } else if s.unreviewed_unknown > 0 {
                    "unknown_result"
                } else {
                    "active"
                };
                // 상태 필터가 없으면 보관된 세션은 제외한다
                if (status.is_empty() && st == "archived") || (!status.is_empty() && st != status) {
                    continue;
                }
                let title_hit = needle.is_empty() || s.title.to_lowercase().contains(&needle);
                if !title_hit && seq.is_none() {
                    continue;
                }
                total += 1;
                if total <= offset || hits.len() as i64 >= limit {
                    continue;
                }
                let snippet = text.as_deref().map(|t| excerpt(t, &needle));
                hits.push(SearchHit { session: s, project_name, match_seq: seq, snippet });
            }
            Ok(json!({ "items": hits, "total": total }))
        })
        .await?;
    Ok(Json(v))
}

pub async fn show(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Session>> {
    Ok(Json(app.db.call(move |c| get(c, &id)).await?))
}

#[derive(Deserialize)]
pub struct UpdateSession {
    pub expected_revision: i64,
    pub title: Option<String>,
    pub archived: Option<bool>,
    /// 없음 = 그대로, null = 기본 워크플로로, 값 = 그 워크플로
    #[serde(default, deserialize_with = "crate::util::double_option")]
    pub workflow_id: Option<Option<String>>,
}

pub async fn update(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<UpdateSession>,
) -> ApiResult<Response> {
    let title = match body.title {
        Some(t) => Some(clean_title(Some(t))?),
        None => None,
    };
    let h = idem::body_hash(
        "session.update",
        &json!({ "id": id, "rev": body.expected_revision, "title": title, "archived": body.archived, "wf": body.workflow_id }),
    );
    let (rev, archived, workflow) = (body.expected_revision, body.archived, body.workflow_id);
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get(tx, &id)?;
        if cur.revision != rev {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        if archived == Some(true) && cur.archived_at.is_none() {
            ensure_archivable(tx, &cur)?;
        }
        if cur.archived_at.is_some() && archived != Some(false) && (title.is_some() || workflow.is_some()) {
            return Err(ApiError::conflict("archived", "보관된 세션은 복원 후 수정하세요"));
        }
        if let Some(Some(wf)) = &workflow {
            crate::definitions::require_enabled_workflow(tx, wf)?;
        }
        let archived_at = match archived {
            Some(true) => cur.archived_at.clone().or(Some(now.to_string())),
            Some(false) => None,
            None => cur.archived_at.clone(),
        };
        let new_wf = match &workflow {
            Some(w) => w.clone(),
            None => cur.workflow_id.clone(),
        };
        tx.execute(
            "UPDATE sessions SET title = ?2, archived_at = ?3, workflow_id = ?4, revision = revision + 1, updated_at = ?5 WHERE id = ?1",
            params![id, title.unwrap_or(cur.title.clone()), archived_at, new_wf, now],
        )?;
        let s = get(tx, &id)?;
        events::append(tx, now, "session.updated", Some(&s.project_id), Some(&id), &serde_json::to_value(&s)?)?;
        Ok((StatusCode::OK, serde_json::to_value(s)?))
    })
    .await
}

#[derive(Deserialize)]
pub struct MessagesQuery {
    pub before_seq: Option<i64>,
    pub after_seq: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Serialize, ts_rs::TS)]
pub struct MessagePage {
    pub items: Vec<Message>,
    pub has_more_before: bool,
    pub has_more_after: bool,
    /// rewind 때만 증가한다. 클라이언트는 이전 페이지와 진행 중 조회를 이 값으로 구분한다.
    pub timeline_revision: i64,
    /// 이 seq 이하는 압축된 구간이므로 rewind할 수 없다.
    pub rewind_boundary_seq: Option<i64>,
}

pub async fn messages(
    State(app): State<App>,
    _p: Principal,
    Path(id): Path<String>,
    Query(q): Query<MessagesQuery>,
) -> ApiResult<Json<MessagePage>> {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let page = app
        .db
        .call(move |c| {
            get(c, &id)?;
            let timeline_revision = c.query_row("SELECT timeline_revision FROM sessions WHERE id = ?1", params![id], |r| r.get(0))?;
            let rewind_boundary_seq = crate::context::latest_compaction(c, &id, None)?.map(|cp| cp.upto_seq);
            let cols = "id, session_id, seq, role, content, turn_id, created_at";
            let mut items = if let Some(after) = q.after_seq {
                let mut st = c.prepare(&format!("SELECT {cols} FROM messages WHERE session_id = ?1 AND rewound_at IS NULL AND seq > ?2 ORDER BY seq LIMIT ?3"))?;
                st.query_map(params![id, after, limit + 1], msg_from_row)?.collect::<Result<Vec<_>, _>>()?
            } else {
                let before = q.before_seq.unwrap_or(i64::MAX);
                let mut st = c.prepare(&format!(
                    "SELECT {cols} FROM messages WHERE session_id = ?1 AND rewound_at IS NULL AND seq < ?2 ORDER BY seq DESC LIMIT ?3"
                ))?;
                let mut v = st.query_map(params![id, before, limit + 1], msg_from_row)?.collect::<Result<Vec<_>, _>>()?;
                v.reverse();
                v
            };
            let more = items.len() as i64 > limit;
            let (has_more_before, has_more_after) = if q.after_seq.is_some() {
                if more {
                    items.truncate(limit as usize);
                }
                let first = items.first().map(|m| m.seq).unwrap_or(0);
                let before: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM messages WHERE session_id = ?1 AND rewound_at IS NULL AND seq < ?2)", params![id, first], |r| r.get(0))?;
                (before, more)
            } else {
                if more {
                    items.remove(0);
                }
                let last = items.last().map(|m| m.seq).unwrap_or(0);
                let max: i64 = c.query_row("SELECT COALESCE(MAX(seq),0) FROM messages WHERE session_id = ?1 AND rewound_at IS NULL", params![id], |r| r.get(0))?;
                (more, last < max)
            };
            Ok(MessagePage { items, has_more_before, has_more_after, timeline_revision, rewind_boundary_seq })
        })
        .await?;
    Ok(Json(page))
}

#[derive(Deserialize)]
pub struct PostMessage {
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<String>,
}

pub const MAX_MESSAGE_CHARS: usize = 200_000;

pub fn validate_text(text: &str) -> ApiResult<()> {
    validate_message(text, &[])
}

pub fn validate_message(text: &str, attachments: &[String]) -> ApiResult<()> {
    if text.trim().is_empty() && attachments.is_empty() {
        return Err(ApiError::invalid("메시지가 비어 있습니다"));
    }
    if text.chars().count() > MAX_MESSAGE_CHARS {
        return Err(ApiError::invalid(format!("메시지는 {MAX_MESSAGE_CHARS}자 이하여야 합니다")));
    }
    Ok(())
}

/// 모델을 호출하지 않고 사용자 메시지만 저장한다.
pub async fn post_message(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<PostMessage>,
) -> ApiResult<Response> {
    validate_message(&body.text, &body.attachments)?;
    let mut hash_body = json!({ "session": id, "text": body.text });
    if !body.attachments.is_empty() { hash_body["attachments"] = json!(body.attachments); }
    let h = idem::body_hash("message.post", &hash_body);
    let data = app.cfg.data_dir.clone();
    let owner = p.root_id.clone();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let s = get_active(tx, &id)?;
        projects::active_root(tx, &s.project_id)?;
        // 실행 중인 턴 사이에 메시지를 끼워 넣으면 모델 입력의 도구 호출·결과 짝이 깨진다.
        if s.active_turn.is_some() {
            return Err(ApiError::busy("턴이 실행 중입니다. 끝난 뒤 저장하세요"));
        }
        let mut content = json!({ "text": body.text });
        let prepared = crate::attachments::prepare(tx, &data, &owner, &s.project_id, &body.text, &body.attachments)?;
        let model_input = if prepared.items.is_empty() { None } else {
            content["attachments"] = json!(prepared.items);
            Some(&prepared.model_input)
        };
        let m = append_message(tx, now, &id, "user", &content, None, model_input)?;
        crate::attachments::bind(tx, now, &m.id, &prepared)?;
        Ok((StatusCode::CREATED, serde_json::to_value(m)?))
    })
    .await
}

#[derive(Deserialize)]
pub struct RewindSession {
    pub message_id: String,
    pub expected_revision: i64,
    pub expected_last_message_seq: i64,
}

/// 대화만 사용자 메시지 직전으로 되돌린다. 파일·Git 변경이나 실행 감사 기록을 되돌리지 않는다.
/// 원문은 보관하고, 모델 이력·검색·타임라인에서 제외한다. 실행 중 작업과 기존 분기의 참조는 보호한다.
pub async fn rewind(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<RewindSession>,
) -> ApiResult<Response> {
    let h = idem::body_hash("session.rewind", &json!({
        "id": id, "message_id": body.message_id, "revision": body.expected_revision,
        "last_message_seq": body.expected_last_message_seq,
    }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get_active(tx, &id)?;
        projects::active_root(tx, &cur.project_id)?;
        if cur.revision != body.expected_revision || cur.last_message_seq != body.expected_last_message_seq {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        ensure_archivable(tx, &cur)?;
        let followups: i64 = tx.query_row("SELECT COUNT(*) FROM followups WHERE session_id = ?1", params![id], |r| r.get(0))?;
        if followups > 0 {
            return Err(ApiError::busy("대기 중인 추가 메시지를 처리하거나 지운 뒤 되감기하세요"));
        }
        let target: Option<(i64, String, Option<String>)> = tx
            .query_row(
                "SELECT seq, role, turn_id FROM messages WHERE id = ?1 AND session_id = ?2 AND rewound_at IS NULL",
                params![body.message_id, id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let (seq, role, turn) = target.ok_or_else(|| ApiError::not_found("이 대화의 활성 메시지가 아닙니다"))?;
        if role != "user" {
            return Err(ApiError::invalid("사용자 메시지 직전으로만 되감기할 수 있습니다"));
        }
        if let Some(turn) = turn {
            let request: String = tx.query_row("SELECT request_message_id FROM turns WHERE id = ?1", params![turn], |r| r.get(0))?;
            if request != body.message_id {
                return Err(ApiError::conflict("mid_turn", "턴 중간의 추가 메시지로는 되감기할 수 없습니다. 그 턴의 첫 사용자 메시지를 선택하세요"));
            }
        }
        if let Some(cp) = crate::context::latest_compaction(tx, &id, None)?
            && seq <= cp.upto_seq
        {
            return Err(ApiError::conflict("compacted_range", "압축된 구간은 되감기할 수 없습니다. 압축 경계 이후의 사용자 메시지를 선택하세요")
                .with_details(json!({ "upto_seq": cp.upto_seq, "files_unchanged": true })));
        }
        let forks: i64 = tx.query_row(
            "SELECT COUNT(*) FROM sessions WHERE parent_session_id = ?1 AND fork_message_seq >= ?2",
            params![id, seq],
            |r| r.get(0),
        )?;
        if forks > 0 {
            return Err(ApiError::conflict("fork_dependency", "기존 분기가 이 구간을 참조합니다. 원본을 되감는 대신 새 대화로 분기하세요"));
        }
        // 압축 기록은 실제 기록 시각보다 앞선 구간을 요약한다. 경계 이후 rewind에서도 유효한 요약은 유지한다.
        let removed = tx.execute(
            "UPDATE messages SET rewound_at = ?3 WHERE session_id = ?1 AND seq >= ?2 AND rewound_at IS NULL \
             AND NOT (role = 'note' AND COALESCE(json_extract(content, '$.type'), '') = 'compaction')",
            params![id, seq, now],
        )?;
        // CLI 자체 세션에는 되감은 대화가 남아 있으므로 재사용하지 않는다.
        tx.execute("DELETE FROM cli_sessions WHERE session_id = ?1", params![id])?;
        tx.execute("UPDATE sessions SET revision = revision + 1, timeline_revision = timeline_revision + 1, updated_at = ?2 WHERE id = ?1", params![id, now])?;
        append_message(tx, now, &id, "note", &json!({
            "type": "rewind", "message_id": body.message_id, "removed_count": removed,
            "text": "대화를 사용자 메시지 직전으로 되감았습니다. 파일·Git 변경과 실행 기록은 되돌리지 않았습니다.",
        }), None, None)?;
        let session = get(tx, &id)?;
        events::append(tx, now, "session.rewound", Some(&cur.project_id), Some(&id), &json!({
            "session": session, "message_id": body.message_id, "removed_count": removed,
        }))?;
        Ok((StatusCode::OK, json!({ "session": session, "removed_count": removed, "files_unchanged": true })))
    }).await
}

#[derive(Deserialize)]
pub struct ForkSession {
    /// 이 seq까지의 메시지를 계승한다.
    pub from_seq: i64,
    pub inherit_context: bool,
    pub title: Option<String>,
}

/// 분기(SESSION-007). 대화 표시는 항상 원본 이력을 참조하고, 모델 컨텍스트 계승은 선택이다.
pub async fn fork(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ForkSession>,
) -> ApiResult<Response> {
    let h = idem::body_hash(
        "session.fork",
        &json!({ "id": id, "seq": body.from_seq, "ctx": body.inherit_context, "title": body.title }),
    );
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let parent = get_active(tx, &id)?;
        if body.from_seq < 0 || body.from_seq > parent.last_message_seq {
            return Err(ApiError::invalid("분기 지점이 범위를 벗어났습니다"));
        }
        let title = clean_title(Some(body.title.unwrap_or_else(|| format!("{} (분기)", parent.title))))?;
        let nid = crate::util::new_id();
        tx.execute(
            "INSERT INTO sessions (id, project_id, title, created_at, updated_at, parent_session_id, fork_message_seq, fork_inherits_context, workflow_id, worktree_id) \
             VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![nid, parent.project_id, title, now, id, body.from_seq, body.inherit_context, parent.workflow_id, parent.worktree_id],
        )?;
        let s = get(tx, &nid)?;
        events::append(tx, now, "session.created", Some(&s.project_id), Some(&nid), &serde_json::to_value(&s)?)?;
        Ok((StatusCode::CREATED, serde_json::to_value(s)?))
    })
    .await
}
