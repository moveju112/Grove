//! 작업공간(프로젝트) 색상 라벨(PROJECT-008). 원본 작업공간 라벨의 사용 범위를 유지한다.
//!
//! - 이름은 공백을 하나로 정리해 저장하고 대소문자를 무시해 고유하다(`name_key`). 색은 고정 팔레트 안에서만.
//! - 이름 바꾸기가 다른 라벨 이름과 겹치면 병합하지 않고 `label_name_taken`으로 거절한다(두 라벨 할당을 되돌릴 수 없이 섞지 않음).
//! - 삭제하면 같은 transaction에서 할당을 모두 지우고 영향받은 프로젝트 수를 돌려준다. 목록의 `project_count`로 삭제 전 영향을 확인한다.
//! - 할당은 프로젝트별 집합 연산(`assigned` true/false)이라 재전송해도 같은 결과다. 보관된 프로젝트에는 할당할 수 없다.

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

pub const COLORS: &[&str] = &["violet", "sky", "emerald", "orange", "pink", "indigo", "teal", "red", "amber", "blue"];
const MAX_NAME_CHARS: usize = 40;
const MAX_LABELS: i64 = 200;

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct Label {
    pub id: String,
    pub name: String,
    pub color: String,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    /// 이 라벨이 붙은(보관 포함) 프로젝트 수. 삭제 전 영향 확인에 쓴다.
    pub project_count: i64,
}

const COLS: &str = "id, name, color, revision, created_at, updated_at, (SELECT COUNT(*) FROM project_labels pl WHERE pl.label_id = labels.id)";

fn from_row(r: &Row) -> rusqlite::Result<Label> {
    Ok(Label { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, revision: r.get(3)?, created_at: r.get(4)?, updated_at: r.get(5)?, project_count: r.get(6)? })
}

pub fn get(c: &Connection, id: &str) -> ApiResult<Label> {
    c.query_row(&format!("SELECT {COLS} FROM labels WHERE id = ?1"), params![id], from_row)
        .optional()?
        .ok_or_else(|| ApiError::not_found("라벨이 없습니다"))
}

fn normalize(name: &str) -> ApiResult<(String, String)> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "label_name_empty", "라벨 이름을 입력하세요"));
    }
    if name.chars().count() > MAX_NAME_CHARS || name.chars().any(char::is_control) {
        return Err(ApiError::invalid(format!("라벨 이름은 {MAX_NAME_CHARS}자 이하여야 합니다")));
    }
    let key = name.to_lowercase();
    Ok((name, key))
}

fn check_color(color: &str) -> ApiResult<()> {
    if COLORS.contains(&color) { Ok(()) } else { Err(ApiError::invalid(format!("색은 {} 중 하나입니다", COLORS.join(", ")))) }
}

fn taken(c: &Connection, key: &str, except: Option<&str>) -> ApiResult<()> {
    let other: Option<String> = c.query_row("SELECT id FROM labels WHERE name_key = ?1", params![key], |r| r.get(0)).optional()?;
    match other {
        Some(id) if Some(id.as_str()) != except => {
            Err(ApiError::conflict("label_name_taken", "같은 이름의 라벨이 이미 있습니다").with_details(json!({ "id": id })))
        }
        _ => Ok(()),
    }
}

