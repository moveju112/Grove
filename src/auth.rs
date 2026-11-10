//! 인증·origin 검사·기기 토큰·브라우저 로그인.
//!
//! - 모든 `/api` 요청은 loopback이어도 Bearer 토큰이 필요하다(SEC-002). 예외: health, 브라우저 로그인/갱신.
//! - 토큰 형식 `grv_<id>.<secret>`, DB에는 secret의 SHA-256만 저장한다.
//! - 소유자 토큰은 데이터 디렉터리의 `owner-token`(0600)에 둔다.
//! - 브라우저: 소유자/기기 토큰으로 로그인 → HttpOnly refresh 쿠키 + 메모리 전용 access token(서버 재시작 시 무효).

use crate::App;
use crate::error::{ApiError, ApiResult};
use crate::util::{ct_eq, fmt_time, new_id, parse_time, random_secret, sha256_hex};
use axum::Json;
use axum::extract::{FromRequestParts, Path, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;
use time::Duration;

pub const ACCESS_TTL: Duration = Duration::hours(1);
pub const REFRESH_TTL: Duration = Duration::days(30);
pub const REFRESH_COOKIE: &str = "grove_refresh";

#[derive(Debug, Clone, Serialize)]
pub struct Principal {
    /// 요청을 인증한 토큰 ID(브라우저면 브라우저 세션 ID)
    pub token_id: String,
    /// 소유 주체 ID(소유자 또는 기기 토큰). idempotency 범위로 쓴다.
    pub root_id: String,
    pub kind: String,
    pub is_owner: bool,
}

pub fn format_token(id: &str, secret: &str) -> String {
    format!("grv_{id}.{secret}")
}

pub fn parse_token(raw: &str) -> Option<(&str, &str)> {
    raw.strip_prefix("grv_")?.split_once('.')
}

/// 메모리 전용 브라우저 access token. 값: (브라우저 토큰 ID, 만료 시각)
#[derive(Default)]
pub struct AccessTokens {
    map: Mutex<HashMap<String, (String, time::OffsetDateTime)>>,
}

impl AccessTokens {
    pub fn issue(&self, browser_id: &str, now: time::OffsetDateTime) -> (String, time::OffsetDateTime) {
        let secret = random_secret(32);
        let exp = now + ACCESS_TTL;
        let mut m = self.map.lock().expect("access tokens");
        m.retain(|_, (_, e)| *e > now);
        m.insert(sha256_hex(secret.as_bytes()), (browser_id.to_string(), exp));
        (format!("gva_{secret}"), exp)
    }
    fn lookup(&self, raw: &str, now: time::OffsetDateTime) -> Option<String> {
        let secret = raw.strip_prefix("gva_")?;
        let m = self.map.lock().expect("access tokens");
        let (bid, exp) = m.get(&sha256_hex(secret.as_bytes()))?;
        (*exp > now).then(|| bid.clone())
    }
    pub fn revoke_browser(&self, browser_id: &str) {
        self.map.lock().expect("access tokens").retain(|_, (b, _)| b != browser_id);
    }
}

/// 토큰 행을 검증하고 상위 토큰이 살아 있는지 확인한다.
fn verify_row(conn: &Connection, id: &str, secret: Option<&str>, now: &str) -> ApiResult<Principal> {
    let row: Option<(String, String, Option<String>, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT kind, secret_hash, parent_id, expires_at, revoked_at FROM tokens WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let Some((kind, hash, parent, expires, revoked)) = row else {
        return Err(ApiError::unauthorized("알 수 없는 토큰입니다"));
    };
    if let Some(secret) = secret {
        if !ct_eq(sha256_hex(secret.as_bytes()).as_bytes(), hash.as_bytes()) {
            return Err(ApiError::unauthorized("토큰이 올바르지 않습니다"));
        }
    }
    if revoked.is_some() {
        return Err(ApiError::unauthorized("폐기된 토큰입니다"));
    }
    if let Some(exp) = expires {
        if exp.as_str() <= now {
            return Err(ApiError::unauthorized("만료된 토큰입니다"));
        }
    }
    let root_id = match (&kind[..], parent) {
        ("browser", Some(p)) => {
            let parent_ok: Option<(String, Option<String>)> = conn
                .query_row("SELECT kind, revoked_at FROM tokens WHERE id = ?1", params![p], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .optional()?;
            match parent_ok {
                Some((_, None)) => p,
                _ => return Err(ApiError::unauthorized("상위 기기 토큰이 폐기되었습니다")),
            }
        }
        _ => id.to_string(),
    };
    let is_owner = if kind == "owner" {
        true
    } else if kind == "browser" {
        conn.query_row("SELECT kind = 'owner' FROM tokens WHERE id = ?1", params![root_id], |r| r.get::<_, bool>(0))?
    } else {
        false
    };
    Ok(Principal { token_id: id.to_string(), root_id, kind, is_owner })
}

pub async fn authenticate(app: &App, headers: &HeaderMap) -> ApiResult<Principal> {
    let raw = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .ok_or_else(|| ApiError::unauthorized("Authorization: Bearer 토큰이 필요합니다"))?
        .to_string();
    let now = app.clock.now();
    let now_s = fmt_time(now);
    if raw.starts_with("gva_") {
        let bid = app.access.lookup(&raw, now).ok_or_else(|| ApiError::unauthorized("access token이 만료되었거나 무효입니다"))?;
        return app.db.call(move |c| verify_row(c, &bid, None, &now_s)).await;
    }
    let (id, secret) = parse_token(&raw).ok_or_else(|| ApiError::unauthorized("토큰 형식이 올바르지 않습니다"))?;
    let (id, secret) = (id.to_string(), secret.to_string());
    app.db
        .call(move |c| {
            let p = verify_row(c, &id, Some(&secret), &now_s)?;
            if p.kind == "browser" {
                // refresh 비밀은 Bearer로 쓸 수 없다.
                return Err(ApiError::unauthorized("브라우저 refresh 자격은 API 호출에 사용할 수 없습니다"));
            }
            c.execute("UPDATE tokens SET last_used_at = ?2 WHERE id = ?1", params![id, now_s])?;
            Ok(p)
        })
        .await
}

impl FromRequestParts<App> for Principal {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self, Self::Rejection> {
        if let Some(p) = parts.extensions.get::<Principal>() {
            return Ok(p.clone());
        }
        let p = authenticate(app, &parts.headers).await?;
        parts.extensions.insert(p.clone());
        Ok(p)
    }
}

/// 소유자 전용 작업용 추출기.
pub struct Owner(pub Principal);
impl FromRequestParts<App> for Owner {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self, Self::Rejection> {
        let p = Principal::from_request_parts(parts, app).await?;
        if !p.is_owner {
            return Err(ApiError::forbidden("소유자 권한이 필요합니다"));
        }
        Ok(Owner(p))
    }
}

/// 교차 사이트 요청과 DNS rebinding을 차단한다(SEC-002, SEC-004).
pub async fn origin_guard(State(app): State<App>, req: Request, next: Next) -> Response {
    if let Err(e) = check_origin(&app, req.headers()) {
        return e.into_response();
    }
    next.run(req).await
}

pub fn check_origin(app: &App, headers: &HeaderMap) -> ApiResult<()> {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !app.cfg.host_allowed(host) {
        return Err(ApiError::forbidden(format!("허용되지 않은 Host입니다: {host}")));
    }
    if let Some(site) = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        if site == "cross-site" {
            return Err(ApiError::forbidden("교차 사이트 요청은 허용되지 않습니다"));
        }
    }
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        let same = origin == format!("http://{host}") || origin == format!("https://{host}");
        if !same && !app.cfg.allowed_origins.iter().any(|o| o == origin) {
            return Err(ApiError::forbidden(format!("허용되지 않은 origin입니다: {origin}")));
        }
    }
    Ok(())
}

// ---------- 시작 시 소유자 토큰 ----------

/// 소유자 토큰 파일과 DB를 맞춘다. 파일이 없거나 무효면 새로 발급하고 기존 소유자 토큰은 폐기한다.
pub fn ensure_owner_token(app: &App) -> ApiResult<String> {
    let path = app.cfg.data_dir.join("owner-token");
    let now = fmt_time(app.clock.now());
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim().to_string();
        if let Some((id, secret)) = parse_token(&existing) {
            let ok = app.db.call_sync(|c| verify_row(c, id, Some(secret), &now).map(|p| p.kind == "owner"));
            if matches!(ok, Ok(true)) {
                return Ok(existing);
            }
        }
    }
    let id = new_id();
    let secret = random_secret(32);
    app.db.call_sync(|c| {
        let tx = c.transaction()?;
        tx.execute("UPDATE tokens SET revoked_at = ?1 WHERE kind = 'owner' AND revoked_at IS NULL", params![now])?;
        tx.execute(
            "INSERT INTO tokens (id, kind, name, secret_hash, created_at) VALUES (?1, 'owner', 'owner', ?2, ?3)",
            params![id, sha256_hex(secret.as_bytes()), now],
        )?;
        tx.commit()?;
        Ok(())
    })?;
    let token = format_token(&id, &secret);
    write_secret_file(&path, &token).map_err(|e| ApiError::internal(format!("owner-token 기록 실패: {e}")))?;
    Ok(token)
}

