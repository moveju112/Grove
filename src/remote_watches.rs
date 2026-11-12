//! 원격 job 완료 감시(EXEC-014~017).
//!
//! - 사용자가 등록한 정확한 HTTPS URL 하나만 GET으로 조회한다. redirect를 따르지 않고 인증·쿠키를 보내지 않으며 원격 mutation을 하지 않는다.
//! - 응답 JSON의 지정 위치(JSON pointer) 값이 성공/실패 값 목록에 들면 감시를 끝낸다. 그 밖의 값과 일시 오류는 다음 확인까지 기다린다.
//! - 감시 취소는 이 서버의 조회만 멈춘다. 원격 작업 자체를 취소하는 요청은 보내지 않는다.
//! - 감시 결과(원격 job 성공/실패)·연결된 로컬 명령 결과·알림 저장·앱 전달·열람은 서로 다른 상태로 둔다. 모델을 다시 부르지 않는다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::{events, idem};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;
use tokio::task::JoinHandle;

const MAX_URL: usize = 2048;
const MAX_BODY: usize = 1 << 20;
const MAX_VALUES: usize = 20;
const MIN_INTERVAL: i64 = 10;
const MAX_INTERVAL: i64 = 3600;
const MAX_TIMEOUT_MINS: i64 = 7 * 24 * 60;
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
/// 한 점검에서 시작하는 최대 조회 수. 나머지는 다음 점검으로 미룬다.
const BATCH: i64 = 8;

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct RemoteWatch {
    pub id: String,
    pub project_id: String,
    pub session_id: String,
    /// 원격 job을 시작한 로컬 명령(선택). 그 명령의 성공은 원격 job 성공과 별개다.
    pub task_id: Option<String>,
    pub title: String,
    pub url: String,
    pub status_pointer: String,
    pub success_values: Vec<String>,
    pub failure_values: Vec<String>,
    pub interval_secs: i64,
    pub deadline_at: String,
    /// watching·succeeded(원격 성공 값)·failed(원격 실패 값)·timed_out(감시 시간 초과)·cancelled(감시만 중단)·stopped(redirect 등 설정 오류로 중단)
    pub status: String,
    /// 마지막으로 읽은 원격 상태 값(원문 문자열).
    pub remote_value: Option<String>,
    pub checks: i64,
    pub last_checked_at: Option<String>,
    pub next_check_at: Option<String>,
    #[ts(type = "{ code: string; message: string } | null")]
    pub last_error: Value,
    /// 종료 알림 ID. 알림의 앱 전달·열람 상태는 알림 쪽에 따로 있다.
    pub notification_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
    pub revision: i64,
}

const COLS: &str = "id, project_id, session_id, task_id, title, url, status_pointer, success_values, failure_values, interval_secs, deadline_at, status, \
    remote_value, checks, last_checked_at, next_check_at, last_error, notification_id, created_at, updated_at, finished_at, revision";

fn row(r: &Row) -> rusqlite::Result<RemoteWatch> {
    let list = |i: usize| -> rusqlite::Result<Vec<String>> { Ok(serde_json::from_str(&r.get::<_, String>(i)?).unwrap_or_default()) };
    Ok(RemoteWatch {
        id: r.get(0)?,
        project_id: r.get(1)?,
        session_id: r.get(2)?,
        task_id: r.get(3)?,
        title: r.get(4)?,
        url: r.get(5)?,
        status_pointer: r.get(6)?,
        success_values: list(7)?,
        failure_values: list(8)?,
        interval_secs: r.get(9)?,
        deadline_at: r.get(10)?,
        status: r.get(11)?,
        remote_value: r.get(12)?,
        checks: r.get(13)?,
        last_checked_at: r.get(14)?,
        next_check_at: r.get(15)?,
        last_error: r.get::<_, Option<String>>(16)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null),
        notification_id: r.get(17)?,
        created_at: r.get(18)?,
        updated_at: r.get(19)?,
        finished_at: r.get(20)?,
        revision: r.get(21)?,
    })
}

pub fn get(c: &Connection, id: &str) -> ApiResult<RemoteWatch> {
    c.query_row(&format!("SELECT {COLS} FROM remote_watches WHERE id = ?1"), params![id], row)
        .optional()?
        .ok_or_else(|| ApiError::not_found("원격 감시가 없습니다"))
}

