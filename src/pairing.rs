//! 서버 발급 비밀번호와 기기 등록용 링크 비밀번호를 분리한다.

pub(crate) mod issuance;
pub use issuance::set_password as set_issuance_password;

use crate::App;
use crate::auth::{self, Principal};
use crate::error::{ApiError, ApiResult};
use crate::util::{ct_eq, fmt_time, new_id, random_secret, sha256_hex};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use ring::pbkdf2;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::num::NonZeroU32;
use time::Duration;

const MAX_PENDING: i64 = 20;
const MAX_FAILURES: i64 = 5;
const REQUEST_TTL: Duration = Duration::minutes(15);
const PASSWORD_ITERATIONS: NonZeroU32 = NonZeroU32::new(600_000).unwrap();
// 비밀번호 연산이 DB 잠금이나 무제한 blocking 작업으로 이어지지 않게 한다.
static PASSWORD_WORK: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Serialize, ts_rs::TS)]
pub struct PairingRequestInfo {
    pub id: String,
    pub name: String,
    pub verification_code: String,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Serialize, ts_rs::TS)]
pub struct PairingInfo {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
    pub consumed_at: Option<String>,
    pub device_id: Option<String>,
    pub failed_attempts: i64,
    pub locked_at: Option<String>,
    pub requests: Vec<PairingRequestInfo>,
}

#[derive(Deserialize)]
pub struct CreatePairing {
    pub name: String,
    pub password: String,
    #[serde(default)]
    pub issuance_password: String,
    pub replace_id: Option<String>,
}

fn device_name(value: &str) -> ApiResult<String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(ApiError::invalid("기기 이름은 1~80자여야 합니다"));
    }
    Ok(name.to_string())
}

async fn password_hash(password: String, salt: String) -> ApiResult<Vec<u8>> {
    let permit = PASSWORD_WORK.acquire().await.expect("password semaphore");
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut hash = vec![0; 32];
        pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, PASSWORD_ITERATIONS, salt.as_bytes(), password.as_bytes(), &mut hash);
        hash
    }).await.map_err(|_| ApiError::internal("pairing password task"))
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn unavailable() -> ApiError {
    ApiError::new(StatusCode::GONE, "pairing_unavailable", "페어링 링크가 만료됐거나 이미 사용됐어요. 새 링크를 발급받으세요.")
}

fn locked() -> ApiError {
    ApiError::new(StatusCode::LOCKED, "pairing_locked", "비밀번호를 5번 틀려 링크가 잠겼어요. 새 링크를 발급받으세요.")
}

struct Link {
    issuer: String,
    password_hash: Vec<u8>,
    salt: String,
}

fn active_link(c: &Connection, id: &str, secret: &str, now: &str) -> ApiResult<Link> {
    let row = c.query_row(
        "SELECT name,issuer_id,password_hash,password_salt,secret_hash,expires_at,revoked_at,consumed_at,locked_at FROM pairings WHERE id=?1",
        [id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<Vec<u8>>>(2)?,
            r.get::<_, Option<String>>(3)?, r.get::<_, String>(4)?, r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<String>>(6)?, r.get::<_, Option<String>>(7)?, r.get::<_, Option<String>>(8)?)),
    ).optional()?;
    let Some((_name, issuer, hash, salt, link_hash, expires, revoked, consumed, lock)) = row else { return Err(unavailable()); };
    if !ct_eq(sha256_hex(secret.as_bytes()).as_bytes(), link_hash.as_bytes())
        || expires.as_deref().is_some_and(|deadline| deadline <= now) || revoked.is_some() || consumed.is_some()
    {
        return Err(unavailable());
    }
    if lock.is_some() { return Err(locked()); }
    let (Some(password_hash), Some(salt)) = (hash, salt) else { return Err(unavailable()); };
    auth::verify_row(c, &issuer, None, now).map_err(|_| unavailable())?;
    Ok(Link { issuer, password_hash, salt })
}

