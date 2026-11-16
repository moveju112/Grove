//! Grove worktree(GIT-007~010).
//! - Grove가 만든 worktree만 `worktrees` 표에 기록하고, 이 표에 있는 것만 Grove 소유로 보고 제거·merge한다.
//!   사용자가 직접 만든 worktree는 목록에 "소유 아님"으로만 보여 주고 건드리지 않는다(GIT-010).
//! - 위치는 `data/worktrees/<id>`, 브랜치는 `grove/<이름>`이다. 제거해도 브랜치는 남긴다.
//! - 대화는 명시적으로 worktree에 들어가거나(enter) 프로젝트 폴더로 돌아온다(return). 들어가 있으면
//!   도구·백그라운드 작업·외부 CLI는 worktree 경로를 쓴다(`sessions::exec_root`). 자동 격리 기본값은 정하지 않았다.
//! - 원래 폴더에 커밋하지 않은 변경이 있으면 생성 시 leave(두고 감)/carry(복사해 감) 중 하나를 고르게 한다(GIT-009).
//!   carry도 원래 폴더의 변경은 그대로 둔다. 큰 저장소는 확인 후에만 만든다.
//! - 변경 중인 worktree는 force 없이 제거하지 않고, 자동 정리(prune)는 git의 관리 기록만 정리한다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::git::{fail, git, is_repo, root_of};
use crate::idem;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path as FsPath, PathBuf};

/// 이 수보다 추적 파일이 많으면 생성 전에 사용자 확인을 받는다(체크아웃 시간·디스크 사용).
pub const LARGE_REPO_FILES: usize = 20_000;

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct Worktree {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub path: String,
    pub branch: String,
    pub base: Option<String>,
    /// active | removed | missing(경로가 사라짐) | unknown(생성 결과 미확정)
    pub status: String,
    pub created_at: String,
    pub removed_at: Option<String>,
}

const COLS: &str = "id, project_id, name, path, branch, base, status, created_at, removed_at";

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<Worktree> {
    Ok(Worktree {
        id: r.get(0)?,
        project_id: r.get(1)?,
        name: r.get(2)?,
        path: r.get(3)?,
        branch: r.get(4)?,
        base: r.get(5)?,
        status: r.get(6)?,
        created_at: r.get(7)?,
        removed_at: r.get(8)?,
    })
}

pub fn get(c: &Connection, id: &str) -> ApiResult<Worktree> {
    c.query_row(&format!("SELECT {COLS} FROM worktrees WHERE id = ?1"), params![id], from_row)
        .optional()?
        .ok_or_else(|| ApiError::not_found("worktree가 없습니다"))
}

/// 대화가 들어갈 수 있는 worktree인지: 같은 프로젝트·프로젝트 모드·active·경로 존재.
pub fn ensure_usable(c: &Connection, project_id: &str, id: &str) -> ApiResult<Worktree> {
    let w = get(c, id)?;
    if w.project_id != project_id {
        return Err(ApiError::invalid("다른 프로젝트의 worktree입니다"));
    }
    crate::projects::ensure_workspaces(c, project_id)?;
    if w.status != "active" || !FsPath::new(&w.path).is_dir() {
        return Err(ApiError::gone("worktree 경로에 접근할 수 없습니다"));
    }
    Ok(w)
}

fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 60 && !n.starts_with(['.', '-']) && n.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) && !n.ends_with(".lock")
}

fn lines(raw: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(raw).lines().map(str::to_string).filter(|l| !l.is_empty()).collect()
}

/// 커밋하지 않은 변경(untracked 포함) 경로 목록
async fn dirty_paths(root: &FsPath) -> ApiResult<Vec<String>> {
    let o = git(root, &["status", "--porcelain", "--untracked-files=all"], true).await?;
    if o.code != 0 {
        return Err(fail(&o, "status"));
    }
    Ok(lines(&o.stdout).into_iter().map(|l| l.get(3..).unwrap_or("").to_string()).collect())
}

/// 경로 비교용 정규화(심볼릭 링크·`..` 제거, 없으면 그대로)
fn canon(p: &FsPath) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn unknown(project_id: &str, operation: &str, worktree_id: Option<&str>) -> ApiError {
    ApiError::conflict("result_unknown", "worktree 작업 결과를 확정하지 못했습니다. 폴더·브랜치·이력을 확인하세요. 같은 요청을 재실행하지 않습니다")
        .with_details(json!({"project_id":project_id,"operation":operation,"worktree_id":worktree_id}))
}

