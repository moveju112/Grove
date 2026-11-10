//! 에이전트·워크플로우 정의(AGENT-002~004, AGENT-015~016, WORKFLOW-001~006).
//!
//! - 기본 원문은 `assets/`의 바이트를 그대로 실행 파일에 내장하고 sha256 baseline을 함께 제공한다.
//! - DB에는 사용자 수정본(builtin=1, NULL 필드는 원문 사용)과 사용자 정의(builtin=0)만 저장한다.
//! - 실제 적용값 계산은 `resolve` 한 곳에서 한다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::idem;
use crate::util::sha256_hex;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub struct Builtin {
    pub kind: &'static str,
    pub id: &'static str,
    /// 원본 파일 경로(assets 기준)
    pub path: &'static str,
    pub raw: &'static str,
    /// agent.json 원문(에이전트만)
    pub meta_raw: Option<&'static str>,
}

macro_rules! agent {
    ($id:literal) => {
        Builtin {
            kind: "agent",
            id: $id,
            path: concat!("agents/", $id, "/AGENT.md"),
            raw: include_str!(concat!("../assets/agents/", $id, "/AGENT.md")),
            meta_raw: Some(include_str!(concat!("../assets/agents/", $id, "/agent.json"))),
        }
    };
}
macro_rules! workflow {
    ($id:literal) => {
        Builtin {
            kind: "workflow",
            id: $id,
            path: concat!("workflows/", $id, "/WORKFLOW.md"),
            raw: include_str!(concat!("../assets/workflows/", $id, "/WORKFLOW.md")),
            meta_raw: None,
        }
    };
}

pub static BUILTINS: &[Builtin] = &[
    agent!("advisor"),
    agent!("context-compressor"),
    agent!("context-explorer"),
    agent!("failure-analyst"),
    agent!("front-worker"),
    agent!("handoff-summarizer"),
    agent!("heavy-worker"),
    agent!("maintainer"),
    agent!("reviewer"),
    agent!("security"),
    agent!("title-generator"),
    agent!("worker"),
    agent!("writer"),
    workflow!("default"),
    workflow!("headless"),
];

pub const BASELINE_MANIFEST: &str = include_str!("../assets/baseline-manifest.json");

/// 원문에서 이름·설명·본문을 추출한다. 에이전트는 agent.json, 워크플로우는 front matter.
pub fn builtin_fields(b: &Builtin) -> (String, String, String) {
    if let Some(meta) = b.meta_raw {
        let v: Value = serde_json::from_str(meta).unwrap_or(Value::Null);
        let name = v["name"].as_str().unwrap_or(b.id).to_string();
        let desc = v["description"].as_str().unwrap_or("").to_string();
        return (name, desc, b.raw.to_string());
    }
    let (fm, body) = split_front_matter(b.raw);
    let mut name = b.id.to_string();
    let mut desc = String::new();
    for line in fm.lines() {
        if let Some(v) = line.strip_prefix("name:") {
            name = unquote(v.trim());
        } else if let Some(v) = line.strip_prefix("description:") {
            desc = unquote(v.trim());
        }
    }
    (name, desc, body.to_string())
}

fn unquote(s: &str) -> String {
    s.strip_prefix('"').and_then(|x| x.strip_suffix('"')).unwrap_or(s).to_string()
}

pub fn split_front_matter(raw: &str) -> (&str, &str) {
    if let Some(rest) = raw.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---\n") {
            return (&rest[..end], &rest[end + 5..]);
        }
    }
    ("", raw)
}

