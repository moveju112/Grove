//! 세션별 파일 변경 이력·undo/redo·review(GIT-011~014).
//!
//! - 파일 편집 도구(`write`·`edit`·`apply_patch`)가 성공하면 변경 전·후 내용을 sha256 이름의 blob으로 한 번씩 저장하고
//!   `file_changes`에 한 건씩 기록한다. 기록은 도구 결과 확정과 같은 transaction이다.
//! - undo/redo는 대상 전체의 현재 sha를 먼저 확인하고(같은 파일의 여러 변경은 순서대로 계산) 모두 맞을 때만 쓴다.
//!   쓰는 도중 실패하면 이미 쓴 파일을 되돌린다. 실행 중인 요청이 있는 세션은 거절한다.
//! - 대화 rewind(SESSION-008)와는 별도 API·화면이다. 서로의 상태를 바꾸지 않는다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::idem;
use crate::tools::fs::{atomic_write, resolve, unified_diff};
use crate::util::sha256_hex;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path as FsPath, PathBuf};

/// 내용을 보관할 최대 파일 크기. 넘으면 sha만 남기고 undo/redo·diff를 제공하지 않는다.
pub const MAX_STORED: u64 = 16 * 1024 * 1024;

/// 도구 호출이 바꿀 수 있는 파일(프로젝트 상대 경로).
pub fn affected_paths(name: &str, target: &Value, pre: Option<&Value>) -> Vec<String> {
    let mut v: Vec<String> = match name {
        "write" | "edit" => target["path"].as_str().map(|p| vec![p.to_string()]).unwrap_or_default(),
        "apply_patch" => pre
            .and_then(|p| p["writes"].as_array())
            .into_iter()
            .flatten()
            .flat_map(|w| [w["path"].as_str(), w["move_to"].as_str()])
            .flatten()
            .map(String::from)
            .collect(),
        _ => vec![],
    };
    v.sort();
    v.dedup();
    v
}

/// 한 시점의 파일 상태: 없음(None) 또는 sha와 (보관 가능하면) 내용.
#[derive(Clone)]
pub struct FileState {
    pub sha: String,
    pub bytes: Option<Vec<u8>>,
}

fn read_state(p: &FsPath) -> Option<FileState> {
    let m = std::fs::metadata(p).ok().filter(|m| m.is_file())?;
    if m.len() > MAX_STORED {
        return crate::tools::fs::file_sha(p).ok().map(|sha| FileState { sha, bytes: None });
    }
    let bytes = std::fs::read(p).ok()?;
    Some(FileState { sha: sha256_hex(&bytes), bytes: Some(bytes) })
}

/// 실행 직전 상태.
pub struct Before {
    root: PathBuf,
    files: Vec<(String, Option<FileState>)>,
}

pub fn capture(root: &FsPath, paths: &[String]) -> Before {
    let files = paths.iter().map(|rel| (rel.clone(), resolve(root, rel).ok().and_then(|p| read_state(&p)))).collect();
    Before { root: root.to_path_buf(), files }
}

/// 기록할 변경 한 건.
pub struct Rec {
    path: String,
    before: Option<FileState>,
    after: Option<FileState>,
}

/// 실행 성공 직후: 변경 후 상태를 읽고 바뀐 파일만 남기며 blob을 저장한다(transaction 밖, 파일 작업).
pub fn finalize(data_dir: &FsPath, b: Before) -> Vec<Rec> {
    let mut out = vec![];
    for (rel, before) in b.files {
        let after = resolve(&b.root, &rel).ok().and_then(|p| read_state(&p));
        if before.as_ref().map(|s| &s.sha) == after.as_ref().map(|s| &s.sha) {
            continue;
        }
        for s in [&before, &after].into_iter().flatten() {
            if let Some(bytes) = &s.bytes {
                let _ = put_blob(data_dir, &s.sha, bytes);
            }
        }
        out.push(Rec { path: rel, before, after });
    }
    out
}

fn blob_path(data_dir: &FsPath, sha: &str) -> PathBuf {
    data_dir.join("blobs").join(&sha[..2.min(sha.len())]).join(sha)
}