pub fn write_secret_file(path: &std::path::Path, content: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    #[cfg(not(unix))]
    std::fs::write(&tmp, content)?;
    std::fs::rename(tmp, path)
}

// ---------- 기기 토큰 API (NET-018) ----------

#[derive(Serialize, ts_rs::TS)]
pub struct DeviceInfo {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub revoked_at: Option<String>,
    pub parent_id: Option<String>,
    pub expires_at: Option<String>,
    pub current: bool,
}

#[derive(Deserialize)]
pub struct CreateDevice {
    pub name: String,
}

pub async fn create_device(
    State(app): State<App>,
    Owner(p): Owner,
    headers: HeaderMap,
    Json(body): Json<CreateDevice>,
) -> ApiResult<Response> {
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(ApiError::invalid("기기 이름은 1~80자여야 합니다"));
    }
    let req_hash = sha256_hex(name.as_bytes());
    let actor = p.clone();
    crate::idem::run_redacted(&app, &p, &headers, &req_hash, &["token"], move |tx, now| {
        let id = new_id();
        let secret = random_secret(32);
        tx.execute(
            "INSERT INTO tokens (id, kind, name, secret_hash, created_at) VALUES (?1, 'device', ?2, ?3, ?4)",
            params![id, name, sha256_hex(secret.as_bytes()), now],
        )?;
        crate::events::append(tx, now, "device.created", None, None, &json!({ "id": id, "name": name }))?;
        crate::audit::record(tx, now, &actor, "device.created", &id, json!({ "name": name }))?;
        // 토큰 원문은 이 응답에서만 한 번 보여준다. idempotency 저장본에는 넣지 않는다.
        Ok((StatusCode::CREATED, json!({ "id": id, "name": name, "token": format_token(&id, &secret) })))
    })
    .await
}

