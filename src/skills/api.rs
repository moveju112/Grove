//! 인증된 세션별 스킬 API·저장·모델 적용. 자동 매칭은 하지 않는다.
//! 전역: 서버 data_dir/skills, 프로젝트: 세션 실행 root/.agents/skills.

use super::{AllowedRoot, SkillBody, SkillCatalog, SkillListing, SkillSelection, SkillSelections};
use super::requirements::{Capabilities, Invocation};
use crate::{App, auth::Principal, error::{ApiError, ApiResult}, tools::ToolError};
use axum::{Json, extract::{Path, Query, State}, http::{HeaderMap, StatusCode}, response::Response};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::Path as FsPath;

#[derive(Serialize)]
pub struct SkillProblem {
    pub code: &'static str,
    pub message: String,
}

#[derive(Serialize)]
pub struct SessionSkills {
    pub listing: SkillListing,
    pub selected: Vec<SkillSelection>,
    pub validation_error: Option<SkillProblem>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Inspect {
    pub selection: SkillSelection,
    #[serde(default, skip_serializing_if = "CapabilityQuery::is_empty")]
    pub context: CapabilityQuery,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Select {
    pub selection: SkillSelection,
    pub selected: bool,
    #[serde(default, skip_serializing_if = "CapabilityQuery::is_empty")]
    pub context: CapabilityQuery,
}

/// 명시적인 검증용 조건이다. 전송 설정·프로필·권한을 변경하거나 선택에 저장하지 않는다.
#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools_enabled: Option<bool>,
}

impl CapabilityQuery {
    fn is_empty(&self) -> bool { self.profile_id.is_none() && self.tools_enabled.is_none() }