async fn accept(
    app: &App, p: &Principal, headers: &HeaderMap, hash: &str, unknown: &ApiError,
    prepare: impl FnOnce(&Transaction, &str) -> ApiResult<()> + Send + 'static,
) -> ApiResult<Option<Response>> {
    let pending = unknown.body();
    let response = idem::run(app, p, headers, hash, move |tx, now| {
        prepare(tx, now)?;
        Ok((StatusCode::CONFLICT, pending))
    }).await?;
    Ok(response.headers().contains_key("idempotent-replayed").then_some(response))
}

async fn finish(
    app: &App, p: &Principal, headers: &HeaderMap, hash: &str, unknown: ApiError,
    result: ApiResult<(StatusCode, Value)>,
    update: impl FnOnce(&Transaction, &str, Value) -> ApiResult<Value> + Send + 'static,
) -> ApiResult<Response> {
    let (status, body) = match result {
        Ok(result) => result,
        Err(error) if error.status.is_server_error() || error.status == StatusCode::REQUEST_TIMEOUT
            || error.code == "result_unknown" || error.details.as_ref().is_some_and(|d| d["result_unknown"] == true) => {
            tracing::warn!(code=error.code, "worktree 실행 결과 확인 실패");
            return Err(unknown);
        }
        Err(error) => (error.status, error.body()),
    };
    let (owner, key, hash, now) = (p.root_id.clone(), idem::key_from(headers)?, hash.to_string(), app.now());
    let body = app.db.call(move |c| {
        let tx = c.transaction()?;
        let body = if status.is_success() { update(&tx, &now, body)? } else { body };
        idem::complete(&tx, &owner, &key, &hash, status, &body)?;
        tx.commit()?;
        Ok(body)
    }).await.map_err(|error| {
        tracing::warn!(code=error.code, "worktree 결과 저장 실패");
        unknown
    })?;
    app.notify_events().await;
    Ok((status, Json(body)).into_response())
}

// ---------------- 목록 ----------------

