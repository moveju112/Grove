//! 프로젝트·CLI가 실제 발견한 명령의 읽기 전용 목록. 본문·경로·선택 상태를 별도 관리하지 않는다.
use crate::{App, auth::Principal, error::{ApiError, ApiResult}};
use axum::{Json, extract::{Path, Query, State, rejection::QueryRejection}};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
pub use crate::provider::cli::commands::NativeCommand;

#[derive(Serialize, ts_rs::TS)]
pub struct NativeCommandCatalog {
    pub project_id: String,
    pub profile_id: String,
    pub protocol: String,
    pub commands: Vec<NativeCommand>,
    pub has_errors: bool,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandQuery {
    pub profile_id: String,
    pub session_id: Option<String>,
    pub worktree_id: Option<String>,
}

fn scope(c: &Connection, project: &str, query: &CommandQuery) -> ApiResult<(std::path::PathBuf, String, i64)> {
    let mut root = crate::projects::active_root(c, project)?;
    if query.session_id.is_some() && query.worktree_id.is_some() { return Err(ApiError::invalid("대화와 새 워크스페이스를 함께 지정할 수 없습니다")); }
    if let Some(session) = &query.session_id {
        if crate::sessions::get_active(c, session)?.project_id != project { return Err(ApiError::invalid("대화와 프로젝트가 다릅니다")); }
        root = crate::sessions::exec_root(c, session)?;
    } else if let Some(worktree) = &query.worktree_id {
        root = crate::worktrees::ensure_usable(c, project, worktree)?.path.into();
    }
    let profile = crate::models::get_enabled_profile(c, &query.profile_id)?;
    if !crate::provider::cli::is_cli(&profile.protocol) { return Err(ApiError::unsupported("CLI 모델에서만 스킬·명령을 사용할 수 있습니다")); }
    Ok((root, profile.protocol, profile.revision))
}

pub async fn list(State(app): State<App>, p: Principal, Path(project): Path<String>, query: Result<Query<CommandQuery>, QueryRejection>) -> ApiResult<Json<NativeCommandCatalog>> {
    let Query(query) = query.map_err(|_| ApiError::invalid("CLI 명령 조회 인자가 올바르지 않습니다"))?;
    let _guard = app.project_resources.ui_read(&app, &project, &p).await?;
    let (pid, q, principal, now) = (project.clone(), query.clone(), p.clone(), app.now());
    let before = app.db.call(move |c| {
        crate::auth::check_principal(c, &principal, &now)?;
        scope(c, &pid, &q)
    }).await?;
    let catalog = crate::provider::cli::commands::list(&before.1, &before.0).await
        .map_err(|error| ApiError::new(axum::http::StatusCode::BAD_GATEWAY, error.code, error.message))?;
    let (pid, q, principal, now) = (project.clone(), query.clone(), p, app.now());
    let protocol = before.1.clone();
    let commands = app.db.call(move |c| {
        crate::auth::check_principal(c, &principal, &now)?;
        if scope(c, &pid, &q)? != before { return Err(ApiError::conflict("native_commands_changed", "CLI 또는 실행 위치가 바뀌었습니다. 다시 조회하세요")); }
        let redact = crate::agent_overview::Redactor::new(c)?;
        Ok(catalog.commands.into_iter().filter_map(|command| {
            let mut info = command.info;
            if redact.text(&info.name) != info.name { return None; }
            info.description = redact.text(&info.description);
            info.argument_hint = redact.text(&info.argument_hint);
            Some(info)
        }).collect())
    }).await?;
    Ok(Json(NativeCommandCatalog { project_id: project, profile_id: query.profile_id, protocol, commands, has_errors: catalog.has_errors }))
}
