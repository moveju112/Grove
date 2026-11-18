//! 휴지통과 저장 공간 정리(DB-013·014·018·019).
//! 대화는 자동 삭제하지 않는다. 휴지통·완료 작업 로그의 보존 기간은 0이면 무기한이다.
//! GC는 종류별 제한된 항목을 검사하고 다음 호출에서 이어간다. 미확정 작업·unknown 로그는 보존한다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::{events, files, idem};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::fs::{DirEntry, ReadDir};
use std::io::Read;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

pub const MAX_PER_RUN: usize = 2500;
pub const BLOB_GRACE: Duration = Duration::from_secs(3600);
const PER_KIND: usize = MAX_PER_RUN / 5;
const TRASH_META_BYTES: u64 = 256 * 1024;
const TRASH_DEPTH: usize = 64;

/// 정기 유지보수와 격리 시험에서 같은 자동 압축 경로를 사용한다.
pub fn compress_history(app: &App) -> ApiResult<usize> {
    app.db.call_sync(|c| crate::history_storage::compress_idle(c, app.clock.now()))
}

#[derive(Default)]
pub struct Storage {
    // GC와 UI 파일 삭제·복원·영구 삭제를 직렬화한다. 다른 프로젝트 실행 상태와는 독립이다.
    pub(crate) mutations: tokio::sync::Mutex<()>,
    gc: Mutex<GcState>,
}

#[derive(Default)]
struct GcState {
    blobs: Scan,
    logs: Scan,
    trash: Scan,
    trash_queue: VecDeque<DirEntry>,
    trash_delete: Option<TrashDelete>,
    trash_after: i64,
    changes_after: i64,
    logs_after: i64,
    attachments: Scan,
    attachments_after: i64,
}

/// 정렬을 위해 디렉터리 전체를 적재하지 않는다. 열린 iterator는 서버 수명 동안만 유지한다.
#[derive(Default)]
struct Scan {
    dir: Option<ReadDir>,
    child: Option<ReadDir>,
}

impl Scan {
    fn batch(&mut self, root: &FsPath, nested: bool, limit: usize) -> ApiResult<Vec<DirEntry>> {
        if self.dir.is_none() {
            match std::fs::symlink_metadata(root) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
                Ok(m) if m.file_type().is_dir() => {}
                Ok(_) => {
                    return Err(ApiError::conflict(
                        "invalid_storage",
                        "저장 공간 경로가 디렉터리가 아닙니다",
                    ));
                }
                Err(e) => return Err(files::io_err(e, "정리 경로")),
            }
            self.dir = Some(std::fs::read_dir(root).map_err(|e| files::io_err(e, "정리 목록"))?);
        }
        let mut out = vec![];
        while out.len() < limit {
            let next = if let Some(child) = &mut self.child {
                match child.next() {
                    Some(e) => Some(e),
                    None => {
                        self.child = None;
                        continue;
                    }
                }
            } else {
                let next = self.dir.as_mut().unwrap().next();
                if let Some(Ok(e)) = &next {
                    if nested
                        && e.file_type()
                            .map_err(|e| files::io_err(e, "정리 항목"))?
                            .is_dir()
                    {
                        self.child = Some(
                            std::fs::read_dir(e.path())
                                .map_err(|e| files::io_err(e, "blob 목록"))?,
                        );
                    }
                }
                next
            };
            match next {
                Some(e) => out.push(e.map_err(|e| files::io_err(e, "정리 항목"))?),
                None => {
                    self.dir = None;
                    break;
                }
            }
        }
        Ok(out)
    }
}

struct TrashDelete {
    entry: Entry,
    dir: PathBuf,
    stack: Vec<(PathBuf, ReadDir)>,
}

enum TrashStep {
    More,
    Done,
    NeedsReview,
}

impl TrashDelete {
    fn start(dir: PathBuf, mut entry: Entry) -> ApiResult<Self> {
        entry.origin["state"] = json!("purging");
        write_origin(&dir, &entry.origin)?;
        let rd = std::fs::read_dir(&dir).map_err(|e| files::io_err(e, "휴지통 정리 목록"))?;
        Ok(Self {
            entry,
            dir: dir.clone(),
            stack: vec![(dir, rd)],
        })
    }

    // 한 번에 파일 하나 또는 폴더 하나만 처리한다. 메타데이터는 끝까지 남겨 재시작 시 이어간다.
    fn step(&mut self) -> ApiResult<TrashStep> {
        let Some((path, rd)) = self.stack.last_mut() else {
            return Ok(TrashStep::Done);
        };
        match rd.next() {
            Some(item) => {
                let item = item.map_err(|e| files::io_err(e, "휴지통 정리 항목"))?;
                if path == &self.dir && item.file_name() == "origin.json" {
                    return Ok(TrashStep::More);
                }
                let p = item.path();
                if item
                    .file_type()
                    .map_err(|e| files::io_err(e, "휴지통 정리 항목"))?
                    .is_dir()
                {
                    if self.stack.len() >= TRASH_DEPTH {
                        self.entry.origin["state"] = json!("needs_review");
                        write_origin(&self.dir, &self.entry.origin)?;
                        self.stack.clear();
                        return Ok(TrashStep::NeedsReview);
                    }
                    let rd =
                        std::fs::read_dir(&p).map_err(|e| files::io_err(e, "휴지통 정리 목록"))?;
                    self.stack.push((p, rd));
                } else {
                    std::fs::remove_file(p).map_err(|e| files::io_err(e, "휴지통 정리"))?;
                }
            }
            None => {
                let (p, _) = self.stack.pop().unwrap();
                if p != self.dir {
                    std::fs::remove_dir(p).map_err(|e| files::io_err(e, "휴지통 폴더 정리"))?;
                }
            }
        }
        Ok(if self.stack.is_empty() {
            TrashStep::Done
        } else {
            TrashStep::More
        })
    }
}

