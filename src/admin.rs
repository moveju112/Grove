//! 관리 API(UPDATE-004, 006, 017~019): 업데이트 도구가 쓰는 readiness·종료 요청과 업데이트 결과 조회.
//!
//! - readiness는 서비스를 멈추지 않고 실행 중인 일을 센다(업데이트 확인은 무중단).
//! - 종료 요청은 인증이 필요하다. 정상 종료 순서(신규 접수 중단 → 실행 정리 → flush)는 신호 종료와 같다.
//! - 업데이트 결과는 updater가 데이터 디렉터리의 `update-receipts/`에 먼저 파일로 남기고,
//!   준비된 서버에 가져오기를 요청해 알림으로 알린다. 요청한 세션이 사라지거나 updater가 중간에 끝나도
//!   파일은 남으므로 `/updates`로 조회할 수 있다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

/// 업데이트를 미뤄야 하는 실행 중 작업 수.
pub fn busy(c: &Connection, now: &str) -> ApiResult<Value> {
    let n = |sql: &str| -> ApiResult<i64> { Ok(c.query_row(sql, [], |r| r.get(0))?) };
    let soon = crate::util::parse_time(now).map(|t| crate::util::fmt_time(t + time::Duration::minutes(10))).unwrap_or_default();
    let schedules_soon: i64 = c.query_row(
        "SELECT COUNT(*) FROM schedules WHERE status = 'active' AND next_run_at IS NOT NULL AND julianday(next_run_at) <= julianday(?1)",
        params![soon],
        |r| r.get(0),
    )?;
    let v = json!({
        "active_turns": n("SELECT COUNT(*) FROM turns WHERE status IN ('queued','running')")?,
        "awaiting_approval": n("SELECT COUNT(*) FROM turns WHERE status = 'awaiting_approval'")?,
        "running_tasks": n("SELECT COUNT(*) FROM tasks WHERE status = 'running'")?,
        "running_terminals": n("SELECT COUNT(*) FROM terminals WHERE status = 'running'")?,
        "schedules_within_10m": schedules_soon,
        "running_schedule_runs": n("SELECT COUNT(*) FROM schedule_runs WHERE status = 'running'")?,
    });
    Ok(v)
}

pub async fn readiness(State(app): State<App>, _p: Principal) -> ApiResult<Json<Value>> {
    let now = app.now();
    let b = app.db.call(move |c| busy(c, &now)).await?;
    let idle = b.as_object().map(|o| o.values().all(|v| v.as_i64() == Some(0))).unwrap_or(false);
    Ok(Json(json!({
        "version": crate::VERSION, "protocol": crate::PROTOCOL_VERSION, "schema": crate::store::MIGRATIONS.len(),
        "idle": idle, "busy": b,
    })))
}

pub async fn update_settings(State(app): State<App>, _p: Principal) -> ApiResult<Json<Value>> {
    let now = app.now();
    let value = app.db.call(move |c| {
        let b = busy(c, &now)?;
        let idle = b.as_object().is_some_and(|o| o.values().all(|v| v.as_i64() == Some(0)));
        Ok(json!({
            "server": { "version": crate::VERSION, "protocol": crate::PROTOCOL_VERSION, "schema": crate::store::MIGRATIONS.len() },
            "settings": crate::update::settings(c)?,
            "last_check": crate::update::last_check(c)?,
            "can_manage": true,
            "readiness": { "idle": idle, "busy": b },
            "automatic_application": "not_enabled",
        }))
    }).await?;
    Ok(Json(value))
}