fn emit(c: &Connection, now: &str, w: &RemoteWatch) -> ApiResult<()> {
    events::append(c, now, "remote_watch.changed", Some(&w.project_id), Some(&w.session_id), &serde_json::to_value(w)?)?;
    Ok(())
}

/// 등록 가능한 URL인지 확인한다. HTTPS만 허용하고 사용자 정보·fragment는 받지 않는다.
/// `insecure_loopback`은 시험용 설정에서만 loopback의 평문 HTTP를 허용한다.
pub fn check_url(raw: &str, insecure_loopback: bool) -> ApiResult<reqwest::Url> {
    if raw.len() > MAX_URL {
        return Err(ApiError::invalid(format!("URL은 {MAX_URL}자 이하여야 합니다")));
    }
    let u = reqwest::Url::parse(raw).map_err(|_| ApiError::invalid("URL 형식이 잘못되었습니다"))?;
    if !u.username().is_empty() || u.password().is_some() {
        return Err(ApiError::invalid("URL에 사용자 정보를 넣을 수 없습니다"));
    }
    if u.fragment().is_some() {
        return Err(ApiError::invalid("URL에 fragment(#)를 넣을 수 없습니다"));
    }
    let loopback = u
        .host_str()
        .map(|h| h.trim_start_matches('[').trim_end_matches(']'))
        .and_then(|h| h.parse::<std::net::IpAddr>().ok())
        .is_some_and(|ip| ip.is_loopback());
    match u.scheme() {
        "https" if u.host().is_some() => Ok(u),
        "http" if insecure_loopback && loopback => Ok(u),
        _ => Err(ApiError::invalid("HTTPS URL만 감시할 수 있습니다")),
    }
}

#[derive(Deserialize)]
pub struct Create {
    pub title: String,
    pub url: String,
    pub status_pointer: String,
    pub success_values: Vec<String>,
    pub failure_values: Vec<String>,
    pub interval_secs: Option<i64>,
    pub timeout_mins: Option<i64>,
    pub task_id: Option<String>,
}

fn clean_values(v: &[String], what: &str) -> ApiResult<Vec<String>> {
    let out: Vec<String> = v.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if out.is_empty() || out.len() > MAX_VALUES || out.iter().any(|s| s.chars().count() > 100) {
        return Err(ApiError::invalid(format!("{what} 값은 1~{MAX_VALUES}개, 각 100자 이하여야 합니다")));
    }
    Ok(out)
}

/// 원격 감시 등록(EXEC-014). 등록 즉시 한 번 확인한다.
pub async fn create(State(app): State<App>, p: Principal, headers: HeaderMap, Path(session_id): Path<String>, Json(b): Json<Create>) -> ApiResult<Response> {
    let title = b.title.trim().to_string();
    if title.is_empty() || title.chars().count() > 100 {
        return Err(ApiError::invalid("이름은 1~100자여야 합니다"));
    }
    let url = check_url(b.url.trim(), app.cfg.remote_watch_insecure_loopback)?.to_string();
    let pointer = b.status_pointer.trim().to_string();
    if !(pointer.is_empty() || pointer.starts_with('/')) || pointer.len() > 200 {
        return Err(ApiError::invalid("상태 위치는 빈 값(본문 전체) 또는 /로 시작하는 JSON pointer여야 합니다"));
    }
    let success = clean_values(&b.success_values, "성공")?;
    let failure = clean_values(&b.failure_values, "실패")?;
    if success.iter().any(|s| failure.contains(s)) {
        return Err(ApiError::invalid("같은 값을 성공과 실패에 함께 둘 수 없습니다"));
    }
    let interval = b.interval_secs.unwrap_or(60);
    if !(MIN_INTERVAL..=MAX_INTERVAL).contains(&interval) {
        return Err(ApiError::invalid(format!("확인 간격은 {MIN_INTERVAL}~{MAX_INTERVAL}초여야 합니다")));
    }
    let timeout = b.timeout_mins.unwrap_or(60);
    if !(1..=MAX_TIMEOUT_MINS).contains(&timeout) {
        return Err(ApiError::invalid(format!("감시 시간은 1~{MAX_TIMEOUT_MINS}분이어야 합니다")));
    }
    let h = idem::body_hash(
        "remote_watch.create",
        &json!({ "s": session_id, "t": title, "u": url, "p": pointer, "ok": success, "no": failure, "i": interval, "m": timeout, "k": b.task_id }),
    );
    let clock = app.clock.clone();
    let resp = idem::run(&app, &p, &headers, &h, move |tx, now| {
        let s = crate::sessions::get_active(tx, &session_id)?;
        if let Some(t) = &b.task_id {
            let same: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?1 AND session_id = ?2)", params![t, session_id], |r| r.get(0))?;
            if !same {
                return Err(ApiError::invalid("이 대화의 작업만 연결할 수 있습니다"));
            }
        }
        let deadline = crate::util::fmt_time(clock.now() + time::Duration::minutes(timeout));
        let id = crate::util::new_id();
        tx.execute(
            "INSERT INTO remote_watches (id, project_id, session_id, task_id, title, url, status_pointer, success_values, failure_values, interval_secs, deadline_at, \
             status, checks, next_check_at, created_at, updated_at, revision) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'watching',0,?12,?12,?12,1)",
            params![id, s.project_id, session_id, b.task_id, title, url, pointer, serde_json::to_string(&success)?, serde_json::to_string(&failure)?, interval, deadline, now],
        )?;
        let w = get(tx, &id)?;
        emit(tx, now, &w)?;
        Ok((StatusCode::CREATED, serde_json::to_value(&w)?))
    })
    .await?;
    app.notify_events().await;
    kick(&app).await;
    Ok(resp)
}

