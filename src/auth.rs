//! 인증·origin 검사·기기 토큰·브라우저 로그인.
//!
//! - 모든 `/api` 요청은 loopback이어도 Bearer 토큰이 필요하다(SEC-002). 예외: health, 브라우저 로그인/갱신.
//! - 토큰 형식 `grv_<id>.<secret>`, DB에는 secret의 SHA-256만 저장한다.
//! - 기존 `owner-token` 파일은 로컬 데몬 관리용 자격이다. 브라우저 로그인이나 암호화 원격 API에는 사용할 수 없다.
//! - 브라우저는 페어링으로 HttpOnly refresh 쿠키와 메모리 전용 access token을 받는다.

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
    /// 등록 기기 또는 로컬 관리 주체의 ID. idempotency 범위로 쓴다.
    pub root_id: String,
    pub kind: String,
    /// 티켓·장기 연결도 발급 당시 access 자격의 수명 이상으로 권한을 연장하지 않는다.
    #[serde(skip)]
    valid_until: Option<time::OffsetDateTime>,
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
    fn lookup(&self, raw: &str, now: time::OffsetDateTime) -> Option<(String, time::OffsetDateTime)> {
        let secret = raw.strip_prefix("gva_")?;
        let m = self.map.lock().expect("access tokens");
        let (bid, exp) = m.get(&sha256_hex(secret.as_bytes()))?;
        (*exp > now).then(|| (bid.clone(), *exp))
    }
    pub fn revoke_browser(&self, browser_id: &str) {
        self.map.lock().expect("access tokens").retain(|_, (b, _)| b != browser_id);
    }
}

