//! 짧게 유효한 일회용 페어링. DB에는 비밀 hash만 저장하고 등록된 기기의 장기 자격은 링크에 넣지 않는다.

use crate::App;
use crate::auth::{self, Owner};
use crate::error::{ApiError, ApiResult};
use crate::util::{ct_eq, fmt_time, new_id, random_secret, sha256_hex};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::Response;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::Duration;

pub const TTL: Duration = Duration::minutes(5);
const MAX_PENDING: i64 = 20;

#[derive(Serialize, ts_rs::TS)]
pub struct PairingInfo {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub expires_at: String,
    pub revoked_at: Option<String>,
    pub consumed_at: Option<String>,
    pub device_id: Option<String>,
}

#[derive(Deserialize)]
pub struct CreatePairing {
    pub name: String,
    pub replace_id: Option<String>,
}

pub async fn create(
    State(app): State<App>,
    Owner(p): Owner,
    headers: HeaderMap,
    Json(body): Json<CreatePairing>,
) -> ApiResult<Response> {
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(ApiError::invalid("기기 이름은 1~80자여야 합니다"));
    }
    let hash = crate::idem::body_hash("pairing.create", &json!({ "name": name, "replace_id": body.replace_id }));
    let issuer = p.root_id.clone();
    let actor = p.clone();
    let expires = fmt_time(app.clock.now() + TTL);
    let mut response = crate::idem::run_redacted(&app, &p, &headers, &hash, &["code"], move |tx, now| {
        if let Some(id) = body.replace_id {
            let n = tx.execute(
                "UPDATE pairings SET revoked_at = COALESCE(revoked_at, ?3) WHERE id = ?1 AND issuer_id = ?2",
                params![id, issuer, now],
            )?;
            if n != 1 {
                return Err(ApiError::not_found("페어링 링크가 없습니다"));
            }
            crate::audit::record(tx, now, &actor, "pairing.revoked", &id, json!({}))?;
        }
        let pending: i64 = tx.query_row(
            "SELECT COUNT(*) FROM pairings WHERE issuer_id = ?1 AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > ?2",
            params![issuer, now],
            |r| r.get(0),
        )?;
        if pending >= MAX_PENDING {
            return Err(ApiError::conflict("pairing_limit", "대기 중인 페어링이 많습니다. 기존 링크를 폐기하거나 만료 후 다시 시도하세요"));
        }
        let id = new_id();
        let secret = random_secret(32);
        tx.execute(
            "INSERT INTO pairings(id,name,secret_hash,issuer_id,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![id, name, sha256_hex(secret.as_bytes()), issuer, now, expires],
        )?;
        crate::audit::record(tx, now, &actor, "pairing.created", &id, json!({ "name": name, "expires_at": expires }))?;
        crate::events::append(tx, now, "pairing.changed", None, None, &json!({ "id": id }))?;
        Ok((StatusCode::CREATED, json!({ "id": id, "name": name, "expires_at": expires, "code": format!("{id}.{secret}") })))
    }).await?;
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

pub async fn list(State(app): State<App>, Owner(p): Owner) -> ApiResult<Json<Vec<PairingInfo>>> {
    let issuer = p.root_id;
    let rows = app.db.call(move |c| {
        let mut statement = c.prepare(
            "SELECT id,name,created_at,expires_at,revoked_at,consumed_at,device_id FROM pairings WHERE issuer_id=?1 ORDER BY created_at DESC,id DESC LIMIT 100",
        )?;
        let rows = statement.query_map(params![issuer], |r| Ok(PairingInfo {
            id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)?, expires_at: r.get(3)?,
            revoked_at: r.get(4)?, consumed_at: r.get(5)?, device_id: r.get(6)?,
        }))?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }).await?;
    Ok(Json(rows))
}