fn put_blob(data_dir: &FsPath, sha: &str, bytes: &[u8]) -> std::io::Result<()> {
    let p = blob_path(data_dir, sha);
    if p.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(p.parent().expect("blob dir"))?;
    atomic_write(&p, bytes).map_err(|e| std::io::Error::other(e.message))
}

fn get_blob(data_dir: &FsPath, sha: &str) -> Option<Vec<u8>> {
    let b = std::fs::read(blob_path(data_dir, sha)).ok()?;
    (sha256_hex(&b) == sha).then_some(b)
}

/// 도구 결과 확정과 같은 transaction에서 기록한다.
pub fn insert(tx: &Connection, now: &str, session_id: &str, turn_id: Option<&str>, call_id: &str, tool: &str, recs: &[Rec]) -> ApiResult<()> {
    if recs.is_empty() {
        return Ok(());
    }
    let mut seq: i64 = tx.query_row("SELECT COALESCE(MAX(seq), 0) FROM file_changes WHERE session_id = ?1", params![session_id], |r| r.get(0))?;
    for r in recs {
        seq += 1;
        let stored = [&r.before, &r.after].into_iter().flatten().all(|s| s.bytes.is_some());
        tx.execute(
            "INSERT INTO file_changes (id, session_id, turn_id, call_id, tool, path, before_sha, after_sha, stored, created_at, seq) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                crate::util::new_id(),
                session_id,
                turn_id,
                call_id,
                tool,
                r.path,
                r.before.as_ref().map(|s| &s.sha),
                r.after.as_ref().map(|s| &s.sha),
                stored as i64,
                now,
                seq
            ],
        )?;
    }
    events::append(tx, now, "file_changes.updated", None, Some(session_id), &json!({ "session_id": session_id }))?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct FileChange {
    pub id: String,
    pub turn_id: Option<String>,
    pub call_id: String,
    pub tool: String,
    pub path: String,
    /// created | modified | deleted
    pub op: String,
    pub before_sha: Option<String>,
    pub after_sha: Option<String>,
    /// 내용을 보관해 diff·undo/redo가 가능한지
    pub stored: bool,
    pub undone_at: Option<String>,
    pub created_at: String,
    pub seq: i64,
}

const COLS: &str = "id, turn_id, call_id, tool, path, before_sha, after_sha, stored, undone_at, created_at, seq";

fn row(r: &rusqlite::Row) -> rusqlite::Result<FileChange> {
    let (b, a): (Option<String>, Option<String>) = (r.get(5)?, r.get(6)?);
    let op = match (&b, &a) {
        (None, _) => "created",
        (_, None) => "deleted",
        _ => "modified",
    };
    Ok(FileChange {
        id: r.get(0)?,
        turn_id: r.get(1)?,
        call_id: r.get(2)?,
        tool: r.get(3)?,
        path: r.get(4)?,
        op: op.into(),
        before_sha: b,
        after_sha: a,
        stored: r.get::<_, i64>(7)? != 0,
        undone_at: r.get(8)?,
        created_at: r.get(9)?,
        seq: r.get(10)?,
    })
}

fn session_changes(c: &Connection, session_id: &str) -> ApiResult<Vec<FileChange>> {
    let mut st = c.prepare(&format!("SELECT {COLS} FROM file_changes WHERE session_id = ?1 ORDER BY seq"))?;
    Ok(st.query_map(params![session_id], row)?.collect::<Result<_, _>>()?)
}

// ---------------- API ----------------

pub async fn list(State(app): State<App>, _p: Principal, Path(session_id): Path<String>) -> ApiResult<Json<Vec<FileChange>>> {
    Ok(Json(
        app.db
            .call(move |c| {
                crate::sessions::get(c, &session_id)?;
                session_changes(c, &session_id)
            })
            .await?,
    ))
}

fn text_of(data_dir: &FsPath, sha: Option<&str>) -> Result<String, &'static str> {
    match sha {
        None => Ok(String::new()),
        Some(s) => {
            let b = get_blob(data_dir, s).ok_or("missing")?;
            String::from_utf8(b).map_err(|_| "binary")
        }
    }
}

fn diff_value(data_dir: &FsPath, before: Option<&str>, after: Option<&str>) -> Value {
    match (text_of(data_dir, before), text_of(data_dir, after)) {
        (Ok(a), Ok(b)) => json!({ "diff": unified_diff(&a, &b, 3) }),
        (Err(e), _) | (_, Err(e)) => json!({ "diff": null, "unavailable": e }),
    }
}

