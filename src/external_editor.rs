//! PC에서만 제공하는 외부 편집기. 클라이언트는 고정 ID와 프로젝트 상대 경로만 지정한다.

use crate::{App, auth::Principal, error::{ApiError, ApiResult}, files::{io_err, resolve_api}, idem, project_fs::ProjectFs};
use axum::{Json, extract::{ConnectInfo, Path, State}, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{net::SocketAddr, path::{Component, Path as FsPath, PathBuf}, process::{Command, Stdio}};

#[derive(Clone, Serialize, ts_rs::TS)]
#[ts(rename = "ExternalEditorInfo")]
pub struct Editor {
    pub id: &'static str,
    pub name: &'static str,
    #[serde(skip)]
    #[ts(skip)]
    executable: PathBuf,
}

#[derive(Serialize, ts_rs::TS)]
#[ts(rename = "ExternalEditorListing")]
pub struct Listing {
    pub available: bool,
    pub reason: Option<String>,
    pub editors: Vec<Editor>,
}

const CANDIDATES: &[(&str, &str, &str)] = &[
    ("vscode", "VS Code", "code"),
    ("cursor", "Cursor", "cursor"),
    ("zed", "Zed", "zed"),
    ("idea", "IntelliJ IDEA", "idea"),
    ("webstorm", "WebStorm", "webstorm"),
    ("pycharm", "PyCharm", "pycharm"),
    ("clion", "CLion", "clion"),
    ("rustrover", "RustRover", "rustrover"),
];

fn executable(path: &FsPath) -> bool {
    let Ok(meta) = path.metadata() else { return false };
    if !meta.is_file() { return false; }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 { return false; }
    }
    true
}

fn discover() -> Vec<Editor> {
    let paths: Vec<_> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).filter(|p| p.is_absolute()).collect()).unwrap_or_default();
    CANDIDATES.iter().filter_map(|&(id, name, command)| {
        #[cfg(windows)]
        let command = format!("{command}.exe");
        #[allow(unused_mut)]
        let mut candidates: Vec<PathBuf> = paths.iter().map(|p| p.join(&command)).collect();
        #[cfg(windows)]
        {
            // Windows의 code.cmd/cursor.cmd는 shell 없이 실행할 수 없으므로 설치된 본체만 후보로 둔다.
            if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).filter(|p| p.is_absolute()) {
                let installed = match id {
                    "vscode" => Some("Programs/Microsoft VS Code/Code.exe"),
                    "cursor" => Some("Programs/cursor/Cursor.exe"),
                    "zed" => Some("Programs/Zed/zed.exe"),
                    _ => None,
                };
                if let Some(installed) = installed { candidates.push(local.join(installed)); }
            }
            if id == "vscode" {
                for key in ["ProgramFiles", "ProgramFiles(x86)"] {
                    if let Some(root) = std::env::var_os(key).map(PathBuf::from).filter(|p| p.is_absolute()) {
                        candidates.push(root.join("Microsoft VS Code/Code.exe"));
                    }
                }
            }
        }
        #[cfg(target_os = "macos")]
        {
            let (bundle, binary) = match id {
                "vscode" => ("Visual Studio Code", "Resources/app/bin/code"),
                "cursor" => ("Cursor", "Resources/app/bin/cursor"),
                "zed" => ("Zed", "MacOS/zed"),
                "idea" => ("IntelliJ IDEA", "MacOS/idea"),
                "webstorm" => ("WebStorm", "MacOS/webstorm"),
                "pycharm" => ("PyCharm", "MacOS/pycharm"),
                "clion" => ("CLion", "MacOS/clion"),
                _ => ("RustRover", "MacOS/rustrover"),
            };
            candidates.push(PathBuf::from(format!("/Applications/{bundle}.app/Contents/{binary}")));
        }
        // canonicalize로 실행 시점의 cwd/PATH 해석에 의존하지 않는다.
        candidates.into_iter().find(|p| executable(p)).and_then(|p| std::fs::canonicalize(p).ok())
            .map(|executable| Editor { id, name, executable })
    }).collect()
}

