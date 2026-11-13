//! Hook 설정과 승인형 lifecycle 실행(RESOURCE-015/016).
mod execution;
pub use execution::{capture, execute_call, plan_call, recover, validate_call};
use crate::{
    App, audit,
    auth::Owner,
    error::{ApiError, ApiResult},
    events, idem,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::OnceLock;

pub const EVENTS: &[&str] = &[
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd",
];
pub const EXECUTION_STATE: &str = "not_implemented";
pub const SUPPORTED_EVENTS: &[&str] = if cfg!(target_os = "linux") {
    &["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]
} else { &[] };

fn execution_state(event: &str) -> &'static str {
    if SUPPORTED_EVENTS.contains(&event) { "approval_required" } else { EXECUTION_STATE }
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub project_id: Option<String>,
}

impl Scope {
    fn check(&self, c: &Connection) -> ApiResult<()> {
        if let Some(id) = &self.project_id {
            // 단일 사용자 서버의 프로젝트는 공유되지만 hook 설정은 Owner만 관리한다.
            let project = crate::projects::get(c, id)?;
            if project.archived_at.is_some() {
                return Err(ApiError::conflict("archived", "보관된 프로젝트의 hook은 변경할 수 없습니다"));
            }
        }
        Ok(())
    }
}

#[derive(Serialize)]
pub struct Hook {
    pub id: String,
    pub project_id: Option<String>,
    pub name: String,
    pub event: String,
    pub matcher: String,
    pub command: String,
    pub command_redacted: bool,
    pub enabled: bool,
    pub revision: i64,
    pub execution_state: &'static str,
}

struct Stored {
    id: String,
    project_id: Option<String>,
    name: String,
    event: String,
    matcher: String,
    command: String,
    enabled: bool,
    revision: i64,
}

impl Stored {
    fn view(&self) -> Hook {
        let command_redacted = sensitive(&self.command);
        Hook {
            id: self.id.clone(), project_id: self.project_id.clone(),
            name: self.name.clone(), event: self.event.clone(), matcher: self.matcher.clone(),
            command: if command_redacted { "[redacted]".into() } else { self.command.clone() },
            command_redacted, enabled: self.enabled, revision: self.revision,
            execution_state: execution_state(&self.event),
        }
    }
}

// 셸 문법을 해석하거나 재작성하지 않는다. 비밀 징후가 있으면 명령 전체를 가린다.
fn sensitive(command: &str) -> bool {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| regex::Regex::new(
        r#"(?i)(secret|token|password|passwd|api[_-]?key|authorization|credential|private[_ -]?key|bearer\s|sk-[a-z0-9]|gh[pousr]_|github_pat_|AKIA[A-Z0-9]|grv_|gva_|://[^/\s]*@|(?:^|[\s'"])(?:--)?key(?:[=\s]|$)|(?:^|\s)-u(?:[=\s]|$)|[a-z0-9_+/=-]{40,})"#
    ).expect("constant secret pattern")).is_match(command)
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Stored> {
    Ok(Stored {
        id: r.get(0)?, project_id: r.get(1)?, name: r.get(2)?, event: r.get(3)?,
        matcher: r.get(4)?, command: r.get(5)?, enabled: r.get(6)?, revision: r.get(7)?,
    })
}
const COLS: &str = "id,project_id,name,event,matcher,command,enabled,revision";

fn get(c: &Connection, id: &str, scope: &Scope) -> ApiResult<Stored> {
    c.query_row(
        &format!("SELECT {COLS} FROM hook_definitions WHERE id=?1 AND project_id IS ?2"),
        params![id, scope.project_id], row,
    ).optional()?.ok_or_else(|| ApiError::not_found("이 범위의 hook이 없습니다"))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Definition {
    pub name: String,
    pub event: String,
    /// glob 문법. *는 모든 대상이며 정규식·셸 표현식이 아니다.
    pub matcher: String,
    pub command: String,
    #[serde(default)]
    pub enabled: bool,
}
fn validate(name: &str, event: &str, matcher: &str, command: &str) -> ApiResult<()> {
    if name.trim().is_empty() || name.len() > 160 || name.chars().any(char::is_control) {
        return Err(ApiError::invalid("hook 이름은 제어 문자 없는 1~160바이트여야 합니다"));
    }
    if !EVENTS.contains(&event) {
        return Err(ApiError::invalid("서버가 제공하는 hook 이벤트를 선택하세요"));
    }
    if matcher.trim().is_empty() || matcher.len() > 512 || matcher.chars().any(char::is_control)
        || globset::Glob::new(matcher).is_err()
    {
        return Err(ApiError::invalid("matcher는 1~512바이트의 유효한 glob이어야 합니다"));
    }
    if command.trim().is_empty() || command.len() > 65536 || command.contains('\0') {
        return Err(ApiError::invalid("명령은 NUL 없는 1~65536바이트 문자열이어야 합니다"));
    }
    Ok(())
}

fn changed(c: &Connection, now: &str, p: &crate::auth::Principal, hook: &Stored, deleted: bool) -> ApiResult<()> {
    let detail = json!({"id":hook.id,"revision":hook.revision,"deleted":deleted});
    events::append(c, now, "hook.changed", hook.project_id.as_deref(), None, &detail)?;
    audit::record(c, now, p, if deleted { "hook.delete" } else { "hook.save" }, &hook.id, detail)
}

pub async fn list(State(app): State<App>, Owner(_p): Owner, Query(scope): Query<Scope>) -> ApiResult<Json<Value>> {
    Ok(Json(app.db.call(move |c| {
        scope.check(c)?;
        let hooks = c.prepare(&format!("SELECT {COLS} FROM hook_definitions WHERE project_id IS ?1 ORDER BY name,id"))?
            .query_map([&scope.project_id], row)?
            .map(|r| r.map(|h| h.view())).collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(json!({"hooks":hooks,"events":EVENTS,"matcher_syntax":"glob",
            "execution_state":if SUPPORTED_EVENTS.is_empty() { EXECUTION_STATE } else { "partial" },
            "supported_events":SUPPORTED_EVENTS,
            "execution_note":"지원 이벤트는 개별 tool_calls 승인 요청을 만듭니다. 원래 작업을 차단하지 않는 독립 실행입니다. Linux bash·sh만 실행하며 PreToolUse·SessionEnd 및 다른 플랫폼·셸은 미지원입니다."}))
    }).await?))
}

/// hook 전용 승인 화면. 실행·결정·취소·unknown 검토는 기존 tool_calls API를 그대로 쓴다.
pub async fn executions(State(app): State<App>, Owner(_p): Owner, Query(scope): Query<Scope>) -> ApiResult<Json<Value>> {
    Ok(Json(app.db.call(move |c| {
        scope.check(c)?;
        let ids = c.prepare(
            "SELECT id FROM tool_calls WHERE name='hook' AND (?1 IS NULL OR project_id=?1) ORDER BY rowid DESC LIMIT 100"
        )?.query_map([&scope.project_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let calls = ids.iter().map(|id| crate::approvals::get(c, id)).collect::<ApiResult<Vec<_>>>()?;
        Ok(json!(calls))
    }).await?))
}

pub async fn create(
    State(app): State<App>, Owner(p): Owner, headers: HeaderMap,
    Query(scope): Query<Scope>, Json(body): Json<Definition>,
) -> ApiResult<Response> {
    validate(&body.name, &body.event, &body.matcher, &body.command)?;
    let hash = idem::body_hash("hook.create", &json!({"scope":scope,"definition":body}));
    let actor = p.clone();
    idem::run(&app, &p, &headers, &hash, move |tx, now| {
        scope.check(tx)?;
        let id = crate::util::new_id();
        tx.execute(
            "INSERT INTO hook_definitions(id,project_id,name,event,matcher,command,enabled,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8)",
            params![id,scope.project_id,body.name,body.event,body.matcher,body.command,body.enabled,now],
        )?;
        let hook = get(tx, &id, &scope)?;
        changed(tx, now, &actor, &hook, false)?;
        Ok((StatusCode::CREATED, json!(hook.view())))
    }).await
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Update {
    pub expected_revision: i64,
    pub name: String,
    pub event: String,
    pub matcher: String,
    /// 생략/null이면 원문 유지. 가린 표시 문자열을 원문으로 덮어쓰지 않는다.
    pub command: Option<String>,
    pub enabled: bool,
}
pub async fn update(
    State(app): State<App>, Owner(p): Owner, headers: HeaderMap,
    Path(id): Path<String>, Query(scope): Query<Scope>, Json(body): Json<Update>,
) -> ApiResult<Response> {
    let hash = idem::body_hash("hook.update", &json!({"id":id,"scope":scope,"update":body}));
    let actor = p.clone();
    idem::run(&app, &p, &headers, &hash, move |tx, now| {
        scope.check(tx)?;
        let hook = get(tx, &id, &scope)?;
        if hook.revision != body.expected_revision {
            return Err(ApiError::revision_conflict(json!(hook.view())));
        }
        let command = body.command.as_deref().unwrap_or(&hook.command);
        validate(&body.name, &body.event, &body.matcher, command)?;
        tx.execute(
            "UPDATE hook_definitions SET name=?2,event=?3,matcher=?4,command=?5,enabled=?6,revision=revision+1,updated_at=?7 WHERE id=?1",
            params![id,body.name,body.event,body.matcher,command,body.enabled,now],
        )?;
        let hook = get(tx, &id, &scope)?;
        changed(tx, now, &actor, &hook, false)?;
        Ok((StatusCode::OK, json!(hook.view())))
    }).await
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Delete {
    pub expected_revision: i64,
    pub project_id: Option<String>,
}
pub async fn remove(
    State(app): State<App>, Owner(p): Owner, headers: HeaderMap,
    Path(id): Path<String>, Query(body): Query<Delete>,
) -> ApiResult<Response> {
    let hash = idem::body_hash("hook.delete", &json!({"id":id,"delete":body}));
    let actor = p.clone();
    idem::run(&app, &p, &headers, &hash, move |tx, now| {
        let scope = Scope { project_id: body.project_id };
        scope.check(tx)?;
        let hook = get(tx, &id, &scope)?;
        if hook.revision != body.expected_revision {
            return Err(ApiError::revision_conflict(json!(hook.view())));
        }
        tx.execute("DELETE FROM hook_definitions WHERE id=?1", [&id])?;
        changed(tx, now, &actor, &hook, true)?;
        Ok((StatusCode::OK, json!({"deleted":true,"execution_state":EXECUTION_STATE})))
    }).await
}