pub async fn create(
    State(app): State<App>, p: Principal, headers: HeaderMap, Json(body): Json<CreatePairing>,
) -> ApiResult<Response> {
    let name = device_name(&body.name)?;
    if body.password.chars().count() < 10 || body.password.len() > 256 {
        return Err(ApiError::invalid("비밀번호는 10자 이상, 256바이트 이하여야 합니다"));
    }
    // 등록 기기·요청 키마다 고유한 salt. 재전송 hash에도 빠른 비밀번호 hash를 남기지 않는다.
    let salt = format!("grove-pairing:{}:{}", p.root_id, crate::idem::key_from(&headers)?);
    // 발급·재발급·재전송 모두 검증한다. 발급 비밀번호는 idempotency 입력에도 남기지 않는다.
    let link_password = app.pairing_issuance.verify(body.issuance_password, body.password).await?;
    let password = password_hash(link_password, salt.clone()).await?;
    let hash = crate::idem::body_hash("pairing.create", &json!({ "name": name, "replace_id": body.replace_id, "password": password }));
    let issuer = p.root_id.clone();
    let response = crate::idem::run_redacted(&app, &p.clone(), &headers, &hash, &["code"], move |tx, now| {
        if let Some(id) = body.replace_id {
            let n = tx.execute("UPDATE pairings SET revoked_at=COALESCE(revoked_at,?2) WHERE id=?1", params![id, now])?;
            if n != 1 { return Err(ApiError::not_found("페어링 링크가 없습니다")); }
            crate::audit::record(tx, now, &p, "pairing.revoked", &id, json!({}))?;
        }
        let pending: i64 = tx.query_row(
            "SELECT COUNT(*) FROM pairings WHERE issuer_id=?1 AND revoked_at IS NULL AND consumed_at IS NULL AND locked_at IS NULL AND (expires_at IS NULL OR expires_at>?2)",
            params![issuer, now], |r| r.get(0),
        )?;
        if pending >= MAX_PENDING {
            return Err(ApiError::conflict("pairing_limit", "대기 중인 페어링이 많습니다. 기존 링크를 폐기하세요"));
        }
        let id = new_id();
        let secret = random_secret(32);
        tx.execute(
            "INSERT INTO pairings(id,name,secret_hash,issuer_id,created_at,password_hash,password_salt) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![id, name, sha256_hex(secret.as_bytes()), issuer, now, password, salt],
        )?;
        crate::audit::record(tx, now, &p, "pairing.created", &id, json!({ "name": name }))?;
        crate::events::append(tx, now, "pairing.changed", None, None, &json!({ "id": id }))?;
        Ok((StatusCode::CREATED, json!({ "id": id, "name": name, "expires_at": null, "code": format!("{id}.{secret}") })))
    }).await?;
    Ok(no_store(response))
}

pub async fn list(State(app): State<App>, _p: Principal) -> ApiResult<Json<Vec<PairingInfo>>> {
    let now = fmt_time(app.clock.now());
    let rows = app.db.call(move |c| {
        let mut statement = c.prepare(
            "SELECT id,name,created_at,expires_at,revoked_at,consumed_at,device_id,failed_attempts,locked_at FROM pairings ORDER BY created_at DESC,id DESC LIMIT 100",
        )?;
        let mut rows = statement.query_map([], |r| Ok(PairingInfo {
            id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)?, expires_at: r.get(3)?,
            revoked_at: r.get(4)?, consumed_at: r.get(5)?, device_id: r.get(6)?,
            failed_attempts: r.get(7)?, locked_at: r.get(8)?, requests: vec![],
        }))?.collect::<Result<Vec<_>, _>>()?;
        let mut requests = c.prepare(
            "SELECT id,name,verification_code,created_at,expires_at FROM pairing_requests WHERE pairing_id=?1 AND approved_at IS NULL AND rejected_at IS NULL AND expires_at>?2 ORDER BY created_at,id",
        )?;
        for row in &mut rows {
            if row.consumed_at.is_some() || row.revoked_at.is_some() || row.locked_at.is_some() { continue; }
            row.requests = requests.query_map(params![row.id, now], |r| Ok(PairingRequestInfo {
                id: r.get(0)?, name: r.get(1)?, verification_code: r.get(2)?, created_at: r.get(3)?, expires_at: r.get(4)?,
            }))?.collect::<Result<Vec<_>, _>>()?;
        }
        Ok(rows)
    }).await?;
    Ok(Json(rows))
}

