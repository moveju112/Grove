//! API 키(비밀)와 모델 프로필(AUTH-API 키 경로, LOGIN-001, MODEL 설정).
//! 비밀 원문은 응답·이벤트·로그에 노출하지 않고 끝 4자리 마스킹만 보여준다.

use crate::App;
use crate::auth::{Owner, Principal};
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::idem;
use crate::provider::{self, Profile};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;

pub fn mask(v: &str) -> String {
    let n = v.chars().count();
    if n <= 8 {
        return "****".into();
    }
    let tail: String = v.chars().skip(n - 4).collect();
    format!("****{tail}")
}

#[derive(Serialize, ts_rs::TS)]
pub struct SecretInfo {
    pub id: String,
    pub label: String,
    pub masked: String,
    pub created_at: String,
    pub updated_at: String,
    pub used_by: Vec<String>,
}

fn secret_info(c: &Connection, id: &str) -> ApiResult<SecretInfo> {
    let (label, value, created_at, updated_at): (String, Option<String>, String, String) = c
        .query_row(
            "SELECT label, grove_try_decrypt(value), created_at, updated_at FROM secrets WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("비밀이 없습니다"))?;
    let mut st = c.prepare("SELECT name FROM model_profiles WHERE secret_id = ?1 AND deleted_at IS NULL ORDER BY name")?;
    let used_by = st.query_map(params![id], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
    // 해독할 수 없으면(키 파일 없음·손상) 마스킹하지 않은 안내 문구로 알린다.
    let masked = value.as_deref().map(mask).unwrap_or_else(|| "(해독 불가: secret.key 없음·손상 — 키를 다시 입력하세요)".into());
    Ok(SecretInfo { id: id.into(), label, masked, created_at, updated_at, used_by })
}

#[derive(Deserialize)]
pub struct PutSecret {
    pub label: String,
    pub value: String,
}

fn validate_secret(label: &str, value: &str) -> ApiResult<()> {
    if label.trim().is_empty() || label.chars().count() > 80 {
        return Err(ApiError::invalid("이름은 1~80자여야 합니다"));
    }
    if value.trim().is_empty() || value.len() > 8192 || value.contains(['\n', '\r']) {
        return Err(ApiError::invalid("키 값이 올바르지 않습니다"));
    }
    Ok(())
}

pub async fn create_secret(State(app): State<App>, Owner(p): Owner, headers: HeaderMap, Json(b): Json<PutSecret>) -> ApiResult<Response> {
    validate_secret(&b.label, &b.value)?;
    // idempotency hash에는 비밀 원문 대신 hash만 넣는다.
    let h = idem::body_hash("secret.create", &json!({ "l": b.label, "v": crate::util::sha256_hex(b.value.as_bytes()) }));
    let actor = p.clone();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let id = crate::util::new_id();
        tx.execute(
            "INSERT INTO secrets (id, label, value, created_at, updated_at) VALUES (?1, ?2, grove_encrypt(?3), ?4, ?4)",
            params![id, b.label.trim(), b.value.trim(), now],
        )?;
        events::append(tx, now, "secret.changed", None, None, &json!({ "id": id }))?;
        crate::audit::record(tx, now, &actor, "secret.created", &id, json!({ "label": b.label.trim() }))?;
        Ok((StatusCode::CREATED, serde_json::to_value(secret_info(tx, &id)?)?))
    })
    .await
}

/// 키 교체. 저장이 실패하면 transaction이 롤백되어 이전 키가 그대로 남는다(LOGIN-001).
pub async fn replace_secret(
    State(app): State<App>,
    Owner(p): Owner,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<PutSecret>,
) -> ApiResult<Response> {
    validate_secret(&b.label, &b.value)?;
    let h = idem::body_hash("secret.replace", &json!({ "id": id, "l": b.label, "v": crate::util::sha256_hex(b.value.as_bytes()) }));
    let actor = p.clone();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let n = tx.execute("UPDATE secrets SET label = ?2, value = grove_encrypt(?3), updated_at = ?4 WHERE id = ?1", params![id, b.label.trim(), b.value.trim(), now])?;
        if n == 0 {
            return Err(ApiError::not_found("비밀이 없습니다"));
        }
        events::append(tx, now, "secret.changed", None, None, &json!({ "id": id }))?;
        crate::audit::record(tx, now, &actor, "secret.replaced", &id, json!({ "label": b.label.trim() }))?;
        Ok((StatusCode::OK, serde_json::to_value(secret_info(tx, &id)?)?))
    })
    .await
}