pub async fn list(State(app): State<App>, _p: Principal, Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let root = root_of(&app, &project_id).await?;
    let _resource = app.project_resources.ui_read(&app,&project_id,&_p).await?;
    if !is_repo(&root).await? {
        return Ok(Json(json!({ "is_repo": false, "worktrees": [], "unowned": [], "removed": [] })));
    }
    let pid = project_id.clone();
    let (rows, users, removed): (Vec<Worktree>, Vec<(String, i64)>, Vec<Worktree>) = app
        .db
        .call(move |c| {
            let mut st = c.prepare(&format!("SELECT {COLS} FROM worktrees WHERE project_id = ?1 AND status != 'removed' ORDER BY created_at"))?;
            let rows = st.query_map(params![pid], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
            // 복원 후보(PROJECT-009): 최근 제거한 것부터.
            let mut st = c.prepare(&format!("SELECT {COLS} FROM worktrees WHERE project_id = ?1 AND status = 'removed' ORDER BY removed_at DESC LIMIT 50"))?;
            let removed = st.query_map(params![pid], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut st = c.prepare(
                "SELECT worktree_id, COUNT(*) FROM sessions WHERE project_id = ?1 AND worktree_id IS NOT NULL AND archived_at IS NULL GROUP BY worktree_id",
            )?;
            let users = st.query_map(params![pid], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((rows, users, removed))
        })
        .await?;
    // git이 아는 worktree 중 Grove 기록에 없는 것(주 작업 폴더 제외)은 소유 아님으로 보여 준다.
    let o = git(&root, &["worktree", "list", "--porcelain"], true).await?;
    let owned: Vec<PathBuf> = rows.iter().map(|w| canon(FsPath::new(&w.path))).collect();
    let main = canon(&root);
    let mut unowned = vec![];
    for block in String::from_utf8_lossy(&o.stdout).split("\n\n") {
        let mut path = None;
        let mut branch = None;
        for l in block.lines() {
            if let Some(p) = l.strip_prefix("worktree ") {
                path = Some(p.to_string());
            } else if let Some(b) = l.strip_prefix("branch ") {
                branch = Some(b.trim_start_matches("refs/heads/").to_string());
            }
        }
        if let Some(p) = path {
            let c = canon(FsPath::new(&p));
            if c != main && !owned.contains(&c) {
                unowned.push(json!({ "path": p, "branch": branch }));
            }
        }
    }
    let mut out = vec![];
    for w in rows {
        let exists = FsPath::new(&w.path).is_dir();
        let dirty = if exists && w.status == "active" { dirty_paths(FsPath::new(&w.path)).await.map(|d| d.len()).ok() } else { None };
        let sessions = users.iter().find(|(id, _)| id == &w.id).map(|(_, n)| *n).unwrap_or(0);
        let mut v = serde_json::to_value(&w)?;
        v["exists"] = json!(exists);
        v["dirty_count"] = json!(dirty);
        v["sessions"] = json!(sessions);
        out.push(v);
    }
    Ok(Json(json!({ "is_repo": true, "worktrees": out, "unowned": unowned, "removed": removed })))
}

// ---------------- 생성(GIT-007·009) ----------------

#[derive(Deserialize)]
pub struct CreateBody {
    pub name: String,
    /// 시작 commit(없으면 현재 HEAD)
    pub base: Option<String>,
    /// 원래 폴더에 변경이 있을 때의 선택: "leave" | "carry". 변경이 있는데 없으면 409 `worktree_dirty_choice`.
    pub carry: Option<String>,
    /// 큰 저장소 경고를 확인했는지
    #[serde(default)]
    pub confirm_large: bool,
}

pub async fn create(State(app): State<App>, p: Principal, headers: HeaderMap, Path(project_id): Path<String>, Json(b): Json<CreateBody>) -> ApiResult<Response> {
    if !valid_name(&b.name) {
        return Err(ApiError::invalid("worktree 이름은 영문·숫자·`.`·`_`·`-` 60자 이하여야 합니다"));
    }
    let carry = match b.carry.as_deref() {
        None => None,
        Some("leave") => Some(false),
        Some("carry") => Some(true),
        Some(_) => return Err(ApiError::invalid("carry는 leave 또는 carry여야 합니다")),
    };
    if carry == Some(true) && b.base.is_some() {
        return Err(ApiError::invalid("변경을 옮겨 가려면 현재 HEAD에서 시작해야 합니다(base 없이 요청하세요)"));
    }
    let h = idem::body_hash("worktree.create", &json!({ "p": project_id, "n": b.name, "b": b.base, "c": b.carry, "l": b.confirm_large }));
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? { return Ok(r); }
    let root = root_of(&app, &project_id).await?;
    if !is_repo(&root).await? {
        return Err(ApiError::invalid("Git 저장소가 아닙니다"));
    }
    let lock = app.repo_locks.get(&project_id);
    let _g = lock.lock().await;
    crate::auth::revalidate(&app,&p).await?;
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? {
        return Ok(r);
    }
    let _resource = app.project_resources.ui_write(&app,&project_id,&p).await?;
    if root_of(&app, &project_id).await? != root {
        return Err(ApiError::conflict("project_changed", "프로젝트 경로가 바뀌어 worktree를 만들지 않았습니다"));
    }
    let dirty = dirty_paths(&root).await?;
    if !dirty.is_empty() && carry.is_none() {
        return Err(ApiError::conflict("worktree_dirty_choice", "원래 폴더에 커밋하지 않은 변경이 있습니다. 두고 갈지(leave) 복사해 갈지(carry) 선택하세요")
            .with_details(json!({ "changed": dirty.len(), "sample": dirty.iter().take(20).collect::<Vec<_>>() })));
    }
    let files = git(&root, &["ls-files", "-z"], true).await?;
    if files.code != 0 { return Err(fail(&files, "추적 파일 확인")); }
    let count = files.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()).count();
    if count > LARGE_REPO_FILES && !b.confirm_large {
        return Err(ApiError::conflict("worktree_large_repo", format!("추적 파일이 {count}개인 큰 저장소입니다. 체크아웃에 시간과 디스크가 듭니다. 확인 후 다시 요청하세요"))
            .with_details(json!({ "files": count, "threshold": LARGE_REPO_FILES })));
    }
    let base = b.base.clone().unwrap_or_else(|| "HEAD".into());
    if base.starts_with('-') {
        return Err(ApiError::invalid("base가 올바르지 않습니다"));
    }
    let rev = git(&root, &["rev-parse", "--verify", "--end-of-options", &format!("{base}^{{commit}}")], true).await?;
    if rev.code != 0 {
        return Err(ApiError::invalid(format!("base commit을 찾을 수 없습니다: {base}")));
    }
    let sha = String::from_utf8_lossy(&rev.stdout).trim().to_string();
    let branch = format!("grove/{}", b.name);
    if !crate::git::valid_branch(&branch) {
        return Err(ApiError::invalid("브랜치 이름을 만들 수 없는 worktree 이름입니다"));
    }
    let id = crate::util::new_id();
    let dir = app.cfg.data_dir.join("worktrees");
    std::fs::create_dir_all(&dir).map_err(|e| ApiError::internal(format!("worktree 폴더 생성 실패: {e}")))?;
    let path = dir.join(&id);
    let path_s = path.to_string_lossy().to_string();
    let pending = unknown(&project_id, "worktree.create", Some(&id));
    let (pid, wid, name, target, new_branch, base) = (project_id.clone(), id.clone(), b.name.clone(), path_s.clone(), branch.clone(), sha.clone());
    if let Some(r) = accept(&app, &p, &headers, &h, &pending, move |tx, now| {
        crate::projects::active_root(tx, &pid)?;
        // 모드 변경과 같은 transaction 순서로 판정해 단일 모드에 worktree가 생기지 않게 한다.
        crate::projects::ensure_workspaces(tx, &pid)?;
        tx.execute(
            "INSERT INTO worktrees (id,project_id,name,path,branch,base,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,'unknown',?7)",
            params![wid,pid,name,target,new_branch,base,now],
        )?;
        events::append(tx, now, "worktree.changed", Some(&pid), None, &json!({"op":"create.accepted","id":wid}))?;
        Ok(())
    }).await? { return Ok(r); }
    // 브랜치가 이미 있으면 git이 거절한다(기존 브랜치를 덮어쓰지 않는다).
    let result = async {
        let o = git(&root, &["worktree", "add", "-b", &branch, "--", &path_s, &sha], false).await?;
        if o.code != 0 { return Err(fail(&o, "worktree 생성")); }
        // 복사 실패도 소유 기록과 원본을 보존한다. 부분 생성물을 자동 삭제하지 않는다.
        if carry == Some(true) { carry_changes(&root, &path, &dir.join(format!("{id}.patch"))).await?; }
        Ok((StatusCode::CREATED, json!({})))
    }.await;
    let carried = carry == Some(true) && !dirty.is_empty();
    let pid = project_id.clone();
    finish(&app, &p, &headers, &h, pending, result, move |tx, now, _| {
        tx.execute("UPDATE worktrees SET status='active' WHERE id=?1", params![id])?;
        let w = get(tx, &id)?;
        events::append(tx, now, "worktree.changed", Some(&pid), None, &json!({ "op": "create", "id": id }))?;
        let mut v = serde_json::to_value(&w)?;
        v["carried"] = json!(carried);
        v["files"] = json!(count);
        Ok(v)
    })
    .await
}

/// 원래 폴더의 커밋하지 않은 변경(추적 파일 diff + untracked 파일)을 새 worktree에 복사한다. 원래 폴더는 바꾸지 않는다.
async fn carry_changes(root: &FsPath, target: &FsPath, patch_file: &FsPath) -> ApiResult<()> {
    let diff = git(root, &["diff", "HEAD", "--binary", "--no-ext-diff"], true).await?;
    if diff.code != 0 {
        return Err(fail(&diff, "변경 읽기"));
    }
    if !diff.stdout.is_empty() {
        std::fs::write(patch_file, &diff.stdout).map_err(|e| ApiError::internal(format!("patch 저장 실패: {e}")))?;
        let pf = patch_file.to_string_lossy().to_string();
        let o = git(target, &["apply", "--binary", "--", &pf], false).await;
        let _ = std::fs::remove_file(patch_file);
        let o = o?;
        if o.code != 0 {
            return Err(fail(&o, "변경 복사"));
        }
    }
    let untracked = git(root, &["ls-files", "--others", "--exclude-standard", "-z"], true).await?;
    if untracked.code != 0 { return Err(fail(&untracked, "미추적 파일 확인")); }
    for rel in untracked.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()) {
        let rel = String::from_utf8_lossy(rel).to_string();
        let from = root.join(&rel);
        let to = target.join(&rel);
        if !from.is_file() {
            continue;
        }
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| ApiError::internal(format!("{rel} 복사 실패: {e}")))?;
        }
        std::fs::copy(&from, &to).map_err(|e| ApiError::internal(format!("{rel} 복사 실패: {e}")))?;
    }
    Ok(())
}

