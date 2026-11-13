//! Grove 승인 root만 변경한다. 원본 CLI 설정·정의는 읽거나 쓰지 않는다.
//! 외부 파일 부작용은 기존 result_unknown receipt를 먼저 남기며 재전송으로 재실행하지 않는다.

use super::{AllowedRoot, MAX_BODY_BYTES, MAX_SKILLS, SkillCatalog, SkillSelection, error, io_error, valid_name};
use super::api::{api_error, catalog, scope};
use crate::{App, auth::Principal, error::{ApiError, ApiResult}, idem, project_fs::ProjectFs, util::sha256_hex};
use axum::{Json, extract::{Path, State}, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path as FsPath;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope { Global, Project }

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Mutation {
    Add { scope: Scope, name: String, text: String },
    Save { selection: SkillSelection, text: String },
    SetEnabled { selection: SkillSelection, enabled: bool },
}

// 기본 발견 항목은 기존 원문 SHA를 유지한다. 활성 상태가 바뀐 항목은 세대를 포함한다.
pub(super) fn revision(content: &str, generation: i64) -> String {
    if generation == 0 { content.to_owned() }
    else { sha256_hex(format!("grove-skill-state:{generation}:{content}").as_bytes()) }
}

pub(super) fn apply_states(c: &Connection, catalog: &mut SkillCatalog) -> ApiResult<()> {
    for (entry, record) in catalog.listing.entries.iter_mut().zip(&mut catalog.records) {
        let state: Option<(bool, i64)> = c.query_row(
            "SELECT enabled,generation FROM skill_states WHERE skill_id=?1", [&entry.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        if let Some((enabled, generation)) = state {
            entry.enabled = enabled;
            entry.revision = revision(&entry.revision, generation);
            record.generation = generation;
        }
    }
    Ok(())
}

fn writable(c: &Connection, p: &Principal, now: &str, session: &str) -> ApiResult<(String, std::path::PathBuf)> {
    crate::auth::check_principal(c, p, now)?;
    let approved = scope(c, session)?;
    if crate::settings::all_layers(c, "tools.mode", Some(&approved.0), Some(session))?
        .iter().any(|v| v == "read_only")
    {
        return Err(ApiError::forbidden("읽기 전용 모드에서는 스킬을 변경할 수 없습니다"));
    }
    Ok(approved)
}

fn text_valid(text: &str) -> ApiResult<()> {
    if text.len() as u64 > MAX_BODY_BYTES {
        return Err(api_error(error("skill_too_large", "스킬 본문 크기 제한을 넘었습니다")));
    }
    if text.contains('\0') {
        return Err(api_error(error("unsupported_format", "바이너리 스킬 본문은 지원하지 않습니다")));
    }
    Ok(())
}

fn location<'a>(scope: Scope, data: &'a FsPath, root: &'a FsPath, project: &'a str) -> (&'a FsPath, &'static str, Option<&'a str>) {
    match scope {
        Scope::Global => (data, "skills", None),
        Scope::Project => (root, ".agents/skills", Some(project)),
    }
}

fn absent(root: &AllowedRoot, name: &str) -> ApiResult<()> {
    match root.fs.dir.symlink_metadata(name) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(api_error(io_error(e))),
        Ok(_) => Err(ApiError::conflict("already_exists", "같은 이름이 이미 있습니다. 덮어쓰지 않습니다")),
    }
}

fn direct_root(root: &AllowedRoot) -> ApiResult<()> {
    if !root.direct {
        return Err(api_error(error("skill_read_only", "다른 위치로 연결된 스킬 root는 조회만 가능합니다")));
    }
    Ok(())
}

// 최종 root가 아직 없어도 기존 상위 alias를 따라 원본 CLI 폴더를 만들지 않는다.
fn direct_location(parent: &FsPath, relative: &str) -> ApiResult<()> {
    let fs = ProjectFs::open(parent).map_err(|e| api_error(io_error(e)))?;
    let mut prefix = std::path::PathBuf::new();
    for part in FsPath::new(relative).components() {
        prefix.push(part);
        match fs.dir.canonicalize(&prefix) {
            Ok(target) if target != prefix => return Err(api_error(error("skill_read_only", "다른 위치로 연결된 스킬 root는 조회만 가능합니다"))),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(api_error(io_error(e))),
        }
    }
    Ok(())
}

fn validate(c: &Connection, data: &FsPath, session: &str, mutation: &Mutation) -> ApiResult<SkillCatalog> {
    let catalog = catalog(c, data, session)?;
    match mutation {
        Mutation::Add { scope: destination, name, text } => {
            if !valid_name(name) || name.starts_with(".grove-") {
                return Err(ApiError::invalid("스킬 이름은 경로가 아닌 128자 이하 디렉터리명이어야 합니다"));
            }
            text_valid(text)?;
            if catalog.listing.entries.len() >= MAX_SKILLS {
                return Err(api_error(error("skills_limit", "스킬 수 제한을 넘었습니다")));
            }
            let (project, root) = scope(c, session)?;
            let (parent, relative, project) = location(*destination, data, &root, &project);
            direct_location(parent, relative)?;
            if let Some(root) = AllowedRoot::within(parent, FsPath::new(relative), project).map_err(api_error)? {
                direct_root(&root)?;
                absent(&root, name)?;
            }
        }
        Mutation::Save { selection, text } => {
            text_valid(text)?;
            catalog.read(selection).map_err(api_error)?;
            let index = catalog.index(selection).map_err(api_error)?;
            direct_root(&catalog.roots[catalog.records[index].root])?;
            // 읽기 alias 정책은 유지하지만 symlink를 교체하거나 alias의 원본을 편집하지 않는다.
            if catalog.listing.entries[index].symlink {
                return Err(api_error(error("skill_read_only", "symlink 스킬은 이 편집기로 저장하지 않습니다")));
            }
        }
        Mutation::SetEnabled { selection, .. } => {
            catalog.read(selection).map_err(api_error)?;
            let index = catalog.index(selection).map_err(api_error)?;
            direct_root(&catalog.roots[catalog.records[index].root])?;
        }
    }
    Ok(catalog)
}

fn write_error(e: std::io::Error) -> ApiError {
    // 기존 쓰기 오류 코드는 재사용하되 OS 원문은 경로·비밀 유출을 막기 위해 버린다.
    let code = crate::tools::fs::write_error(e).code;
    ApiError::new(match code {
        "permission_denied" | "read_only_filesystem" => StatusCode::FORBIDDEN,
        "storage_full" => StatusCode::INSUFFICIENT_STORAGE,
        _ => StatusCode::CONFLICT,
    }, code, "스킬 파일 변경을 완료하지 못했습니다")
}

fn execute(c: &Connection, data: &FsPath, session: &str, mutation: &Mutation) -> ApiResult<(Value, bool)> {
    let catalog = validate(c, data, session, mutation)?;
    match mutation {
        Mutation::Add { scope: destination, name, text } => {
            let (project, root) = scope(c, session)?;
            let (parent, relative, project) = location(*destination, data, &root, &project);
            direct_location(parent, relative)?;
            let parent_fs = ProjectFs::open(parent).map_err(write_error)?;
            parent_fs.create_dir_all(&parent.join(relative)).map_err(write_error)?;
            let root = AllowedRoot::within(parent, FsPath::new(relative), project).map_err(api_error)?
                .ok_or_else(|| ApiError::conflict("skill_changed", "스킬 출처가 변경됐습니다"))?;
            direct_root(&root)?;
            absent(&root, name)?;
            let stage = root.path.join(format!(".grove-skill-{}", crate::util::new_id()));
            root.fs.create_dir(&stage, true).map_err(write_error)?;
            let result = (|| {
                root.fs.write_new(&stage.join("SKILL.md"), text.as_bytes())?;
                root.fs.rename_noreplace(&stage, &root.fs, &root.path.join(name))
            })();
            if let Err(e) = result {
                root.fs.remove_dir_all(&stage).map_err(write_error)?;
                return Err(write_error(e));
            }
            let fresh = super::api::catalog(c, data, session)?;
            let entry = fresh.listing.entries.iter().find(|e| e.name == *name && e.source == root.source)
                .ok_or_else(|| ApiError::conflict("skill_changed", "저장한 스킬을 확인할 수 없습니다"))?;
            Ok((json!({"id":entry.id,"revision":entry.revision,"enabled":entry.enabled}), true))
        }
        Mutation::Save { selection, text } => {
            let index = catalog.index(selection).map_err(api_error)?;
            let record = &catalog.records[index];
            let root = &catalog.roots[record.root];
            let next = revision(&sha256_hex(text.as_bytes()), record.generation);
            let changed = next != selection.revision;
            if changed {
                root.fs.atomic_write(&root.path.join(&record.name).join("SKILL.md"), text.as_bytes()).map_err(write_error)?;
            }
            Ok((json!({"id":selection.id,"revision":next,
                "enabled":catalog.listing.entries[index].enabled}), changed))
        }
        Mutation::SetEnabled { selection, enabled } => {
            let index = catalog.index(selection).map_err(api_error)?;
            let changed = catalog.listing.entries[index].enabled != *enabled;
            if changed {
                c.execute(
                    "INSERT INTO skill_states(skill_id,enabled,generation) VALUES(?1,?2,1)
                     ON CONFLICT(skill_id) DO UPDATE SET enabled=excluded.enabled,generation=generation+1",
                    params![selection.id, enabled],
                )?;
            }
            let fresh = super::api::catalog(c, data, session)?;
            let entry = fresh.listing.entries.iter().find(|entry| entry.id == selection.id && entry.source == selection.source)
                .ok_or_else(|| ApiError::conflict("skill_changed", "활성 상태를 바꾼 스킬 출처가 변경됐습니다"))?;
            Ok((json!({"id":entry.id,"revision":entry.revision,"enabled":entry.enabled}), changed))
        }
    }
}

pub async fn mutate(State(app): State<App>, p: Principal, headers: HeaderMap, Path(session): Path<String>, Json(body): Json<Mutation>) -> ApiResult<Response> {
    let (principal, sid, now) = (p.clone(), session.clone(), app.now());
    let approved = app.db.call(move |c| writable(c, &principal, &now, &sid)).await?;
    let _resource = app.project_resources.ui_write(&app, &approved.0, &p).await?;
    // 전역 root 및 서로 같은 실행 root를 쓰는 세션의 변경도 기존 파일 mutation과 직렬화한다.
    let _files = app.storage.mutations.lock().await;
    let hash = idem::body_hash("skills.manage", &json!({"session":session,"body":body}));
    let (principal, sid, now, expected) = (p.clone(), session.clone(), app.now(), approved.clone());
    app.db.call(move |c| {
        if writable(c, &principal, &now, &sid)? != expected {
            return Err(ApiError::conflict("skill_changed", "세션 실행 위치가 변경됐습니다"));
        }
        Ok(())
    }).await?;
    // replay에도 현재 인증·정책·세션 위치를 먼저 확인한다. 본문 revision은 과거 성공에 대해 재검증하지 않는다.
    if let Some(response) = idem::replay(&app, &p, &headers, &hash).await? { return Ok(response); }
    let (sid, data, input) = (session.clone(), app.cfg.data_dir.clone(), body.clone());
    app.db.call(move |c| { validate(c, &data, &sid, &input)?; Ok(()) }).await?;
    let unknown = ApiError::conflict("result_unknown", "스킬 변경 결과가 불명확합니다. 다시 읽기로 현재 상태를 확인하세요. 같은 요청은 재실행하지 않습니다");
    let pending = unknown.body();
    let (principal, sid, expected) = (p.clone(), session.clone(), approved.clone());
    let accepted = idem::run(&app, &p, &headers, &hash, move |tx, now| {
        if writable(tx, &principal, now, &sid)? != expected {
            return Err(ApiError::conflict("skill_changed", "세션 실행 위치가 변경됐습니다"));
        }
        Ok((StatusCode::CONFLICT, pending))
    }).await?;
    if accepted.headers().contains_key("idempotent-replayed") { return Ok(accepted); }
    let (data, principal, key, now) = (app.cfg.data_dir.clone(), p.clone(), idem::key_from(&headers)?, app.now());
    let response = app.db.call(move |c| {
        let tx = c.transaction()?;
        if writable(&tx, &principal, &now, &session)? != approved {
            return Err(ApiError::conflict("skill_changed", "세션 실행 위치가 변경됐습니다"));
        }
        let (response, changed) = execute(&tx, &data, &session, &body)?;
        if changed { crate::events::append(&tx, &now, "skill.changed", Some(&approved.0), None, &response)?; }
        idem::complete(&tx, &principal.root_id, &key, &hash, StatusCode::OK, &response)?;
        tx.commit()?;
        Ok(response)
    }).await.map_err(|e| {
        tracing::warn!(code=e.code, "스킬 변경 결과 불명");
        unknown.with_details(json!({"cause":e.code}))
    })?;
    app.notify_events().await;
    Ok(Json(response).into_response())
}
