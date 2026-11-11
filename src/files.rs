//! 파일 탐색·편집 화면 API(FILEUI-001~006, 012).
//!
//! - 모든 경로는 `tools::fs::resolve`로 프로젝트 경계 안에서만 해석한다(symlink 탈출 차단).
//! - 저장은 sha256 revision 검사. 같은 내용 재전송은 성공으로 수렴한다.
//! - 삭제는 확인 문구가 필요하고, 실제 삭제 대신 서버 데이터 폴더의 휴지통으로 옮긴다.
//! - preview(raw)는 sandbox CSP로 스크립트 실행·외부 요청을 막는다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::idem;
use crate::tools::ToolError;
use crate::tools::fs::{atomic_write, file_sha, rel_display, resolve};
use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path as FsPath, PathBuf};

/// 편집기로 여는 텍스트 상한.
pub const MAX_TEXT: u64 = 2 * 1024 * 1024;
/// preview·다운로드 상한.
pub const MAX_RAW: u64 = 32 * 1024 * 1024;
/// 목록 상한.
const MAX_ENTRIES: usize = 5000;

fn tool_err(e: ToolError) -> ApiError {
    match e.code {
        "outside_project" | "invalid_path" => ApiError::new(StatusCode::BAD_REQUEST, e.code, e.message),
        "not_found" => ApiError::not_found(e.message),
        "permission_denied" => ApiError::new(StatusCode::FORBIDDEN, e.code, e.message),
        _ => ApiError::new(StatusCode::CONFLICT, e.code, e.message),
    }
}

async fn root_of(app: &App, project_id: &str) -> ApiResult<PathBuf> {
    let pid = project_id.to_string();
    let root = app.db.call(move |c| crate::projects::active_root(c, &pid)).await?;
    crate::util::canonical(&root).map_err(|_| ApiError::conflict("project_unavailable", "프로젝트 폴더에 접근할 수 없습니다"))
}

pub(crate) fn resolve_api(root: &FsPath, rel: &str) -> ApiResult<PathBuf> {
    if rel.trim().is_empty() {
        return Err(ApiError::invalid("경로가 비어 있습니다"));
    }
    resolve(root, rel).map_err(tool_err)
}

pub(crate) fn io_err(e: std::io::Error, what: &str) -> ApiError {
    match e.kind() {
        std::io::ErrorKind::NotFound => ApiError::not_found(format!("{what}: 없음")),
        std::io::ErrorKind::PermissionDenied => ApiError::new(StatusCode::FORBIDDEN, "permission_denied", format!("{what}: 권한 없음")),
        std::io::ErrorKind::AlreadyExists => ApiError::conflict("already_exists", format!("{what}: 이미 있습니다")),
        _ => ApiError::conflict("io_failed", format!("{what}: {e}")),
    }
}

fn mtime(m: &std::fs::Metadata) -> Option<String> {
    m.modified().ok().map(|t| crate::util::fmt_time(time::OffsetDateTime::from(t)))
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub path: Option<String>,
    #[serde(default)]
    pub hidden: bool,
    /// name | mtime | size
    pub sort: Option<String>,
}

pub async fn list(State(app): State<App>, _p: Principal, Path(id): Path<String>, Query(q): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let root = root_of(&app, &id).await?;
    let _resource = app.project_resources.ui_read(&app,&id,&_p).await?;
    let dir = resolve_api(&root, q.path.as_deref().unwrap_or("."))?;
    let rd = std::fs::read_dir(&dir).map_err(|e| io_err(e, "폴더 열기"))?;
    let mut entries = vec![];
    let mut truncated = false;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !q.hidden && name.starts_with('.') {
            continue;
        }
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let Ok(lm) = e.path().symlink_metadata() else { continue };
        let is_link = lm.file_type().is_symlink();
        // symlink는 대상이 프로젝트 안일 때만 종류를 따라간다.
        let target_ok = !is_link || resolve(&root, &e.path().to_string_lossy()).is_ok();
        let m = if is_link && target_ok { std::fs::metadata(e.path()).unwrap_or(lm.clone()) } else { lm.clone() };
        let kind = if is_link && !target_ok { "link_outside" } else if m.is_dir() { "dir" } else if m.is_file() { "file" } else { "other" };
        entries.push(json!({
            "name": name,
            "path": rel_display(&root, &dir.join(&name)),
            "kind": kind,
            "symlink": is_link,
            "size": if m.is_file() { Some(m.len()) } else { None },
            "mtime": mtime(&m),
        }));
    }
    let key = q.sort.as_deref().unwrap_or("name");
    entries.sort_by(|a, b| {
        let dir_first = (b["kind"] == "dir").cmp(&(a["kind"] == "dir"));
        dir_first.then_with(|| match key {
            "mtime" => b["mtime"].as_str().cmp(&a["mtime"].as_str()),
            "size" => b["size"].as_u64().cmp(&a["size"].as_u64()),
            _ => a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase()),
        })
    });
    Ok(Json(json!({ "path": rel_display(&root, &dir), "entries": entries, "truncated": truncated })))
}