// ---------------- 대화 진입·복귀(GIT-007·008) ----------------

#[derive(Deserialize)]
pub struct EnterBody {
    /// 들어갈 worktree. null이면 프로젝트 폴더로 돌아온다.
    pub worktree_id: Option<String>,
}

pub async fn enter(State(app): State<App>, p: Principal, headers: HeaderMap, Path(session_id): Path<String>, Json(b): Json<EnterBody>) -> ApiResult<Response> {
    let h = idem::body_hash("session.worktree", &json!({ "s": session_id, "w": b.worktree_id }));
    if let Some(response) = idem::replay(&app,&p,&headers,&h).await? { return Ok(response); }
    let sid = session_id.clone();
    let project = app.db.call(move |c| Ok(crate::sessions::get_active(c,&sid)?.project_id)).await?;
    let _resource = app.project_resources.ui_read(&app,&project,&p).await?;
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let s = crate::sessions::get_active(tx, &session_id)?;
        if s.worktree_id == b.worktree_id {
            return Ok((StatusCode::OK, serde_json::to_value(s)?));
        }
        // 실행 중인 일은 이전 폴더에서 돌고 있으므로 위치를 바꾸지 않는다.
        let tasks = crate::tasks::running_in_session(tx, &session_id)?;
        let agents = crate::agents::running_for_parent(tx, &session_id)?;
        if s.active_turn.is_some() || s.pending_approvals > 0 || tasks > 0 || agents > 0 {
            return Err(ApiError::busy("실행 중이거나 승인 대기 중인 일이 있어 작업 위치를 바꿀 수 없습니다. 끝난 뒤 다시 시도하세요"));
        }
        crate::projects::active_root(tx, &s.project_id)?;
        if let Some(w) = &b.worktree_id {
            ensure_usable(tx, &s.project_id, w)?;
        }
        tx.execute("UPDATE sessions SET worktree_id = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?1", params![session_id, b.worktree_id, now])?;
        let s = crate::sessions::get(tx, &session_id)?;
        events::append(tx, now, "session.updated", Some(&s.project_id), Some(&session_id), &serde_json::to_value(&s)?)?;
        Ok((StatusCode::OK, serde_json::to_value(s)?))
    })
    .await
}

