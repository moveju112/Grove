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
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path as FsPath, PathBuf};

/// 내용을 보관할 최대 파일 크기. 넘으면 sha만 남기고 undo/redo·diff를 제공하지 않는다.
pub const MAX_STORED: u64 = 16 * 1024 * 1024;
const MAX_NATIVE_FILES: usize = 20_000;
const MAX_NATIVE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_INVENTORY_ENTRIES: usize = 80_000;

pub(crate) struct WorkspaceSnapshot {
    files: HashMap<String, FileState>,
    inventory: Option<HashSet<PathBuf>>,
}

fn native_mode(meta: &std::fs::Metadata) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let mode = meta.permissions().mode() & 0o7777;
        (meta.nlink() == 1 && mode & 0o7000 == 0).then_some(mode)
    }
    #[cfg(not(unix))]
    { (!meta.permissions().readonly()).then_some(0) }
}

fn inventory_key(path: PathBuf) -> PathBuf {
    // 대소문자만 달라진 기존 파일을 새 파일로 분류하면 복원 시 삭제될 수 있다.
    if cfg!(any(windows, target_os = "macos")) { PathBuf::from(path.to_string_lossy().to_lowercase()) } else { path }
}

impl WorkspaceSnapshot {
    pub(crate) fn capture(root: &FsPath, data_dir: &FsPath, baseline: bool) -> std::io::Result<Self> {
        use std::io::Read;
        let scope = crate::project_fs::ProjectFs::open(root)?;
        let root = scope.root();
        let data_dir = crate::util::canonical(data_dir)?;
        if root.starts_with(&data_dir) { return Ok(Self { files: HashMap::new(), inventory: None }); }
        // 한도를 넘는 프로젝트는 내용을 읽기 전에 목록의 크기만으로 거절한다. 읽을 때의 한도 검사는 그대로 둔다.
        let mut candidates = Vec::new();
        let (mut listed, mut listed_bytes) = (0usize, 0u64);
        for entry in crate::tools::search::walker_excluding(root, root, false, Some(data_dir.clone())) {
            let entry = entry.map_err(std::io::Error::other)?;
            if !entry.file_type().is_some_and(|kind| kind.is_file()) { continue; }
            let name = entry.file_name().to_string_lossy();
            if name == ".env" || name.starts_with(".env.") { continue; }
            if entry.path().strip_prefix(root).ok().and_then(FsPath::to_str).is_none() { continue; }
            // 읽을 때 건너뛰는 파일(보관 상한 초과·특수 권한·hard link)은 세지 않는다.
            if let Ok(meta) = entry.metadata() && meta.len() <= MAX_STORED && native_mode(&meta).is_some() {
                listed += 1;
                listed_bytes += meta.len();
                if listed > MAX_NATIVE_FILES {
                    return Err(std::io::Error::other("CLI 변경 이력의 파일 수 한도를 넘었습니다"));
                }
                if listed_bytes > MAX_NATIVE_BYTES {
                    return Err(std::io::Error::other("CLI 변경 이력의 용량 한도를 넘었습니다"));
                }
            }
            candidates.push(entry.into_path());
        }
        let mut files = HashMap::new();
        let mut remaining = MAX_NATIVE_BYTES;
        for path in &candidates {
            let Some(relative) = path.strip_prefix(root).ok().and_then(FsPath::to_str) else { continue; };
            if files.len() >= MAX_NATIVE_FILES {
                return Err(std::io::Error::other("CLI 변경 이력의 파일 수 한도를 넘었습니다"));
            }
            let file = match scope.open_regular_file(path, true) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            let meta = file.metadata()?;
            if meta.len() > MAX_STORED { continue; }
            let Some(mode) = native_mode(&meta) else { continue; };
            let mut bytes = Vec::new();
            file.take(remaining.min(MAX_STORED) + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > remaining.min(MAX_STORED) {
                return Err(std::io::Error::other("CLI 변경 이력의 용량 한도를 넘었습니다"));
            }
            remaining -= bytes.len() as u64;
            files.insert(relative.replace(std::path::MAIN_SEPARATOR, "/"), FileState { sha: sha256_hex(&bytes), bytes: Some(bytes), mode: Some(mode) });
        }
        // 무시 규칙이 바뀌어 드러난 기존 파일을 새 파일로 기록하면 undo에서 삭제될 수 있다.
        let inventory = baseline.then(|| {
            let mut paths = HashSet::new();
            for entry in crate::tools::search::walker_excluding(root, root, true, Some(data_dir)) {
                let entry = entry.ok()?;
                if paths.len() >= MAX_INVENTORY_ENTRIES { return None; }
                paths.insert(inventory_key(entry.into_path()));
            }
            Some(paths)
        }).flatten();
        Ok(Self { files, inventory })
    }

    pub(crate) fn changes(self, after: Self, root: &FsPath, data_dir: &FsPath) -> std::io::Result<Vec<Rec>> {
        let scope = crate::project_fs::ProjectFs::open(root)?;
        let mut after = after.files;
        let mut records = Vec::new();
        for (path, before) in self.files {
            let current = after.remove(&path);
            // 파일이 커지거나 ignore·symlink 설정이 바뀌어 목록에서 빠진 경우 삭제로 기록하지 않는다.
            if current.is_none() && !scope.symlink_metadata(&scope.root().join(&path)).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
                continue;
            }
            if current.as_ref().is_none_or(|current| current.sha != before.sha || current.mode != before.mode) {
                records.push(Rec::store(data_dir, path, Some(before), current));
            }
        }
        if let Some(inventory) = self.inventory {
            for (path, current) in after {
                if !inventory.contains(&inventory_key(scope.root().join(&path))) {
                    records.push(Rec::store(data_dir, path, None, Some(current)));
                }
            }
        }
        records.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(records)
    }
}

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
    mode: Option<u32>,
}