fn older_than(p: &FsPath, age: Duration, now: SystemTime) -> ApiResult<bool> {
    match p.symlink_metadata() {
        Ok(m) => Ok(now
            .duration_since(m.modified().map_err(|e| files::io_err(e, "수정 시각"))?)
            .is_ok_and(|d| d >= age)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(files::io_err(e, "정리 항목")),
    }
}

/// 삭제·복원과 겹치면 다음 주기로 유예한다. DB 오류를 '참조 없음'으로 취급하지 않는다.
pub fn gc(app: &App) -> ApiResult<Value> {
    let Ok(_guard) = app.storage.mutations.try_lock() else {
        return Ok(json!({ "deferred": true }));
    };
    let mut state = app
        .storage
        .gc
        .lock()
        .map_err(|_| ApiError::internal("storage gc lock"))?;
    let dd = app.cfg.data_dir.clone();
    let now = app.clock.now();
    let stamp = crate::util::fmt_time(now);
    let wall: SystemTime = now.into();
    let (trash_days, log_days) = app.db.call_sync(|c| {
        Ok((
            crate::settings::effective(c, "storage.trash_retention_days", None, None)?
                .as_i64()
                .unwrap_or(0),
            crate::settings::effective(c, "storage.task_log_retention_days", None, None)?
                .as_i64()
                .unwrap_or(0),
        ))
    })?;
    let mut blobs_removed = 0;
    for f in state.blobs.batch(&dd.join("blobs"), true, PER_KIND)? {
        let sha = f.file_name().to_string_lossy().to_string();
        let stage = crate::tools::fs::atomic_staging_target(&sha)
            .filter(|sha| crate::util::valid_sha256(sha));
        let hash = stage.unwrap_or(&sha);
        if !crate::util::valid_sha256(hash) {
            continue;
        }
        let canonical = if stage.is_some() {
            crate::changes::blob_path(&dd, hash)
                .parent()
                .unwrap()
                .join(&sha)
        } else {
            crate::changes::blob_path(&dd, hash)
        };
        if !f
            .file_type()
            .map_err(|e| files::io_err(e, "blob"))?
            .is_file()
            || f.path() != canonical
            || !older_than(&f.path(), BLOB_GRACE, wall)?
        {
            continue;
        }
        // 참조 확인과 삭제 사이에 새 DB 참조가 들어오지 않게 같은 DB 잠금 안에서 처리한다.
        blobs_removed += app.db.call_sync(|c| {
            let writing: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM tool_calls WHERE status = 'running' AND name IN ('write', 'edit', 'apply_patch'))", [], |r| r.get(0))?;
            if writing { return Ok(0); }
            let used: bool = stage.is_none() && c.query_row("SELECT EXISTS(SELECT 1 FROM file_changes WHERE before_sha = ?1 OR after_sha = ?1)", params![hash], |r| r.get(0))?;
            if used || !older_than(&f.path(), BLOB_GRACE, wall)? { return Ok(0); }
            std::fs::remove_file(f.path()).map_err(|e| files::io_err(e, "blob 정리"))?;
            if stage.is_none() { c.execute("DELETE FROM blobs WHERE sha = ?1", params![sha])?; }
            Ok(1)
        })?;
    }

    let after = state.changes_after;
    let rows: Vec<(i64, String, String, Option<String>, Option<String>)> = app.db.call_sync(|c| {
        let mut st = c.prepare("SELECT rowid, id, session_id, before_sha, after_sha FROM file_changes WHERE rowid > ?1 AND stored = 1 ORDER BY rowid LIMIT ?2")?;
        Ok(st.query_map(params![after, PER_KIND as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<Result<_, _>>()?)
    })?;
    let mut missing_marked = 0;
    for (_, id, sid, b, a) in &rows {
        let missing =
            [b, a]
                .into_iter()
                .flatten()
                .try_fold(false, |missing, s| -> ApiResult<bool> {
                    match crate::changes::blob_path(&dd, s).symlink_metadata() {
                        Ok(m) => Ok(missing
                            || !m.file_type().is_file()
                            || m.len() > crate::changes::MAX_STORED),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
                        Err(e) => Err(files::io_err(e, "blob 확인")),
                    }
                })?;
        if missing {
            app.db.call_sync(|c| {
                let tx = c.transaction()?;
                tx.execute(
                    "UPDATE file_changes SET stored = 0 WHERE id = ?1",
                    params![id],
                )?;
                events::append(
                    &tx,
                    &stamp,
                    "file_changes.updated",
                    None,
                    Some(sid),
                    &json!({ "session_id": sid }),
                )?;
                tx.commit()?;
                Ok(())
            })?;
            missing_marked += 1;
        }
    }
    state.changes_after = if rows.len() < PER_KIND {
        0
    } else {
        rows.last().unwrap().0
    };

    let cutoff = crate::util::fmt_time(now - time::Duration::days(log_days.clamp(0, 3650)));
    let mut task_logs_removed = 0;
    for f in state.logs.batch(&dd.join("tasks"), false, PER_KIND / 2)? {
        if !f
            .file_type()
            .map_err(|e| files::io_err(e, "작업 로그"))?
            .is_file()
        {
            continue;
        }
        let name = f.file_name().to_string_lossy().to_string();
        let Some(id) = name
            .strip_suffix(".out")
            .or_else(|| name.strip_suffix(".err"))
            .filter(|id| valid_id(id))
        else {
            continue;
        };
        let expired = app.db.call_sync(|c| {
            let row: Option<(String, Option<String>)> = c
                .query_row(
                    "SELECT status, ended_at FROM tasks WHERE id = ?1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            match row {
                None => Ok(true),
                Some((s, Some(end)))
                    if log_days > 0
                        && matches!(
                            s.as_str(),
                            "completed" | "failed" | "cancelled" | "timeout"
                        ) =>
                {
                    Ok(c.query_row(
                        "SELECT COALESCE(julianday(?1) < julianday(?2), 0)",
                        params![end, cutoff],
                        |r| r.get(0),
                    )?)
                }
                _ => Ok(false),
            }
        })?;
        if expired {
            app.db.call_sync(|c| {
                let tx=c.transaction()?;
                std::fs::remove_file(f.path()).map_err(|e| files::io_err(e, "작업 로그 정리"))?;
                let stream=if name.ends_with(".out") {"out"} else {"err"};
                let n=tx.execute("UPDATE task_logs SET state='expired',error=NULL,updated_at=?3 WHERE task_id=?1 AND stream=?2",params![id,stream,stamp])?;
                if n>0 {
                    let t=crate::tasks::get(&tx,id)?;
                    events::append(&tx,&stamp,"task.changed",Some(&t.project_id),Some(&t.session_id),&serde_json::to_value(&t)?)?;
                }
                tx.commit()?;
                Ok(())
            })?;
            task_logs_removed += 1;
        }
    }
    let task_logs_marked = crate::task_logs::reconcile(app, &mut state.logs_after, PER_KIND / 2)?;

    let mut trash_removed = 0;
    let mut trash_needs_review = 0;
    // 보존 기간을 꺼도 이미 원문 삭제가 끝난 작업의 완료 기록은 복구한다.
    let finishing = app.db.call_sync(|c| {
        let mut st = c.prepare("SELECT rowid,id,project_id,path,origin_sha256 FROM trash_gc WHERE rowid>?1 ORDER BY rowid LIMIT ?2")?;
        let rows = st.query_map(params![state.trash_after, PER_KIND / 2], |r| Ok((r.get::<_, i64>(0)?, TrashFinish {
            id:r.get(1)?,project_id:r.get(2)?,path:r.get(3)?,origin_sha256:r.get(4)?,
        })))?;
        Ok(rows.collect::<Result<Vec<_>,_>>()?)
    })?;
    state.trash_after = if finishing.len() < PER_KIND / 2 {
        0
    } else {
        finishing.last().unwrap().0
    };
    let finish_count = finishing.len();
    for (_, work) in finishing {
        if work.finish(app, &stamp)? {
            trash_removed += 1;
        }
    }
    if trash_days > 0 {
        if let Some(work) = &state.trash_delete {
            // 호출 사이 명시적 영구 삭제가 실패한 경우도 결과 불명 증거를 보존한다.
            if app.db.call_sync(|c| unresolved_trash(c, &work.entry.id))? {
                state.trash_delete = None;
            }
        }
        // 목록 검사와 하위 항목 삭제의 합을 종류별 한도 안에 둔다.
        if state.trash_queue.is_empty() && state.trash_delete.is_none() {
            let batch = state.trash.batch(&dd.join("trash"), false, PER_KIND / 2)?;
            state.trash_queue.extend(batch);
        }
        for _ in finish_count..PER_KIND / 2 {
            if state
                .trash_delete
                .as_ref()
                .is_some_and(|work| matches!(work.dir.symlink_metadata(), Err(e) if e.kind() == std::io::ErrorKind::NotFound))
            {
                state.trash_delete = None;
            }
            if let Some(work) = &mut state.trash_delete {
                match work.step()? {
                    TrashStep::More => continue,
                    TrashStep::NeedsReview => {
                        let project_id = work.entry.project_id.clone();
                        let path = work.entry.path.clone();
                        // 이벤트 기록이 실패해도 다음 호출이 빈 stack을 완료로 오인하지 않는다.
                        state.trash_delete = None;
                        trash_needs_review += 1;
                        app.db.call_sync(|c| {
                            events::append(
                                c,
                                &stamp,
                                "file.changed",
                                Some(&project_id),
                                None,
                                &json!({ "op":"needs_review", "path":path }),
                            )?;
                            Ok(())
                        })?;
                        continue;
                    }
                    TrashStep::Done => {
                        let finish = TrashFinish::from_entry(&work.entry);
                        finish.record(app)?;
                        // 이후에는 DB journal이 소유한다. 다음 호출에서 빈 stack으로 재귀 삭제하지 않는다.
                        state.trash_delete = None;
                        if finish.finish(app, &stamp)? {
                            trash_removed += 1;
                        }
                    }
                }
                continue;
            }
            let Some(f) = state.trash_queue.pop_front() else {
                break;
            };
            if let Some(e) = read_entry(&f.path()) {
                let protected = app.db.call_sync(|c| {
                    Ok(unresolved_trash(c, &e.id)?
                        || c.query_row(
                            "SELECT EXISTS(SELECT 1 FROM trash_gc WHERE id=?1)",
                            params![e.id],
                            |r| r.get::<_, bool>(0),
                        )?)
                })?;
                if !protected
                    && (e.origin["state"] == "purging"
                        || (e.ready
                            && e.age(wall) >= Duration::from_secs(trash_days as u64 * 86_400)))
                {
                    let work = TrashDelete::start(f.path(), e)?;
                    state.trash_delete = Some(work);
                    let work = state.trash_delete.as_ref().unwrap();
                    app.db.call_sync(|c| {
                        events::append(
                            c,
                            &stamp,
                            "file.changed",
                            Some(&work.entry.project_id),
                            None,
                            &json!({ "op": "purging", "path": work.entry.path }),
                        )?;
                        Ok(())
                    })?;
                }
            }
        }
    }
    let attachment_files =
        state
            .attachments
            .batch(&dd.join("attachments/blobs"), true, PER_KIND / 2)?;
    let attachment_gc = crate::attachments::gc(
        app,
        attachment_files,
        &mut state.attachments_after,
        PER_KIND / 2,
    )?;
    Ok(
        json!({ "blobs_removed": blobs_removed, "changes_marked_unstored": missing_marked, "task_logs_removed": task_logs_removed, "task_logs_marked":task_logs_marked, "trash_removed": trash_removed, "trash_needs_review":trash_needs_review, "attachments": attachment_gc }),
    )
}

struct Entry {
    id: String,
    project_id: String,
    path: String,
    deleted_at: Option<String>,
    item: Option<PathBuf>,
    ready: bool,
    time: SystemTime,
    origin: Value,
}

impl Entry {
    fn age(&self, now: SystemTime) -> Duration {
        now.duration_since(self.time).unwrap_or_default()
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// 새 항목은 고정 payload 경로를 쓴다. 이전 원래 파일명 형식도 읽되, symlink 디렉터리는 따라가지 않는다.
fn read_entry(dir: &FsPath) -> Option<Entry> {
    if !dir.symlink_metadata().ok()?.file_type().is_dir()
        || !valid_id(&dir.file_name()?.to_string_lossy())
    {
        return None;
    }
    let meta = dir.join("origin.json");
    let m = meta.symlink_metadata().ok()?;
    if !m.file_type().is_file() || m.len() > TRASH_META_BYTES {
        return None;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(meta).ok()?;
    let m = file.metadata().ok()?;
    if !m.file_type().is_file() || m.len() > TRASH_META_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(TRASH_META_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > TRASH_META_BYTES {
        return None;
    }
    let o: Value = serde_json::from_slice(&bytes).ok()?;
    let item = match o["format"].as_u64() {
        Some(2) => Some(dir.join("payload")).filter(|p| p.symlink_metadata().is_ok()),
        None => std::fs::read_dir(dir)
            .ok()?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| p.file_name().is_some_and(|n| n != "origin.json")),
        _ => return None,
    };
    let deleted_at = o["deleted_at"].as_str().map(String::from);
    let time = deleted_at
        .as_deref()
        .and_then(|s| {
            time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()
        })
        .map(SystemTime::from)
        .or_else(|| dir.metadata().ok()?.modified().ok())?;
    Some(Entry {
        id: dir.file_name()?.to_string_lossy().to_string(),
        project_id: o["project_id"].as_str()?.to_string(),
        path: o["path"].as_str()?.to_string(),
        deleted_at,
        item,
        ready: o["state"].as_str().is_none_or(|s| s == "trashed"),
        time,
        origin: o,
    })
}

fn entry(app: &App, id: &str) -> ApiResult<(PathBuf, Entry)> {
    if !valid_id(id) {
        return Err(ApiError::not_found("휴지통 항목이 없습니다"));
    }
    let dir = app.cfg.data_dir.join("trash").join(id);
    let e = read_entry(&dir).ok_or_else(|| ApiError::not_found("휴지통 항목이 없습니다"))?;
    Ok((dir, e))
}

struct TrashFinish {
    id: String,
    project_id: String,
    path: String,
    origin_sha256: String,
}

impl TrashFinish {
    fn from_entry(e: &Entry) -> Self {
        Self {
            id: e.id.clone(),
            project_id: e.project_id.clone(),
            path: e.path.clone(),
            origin_sha256: crate::util::sha256_hex(e.origin.to_string().as_bytes()),
        }
    }

    fn record(&self, app: &App) -> ApiResult<()> {
        app.db.call_sync(|c| {
            c.execute("INSERT INTO trash_gc(id,project_id,path,origin_sha256) VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO NOTHING",
                params![self.id,self.project_id,self.path,self.origin_sha256])?;
            Ok(())
        })
    }

    // 원문 삭제가 끝난 항목만 대상으로 한다. 중단 뒤 새로 생긴 내용은 재귀 삭제하지 않는다.
    fn finish(&self, app: &App, stamp: &str) -> ApiResult<bool> {
        if !valid_id(&self.id) || app.db.call_sync(|c| unresolved_trash(c, &self.id))? {
            return Ok(false);
        }
        let root = app.cfg.data_dir.join("trash");
        if root
            .symlink_metadata()
            .is_ok_and(|m| !m.file_type().is_dir())
        {
            return Ok(false);
        }
        let dir = root.join(&self.id);
        match dir.symlink_metadata() {
            Ok(m) if m.file_type().is_dir() => {
                let meta = dir.join("origin.json");
                match meta.symlink_metadata() {
                    Ok(_) => {
                        let Some(e) = read_entry(&dir) else {
                            return Ok(false);
                        };
                        if e.project_id != self.project_id
                            || e.path != self.path
                            || e.origin["state"] != "purging"
                            || crate::util::sha256_hex(e.origin.to_string().as_bytes())
                                != self.origin_sha256
                        {
                            return Ok(false);
                        }
                        for child in std::fs::read_dir(&dir)
                            .map_err(|e| files::io_err(e, "휴지통 완료 확인"))?
                            .take(2)
                        {
                            if child
                                .map_err(|e| files::io_err(e, "휴지통 완료 항목"))?
                                .file_name()
                                != "origin.json"
                            {
                                return Ok(false);
                            }
                        }
                        std::fs::remove_file(meta)
                            .map_err(|e| files::io_err(e, "휴지통 메타데이터 정리"))?;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(files::io_err(e, "휴지통 메타데이터 확인")),
                }
                match std::fs::remove_dir(&dir) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::DirectoryNotEmpty => {
                        return Ok(false);
                    }
                    Err(e) => return Err(files::io_err(e, "휴지통 항목 정리")),
                }
            }
            Ok(_) => return Ok(false),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(files::io_err(e, "휴지통 완료 확인")),
        }
        app.db.call_sync(|c| {
            let tx = c.transaction()?;
            if tx.execute("DELETE FROM trash_gc WHERE id=?1", params![self.id])? > 0 {
                events::append(
                    &tx,
                    stamp,
                    "file.changed",
                    Some(&self.project_id),
                    None,
                    &json!({"op":"purge","path":self.path}),
                )?;
            }
            tx.commit()?;
            Ok(())
        })?;
        Ok(true)
    }
}

fn unresolved_trash(c: &rusqlite::Connection, id: &str) -> ApiResult<bool> {
    Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM idempotency WHERE status = 409 AND json_extract(response, '$.error.code') = 'result_unknown' AND json_extract(response, '$.error.details.trash_id') = ?1)", params![id], |r| r.get(0))?)
}

pub async fn list_trash(
    State(app): State<App>,
    _p: Principal,
    Path(project_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let pid = project_id.clone();
    app.db
        .call(move |c| crate::projects::active_root(c, &pid))
        .await?;
    let items = tokio::task::spawn_blocking(move || -> ApiResult<Vec<Value>> {
        let rd = match std::fs::read_dir(app.cfg.data_dir.join("trash")) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(files::io_err(e, "휴지통 목록")),
        };
        let mut v: Vec<Entry> = rd.filter_map(Result::ok).filter_map(|e| read_entry(&e.path())).filter(|e| e.project_id == project_id).collect();
        v.sort_by_key(|e| std::cmp::Reverse(e.time));
        v.into_iter().map(|e| {
            let unresolved = app.db.call_sync(|c| unresolved_trash(c, &e.id))?;
            Ok(json!({ "id": e.id, "path": e.path, "deleted_at": e.deleted_at,
                "is_dir": e.item.as_ref().is_some_and(|p| p.is_dir()), "status": if unresolved { "needs_review" } else if e.origin["state"] == "purging" { "purging" } else if e.ready && e.item.is_some() { "trashed" } else { "needs_review" } }))
        }).collect()
    }).await.map_err(|e| ApiError::internal(e.to_string()))??;
    Ok(Json(json!({ "items": items })))
}

#[derive(Clone)]
enum Op {
    Delete {
        project_id: String,
        path: String,
        confirm: String,
    },
    Restore {
        id: String,
    },
    Purge {
        id: String,
        confirm: String,
    },
}

struct Plan {
    dir: PathBuf,
    project_id: String,
    path: String,
    origin: Value,
    work: Work,
    storage: crate::project_fs::ProjectFs,
}

enum Work {
    Delete { source: PathBuf, scope: crate::project_fs::ProjectFs },
    Restore { item: PathBuf, target: PathBuf, scope: crate::project_fs::ProjectFs },
    Purge,
}

fn confirm_path(confirm: &str, path: &str) -> ApiResult<()> {
    if confirm != path {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "confirmation_required",
            format!("확인란에 `{path}`을 그대로 적으세요"),
        ));
    }
    Ok(())
}

fn prepare(app: &App, op: Op) -> ApiResult<Plan> {
    let storage = crate::project_fs::ProjectFs::open(&app.cfg.data_dir).map_err(|e| files::io_err(e, "저장 공간 열기"))?;
    match op {
        Op::Delete {
            project_id,
            path,
            confirm,
        } => {
            let root = app
                .db
                .call_sync(|c| crate::projects::active_root(c, &project_id))?;
            let root = crate::util::canonical(&root).map_err(|e| files::io_err(e, "프로젝트"))?;
            let source = files::resolve_api(&root, &path)?;
            let scope = crate::project_fs::ProjectFs::open(&root).map_err(|e| files::io_err(e, "프로젝트 열기"))?;
            if source == root {
                return Err(ApiError::invalid("프로젝트 root는 지울 수 없습니다"));
            }
            let path = crate::tools::fs::rel_display(&root, &source);
            confirm_path(&confirm, &path)?;
            scope
                .symlink_metadata(&source)
                .map_err(|e| files::io_err(e, "삭제 대상"))?;
            let dir = app.cfg.data_dir.join("trash").join(crate::util::new_id());
            let origin = json!({ "format": 2, "state": "pending", "project_id": project_id, "path": path, "deleted_at": app.now() });
            Ok(Plan {
                dir,
                project_id,
                path,
                origin,
                work: Work::Delete { source, scope },
                storage,
            })
        }
        Op::Restore { ref id } | Op::Purge { ref id, .. } => {
            let (dir, e) = entry(app, &id)?;
            let root = app
                .db
                .call_sync(|c| crate::projects::active_root(c, &e.project_id))?;
            let work = if let Op::Purge { confirm, .. } = op {
                confirm_path(&confirm, &e.path)?;
                Work::Purge
            } else {
                if !e.ready {
                    return Err(ApiError::conflict(
                        "needs_review",
                        "중단된 파일 작업입니다. 원본과 휴지통을 확인하세요",
                    ));
                }
                let item = e
                    .item
                    .ok_or_else(|| ApiError::conflict("broken", "휴지통 내용이 없습니다"))?;
                let target = files::resolve_api(&root, &e.path)?;
                let scope = crate::project_fs::ProjectFs::open(&root).map_err(|e| files::io_err(e, "프로젝트 열기"))?;
                if scope.symlink_metadata(&target).is_ok() {
                    return Err(ApiError::conflict(
                        "already_exists",
                        "같은 경로에 이미 파일이 있습니다",
                    ));
                }
                Work::Restore { item, target, scope }
            };
            Ok(Plan {
                dir,
                project_id: e.project_id,
                path: e.path,
                origin: e.origin,
                work,
                storage,
            })
        }
    }
}

fn write_origin(dir: &FsPath, origin: &Value) -> ApiResult<()> {
    crate::tools::fs::atomic_write(&dir.join("origin.json"), origin.to_string().as_bytes())
        .map_err(|e| ApiError::conflict(e.code, e.message))
}

/// 확인 뒤 새로 만들어진 같은 이름의 파일도 덮어쓰지 않는다.
pub(crate) fn rename_noreplace(from: &FsPath, to: &FsPath) -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStrExt;
        let from = std::ffi::CString::new(from.as_os_str().as_bytes())?;
        let to = std::ffi::CString::new(to.as_os_str().as_bytes())?;
        let rc = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if rc == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
        }
        let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } != 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = (from, to);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "안전한 이동을 지원하지 않는 OS입니다",
        ))
    }
}