// ---------------- merge·제거·prune(GIT-007·010) ----------------

async fn owned(app: &App, id: &str) -> ApiResult<(Worktree, PathBuf)> {
    let wid = id.to_string();
    let w = app.db.call(move |c| get(c, &wid)).await?;
    let root = root_of(app, &w.project_id).await?;
    Ok((w, root))
}

#[derive(Deserialize)]
pub struct MergeBody {
    #[serde(default)]
    pub no_ff: bool,
}

#[derive(Deserialize)]
pub struct ReviewBody {
    pub reviewed: bool,
}

/// 이전 생성 요청의 완료 여부와 별개로, 사용자가 검토한 현재 worktree를 사용한다.
pub async fn review(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<ReviewBody>) -> ApiResult<Response> {
    if !b.reviewed { return Err(ApiError::invalid("폴더·브랜치·복사된 파일을 먼저 확인하세요")); }
    let h = idem::body_hash("worktree.review", &json!({"w":id,"reviewed":b.reviewed}));
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? { return Ok(r); }
    let (w, root) = owned(&app, &id).await?;
    let lock = app.repo_locks.get(&w.project_id);
    let _g = lock.lock().await;
    let _resource = app.project_resources.ui_write(&app, &w.project_id, &p).await?;
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? { return Ok(r); }
    let (w, current_root) = owned(&app, &id).await?;
    if current_root != root { return Err(ApiError::conflict("project_changed", "프로젝트 경로가 바뀌었습니다")); }
    if w.status != "unknown" { return Err(ApiError::conflict("worktree_state", "생성 결과 미확정 worktree만 검토할 수 있습니다")); }
    let target = FsPath::new(&w.path);
    let list = git(&root, &["worktree", "list", "--porcelain", "-z"], true).await?;
    if list.code != 0 { return Err(fail(&list, "worktree 등록 확인")); }
    let fields: Vec<_> = list.stdout.split(|b| *b == 0).collect();
    let wanted_path = format!("worktree {}", w.path);
    let wanted_branch = format!("branch refs/heads/{}", w.branch);
    let registered = fields.split(|field| field.is_empty()).any(|record|
        record.contains(&wanted_path.as_bytes()) && record.contains(&wanted_branch.as_bytes()));
    if !registered || !target.is_dir() { return Err(ApiError::conflict("worktree_mismatch", "소유 기록과 실제 Git worktree가 다릅니다. 파일을 보존하고 직접 확인하세요")); }
    for (at, args, expected) in [
        (target, vec!["rev-parse","--show-toplevel"], canon(target)),
        (target, vec!["rev-parse","--git-common-dir"], {
            let common = git(&root, &["rev-parse","--git-common-dir"], true).await?;
            if common.code != 0 { return Err(fail(&common, "공유 Git metadata 확인")); }
            canon(&root.join(String::from_utf8_lossy(&common.stdout).trim_end_matches('\n')))
        }),
    ] {
        let actual = git(at, &args, true).await?;
        if actual.code != 0 || canon(&at.join(String::from_utf8_lossy(&actual.stdout).trim_end_matches('\n'))) != expected {
            return Err(ApiError::conflict("worktree_mismatch", "실제 폴더의 Git metadata가 소유 기록과 다릅니다"));
        }
    }
    let branch = git(target, &["symbolic-ref","--quiet","HEAD"], true).await?;
    if branch.code != 0 || String::from_utf8_lossy(&branch.stdout).trim_end_matches('\n') != format!("refs/heads/{}", w.branch) {
        return Err(ApiError::conflict("worktree_mismatch", "실제 worktree 브랜치가 소유 기록과 다릅니다"));
    }
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        tx.execute("UPDATE worktrees SET status='active' WHERE id=?1 AND status='unknown'", params![id])?;
        let w = get(tx, &id)?;
        events::append(tx, now, "worktree.changed", Some(&w.project_id), None, &json!({"op":"review","id":id}))?;
        Ok((StatusCode::OK, serde_json::to_value(w)?))
    }).await
}