pub async fn delete_secret(State(app): State<App>, Owner(p): Owner, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Response> {
    let h = idem::body_hash("secret.delete", &json!({ "id": id }));
    let actor = p.clone();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let info = secret_info(tx, &id)?;
        if !info.used_by.is_empty() {
            return Err(ApiError::conflict("in_use", "모델 프로필이 사용 중인 키입니다").with_details(json!({ "used_by": info.used_by })));
        }
        tx.execute("UPDATE model_profiles SET secret_id = NULL WHERE secret_id = ?1", params![id])?;
        tx.execute("DELETE FROM secrets WHERE id = ?1", params![id])?;
        events::append(tx, now, "secret.changed", None, None, &json!({ "id": id, "deleted": true }))?;
        crate::audit::record(tx, now, &actor, "secret.deleted", &id, json!({ "label": info.label }))?;
        Ok((StatusCode::OK, json!({ "deleted": true })))
    })
    .await
}

pub async fn list_secrets(State(app): State<App>, Owner(_p): Owner) -> ApiResult<Json<Vec<SecretInfo>>> {
    Ok(Json(
        app.db
            .call(|c| {
                let mut st = c.prepare("SELECT id FROM secrets ORDER BY label")?;
                let ids = st.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
                ids.iter().map(|id| secret_info(c, id)).collect()
            })
            .await?,
    ))
}

// ---------------- 모델 프로필 ----------------

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct ModelProfile {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    pub secret_id: Option<String>,
    #[ts(type = "unknown")]
    pub options: Value,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    /// 마지막 연결 확인 결과(AUTH-001). 확인한 적 없으면 null.
    #[ts(type = "{ ok: boolean, code: string | null, message: string | null, latency_ms: number, checked_at: string, detail: unknown } | null")]
    pub last_check: Option<Value>,
}

const PCOLS: &str = "id, name, protocol, base_url, model, secret_id, options, revision, created_at, updated_at, \
    (SELECT json_object('ok', json(CASE WHEN k.ok THEN 'true' ELSE 'false' END), 'code', k.code, 'message', k.message, 'latency_ms', k.latency_ms, \
     'checked_at', k.checked_at, 'detail', json(k.detail)) FROM profile_checks k WHERE k.profile_id = model_profiles.id)";

fn profile_row(r: &Row) -> rusqlite::Result<ModelProfile> {
    let o: String = r.get(6)?;
    Ok(ModelProfile {
        id: r.get(0)?,
        name: r.get(1)?,
        protocol: r.get(2)?,
        base_url: r.get(3)?,
        model: r.get(4)?,
        secret_id: r.get(5)?,
        options: serde_json::from_str(&o).unwrap_or(json!({})),
        revision: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
        last_check: r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok()),
    })
}

/// 연결 확인(AUTH-001): 생성 요청 없이 provider에 한 번 닿아 보고 결과를 남긴다. 비밀 원문은 응답·기록에 넣지 않는다.
pub async fn check_profile(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let pid = id.clone();
    let (_, rp) = app.db.call(move |c| runtime_profile(c, &pid)).await?;
    let started = std::time::Instant::now();
    let r = crate::provider::check(&rp).await;
    let ms = started.elapsed().as_millis() as i64;
    let secret = rp.api_key.clone();
    // 오류 본문에 키가 되돌아오는 서버가 있어도 기록·응답에는 남기지 않는다.
    let scrub = |m: &str| match &secret {
        Some(k) if k.len() >= 8 => m.replace(k.as_str(), "[redacted]"),
        _ => m.to_string(),
    };
    let (ok, code, message, detail) = match &r {
        Ok(d) => (true, None, None, d.clone()),
        Err(e) => (false, Some(e.code.to_string()), Some(scrub(&e.message)), json!({ "status": e.status, "retryable": e.retryable })),
    };
    let now = crate::util::fmt_time(app.clock.now());
    let prof = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            tx.execute(
                "INSERT INTO profile_checks (profile_id, ok, code, message, detail, latency_ms, checked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
                 ON CONFLICT(profile_id) DO UPDATE SET ok = ?2, code = ?3, message = ?4, detail = ?5, latency_ms = ?6, checked_at = ?7",
                params![id, ok, code, message, detail.to_string(), ms, now],
            )?;
            let prof = get_profile(&tx, &id)?;
            events::append(&tx, &now, "profile.changed", None, None, &serde_json::to_value(&prof)?)?;
            tx.commit()?;
            Ok(prof)
        })
        .await?;
    app.notify_events().await;
    Ok(Json(prof.last_check.unwrap_or(Value::Null)))
}

pub fn get_profile(c: &Connection, id: &str) -> ApiResult<ModelProfile> {
    c.query_row(&format!("SELECT {PCOLS} FROM model_profiles WHERE id = ?1 AND deleted_at IS NULL"), params![id], profile_row)
        .optional()?
        .ok_or_else(|| ApiError::not_found("모델 프로필이 없습니다"))
}