#[derive(Deserialize)]
pub struct PathQuery {
    pub path: String,
}

fn preview_kind(p: &FsPath) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico") => "image",
        Some("svg") => "svg",
        Some("pdf") => "pdf",
        Some("html" | "htm") => "html",
        _ => "text",
    }
}

pub async fn content(State(app): State<App>, _p: Principal, Path(id): Path<String>, Query(q): Query<PathQuery>) -> ApiResult<Json<Value>> {
    let root = root_of(&app, &id).await?;
    let _resource = app.project_resources.ui_read(&app,&id,&_p).await?;
    let p = resolve_api(&root, &q.path)?;
    let m = std::fs::metadata(&p).map_err(|e| io_err(e, "파일"))?;
    if !m.is_file() {
        return Err(ApiError::invalid("파일이 아닙니다"));
    }
    let sha = file_sha(&p).map_err(|e| io_err(e, "파일 읽기"))?;
    let kind = preview_kind(&p);
    let base = json!({ "path": rel_display(&root, &p), "size": m.len(), "mtime": mtime(&m), "sha256": sha, "preview": kind });
    if m.len() > MAX_TEXT || matches!(kind, "image" | "pdf") {
        let mut v = base;
        v["text"] = Value::Null;
        v["reason"] = json!(if m.len() > MAX_TEXT { "too_large" } else { "binary" });
        return Ok(Json(v));
    }
    let bytes = std::fs::read(&p).map_err(|e| io_err(e, "파일 읽기"))?;
    let mut v = base;
    match String::from_utf8(bytes) {
        Ok(t) if !t.contains('\0') => v["text"] = json!(t),
        _ => {
            v["text"] = Value::Null;
            v["reason"] = json!("binary");
        }
    }
    Ok(Json(v))
}

/// `<img>`·새 탭처럼 Authorization 헤더를 보낼 수 없는 요청용 단기 티켓(FILEUI-005).
/// 프로젝트·경로 하나에만 유효하고 5분 뒤 만료된다. 프로세스 메모리에만 있어 재시작하면 사라진다.
#[derive(Default)]
pub struct Tickets(std::sync::Mutex<std::collections::HashMap<String, (String, String, std::time::Instant, Principal)>>);

const TICKET_TTL: std::time::Duration = std::time::Duration::from_secs(300);

impl Tickets {
    fn issue(&self, project_id: &str, path: &str, principal: Principal) -> String {
        let t = crate::util::random_secret(24);
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let now = std::time::Instant::now();
        m.retain(|_, v| v.2 > now);
        m.insert(t.clone(), (project_id.to_string(), path.to_string(), now + TICKET_TTL, principal));
        t
    }
    fn check(&self, ticket: &str) -> Option<(String, String, Principal)> {
        let m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        m.get(ticket).filter(|v| v.2 > std::time::Instant::now()).map(|v| (v.0.clone(), v.1.clone(), v.3.clone()))
    }
}

pub async fn ticket(State(app): State<App>, principal: Principal, Path(id): Path<String>, Json(q): Json<PathQuery>) -> ApiResult<Json<Value>> {
    let root = root_of(&app, &id).await?;
    let _resource = app.project_resources.ui_read(&app,&id,&principal).await?;
    let p = resolve_api(&root, &q.path)?;
    if !p.is_file() {
        return Err(ApiError::invalid("파일이 아닙니다"));
    }
    let t = app.tickets.issue(&id, &rel_display(&root, &p), principal);
    Ok(Json(json!({ "url": format!("/api/v1/file-tickets/{t}"), "expires_in": TICKET_TTL.as_secs() })))
}

#[derive(Deserialize)]
pub struct TicketQuery {
    #[serde(default)]
    pub download: bool,
}

