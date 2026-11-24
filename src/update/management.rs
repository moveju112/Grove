//! 프록시·공개 포트의 정책을 우회하지 않고 계정 전용 소켓에서 updater 요청만 받는다.
use super::*;
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};

pub(super) fn socket_path(inst: &Install) -> Option<PathBuf> {
    let path = PathBuf::from(std::fs::read_to_string(inst.root.join("management-socket")).ok()?);
    let dir = path.parent()?.symlink_metadata().ok()?;
    if !dir.is_dir() || dir.uid() != unsafe { libc::geteuid() } || dir.mode() & 0o077 != 0 { return None; }
    path.symlink_metadata().ok()?.file_type().is_socket().then_some(path)
}

async fn owner(State(app): State<crate::App>, mut request: Request, next: Next) -> Response {
    match crate::auth::authenticate_request(&app, request.headers(), true).await {
        Ok(p) if p.kind == "owner" => {
            request.extensions_mut().insert(p);
            next.run(request).await
        }
        _ => crate::error::ApiError::forbidden("로컬 업데이트 자격이 필요합니다").into_response(),
    }
}

pub(crate) fn listen(inst: &Install, app: crate::App) -> Result<tokio::task::JoinHandle<()>, String> {
    // 설치 경로 길이와 무관하게 Unix 소켓 주소 한도 안에 둔다.
    let dir = tempfile::Builder::new().prefix("grove-updater-").tempdir_in("/tmp").map_err(|e| e.to_string())?;
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    let path = dir.path().join("daemon.sock");
    let listener = tokio::net::UnixListener::bind(&path).map_err(|e| e.to_string())?;
    let mut shutdown = app.shutdown_rx.clone();
    let routes = axum::Router::new()
        .route("/api/v1/projects", get(crate::projects::list))
        .route("/api/v1/admin/update-readiness", get(crate::admin::readiness))
        .route("/api/v1/admin/shutdown-if-idle", post(crate::admin::shutdown_if_idle))
        .route("/api/v1/admin/shutdown", post(crate::admin::shutdown))
        .route("/api/v1/admin/update-receipts/import", post(crate::admin::import_receipts))
        .route_layer(axum::middleware::from_fn_with_state(app.clone(), owner))
        .route("/api/v1/health", get(crate::web::health))
        .with_state(app);
    write_atomic(&inst.root.join("management-socket"), path.as_os_str().as_encoded_bytes())?;
    Ok(tokio::spawn(async move {
        let _dir = dir;
        if let Err(error) = axum::serve(listener, routes).with_graceful_shutdown(async move {
            let _ = shutdown.wait_for(|closing| *closing).await;
        }).await {
            tracing::warn!(%error, "데몬 업데이트 소켓 종료");
        }
    }))
}