/// 변경 한 건의 patch.
pub async fn diff(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let ch = app
        .db
        .call(move |c| {
            let mut st = c.prepare(&format!("SELECT {COLS} FROM file_changes WHERE id = ?1"))?;
            st.query_map(params![id], row)?.next().transpose()?.ok_or_else(|| ApiError::not_found("변경 기록이 없습니다"))
        })
        .await?;
    let dd = app.cfg.data_dir.clone();
    let v = tokio::task::spawn_blocking(move || {
        let mut v = if !ch.stored {
            json!({ "diff": null, "unavailable": "too_large" })
        } else {
            diff_value(&dd, ch.before_sha.as_deref(), ch.after_sha.as_deref())
        };
        v["id"] = json!(ch.id);
        v["path"] = json!(ch.path);
        v
    })
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(Json(v))
}

/// 세션 전체 검토(GIT-014): 파일마다 이 세션의 첫 변경 전 상태(기준 snapshot)와 지금 디스크 내용을 비교한다.
/// 되돌린 변경은 빼고, 세션 밖에서 바뀐 내용도 현재 상태에 그대로 드러난다.
pub async fn review(State(app): State<App>, _p: Principal, Path(session_id): Path<String>) -> ApiResult<Json<Value>> {
    let (changes, root) = app
        .db
        .call(move |c| {
            let s = crate::sessions::get(c, &session_id)?;
            Ok((session_changes(c, &session_id)?, crate::projects::active_root(c, &s.project_id)?))
        })
        .await?;
    let dd = app.cfg.data_dir.clone();
    let files = tokio::task::spawn_blocking(move || {
        let mut base: Vec<(String, Option<String>, bool)> = vec![];
        for ch in changes.iter().filter(|c| c.undone_at.is_none()) {
            if !base.iter().any(|(p, _, _)| *p == ch.path) {
                base.push((ch.path.clone(), ch.before_sha.clone(), ch.stored));
            }
        }
        base.into_iter()
            .map(|(path, baseline, stored)| {
                let cur = resolve(&root, &path).ok().and_then(|p| read_state(&p));
                let cur_sha = cur.as_ref().map(|s| s.sha.clone());
                let mut v = json!({ "path": path, "baseline_sha": baseline, "current_sha": cur_sha, "unchanged": baseline == cur_sha });
                if !stored || cur.as_ref().is_some_and(|s| s.bytes.is_none()) {
                    v["unavailable"] = json!("too_large");
                } else {
                    let a = text_of(&dd, baseline.as_deref());
                    let b = cur.and_then(|s| s.bytes).map(String::from_utf8).transpose();
                    match (a, b) {
                        (Ok(a), Ok(b)) => v["diff"] = json!(unified_diff(&a, &b.unwrap_or_default(), 3)),
                        (Err(e), _) => v["unavailable"] = json!(e),
                        (_, Err(_)) => v["unavailable"] = json!("binary"),
                    }
                }
                v
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(Json(json!({ "files": files })))
}

#[derive(Deserialize)]
pub struct ChangeIds {
    pub change_ids: Vec<String>,
}

pub async fn undo(State(app): State<App>, p: Principal, headers: HeaderMap, Path(session_id): Path<String>, Json(b): Json<ChangeIds>) -> ApiResult<Response> {
    apply(app, p, headers, session_id, b.change_ids, true).await
}

pub async fn redo(State(app): State<App>, p: Principal, headers: HeaderMap, Path(session_id): Path<String>, Json(b): Json<ChangeIds>) -> ApiResult<Response> {
    apply(app, p, headers, session_id, b.change_ids, false).await
}

/// undo(되돌리기)·redo(다시 적용). 대상의 현재 sha가 예상과 모두 맞을 때만 쓴다(GIT-012).
async fn apply(app: App, p: Principal, headers: HeaderMap, session_id: String, ids: Vec<String>, undo: bool) -> ApiResult<Response> {
    if ids.is_empty() || ids.len() > 500 {
        return Err(ApiError::invalid("change_ids는 1~500개여야 합니다"));
    }
    let h = idem::body_hash(if undo { "changes.undo" } else { "changes.redo" }, &json!({ "s": session_id, "ids": ids }));
    let dd = app.cfg.data_dir.clone();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let s = crate::sessions::get_active(tx, &session_id)?;
        if s.active_turn.is_some() {
            return Err(ApiError::busy("실행 중인 요청이 있어 파일 변경을 되돌릴 수 없습니다. 끝난 뒤 다시 시도하세요"));
        }
        let root = crate::projects::active_root(tx, &s.project_id)?;
        let all = session_changes(tx, &session_id)?;
        let mut sel: Vec<&FileChange> = all.iter().filter(|c| ids.contains(&c.id)).collect();
        if sel.len() != ids.len() {
            return Err(ApiError::not_found("이 대화의 변경 기록이 아닌 항목이 있습니다"));
        }
        if let Some(c) = sel.iter().find(|c| c.undone_at.is_some() != !undo) {
            return Err(ApiError::conflict(
                "invalid_state",
                format!("{}: 이미 {} 상태입니다", c.path, if undo { "되돌린" } else { "적용된" }),
            ));
        }
        if let Some(c) = sel.iter().find(|c| !c.stored) {
            return Err(ApiError::conflict("not_stored", format!("{}: 파일이 커서 내용을 보관하지 않아 되돌릴 수 없습니다", c.path)));
        }
        // undo는 최근 변경부터, redo는 오래된 변경부터.
        sel.sort_by_key(|c| if undo { -c.seq } else { c.seq });
        // 1) 확인: 파일별 예상 현재 상태를 순서대로 계산한다.
        let mut expect: HashMap<String, Option<String>> = HashMap::new();
        let mut abs: HashMap<String, PathBuf> = HashMap::new();
        let mut conflicts = vec![];
        for c in &sel {
            let p = resolve(&root, &c.path).map_err(|e| ApiError::invalid(e.message))?;
            let cur = expect.entry(c.path.clone()).or_insert_with(|| read_state(&p).map(|s| s.sha)).clone();
            abs.insert(c.path.clone(), p);
            let (from, to) = if undo { (&c.after_sha, &c.before_sha) } else { (&c.before_sha, &c.after_sha) };
            if cur != *from {
                conflicts.push(json!({ "path": c.path, "expected_sha": from, "current_sha": cur }));
            }
            expect.insert(c.path.clone(), to.clone());
        }
        if !conflicts.is_empty() {
            return Err(ApiError::conflict("conflict", "파일이 기록 이후 바뀌어 적용하지 않았습니다. 아무 파일도 바꾸지 않았습니다")
                .with_details(json!({ "files": conflicts })));
        }
        // 2) 쓰기: 실패하면 이미 쓴 파일을 원래대로 되돌린다.
        let mut done: Vec<(PathBuf, Option<Vec<u8>>)> = vec![];
        for c in &sel {
            let p = &abs[&c.path];
            let to = if undo { &c.before_sha } else { &c.after_sha };
            let prev = std::fs::read(p).ok();
            let res = match to {
                None => std::fs::remove_file(p).map_err(|e| e.to_string()),
                Some(sha) => match get_blob(&dd, sha) {
                    None => Err("보관한 내용을 찾을 수 없습니다".to_string()),
                    Some(bytes) => {
                        if let Some(parent) = p.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        atomic_write(p, &bytes).map_err(|e| e.message)
                    }
                },
            };
            if let Err(e) = res {
                for (q, old) in done.into_iter().rev() {
                    let _ = match old {
                        Some(b) => atomic_write(&q, &b).map_err(|e| e.message),
                        None => std::fs::remove_file(&q).map_err(|e| e.to_string()),
                    };
                }
                return Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "write_failed", format!("{}: {e} (이미 쓴 파일은 되돌렸습니다)", c.path)));
            }
            done.push((p.clone(), prev));
        }
        for c in &sel {
            tx.execute("UPDATE file_changes SET undone_at = ?2 WHERE id = ?1", params![c.id, if undo { Some(now) } else { None }])?;
        }
        events::append(tx, now, "file_changes.updated", Some(&s.project_id), Some(&session_id), &json!({ "session_id": session_id }))?;
        let changed = session_changes(tx, &session_id)?;
        Ok((StatusCode::OK, json!({ "changes": changed })))
    })
    .await
}
