//! 프로젝트 script 정의와 명시적으로 확인한 실행 대상. 저장·조회만으로는 명령을 실행하지 않는다.
use crate::{App, auth::Principal, error::{ApiError, ApiResult}, events, idem};
use axum::{Json, extract::{Path, Query, State}, http::{HeaderMap, StatusCode}, response::Response};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path as FsPath;

#[derive(Debug, Clone, Serialize)]
pub struct Script {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub command: String,
    pub revision: i64,
}
const COLS: &str = "id,project_id,name,command,revision";
fn row(r: &rusqlite::Row) -> rusqlite::Result<Script> {
    Ok(Script { id: r.get(0)?, project_id: r.get(1)?, name: r.get(2)?, command: r.get(3)?, revision: r.get(4)? })
}
fn get(c: &Connection, id: &str) -> ApiResult<Script> {
    c.query_row(&format!("SELECT {COLS} FROM project_scripts WHERE id=?1 AND deleted_at IS NULL"), [id], row)
        .optional()?.ok_or_else(|| ApiError::not_found("프로젝트 script가 없습니다"))
}
fn validate(name: &str, command: &str) -> ApiResult<()> {
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control)
        || command.trim().is_empty() || command.len() > 64 * 1024 || command.contains('\0')
    {
        return Err(ApiError::invalid("이름은 1~80자, 명령은 비어 있지 않은 64KiB 이하 문자열이어야 합니다"));
    }
    Ok(())
}
fn unique_name(c: &Connection, project: &str, name: &str, except: &str) -> ApiResult<()> {
    let exists: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM project_scripts WHERE project_id=?1 AND name=?2 AND id<>?3 AND deleted_at IS NULL)",
        params![project,name,except], |r| r.get(0))?;
    if exists { return Err(ApiError::conflict("already_exists", "같은 이름의 script가 있습니다")); }
    Ok(())
}
fn fingerprint(project: &crate::projects::Project, root: &FsPath, shell: &str) -> String {
    crate::util::sha256_hex(json!({
        "project":project.id,"revision":project.revision,"root":root.to_string_lossy(),"shell":shell
    }).to_string().as_bytes())
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Intent {
    pub id: String,
    pub expected_revision: i64,
    pub expected_execution: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Snapshot {
    pub id: String,
    pub name: String,
    pub revision: i64,
    pub execution: String,
}

pub(crate) fn prepare(c: &Connection, project_id: &str, intent: &Intent, command: &str, root: &FsPath, shell: &str) -> ApiResult<Snapshot> {
    let script = get(c, &intent.id)?;
    if script.project_id != project_id { return Err(ApiError::not_found("이 프로젝트의 script가 아닙니다")); }
    let project = crate::projects::get(c, project_id)?;
    let execution = fingerprint(&project, root, shell);
    if script.revision != intent.expected_revision || command != script.command || execution != intent.expected_execution {
        return Err(ApiError::conflict("script_changed", "script 또는 실행 대상이 바뀌었습니다. 프로젝트·셸·명령을 다시 확인하세요"));
    }
    Ok(Snapshot { id: script.id, name: script.name, revision: script.revision, execution })
}

pub async fn list(State(app): State<App>, principal: Principal, Path(project): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(app.db.call(move |c| {
        let p = crate::projects::get(c, &project)?;
        let scripts = c.prepare(&format!("SELECT {COLS} FROM project_scripts WHERE project_id=?1 AND deleted_at IS NULL ORDER BY name,id"))?
            .query_map([&project], row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        let execution = if p.available && p.archived_at.is_none() {
            let root = crate::projects::active_root(c, &project)?;
            let setting = crate::settings::effective(c, "exec.shell", Some(&project), None)?;
            let shell = crate::tools::shell::resolve_shell(setting.as_str().unwrap_or("default"));
            Some(json!({"root":root.to_string_lossy(),"shell":shell,"fingerprint":fingerprint(&p,&root,shell)}))
        } else { None };
        Ok(json!({"scripts":scripts,"execution":execution,"owner":principal.root_id}))
    }).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    pub name: String,
    pub command: String,
}
pub async fn create(State(app): State<App>, p: Principal, headers: HeaderMap, Path(project): Path<String>, Json(body): Json<Create>) -> ApiResult<Response> {
    let name = body.name.trim().to_string();
    validate(&name, &body.command)?;
    let h = idem::body_hash("project-script.create", &json!({"project":project,"name":name,"command":body.command}));
    idem::run(&app,&p,&headers,&h,move |tx,now| {
        crate::projects::get(tx,&project)?;
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM project_scripts WHERE project_id=?1 AND deleted_at IS NULL", [&project], |r|r.get(0))?;
        if count >= 32 { return Err(ApiError::invalid("프로젝트 script는 32개까지 등록할 수 있습니다")); }
        unique_name(tx,&project,&name,"")?;
        let id = crate::util::new_id();
        tx.execute("INSERT INTO project_scripts(id,project_id,name,command,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)",
            params![id,project,name,body.command,now])?;
        let script = get(tx,&id)?;
        events::append(tx,now,"project_script.changed",Some(&project),None,&json!({"id":id,"revision":script.revision}))?;
        Ok((StatusCode::CREATED,json!(script)))
    }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Update {
    pub expected_revision: i64,
    pub name: String,
    pub command: String,
}
pub async fn update(State(app): State<App>, p: Principal, headers: HeaderMap, Path((project,id)): Path<(String,String)>, Json(body): Json<Update>) -> ApiResult<Response> {
    let name = body.name.trim().to_string();
    validate(&name,&body.command)?;
    let h = idem::body_hash("project-script.update",&json!({"project":project,"id":id,"revision":body.expected_revision,"name":name,"command":body.command}));
    idem::run(&app,&p,&headers,&h,move |tx,now| {
        let current = get(tx,&id)?;
        if current.project_id != project { return Err(ApiError::not_found("이 프로젝트의 script가 아닙니다")); }
        if current.revision != body.expected_revision { return Err(ApiError::revision_conflict(json!(current))); }
        unique_name(tx,&project,&name,&id)?;
        tx.execute("UPDATE project_scripts SET name=?2,command=?3,revision=revision+1,updated_at=?4 WHERE id=?1",params![id,name,body.command,now])?;
        let script = get(tx,&id)?;
        events::append(tx,now,"project_script.changed",Some(&project),None,&json!({"id":id,"revision":script.revision}))?;
        Ok((StatusCode::OK,json!(script)))
    }).await
}

#[derive(Deserialize)]
pub struct Delete { pub expected_revision: i64 }
pub async fn remove(State(app): State<App>, p: Principal, headers: HeaderMap, Path((project,id)): Path<(String,String)>, Query(body): Query<Delete>) -> ApiResult<Response> {
    let h = idem::body_hash("project-script.delete",&json!({"project":project,"id":id,"revision":body.expected_revision}));
    idem::run(&app,&p,&headers,&h,move |tx,now| {
        let current = get(tx,&id)?;
        if current.project_id != project { return Err(ApiError::not_found("이 프로젝트의 script가 아닙니다")); }
        if current.revision != body.expected_revision { return Err(ApiError::revision_conflict(json!(current))); }
        tx.execute("UPDATE project_scripts SET deleted_at=?2,updated_at=?2,revision=revision+1 WHERE id=?1",params![id,now])?;
        events::append(tx,now,"project_script.changed",Some(&project),None,&json!({"id":id,"deleted":true}))?;
        Ok((StatusCode::OK,json!({"deleted":true})))
    }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Run {
    pub command: String,
    pub expected_revision: i64,
    pub expected_execution: String,
    pub expected_owner: String,
    /// 초기 설정 실행(PROJECT-010). 이 script가 프로젝트의 초기 설정 script여야 한다.
    #[serde(default)]
    pub setup: bool,
}
pub async fn run(State(app): State<App>, p: Principal, headers: HeaderMap, Path((session,id)): Path<(String,String)>, Json(body): Json<Run>) -> ApiResult<Response> {
    if p.root_id != body.expected_owner {
        return Err(ApiError::new(StatusCode::FORBIDDEN,"actor_changed","다른 인증으로 접수한 요청입니다. 원래 인증으로 결과를 확인하세요"));
    }
    // 정의를 먼저 다시 읽으면 접수 뒤 삭제·편집된 요청의 응답 확인이 깨지므로 공통 receipt를 먼저 확인한다.
    crate::tasks::start(State(app),p,headers,Path(session),Json(crate::tasks::StartBody {
        command:body.command,cwd:Some(".".into()),timeout_ms:None,
        script:Some(Intent {id,expected_revision:body.expected_revision,expected_execution:body.expected_execution}),
        setup:body.setup,
    })).await
}

/// 초기 설정 상태(PROJECT-010): 지정한 script와 실행 위치(프로젝트 폴더·활성 worktree)별 마지막 설정 실행.
/// 상태는 작업 상태 그대로(running·completed·failed·timeout·cancelled·unknown), 실행한 적 없으면 not_run.
/// 각 위치의 실행 확인값(fingerprint)을 함께 돌려 화면이 그 위치의 대화에서 확인된 실행을 요청하게 한다.
pub async fn setup_status(State(app): State<App>, _p: Principal, Path(project): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(app.db.call(move |c| {
        let p = crate::projects::get(c, &project)?;
        let script = match &p.setup_script_id {
            Some(id) => c.query_row(&format!("SELECT {COLS} FROM project_scripts WHERE id=?1 AND deleted_at IS NULL"), [id], row).optional()?,
            None => None,
        };
        let usable = p.available && p.archived_at.is_none();
        let shell = {
            let setting = crate::settings::effective(c, "exec.shell", Some(&project), None)?;
            crate::tools::shell::resolve_shell(setting.as_str().unwrap_or("default")).to_string()
        };
        let mut targets: Vec<(Option<String>, String, String)> = vec![(None, "프로젝트 폴더".into(), p.root_path.clone())];
        let mut st = c.prepare("SELECT id, name, path FROM worktrees WHERE project_id = ?1 AND status = 'active' ORDER BY created_at")?;
        for r in st.query_map([&project], |r| Ok((Some(r.get::<_, String>(0)?), r.get::<_, String>(1)?, r.get::<_, String>(2)?)))? {
            targets.push(r?);
        }
        let mut out = vec![];
        for (wid, name, path) in targets {
            let last: Option<(String, String, String, Option<i64>, String, Option<String>)> = c.query_row(
                "SELECT t.id, t.session_id, t.status, t.exit_code, t.started_at, t.ended_at FROM setup_runs r JOIN tasks t ON t.id = r.task_id \
                 WHERE r.project_id = ?1 AND r.worktree_id IS ?2 AND r.script_id = ?3 ORDER BY r.created_at DESC, r.task_id DESC LIMIT 1",
                params![project, wid, p.setup_script_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            ).optional()?;
            let attempts: i64 = c.query_row(
                "SELECT COUNT(*) FROM setup_runs WHERE project_id = ?1 AND worktree_id IS ?2 AND script_id = ?3",
                params![project, wid, p.setup_script_id], |r| r.get(0))?;
            let exists = FsPath::new(&path).is_dir();
            let fingerprint = (usable && exists).then(|| fingerprint(&p, FsPath::new(&path), &shell));
            out.push(json!({
                "worktree_id": wid, "name": name, "path": path, "fingerprint": fingerprint, "attempts": attempts,
                "status": last.as_ref().map(|l| l.2.clone()).unwrap_or_else(|| "not_run".into()),
                "task_id": last.as_ref().map(|l| l.0.clone()), "session_id": last.as_ref().map(|l| l.1.clone()),
                "exit_code": last.as_ref().and_then(|l| l.3), "started_at": last.as_ref().map(|l| l.4.clone()),
                "ended_at": last.as_ref().and_then(|l| l.5.clone()),
            }));
        }
        Ok(json!({ "script": script, "targets": out }))
    }).await?))
}