pub fn find_builtin(kind: &str, id: &str) -> Option<&'static Builtin> {
    BUILTINS.iter().find(|b| b.kind == kind && b.id == id)
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct Definition {
    pub kind: String,
    pub id: String,
    pub name: String,
    pub description: String,
    pub body: String,
    pub builtin: bool,
    /// 기본 원문과 다른 필드 목록(builtin일 때)
    pub modified_fields: Vec<String>,
    pub enabled: bool,
    pub revision: i64,
    pub body_sha256: String,
    /// 기본 원문 파일 sha256(builtin일 때)
    pub baseline_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct DefinitionDetail {
    #[serde(flatten)]
    #[ts(flatten)]
    pub def: Definition,
    pub baseline_name: Option<String>,
    pub baseline_description: Option<String>,
    pub baseline_body: Option<String>,
}

type Row = (bool, Option<String>, Option<String>, Option<String>, bool, i64, Option<String>);

fn load_row(conn: &Connection, kind: &str, id: &str) -> ApiResult<Option<Row>> {
    Ok(conn
        .query_row(
            "SELECT builtin, name, description, body, enabled, revision, deleted_at FROM definitions WHERE kind = ?1 AND id = ?2",
            params![kind, id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()?)
}

/// 실제 적용값 계산(유일한 위치).
pub fn resolve(conn: &Connection, kind: &str, id: &str) -> ApiResult<DefinitionDetail> {
    let row = load_row(conn, kind, id)?;
    if let Some(b) = find_builtin(kind, id) {
        let (bn, bd, bb) = builtin_fields(b);
        let (name, desc, body, enabled, revision) = match &row {
            Some((_, n, d, body, en, rev, _)) => (
                n.clone().unwrap_or(bn.clone()),
                d.clone().unwrap_or(bd.clone()),
                body.clone().unwrap_or(bb.clone()),
                *en,
                *rev,
            ),
            None => (bn.clone(), bd.clone(), bb.clone(), true, 0),
        };
        let mut modified = vec![];
        if name != bn {
            modified.push("name".into());
        }
        if desc != bd {
            modified.push("description".into());
        }
        if body != bb {
            modified.push("body".into());
        }
        return Ok(DefinitionDetail {
            def: Definition {
                kind: kind.into(),
                id: id.into(),
                body_sha256: sha256_hex(body.as_bytes()),
                name,
                description: desc,
                body,
                builtin: true,
                modified_fields: modified,
                enabled,
                revision,
                baseline_sha256: Some(sha256_hex(b.raw.as_bytes())),
            },
            baseline_name: Some(bn),
            baseline_description: Some(bd),
            baseline_body: Some(bb),
        });
    }
    match row {
        Some((false, Some(n), d, Some(body), en, rev, None)) => Ok(DefinitionDetail {
            def: Definition {
                kind: kind.into(),
                id: id.into(),
                name: n,
                description: d.unwrap_or_default(),
                body_sha256: sha256_hex(body.as_bytes()),
                body,
                builtin: false,
                modified_fields: vec![],
                enabled: en,
                revision: rev,
                baseline_sha256: None,
            },
            baseline_name: None,
            baseline_description: None,
            baseline_body: None,
        }),
        _ => Err(ApiError::not_found("정의가 없습니다")),
    }
}

pub fn require_enabled_workflow(conn: &Connection, id: &str) -> ApiResult<DefinitionDetail> {
    let d = resolve(conn, "workflow", id)?;
    if !d.def.enabled {
        return Err(ApiError::conflict("disabled", "비활성화된 워크플로우입니다"));
    }
    Ok(d)
}

fn check_kind(kind: &str) -> ApiResult<()> {
    if kind == "agent" || kind == "workflow" { Ok(()) } else { Err(ApiError::not_found("알 수 없는 정의 종류입니다")) }
}

pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

pub fn list_all(conn: &Connection, kind: &str) -> ApiResult<Vec<Definition>> {
    let mut ids: Vec<String> = BUILTINS.iter().filter(|b| b.kind == kind).map(|b| b.id.to_string()).collect();
    let mut st = conn.prepare("SELECT id FROM definitions WHERE kind = ?1 AND builtin = 0 AND deleted_at IS NULL")?;
    ids.extend(st.query_map(params![kind], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?);
    ids.sort();
    ids.dedup();
    ids.iter().map(|id| resolve(conn, kind, id).map(|d| d.def)).collect()
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub kind: String,
}

pub async fn list(State(app): State<App>, _p: Principal, Query(q): Query<ListQuery>) -> ApiResult<Json<Vec<Definition>>> {
    check_kind(&q.kind)?;
    Ok(Json(app.db.call(move |c| list_all(c, &q.kind)).await?))
}

pub async fn show(State(app): State<App>, _p: Principal, Path((kind, id)): Path<(String, String)>) -> ApiResult<Json<DefinitionDetail>> {
    check_kind(&kind)?;
    Ok(Json(app.db.call(move |c| resolve(c, &kind, &id)).await?))
}

fn validate_texts(name: Option<&str>, desc: Option<&str>, body: Option<&str>) -> ApiResult<()> {
    if let Some(n) = name {
        if n.trim().is_empty() || n.chars().count() > 80 {
            return Err(ApiError::invalid("이름은 1~80자여야 합니다"));
        }
    }
    if let Some(d) = desc {
        if d.chars().count() > 500 {
            return Err(ApiError::invalid("설명은 500자 이하여야 합니다"));
        }
    }
    if let Some(b) = body {
        if b.trim().is_empty() {
            return Err(ApiError::invalid("본문이 비어 있습니다"));
        }
        if b.len() > 256 * 1024 {
            return Err(ApiError::invalid("본문은 256KiB 이하여야 합니다"));
        }
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct CreateDef {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub body: String,
}

pub async fn create(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path(kind): Path<String>,
    Json(b): Json<CreateDef>,
) -> ApiResult<Response> {
    check_kind(&kind)?;
    if !valid_id(&b.id) {
        return Err(ApiError::invalid("ID는 소문자·숫자·하이픈 64자 이하여야 합니다"));
    }
    validate_texts(Some(&b.name), b.description.as_deref(), Some(&b.body))?;
    let h = idem::body_hash("def.create", &json!({ "kind": kind, "id": b.id, "name": b.name, "d": b.description, "body": b.body }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        if find_builtin(&kind, &b.id).is_some() {
            return Err(ApiError::conflict("already_exists", "기본 정의와 같은 ID입니다"));
        }
        let row = load_row(tx, &kind, &b.id)?;
        let rev = match row {
            Some((_, _, _, _, _, _, None)) => return Err(ApiError::conflict("already_exists", "이미 있는 ID입니다")),
            Some((_, _, _, _, _, rev, Some(_))) => rev + 1,
            None => 1,
        };
        tx.execute(
            "INSERT INTO definitions (kind, id, builtin, name, description, body, enabled, revision, created_at, updated_at) \
             VALUES (?1, ?2, 0, ?3, ?4, ?5, 1, ?6, ?7, ?7) \
             ON CONFLICT(kind, id) DO UPDATE SET name = ?3, description = ?4, body = ?5, enabled = 1, revision = ?6, updated_at = ?7, deleted_at = NULL",
            params![kind, b.id, b.name.trim(), b.description.unwrap_or_default(), b.body, rev, now],
        )?;
        let d = resolve(tx, &kind, &b.id)?;
        events::append(tx, now, "definition.changed", None, None, &json!({ "kind": kind, "id": b.id, "revision": d.def.revision }))?;
        Ok((StatusCode::CREATED, serde_json::to_value(d)?))
    })
    .await
}

#[derive(Deserialize)]
pub struct UpdateDef {
    pub expected_revision: i64,
    pub name: Option<String>,
    pub description: Option<String>,
    pub body: Option<String>,
    pub enabled: Option<bool>,
}

pub async fn update(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path((kind, id)): Path<(String, String)>,
    Json(b): Json<UpdateDef>,
) -> ApiResult<Response> {
    check_kind(&kind)?;
    validate_texts(b.name.as_deref(), b.description.as_deref(), b.body.as_deref())?;
    let h = idem::body_hash(
        "def.update",
        &json!({ "kind": kind, "id": id, "rev": b.expected_revision, "n": b.name, "d": b.description, "b": b.body, "e": b.enabled }),
    );
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = resolve(tx, &kind, &id)?;
        if cur.def.revision != b.expected_revision {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        if b.enabled == Some(false) && kind == "workflow" && id == "default" {
            return Err(ApiError::invalid("기본 워크플로우는 비활성화할 수 없습니다"));
        }
        let builtin = cur.def.builtin;
        // builtin 수정본은 원문과 같은 값이면 NULL(원문 사용)로 저장해 이후 원문 비교가 정확하도록 한다.
        let pick = |new: Option<String>, curv: &str, base: &Option<String>| -> Option<String> {
            let v = new.unwrap_or_else(|| curv.to_string());
            if builtin && base.as_deref() == Some(v.as_str()) { None } else { Some(v) }
        };
        let name = pick(b.name.map(|n| n.trim().to_string()), &cur.def.name, &cur.baseline_name);
        let desc = pick(b.description, &cur.def.description, &cur.baseline_description);
        let body = pick(b.body, &cur.def.body, &cur.baseline_body);
        let enabled = b.enabled.unwrap_or(cur.def.enabled);
        tx.execute(
            "INSERT INTO definitions (kind, id, builtin, name, description, body, enabled, revision, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9) \
             ON CONFLICT(kind, id) DO UPDATE SET name = ?4, description = ?5, body = ?6, enabled = ?7, revision = ?8, updated_at = ?9",
            params![kind, id, builtin, name, desc, body, enabled, cur.def.revision + 1, now],
        )?;
        let d = resolve(tx, &kind, &id)?;
        events::append(tx, now, "definition.changed", None, None, &json!({ "kind": kind, "id": id, "revision": d.def.revision }))?;
        Ok((StatusCode::OK, serde_json::to_value(d)?))
    })
    .await
}

#[derive(Deserialize)]
pub struct RestoreDef {
    pub expected_revision: i64,
    /// 복원할 필드. 비우면 전체(name, description, body).
    pub fields: Option<Vec<String>>,
}

pub async fn restore(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path((kind, id)): Path<(String, String)>,
    Json(b): Json<RestoreDef>,
) -> ApiResult<Response> {
    check_kind(&kind)?;
    let fields = b.fields.unwrap_or_else(|| vec!["name".into(), "description".into(), "body".into()]);
    if fields.iter().any(|f| !matches!(f.as_str(), "name" | "description" | "body")) {
        return Err(ApiError::invalid("복원 가능한 필드는 name, description, body입니다"));
    }
    let h = idem::body_hash("def.restore", &json!({ "kind": kind, "id": id, "rev": b.expected_revision, "f": fields }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = resolve(tx, &kind, &id)?;
        if !cur.def.builtin {
            return Err(ApiError::invalid("사용자 정의는 복원할 기본값이 없습니다"));
        }
        if cur.def.revision != b.expected_revision {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        let row = load_row(tx, &kind, &id)?;
        let (mut n, mut d, mut body, en) = match row {
            Some((_, n, d, b, en, _, _)) => (n, d, b, en),
            None => (None, None, None, true),
        };
        for f in &fields {
            match f.as_str() {
                "name" => n = None,
                "description" => d = None,
                _ => body = None,
            }
        }
        tx.execute(
            "INSERT INTO definitions (kind, id, builtin, name, description, body, enabled, revision, created_at, updated_at) \
             VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?8) \
             ON CONFLICT(kind, id) DO UPDATE SET name = ?3, description = ?4, body = ?5, revision = ?7, updated_at = ?8",
            params![kind, id, n, d, body, en, cur.def.revision + 1, now],
        )?;
        let res = resolve(tx, &kind, &id)?;
        events::append(tx, now, "definition.changed", None, None, &json!({ "kind": kind, "id": id, "revision": res.def.revision }))?;
        Ok((StatusCode::OK, serde_json::to_value(res)?))
    })
    .await
}

#[derive(Deserialize)]
pub struct DeleteQuery {
    pub expected_revision: i64,
}

pub async fn delete(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path((kind, id)): Path<(String, String)>,
    Query(q): Query<DeleteQuery>,
) -> ApiResult<Response> {
    check_kind(&kind)?;
    let h = idem::body_hash("def.delete", &json!({ "kind": kind, "id": id, "rev": q.expected_revision }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = resolve(tx, &kind, &id)?;
        if cur.def.builtin {
            return Err(ApiError::invalid("기본 정의는 삭제할 수 없습니다. 복원을 사용하세요"));
        }
        if cur.def.revision != q.expected_revision {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        // 이 워크플로우를 쓰던 세션은 다음 턴부터 기본 워크플로우를 쓴다(활성 턴은 정의 snapshot 유지).
        if kind == "workflow" {
            tx.execute("UPDATE sessions SET workflow_id = NULL, revision = revision + 1, updated_at = ?2 WHERE workflow_id = ?1", params![id, now])?;
        }
        tx.execute(
            "UPDATE definitions SET deleted_at = ?3, revision = revision + 1, updated_at = ?3 WHERE kind = ?1 AND id = ?2",
            params![kind, id, now],
        )?;
        events::append(tx, now, "definition.deleted", None, None, &json!({ "kind": kind, "id": id }))?;
        Ok((StatusCode::OK, json!({ "deleted": true, "kind": kind, "id": id })))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtins_match_baseline_manifest() {
        let m: Value = serde_json::from_str(BASELINE_MANIFEST).unwrap();
        let files = m["files"].as_object().unwrap();
        assert_eq!(BUILTINS.iter().filter(|b| b.kind == "agent").count(), 13);
        assert_eq!(BUILTINS.iter().filter(|b| b.kind == "workflow").count(), 2);
        for b in BUILTINS {
            let want = files[b.path].as_str().unwrap();
            assert_eq!(sha256_hex(b.raw.as_bytes()), want, "{} 원문 hash 불일치", b.path);
            if let Some(meta) = b.meta_raw {
                let p = b.path.replace("AGENT.md", "agent.json");
                assert_eq!(sha256_hex(meta.as_bytes()), files[&p].as_str().unwrap());
            }
        }
    }

    #[test]
    fn workflow_front_matter() {
        let b = find_builtin("workflow", "default").unwrap();
        let (n, d, body) = builtin_fields(b);
        assert_eq!(n, "Default");
        assert_eq!(d, "Handle tasks as requested.");
        assert!(body.starts_with("\nAn explicit request") || body.starts_with("An explicit request"));
    }

    #[test]
    fn ids() {
        assert!(valid_id("my-agent-1"));
        assert!(!valid_id("My"));
        assert!(!valid_id("-x"));
        assert!(!valid_id(""));
        assert!(!valid_id(&"a".repeat(65)));
    }
}