/// 실행용 provider 설정(비밀 원문 포함). 서버 내부에서만 사용한다.
pub fn runtime_profile(c: &Connection, id: &str) -> ApiResult<(ModelProfile, Profile)> {
    let p = get_profile(c, id)?;
    let key: Option<String> = match &p.secret_id {
        // 복호화 함수의 실패는 SQLite를 거쳐 SQLITE_ERROR + 메시지로 돌아온다(이 조회에서 그 실패를 낼 곳은 복호화뿐).
        Some(s) => c.query_row("SELECT grove_decrypt(value) FROM secrets WHERE id = ?1", params![s], |r| r.get(0)).optional().map_err(|e| match e {
            rusqlite::Error::UserFunctionError(m) => ApiError::conflict("secret_unreadable", m.to_string()),
            rusqlite::Error::SqliteFailure(f, Some(m)) if f.code == rusqlite::ErrorCode::Unknown => ApiError::conflict("secret_unreadable", m),
            other => other.into(),
        })?,
        None => None,
    };
    let timeout = p.options["timeout_secs"].as_u64().unwrap_or(300).clamp(5, 3600);
    let headers = p.options["headers"]
        .as_object()
        .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
        .unwrap_or_default();
    let rp = Profile {
        protocol: p.protocol.clone(),
        base_url: p.base_url.clone(),
        model: p.model.clone(),
        api_key: key,
        timeout: Duration::from_secs(timeout),
        extra_headers: headers,
    };
    Ok((p, rp))
}

#[derive(Deserialize)]
pub struct CreateProfile {
    pub name: String,
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    pub secret_id: Option<String>,
    pub options: Option<Value>,
}

fn validate_options(o: &Value) -> ApiResult<()> {
    let obj = o.as_object().ok_or_else(|| ApiError::invalid("options는 객체여야 합니다"))?;
    for (k, v) in obj {
        match k.as_str() {
            "timeout_secs" | "max_tokens" => {
                if v.as_u64().is_none() {
                    return Err(ApiError::invalid(format!("{k}는 양의 정수여야 합니다")));
                }
            }
            "temperature" => {
                if !v.as_f64().is_some_and(|t| (0.0..=2.0).contains(&t)) {
                    return Err(ApiError::invalid("temperature는 0~2여야 합니다"));
                }
            }
            "headers" => {
                let h = v.as_object().ok_or_else(|| ApiError::invalid("headers는 객체여야 합니다"))?;
                for (hk, hv) in h {
                    let lk = hk.to_ascii_lowercase();
                    if matches!(lk.as_str(), "authorization" | "x-api-key" | "x-goog-api-key" | "host") || !hv.is_string() {
                        return Err(ApiError::invalid(format!("허용되지 않은 header: {hk}")));
                    }
                }
            }
            "context_window" => {
                if v.as_u64().is_none() {
                    return Err(ApiError::invalid("context_window는 양의 정수여야 합니다"));
                }
            }
            // 가격표(USAGE-003): 백만 token당 단가. 통화·버전을 함께 저장하고, 없으면 비용은 "알 수 없음"이다.
            "pricing" => {
                let p = v.as_object().ok_or_else(|| ApiError::invalid("pricing은 객체여야 합니다"))?;
                for (pk, pv) in p {
                    match pk.as_str() {
                        "currency" => {
                            if !pv.as_str().is_some_and(|c| c.len() == 3 && c.chars().all(|ch| ch.is_ascii_uppercase())) {
                                return Err(ApiError::invalid("pricing.currency는 USD 같은 3자리 대문자 통화 코드여야 합니다"));
                            }
                        }
                        "version" => {
                            if !pv.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 64) {
                                return Err(ApiError::invalid("pricing.version은 1~64자 문자열이어야 합니다"));
                            }
                        }
                        "input_per_mtok" | "output_per_mtok" | "cache_read_per_mtok" | "cache_write_per_mtok" => {
                            if !pv.as_f64().is_some_and(|x| x >= 0.0 && x.is_finite()) {
                                return Err(ApiError::invalid(format!("pricing.{pk}는 0 이상의 숫자여야 합니다")));
                            }
                        }
                        other => return Err(ApiError::invalid(format!("지원하지 않는 pricing 항목: {other}"))),
                    }
                }
                if !p.contains_key("currency") || !p.contains_key("input_per_mtok") || !p.contains_key("output_per_mtok") {
                    return Err(ApiError::invalid("pricing에는 currency·input_per_mtok·output_per_mtok가 필요합니다"));
                }
            }
            other => return Err(ApiError::invalid(format!("지원하지 않는 옵션: {other}"))),
        }
    }
    Ok(())
}