pub async fn save_update_settings(
    State(app): State<App>, p: Principal, headers: axum::http::HeaderMap,
    Json(request): Json<crate::update::SaveUpdateSettings>,
) -> ApiResult<Response> {
    let hash = crate::idem::body_hash("server_update.settings", &serde_json::to_value(&request)?);
    let actor = p.clone();
    crate::idem::run(&app, &p, &headers, &hash, move |tx, now| {
        let settings = crate::update::save_settings(tx, request, now)?;
        crate::audit::record(tx, now, &actor, "server_update.settings", "server", serde_json::to_value(&settings)?)?;
        Ok((StatusCode::OK, json!({ "settings": settings })))
    }).await
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateCheckRequest {
    pub expected_revision: i64,
}

pub async fn check_update(
    State(app): State<App>, p: Principal, headers: axum::http::HeaderMap,
    Json(request): Json<UpdateCheckRequest>,
) -> ApiResult<Response> {
    let hash = crate::idem::body_hash("server_update.check", &serde_json::to_value(&request)?);
    if let Some(prior) = crate::idem::replay(&app, &p, &headers, &hash).await? { return Ok(prior); }
    let revision = request.expected_revision;
    let channel = app.db.call(move |c| Ok(crate::update::require_revision(c, revision)?.channel)).await?;
    let release = crate::update::published_release(app.cfg.release_mirror.clone(), channel).await;
    crate::idem::run(&app, &p, &headers, &hash, move |tx, now| {
        let result = crate::update::check_settings(tx, revision, now, release)?;
        Ok((StatusCode::OK, json!({ "last_check": result })))
    }).await
}

/// PWA의 자동·수동 조회는 서버 설정이나 마지막 수동 확인 기록을 변경하지 않는다.
#[derive(serde::Deserialize)]
pub struct WebVersion { version: String }

pub async fn web_release(State(app): State<App>, _p: Principal, axum::extract::Query(web): axum::extract::Query<WebVersion>) -> ApiResult<Json<Value>> {
    let channel = app.db.call(|c| Ok(crate::update::settings(c)?.channel)).await?;
    let release = crate::update::published_release(app.cfg.release_mirror.clone(), channel).await
        .map_err(|_| ApiError::new(StatusCode::BAD_GATEWAY, "release_unavailable", "공식 웹 릴리즈를 확인하지 못했습니다"))?;
    let version = release["available"].as_str().unwrap_or_default();
    Ok(Json(json!({ "version": version, "newer": crate::update::cmp_version(version, &web.version).is_gt() })))
}

/// 서버 자원 상태(OBS-004). 상태를 바꾸지 않는다.
/// CPU·메모리는 Linux `/proc/self`에서 읽고, 다른 OS는 `null`(측정 불가)로 둔다.
pub async fn metrics(State(app): State<App>, _p: Principal) -> ApiResult<Json<Value>> {
    Ok(Json(collect_metrics(&app).await?))
}

async fn collect_metrics(app: &App) -> ApiResult<Value> {
    let now = app.now();
    let busy = app.db.call(move |c| busy(c, &now)).await?;
    let sessions: i64 = app
        .db
        .call(|c| Ok(c.query_row("SELECT COUNT(DISTINCT session_id) FROM turns WHERE status IN ('queued','running','awaiting_approval')", [], |r| r.get(0))?))
        .await?;
    let (fair_active, fair_waiting) = app.fair.counts();
    let db = app.cfg.data_dir.join("grove.db");
    let size = |suffix: &str| std::fs::metadata(format!("{}{suffix}", db.display())).map(|m| m.len()).unwrap_or(0);
    Ok(json!({
        "process": process_stats(),
        "active_sessions": sessions,
        "work": busy,
        "queue": { "running": fair_active, "waiting": fair_waiting },
        "db_bytes": { "main": size(""), "wal": size("-wal") },
        // 이벤트 변경 구독 수. 열린 SSE 연결과 서버 내부 대기(도구 실행 순서 대기 등)를 함께 센다.
        "event_subscribers": app.seq_tx.receiver_count(),
    }))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticRequest {
    pub confirmed: bool,
}

/// OBS-008: 명시적 요청에만 생성한다. 원문을 수집한 뒤 가리는 대신 고정 수치·상태만 읽는다.
pub async fn diagnostics(
    State(app): State<App>, _p: Principal, Json(request): Json<DiagnosticRequest>,
) -> ApiResult<Response> {
    if !request.confirmed {
        return Err(ApiError::invalid("진단 묶음에 포함되는 정보 범위를 확인하세요"));
    }
    let resources = collect_metrics(&app).await?;
    let counts = app.db.call(|c| {
        let n = |sql: &str| -> ApiResult<i64> { Ok(c.query_row(sql, [], |r| r.get(0))?) };
        // 고정 쿼리만 사용한다. 이름·ID·본문·경로·설정·로그·remote 오류 문구는 읽지 않는다.
        Ok(json!({
            "projects": n("SELECT COUNT(*) FROM projects")?,
            "sessions": n("SELECT COUNT(*) FROM sessions")?,
            "profiles_enabled": n("SELECT COUNT(*) FROM model_profiles WHERE deleted_at IS NULL AND enabled=1")?,
            "profiles_disabled": n("SELECT COUNT(*) FROM model_profiles WHERE deleted_at IS NULL AND enabled=0")?,
            "turns": {
                "completed": n("SELECT COUNT(*) FROM turns WHERE status='completed'")?,
                "failed": n("SELECT COUNT(*) FROM turns WHERE status='failed'")?,
                "cancelled": n("SELECT COUNT(*) FROM turns WHERE status='cancelled'")?,
                "interrupted": n("SELECT COUNT(*) FROM turns WHERE status='interrupted'")?,
            },
            "unknown_tools": n("SELECT COUNT(*) FROM tool_calls WHERE status='unknown'")?,
        }))
    }).await?;
    let bundle = json!({
        "format": "grove-diagnostics-v1",
        "collected_at": app.now(),
        "server": {
            "version": crate::VERSION, "protocol": crate::PROTOCOL_VERSION,
            "schema": app.db.schema_version(), "capabilities": crate::CAPABILITIES,
            "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
            "shutting_down": app.is_shutting_down(),
        },
        "resources": resources, "counts": counts,
        "privacy": {
            "external_upload": false,
            "collection": "allowlisted_aggregates_only",
            "excluded": ["tokens", "credentials", "content", "names", "ids", "paths", "urls", "settings", "environment", "logs"],
        },
    });
    Ok(([(axum::http::header::CACHE_CONTROL, "no-store")], Json(bundle)).into_response())
}

#[cfg(target_os = "linux")]
fn process_stats() -> Value {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let field = |k: &str| status.lines().find_map(|l| l.strip_prefix(k)).and_then(|v| v.split_whitespace().next()).and_then(|v| v.parse::<u64>().ok());
    // /proc/self/stat의 14·15번째(utime·stime)는 USER_HZ(Linux ABI 100) 단위다. comm에 공백이 있을 수 있어 ')' 뒤에서 센다.
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    let cpu = stat.rsplit_once(')').map(|(_, rest)| rest.split_whitespace().collect::<Vec<_>>()).and_then(|f| {
        let t = |i: usize| f.get(i).and_then(|v| v.parse::<u64>().ok());
        Some(t(11)? + t(12)?)
    });
    json!({
        "rss_bytes": field("VmRSS:").map(|kb| kb * 1024),
        "threads": field("Threads:"),
        "cpu_seconds": cpu.map(|ticks| ticks as f64 / 100.0),
    })
}

#[cfg(not(target_os = "linux"))]
fn process_stats() -> Value {
    json!({ "rss_bytes": null, "threads": null, "cpu_seconds": null })
}

pub async fn shutdown(State(app): State<App>, _p: Principal) -> (StatusCode, Json<Value>) {
    app.exit_tx.send_replace(true);
    (StatusCode::ACCEPTED, Json(json!({ "shutting_down": true })))
}

/// updater가 결과 파일을 쓴 뒤 호출한다. 서버 시작 시에는 가져오지 않는다:
/// 새 버전의 readiness 확인 중 시스템 기록이 생기면 "새 쓰기 있음"으로 오판해 안전한 복구를 막기 때문이다.
pub async fn import_receipts(State(app): State<App>, _p: Principal) -> ApiResult<Json<Value>> {
    let a = app.clone();
    let n = tokio::task::spawn_blocking(move || import_update_receipts(&a)).await.unwrap_or(0);
    app.notify_events().await;
    Ok(Json(json!({ "imported": n })))
}

/// 결과 파일을 알림으로 가져온다(한 번만: 가져온 파일은 imported/로 옮긴다).
pub fn import_update_receipts(app: &App) -> usize {
    let dir = app.cfg.data_dir.join("update-receipts");
    let Ok(rd) = std::fs::read_dir(&dir) else { return 0 };
    let imported = dir.join("imported");
    let _ = std::fs::create_dir_all(&imported);
    let mut n = 0;
    let mut files: Vec<_> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    files.sort();
    for p in files {
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let Ok(r) = serde_json::from_str::<Value>(&text) else { continue };
        let now = app.now();
        let title = match r["status"].as_str() {
            Some("applied") => format!("Grove {} 업데이트 완료", r["to_version"].as_str().unwrap_or("?")),
            Some("rolled_back") => format!("Grove {} 업데이트 실패 — 이전 버전으로 되돌림", r["to_version"].as_str().unwrap_or("?")),
            Some("deferred") => "업데이트 보류(실행 중 작업)".to_string(),
            _ => format!("업데이트 결과: {}", r["status"].as_str().unwrap_or("?")),
        };
        let body = r["message"].as_str().unwrap_or("").to_string();
        let ok = app
            .db
            .call_sync(move |c| {
                crate::notifications::push(c, &now, "update", &title, &body, None, None, r["id"].as_str())?;
                Ok(())
            })
            .is_ok();
        if ok && std::fs::rename(&p, imported.join(p.file_name().unwrap_or_default())).is_ok() {
            n += 1;
        }
    }
    n
}

/// 업데이트 결과 목록(가져온 것 + 아직 안 가져온 것). 모델 후속 분석과 분리된 단순 조회.
pub async fn list_updates(State(app): State<App>, _p: Principal) -> ApiResult<Json<Value>> {
    let dir = app.cfg.data_dir.join("update-receipts");
    let mut out = vec![];
    for d in [dir.join("imported"), dir] {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                if e.path().extension().is_some_and(|x| x == "json") {
                    if let Ok(v) = std::fs::read_to_string(e.path()).map(|t| serde_json::from_str::<Value>(&t).unwrap_or(Value::Null)) {
                        out.push(v);
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| b["finished_at"].as_str().cmp(&a["finished_at"].as_str()));
    Ok(Json(json!({ "items": out, "server": { "version": crate::VERSION, "protocol": crate::PROTOCOL_VERSION, "schema": crate::store::MIGRATIONS.len() } })))
}