/// 티켓으로 여는 preview·다운로드. 인증 대신 티켓이 프로젝트·경로를 고정한다.
pub async fn by_ticket(State(app): State<App>, Path(t): Path<String>, Query(q): Query<TicketQuery>) -> ApiResult<Response> {
    let (pid, path, principal) = app.tickets.check(&t).ok_or_else(|| ApiError::unauthorized("만료되었거나 잘못된 파일 링크입니다"))?;
    crate::auth::revalidate(&app, &principal).await?;
    serve(&app, &pid, &path, q.download,&principal).await
}

/// preview·다운로드. 스크립트가 실행되지 않도록 sandbox CSP와 nosniff를 붙이고, HTML은 원문 텍스트로만 보낸다.
pub async fn raw(State(app): State<App>, _p: Principal, Path(id): Path<String>, Query(q): Query<RawQuery>) -> ApiResult<Response> {
    serve(&app, &id, &q.path, q.download,&_p).await
}

async fn serve(app: &App, id: &str, path: &str, download: bool, principal: &Principal) -> ApiResult<Response> {
    let q = RawQuery { path: path.to_string(), download };
    let root = root_of(app, id).await?;
    let _resource = app.project_resources.ui_read(app,id,principal).await?;
    let p = resolve_api(&root, &q.path)?;
    let m = std::fs::metadata(&p).map_err(|e| io_err(e, "파일"))?;
    if !m.is_file() {
        return Err(ApiError::invalid("파일이 아닙니다"));
    }
    if m.len() > MAX_RAW {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", format!("{}바이트를 넘는 파일은 보낼 수 없습니다", MAX_RAW)));
    }
    let bytes = std::fs::read(&p).map_err(|e| io_err(e, "파일 읽기"))?;
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let ctype = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ if q.download => "application/octet-stream",
        _ => "text/plain; charset=utf-8",
    };
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let mut r = Response::new(Body::from(bytes));
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(ctype));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    let disp = if q.download { "attachment" } else { "inline" };
    let encoded: String = name.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    if let Ok(v) = HeaderValue::from_str(&format!("{disp}; filename*=UTF-8''{encoded}")) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    Ok(r.into_response())
}

