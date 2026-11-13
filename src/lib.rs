//! Grove 서버 라이브러리. 실행 파일 `grove`는 `cli::run`만 호출한다.
//!
//! 모듈 경계(설계 문서 §6): 하위 모듈은 상위 모듈을 import하지 않는다.

pub mod agents;
pub mod attachments;
pub mod source_settings;
pub mod skills;
pub mod approvals;
mod project_fs;
pub mod auth;
pub mod backup;
pub mod cli;
pub mod exec;
mod logging;
pub mod runner;
pub mod server;
pub mod config;
pub mod deps;
pub mod context;
pub mod recall;
pub mod memories;
mod history;
pub mod definitions;
pub mod error;
pub mod events;
pub mod files;
pub mod git;
pub mod followups;
pub mod goals;
pub mod idem;
pub mod model_capabilities;
pub mod model_limits;
pub mod model_headers;
pub mod models;
pub mod changes;
pub mod procs;
pub mod project_resources;
pub mod storage;
pub mod labels;
pub mod mcp;
pub mod projects;
pub mod repos;
pub mod provider;
pub mod tools;
pub mod sessions;
pub mod settings;
pub mod store;
pub mod tasks;
mod task_logs;
pub mod admin;
pub mod bot_avatars;
pub mod bots;
pub mod notifications;
pub mod schedules;
pub mod remote_watches;
pub mod terminals;
mod terminal_capture;
pub mod titles;
pub mod audit;
pub mod fair;
pub mod import;
pub mod update;
pub mod vault;
pub mod usage;
pub mod util;
pub mod web;
pub mod workspace;
pub mod worktrees;
pub mod pairing;
pub mod project_scripts;

use axum::Router;
use axum::routing::{get, post, put};
use std::sync::Arc;
use tokio::sync::watch;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// 클라이언트·서버 공용 프로토콜 버전. 호환되지 않는 변경 시 올린다(NET-001, NET-025).
pub const PROTOCOL_VERSION: u32 = 1;

/// 같은 protocol 안에서 추가된 기능 목록(NET-001). health·이벤트 `hello`·`grove version --json`이 같은 목록을 알린다.
/// 클라이언트는 쓰기 전에 목록을 확인하고, 변경 요청에는 필요한 기능을 `x-grove-require`로 밝힌다.
/// 기능을 빼거나 의미를 바꾸면 이름의 버전(`_v2`)을 올린다.
pub const CAPABILITIES: &[&str] = &[
    "file_log_rotation_v1",
    "diagnostics_bundle_v1",
    "file_changes_v1",
    "trash_v1",
    "attachments_v1",
    "task_logs_v1",
    "worktrees_v1",
    "dependency_hints_v1",
    "pairing_v1",
    "notification_delivery_v1",
    "model_management_v1",
    "model_capabilities_v1",
    "context_auto_clear_v1",
    "recall_keyword_v1",
    "user_memories_v1",
    "model_session_access_v1",
    "private_model_headers_v1",
    "project_scripts_v1",
    "terminal_capture_v1",
    "settings_reset_v1",
    "mcp_settings_v1",
    "mcp_check_v1",
    "mcp_tools_v1",
];

#[derive(Clone)]
pub struct App {
    pub cfg: Arc<config::Config>,
    pub db: store::Db,
    pub clock: util::SharedClock,
    pub access: Arc<auth::AccessTokens>,
    pub auth_tx: Arc<watch::Sender<()>>,
    pub partials: Arc<events::Partials>,
    pub cancels: Arc<runner::Cancels>,
    pub fair: fair::Fair,
    pub repo_locks: Arc<git::RepoLocks>,
    pub project_resources: Arc<project_resources::ProjectResources>,
    pub tickets: Arc<files::Tickets>,
    pub tasks: Arc<tasks::Tasks>,
    pub terminals: Arc<terminals::Terminals>,
    pub storage: Arc<storage::Storage>,
    pub seq_tx: Arc<watch::Sender<i64>>,
    pub shutdown_tx: Arc<watch::Sender<bool>>,
    pub shutdown_rx: watch::Receiver<bool>,
    /// 관리 API의 종료 요청(업데이트 도구가 OS와 무관하게 정상 종료시킬 때). serve가 신호처럼 처리한다.
    pub exit_tx: Arc<watch::Sender<bool>>,
    /// 이 서버 프로세스의 실행 소유권 epoch. 재시작 후 이전 epoch의 실행은 중단으로 판정한다.
    pub epoch: String,
}