/// 토큰 행을 검증하고 상위 토큰이 살아 있는지 확인한다.
pub(crate) fn verify_row(conn: &Connection, id: &str, secret: Option<&str>, now: &str) -> ApiResult<Principal> {
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
    if let Some(exp) = &expires {
        if exp.as_str() <= now {
            return Err(ApiError::unauthorized("만료된 토큰입니다"));
        }
    }
    let mut valid_until = expires.as_deref().and_then(parse_time);
    let root_id = match (&kind[..], parent) {
        ("browser", Some(p)) => {
            let parent_ok: Option<(String, Option<String>, Option<String>)> = conn
                .query_row("SELECT t.kind,t.revoked_at,t.expires_at FROM tokens t WHERE t.id=?1 AND EXISTS(SELECT 1 FROM pairings WHERE device_id=t.id AND consumed_at IS NOT NULL)", params![p], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .optional()?;
            match parent_ok {
                Some((kind, None, exp)) if kind == "device"
                    && exp.as_deref().is_none_or(|e| e > now) => {
                    valid_until = valid_until.into_iter().chain(exp.as_deref().and_then(parse_time)).min();
                    p
                }
                _ => return Err(ApiError::unauthorized("상위 기기 토큰이 만료되었거나 폐기되었습니다")),
            }
        }
        ("owner" | "device", None) => id.to_string(),
        _ => return Err(ApiError::unauthorized("토큰의 권한 계층이 올바르지 않습니다")),
    };
    Ok(Principal { token_id: id.to_string(), root_id, kind, valid_until })
}

/// 이미 인증한 주체를 현재 DB 상태와 다시 대조한다. 원문 토큰을 티켓에 보관하지 않는다.
pub(crate) fn check_principal(conn: &Connection, p: &Principal, now: &str) -> ApiResult<Option<time::OffsetDateTime>> {
    let current = verify_row(conn, &p.token_id, None, now)?;
    if current.root_id != p.root_id || current.kind != p.kind {
        return Err(ApiError::unauthorized("인증 주체의 권한이 변경되었습니다"));
    }
    let until = p.valid_until.into_iter().chain(current.valid_until).min();
    if until.is_some_and(|exp| fmt_time(exp).as_str() <= now) {
        return Err(ApiError::unauthorized("연결 자격이 만료되었습니다"));
    }
    Ok(until)
}

pub(crate) async fn revalidate(app: &App, p: &Principal) -> ApiResult<Option<time::OffsetDateTime>> {
    let (p, now) = (p.clone(), app.now());
    app.db.call(move |c| check_principal(c, &p, &now)).await
}

/// 폐기·로그아웃 알림과 자격의 고정 만료 시각을 기다린다. idle 연결에도 적용한다.
pub(crate) async fn wait_until_invalid(app: App, p: Principal) -> ApiError {
    let mut changed = app.auth_tx.subscribe();
    loop {
        let until = match revalidate(&app, &p).await {
            Ok(until) => until,
            Err(error) => return error,
        };
        let expiry = async {
            match until {
                Some(exp) => tokio::time::sleep((exp - app.clock.now()).try_into().unwrap_or_default()).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            _ = changed.changed() => {}
            _ = expiry => {}
        }
    }
}

pub async fn authenticate(app: &App, headers: &HeaderMap) -> ApiResult<Principal> {
    authenticate_request(app, headers, false).await
}

async fn authenticate_request(app: &App, headers: &HeaderMap, local: bool) -> ApiResult<Principal> {
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
        let (bid, exp) = app.access.lookup(&raw, now).ok_or_else(|| ApiError::unauthorized("access token이 만료되었거나 무효입니다"))?;
        return app.db.call(move |c| {
            let mut p = verify_row(c, &bid, None, &now_s)?;
            p.valid_until = p.valid_until.into_iter().chain(Some(exp)).min();
            Ok(p)
        }).await;
    }
    if !local {
        return Err(ApiError::unauthorized("기기 페어링이 필요합니다"));
    }
    let (id, secret) = parse_token(&raw).ok_or_else(|| ApiError::unauthorized("토큰 형식이 올바르지 않습니다"))?;
    let (id, secret) = (id.to_string(), secret.to_string());
    app.db
        .call(move |c| {
            let p = verify_row(c, &id, Some(&secret), &now_s)?;
            if p.kind != "owner" {
                return Err(ApiError::unauthorized("기기 페어링이 필요합니다"));
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
        let local = parts.extensions.get::<crate::e2ee::Encrypted>().is_none()
            && parts.extensions.get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                .is_some_and(|peer| peer.ip().is_loopback())
            && !parts.headers.contains_key(header::ORIGIN)
            && !parts.headers.contains_key("sec-fetch-site");
        let p = if local {
            authenticate_request(app, &parts.headers, true).await?
        } else {
            authenticate(app, &parts.headers).await?
        };
        parts.extensions.insert(p.clone());
        Ok(p)
    }
}

/// 교차 사이트 요청과 DNS rebinding을 차단한다(SEC-002, SEC-004).
pub async fn origin_guard(State(app): State<App>, req: Request, next: Next) -> Response {
    if req.extensions().get::<crate::e2ee::Encrypted>().is_some() {
        return next.run(req).await;
    }
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
        // TLS 종료는 운영자가 명시한다. 요청자가 보낸 forwarded 헤더로 신뢰 경계를 바꾸지 않는다.
        let scheme = if app.cfg.tls_terminated { "https" } else { "http" };
        let same = origin == format!("{scheme}://{host}");
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

pub async fn current_device(State(app): State<App>, p: Principal) -> ApiResult<Json<serde_json::Value>> {
    let id = p.root_id;
    let device = app.db.call(move |c| {
        let name: String = c.query_row("SELECT name FROM tokens WHERE id = ?1", params![id], |r| r.get(0))?;
        Ok(json!({ "id": id, "name": name }))
    }).await?;
    Ok(Json(device))
}

pub async fn rename_current_device(
    State(app): State<App>, p: Principal, headers: HeaderMap, Json(body): Json<CreateDevice>,
) -> ApiResult<Response> {
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(ApiError::invalid("기기 이름은 1~80자여야 합니다"));
    }
    let req_hash = sha256_hex(format!("rename-current:{name}").as_bytes());
    let actor = p.clone();
    let id = p.root_id.clone();
    crate::idem::run(&app, &p, &headers, &req_hash, move |tx, now| {
        tx.execute("UPDATE tokens SET name = ?2 WHERE id = ?1", params![id, name])?;
        crate::events::append(tx, now, "device.updated", None, None, &json!({ "id": id }))?;
        crate::audit::record(tx, now, &actor, "device.updated", &id, json!({ "name": name }))?;
        Ok((StatusCode::OK, json!({ "id": id, "name": name })))
    }).await
}

pub async fn list_devices(State(app): State<App>, p: Principal) -> ApiResult<Json<Vec<DeviceInfo>>> {
    let cur = p.token_id.clone();
    let list = app
        .db
        .call(move |c| {
            let mut s = c.prepare(
                "SELECT id, kind, name, created_at, last_used_at, revoked_at, parent_id, expires_at FROM tokens t WHERE kind IN ('device','browser') AND EXISTS(SELECT 1 FROM pairings WHERE device_id=COALESCE(t.parent_id,t.id) AND consumed_at IS NOT NULL) ORDER BY created_at",
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
    p: Principal,
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
            Some("owner") => return Err(ApiError::not_found("등록 기기가 아닙니다")),
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
    app.auth_tx.send_replace(());
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

fn refresh_cookie_name(headers: &HeaderMap) -> String {
    // 쿠키는 port를 구분하지 않는다. 같은 hostname의 서로 다른 Grove 서버가 덮어쓰지 않게 한다.
    let authority = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    format!("{REFRESH_COOKIE}_{}", &sha256_hex(authority.as_bytes())[..16])
}

fn refresh_cookie(app: &App, headers: &HeaderMap, value: &str, max_age: i64) -> HeaderValue {
    let secure = if app.cfg.tls_terminated { "; Secure" } else { "" };
    let name = refresh_cookie_name(headers);
    HeaderValue::from_str(&format!(
        "{name}={value}; HttpOnly; SameSite=Strict; Path=/api/v1/auth; Max-Age={max_age}{secure}"
    ))
    .expect("cookie header")
}

pub(crate) fn browser_session_response(app: &App, headers: &HeaderMap, bid: &str, refresh: &str, max_age: i64) -> Response {
    let (access, exp) = app.access.issue(bid, app.clock.now());
    let mut resp = Json(json!({ "access_token": access, "expires_at": fmt_time(exp), "browser_session_id": bid })).into_response();
    resp.headers_mut().insert(header::SET_COOKIE, refresh_cookie(app, headers, &format_token(bid, refresh), max_age));
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')).find_map(|kv| {
        let (k, v) = kv.trim().split_once('=')?;
        (k == name).then(|| v.to_string())
    })
}

fn refresh_key(headers: &HeaderMap) -> ApiResult<Option<String>> {
    headers.contains_key(crate::idem::HEADER).then(|| crate::idem::key_from(headers)).transpose()
}

/// 살아 있는 브라우저·부모를 먼저 검증한다. 이전 비밀은 직전 요청 ID와 함께만 재생할 수 있다.
fn verify_refresh(c: &Connection, id: &str, secret: &str, key: Option<&str>, now: &str) -> ApiResult<()> {
    let p = verify_row(c, id, None, now)?;
    if p.kind != "browser" {
        return Err(ApiError::unauthorized("브라우저 세션이 아닙니다"));
    }
    let hash: String = c.query_row("SELECT secret_hash FROM tokens WHERE id=?1", [id], |r| r.get(0))?;
    let presented = sha256_hex(secret.as_bytes());
    if ct_eq(hash.as_bytes(), presented.as_bytes()) {
        return Ok(());
    }
    if let Some(key) = key {
        let previous: Option<String> = c.query_row(
            "SELECT previous_hash FROM browser_refresh_receipts WHERE browser_id=?1 AND request_key=?2",
            params![id, key], |r| r.get(0),
        ).optional()?;
        if previous.is_some_and(|old| ct_eq(old.as_bytes(), presented.as_bytes())) {
            return Ok(());
        }
    }
    Err(ApiError::unauthorized("토큰이 올바르지 않습니다"))
}

/// 비밀 회전과 재생 결과는 함께 commit한다. 갱신 성공부터 30일 동안 다시 로그인하지 않아도 된다.
pub async fn browser_refresh(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    check_origin(&app, &headers)?;
    let raw = cookie_value(&headers, &refresh_cookie_name(&headers))
        .or_else(|| cookie_value(&headers, REFRESH_COOKIE))
        .ok_or_else(|| ApiError::unauthorized("로그인이 필요합니다"))?;
    let (id, secret) = parse_token(&raw).ok_or_else(|| ApiError::unauthorized("로그인이 필요합니다"))?;
    let (id, secret) = (id.to_string(), secret.to_string());
    let key = refresh_key(&headers)?;
    let now = app.clock.now();
    let now_s = fmt_time(now);
    let (bid, refresh, expires_at) = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            verify_refresh(&tx, &id, &secret, key.as_deref(), &now_s)?;
            if let Some(key) = &key {
                let replay: Option<String> = tx.query_row(
                    "SELECT grove_decrypt(next_secret) FROM browser_refresh_receipts WHERE browser_id=?1 AND request_key=?2",
                    params![id, key], |r| r.get(0),
                ).optional()?;
                if let Some(refresh) = replay {
                    let exp: Option<String> = tx.query_row("SELECT expires_at FROM tokens WHERE id=?1", [&id], |r| r.get(0))?;
                    tx.commit()?;
                    return Ok((id, refresh, exp));
                }
            }
            let refresh = random_secret(32);
            let expires = fmt_time(now + REFRESH_TTL);
            tx.execute(
                "UPDATE tokens SET secret_hash=?2,last_used_at=?3,expires_at=?4 WHERE id=?1",
                params![id, sha256_hex(refresh.as_bytes()), now_s, expires],
            )?;
            tx.execute("DELETE FROM browser_refresh_receipts WHERE browser_id=?1", [&id])?;
            if let Some(key) = key {
                tx.execute(
                    "INSERT INTO browser_refresh_receipts(browser_id,request_key,previous_hash,next_secret) VALUES(?1,?2,?3,grove_encrypt(?4))",
                    params![id, key, sha256_hex(secret.as_bytes()), refresh],
                )?;
            }
            tx.commit()?;
            Ok((id, refresh, Some(expires)))
        })
        .await?;
    // 재생은 만료를 더 연장하지 않는다.
    let remaining = expires_at.as_deref().and_then(parse_time).map(|e| (e - now).whole_seconds()).unwrap_or(0).max(0);
    Ok(browser_session_response(&app, &headers, &bid, &refresh, remaining))
}

pub async fn browser_logout(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    check_origin(&app, &headers)?;
    let key = refresh_key(&headers)?;
    if let Some(raw) = cookie_value(&headers, &refresh_cookie_name(&headers)).or_else(|| cookie_value(&headers, REFRESH_COOKIE)) {
        if let Some((id, secret)) = parse_token(&raw) {
            let (id, secret) = (id.to_string(), secret.to_string());
            let now = fmt_time(app.clock.now());
            let id2 = id.clone();
            app.db
                .call(move |c| {
                    let tx = c.transaction()?;
                    verify_refresh(&tx, &id2, &secret, key.as_deref(), &now)?;
                    tx.execute(
                        "UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?2) WHERE id = ?1 AND kind = 'browser'",
                        params![id2, now],
                    )?;
                    tx.execute("DELETE FROM browser_refresh_receipts WHERE browser_id=?1", [&id2])?;
                    tx.commit()?;
                    Ok(())
                })
                .await?;
            app.auth_tx.send_replace(());
            app.access.revoke_browser(&id);
        }
    }
    let mut resp = Json(json!({ "logged_out": true })).into_response();
    resp.headers_mut().insert(header::SET_COOKIE, refresh_cookie(&app, &headers, "", 0));
    Ok(resp)
}

pub async fn whoami(p: Principal) -> Json<Principal> {
    Json(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::Clock;
    use std::sync::Arc;
    use time::OffsetDateTime;

    struct ManualClock(Mutex<OffsetDateTime>);
    impl Clock for ManualClock {
        fn now(&self) -> OffsetDateTime { *self.0.lock().unwrap() }
    }

    #[tokio::test]
    async fn access_expiry_is_not_extended_by_refresh_for_existing_tickets_or_connections() {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(ManualClock(Mutex::new(OffsetDateTime::now_utc())));
        let cfg = crate::config::Config {
            data_dir: dir.path().to_path_buf(), listen: "127.0.0.1:0".parse().unwrap(),
            allowed_origins: vec![], allowed_hosts: vec![], tls_terminated: false, web_dir: None,
            web_base: "/".into(),
            approval_ttl_secs: 1800, scheduler_tick_ms: 100, remote_watch_insecure_loopback: false, gh_command: "gh".into(),
        };
        let app = App::new(cfg, clock.clone()).unwrap();
        let local = ensure_owner_token(&app).unwrap();
        let issuer = parse_token(&local).unwrap().0.to_owned();
        let parent = new_id();
        let browser_id = new_id();
        let (bid, now) = (browser_id.clone(), app.now());
        app.db.call(move |c| {
            c.execute("INSERT INTO tokens (id,kind,name,secret_hash,created_at) VALUES (?1,'device','test',?2,?3)",
                params![parent, sha256_hex(random_secret(32).as_bytes()), now])?;
            c.execute("INSERT INTO pairings(id,name,secret_hash,issuer_id,created_at,device_id,consumed_at) VALUES(?1,'test','unused',?2,?3,?4,?3)",
                params![new_id(), issuer, now, parent])?;
            c.execute("INSERT INTO tokens (id,kind,name,secret_hash,parent_id,created_at) VALUES (?1,'browser','expiry',?2,?3,?4)",
                params![bid, sha256_hex(b"test-refresh-secret"), parent, now])?;
            Ok(())
        }).await.unwrap();
        let (access, _) = app.access.issue(&browser_id, clock.now());
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, format!("Bearer {access}").parse().unwrap());
        let old = authenticate(&app, &headers).await.unwrap();
        assert!(revalidate(&app, &old).await.is_ok());
        *clock.0.lock().unwrap() += ACCESS_TTL + Duration::seconds(1);
        let (fresh, _) = app.access.issue(&browser_id, clock.now());
        headers.insert(header::AUTHORIZATION, format!("Bearer {fresh}").parse().unwrap());
        let new = authenticate(&app, &headers).await.unwrap();
        assert!(revalidate(&app, &new).await.is_ok());
        assert_eq!(revalidate(&app, &old).await.unwrap_err().status, StatusCode::UNAUTHORIZED);
        tokio::time::timeout(std::time::Duration::from_secs(1), wait_until_invalid(app, old))
            .await.expect("이전 access로 열린 연결은 갱신된 access의 수명을 빌릴 수 없다");
    }
}