#[derive(Deserialize)]
pub struct RawQuery {
    pub path: String,
    #[serde(default)]
    pub download: bool,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SaveBody {
    pub path: String,
    /// 새 파일이면 null. 기존 파일이면 사용자가 열었을 때의 sha256.
    pub expected_sha256: Option<String>,
    pub text: String,
}

pub async fn save(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<SaveBody>) -> ApiResult<Response> {
    mutate(app, p, headers, id, FileMutation::Save(b)).await
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum FileOp {
    Mkdir { path: String },
    Rename { path: String, to: String },
    Duplicate { path: String, to: String },
    /// confirm에는 지울 경로를 그대로 다시 적어야 한다.
    Delete { path: String, confirm: String },
}

pub(crate) fn copy_recursive(from: &FsPath, to: &FsPath) -> std::io::Result<()> {
    let m = from.symlink_metadata()?;
    if m.file_type().is_symlink() {
        #[cfg(unix)]
        return std::os::unix::fs::symlink(std::fs::read_link(from)?, to);
        #[cfg(not(unix))]
        return std::fs::copy(from, to).map(|_| ());
    }
    if m.is_dir() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            // 복사 도중에도 비공개 폴더의 내용이 다른 사용자에게 노출되지 않게 한다.
            std::fs::DirBuilder::new().mode(0o700).create(to)?;
        }
        #[cfg(not(unix))]
        std::fs::create_dir(to)?;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            copy_recursive(&e.path(), &to.join(e.file_name()))?;
        }
        #[cfg(unix)]
        std::fs::set_permissions(to, m.permissions())?;
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

pub async fn op(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<FileOp>) -> ApiResult<Response> {
    if let FileOp::Delete { path, confirm } = b {
        return crate::storage::move_to_trash(app, p, headers, id, path, confirm).await;
    }
    mutate(app, p, headers, id, FileMutation::Op(b)).await
}

#[derive(Clone, Serialize)]
enum FileMutation {
    Save(SaveBody),
    Op(FileOp),
}

enum FileWork {
    Save(PathBuf, Vec<u8>),
    Mkdir(PathBuf),
    Rename(PathBuf, PathBuf),
    Duplicate { from: PathBuf, to: PathBuf, stage: PathBuf },
}

struct FilePlan {
    work: Option<FileWork>,
    response: Value,
    event: Option<Value>,
}

fn require_absent(path: &FsPath) -> ApiResult<()> {
    match path.symlink_metadata() {
        Ok(_) => Err(ApiError::conflict("already_exists", "대상 이름이 이미 있습니다. 덮어쓰지 않습니다")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err(e, "대상 확인")),
    }
}

fn prepare_mutation(root: &FsPath, mutation: &FileMutation, copy_id: &str) -> ApiResult<FilePlan> {
    let (work, response, event) = match mutation {
        FileMutation::Save(b) => {
            let p = resolve_api(root, &b.path)?;
            if b.text.len() as u64 > MAX_TEXT {
                return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "편집기로 저장할 수 있는 크기를 넘었습니다"));
            }
            let new_sha = crate::util::sha256_hex(b.text.as_bytes());
            let cur = if p.exists() { Some(file_sha(&p).map_err(|e| io_err(e, "파일 읽기"))?) } else { None };
            let rel = rel_display(root, &p);
            if cur.as_deref() == Some(new_sha.as_str()) {
                return Ok(FilePlan { work: None, response: json!({"path":rel,"sha256":new_sha,"changed":false}), event: None });
            }
            if cur != b.expected_sha256 {
                return Err(ApiError::conflict(
                    if cur.is_none() { "file_missing" } else if b.expected_sha256.is_none() { "already_exists" } else { "file_changed" },
                    "편집을 시작한 뒤 파일이 바뀌었습니다. 현재 내용을 확인하세요",
                ).with_details(json!({"current_sha256":cur})));
            }
            if p.parent().is_none_or(|d| !d.is_dir()) {
                return Err(ApiError::invalid("상위 폴더가 없습니다"));
            }
            (FileWork::Save(p, b.text.as_bytes().to_vec()), json!({"path":rel,"sha256":new_sha,"changed":true}), json!({"op":"save","path":rel}))
        }
        FileMutation::Op(FileOp::Mkdir { path }) => {
            let p = resolve_api(root, path)?;
            require_absent(&p)?;
            let result = json!({"op":"mkdir","path":rel_display(root, &p)});
            (FileWork::Mkdir(p), result.clone(), result)
        }
        FileMutation::Op(FileOp::Rename { path, to } | FileOp::Duplicate { path, to }) => {
            let (a, z) = (resolve_api(root, path)?, resolve_api(root, to)?);
            a.symlink_metadata().map_err(|e| io_err(e, "원본"))?;
            require_absent(&z)?;
            if matches!(mutation, FileMutation::Op(FileOp::Rename { .. })) {
                if a == root { return Err(ApiError::invalid("프로젝트 root는 옮길 수 없습니다")); }
                let result = json!({"op":"rename","path":rel_display(root,&a),"to":rel_display(root,&z)});
                (FileWork::Rename(a, z), result.clone(), result)
            } else {
                if z.starts_with(&a) { return Err(ApiError::invalid("폴더를 자기 안으로 복제할 수 없습니다")); }
                let parent = z.parent().filter(|p| p.is_dir()).ok_or_else(|| ApiError::invalid("상위 폴더가 없습니다"))?;
                let stage = parent.join(format!(".grove-copy-{copy_id}"));
                require_absent(&stage)?;
                let result = json!({"op":"duplicate","path":rel_display(root,&a),"to":rel_display(root,&z)});
                (FileWork::Duplicate { from: a, to: z, stage }, result.clone(), result)
            }
        }
        FileMutation::Op(FileOp::Delete { .. }) => unreachable!("삭제는 휴지통 경로에서 처리"),
    };
    Ok(FilePlan { work: Some(work), response, event: Some(event) })
}

fn execute_mutation(work: FileWork) -> ApiResult<()> {
    match work {
        FileWork::Save(p, bytes) => atomic_write(&p, &bytes).map_err(tool_err),
        FileWork::Mkdir(p) => std::fs::create_dir(p).map_err(|e| io_err(e, "폴더 만들기")),
        FileWork::Rename(a, z) => crate::storage::rename_noreplace(&a, &z).map_err(|e| io_err(e, "이름 바꾸기")),
        FileWork::Duplicate { from, to, stage } => {
            #[cfg(unix)]
            let created = {
                use std::os::unix::fs::DirBuilderExt;
                std::fs::DirBuilder::new().mode(0o700).create(&stage)
            };
            #[cfg(not(unix))]
            let created = std::fs::create_dir(&stage);
            created.map_err(|e| io_err(e, "복제 임시 폴더"))?;
            // 소유한 staging 안에서만 복사한다. 외부에서 만든 대상은 rename 시에도 덮어쓰지 않는다.
            let result = copy_recursive(&from, &stage.join("payload"))
                .and_then(|_| crate::storage::rename_noreplace(&stage.join("payload"), &to));
            let cleanup = std::fs::remove_dir_all(&stage);
            result.map_err(|e| io_err(e, "복제"))?;
            cleanup.map_err(|e| io_err(e, "복제 임시 폴더 정리"))
        }
    }
}