impl App {
    pub fn new(cfg: config::Config, clock: util::SharedClock) -> Result<Self, store::anyhow_like::Error> {
        std::fs::create_dir_all(&cfg.data_dir)?;
        let db = store::Db::open(&cfg.db_path())?;
        // 이전 버전의 평문 비밀정보를 암호화한다(SEC-019).
        db.call_sync(|c| Ok(vault::migrate_plaintext(c)?))?;
        db.call_sync(model_headers::migrate)?;
        let latest = db.call_sync(|c| events::latest_seq(c))?;
        let (seq_tx, _) = watch::channel(latest);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        Ok(Self {
            cfg: Arc::new(cfg),
            db,
            clock,
            access: Arc::new(auth::AccessTokens::default()),
            auth_tx: Arc::new(watch::channel(()).0),
            partials: Arc::new(events::Partials::new()),
            cancels: Arc::new(runner::Cancels::default()),
            fair: fair::Fair::default(),
            repo_locks: Arc::new(git::RepoLocks::default()),
            project_resources: Arc::new(project_resources::ProjectResources::default()),
            tickets: Arc::new(files::Tickets::default()),
            tasks: Arc::new(tasks::Tasks::default()),
            terminals: Arc::new(terminals::Terminals::default()),
            storage: Arc::new(storage::Storage::default()),
            seq_tx: Arc::new(seq_tx),
            shutdown_tx: Arc::new(shutdown_tx),
            shutdown_rx,
            exit_tx: Arc::new(watch::channel(false).0),
            epoch: util::new_id(),
        })
    }

    /// commit 이후 SSE 구독자에게 새 이벤트가 있음을 알린다.
    pub async fn notify_events(&self) {
        if let Ok(seq) = self.db.call(|c| events::latest_seq(c)).await {
            self.seq_tx.send_replace(seq);
        }
    }

    pub fn now(&self) -> String {
        util::fmt_time(self.clock.now())
    }

    pub fn is_shutting_down(&self) -> bool {
        *self.shutdown_rx.borrow()
    }
}

async fn tools_list(_p: auth::Principal) -> axum::Json<Vec<tools::ToolSpec>> {
    axum::Json(tools::specs())
}