/// worktree 브랜치를 프로젝트 폴더의 현재 브랜치에 merge한다. worktree에 커밋하지 않은 변경이 있으면 거부한다.
pub async fn merge(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<MergeBody>) -> ApiResult<Response> {
    let h = idem::body_hash("worktree.merge", &json!({ "w": id, "n": b.no_ff }));
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? { return Ok(r); }
    let (w, root) = owned(&app, &id).await?;
    let lock = app.repo_locks.get(&w.project_id);
    let _g = lock.lock().await;
    crate::auth::revalidate(&app,&p).await?;
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? {
        return Ok(r);
    }
    let _resource = app.project_resources.ui_write(&app,&w.project_id,&p).await?;
    let (w, current_root) = owned(&app, &id).await?;
    if current_root != root { return Err(ApiError::conflict("project_changed", "프로젝트 경로가 바뀌어 merge하지 않았습니다")); }
    if w.status != "active" { return Err(ApiError::gone("활성 worktree가 아닙니다")); }
    if FsPath::new(&w.path).is_dir() {
        let d = dirty_paths(FsPath::new(&w.path)).await?;
        if !d.is_empty() {
            return Err(ApiError::conflict("worktree_dirty", "worktree에 커밋하지 않은 변경이 있습니다. 먼저 worktree에서 커밋하세요")
                .with_details(json!({ "changed": d.len() })));
        }
    }
    let pending = unknown(&w.project_id, "worktree.merge", Some(&id));
    if let Some(r) = accept(&app, &p, &headers, &h, &pending, |_, _| Ok(())).await? { return Ok(r); }
    let result = crate::git::merge_into(&root, &w.branch, b.no_ff).await.map(|v| (StatusCode::OK, v));
    let pid = w.project_id.clone();
    finish(&app, &p, &headers, &h, pending, result, move |tx, now, result| {
        events::append(tx, now, "git.changed", Some(&pid), None, &json!({ "op": "worktree.merge" }))?;
        events::append(tx, now, "worktree.changed", Some(&pid), None, &json!({ "op": "merge", "id": id }))?;
        Ok(result)
    })
    .await
}

#[derive(Deserialize, Default)]
pub struct RemoveQuery {
    /// 커밋하지 않은 변경이 있어도 지운다(사용자가 명시적으로 선택했을 때만)
    #[serde(default)]
    pub force: bool,
}

/// Grove가 만든 worktree만 제거한다. 브랜치는 남긴다. 대화가 아직 들어가 있으면 거부한다.
pub async fn remove(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Query(q): Query<RemoveQuery>) -> ApiResult<Response> {
    let force = q.force;
    let h = idem::body_hash("worktree.remove", &json!({ "w": id, "f": force }));
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? { return Ok(r); }
    let (w, root) = owned(&app, &id).await?;
    let lock = app.repo_locks.get(&w.project_id);
    let _g = lock.lock().await;
    crate::auth::revalidate(&app,&p).await?;
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? {
        return Ok(r);
    }
    let _resource = app.project_resources.ui_write(&app,&w.project_id,&p).await?;
    let (w, current_root) = owned(&app, &id).await?;
    if current_root != root { return Err(ApiError::conflict("project_changed", "프로젝트 경로가 바뀌어 worktree를 제거하지 않았습니다")); }
    if w.status == "removed" {
        return Ok(axum::response::IntoResponse::into_response((StatusCode::OK, Json(serde_json::to_value(&w)?))));
    }
    let wid = id.clone();
    let users: i64 = app
        .db
        .call(move |c| Ok(c.query_row("SELECT COUNT(*) FROM sessions WHERE worktree_id = ?1 AND archived_at IS NULL", params![wid], |r| r.get(0))?))
        .await?;
    if users > 0 {
        return Err(ApiError::conflict("worktree_in_use", "이 worktree에서 일하는 대화가 있습니다. 대화를 프로젝트 폴더로 돌린 뒤 제거하세요")
            .with_details(json!({ "sessions": users })));
    }
    let path = FsPath::new(&w.path);
    if path.is_dir() {
        let d = dirty_paths(path).await?;
        if !d.is_empty() && !force {
            return Err(ApiError::conflict("worktree_dirty", "worktree에 커밋하지 않은 변경이 있어 제거하지 않습니다. 버려도 되면 강제 제거를 선택하세요")
                .with_details(json!({ "changed": d.len(), "sample": d.iter().take(20).collect::<Vec<_>>() })));
        }
    }
    let pending = unknown(&w.project_id, "worktree.remove", Some(&id));
    if let Some(r) = accept(&app, &p, &headers, &h, &pending, |_, _| Ok(())).await? { return Ok(r); }
    let result = async {
        let o = if path.is_dir() {
            let mut args = vec!["worktree", "remove"];
            if force { args.push("--force"); }
            args.extend(["--", w.path.as_str()]);
            git(&root, &args, false).await?
        } else {
            // 경로가 이미 없으면 git의 관리 기록만 정리한다.
            git(&root, &["worktree", "prune"], false).await?
        };
        if o.code != 0 { return Err(fail(&o, "worktree 제거")); }
        Ok((StatusCode::OK, json!({})))
    }.await;
    let pid = w.project_id.clone();
    finish(&app, &p, &headers, &h, pending, result, move |tx, now, _| {
        tx.execute("UPDATE worktrees SET status = 'removed', removed_at = ?2 WHERE id = ?1", params![id, now])?;
        let w = get(tx, &id)?;
        events::append(tx, now, "worktree.changed", Some(&pid), None, &json!({ "op": "remove", "id": id }))?;
        let mut v = serde_json::to_value(&w)?;
        v["branch_kept"] = json!(true);
        Ok(v)
    })
    .await
}