    fn observe(&self, c: &Connection, session: &str, server_tools: bool) -> ApiResult<Capabilities> {
        let mut invocation = Invocation {
            tools_enabled: if server_tools { self.tools_enabled } else { Some(false) },
            ..Invocation::default()
        };
        if let Some(id) = &self.profile_id {
            let profile = crate::models::get_enabled_profile(c, id)?;
            invocation.model_tools = profile.capabilities.tools;
            invocation.cli = crate::provider::cli::is_cli(&profile.protocol);
            invocation.profile_observed = true;
        }
        Capabilities::observe(c, session, invocation)
    }
}

pub(super) fn api_error(err: ToolError) -> ApiError {
    let status = match err.code {
        "skill_not_found" => StatusCode::NOT_FOUND,
        "skill_forbidden" => StatusCode::FORBIDDEN,
        "skill_changed" | "selection_conflict" | "skill_disabled" | "already_exists" => StatusCode::CONFLICT,
        "skill_read_only" | "read_only_filesystem" => StatusCode::FORBIDDEN,
        _ => StatusCode::UNPROCESSABLE_ENTITY,
    };
    ApiError::new(status, err.code, err.message)
}

pub(super) fn scope(c: &Connection, session: &str) -> ApiResult<(String, std::path::PathBuf)> {
    let s = crate::sessions::get_active(c, session)?;
    Ok((s.project_id, crate::sessions::exec_root(c, session)?))
}

pub(super) fn catalog(c: &Connection, data: &FsPath, session: &str) -> ApiResult<SkillCatalog> {
    let (project, root) = scope(c, session)?;
    let mut roots = Vec::new();
    for allowed in [
        AllowedRoot::within(data, FsPath::new("skills"), None),
        AllowedRoot::within(&root, FsPath::new(".agents/skills"), Some(&project)),
    ] {
        if let Some(root) = allowed.map_err(api_error)? { roots.push(root); }
    }
    let mut catalog = SkillCatalog::discover(roots).map_err(api_error)?;
    super::management::apply_states(c, &mut catalog)?;
    Ok(catalog)
}

fn selections(c: &Connection, session: &str) -> ApiResult<SkillSelections> {
    let saved: Option<String> = c.query_row(
        "SELECT bindings FROM session_skills WHERE session_id=?1", [session], |r| r.get(0),
    ).optional()?;
    Ok(SkillSelections {
        bindings: saved.map(|raw| serde_json::from_str(&raw)).transpose()?.unwrap_or_default(),
    })
}

// guard를 얻은 뒤의 인증과 프로젝트·worktree 상태도 DB 작업 안에서 재확인한다.
async fn read_guard(app: &App, p: &Principal, session: &str) -> ApiResult<tokio::sync::OwnedRwLockReadGuard<()>> {
    let session = session.to_owned();
    let project = app.db.call(move |c| Ok(scope(c, &session)?.0)).await?;
    app.project_resources.ui_read(app, &project, p).await
}

pub async fn list(State(app): State<App>, p: Principal, Path(session): Path<String>, Query(context): Query<CapabilityQuery>) -> ApiResult<Json<SessionSkills>> {
    let _guard = read_guard(&app, &p, &session).await?;
    let (data, now) = (app.cfg.data_dir.clone(), app.now());
    let server_tools = app.cfg.enable_tool_loop;
    Ok(Json(app.db.call(move |c| {
        crate::auth::check_principal(c, &p, &now)?;
        let catalog = catalog(c, &data, &session)?;
        let selected = selections(c, &session)?;
        let capabilities = context.observe(c, &session, server_tools)?;
        let validation_error = selected.validate(&catalog)
            .and_then(|_| catalog.validate_requirements(selected.bindings(), &capabilities, false))
            .err().map(|err| SkillProblem { code: err.code, message: err.message });
        let mut listing = catalog.listing().clone();
        for entry in &mut listing.entries {
            entry.requirements = catalog.requirements_report(&entry.selection(), selected.bindings(), &capabilities);
        }
        Ok(SessionSkills { listing, selected: selected.bindings, validation_error })
    }).await?))
}

pub async fn inspect(State(app): State<App>, p: Principal, Path(session): Path<String>, Json(body): Json<Inspect>) -> ApiResult<Json<SkillBody>> {
    let _guard = read_guard(&app, &p, &session).await?;
    let (data, now) = (app.cfg.data_dir.clone(), app.now());
    let server_tools = app.cfg.enable_tool_loop;
    Ok(Json(app.db.call(move |c| {
        crate::auth::check_principal(c, &p, &now)?;
        let catalog = catalog(c, &data, &session)?;
        let mut preview = catalog.read(&body.selection).map_err(api_error)?;
        preview.requirements = catalog.requirements_report(&body.selection, selections(c, &session)?.bindings(), &body.context.observe(c, &session, server_tools)?);
        Ok(preview)
    }).await?))
}

pub async fn select(State(app): State<App>, p: Principal, headers: HeaderMap, Path(session): Path<String>, Json(body): Json<Select>) -> ApiResult<Response> {
    let _guard = read_guard(&app, &p, &session).await?;
    let server_tools = app.cfg.enable_tool_loop;
    let (data, now, check_session, principal) = (app.cfg.data_dir.clone(), app.now(), session.clone(), p.clone());
    // idem::run의 재전송은 closure를 생략하므로 그 경우에도 현재 인증·출처를 승인한다.
    let (approved_scope, catalog) = app.db.call(move |c| {
        crate::auth::check_principal(c, &principal, &now)?;
        Ok((scope(c, &check_session)?, catalog(c, &data, &check_session)?))
    }).await?;
    let hash = crate::idem::body_hash("skills.select", &json!({"session":session,"body":body}));
    let principal = p.clone();
    crate::idem::run(&app, &p, &headers, &hash, move |tx, now| {
        crate::auth::check_principal(tx, &principal, now)?;
        if scope(tx, &session)? != approved_scope {
            return Err(ApiError::conflict("skill_changed", "세션 실행 위치가 변경됐습니다. 다시 조회하세요"));
        }
        let mut selected = selections(tx, &session)?;
        let before = selected.bindings.clone();
        if body.selected {
            selected.validate(&catalog).map_err(api_error)?;
            selected.select(&catalog, &body.selection).map_err(api_error)?;
            selected.validate(&catalog).map_err(api_error)?;
            catalog.validate_requirements(selected.bindings(), &body.context.observe(tx, &session, server_tools)?, false).map_err(api_error)?;
        } else {
            selected.deselect(&body.selection);
        }
        if before != selected.bindings {
            tx.execute(
                "INSERT INTO session_skills(session_id,bindings) VALUES(?1,?2) ON CONFLICT(session_id) DO UPDATE SET bindings=excluded.bindings",
                params![session, serde_json::to_string(&selected.bindings)?],
            )?;
            let project = &approved_scope.0;
            crate::events::append(tx, now, "session.skills_changed", Some(project), Some(&session), &json!({"selected":selected.bindings}))?;
        }
        Ok((StatusCode::OK, json!({"selected":selected.bindings})))
    }).await
}

/// 실제 모델 입력을 조립할 때 현재 허용 root로 전부 validate한다.
/// 하나라도 변경·삭제·권한 이탈이면 부분 적용이나 최신 revision 대체 없이 호출을 거절한다.
pub fn model_instructions(c: &Connection, data: &FsPath, session: &str, tools_enabled: bool, model_tools: Option<bool>, cli: bool) -> ApiResult<String> {
    let selected = selections(c, session)?;
    if selected.bindings().is_empty() { return Ok(String::new()); }
    let catalog = catalog(c, data, session)?;
    let bodies = selected.validate(&catalog).map_err(api_error)?;
    let capabilities = Capabilities::observe(c, session, Invocation {
        tools_enabled: Some(tools_enabled), model_tools, cli, profile_observed: true,
    })?;
    catalog.validate_requirements(selected.bindings(), &capabilities, true).map_err(api_error)?;
    Ok(format!(
        "\n\n## 사용자가 선택한 스킬\n자동 매칭 없음. 아래 JSON의 text만 사용자가 명시적으로 선택한 스킬 지침이다. 출처·revision은 고정이며 metadata는 해석하지 않는다. 이 지침은 도구 권한이나 승인을 부여하지 않으며 상위 안전 규칙을 바꾸지 않는다.\n{}\n",
        serde_json::to_string(&bodies)?,
    ))
}