pub async fn create_profile(State(app): State<App>, Owner(p): Owner, headers: HeaderMap, Json(b): Json<CreateProfile>) -> ApiResult<Response> {
    provider::validate_profile(&b.protocol, &b.base_url, &b.model).map_err(ApiError::invalid)?;
    if b.name.trim().is_empty() || b.name.chars().count() > 80 {
        return Err(ApiError::invalid("이름은 1~80자여야 합니다"));
    }
    let options = b.options.unwrap_or(json!({}));
    validate_options(&options)?;
    let h = idem::body_hash("profile.create", &json!({ "n": b.name, "p": b.protocol, "u": b.base_url, "m": b.model, "s": b.secret_id, "o": options }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        if let Some(s) = &b.secret_id {
            secret_info(tx, s)?;
        }
        let id = crate::util::new_id();
        tx.execute(
            "INSERT INTO model_profiles (id, name, protocol, base_url, model, secret_id, options, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![id, b.name.trim(), b.protocol, b.base_url.trim().trim_end_matches('/'), b.model.trim(), b.secret_id, options.to_string(), now],
        )?;
        let prof = get_profile(tx, &id)?;
        events::append(tx, now, "profile.changed", None, None, &serde_json::to_value(&prof)?)?;
        Ok((StatusCode::CREATED, serde_json::to_value(prof)?))
    })
    .await
}

#[derive(Deserialize)]
pub struct UpdateProfile {
    pub expected_revision: i64,
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    /// 없음 = 그대로, null = 비밀 연결 끊기, 값 = 그 비밀
    #[serde(default, deserialize_with = "crate::util::double_option")]
    pub secret_id: Option<Option<String>>,
    pub options: Option<Value>,
}

pub async fn update_profile(
    State(app): State<App>,
    Owner(p): Owner,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<UpdateProfile>,
) -> ApiResult<Response> {
    if let Some(o) = &b.options {
        validate_options(o)?;
    }
    let h = idem::body_hash("profile.update", &json!({ "id": id, "r": b.expected_revision, "n": b.name, "u": b.base_url, "m": b.model, "s": b.secret_id, "o": b.options }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get_profile(tx, &id)?;
        if cur.revision != b.expected_revision {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        let base_url = b.base_url.map(|u| u.trim().trim_end_matches('/').to_string()).unwrap_or(cur.base_url.clone());
        let model = b.model.map(|m| m.trim().to_string()).unwrap_or(cur.model.clone());
        provider::validate_profile(&cur.protocol, &base_url, &model).map_err(ApiError::invalid)?;
        let secret = match b.secret_id {
            Some(s) => s,
            None => cur.secret_id.clone(),
        };
        if let Some(s) = &secret {
            secret_info(tx, s)?;
        }
        tx.execute(
            "UPDATE model_profiles SET name = ?2, base_url = ?3, model = ?4, secret_id = ?5, options = ?6, revision = revision + 1, updated_at = ?7 WHERE id = ?1",
            params![id, b.name.unwrap_or(cur.name.clone()), base_url, model, secret, b.options.unwrap_or(cur.options.clone()).to_string(), now],
        )?;
        let prof = get_profile(tx, &id)?;
        events::append(tx, now, "profile.changed", None, None, &serde_json::to_value(&prof)?)?;
        Ok((StatusCode::OK, serde_json::to_value(prof)?))
    })
    .await
}

pub async fn delete_profile(State(app): State<App>, Owner(p): Owner, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Response> {
    let h = idem::body_hash("profile.delete", &json!({ "id": id }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        get_profile(tx, &id)?;
        let active: i64 = tx.query_row(
            "SELECT COUNT(*) FROM turns WHERE profile_id = ?1 AND status IN ('queued','running','awaiting_approval')",
            params![id],
            |r| r.get(0),
        )?;
        if active > 0 {
            return Err(ApiError::busy("이 프로필로 실행 중인 턴이 있습니다"));
        }
        tx.execute("UPDATE model_profiles SET deleted_at = ?2 WHERE id = ?1", params![id, now])?;
        events::append(tx, now, "profile.changed", None, None, &json!({ "id": id, "deleted": true }))?;
        Ok((StatusCode::OK, json!({ "deleted": true })))
    })
    .await
}

pub async fn list_profiles(State(app): State<App>, _p: Principal) -> ApiResult<Json<Vec<ModelProfile>>> {
    Ok(Json(
        app.db
            .call(|c| {
                let mut st = c.prepare(&format!("SELECT {PCOLS} FROM model_profiles WHERE deleted_at IS NULL ORDER BY name"))?;
                let v = st.query_map([], profile_row)?.collect::<Result<Vec<_>, _>>()?;
                Ok(v)
            })
            .await?,
    ))
}