// ---------------- 복원 검사·실행(PROJECT-009) ----------------

/// 제거(removed)·유실(missing)된 Grove worktree를 남겨 둔 브랜치로 같은 경로에 다시 만들 수 있는지.
/// 기존 폴더·다른 worktree가 쓰는 브랜치는 덮어쓰지 않는다.
async fn inspect_worktree(w: &Worktree, root: &FsPath) -> ApiResult<Value> {
    let unavailable = |reason: &str, message: &str| json!({ "kind": "unavailable", "worktree_id": w.id, "reason": reason, "message": message });
    if w.status != "removed" && w.status != "missing" {
        return Ok(unavailable("worktree_not_removed", "제거되거나 사라진 worktree가 아닙니다"));
    }
    if !is_repo(root).await? {
        return Ok(unavailable("project_not_repo", "프로젝트 폴더가 Git 저장소가 아니어서 다시 만들 수 없습니다"));
    }
    if FsPath::new(&w.path).exists() {
        return Ok(unavailable("worktree_path_occupied", "원래 worktree 경로에 이미 폴더가 있어 덮어쓰지 않습니다. 폴더를 확인하세요"));
    }
    let r = git(root, &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("refs/heads/{}", w.branch)], true).await?;
    if r.code != 0 {
        return Ok(unavailable("worktree_branch_missing", "남겨 둔 브랜치가 지워져 복원할 수 없습니다"));
    }
    let list = git(root, &["worktree", "list", "--porcelain"], true).await?;
    let mut holder: Option<String> = None;
    for block in String::from_utf8_lossy(&list.stdout).split("\n\n") {
        let path = block.lines().find_map(|l| l.strip_prefix("worktree ")).map(str::to_string);
        let branch = block.lines().find_map(|l| l.strip_prefix("branch ")).map(|b| b.trim_start_matches("refs/heads/").to_string());
        let gone = block.lines().any(|l| l.starts_with("prunable"));
        if branch.as_deref() == Some(w.branch.as_str()) && !gone {
            holder = path;
        }
    }
    if let Some(p) = holder {
        return Ok(json!({ "kind": "unavailable", "worktree_id": w.id, "reason": "worktree_branch_in_use",
            "message": format!("브랜치 {}를 다른 작업 폴더가 쓰고 있습니다: {p}", w.branch) }));
    }
    Ok(json!({ "kind": "recoverable", "worktree_id": w.id, "action": "restore", "branch": w.branch, "path": w.path, "name": w.name }))
}

pub async fn recovery(State(app): State<App>, p: Principal, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let (w, root) = owned(&app, &id).await?;
    let _resource = app.project_resources.ui_read(&app, &w.project_id, &p).await?;
    Ok(Json(inspect_worktree(&w, &root).await?))
}