pub async fn list(State(app): State<App>, _p: Principal, Path(session_id): Path<String>) -> ApiResult<Json<Vec<RemoteWatch>>> {
    Ok(Json(
        app.db
            .call(move |c| {
                let mut st = c.prepare(&format!("SELECT {COLS} FROM remote_watches WHERE session_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 100"))?;
                let v = st.query_map(params![session_id], row)?.collect::<Result<Vec<_>, _>>()?;
                Ok(v)
            })
            .await?,
    ))
}

pub async fn show(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<RemoteWatch>> {
    Ok(Json(app.db.call(move |c| get(c, &id)).await?))
}

#[derive(Deserialize)]
pub struct Revision {
    pub expected_revision: i64,
}

/// 감시 취소(EXEC-016). 이 서버의 조회만 멈추며 원격 작업에는 아무 요청도 보내지 않는다.
pub async fn cancel(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<Revision>) -> ApiResult<Response> {
    let h = idem::body_hash("remote_watch.cancel", &json!({ "i": id, "r": b.expected_revision }));
    let resp = idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get(tx, &id)?;
        if cur.status != "watching" {
            return Err(ApiError::conflict("not_watching", format!("이미 끝난 감시입니다({})", cur.status)).with_details(json!({ "watch": cur })));
        }
        if cur.revision != b.expected_revision {
            return Err(ApiError::conflict("revision_conflict", "다른 곳에서 먼저 바뀌었습니다").with_details(json!({ "watch": cur })));
        }
        tx.execute(
            "UPDATE remote_watches SET status = 'cancelled', finished_at = ?2, next_check_at = NULL, updated_at = ?2, revision = revision + 1 WHERE id = ?1",
            params![id, now],
        )?;
        let w = get(tx, &id)?;
        emit(tx, now, &w)?;
        Ok((StatusCode::OK, json!({ "watch": w, "remote_job_cancelled": false })))
    })
    .await?;
    app.notify_events().await;
    Ok(resp)
}

/// 지금 확인. 다음 확인 시각만 앞당기며 진행 중인 조회가 있으면 겹쳐 보내지 않는다.
pub async fn check_now(State(app): State<App>, _p: Principal, Path(id): Path<String>, Json(b): Json<Revision>) -> ApiResult<Json<RemoteWatch>> {
    let now = app.now();
    let w = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let cur = get(&tx, &id)?;
            if cur.status != "watching" {
                return Err(ApiError::conflict("not_watching", format!("이미 끝난 감시입니다({})", cur.status)));
            }
            if cur.revision != b.expected_revision {
                return Err(ApiError::conflict("revision_conflict", "다른 곳에서 먼저 바뀌었습니다").with_details(json!({ "watch": cur })));
            }
            tx.execute("UPDATE remote_watches SET next_check_at = ?2 WHERE id = ?1", params![id, now])?;
            let w = get(&tx, &id)?;
            tx.commit()?;
            Ok(w)
        })
        .await?;
    kick(&app).await;
    Ok(Json(w))
}

/// 조회 중인 감시. 같은 감시를 겹쳐 조회하지 않는다(프로세스 안).
static IN_FLIGHT: std::sync::LazyLock<Mutex<HashSet<String>>> = std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