async fn mutate(app: App, p: Principal, headers: HeaderMap, id: String, mutation: FileMutation) -> ApiResult<Response> {
    let h = idem::body_hash("files.mutate", &json!({"project_id":id,"request":mutation}));
    if let Some(response) = idem::replay(&app, &p, &headers, &h).await? { return Ok(response); }
    let _resource = app.project_resources.ui_write(&app,&id,&p).await?;
    let _guard = app.storage.mutations.lock().await;
    if let Some(response) = idem::replay(&app,&p,&headers,&h).await? { return Ok(response); }
    let (pid, input, copy_id) = (id.clone(), mutation.clone(), crate::util::new_id());
    let staging_id = copy_id.clone();
    let (root, mut details) = app.db.call(move |c| {
        let root = crate::projects::active_root(c, &pid)?;
        let root = crate::util::canonical(&root).map_err(|_| ApiError::conflict("project_unavailable", "프로젝트 폴더에 접근할 수 없습니다"))?;
        let plan = prepare_mutation(&root, &input, &copy_id)?;
        let mut details = plan.event.unwrap_or_else(|| json!({"op":"save","path":plan.response["path"]}));
        if let Some(FileWork::Duplicate { stage, .. }) = plan.work { details["staging"] = json!(rel_display(&root, &stage)); }
        Ok((root, details))
    }).await?;
    details["project_id"] = json!(id);
    let unknown = ApiError::conflict("result_unknown", "파일 작업 결과를 확정하지 못했습니다. 원문과 대상 경로를 확인하세요").with_details(details);
    let pending = unknown.body();
    let (pid, expected_root) = (id.clone(), root.clone());
    idem::run(&app, &p, &headers, &h, move |tx, _| {
        if crate::projects::active_root(tx, &pid)? != expected_root {
            return Err(ApiError::conflict("project_changed", "프로젝트 경로가 변경되어 파일을 바꾸지 않았습니다"));
        }
        Ok((StatusCode::CONFLICT, pending))
    }).await?;
    let (owner, key, now) = (p.root_id, idem::key_from(&headers)?, app.now());
    let response = app.db.call(move |c| {
        let tx = c.transaction()?;
        if crate::projects::active_root(&tx, &id)? != root {
            return Err(ApiError::conflict("project_changed", "프로젝트 경로가 변경되어 파일을 바꾸지 않았습니다"));
        }
        // 접수 이후 원문·대상 경로를 다시 확인한다. DB 잠금 안에서 경로 변경과 완료 기록을 직렬화한다.
        let plan = prepare_mutation(&root, &mutation, &staging_id)?;
        if let Some(work) = plan.work { execute_mutation(work)?; }
        if let Some(event) = plan.event { events::append(&tx, &now, "file.changed", Some(&id), None, &event)?; }
        idem::complete(&tx, &owner, &key, &h, StatusCode::OK, &plan.response)?;
        tx.commit()?;
        Ok(plan.response)
    }).await.map_err(|e| { tracing::warn!(code=e.code, "파일 작업 결과 불명"); unknown })?;
    app.notify_events().await;
    Ok(Json(response).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_preserves_a_target_created_after_preparation_and_cleans_only_its_stage() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("copy");
        let stage = root.path().join(".grove-copy-fixture");
        std::fs::write(&source, "original").unwrap();
        let mutation = FileMutation::Op(FileOp::Duplicate { path: "source".into(), to: "copy".into() });
        let plan = prepare_mutation(root.path(), &mutation, "fixture").unwrap();
        std::fs::write(&target, "external edit").unwrap();
        assert!(execute_mutation(plan.work.unwrap()).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
        assert_eq!(std::fs::read(&target).unwrap(), b"external edit");
        assert!(!stage.exists());
        // 존재하는 외부 staging은 소유하지 않으므로 생성 실패 뒤 정리하지 않는다.
        std::fs::create_dir(&stage).unwrap();
        std::fs::write(stage.join("foreign"), "keep").unwrap();
        assert!(execute_mutation(FileWork::Duplicate { from: source, to: target, stage: stage.clone() }).is_err());
        assert_eq!(std::fs::read(stage.join("foreign")).unwrap(), b"keep");
    }
}
