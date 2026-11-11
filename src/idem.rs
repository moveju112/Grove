//! idempotency 키 처리(DB-005, DB-008, STORE-002).
//! 상태 변경·응답 저장·이벤트 기록을 한 transaction에서 commit한 뒤에만 성공을 응답한다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::util::fmt_time;
use axum::Json;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::Value;

pub const HEADER: &str = "idempotency-key";

pub fn key_from(headers: &HeaderMap) -> ApiResult<String> {
    let key = headers
        .get(HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .ok_or_else(|| ApiError::invalid("Idempotency-Key 헤더가 필요합니다"))?;
    if key.len() > 128 || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(ApiError::invalid("Idempotency-Key는 128자 이하의 ASCII여야 합니다"));
    }
    Ok(key.to_string())
}

pub async fn run<F>(app: &App, p: &Principal, headers: &HeaderMap, request_hash: &str, f: F) -> ApiResult<Response>
where
    F: FnOnce(&Transaction, &str) -> ApiResult<(StatusCode, Value)> + Send + 'static,
{
    run_redacted(app, p, headers, request_hash, &[], f).await
}

/// `redact`에 적은 최상위 필드는 저장본에서 지운다(일회성 비밀 등). 재전송 시 `<필드>_redacted: true`로 응답한다.
pub async fn run_redacted<F>(
    app: &App,
    p: &Principal,
    headers: &HeaderMap,
    request_hash: &str,
    redact: &'static [&'static str],
    f: F,
) -> ApiResult<Response>
where
    F: FnOnce(&Transaction, &str) -> ApiResult<(StatusCode, Value)> + Send + 'static,
{
    let key = key_from(headers)?;
    let owner = p.root_id.clone();
    let request_hash = request_hash.to_string();
    let now = fmt_time(app.clock.now());
    let (status, body, replayed) = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let existing: Option<(String, i64, String)> = tx
                .query_row(
                    "SELECT request_hash, status, response FROM idempotency WHERE owner_id = ?1 AND key = ?2",
                    params![owner, key],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            if let Some((hash, status, response)) = existing {
                if hash != request_hash {
                    return Err(ApiError::conflict(
                        "idempotency_conflict",
                        "같은 Idempotency-Key가 다른 요청에 이미 사용되었습니다",
                    ));
                }
                let body: Value = serde_json::from_str(&response)?;
                return Ok((StatusCode::from_u16(status as u16).unwrap_or(StatusCode::OK), body, true));
            }
            let (status, body) = f(&tx, &now)?;
            let mut stored = body.clone();
            if let Value::Object(m) = &mut stored {
                for k in redact {
                    if m.remove(*k).is_some() {
                        m.insert(format!("{k}_redacted"), Value::Bool(true));
                    }
                }
            }
            tx.execute(
                "INSERT INTO idempotency (owner_id, key, request_hash, status, response, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![owner, key, request_hash, status.as_u16() as i64, stored.to_string(), now],
            )?;
            tx.commit()?;
            Ok((status, body, false))
        })
        .await?;
    app.notify_events().await;
    let mut resp = (status, Json(body)).into_response();
    if replayed {
        resp.headers_mut().insert("idempotent-replayed", HeaderValue::from_static("true"));
    }
    Ok(resp)
}

/// 외부 부작용(프로세스·Git)을 transaction 밖에서 일으키는 요청용: 같은 키의 기록이 있으면 실행 없이 저장된 응답을 돌려준다.
/// 다른 요청에 쓰인 키면 충돌. 기록이 없으면 None이며, 부작용 전 접수·직렬화는 호출자가 보장해야 한다.
pub async fn replay(app: &App, p: &Principal, headers: &HeaderMap, request_hash: &str) -> ApiResult<Option<Response>> {
    let key = key_from(headers)?;
    let owner = p.root_id.clone();
    let prior: Option<(String, i64, String)> = app
        .db
        .call(move |c| {
            Ok(c.query_row(
                "SELECT request_hash, status, response FROM idempotency WHERE owner_id = ?1 AND key = ?2",
                params![owner, key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?)
        })
        .await?;
    let Some((hash, status, response)) = prior else { return Ok(None) };
    if hash != request_hash {
        return Err(ApiError::conflict("idempotency_conflict", "같은 Idempotency-Key가 다른 요청에 이미 사용되었습니다"));
    }
    let body: Value = serde_json::from_str(&response)?;
    let mut resp = (StatusCode::from_u16(status as u16).unwrap_or(StatusCode::OK), Json(body)).into_response();
    resp.headers_mut().insert("idempotent-replayed", HeaderValue::from_static("true"));
    Ok(Some(resp))
}

/// 외부 부작용 전에 저장한 결과 불명 receipt만 확정한다. 호출자의 transaction에 이벤트도 함께 넣는다.
pub(crate) fn complete(c: &Connection, owner: &str, key: &str, hash: &str, status: StatusCode, body: &Value) -> ApiResult<()> {
    let n=c.execute(
        "UPDATE idempotency SET status=?4,response=?5 WHERE owner_id=?1 AND key=?2 AND request_hash=?3 AND status=409 AND json_extract(response,'$.error.code')='result_unknown'",
        params![owner,key,hash,status.as_u16() as i64,body.to_string()],
    )?;
    if n != 1 { return Err(ApiError::conflict("result_unknown","작업 접수 기록을 확정하지 못했습니다")); }
    Ok(())
}

/// 요청 본문의 정규화 hash. serde_json은 객체 키 순서를 보존하므로 정렬해서 hash한다.
pub fn body_hash(route: &str, v: &Value) -> String {
    fn canon(v: &Value) -> Value {
        match v {
            Value::Object(m) => {
                let mut keys: Vec<_> = m.keys().cloned().collect();
                keys.sort();
                let mut out = serde_json::Map::new();
                for k in keys {
                    out.insert(k.clone(), canon(&m[&k]));
                }
                Value::Object(out)
            }
            Value::Array(a) => Value::Array(a.iter().map(canon).collect()),
            other => other.clone(),
        }
    }
    crate::util::sha256_hex(format!("{route}\n{}", canon(v)).as_bytes())
}