enum Outcome {
    /// 원격 상태 값(문자열)
    Value(String),
    /// 다시 시도할 수 있는 오류(네트워크·5xx·형식)
    Retry(&'static str, String),
    /// 설정을 바꾸지 않으면 계속 실패하는 오류(redirect 등). 감시를 멈춘다.
    Stop(&'static str, String),
}

fn client(insecure_loopback: bool) -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .https_only(!insecure_loopback)
        .timeout(FETCH_TIMEOUT)
        .user_agent(concat!("grove-remote-watch/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("reqwest client")
}

async fn fetch(url: &str, pointer: &str, insecure_loopback: bool) -> Outcome {
    let resp = match client(insecure_loopback).get(url).header("Accept", "application/json").send().await {
        Ok(r) => r,
        Err(e) if e.is_timeout() => return Outcome::Retry("timeout", "응답 시간이 초과되었습니다".into()),
        Err(_) => return Outcome::Retry("network", "원격 서버에 연결하지 못했습니다".into()),
    };
    let st = resp.status();
    if st.is_redirection() {
        return Outcome::Stop("redirect_refused", format!("redirect({})는 따라가지 않습니다. 최종 URL을 직접 등록하세요", st.as_u16()));
    }
    if !st.is_success() {
        return Outcome::Retry("http_status", format!("원격 응답 상태 {}", st.as_u16()));
    }
    let mut body = Vec::new();
    let mut resp = resp;
    loop {
        match resp.chunk().await {
            Ok(Some(c)) => {
                if body.len() + c.len() > MAX_BODY {
                    return Outcome::Retry("too_large", "응답이 1MiB를 넘습니다".into());
                }
                body.extend_from_slice(&c);
            }
            Ok(None) => break,
            Err(_) => return Outcome::Retry("network", "응답을 끝까지 받지 못했습니다".into()),
        }
    }
    let Ok(v) = serde_json::from_slice::<Value>(&body) else { return Outcome::Retry("not_json", "응답이 JSON이 아닙니다".into()) };
    match v.pointer(pointer) {
        Some(Value::String(s)) => Outcome::Value(s.clone()),
        Some(x @ (Value::Number(_) | Value::Bool(_))) => Outcome::Value(x.to_string()),
        _ => Outcome::Retry("status_missing", format!("응답의 {pointer} 위치에 문자열·숫자 상태가 없습니다")),
    }
}

fn finish(c: &Connection, now: &str, w: &RemoteWatch, status: &str, value: Option<&str>, error: Option<&Value>) -> ApiResult<()> {
    let (word, body) = match status {
        "succeeded" => ("성공", format!("원격 상태 {}", value.unwrap_or(""))),
        "failed" => ("실패", format!("원격 상태 {}", value.unwrap_or(""))),
        "timed_out" => ("감시 시간 초과", "원격 작업 결과를 확인하지 못했습니다. 원격 작업은 계속 진행 중일 수 있습니다".into()),
        _ => ("감시 중단", error.and_then(|e| e["message"].as_str()).unwrap_or("").to_string()),
    };
    let n = crate::notifications::push(c, now, "remote_watch", &format!("원격 작업 {}: {word}", w.title), &body, Some(&w.project_id), Some(&w.session_id), Some(&w.id))?;
    let changed = c.execute(
        "UPDATE remote_watches SET status = ?2, remote_value = COALESCE(?3, remote_value), last_error = ?4, finished_at = ?5, next_check_at = NULL, \
         notification_id = ?6, updated_at = ?5, revision = revision + 1 WHERE id = ?1 AND status = 'watching'",
        params![w.id, status, value, error.map(Value::to_string), now, n.id],
    )?;
    if changed == 0 {
        return Err(ApiError::conflict("not_watching", "이미 끝난 감시입니다"));
    }
    crate::sessions::append_message(c, now, &w.session_id, "note", &json!({
        "type": "remote_watch_result", "watch_id": w.id, "title": w.title, "status": status, "remote_value": value, "url": w.url,
    }), None, None)?;
    emit(c, now, &get(c, &w.id)?)
}

/// 한 감시를 조회하고 결과를 기록한다. 조회 중 취소되면 결과를 버린다(상태 조건부 갱신).
async fn check_one(app: App, w: RemoteWatch) {
    let outcome = fetch(&w.url, &w.status_pointer, app.cfg.remote_watch_insecure_loopback).await;
    let clock = app.clock.clone();
    let id = w.id.clone();
    let _ = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let now_t = clock.now();
            let now = crate::util::fmt_time(now_t);
            let cur = get(&tx, &w.id)?;
            if cur.status != "watching" {
                return Ok(());
            }
            tx.execute("UPDATE remote_watches SET checks = checks + 1, last_checked_at = ?2 WHERE id = ?1", params![w.id, now])?;
            let next = crate::util::fmt_time(now_t + time::Duration::seconds(cur.interval_secs));
            match outcome {
                Outcome::Value(v) if cur.success_values.contains(&v) => finish(&tx, &now, &cur, "succeeded", Some(&v), None)?,
                Outcome::Value(v) if cur.failure_values.contains(&v) => finish(&tx, &now, &cur, "failed", Some(&v), None)?,
                Outcome::Stop(code, message) => finish(&tx, &now, &cur, "stopped", None, Some(&json!({ "code": code, "message": message })))?,
                other => {
                    let (value, error) = match other {
                        Outcome::Value(v) => (Some(v), None),
                        Outcome::Retry(code, message) => (None, Some(json!({ "code": code, "message": message }).to_string())),
                        Outcome::Stop(..) => unreachable!(),
                    };
                    tx.execute(
                        "UPDATE remote_watches SET remote_value = COALESCE(?2, remote_value), last_error = ?3, next_check_at = ?4, updated_at = ?5, revision = revision + 1 WHERE id = ?1",
                        params![w.id, value, error, next, now],
                    )?;
                    emit(&tx, &now, &get(&tx, &w.id)?)?;
                }
            }
            tx.commit()?;
            Ok(())
        })
        .await;
    IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    app.notify_events().await;
}

/// 감시 시간이 지난 감시를 끝내고, 확인할 때가 된 감시를 조회한다.
pub async fn kick(app: &App) {
    let now = app.now();
    let due = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let mut st = tx.prepare(&format!("SELECT {COLS} FROM remote_watches WHERE status = 'watching' AND deadline_at <= ?1"))?;
            let expired = st.query_map(params![now], row)?.collect::<Result<Vec<_>, _>>()?;
            drop(st);
            for w in &expired {
                finish(&tx, &now, w, "timed_out", None, None)?;
            }
            let mut st = tx.prepare(&format!(
                "SELECT {COLS} FROM remote_watches WHERE status = 'watching' AND next_check_at <= ?1 ORDER BY next_check_at LIMIT ?2"
            ))?;
            let due = st.query_map(params![now, BATCH], row)?.collect::<Result<Vec<_>, _>>()?;
            drop(st);
            tx.commit()?;
            Ok((due, !expired.is_empty()))
        })
        .await;
    let (due, expired) = match due {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("원격 감시 점검 실패: {}", e.message);
            return;
        }
    };
    if expired {
        app.notify_events().await;
    }
    for w in due {
        if !IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).insert(w.id.clone()) {
            continue;
        }
        tokio::spawn(check_one(app.clone(), w));
    }
}