pub async fn revoke(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Response> {
    let hash = crate::idem::body_hash("pairing.revoke", &json!({ "id": id }));
    crate::idem::run(&app, &p.clone(), &headers, &hash, move |tx, now| {
        let n = tx.execute(
            "UPDATE pairings SET revoked_at=COALESCE(revoked_at,?2) WHERE id=?1",
            params![id, now],
        )?;
        if n != 1 { return Err(ApiError::not_found("페어링 링크가 없습니다")); }
        crate::audit::record(tx, now, &p, "pairing.revoked", &id, json!({}))?;
        crate::events::append(tx, now, "pairing.changed", None, None, &json!({ "id": id }))?;
        Ok((StatusCode::OK, json!({ "id": id, "revoked": true })))
    }).await
}

#[derive(Deserialize)]
pub struct RedeemPairing {
    pub code: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub name: String,
}

/// 비밀번호 확인은 등록 요청만 만든다. 이 시점에는 API 자격·쿠키·기기 토큰이 없다.
pub async fn redeem(State(app): State<App>, headers: HeaderMap, Json(body): Json<RedeemPairing>) -> Response {
    no_store(redeem_inner(app, headers, body).await.unwrap_or_else(IntoResponse::into_response))
}

async fn redeem_inner(app: App, headers: HeaderMap, body: RedeemPairing) -> ApiResult<Response> {
    auth::check_origin(&app, &headers)?;
    if body.code.len() > 128 { return Err(unavailable()); }
    let (id, secret) = body.code.split_once('.').ok_or_else(unavailable)?;
    let (id, secret) = (id.to_string(), secret.to_string());
    let now = app.clock.now();
    let now_s = fmt_time(now);
    let (lookup_id, lookup_secret, lookup_now) = (id.clone(), secret.clone(), now_s.clone());
    let link = app.db.call(move |c| active_link(c, &lookup_id, &lookup_secret, &lookup_now)).await?;
    if body.password.is_empty() || body.password.len() > 256 {
        return Err(ApiError::invalid("비밀번호를 입력하세요"));
    }
    let name = device_name(&body.name)?;
    let candidate = password_hash(body.password, link.salt).await?;
    let valid = ct_eq(&candidate, &link.password_hash);
    let expires = fmt_time(now + REQUEST_TTL);
    // 실패 횟수도 반드시 commit한다. Err 반환으로 transaction이 rollback되지 않게 분리한다.
    let result = app.db.call(move |c| {
        let tx = c.transaction()?;
        let current = active_link(&tx, &id, &secret, &now_s)?;
        if !valid {
            tx.execute("UPDATE pairings SET failed_attempts=failed_attempts+1,locked_at=CASE WHEN failed_attempts+1>=5 THEN ?2 ELSE NULL END WHERE id=?1", params![id, now_s])?;
            let attempts: i64 = tx.query_row("SELECT failed_attempts FROM pairings WHERE id=?1", [&id], |r| r.get(0))?;
            crate::events::append(&tx, &now_s, "pairing.changed", None, None, &json!({ "id": id }))?;
            tx.commit()?;
            return Ok(Err(if attempts >= MAX_FAILURES { locked() } else {
                ApiError::new(StatusCode::UNAUTHORIZED, "pairing_password", format!("비밀번호가 틀렸습니다. {}회 더 틀리면 링크가 잠깁니다", MAX_FAILURES - attempts))
            }));
        }
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM pairing_requests WHERE pairing_id=?1 AND rejected_at IS NULL AND expires_at>?2",
            params![id, now_s], |r| r.get(0),
        )?;
        if count >= MAX_PENDING { return Err(ApiError::conflict("pairing_request_limit", "승인 대기 요청이 많아요. 등록한 기기에서 대기 요청을 정리한 뒤 다시 시도하세요.")); }
        let request_id = new_id();
        let request_secret = random_secret(32);
        let verification = sha256_hex(request_secret.as_bytes())[..8].to_ascii_uppercase();
        let verification = format!("{}-{}", &verification[..4], &verification[4..]);
        tx.execute(
            "INSERT INTO pairing_requests(id,pairing_id,name,secret_hash,verification_code,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![request_id, id, name, sha256_hex(request_secret.as_bytes()), verification, now_s, expires],
        )?;
        let actor = auth::verify_row(&tx, &current.issuer, None, &now_s)?;
        crate::audit::record(&tx, &now_s, &actor, "pairing.requested", &id, json!({ "request_id": request_id }))?;
        crate::events::append(&tx, &now_s, "pairing.changed", None, None, &json!({ "id": id }))?;
        tx.commit()?;
        Ok(Ok(json!({ "code": format!("{request_id}.{request_secret}"), "verification_code": verification, "expires_at": expires })))
    }).await?;
    app.notify_events().await;
    Ok((StatusCode::ACCEPTED, Json(result?)).into_response())
}