fn has_gui() -> bool {
    if std::env::var_os("SSH_CONNECTION").is_some() || std::env::var_os("SSH_TTY").is_some() { return false; }
    #[cfg(target_os = "linux")]
    {
        return ["DISPLAY", "WAYLAND_DISPLAY"].iter().any(|key| std::env::var_os(key).is_some_and(|v| !v.is_empty()));
    }
    #[cfg(windows)]
    {
        // Session 0(서비스)와 접근할 수 없는 input desktop에서는 실행하지 않는다.
        #[link(name = "user32")]
        unsafe extern "system" {
            fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> *mut std::ffi::c_void;
            fn CloseDesktop(desktop: *mut std::ffi::c_void) -> i32;
        }
        let mut session = 0;
        unsafe {
            use windows_sys::Win32::System::{Threading::GetCurrentProcessId, RemoteDesktop::ProcessIdToSessionId};
            if ProcessIdToSessionId(GetCurrentProcessId(), &mut session) == 0 || session == 0 { return false; }
            let desktop = OpenInputDesktop(0, 0, 0x0001);
            if desktop.is_null() { return false; }
            CloseDesktop(desktop);
        }
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        #[link(name = "ApplicationServices", kind = "framework")]
        unsafe extern "C" { fn CGSessionCopyCurrentDictionary() -> *const std::ffi::c_void; }
        #[link(name = "CoreFoundation", kind = "framework")]
        unsafe extern "C" { fn CFRelease(value: *const std::ffi::c_void); }
        unsafe {
            let session = CGSessionCopyCurrentDictionary();
            if session.is_null() { return false; }
            CFRelease(session);
        }
        return true;
    }
    #[allow(unreachable_code)]
    false
}

fn local_request(app: &App, peer: Option<SocketAddr>, headers: &HeaderMap) -> bool {
    // 프록시·공개 listen·원격 호스트는 loopback 프록시를 거쳐도 PC로 판단하지 않는다.
    // 암호화 전송처럼 직접 연결 정보가 없는 요청도 로컬 PC로 간주하지 않는다.
    if !app.cfg.listen.ip().is_loopback() || app.cfg.tls_terminated || !peer.is_some_and(|p| p.ip().is_loopback())
        || ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"].iter().any(|h| headers.contains_key(*h)) {
        return false;
    }
    let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<axum::http::uri::Authority>().ok()) else { return false };
    let host = host.host().trim_start_matches('[').trim_end_matches(']');
    let local = host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
    let ua = headers.get("user-agent").and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    local && !["mobile", "android", "iphone", "ipad", "ipod"].iter().any(|s| ua.contains(s))
}

fn listing(app: &App, peer: Option<SocketAddr>, headers: &HeaderMap) -> Listing {
    let reason = if !local_request(app, peer, headers) {
        Some("외부 편집기는 서버 PC의 로컬 데스크톱에서만 사용할 수 있습니다.")
    } else if !has_gui() {
        Some("서버 사용자에게 GUI 세션이 없어 외부 편집기를 사용할 수 없습니다.")
    } else { None };
    if let Some(reason) = reason {
        return Listing { available: false, reason: Some(reason.into()), editors: vec![] };
    }
    let editors = discover();
    Listing {
        available: !editors.is_empty(),
        reason: editors.is_empty().then(|| "설치된 지원 편집기를 찾지 못했습니다. 편집기 CLI를 PATH에 등록하세요.".into()),
        editors,
    }
}