/// 1초마다 기한·확인 시각을 점검한다. 조회는 GET 뿐이므로 재시작 뒤에도 그대로 이어서 감시한다.
pub fn spawn(app: App) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut rx = app.shutdown_rx.clone();
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                _ = rx.changed() => break,
            }
            kick(&app).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::check_url;

    #[test]
    fn only_exact_https_urls_are_accepted() {
        assert!(check_url("https://ci.example.com/api/jobs/1?x=1", false).is_ok());
        for bad in ["http://ci.example.com/x", "ftp://x/y", "https://user:pw@ci.example.com/x", "https://ci.example.com/x#frag", "not a url", "file:///etc/passwd"] {
            assert!(check_url(bad, false).is_err(), "{bad}");
        }
        // 시험용 설정도 loopback 평문만 허용한다.
        assert!(check_url("http://127.0.0.1:9/x", false).is_err());
        assert!(check_url("http://127.0.0.1:9/x", true).is_ok());
        assert!(check_url("http://[::1]:9/x", true).is_ok());
        assert!(check_url("http://example.com/x", true).is_err());
        assert!(check_url("http://localhost:9/x", true).is_err(), "이름 해석이 필요한 host는 평문 예외에서 뺀다");
        assert!(check_url(&format!("https://x.example/{}", "a".repeat(2100)), false).is_err());
    }
}