pub async fn list_devices(State(app): State<App>, Owner(p): Owner) -> ApiResult<Json<Vec<DeviceInfo>>> {
    let cur = p.token_id.clone();
    let list = app
        .db
        .call(move |c| {
            let mut s = c.prepare(
                "SELECT id, kind, name, created_at, last_used_at, revoked_at, parent_id, expires_at FROM tokens ORDER BY created_at",
            )?;
            let rows = s.query_map([], |r| {
                Ok(DeviceInfo {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    name: r.get(2)?,
                    created_at: r.get(3)?,
                    last_used_at: r.get(4)?,
                    revoked_at: r.get(5)?,
                    parent_id: r.get(6)?,
                    expires_at: r.get(7)?,
                    current: false,
                })
            })?;
            let mut v = rows.collect::<Result<Vec<_>, _>>()?;
            for d in &mut v {
                d.current = d.id == cur;
            }
            Ok(v)
        })
        .await?;
    Ok(Json(list))
}

pub async fn revoke_device(
    State(app): State<App>,
    Owner(p): Owner,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let req_hash = sha256_hex(format!("revoke:{id}").as_bytes());
    let access = app.access.clone();
    let id2 = id.clone();
    let actor = p.clone();
    let resp = crate::idem::run(&app, &p, &headers, &req_hash, move |tx, now| {
        let kind: Option<String> =
            tx.query_row("SELECT kind FROM tokens WHERE id = ?1", params![id], |r| r.get(0)).optional()?;
        match kind.as_deref() {
            None => return Err(ApiError::not_found("토큰이 없습니다")),
            Some("owner") => return Err(ApiError::forbidden("소유자 토큰은 여기서 폐기할 수 없습니다")),
            _ => {}
        }
        tx.execute(
            "UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?2) WHERE id = ?1 OR parent_id = ?1",
            params![id, now],
        )?;
        crate::events::append(tx, now, "device.revoked", None, None, &json!({ "id": id }))?;
        crate::audit::record(tx, now, &actor, "device.revoked", &id, json!({ "kind": kind }))?;
        Ok((StatusCode::OK, json!({ "id": id, "revoked": true })))
    })
    .await?;
    // 폐기된 브라우저 세션의 메모리 access token도 무효화
    let children: Vec<String> = app
        .db
        .call(move |c| {
            let mut s = c.prepare("SELECT id FROM tokens WHERE id = ?1 OR parent_id = ?1")?;
            let v = s.query_map(params![id2], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            Ok(v)
        })
        .await?;
    for c in children {
        access.revoke_browser(&c);
    }
    Ok(resp)
}

// ---------- 브라우저 로그인 (SEC-004, WEB-006) ----------

#[derive(Deserialize)]
pub struct BrowserLogin {
    pub token: String,
    pub name: Option<String>,
}

fn refresh_cookie(app: &App, value: &str, max_age: i64) -> HeaderValue {
    let secure = if app.cfg.tls_terminated { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{REFRESH_COOKIE}={value}; HttpOnly; SameSite=Strict; Path=/api/v1/auth; Max-Age={max_age}{secure}"
    ))
    .expect("cookie header")
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')).find_map(|kv| {
        let (k, v) = kv.trim().split_once('=')?;
        (k == name).then(|| v.to_string())
    })
}