fn execute(mut plan: Plan) -> ApiResult<Value> {
    let storage = plan.storage;
    let write_origin = |origin: &Value| storage.atomic_write(&plan.dir.join("origin.json"), origin.to_string().as_bytes())
        .map_err(|e| files::io_err(e, "휴지통 기록"));
    match plan.work {
        Work::Delete { source, scope } => {
            storage.create_dir_all(plan.dir.parent().unwrap())
                .map_err(|e| files::io_err(e, "휴지통"))?;
            storage.create_dir(&plan.dir, true).map_err(|e| files::io_err(e, "휴지통 항목"))?;
            write_origin(&plan.origin)?;
            let payload = plan.dir.join("payload");
            if let Err(e) = scope.rename_noreplace(&source, &storage, &payload) {
                if e.kind() != std::io::ErrorKind::CrossesDevices {
                    return Err(files::io_err(e, "휴지통 이동"));
                }
                scope.copy_to(&source, &storage, &payload)
                    .map_err(|e| files::io_err(e, "휴지통 복사"))?;
                if scope.symlink_metadata(&source).map_err(|e| files::io_err(e, "원본 확인"))?.is_dir() {
                    scope.remove_dir_all(&source)
                } else { scope.remove_file(&source) }.map_err(|e| files::io_err(e, "원본 정리"))?;
            }
            plan.origin["state"] = json!("trashed");
            write_origin(&plan.origin)?;
            Ok(
                json!({ "op": "delete", "path": plan.path, "trash": plan.dir.file_name().unwrap().to_string_lossy() }),
            )
        }
        Work::Restore { item, target, scope } => {
            plan.origin["state"] = json!("restoring");
            write_origin(&plan.origin)?;
            let parent = target
                .parent()
                .ok_or_else(|| ApiError::invalid("복원 경로가 잘못되었습니다"))?;
            scope.create_dir_all(parent).map_err(|e| files::io_err(e, "복원 폴더"))?;
            if let Err(e) = storage.rename_noreplace(&item, &scope, &target) {
                if e.kind() != std::io::ErrorKind::CrossesDevices {
                    return Err(files::io_err(e, "복원"));
                }
                // 복사는 우리가 만든 staging 안에서 끝낸 뒤 덮어쓰기 없는 rename으로 공개한다.
                let stage = parent.join(format!(".grove-restore-{}", crate::util::new_id()));
                scope.create_dir(&stage, true).map_err(|e| files::io_err(e, "복원 임시 폴더"))?;
                let result = storage.copy_to(&item, &scope, &stage.join("payload"))
                    .and_then(|_| scope.rename_noreplace(&stage.join("payload"), &scope, &target));
                let _ = scope.remove_dir_all(&stage);
                result.map_err(|e| files::io_err(e, "복원"))?;
            }
            storage.remove_dir_all(&plan.dir)
                .map_err(|e| files::io_err(e, "복원 후 휴지통 정리"))?;
            Ok(json!({ "op": "restore", "path": plan.path }))
        }
        Work::Purge => {
            storage.remove_dir_all(&plan.dir).map_err(|e| files::io_err(e, "영구 삭제"))?;
            Ok(json!({ "op": "purge", "deleted": true, "path": plan.path }))
        }
    }
}