pub async fn revoke(State(app): State<App>, Owner(p): Owner, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Response> {
    let hash = crate::idem::body_hash("pairing.revoke", &json!({ "id": id }));
    let issuer = p.root_id.clone();
    let actor = p.clone();
    crate::idem::run(&app, &p, &headers, &hash, move |tx, now| {
        let n = tx.execute(
            "UPDATE pairings SET revoked_at=COALESCE(revoked_at,?3) WHERE id=?1 AND issuer_id=?2",
            params![id, issuer, now],
        )?;
        if n != 1 { return Err(ApiError::not_found("페어링 링크가 없습니다")); }
        crate::audit::record(tx, now, &actor, "pairing.revoked", &id, json!({}))?;
        crate::events::append(tx, now, "pairing.changed", None, None, &json!({ "id": id }))?;
        Ok((StatusCode::OK, json!({ "id": id, "revoked": true })))
    }).await
}

#[derive(Deserialize)]
pub struct RedeemPairing {
    pub code: String,
}

fn unavailable() -> ApiError {
    ApiError::new(StatusCode::GONE, "pairing_unavailable", "페어링 링크가 만료되었거나 폐기·사용되었습니다. 소유자에게 재발급을 요청하세요")
}

/// 일반 기기 토큰을 출력하지 않고 이 브라우저의 세션만 발급한다. 응답 유실 시 자동 재등록하지 않는다.
pub async fn redeem(State(app): State<App>, headers: HeaderMap, Json(body): Json<RedeemPairing>) -> ApiResult<Response> {
    auth::check_origin(&app, &headers)?;
    if body.code.len() > 128 { return Err(unavailable()); }
    let (id, secret) = body.code.split_once('.').ok_or_else(unavailable)?;
    let (id, secret) = (id.to_string(), secret.to_string());
    let now = app.clock.now();
    let now_s = fmt_time(now);
    let expires = fmt_time(now + auth::REFRESH_TTL);
    let (browser_id, refresh) = app.db.call(move |c| {
        let tx = c.transaction()?;
        let row: Option<(String, String, String, String, Option<String>, Option<String>)> = tx.query_row(
            "SELECT name,secret_hash,issuer_id,expires_at,revoked_at,consumed_at FROM pairings WHERE id=?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        ).optional()?;
        let Some((name, hash, issuer, deadline, revoked, consumed)) = row else { return Err(unavailable()); };
        if !ct_eq(sha256_hex(secret.as_bytes()).as_bytes(), hash.as_bytes()) || deadline <= now_s || revoked.is_some() || consumed.is_some() {
            return Err(unavailable());
        }
        let actor = auth::verify_row(&tx, &issuer, None, &now_s)?;
        if !actor.is_owner { return Err(unavailable()); }
        let device_id = new_id();
        let device_secret = random_secret(32);
        tx.execute(
            "INSERT INTO tokens(id,kind,name,secret_hash,created_at) VALUES(?1,'device',?2,?3,?4)",
            params![device_id, name, sha256_hex(device_secret.as_bytes()), now_s],
        )?;
        let browser_id = new_id();
        let refresh = random_secret(32);
        tx.execute(
            "INSERT INTO tokens(id,kind,name,secret_hash,parent_id,created_at,expires_at) VALUES(?1,'browser',?2,?3,?4,?5,?6)",
            params![browser_id, name, sha256_hex(refresh.as_bytes()), device_id, now_s, expires],
        )?;
        tx.execute("UPDATE pairings SET consumed_at=?2,device_id=?3 WHERE id=?1", params![id, now_s, device_id])?;
        crate::audit::record(&tx, &now_s, &actor, "pairing.consumed", &id, json!({ "device_id": device_id }))?;
        crate::events::append(&tx, &now_s, "device.created", None, None, &json!({ "id": device_id, "name": name }))?;
        crate::events::append(&tx, &now_s, "pairing.changed", None, None, &json!({ "id": id }))?;
        tx.commit()?;
        Ok((browser_id, refresh))
    }).await?;
    app.notify_events().await;
    Ok(auth::browser_session_response(&app, &headers, &browser_id, &refresh, auth::REFRESH_TTL.whole_seconds()))
}