fn read_state(root: &FsPath, p: &FsPath) -> Option<FileState> {
    use std::io::Read;
    let scope = crate::project_fs::ProjectFs::open(root).ok()?;
    let mut file = scope.open_file(p).ok()?;
    let m = file.metadata().ok()?;
    if m.len() > MAX_STORED {
        return crate::tools::fs::reader_sha(file).ok().map(|sha| FileState { sha, bytes: None, mode: None });
    }
    let mut bytes = Vec::new();
    (&mut file).take(MAX_STORED + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_STORED {
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(0)).ok()?;
        return crate::tools::fs::reader_sha(file).ok().map(|sha| FileState { sha, bytes: None, mode: None });
    }
    Some(FileState { sha: sha256_hex(&bytes), bytes: Some(bytes), mode: None })
}

/// 실행 직전 상태.
pub struct Before {
    root: PathBuf,
    files: Vec<(String, Option<FileState>)>,
}

pub fn capture(root: &FsPath, paths: &[String]) -> Before {
    let files = paths.iter().map(|rel| (rel.clone(), resolve(root, rel).ok().and_then(|p| read_state(root, &p)))).collect();
    Before { root: root.to_path_buf(), files }
}

/// 기록할 변경 한 건.
pub struct Rec {
    path: String,
    before: Option<FileState>,
    after: Option<FileState>,
}

impl Rec {
    fn store(data_dir: &FsPath, path: String, mut before: Option<FileState>, mut after: Option<FileState>) -> Self {
        for state in [&mut before, &mut after].into_iter().flatten() {
            if let Some(bytes) = &state.bytes && put_blob(data_dir, &state.sha, bytes).is_err() {
                // 파일 변경과 원문 보관 성공은 구분한다.
                state.bytes = None;
            }
        }
        Self { path, before, after }
    }
}

/// 실행 성공 직후: 변경 후 상태를 읽고 바뀐 파일만 남기며 blob을 저장한다(transaction 밖, 파일 작업).
pub fn finalize(data_dir: &FsPath, b: Before) -> Vec<Rec> {
    let mut out = vec![];
    for (rel, before) in b.files {
        let after = resolve(&b.root, &rel).ok().and_then(|p| read_state(&b.root, &p));
        if before.as_ref().map(|s| &s.sha) == after.as_ref().map(|s| &s.sha) {
            continue;
        }
        out.push(Rec::store(data_dir, rel, before, after));
    }
    out
}

pub(crate) fn blob_path(data_dir: &FsPath, sha: &str) -> PathBuf {
    data_dir.join("blobs").join(&sha[..2.min(sha.len())]).join(sha)
}