/// 같은 클라이언트의 로그인 실패 한도와 잠금 시간(NET-021: 기존 5회 정책 유지).
pub const LOGIN_MAX_FAILURES: i64 = 5;
pub const LOGIN_WINDOW: Duration = Duration::minutes(15);
pub const LOGIN_LOCK: Duration = Duration::minutes(15);

fn client_key(req: &Request) -> String {
    req.extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|c| c.0.ip().to_string())
        .unwrap_or_else(|| "unknown".into())
}

/// 잠금 상태 확인. 잠겨 있으면 남은 시간을 담은 오류.
fn check_lock(c: &Connection, client: &str, now: &str) -> ApiResult<()> {
    let until: Option<Option<String>> =
        c.query_row("SELECT locked_until FROM login_failures WHERE client = ?1", params![client], |r| r.get(0)).optional()?;
    if let Some(Some(u)) = until {
        if u.as_str() > now {
            return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "locked", "로그인 실패가 많아 잠시 잠겼습니다. 서버에서 `grove unlock`으로 해제할 수 있습니다")
                .with_details(json!({ "locked_until": u })));
        }
    }
    Ok(())
}

fn record_failure(c: &Connection, client: &str, now: time::OffsetDateTime) -> ApiResult<()> {
    let now_s = fmt_time(now);
    let window_start = fmt_time(now - LOGIN_WINDOW);
    let row: Option<(i64, String)> =
        c.query_row("SELECT count, first_at FROM login_failures WHERE client = ?1", params![client], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let (count, first) = match row {
        Some((n, f)) if f >= window_start => (n + 1, f),
        _ => (1, now_s.clone()),
    };
    let locked = (count >= LOGIN_MAX_FAILURES).then(|| fmt_time(now + LOGIN_LOCK));
    c.execute(
        "INSERT INTO login_failures (client, count, first_at, locked_until) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(client) DO UPDATE SET count = ?2, first_at = ?3, locked_until = ?4",
        params![client, if locked.is_some() { 0 } else { count }, first, locked],
    )?;
    Ok(())
}

/// 로컬 복구 경로: 서버 PC에서 모든 로그인 잠금을 해제한다.
pub fn clear_lockouts(c: &Connection) -> ApiResult<usize> {
    Ok(c.execute("DELETE FROM login_failures", [])?)
}

pub async fn browser_login(State(app): State<App>, req: Request) -> ApiResult<Response> {
    let headers = req.headers().clone();
    check_origin(&app, &headers)?;
    let client = client_key(&req);
    let bytes = axum::body::to_bytes(req.into_body(), 64 * 1024).await.map_err(|_| ApiError::invalid("요청 본문이 너무 큽니다"))?;
    let body: BrowserLogin = serde_json::from_slice(&bytes).map_err(|e| ApiError::invalid(format!("JSON 형식 오류: {e}")))?;
    let now = app.clock.now();
    let now_s = fmt_time(now);
    {
        let (client, now_s) = (client.clone(), now_s.clone());
        app.db.call(move |c| check_lock(c, &client, &now_s)).await?;
    }
    let Some((id, secret)) = parse_token(body.token.trim()).map(|(a, b)| (a.to_string(), b.to_string())) else {
        let client = client.clone();
        app.db.call(move |c| record_failure(c, &client, now)).await?;
        return Err(ApiError::unauthorized("토큰 형식이 올바르지 않습니다"));
    };
    let exp_s = fmt_time(now + REFRESH_TTL);
    let name = body.name.unwrap_or_else(|| "browser".into()).chars().take(80).collect::<String>();
    let client2 = client.clone();
    let result = app
        .db
        .call(move |c| {
            let p = match verify_row(c, &id, Some(&secret), &now_s) {
                Ok(p) => p,
                Err(e) => {
                    record_failure(c, &client2, now)?;
                    return Err(e);
                }
            };
            c.execute("DELETE FROM login_failures WHERE client = ?1", params![client2])?;
            if p.kind == "browser" {
                return Err(ApiError::unauthorized("브라우저 세션으로 다시 로그인할 수 없습니다"));
            }
            let bid = new_id();
            let refresh = random_secret(32);
            c.execute(
                "INSERT INTO tokens (id, kind, name, secret_hash, parent_id, created_at, expires_at) VALUES (?1, 'browser', ?2, ?3, ?4, ?5, ?6)",
                params![bid, name, sha256_hex(refresh.as_bytes()), p.token_id, now_s, exp_s],
            )?;
            Ok((bid, refresh))
        })
        .await;
    let (bid, refresh) = result?;
    let (access, exp) = app.access.issue(&bid, now);
    let mut resp = Json(json!({ "access_token": access, "expires_at": fmt_time(exp), "browser_session_id": bid })).into_response();
    resp.headers_mut().insert(header::SET_COOKIE, refresh_cookie(&app, &format_token(&bid, &refresh), REFRESH_TTL.whole_seconds()));
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(resp)
}

/// refresh 쿠키로 새 access token을 받는다. refresh 비밀은 매번 교체한다.
pub async fn browser_refresh(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    check_origin(&app, &headers)?;
    let raw = cookie_value(&headers, REFRESH_COOKIE).ok_or_else(|| ApiError::unauthorized("로그인이 필요합니다"))?;
    let (id, secret) = parse_token(&raw).ok_or_else(|| ApiError::unauthorized("로그인이 필요합니다"))?;
    let (id, secret) = (id.to_string(), secret.to_string());
    let now = app.clock.now();
    let now_s = fmt_time(now);
    let (bid, refresh, expires_at) = app
        .db
        .call(move |c| {
            let p = verify_row(c, &id, Some(&secret), &now_s)?;
            if p.kind != "browser" {
                return Err(ApiError::unauthorized("브라우저 세션이 아닙니다"));
            }
            let refresh = random_secret(32);
            let n = c.execute(
                "UPDATE tokens SET secret_hash = ?2, last_used_at = ?3 WHERE id = ?1 AND secret_hash = ?4",
                params![id, sha256_hex(refresh.as_bytes()), now_s, sha256_hex(secret.as_bytes())],
            )?;
            if n != 1 {
                return Err(ApiError::unauthorized("동시에 갱신되었습니다. 다시 로그인하세요"));
            }
            let exp: Option<String> = c.query_row("SELECT expires_at FROM tokens WHERE id = ?1", params![id], |r| r.get(0))?;
            Ok((id, refresh, exp))
        })
        .await?;
    // refresh 만료 시각은 고정(최초 로그인 기준). 남은 시간만큼 쿠키 유지.
    let remaining = expires_at.as_deref().and_then(parse_time).map(|e| (e - now).whole_seconds()).unwrap_or(0).max(0);
    let (access, exp) = app.access.issue(&bid, now);
    let mut resp = Json(json!({ "access_token": access, "expires_at": fmt_time(exp), "browser_session_id": bid })).into_response();
    resp.headers_mut().insert(header::SET_COOKIE, refresh_cookie(&app, &format_token(&bid, &refresh), remaining));
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(resp)
}

pub async fn browser_logout(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    check_origin(&app, &headers)?;
    if let Some(raw) = cookie_value(&headers, REFRESH_COOKIE) {
        if let Some((id, _)) = parse_token(&raw) {
            let id = id.to_string();
            let now = fmt_time(app.clock.now());
            let id2 = id.clone();
            app.db
                .call(move |c| {
                    c.execute(
                        "UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?2) WHERE id = ?1 AND kind = 'browser'",
                        params![id2, now],
                    )?;
                    Ok(())
                })
                .await?;
            app.access.revoke_browser(&id);
        }
    }
    let mut resp = Json(json!({ "logged_out": true })).into_response();
    resp.headers_mut().insert(header::SET_COOKIE, refresh_cookie(&app, "", 0));
    Ok(resp)
}

pub async fn whoami(p: Principal) -> Json<Principal> {
    Json(p)
}