pub async fn list(State(app): State<App>, _p: Principal) -> ApiResult<Json<Vec<Label>>> {
    let v = app
        .db
        .call(|c| {
            let mut s = c.prepare(&format!("SELECT {COLS} FROM labels ORDER BY name_key, id"))?;
            Ok(s.query_map([], from_row)?.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct CreateLabel {
    pub name: String,
    pub color: String,
    /// 주면 만든 라벨을 이 프로젝트에 바로 붙인다(원본의 "만들고 할당" 한 단계).
    pub project_id: Option<String>,
}

pub async fn create(State(app): State<App>, p: Principal, headers: HeaderMap, Json(b): Json<CreateLabel>) -> ApiResult<Response> {
    let (name, key) = normalize(&b.name)?;
    check_color(&b.color)?;
    let h = idem::body_hash("label.create", &json!({ "name": name, "color": b.color, "project": b.project_id }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        taken(tx, &key, None)?;
        let n: i64 = tx.query_row("SELECT COUNT(*) FROM labels", [], |r| r.get(0))?;
        if n >= MAX_LABELS {
            return Err(ApiError::conflict("limit", format!("라벨은 {MAX_LABELS}개까지 만들 수 있습니다")));
        }
        if let Some(pid) = &b.project_id {
            assignable(tx, pid)?;
        }
        let id = crate::util::new_id();
        tx.execute(
            "INSERT INTO labels (id, name, name_key, color, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, name, key, b.color, now],
        )?;
        if let Some(pid) = &b.project_id {
            set_assigned(tx, now, pid, &id, true)?;
        }
        let label = get(tx, &id)?;
        events::append(tx, now, "label.changed", None, None, &serde_json::to_value(&label)?)?;
        Ok((StatusCode::CREATED, serde_json::to_value(label)?))
    })
    .await
}

#[derive(Deserialize)]
pub struct UpdateLabel {
    pub expected_revision: i64,
    pub name: Option<String>,
    pub color: Option<String>,
}

/// 이름·색을 한 번에 바꾼다. 하나라도 거절되면 둘 다 적용하지 않는다. 할당은 id로 연결되므로 이름을 바꿔도 그대로다.
pub async fn update(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<UpdateLabel>) -> ApiResult<Response> {
    let name = b.name.as_deref().map(normalize).transpose()?;
    if let Some(c) = &b.color {
        check_color(c)?;
    }
    let h = idem::body_hash("label.update", &json!({ "id": id, "rev": b.expected_revision, "name": name, "color": b.color }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get(tx, &id)?;
        if cur.revision != b.expected_revision {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        let (new_name, key) = name.clone().unwrap_or((cur.name.clone(), cur.name.to_lowercase()));
        taken(tx, &key, Some(&id))?;
        let color = b.color.clone().unwrap_or(cur.color.clone());
        if new_name == cur.name && color == cur.color {
            return Ok((StatusCode::OK, serde_json::to_value(cur)?));
        }
        tx.execute(
            "UPDATE labels SET name = ?2, name_key = ?3, color = ?4, updated_at = ?5, revision = revision + 1 WHERE id = ?1",
            params![id, new_name, key, color, now],
        )?;
        let label = get(tx, &id)?;
        events::append(tx, now, "label.changed", None, None, &serde_json::to_value(&label)?)?;
        Ok((StatusCode::OK, serde_json::to_value(label)?))
    })
    .await
}

#[derive(Deserialize)]
pub struct DeleteQuery {
    pub expected_revision: i64,
}

pub async fn remove(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Query(q): Query<DeleteQuery>) -> ApiResult<Response> {
    let h = idem::body_hash("label.delete", &json!({ "id": id, "rev": q.expected_revision }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get(tx, &id)?;
        if cur.revision != q.expected_revision {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        let mut s = tx.prepare("SELECT project_id FROM project_labels WHERE label_id = ?1")?;
        let projects = s.query_map(params![id], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        drop(s);
        tx.execute("DELETE FROM project_labels WHERE label_id = ?1", params![id])?;
        tx.execute("DELETE FROM labels WHERE id = ?1", params![id])?;
        for pid in &projects {
            let proj = crate::projects::get(tx, pid)?;
            events::append(tx, now, "project.updated", Some(pid), None, &serde_json::to_value(&proj)?)?;
        }
        events::append(tx, now, "label.deleted", None, None, &json!({ "id": id, "name": cur.name }))?;
        Ok((StatusCode::OK, json!({ "id": id, "affected_project_count": projects.len() })))
    })
    .await
}

fn assignable(c: &Connection, project_id: &str) -> ApiResult<()> {
    let p = crate::projects::get(c, project_id)?;
    if p.archived_at.is_some() {
        return Err(ApiError::conflict("archived", "보관된 프로젝트에는 라벨을 붙일 수 없습니다"));
    }
    Ok(())
}

/// 할당 집합 연산. 바뀌었을 때만 프로젝트 변경 이벤트를 남긴다(프로젝트 revision은 올리지 않아 이름·경로 편집과 충돌하지 않는다).
fn set_assigned(tx: &Connection, now: &str, project_id: &str, label_id: &str, assigned: bool) -> ApiResult<bool> {
    let changed = if assigned {
        tx.execute("INSERT OR IGNORE INTO project_labels (project_id, label_id, created_at) VALUES (?1, ?2, ?3)", params![project_id, label_id, now])?
    } else {
        tx.execute("DELETE FROM project_labels WHERE project_id = ?1 AND label_id = ?2", params![project_id, label_id])?
    } > 0;
    if changed {
        let proj = crate::projects::get(tx, project_id)?;
        events::append(tx, now, "project.updated", Some(project_id), None, &serde_json::to_value(&proj)?)?;
        let label = get(tx, label_id)?;
        events::append(tx, now, "label.changed", None, None, &serde_json::to_value(&label)?)?;
    }
    Ok(changed)
}

#[derive(Deserialize)]
pub struct Assignment {
    pub assigned: bool,
}

pub async fn assign(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path((project_id, label_id)): Path<(String, String)>,
    Json(b): Json<Assignment>,
) -> ApiResult<Response> {
    let h = idem::body_hash("label.assign", &json!({ "project": project_id, "label": label_id, "assigned": b.assigned }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        get(tx, &label_id)?;
        if b.assigned {
            assignable(tx, &project_id)?;
        } else {
            crate::projects::get(tx, &project_id)?;
        }
        set_assigned(tx, now, &project_id, &label_id, b.assigned)?;
        Ok((StatusCode::OK, serde_json::to_value(crate::projects::get(tx, &project_id)?)?))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_whitespace_normalized_and_case_insensitive() {
        assert_eq!(normalize("  Front   end ").unwrap(), ("Front end".into(), "front end".into()));
        assert_eq!(normalize(" \t ").unwrap_err().code, "label_name_empty");
        assert!(normalize(&"가".repeat(41)).is_err());
        assert!(check_color("sky").is_ok());
        assert!(check_color("#ff0000").is_err());
    }
}