pub fn router(app: App) -> Router {
    use axum::routing::delete;
    let api = Router::new()
        .route("/auth/whoami", get(auth::whoami))
        .route("/devices", get(auth::list_devices).post(auth::create_device))
        .route("/devices/{id}", delete(auth::revoke_device))
        .route("/events", get(events::stream))
        .route("/projects", get(projects::list).post(projects::create))
        .route("/fs/dirs", get(projects::browse_dirs))
        .route("/fs/suggest", get(repos::suggest))
        .route("/github/repos", get(repos::search))
        .route("/projects/clone", post(repos::clone))
        .route("/projects/{id}", get(projects::show).patch(projects::update))
        .route("/labels", get(labels::list).post(labels::create))
        .route("/labels/{id}", axum::routing::patch(labels::update).delete(labels::remove))
        .route("/projects/{id}/labels/{label_id}", axum::routing::put(labels::assign))
        .route("/projects/{id}/sessions", get(sessions::list).post(sessions::create))
        .route("/projects/{id}/attachments", post(attachments::upload).layer(axum::extract::DefaultBodyLimit::max(6 * 1024 * 1024)))
        .route("/attachments/{id}", get(attachments::show).delete(attachments::remove))
        .route("/attachments/{id}/content", get(attachments::content))
        .route("/projects/{id}/terminals", get(terminals::list).post(terminals::create))
        .route("/terminals/{id}", axum::routing::patch(terminals::rename).delete(terminals::remove))
        .route("/terminals/{id}/kill", post(terminals::kill))
        .route("/terminals/{id}/screen", get(terminals::screen))
        .route("/terminals/{id}/capture", get(terminals::capture))
        .route("/terminals/{id}/ticket", post(terminals::ticket))
        .route("/terminal-ws/{ticket}", get(terminals::ws))
        .route("/usage", get(usage::get_usage))
        .route("/usage/capacity", get(usage::capacity))
        .route("/admin/update-readiness", get(admin::readiness))
        .route("/admin/shutdown", post(admin::shutdown))
        .route("/admin/metrics", get(admin::metrics))
        .route("/admin/diagnostics", post(admin::diagnostics))
        .route("/mcp/servers", get(mcp::list).post(mcp::create))
        .route("/mcp/servers/{id}", axum::routing::put(mcp::update).delete(mcp::remove))
        .route("/mcp/servers/{id}/check", get(mcp::check_result).post(mcp::check))
        .route("/admin/update-receipts/import", post(admin::import_receipts))
        .route("/updates", get(admin::list_updates))
        .route("/bots", get(bots::list).post(bots::create))
        .route("/bots/order", post(bots::reorder))
        .route("/bots/{id}", get(bots::show).patch(bots::update))
        .route(
            "/bots/{id}/avatar",
            get(bot_avatars::get)
                .put(bot_avatars::put)
                .delete(bot_avatars::remove)
                .layer(axum::extract::DefaultBodyLimit::max(bot_avatars::MAX_BYTES.div_ceil(3) * 4 + 4096)),
        )
        .route("/bots/{id}/home", post(bots::open_home))
        .route("/bots/{id}/status", post(bots::set_status))
        .route("/bots/{id}/seen", post(bots::seen))
        .route("/notifications", get(notifications::list))
        .route("/notifications/delivered", post(notifications::delivered))
        .route("/notifications/read-all", post(notifications::read_all))
        .route("/notifications/{id}/read", post(notifications::read))
        .route("/schedules", get(schedules::list))
        .route("/projects/{id}/schedules", post(schedules::create))
        .route("/schedules/{id}", get(schedules::show).patch(schedules::update))
        .route("/schedules/{id}/pause", post(schedules::pause))
        .route("/schedules/{id}/resume", post(schedules::resume))
        .route("/schedules/{id}/delete", post(schedules::delete))
        .route("/schedules/{id}/run", post(schedules::run_now))
        .route("/schedules/{id}/runs", get(schedules::runs))
        .route("/schedules/{id}/webhook", post(schedules::set_webhook))
        .route("/hooks/schedules/{id}", post(schedules::receive_hook))
        .route("/sessions/{id}/context", get(context::get_usage))
        .route("/sessions/{id}/model-input", get(context::get_model_input))
        .route("/sessions/{id}/compact", post(context::post_compact))
        .route("/sessions/{id}/rewind", post(sessions::rewind))
        .route("/sessions/{id}/followups", get(followups::get_list).post(followups::post_add))
        .route("/sessions/{id}/followups/{fid}", axum::routing::delete(followups::delete))
        .route("/sessions/{id}/followups/{fid}/start", post(followups::post_start))
        .route("/sessions/{id}/goals", get(goals::get_list).post(goals::post_add))
        .route("/sessions/{id}/goals/reorder", post(goals::post_reorder))
        .route("/sessions/{id}/goals/{goal_id}", axum::routing::patch(goals::patch))
        .route("/sessions/{id}/agent-runs", get(agents::list))
        .route("/agent-runs/{id}", get(agents::show))
        .route("/agent-runs/{id}/cancel", post(agents::cancel))
        .route("/sessions/{id}/tasks", get(tasks::list).post(tasks::start))
        .route("/projects/{id}/scripts", get(project_scripts::list).post(project_scripts::create))
        .route("/projects/{id}/scripts/{script}", put(project_scripts::update).delete(project_scripts::remove))
        .route("/sessions/{id}/scripts/{script}/run", post(project_scripts::run))
        .route("/projects/{id}/setup", get(project_scripts::setup_status))
        .route("/sessions/{id}/file-changes", get(changes::list))
        .route("/sessions/{id}/file-changes/undo", post(changes::undo))
        .route("/sessions/{id}/file-changes/redo", post(changes::redo))
        .route("/sessions/{id}/review", get(changes::review))
        .route("/file-changes/{id}/diff", get(changes::diff))
        .route("/projects/{id}/trash", get(storage::list_trash))
        .route("/trash/{id}/restore", post(storage::restore_trash))
        .route("/trash/{id}/delete", post(storage::delete_trash))
        .route("/tasks/{id}", get(tasks::show))
        .route("/tasks/{id}/output", get(tasks::output))
        .route("/tasks/{id}/wait", get(tasks::wait))
        .route("/tasks/{id}/cancel", post(tasks::cancel))
        .route("/projects/{id}/files", get(files::list))
        .route("/projects/{id}/files/content", get(files::content).put(files::save))
        .route("/projects/{id}/files/raw", get(files::raw))
        .route("/projects/{id}/files/op", post(files::op))
        .route("/projects/{id}/files/upload", post(files::upload).layer(axum::extract::DefaultBodyLimit::max(7 * 1024 * 1024 + 512 * 1024)))
        .route("/projects/{id}/files/ticket", post(files::ticket))
        .route("/file-tickets/{ticket}", get(files::by_ticket))
        .route("/projects/{id}/git/status", get(git::status))
        .route("/projects/{id}/git/stashes", get(git::stashes))
        .route("/projects/{id}/git/stash-save", post(git::stash_save))
        .route("/projects/{id}/git/review", post(git::review))
        .route("/projects/{id}/git/confirm", post(git::confirm_git))
        .route("/projects/{id}/git/diff", get(git::diff))
        .route("/projects/{id}/git/log", get(git::log))
        .route("/projects/{id}/git/branches", get(git::branches).post(git::create_branch))
        .route("/projects/{id}/git/switch", post(git::switch_branch))
        .route("/projects/{id}/git/stage", post(git::stage))
        .route("/projects/{id}/git/unstage", post(git::unstage))
        .route("/projects/{id}/git/commit", post(git::commit))
        .route("/projects/{id}/git/hunks", get(git::hunks))
        .route("/projects/{id}/git/stage-hunks", post(git::stage_hunks))
        .route("/projects/{id}/git/fetch", post(git::fetch))
        .route("/projects/{id}/git/pull", post(git::pull))
        .route("/projects/{id}/git/push", post(git::push))
        .route("/projects/{id}/git/merge", post(git::merge))
        .route("/projects/{id}/worktrees", get(worktrees::list).post(worktrees::create))
        .route("/projects/{id}/worktrees/prune", post(worktrees::prune))
        .route("/worktrees/{id}", delete(worktrees::remove))
        .route("/worktrees/{id}/merge", post(worktrees::merge))
        .route("/worktrees/{id}/review", post(worktrees::review))
        .route("/worktrees/{id}/recovery", get(worktrees::recovery))
        .route("/worktrees/{id}/restore", post(worktrees::restore))
        .route("/projects/{id}/recovery", get(projects::recovery))
        .route("/projects/{id}/restore", post(projects::restore))
        .route("/sessions/{id}/worktree", post(worktrees::enter))
        .route("/projects/{id}/git/branches/rename", post(git::rename_branch))
        .route("/projects/{id}/git/commits/{rev}", get(git::show_commit))
        .route("/projects/{id}/git/compare", get(git::compare))
        .route("/sessions/search", get(sessions::search))
        .route("/recall", get(recall::get))
        .route("/memories", get(memories::get_list).post(memories::create))
        .route("/memories/{id}", put(memories::update))
        .route("/memories/{id}/delete", post(memories::delete))
        .route("/sessions/{id}/delete", post(sessions::delete_permanently))
        .route("/sessions/{id}/title", post(titles::post_generate))
        .route("/sessions/{id}", get(sessions::show).patch(sessions::update))
        .route("/sessions/{id}/messages", get(sessions::messages).post(sessions::post_message))
        .route("/sessions/{id}/fork", post(sessions::fork))
        .route("/sessions/{id}/turns", get(runner::list).post(runner::create))
        .route("/sessions/{id}/tool-requests", post(approvals::create_request))
        .route("/turns/{id}", get(runner::show))
        .route("/turns/{id}/cancel", post(runner::cancel))
        .route("/turns/{id}/retry", post(runner::retry))
        .route("/turns/{id}/acknowledge", post(runner::acknowledge))
        .route("/recovery", get(runner::recovery))
        .route("/sessions/{id}/remote-watches", get(remote_watches::list).post(remote_watches::create))
        .route("/remote-watches/{id}", get(remote_watches::show))
        .route("/remote-watches/{id}/cancel", post(remote_watches::cancel))
        .route("/remote-watches/{id}/check", post(remote_watches::check_now))
        .route("/tool-calls", get(approvals::list))
        .route("/tool-calls/{id}", get(approvals::show))
        .route("/tool-calls/{id}/decision", post(approvals::decide))
        .route("/tool-calls/{id}/answer", post(approvals::answer))
        .route("/audit", get(audit::list))
        .route("/sessions/{id}/tool-grants", get(approvals::list_grants))
        .route("/sessions/{id}/tool-grants/{tool}", axum::routing::delete(approvals::revoke_grant))
        .route("/tool-calls/{id}/cancel", post(approvals::cancel))
        .route("/tool-calls/{id}/observe", get(approvals::observe))
        .route("/tool-calls/{id}/review", post(approvals::review))
        .route("/tools", get(tools_list))
        .route("/secrets", get(models::list_secrets).post(models::create_secret))
        .route("/secrets/{id}", axum::routing::put(models::replace_secret).delete(models::delete_secret))
        .route("/model-profiles", get(models::list_profiles).post(models::create_profile))
        .route("/model-profiles/{id}", axum::routing::put(models::update_profile).delete(models::delete_profile))
        .route("/model-profiles/{id}/check", post(models::check_profile))
        .route("/model-profiles/{id}/models", get(models::catalog))
        .route("/settings/registry", get(settings::get_registry))
        .route("/settings/effective", get(settings::get_effective))
        .route("/settings/reset-preview", get(settings::reset_preview))
        .route("/settings/reset", post(settings::reset_apply))
        .route("/settings/{scope}/{scope_id}/{key}", axum::routing::put(settings::put))
        .route("/recent", get(workspace::list))
        .route("/recent/touch", post(workspace::touch))
        .route("/recent/{id}", axum::routing::patch(workspace::update))
        .route("/layouts/{device}", get(workspace::get_layout).put(workspace::put_layout))
        .route("/drafts/{key}", get(workspace::get_draft).put(workspace::put_draft))
        .route("/definitions", get(definitions::list))
        .route("/definitions/{kind}", post(definitions::create))
        .route("/definitions/{kind}/{id}", get(definitions::show).put(definitions::update).delete(definitions::delete))
        .route("/definitions/{kind}/{id}/restore", post(definitions::restore))
        // 인증 없이 접근 가능한 경로(origin 검사는 handler 안에서 수행)
        .route("/health", get(web::health))
        .route("/auth/browser-login", post(auth::browser_login))
        .route("/auth/refresh", post(auth::browser_refresh))
        .route("/auth/logout", post(auth::browser_logout))
        .route("/auth/pairing", post(pairing::redeem))
        .route("/pairings", get(pairing::list).post(pairing::create))
        .route("/pairings/{id}", axum::routing::delete(pairing::revoke))
        .fallback(|| async { error::ApiError::not_found("요청한 API가 없습니다") })
        .layer(axum::middleware::from_fn_with_state(app.clone(), auth::origin_guard))
        .layer(axum::middleware::from_fn_with_state(app.clone(), web::reject_when_shutting_down))
        .layer(tower_http::limit::RequestBodyLimitLayer::new(8 * 1024 * 1024))
        .layer(axum::middleware::from_fn(web::protocol_guard))
        .layer(axum::middleware::from_fn(web::request_context));
    Router::new().nest("/api/v1", api).merge(web::static_routes(&app))
        .with_state(app)
}