async fn mutate(
    app: App,
    p: Principal,
    headers: HeaderMap,
    op: Op,
    body: Value,
) -> ApiResult<Response> {
    let h = idem::body_hash("trash", &body);
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? {
        return Ok(r);
    }
    let project = match &op {
        Op::Delete { project_id,.. } => project_id.clone(),
        Op::Restore { id } | Op::Purge { id,.. } => entry(&app,id)?.1.project_id,
    };
    let _resource = app.project_resources.ui_write(&app,&project,&p).await?;
    let _guard = app.storage.mutations.lock().await;
    if let Some(response) = idem::replay(&app,&p,&headers,&h).await? { return Ok(response); }
    let a = app.clone();
    let plan = tokio::task::spawn_blocking(move || prepare(&a, op))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))??;
    let pid = plan.project_id.clone();
    let trash_id = plan.dir.file_name().unwrap().to_string_lossy().to_string();
    let unknown = ApiError::conflict("result_unknown", "파일 작업 결과를 확정하지 못했습니다. 원본과 휴지통을 확인하세요")
        .with_details(json!({ "project_id": pid, "path": plan.path, "trash_id": plan.dir.file_name().unwrap().to_string_lossy() }));
    let pending = unknown.body();
    // 실행 전에 영속 접수한다. 중간 종료·결과 commit 실패 뒤 같은 키로 파일 작업을 재실행하지 않는다.
    idem::run(&app, &p, &headers, &h, move |_, _| {
        Ok((StatusCode::CONFLICT, pending))
    })
    .await?;
    let result = match tokio::task::spawn_blocking(move || execute(plan)).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            tracing::warn!(code = e.code, "휴지통 작업 결과 불명");
            return Err(unknown);
        }
        Err(_) => {
            tracing::warn!("휴지통 실행 작업 결과 불명");
            return Err(unknown);
        }
    };
    let key = idem::key_from(&headers)?;
    let owner = p.root_id;
    let now = app.now();
    let response = result.clone();
    app.db
        .call(move |c| {
            let tx = c.transaction()?;
            idem::complete(&tx, &owner, &key, &h, StatusCode::OK, &response)?;
            events::append(&tx, &now, "file.changed", Some(&pid), None, &response)?;
            if response["op"] == "purge" {
                tx.execute("DELETE FROM trash_gc WHERE id=?1", params![trash_id])?;
            }
            tx.commit()?;
            Ok(())
        })
        .await
        .map_err(|_| unknown)?;
    app.notify_events().await;
    Ok(Json(result).into_response())
}

