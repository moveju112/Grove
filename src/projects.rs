//! 프로젝트 = 단일 작업공간(PROJECT). 프로젝트마다 root 경로 하나, 중간 생성 단계 없음.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::idem;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
    pub archived_at: Option<String>,
    /// root 경로가 현재 접근 가능한 디렉터리인지
    pub available: bool,
}

const COLS: &str = "id, name, root_path, created_at, updated_at, revision, archived_at";

fn from_row(r: &Row) -> rusqlite::Result<Project> {
    let root: String = r.get(2)?;
    let available = std::path::Path::new(&root).is_dir();
    Ok(Project {
        id: r.get(0)?,
        name: r.get(1)?,
        root_path: root,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
        revision: r.get(5)?,
        archived_at: r.get(6)?,
        available,
    })
}

pub fn get(conn: &Connection, id: &str) -> ApiResult<Project> {
    conn.query_row(&format!("SELECT {COLS} FROM projects WHERE id = ?1"), params![id], from_row)
        .optional()?
        .ok_or_else(|| ApiError::not_found("프로젝트가 없습니다"))
}

/// 실행 가능한(보관되지 않은) 프로젝트의 root 경로.
pub fn active_root(conn: &Connection, id: &str) -> ApiResult<std::path::PathBuf> {
    let p = get(conn, id)?;
    if p.archived_at.is_some() {
        return Err(ApiError::conflict("archived", "보관된 프로젝트입니다"));
    }
    let root = std::path::PathBuf::from(&p.root_path);
    if !root.is_dir() {
        return Err(ApiError::gone("프로젝트 경로에 접근할 수 없습니다"));
    }
    Ok(root)
}

#[derive(Deserialize)]
pub struct CreateProject {
    pub root_path: String,
    pub name: Option<String>,
}

pub async fn create(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Json(body): Json<CreateProject>,
) -> ApiResult<Response> {
    let raw = body.root_path.trim();
    if raw.is_empty() {
        return Err(ApiError::invalid("root_path가 필요합니다"));
    }
    let canon = crate::util::canonical(raw).map_err(|_| ApiError::invalid("존재하지 않는 경로입니다"))?;
    if !canon.is_dir() {
        return Err(ApiError::invalid("디렉터리가 아닙니다"));
    }
    let root = canon.to_string_lossy().to_string();
    let name = body
        .name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| canon.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| root.clone()));
    if name.chars().count() > 120 {
        return Err(ApiError::invalid("이름은 120자 이하여야 합니다"));
    }
    let h = idem::body_hash("project.create", &json!({ "root": root, "name": name }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let existing: Option<String> =
            tx.query_row("SELECT id FROM projects WHERE root_path = ?1", params![root], |r| r.get(0)).optional()?;
        if let Some(id) = existing {
            return Err(ApiError::conflict("already_exists", "이미 등록된 경로입니다").with_details(json!({ "id": id })));
        }
        let id = crate::util::new_id();
        tx.execute(
            "INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, name, root, now],
        )?;
        let proj = get(tx, &id)?;
        events::append(tx, now, "project.created", Some(&id), None, &serde_json::to_value(&proj)?)?;
        Ok((StatusCode::CREATED, serde_json::to_value(proj)?))
    })
    .await
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub archived: Option<bool>,
}

pub async fn list(State(app): State<App>, _p: Principal, Query(q): Query<ListQuery>) -> ApiResult<Json<Vec<Project>>> {
    let archived = q.archived.unwrap_or(false);
    let v = app
        .db
        .call(move |c| {
            let sql = format!(
                "SELECT {COLS} FROM projects WHERE (archived_at IS NOT NULL) = ?1 ORDER BY name COLLATE NOCASE, id"
            );
            let mut s = c.prepare(&sql)?;
            let v = s.query_map(params![archived], from_row)?.collect::<Result<Vec<_>, _>>()?;
            Ok(v)
        })
        .await?;
    Ok(Json(v))
}

pub async fn show(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Project>> {
    Ok(Json(app.db.call(move |c| get(c, &id)).await?))
}

#[derive(Deserialize)]
pub struct UpdateProject {
    pub expected_revision: i64,
    pub name: Option<String>,
    pub archived: Option<bool>,
    /// 폴더를 옮겼을 때 새 경로로 다시 연결한다(PROJECT-007). 기존 폴더는 건드리지 않는다.
    pub root_path: Option<String>,
}

/// 실행 중인 턴·백그라운드 작업·터미널 수(경로를 바꾸면 안 되는 상태).
fn running_in_project(c: &Connection, id: &str) -> ApiResult<i64> {
    Ok(c.query_row(
        "SELECT (SELECT COUNT(*) FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.project_id = ?1 AND t.status IN ('queued','running','awaiting_approval')) \
              + (SELECT COUNT(*) FROM tasks k JOIN sessions s ON s.id = k.session_id WHERE s.project_id = ?1 AND k.status = 'running') \
              + (SELECT COUNT(*) FROM terminals m WHERE m.project_id = ?1 AND m.status = 'running')",
        params![id],
        |r| r.get(0),
    )?)
}

pub async fn update(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<UpdateProject>,
) -> ApiResult<Response> {
    let name = body.name.as_ref().map(|n| n.trim().to_string());
    if let Some(n) = &name {
        if n.is_empty() || n.chars().count() > 120 {
            return Err(ApiError::invalid("이름은 1~120자여야 합니다"));
        }
    }
    let new_root = match body.root_path.as_deref().map(str::trim) {
        None => None,
        Some(raw) => {
            let canon = crate::util::canonical(raw).map_err(|_| ApiError::invalid("존재하지 않는 경로입니다"))?;
            if !canon.is_dir() {
                return Err(ApiError::invalid("디렉터리가 아닙니다"));
            }
            Some(canon.to_string_lossy().to_string())
        }
    };
    let h = idem::body_hash(
        "project.update",
        &json!({ "id": id, "rev": body.expected_revision, "name": name, "archived": body.archived, "root": new_root }),
    );
    let rev = body.expected_revision;
    let archived = body.archived;
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get(tx, &id)?;
        if cur.revision != rev {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        if let Some(r) = new_root.as_deref().filter(|r| *r != cur.root_path) {
            let other: Option<String> = tx.query_row("SELECT id FROM projects WHERE root_path = ?1", params![r], |x| x.get(0)).optional()?;
            if let Some(o) = other {
                return Err(ApiError::conflict("already_exists", "다른 프로젝트가 쓰는 경로입니다").with_details(json!({ "id": o })));
            }
            let n = running_in_project(tx, &id)?;
            if n > 0 {
                return Err(ApiError::busy("실행 중인 요청·작업·터미널이 있어 경로를 바꿀 수 없습니다").with_details(json!({ "running": n })));
            }
            tx.execute("UPDATE projects SET root_path = ?2 WHERE id = ?1", params![id, r])?;
        }
        let new_name = name.unwrap_or(cur.name.clone());
        let archived_at = match archived {
            Some(true) => cur.archived_at.clone().or(Some(now.to_string())),
            Some(false) => None,
            None => cur.archived_at.clone(),
        };
        tx.execute(
            "UPDATE projects SET name = ?2, archived_at = ?3, updated_at = ?4, revision = revision + 1 WHERE id = ?1",
            params![id, new_name, archived_at, now],
        )?;
        let proj = get(tx, &id)?;
        events::append(tx, now, "project.updated", Some(&id), None, &serde_json::to_value(&proj)?)?;
        Ok((StatusCode::OK, serde_json::to_value(proj)?))
    })
    .await
}