fn put_blob(data_dir: &FsPath, sha: &str, bytes: &[u8]) -> std::io::Result<()> {
    if !crate::util::valid_sha256(sha) || bytes.len() as u64 > MAX_STORED {
        return Err(std::io::Error::other("변경 원문 key 또는 크기가 잘못되었습니다"));
    }
    let p = blob_path(data_dir, sha);
    for dir in [data_dir.join("blobs"), p.parent().expect("blob dir").to_path_buf()] {
        match std::fs::create_dir(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        if !dir.symlink_metadata()?.file_type().is_dir() {
            return Err(std::io::Error::other("변경 원문 폴더가 잘못되었습니다"));
        }
    }
    match p.symlink_metadata() {
        Ok(m) => {
            if !m.file_type().is_file() {
                return Err(std::io::Error::other("변경 원문이 일반 파일이 아닙니다"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if m.nlink() != 1 {
                    return Err(std::io::Error::other("변경 원문이 외부 파일과 연결되었습니다"));
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    // 현재 확보한 정상 원문으로 교체한다. 같은 hash의 손상 파일도 복구하고 GC 유예 시각을 갱신한다.
    atomic_write(&p, bytes).map_err(|e| std::io::Error::other(e.message))
}

fn get_blob(data_dir: &FsPath, sha: &str) -> Option<Vec<u8>> {
    use std::io::Read;
    if !crate::util::valid_sha256(sha) { return None; }
    let p = blob_path(data_dir, sha);
    for dir in [data_dir.join("blobs"), p.parent()?.to_path_buf()] {
        if !dir.symlink_metadata().ok()?.file_type().is_dir() { return None; }
    }
    let m = p.symlink_metadata().ok()?;
    if !m.file_type().is_file() || m.len() > MAX_STORED { return None; }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(p).ok()?;
    let m = file.metadata().ok()?;
    if !m.file_type().is_file() || m.len() > MAX_STORED { return None; }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if m.nlink() != 1 { return None; }
    }
    let mut b = Vec::new();
    file.take(MAX_STORED + 1).read_to_end(&mut b).ok()?;
    (b.len() as u64 <= MAX_STORED && sha256_hex(&b) == sha).then_some(b)
}

/// 도구 결과 확정과 같은 transaction에서 기록한다.
pub fn insert(tx: &Connection, now: &str, session_id: &str, turn_id: Option<&str>, call_id: Option<&str>, tool: &str, recs: &[Rec]) -> ApiResult<()> {
    if recs.is_empty() {
        return Ok(());
    }
    let mut seq: i64 = tx.query_row("SELECT COALESCE(MAX(seq), 0) FROM file_changes WHERE session_id = ?1", params![session_id], |r| r.get(0))?;
    for r in recs {
        seq += 1;
        let stored = [&r.before, &r.after].into_iter().flatten().all(|s| s.bytes.is_some());
        for s in [&r.before, &r.after].into_iter().flatten() {
            if let Some(b) = &s.bytes {
                tx.execute("INSERT INTO blobs (sha, size, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(sha) DO NOTHING", params![s.sha, b.len() as i64, now])?;
            }
        }
        tx.execute(
            "INSERT INTO file_changes (id, session_id, turn_id, call_id, tool, path, before_sha, after_sha, stored, created_at, seq, before_mode, after_mode) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
                seq,
                r.before.as_ref().and_then(|s| s.mode),
                r.after.as_ref().and_then(|s| s.mode),
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
    /// Grove 도구 호출 ID. CLI 턴 스냅샷은 빈 문자열로 전달한다.
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
    #[serde(skip)]
    #[ts(skip)]
    before_mode: Option<u32>,
    #[serde(skip)]
    #[ts(skip)]
    after_mode: Option<u32>,
}

const COLS: &str = "id, turn_id, call_id, tool, path, before_sha, after_sha, stored, undone_at, created_at, seq, before_mode, after_mode";

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
        call_id: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
        tool: r.get(3)?,
        path: r.get(4)?,
        op: op.into(),
        before_sha: b,
        after_sha: a,
        stored: r.get::<_, i64>(7)? != 0,
        undone_at: r.get(8)?,
        created_at: r.get(9)?,
        seq: r.get(10)?,
        before_mode: r.get(11)?,
        after_mode: r.get(12)?,
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

#[derive(Deserialize)]
pub struct ChangePageQuery {
    pub before_seq: Option<i64>,
    pub limit: Option<usize>,
}

#[derive(Serialize, ts_rs::TS)]
pub struct FileChangeGroup {
    pub turn_id: Option<String>,
    pub applied: usize,
    pub undone: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub has_cli_snapshot: Option<bool>,
}

#[derive(Serialize, ts_rs::TS)]
pub struct FileChangePage {
    pub items: Vec<FileChange>,
    pub groups: Vec<FileChangeGroup>,
    pub total: usize,
    pub applied: usize,
    pub through_seq: i64,
    pub next_before_seq: Option<i64>,
}

pub async fn page(State(app): State<App>, _p: Principal, Path(id): Path<String>, Query(q): Query<ChangePageQuery>) -> ApiResult<Json<FileChangePage>> {
    if q.before_seq.is_some_and(|seq| seq < 1) { return Err(ApiError::invalid("변경 이력 위치가 잘못되었습니다")); }
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let result = app.db.call(move |c| {
        crate::sessions::get(c, &id)?;
        let (total, applied, through_seq): (usize, usize, i64) = c.query_row(
            "SELECT COUNT(*), COALESCE(SUM(undone_at IS NULL), 0), COALESCE(MAX(seq), 0) FROM file_changes WHERE session_id = ?1",
            params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        let before = q.before_seq.unwrap_or(i64::MAX);
        let mut st = c.prepare(&format!("SELECT {COLS} FROM file_changes WHERE session_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3"))?;
        let mut items = st.query_map(params![id, before, limit + 1], row)?.collect::<Result<Vec<_>, _>>()?;
        let more = items.len() > limit;
        items.truncate(limit);
        items.reverse();
        let next_before_seq = more.then(|| items[0].seq);
        // 표시한 턴의 전체 건수만 구한다. 페이지 밖의 원문·행을 내려받지 않아도 그룹 작업의 의미는 유지한다.
        let mut st = c.prepare(
            "WITH visible AS (SELECT turn_id FROM file_changes WHERE session_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3) \
             SELECT turn_id, COALESCE(SUM(stored AND undone_at IS NULL), 0), COALESCE(SUM(stored AND undone_at IS NOT NULL), 0), \
             MAX(stored AND call_id IS NULL) \
             FROM file_changes WHERE session_id = ?1 AND seq <= ?4 AND \
             (turn_id IN (SELECT turn_id FROM visible) OR (turn_id IS NULL AND EXISTS(SELECT 1 FROM visible WHERE turn_id IS NULL))) GROUP BY turn_id")?;
        let groups = st.query_map(params![id, before, limit, through_seq], |r| Ok(FileChangeGroup {
            turn_id: r.get(0)?, applied: r.get(1)?, undone: r.get(2)?,
            has_cli_snapshot: r.get::<_, bool>(3)?.then_some(true),
        }))?.collect::<Result<_, _>>()?;
        Ok(FileChangePage { items, groups, total, applied, through_seq, next_before_seq })
    }).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct ChangeGroupQuery {
    pub turn_id: Option<String>,
    pub through_seq: i64,
    pub undone: bool,
}

pub async fn group_ids(State(app): State<App>, _p: Principal, Path(id): Path<String>, Query(q): Query<ChangeGroupQuery>) -> ApiResult<Json<Vec<String>>> {
    if q.through_seq < 1 { return Err(ApiError::invalid("변경 이력 위치가 잘못되었습니다")); }
    let ids = app.db.call(move |c| {
        crate::sessions::get(c, &id)?;
        let mut st = c.prepare("SELECT id FROM file_changes WHERE session_id = ?1 AND turn_id IS ?2 AND seq <= ?3 AND stored = 1 AND (undone_at IS NOT NULL) = ?4 ORDER BY seq")?;
        Ok(st.query_map(params![id, q.turn_id, q.through_seq, q.undone], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?)
    }).await?;
    Ok(Json(ids))
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
    let sid = session_id.clone();
    let project = app.db.call(move |c| Ok(crate::sessions::get(c,&sid)?.project_id)).await?;
    let _resource = app.project_resources.ui_read(&app,&project,&_p).await?;
    let (changes, root) = app
        .db
        .call(move |c| {
            crate::sessions::get(c, &session_id)?;
            Ok((session_changes(c, &session_id)?, crate::sessions::exec_root(c, &session_id)?))
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
                let cur = resolve(&root, &path).ok().and_then(|p| read_state(&root, &p));
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

struct ApplyPlan {
    project_id: String,
    root: PathBuf,
    selected: Vec<FileChange>,
    paths: HashMap<String, PathBuf>,
}

/// 정상적인 충돌·상태 오류는 receipt 접수 전에 거부하고, 실행 직전에도 같은 검증을 한다.
fn prepare_apply(tx: &Connection, session_id: &str, ids: &[String], undo: bool) -> ApiResult<ApplyPlan> {
    let s = crate::sessions::get_active(tx, &session_id)?;
    if s.active_turn.is_some() {
        return Err(ApiError::busy("실행 중인 요청이 있어 파일 변경을 되돌릴 수 없습니다. 끝난 뒤 다시 시도하세요"));
    }
    let root = crate::sessions::exec_root(tx, &session_id)?;
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
    let mut modes: HashMap<String, Option<u32>> = HashMap::new();
    let mut abs: HashMap<String, PathBuf> = HashMap::new();
    let mut conflicts = vec![];
    let scope = crate::project_fs::ProjectFs::open(&root).map_err(|e| ApiError::invalid(e.to_string()))?;
    for c in &sel {
        let p = resolve(&root, &c.path).map_err(|e| ApiError::invalid(e.message))?;
        let (from, to, from_mode, to_mode) = if undo {
            (&c.after_sha, &c.before_sha, c.after_mode, c.before_mode)
        } else {
            (&c.before_sha, &c.after_sha, c.before_mode, c.after_mode)
        };
        if c.call_id.is_empty() {
            let expected = scope.root().join(&c.path);
            let actual = match scope.open_regular_file(&expected, true) {
                Ok(file) => file.metadata().ok().and_then(|meta| native_mode(&meta)).map(Some),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(None),
                Err(_) => None,
            };
            if p != expected || actual.is_none() || *modes.entry(c.path.clone()).or_insert(actual.flatten()) != from_mode {
                conflicts.push(json!({ "path": c.path }));
                continue;
            }
        }
        if c.call_id.is_empty() || to.is_none() { modes.insert(c.path.clone(), to_mode); }
        let cur = expect.entry(c.path.clone()).or_insert_with(|| read_state(&root, &p).map(|s| s.sha)).clone();
        abs.insert(c.path.clone(), p);
        if cur != *from {
            conflicts.push(json!({ "path": c.path, "expected_sha": from, "current_sha": cur }));
        }
        expect.insert(c.path.clone(), to.clone());
    }
    if !conflicts.is_empty() {
        return Err(ApiError::conflict("conflict", "파일이 기록 이후 바뀌어 적용하지 않았습니다. 아무 파일도 바꾸지 않았습니다")
            .with_details(json!({ "files": conflicts })));
    }
    Ok(ApplyPlan { project_id: s.project_id, root, selected: sel.into_iter().cloned().collect(), paths: abs })
}

/// 파일 작업 전 receipt를 확정한다. 최종 DB 실패·중단은 같은 키로 재실행하지 않는다.
async fn apply(app: App, p: Principal, headers: HeaderMap, session_id: String, ids: Vec<String>, undo: bool) -> ApiResult<Response> {
    if ids.is_empty() || ids.len() > 500 {
        return Err(ApiError::invalid("change_ids는 1~500개여야 합니다"));
    }
    let h = idem::body_hash(if undo { "changes.undo" } else { "changes.redo" }, &json!({ "s": session_id, "ids": ids }));
    if let Some(response) = idem::replay(&app, &p, &headers, &h).await? { return Ok(response); }
    let sid = session_id.clone();
    let project = app.db.call(move |c| Ok(crate::sessions::get_active(c,&sid)?.project_id)).await?;
    let _resource = app.project_resources.ui_write(&app,&project,&p).await?;
    let _guard = app.storage.mutations.lock().await;
    if let Some(response) = idem::replay(&app,&p,&headers,&h).await? { return Ok(response); }
    let sid = session_id.clone();
    let selected = ids.clone();
    let expected_root = app.db.call(move |c| Ok(prepare_apply(c, &sid, &selected, undo)?.root)).await?;
    let unknown = ApiError::conflict("result_unknown", "파일 변경 결과를 확정하지 못했습니다. 원문과 변경 이력을 확인하세요")
        .with_details(json!({ "session_id": session_id, "change_ids": ids, "action": if undo {"undo"} else {"redo"} }));
    let pending = unknown.body();
    idem::run(&app, &p, &headers, &h, move |_, _| Ok((StatusCode::CONFLICT, pending))).await?;
    let owner = p.root_id;
    let key = idem::key_from(&headers)?;
    let dd = app.cfg.data_dir.clone();
    let now = app.now();
    let response = app.db.call(move |c| {
        let tx = c.transaction()?;
        let plan = prepare_apply(&tx, &session_id, &ids, undo)?;
        if plan.root != expected_root {
            return Err(ApiError::conflict("project_changed", "프로젝트 경로가 변경되어 파일을 바꾸지 않았습니다"));
        }
        let scope = crate::project_fs::ProjectFs::open(&plan.root).map_err(|e| ApiError::invalid(e.to_string()))?;
        let sel = plan.selected;
        let abs = plan.paths;
        // 2) 쓰기: 실패하면 이미 쓴 파일을 원래대로 되돌린다.
        let mut done: Vec<(PathBuf, Option<Vec<u8>>, Option<u32>)> = vec![];
        for c in &sel {
            let p = &abs[&c.path];
            let (to, from_mode, to_mode) = if undo { (&c.before_sha, c.after_mode, c.before_mode) }
                else { (&c.after_sha, c.before_mode, c.after_mode) };
            let prev = scope.read(p, MAX_STORED).ok();
            let res = match to {
                None => scope.remove_file(p).map_err(|e| e.to_string()),
                Some(sha) => match get_blob(&dd, sha) {
                    None => Err("보관한 내용을 찾을 수 없습니다".to_string()),
                    Some(bytes) => (|| -> std::io::Result<()> {
                        if let Some(parent) = p.parent() {
                            scope.create_dir_all(parent)?;
                        }
                        scope.restore_file(p, &bytes, to_mode)
                    })().map_err(|e| e.to_string()),
                },
            };
            if let Err(e) = res {
                for (q, old, mode) in done.into_iter().rev() {
                    let _ = match old {
                        Some(b) => scope.restore_file(&q, &b, mode).map_err(|e| e.to_string()),
                        None => scope.remove_file(&q).map_err(|e| e.to_string()),
                    };
                }
                return Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "write_failed", format!("{}: {e} (원본과 변경 이력을 확인하세요)", c.path)));
            }
            done.push((p.clone(), prev, from_mode));
        }

        for change in &sel {
            tx.execute("UPDATE file_changes SET undone_at = ?2 WHERE id = ?1", params![change.id, if undo { Some(&now) } else { None }])?;
        }
        events::append(&tx, &now, "file_changes.updated", Some(&plan.project_id), Some(&session_id), &json!({ "session_id": session_id }))?;
        let response = json!({ "changes": session_changes(&tx, &session_id)? });
        idem::complete(&tx, &owner, &key, &h, StatusCode::OK, &response)?;
        tx.commit()?;
        Ok(response)
    }).await.map_err(|e| { tracing::warn!(code=e.code, "파일 변경 결과 불명"); unknown })?;
    app.notify_events().await;
    Ok(Json(response).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_snapshot_distinguishes_new_files_from_preexisting_untracked_content() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("grove-data");
        std::fs::create_dir(&data).unwrap();
        let ignore = root.path().join(".gitignore");
        let ignored = root.path().join("ignored.txt");
        let large = root.path().join("large.txt");
        let deleted = root.path().join("deleted.txt");
        std::fs::write(&ignore, "ignored.txt\n").unwrap();
        std::fs::write(&ignored, "existing ignored file").unwrap();
        std::fs::write(&deleted, "working file").unwrap();
        std::fs::File::create(&large).unwrap().set_len(MAX_STORED + 1).unwrap();
        std::fs::write(data.join("db.txt"), "existing database").unwrap();
        let before = WorkspaceSnapshot::capture(root.path(), &data, true).unwrap();
        std::fs::write(&ignore, "").unwrap();
        std::fs::write(&large, "now small").unwrap();
        std::fs::remove_file(deleted).unwrap();
        std::fs::write(root.path().join("new.txt"), "new file").unwrap();
        std::fs::write(data.join("db.txt"), "new database contents").unwrap();
        let after = WorkspaceSnapshot::capture(root.path(), &data, false).unwrap();
        let records = before.changes(after, root.path(), &data).unwrap();
        assert_eq!(records.iter().map(|r| (r.path.as_str(), r.before.is_some(), r.after.is_some())).collect::<Vec<_>>(),
            [(".gitignore", true, true), ("deleted.txt", true, false), ("new.txt", false, true)]);
    }

    /// 한도 초과는 내용을 읽기 전에 목록 크기로 판정한다. 읽을 수 없는 파일도 열어 보지 않고 거절한다.
    #[cfg(unix)]
    #[test]
    fn over_limit_workspace_is_rejected_before_reading_contents() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        for i in 0..=MAX_NATIVE_BYTES / MAX_STORED {
            let path = root.path().join(format!("sparse-{i}"));
            std::fs::File::create(&path).unwrap().set_len(MAX_STORED).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        }
        let error = WorkspaceSnapshot::capture(root.path(), data.path(), true).err().unwrap();
        assert_eq!(error.to_string(), "CLI 변경 이력의 용량 한도를 넘었습니다");
    }

    #[test]
    fn blob_reads_and_writes_reject_oversize_and_invalid_keys() {
        let data = tempfile::tempdir().unwrap();
        let bytes = vec![b'x'; MAX_STORED as usize + 1];
        let sha = sha256_hex(&bytes);
        let path = blob_path(data.path(), &sha);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        assert!(get_blob(data.path(), &sha).is_none(), "hash가 맞아도 보관 상한을 넘으면 읽지 않는다");
        assert!(put_blob(data.path(), &sha, &bytes).is_err());
        assert_eq!(path.metadata().unwrap().len(), bytes.len() as u64);
        assert!(get_blob(data.path(), "../../outside").is_none());
        assert!(put_blob(data.path(), "../../outside", b"x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn blob_links_and_special_files_never_expose_or_change_outside_data() {
        use std::os::unix::fs::symlink;
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let bytes = b"outside original";
        let sha = sha256_hex(bytes);
        let target = outside.path().join(&sha);
        std::fs::write(&target, bytes).unwrap();
        let path = blob_path(data.path(), &sha);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        symlink(&target, &path).unwrap();
        assert!(get_blob(data.path(), &sha).is_none());
        assert!(put_blob(data.path(), &sha, bytes).is_err());
        assert!(path.symlink_metadata().unwrap().file_type().is_symlink());
        std::fs::remove_file(&path).unwrap();
        std::fs::hard_link(&target, &path).unwrap();
        assert!(get_blob(data.path(), &sha).is_none());
        assert!(put_blob(data.path(), &sha, bytes).is_err());
        std::fs::remove_file(&path).unwrap();
        use std::os::unix::ffi::OsStrExt;
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(get_blob(data.path(), &sha).is_none());
        assert!(put_blob(data.path(), &sha, bytes).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(path.parent().unwrap()).unwrap();
        symlink(outside.path(), path.parent().unwrap()).unwrap();
        assert!(get_blob(data.path(), &sha).is_none());
        assert!(put_blob(data.path(), &sha, bytes).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
    }

    #[test]
    fn storing_a_known_original_repairs_corrupt_blob_and_refreshes_its_grace() {
        let data = tempfile::tempdir().unwrap();
        let bytes = b"known original";
        let sha = sha256_hex(bytes);
        let path = blob_path(data.path(), &sha);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"wrong original").unwrap();
        put_blob(data.path(), &sha, bytes).unwrap();
        assert_eq!(get_blob(data.path(), &sha).as_deref(), Some(bytes.as_slice()));
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
        std::fs::OpenOptions::new().write(true).open(&path).unwrap().set_modified(old).unwrap();
        put_blob(data.path(), &sha, bytes).unwrap();
        assert!(path.metadata().unwrap().modified().unwrap() > old);
    }
}
