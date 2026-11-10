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
use crate::tools::ToolError;
use crate::tools::fs::{atomic_write, file_sha, rel_display, resolve};
use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
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

fn resolve_api(root: &FsPath, rel: &str) -> ApiResult<PathBuf> {
    if rel.trim().is_empty() {
        return Err(ApiError::invalid("경로가 비어 있습니다"));
    }
    resolve(root, rel).map_err(tool_err)
}

fn io_err(e: std::io::Error, what: &str) -> ApiError {
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
pub struct Tickets(std::sync::Mutex<std::collections::HashMap<String, (String, String, std::time::Instant)>>);

const TICKET_TTL: std::time::Duration = std::time::Duration::from_secs(300);

impl Tickets {
    fn issue(&self, project_id: &str, path: &str) -> String {
        let t = crate::util::random_secret(24);
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let now = std::time::Instant::now();
        m.retain(|_, v| v.2 > now);
        m.insert(t.clone(), (project_id.to_string(), path.to_string(), now + TICKET_TTL));
        t
    }
    fn check(&self, ticket: &str) -> Option<(String, String)> {
        let m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        m.get(ticket).filter(|v| v.2 > std::time::Instant::now()).map(|v| (v.0.clone(), v.1.clone()))
    }
}

pub async fn ticket(State(app): State<App>, _p: Principal, Path(id): Path<String>, Json(q): Json<PathQuery>) -> ApiResult<Json<Value>> {
    let root = root_of(&app, &id).await?;
    let p = resolve_api(&root, &q.path)?;
    if !p.is_file() {
        return Err(ApiError::invalid("파일이 아닙니다"));
    }
    let t = app.tickets.issue(&id, &rel_display(&root, &p));
    Ok(Json(json!({ "url": format!("/api/v1/file-tickets/{t}"), "expires_in": TICKET_TTL.as_secs() })))
}

#[derive(Deserialize)]
pub struct TicketQuery {
    #[serde(default)]
    pub download: bool,
}

/// 티켓으로 여는 preview·다운로드. 인증 대신 티켓이 프로젝트·경로를 고정한다.
pub async fn by_ticket(State(app): State<App>, Path(t): Path<String>, Query(q): Query<TicketQuery>) -> ApiResult<Response> {
    let (pid, path) = app.tickets.check(&t).ok_or_else(|| ApiError::unauthorized("만료되었거나 잘못된 파일 링크입니다"))?;
    serve(&app, &pid, &path, q.download).await
}

/// preview·다운로드. 스크립트가 실행되지 않도록 sandbox CSP와 nosniff를 붙이고, HTML은 원문 텍스트로만 보낸다.
pub async fn raw(State(app): State<App>, _p: Principal, Path(id): Path<String>, Query(q): Query<RawQuery>) -> ApiResult<Response> {
    serve(&app, &id, &q.path, q.download).await
}

async fn serve(app: &App, id: &str, path: &str, download: bool) -> ApiResult<Response> {
    let q = RawQuery { path: path.to_string(), download };
    let root = root_of(app, id).await?;
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

#[derive(Deserialize)]
pub struct SaveBody {
    pub path: String,
    /// 새 파일이면 null. 기존 파일이면 사용자가 열었을 때의 sha256.
    pub expected_sha256: Option<String>,
    pub text: String,
}

pub async fn save(State(app): State<App>, _p: Principal, Path(id): Path<String>, Json(b): Json<SaveBody>) -> ApiResult<Json<Value>> {
    let root = root_of(&app, &id).await?;
    let p = resolve_api(&root, &b.path)?;
    if b.text.len() as u64 > MAX_TEXT {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "편집기로 저장할 수 있는 크기를 넘었습니다"));
    }
    let new_sha = crate::util::sha256_hex(b.text.as_bytes());
    let cur = if p.exists() { Some(file_sha(&p).map_err(|e| io_err(e, "파일 읽기"))?) } else { None };
    // 이미 같은 내용이면(재전송 등) 쓰지 않고 성공으로 수렴한다.
    if cur.as_deref() == Some(new_sha.as_str()) {
        return Ok(Json(json!({ "path": rel_display(&root, &p), "sha256": new_sha, "changed": false })));
    }
    if cur != b.expected_sha256 {
        return Err(ApiError::conflict(
            if cur.is_none() { "file_missing" } else if b.expected_sha256.is_none() { "already_exists" } else { "file_changed" },
            "편집을 시작한 뒤 파일이 바뀌었습니다. 현재 내용을 확인하세요",
        )
        .with_details(json!({ "current_sha256": cur })));
    }
    if p.parent().is_none_or(|d| !d.is_dir()) {
        return Err(ApiError::invalid("상위 폴더가 없습니다"));
    }
    atomic_write(&p, b.text.as_bytes()).map_err(tool_err)?;
    let rel = rel_display(&root, &p);
    notify(&app, &id, json!({ "op": "save", "path": rel })).await?;
    Ok(Json(json!({ "path": rel, "sha256": new_sha, "changed": true })))
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum FileOp {
    Mkdir { path: String },
    Rename { path: String, to: String },
    Duplicate { path: String, to: String },
    /// confirm에는 지울 경로를 그대로 다시 적어야 한다.
    Delete { path: String, confirm: String },
}

fn copy_recursive(from: &FsPath, to: &FsPath) -> std::io::Result<()> {
    let m = from.symlink_metadata()?;
    if m.file_type().is_symlink() {
        #[cfg(unix)]
        return std::os::unix::fs::symlink(std::fs::read_link(from)?, to);
        #[cfg(not(unix))]
        return std::fs::copy(from, to).map(|_| ());
    }
    if m.is_dir() {
        std::fs::create_dir(to)?;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            copy_recursive(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

pub async fn op(State(app): State<App>, _p: Principal, Path(id): Path<String>, Json(b): Json<FileOp>) -> ApiResult<Json<Value>> {
    let root = root_of(&app, &id).await?;
    let result = match b {
        FileOp::Mkdir { path } => {
            let p = resolve_api(&root, &path)?;
            std::fs::create_dir(&p).map_err(|e| io_err(e, "폴더 만들기"))?;
            json!({ "op": "mkdir", "path": rel_display(&root, &p) })
        }
        FileOp::Rename { path, to } => {
            let (a, z) = (resolve_api(&root, &path)?, resolve_api(&root, &to)?);
            if a == root {
                return Err(ApiError::invalid("프로젝트 root는 옮길 수 없습니다"));
            }
            a.symlink_metadata().map_err(|e| io_err(e, "원본"))?;
            if z.symlink_metadata().is_ok() {
                return Err(ApiError::conflict("already_exists", "대상 이름이 이미 있습니다. 덮어쓰지 않습니다"));
            }
            std::fs::rename(&a, &z).map_err(|e| io_err(e, "이름 바꾸기"))?;
            json!({ "op": "rename", "path": rel_display(&root, &a), "to": rel_display(&root, &z) })
        }
        FileOp::Duplicate { path, to } => {
            let (a, z) = (resolve_api(&root, &path)?, resolve_api(&root, &to)?);
            if z.symlink_metadata().is_ok() {
                return Err(ApiError::conflict("already_exists", "대상 이름이 이미 있습니다. 덮어쓰지 않습니다"));
            }
            if z.starts_with(&a) {
                return Err(ApiError::invalid("폴더를 자기 안으로 복제할 수 없습니다"));
            }
            if let Err(e) = copy_recursive(&a, &z) {
                // 부분 복제본은 우리가 만든 것이므로 정리한다.
                let _ = if z.is_dir() { std::fs::remove_dir_all(&z) } else { std::fs::remove_file(&z) };
                return Err(io_err(e, "복제"));
            }
            json!({ "op": "duplicate", "path": rel_display(&root, &a), "to": rel_display(&root, &z) })
        }
        FileOp::Delete { path, confirm } => {
            let a = resolve_api(&root, &path)?;
            let rel = rel_display(&root, &a);
            if a == root {
                return Err(ApiError::invalid("프로젝트 root는 지울 수 없습니다"));
            }
            if confirm != rel {
                return Err(ApiError::new(StatusCode::BAD_REQUEST, "confirmation_required", format!("삭제하려면 확인란에 `{rel}`을 그대로 적으세요")));
            }
            a.symlink_metadata().map_err(|e| io_err(e, "삭제 대상"))?;
            let trash = app.cfg.data_dir.join("trash").join(crate::util::new_id());
            std::fs::create_dir_all(&trash).map_err(|e| io_err(e, "휴지통"))?;
            let dest = trash.join(a.file_name().unwrap_or_default());
            std::fs::write(trash.join("origin.json"), json!({ "project_id": id, "path": rel }).to_string()).map_err(|e| io_err(e, "휴지통"))?;
            if std::fs::rename(&a, &dest).is_err() {
                // 다른 파일 시스템이면 복사가 끝난 뒤에만 원본을 지운다.
                copy_recursive(&a, &dest).map_err(|e| io_err(e, "휴지통으로 복사"))?;
                let m = a.symlink_metadata().map_err(|e| io_err(e, "삭제 대상"))?;
                if m.is_dir() { std::fs::remove_dir_all(&a) } else { std::fs::remove_file(&a) }.map_err(|e| io_err(e, "삭제"))?;
            }
            json!({ "op": "delete", "path": rel, "trash": trash.file_name().map(|n| n.to_string_lossy().to_string()) })
        }
    };
    notify(&app, &id, result.clone()).await?;
    Ok(Json(result))
}

async fn notify(app: &App, project_id: &str, data: Value) -> ApiResult<()> {
    let pid = project_id.to_string();
    let now = app.now();
    app.db
        .call(move |c| {
            events::append(c, &now, "file.changed", Some(&pid), None, &data)?;
            Ok(())
        })
        .await?;
    app.notify_events().await;
    Ok(())
}
