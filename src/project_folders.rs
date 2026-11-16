//! 사이드바 정리용 폴더. 실제 디렉터리·프로젝트 경로·대화는 변경하지 않는다.

use crate::{App, auth::Principal, error::{ApiError, ApiResult}, events, idem};
use axum::{Json, extract::{Path, Query, State}, http::{HeaderMap, StatusCode}, response::Response};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct ProjectFolder {
    pub id: String,
    pub name: String,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    pub project_count: i64,
}

const COLS: &str = "id, name, revision, created_at, updated_at, (SELECT COUNT(*) FROM projects WHERE folder_id = project_folders.id)";

fn from_row(row: &Row) -> rusqlite::Result<ProjectFolder> {
    Ok(ProjectFolder { id: row.get(0)?, name: row.get(1)?, revision: row.get(2)?,
        created_at: row.get(3)?, updated_at: row.get(4)?, project_count: row.get(5)? })
}

pub fn get(conn: &Connection, id: &str) -> ApiResult<ProjectFolder> {
    conn.query_row(&format!("SELECT {COLS} FROM project_folders WHERE id = ?1"), params![id], from_row)
        .optional()?.ok_or_else(|| ApiError::not_found("정리용 폴더가 없습니다"))
}

fn normalize(name: &str) -> ApiResult<(String, String)> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(ApiError::invalid("폴더 이름은 1~80자여야 합니다"));
    }
    let key = name.to_lowercase();
    Ok((name, key))
}

fn available(conn: &Connection, key: &str, except: Option<&str>) -> ApiResult<()> {
    let id: Option<String> = conn.query_row("SELECT id FROM project_folders WHERE name_key = ?1", params![key], |r| r.get(0)).optional()?;
    if id.as_deref().is_some_and(|id| Some(id) != except) {
        return Err(ApiError::conflict("folder_name_taken", "같은 이름의 폴더가 이미 있습니다"));
    }
    Ok(())
}

pub async fn list(State(app): State<App>, _p: Principal) -> ApiResult<Json<Vec<ProjectFolder>>> {
    Ok(Json(app.db.call(|conn| {
        let mut query = conn.prepare(&format!("SELECT {COLS} FROM project_folders ORDER BY name_key, id"))?;
        Ok(query.query_map([], from_row)?.collect::<Result<Vec<_>, _>>()?)
    }).await?))
}

#[derive(Deserialize)]
pub struct CreateFolder {
    pub name: String,
}

pub async fn create(State(app): State<App>, p: Principal, headers: HeaderMap, Json(body): Json<CreateFolder>) -> ApiResult<Response> {
    let (name, key) = normalize(&body.name)?;
    let hash = idem::body_hash("project_folder.create", &json!({ "name": name }));
    idem::run(&app, &p, &headers, &hash, move |tx, now| {
        available(tx, &key, None)?;
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM project_folders", [], |r| r.get(0))?;
        if count >= 200 { return Err(ApiError::conflict("limit", "폴더는 200개까지 만들 수 있습니다")); }
        let id = crate::util::new_id();
        tx.execute("INSERT INTO project_folders (id,name,name_key,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)", params![id,name,key,now])?;
        let folder = get(tx, &id)?;
        events::append(tx, now, "project_folder.changed", None, None, &serde_json::to_value(&folder)?)?;
        Ok((StatusCode::CREATED, serde_json::to_value(folder)?))
    }).await
}

#[derive(Deserialize)]
pub struct UpdateFolder {
    pub expected_revision: i64,
    pub name: String,
}

pub async fn update(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(body): Json<UpdateFolder>) -> ApiResult<Response> {
    let (name, key) = normalize(&body.name)?;
    let hash = idem::body_hash("project_folder.update", &json!({ "id": id, "revision": body.expected_revision, "name": name }));
    idem::run(&app, &p, &headers, &hash, move |tx, now| {
        let current = get(tx, &id)?;
        if current.revision != body.expected_revision { return Err(ApiError::revision_conflict(serde_json::to_value(current)?)); }
        available(tx, &key, Some(&id))?;
        if current.name != name {
            tx.execute("UPDATE project_folders SET name=?2,name_key=?3,revision=revision+1,updated_at=?4 WHERE id=?1", params![id,name,key,now])?;
        }
        let folder = get(tx, &id)?;
        events::append(tx, now, "project_folder.changed", None, None, &serde_json::to_value(&folder)?)?;
        Ok((StatusCode::OK, serde_json::to_value(folder)?))
    }).await
}

#[derive(Deserialize)]
pub struct DeleteFolder {
    pub expected_revision: i64,
}

pub async fn remove(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Query(body): Query<DeleteFolder>) -> ApiResult<Response> {
    let hash = idem::body_hash("project_folder.delete", &json!({ "id": id, "revision": body.expected_revision }));
    idem::run(&app, &p, &headers, &hash, move |tx, now| {
        let folder = get(tx, &id)?;
        if folder.revision != body.expected_revision { return Err(ApiError::revision_conflict(serde_json::to_value(folder)?)); }
        let mut query = tx.prepare("SELECT id FROM projects WHERE folder_id=?1 ORDER BY id")?;
        let projects = query.query_map(params![id], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        drop(query);
        tx.execute("UPDATE projects SET folder_id=NULL,revision=revision+1 WHERE folder_id=?1", params![id])?;
        tx.execute("DELETE FROM project_folders WHERE id=?1", params![id])?;
        for project_id in &projects {
            let project = crate::projects::get(tx, project_id)?;
            events::append(tx, now, "project.updated", Some(project_id), None, &serde_json::to_value(project)?)?;
        }
        events::append(tx, now, "project_folder.deleted", None, None, &json!({ "id": id }))?;
        Ok((StatusCode::OK, json!({ "id": id, "affected_project_count": projects.len() })))
    }).await
}