pub async fn move_to_trash(
    app: App,
    p: Principal,
    headers: HeaderMap,
    project_id: String,
    path: String,
    confirm: String,
) -> ApiResult<Response> {
    let body =
        json!({ "op": "delete", "project_id": project_id, "path": path, "confirm": confirm });
    mutate(
        app,
        p,
        headers,
        Op::Delete {
            project_id,
            path,
            confirm,
        },
        body,
    )
    .await
}

pub async fn restore_trash(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let body = json!({ "op": "restore", "id": id });
    mutate(app, p, headers, Op::Restore { id }, body).await
}

#[derive(Deserialize)]
pub struct ConfirmBody {
    pub confirm: String,
}

pub async fn delete_trash(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<ConfirmBody>,
) -> ApiResult<Response> {
    let body = json!({ "op": "purge", "id": id, "confirm": b.confirm });
    mutate(
        app,
        p,
        headers,
        Op::Purge {
            id,
            confirm: b.confirm,
        },
        body,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn trash_delete_and_restore_do_not_follow_replaced_project_parents() {
        use crate::project_fs::ProjectFs;
        use std::os::unix::fs::symlink;
        for restore in [false, true] {
            let fixture = tempfile::tempdir().unwrap();
            let root = fixture.path().join("project");
            let data = fixture.path().join("data");
            let outside = fixture.path().join("outside");
            std::fs::create_dir_all(root.join("folder")).unwrap();
            std::fs::create_dir(&data).unwrap();
            std::fs::create_dir(&outside).unwrap();
            std::fs::write(outside.join("file"), "outside").unwrap();
            std::fs::write(root.join("folder/file"), "project").unwrap();
            let dir = data.join("trash/entry");
            let scope = ProjectFs::open(&root).unwrap();
            let storage = ProjectFs::open(&data).unwrap();
            let work = if restore {
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(dir.join("payload"), "restore").unwrap();
                Work::Restore { item: dir.join("payload"), target: root.join("folder/new"), scope }
            } else {
                Work::Delete { source: root.join("folder/file"), scope }
            };
            let plan = Plan { dir: dir.clone(), project_id: "project".into(), path: "folder/file".into(),
                origin: json!({ "format": 2, "state": "pending", "project_id": "project", "path": "folder/file" }),
                work, storage };
            std::fs::rename(root.join("folder"), root.join("old-folder")).unwrap();
            symlink(&outside, root.join("folder")).unwrap();
            assert!(execute(plan).is_err());
            assert_eq!(std::fs::read(outside.join("file")).unwrap(), b"outside");
            assert!(!outside.join("new").exists());
            if restore { assert_eq!(std::fs::read(dir.join("payload")).unwrap(), b"restore"); }
        }
    }

    fn trash_fixture(root: &FsPath) -> PathBuf {
        let dir = root.join("entry");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("origin.json"), json!({ "format":2,"state":"trashed","project_id":"p","path":"deep","deleted_at":"2000-01-01T00:00:00Z" }).to_string()).unwrap();
        dir
    }

    #[test]
    fn trash_metadata_has_a_read_budget() {
        let d = tempfile::tempdir().unwrap();
        let dir = trash_fixture(d.path());
        std::fs::write(dir.join("payload"), b"keep").unwrap();
        assert!(read_entry(&dir).is_some());
        let meta = dir.join("origin.json");
        let original = std::fs::read(&meta).unwrap();
        let mut padded = original;
        padded.resize(300 * 1024, b' ');
        std::fs::write(&meta, &padded).unwrap();
        assert!(
            read_entry(&dir).is_none(),
            "큰 metadata는 전부 적재하지 않고 보존한다"
        );
        assert_eq!(std::fs::metadata(meta).unwrap().len(), padded.len() as u64);
        assert_eq!(std::fs::read(dir.join("payload")).unwrap(), b"keep");
    }

    #[test]
    fn trash_gc_limits_open_directory_handles() {
        let d = tempfile::tempdir().unwrap();
        let dir = trash_fixture(d.path());
        let mut deepest = dir.join("payload");
        std::fs::create_dir(&deepest).unwrap();
        for _ in 0..80 {
            deepest.push("d");
            std::fs::create_dir(&deepest).unwrap();
        }
        std::fs::write(deepest.join("keep"), b"preserve").unwrap();
        let mut work = TrashDelete::start(dir.clone(), read_entry(&dir).unwrap()).unwrap();
        for _ in 0..70 {
            let _ = work.step().unwrap();
        }
        assert!(
            work.stack.len() <= 64,
            "호출마다 하위 폴더 handle을 계속 쌓지 않는다"
        );
        assert!(deepest.join("keep").exists());
        assert_eq!(read_entry(&dir).unwrap().origin["state"], "needs_review");
    }

    #[test]
    fn nested_scan_counts_directories_and_advances_its_cursor() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..101 {
            let dir = d.path().join(format!("dir-{i}"));
            std::fs::create_dir(&dir).unwrap();
            if i % 2 == 0 {
                std::fs::write(dir.join("file"), b"x").unwrap();
            }
        }
        let mut scan = Scan::default();
        let mut seen = std::collections::BTreeSet::new();
        loop {
            let batch = scan.batch(d.path(), true, 7).unwrap();
            assert!(batch.len() <= 7);
            let done = batch.len() < 7;
            for e in batch {
                assert!(
                    seen.insert(e.path()),
                    "이어갈 때 앞부분을 다시 검사하지 않는다"
                );
            }
            if done {
                break;
            }
        }
        assert_eq!(seen.len(), 152);
    }

    #[test]
    fn rename_never_replaces_an_existing_file_or_directory() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let target = dir.path().join("target");
        std::fs::write(&source, "원본").unwrap();
        std::fs::write(&target, "새 파일").unwrap();
        assert!(rename_noreplace(&source, &target).is_err());
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "원본");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "새 파일");
        std::fs::remove_file(&source).unwrap();
        std::fs::remove_file(&target).unwrap();
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&target).unwrap();
        assert!(rename_noreplace(&source, &target).is_err());
        assert!(source.is_dir() && target.is_dir());
    }
}