pub async fn list(State(app): State<App>, _p: Principal, peer: Result<ConnectInfo<SocketAddr>, axum::extract::rejection::ExtensionRejection>, headers: HeaderMap) -> Json<Listing> {
    Json(listing(&app, peer.ok().map(|p| p.0), &headers))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpenBody {
    pub editor_id: String,
    pub path: String,
}

fn file_path(root: &FsPath, rel: &str) -> ApiResult<PathBuf> {
    // resolve_api는 내부 symlink를 실제 경로로 정규화하고 외부 symlink를 거절한다.
    if !FsPath::new(rel).components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
        || FsPath::new(rel).is_absolute() || rel.contains('\\') {
        return Err(ApiError::invalid("프로젝트 상대 파일 경로만 사용할 수 있습니다"));
    }
    let path = resolve_api(root, rel)?;
    let scope = ProjectFs::open(root).map_err(|e| io_err(e, "프로젝트 열기"))?;
    let _file = scope.open_file(&path).map_err(|e| io_err(e, "파일 열기"))?;
    Ok(path)
}

fn launch(editor: &Editor, root: &FsPath, rel: &str) -> ApiResult<()> {
    let path = file_path(root, rel)?;
    let mut command = Command::new(&editor.executable);
    command.arg(&path).current_dir(root).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 터미널·서버의 프로세스 그룹과 분리한다. 사용자 파일을 shell에 전달하지 않는다.
        unsafe { command.pre_exec(|| if libc::setsid() == -1 { Err(std::io::Error::last_os_error()) } else { Ok(()) }); }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000008 | 0x00000200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    let mut child = command.spawn().map_err(|_| ApiError::conflict("editor_launch_failed", "편집기를 실행하지 못했습니다. 설치와 실행 권한을 확인하세요."))?;
    // HTTP 요청은 종료를 기다리지 않는다. Unix zombie는 백그라운드에서 회수한다.
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

pub async fn open(
    State(app): State<App>, p: Principal, peer: Result<ConnectInfo<SocketAddr>, axum::extract::rejection::ExtensionRejection>,
    headers: HeaderMap, Path(id): Path<String>, Json(body): Json<OpenBody>,
) -> ApiResult<Response> {
    let hash = idem::body_hash("external_editor.open", &json!({"project_id":id,"request":body}));
    let _resource = app.project_resources.ui_write(&app, &id, &p).await?;
    let available = listing(&app, peer.ok().map(|p| p.0), &headers);
    if !available.available {
        return Err(ApiError::forbidden(available.reason.unwrap_or_default()));
    }
    let editor = available.editors.into_iter().find(|e| e.id == body.editor_id)
        .ok_or_else(|| ApiError::invalid("설치된 편집기 ID를 선택하세요"))?;
    let pid = id.clone();
    let root = app.db.call(move |c| crate::projects::active_root(c, &pid)).await?;
    if let Some(response) = idem::replay(&app, &p, &headers, &hash).await? { return Ok(response); }
    file_path(&root, &body.path)?;
    let unknown = ApiError::conflict("result_unknown", "편집기 실행 결과를 확인하지 못했습니다. 서버 PC에서 확인하세요.");
    let pending = unknown.body();
    idem::run(&app, &p, &headers, &hash, move |_, _| Ok((StatusCode::CONFLICT, pending))).await?;
    let (owner, key) = (p.root_id, idem::key_from(&headers)?);
    let result = app.db.call(move |c| {
        let tx = c.transaction()?;
        if crate::projects::active_root(&tx, &id)? != root {
            return Err(ApiError::conflict("project_changed", "프로젝트 경로가 변경되어 편집기를 열지 않았습니다"));
        }
        let (status, result) = match launch(&editor, &root, &body.path) {
            Ok(()) => (StatusCode::ACCEPTED, json!({"launched":true})),
            Err(e) => (e.status, e.body()),
        };
        idem::complete(&tx, &owner, &key, &hash, status, &result)?;
        tx.commit()?;
        Ok((status, result))
    }).await;
    match result {
        Ok((status, body)) => Ok((status, Json(body)).into_response()),
        Err(_) => Err(unknown),
    }
}