pub async fn approve(State(app): State<App>, p: Principal, headers: HeaderMap, Path((id, request_id)): Path<(String, String)>) -> ApiResult<Response> {
    let hash = crate::idem::body_hash("pairing.approve", &json!({ "id": id, "request_id": request_id }));
    crate::idem::run(&app, &p.clone(), &headers, &hash, move |tx, now| {
        let request: Option<(String, String)> = tx.query_row(
            "SELECT r.name,p.issuer_id FROM pairing_requests r JOIN pairings p ON p.id=r.pairing_id WHERE p.id=?1 AND r.id=?2 AND p.revoked_at IS NULL AND p.consumed_at IS NULL AND p.locked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?3) AND r.rejected_at IS NULL AND r.approved_at IS NULL AND r.expires_at>?3",
            params![id, request_id, now], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        let Some((name, issuer)) = request else { return Err(unavailable()); };
        auth::verify_row(tx, &issuer, None, now).map_err(|_| unavailable())?;
        let device_id = new_id();
        tx.execute(
            "INSERT INTO tokens(id,kind,name,secret_hash,created_at) VALUES(?1,'device',?2,?3,?4)",
            params![device_id, name, sha256_hex(random_secret(32).as_bytes()), now],
        )?;
        tx.execute("UPDATE pairings SET consumed_at=?2,device_id=?3 WHERE id=?1", params![id, now, device_id])?;
        tx.execute("UPDATE pairing_requests SET approved_at=?2,device_id=?3 WHERE id=?1", params![request_id, now, device_id])?;
        tx.execute("UPDATE pairing_requests SET rejected_at=?3 WHERE pairing_id=?1 AND id!=?2 AND rejected_at IS NULL", params![id, request_id, now])?;
        crate::audit::record(tx, now, &p, "pairing.approved", &id, json!({ "request_id": request_id, "device_id": device_id }))?;
        crate::events::append(tx, now, "device.created", None, None, &json!({ "id": device_id, "name": name }))?;
        crate::events::append(tx, now, "pairing.changed", None, None, &json!({ "id": id }))?;
        Ok((StatusCode::OK, json!({ "device_id": device_id })))
    }).await
}

pub async fn reject(State(app): State<App>, p: Principal, headers: HeaderMap, Path((id, request_id)): Path<(String, String)>) -> ApiResult<Response> {
    let hash = crate::idem::body_hash("pairing.reject", &json!({ "id": id, "request_id": request_id }));
    crate::idem::run(&app, &p.clone(), &headers, &hash, move |tx, now| {
        let n = tx.execute(
            "UPDATE pairing_requests SET rejected_at=COALESCE(rejected_at,?3) WHERE id=?1 AND pairing_id=?2 AND approved_at IS NULL",
            params![request_id, id, now],
        )?;
        if n != 1 { return Err(unavailable()); }
        crate::audit::record(tx, now, &p, "pairing.rejected", &id, json!({ "request_id": request_id }))?;
        crate::events::append(tx, now, "pairing.changed", None, None, &json!({ "id": id }))?;
        Ok((StatusCode::OK, json!({ "rejected": true })))
    }).await
}

#[derive(Deserialize)]
pub struct ClaimPairing {
    pub code: String,
}

pub async fn claim(State(app): State<App>, headers: HeaderMap, Json(body): Json<ClaimPairing>) -> Response {
    no_store(claim_inner(app, headers, body).await.unwrap_or_else(IntoResponse::into_response))
}

async fn claim_inner(app: App, headers: HeaderMap, body: ClaimPairing) -> ApiResult<Response> {
    auth::check_origin(&app, &headers)?;
    if body.code.len() > 128 { return Err(unavailable()); }
    let (id, secret) = body.code.split_once('.').ok_or_else(unavailable)?;
    let (id, secret) = (id.to_string(), secret.to_string());
    let now = app.clock.now();
    let now_s = fmt_time(now);
    let expires = fmt_time(now + auth::REFRESH_TTL);
    let session = app.db.call(move |c| {
        let tx = c.transaction()?;
        let row = tx.query_row(
            "SELECT r.name,r.secret_hash,r.expires_at,r.rejected_at,r.claimed_at,r.device_id,p.issuer_id,p.revoked_at,p.locked_at FROM pairing_requests r JOIN pairings p ON p.id=r.pairing_id WHERE r.id=?1",
            [&id], |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?,r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,r.get::<_, Option<String>>(4)?,r.get::<_, Option<String>>(5)?,
                r.get::<_, String>(6)?,r.get::<_, Option<String>>(7)?,r.get::<_, Option<String>>(8)?)),
        ).optional()?;
        let Some((name, hash, deadline, rejected, claimed, device, issuer, revoked, lock)) = row else { return Err(unavailable()); };
        if !ct_eq(sha256_hex(secret.as_bytes()).as_bytes(), hash.as_bytes()) || deadline <= now_s
            || rejected.is_some() || claimed.is_some() || revoked.is_some()
        { return Err(unavailable()); }
        if lock.is_some() { return Err(locked()); }
        auth::verify_row(&tx, &issuer, None, &now_s).map_err(|_| unavailable())?;
        let Some(device_id) = device else { return Ok(None); };
        auth::verify_row(&tx, &device_id, None, &now_s)?;
        let browser_id = new_id();
        let refresh = random_secret(32);
        tx.execute(
            "INSERT INTO tokens(id,kind,name,secret_hash,parent_id,created_at,expires_at) VALUES(?1,'browser',?2,?3,?4,?5,?6)",
            params![browser_id, name, sha256_hex(refresh.as_bytes()), device_id, now_s, expires],
        )?;
        tx.execute("UPDATE pairing_requests SET claimed_at=?2 WHERE id=?1", params![id, now_s])?;
        tx.commit()?;
        Ok(Some((browser_id, refresh)))
    }).await?;
    match session {
        None => Ok((StatusCode::ACCEPTED, Json(json!({ "status": "pending" }))).into_response()),
        Some((id, refresh)) => Ok(auth::browser_session_response(&app, &headers, &id, &refresh, auth::REFRESH_TTL.whole_seconds())),
    }
}