pub async fn restore(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Response> {
    let h = idem::body_hash("worktree.restore", &json!({ "w": id }));
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? { return Ok(r); }
    let (w, root) = owned(&app, &id).await?;
    let lock = app.repo_locks.get(&w.project_id);
    let _g = lock.lock().await;
    crate::auth::revalidate(&app, &p).await?;
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? {
        return Ok(r);
    }
    let _resource = app.project_resources.ui_write(&app, &w.project_id, &p).await?;
    let (w, current_root) = owned(&app, &id).await?;
    if current_root != root { return Err(ApiError::conflict("project_changed", "프로젝트 경로가 바뀌어 worktree를 복원하지 않았습니다")); }
    // 검사는 잠금 안에서 다시 한다(화면이 본 결과를 믿지 않는다).
    let state = inspect_worktree(&w, &root).await?;
    if state["kind"] != "recoverable" {
        let reason = state["reason"].as_str().unwrap_or("unavailable").to_string();
        let code: &'static str = match reason.as_str() {
            "worktree_not_removed" => "worktree_not_removed",
            "project_not_repo" => "project_not_repo",
            "worktree_path_occupied" => "worktree_path_occupied",
            "worktree_branch_missing" => "worktree_branch_missing",
            _ => "worktree_branch_in_use",
        };
        return Err(ApiError::conflict(code, state["message"].as_str().unwrap_or("복원할 수 없습니다").to_string()).with_details(state));
    }
    let pending = unknown(&w.project_id, "worktree.restore", Some(&id));
    let pid = w.project_id.clone();
    if let Some(r) = accept(&app, &p, &headers, &h, &pending, move |tx, _| crate::projects::ensure_workspaces(tx, &pid)).await? { return Ok(r); }
    let result = async {
        // 사라진 경로의 관리 기록이 남아 있으면 add가 거절하므로 먼저 정리한다(폴더는 지우지 않는다).
        let o = git(&root, &["worktree", "prune"], false).await?;
        if o.code != 0 { return Err(fail(&o, "worktree prune")); }
        let o = git(&root, &["worktree", "add", "--", &w.path, &w.branch], false).await?;
        if o.code != 0 { return Err(fail(&o, "worktree 복원")); }
        Ok((StatusCode::OK, json!({})))
    }.await;
    let pid = w.project_id.clone();
    finish(&app, &p, &headers, &h, pending, result, move |tx, now, _| {
        tx.execute("UPDATE worktrees SET status = 'active', removed_at = NULL WHERE id = ?1", params![id])?;
        let w = get(tx, &id)?;
        events::append(tx, now, "worktree.changed", Some(&pid), None, &json!({ "op": "restore", "id": id }))?;
        Ok(serde_json::to_value(&w)?)
    })
    .await
}

/// 경로가 사라진 worktree의 git 관리 기록을 정리하고 Grove 기록을 missing으로 표시한다.
/// 어떤 폴더도 지우지 않는다(소유 아닌 worktree·남아 있는 폴더는 그대로).
pub async fn prune(State(app): State<App>, p: Principal, headers: HeaderMap, Path(project_id): Path<String>) -> ApiResult<Response> {
    let h = idem::body_hash("worktree.prune", &json!({ "p": project_id }));
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? { return Ok(r); }
    let root = root_of(&app, &project_id).await?;
    if !is_repo(&root).await? {
        return Err(ApiError::invalid("Git 저장소가 아닙니다"));
    }
    let lock = app.repo_locks.get(&project_id);
    let _g = lock.lock().await;
    crate::auth::revalidate(&app,&p).await?;
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? {
        return Ok(r);
    }
    let _resource = app.project_resources.ui_write(&app,&project_id,&p).await?;
    if root_of(&app, &project_id).await? != root { return Err(ApiError::conflict("project_changed", "프로젝트 경로가 바뀌어 prune하지 않았습니다")); }
    let pending = unknown(&project_id, "worktree.prune", None);
    if let Some(r) = accept(&app, &p, &headers, &h, &pending, |_, _| Ok(())).await? { return Ok(r); }
    let result = async {
        let o = git(&root, &["worktree", "prune", "--verbose"], false).await?;
        if o.code != 0 { return Err(fail(&o, "worktree prune")); }
        Ok((StatusCode::OK, json!({"git_pruned":lines(o.stderr.as_bytes()).len() + lines(&o.stdout).len()})))
    }.await;
    finish(&app, &p, &headers, &h, pending, result, move |tx, now, mut result| {
        let mut st = tx.prepare("SELECT id, path FROM worktrees WHERE project_id = ?1 AND status = 'active'")?;
        let rows = st.query_map(params![project_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(st);
        let mut missing = vec![];
        for (id, path) in rows {
            if !FsPath::new(&path).is_dir() {
                tx.execute("UPDATE worktrees SET status = 'missing' WHERE id = ?1", params![id])?;
                missing.push(id);
            }
        }
        events::append(tx, now, "worktree.changed", Some(&project_id), None, &json!({ "op": "prune" }))?;
        result["missing"] = json!(missing);
        Ok(result)
    })
    .await
}
