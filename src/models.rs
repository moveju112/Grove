//! API 키(비밀)와 모델 프로필(AUTH-API 키 경로, LOGIN-001, MODEL 설정).
//! 비밀 원문은 응답·이벤트·로그에 노출하지 않고 끝 4자리 마스킹만 보여준다.

use crate::App;
use crate::auth::{Owner, Principal};
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::idem;
use crate::provider::{self, Profile, scrub_provider_text};
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

/// 실행 백엔드와 역할 정의는 별개다. 설치 여부는 인증·모델 사용 가능 여부를 뜻하지 않는다.
#[derive(Debug, Serialize, ts_rs::TS)]
pub struct AgentBackend {
    pub protocol: String,
    pub name: String,
    pub installed: bool,
    pub read_only: bool,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct AgentBackendCatalog {
    pub backends: Vec<AgentBackend>,
}

const AGENT_BACKENDS: &[(&str, &str, &str)] = &[
    ("codex_cli", "Codex", "codex"),
    ("claude_code", "Claude Code", "claude"),
];

/// 사용자가 연결을 선택할 때만 조회한다. CLI 실행·로그인 파일 접근·모델 호출은 하지 않는다.
pub async fn agent_backends(_p: Principal) -> Json<AgentBackendCatalog> {
    Json(AgentBackendCatalog {
        backends: AGENT_BACKENDS.iter().map(|(protocol, name, program)| AgentBackend {
            protocol: (*protocol).into(),
            name: (*name).into(),
            installed: crate::deps::find_in_path(program).is_some(),
            read_only: true,
        }).collect(),
    })
}

/// 명시적 연결은 프로필 관리 권한을 따른다. 동시 탭·응답 유실 후 재시도도 같은 기본 연결로 수렴한다.
pub async fn connect_agent_backend(State(app): State<App>, Owner(p): Owner, headers: HeaderMap, Path(protocol): Path<String>) -> ApiResult<Response> {
    let (_, name, program) = AGENT_BACKENDS.iter().find(|(id, _, _)| *id == protocol)
        .ok_or_else(|| ApiError::invalid("지원하지 않는 에이전트입니다"))?;
    let hash = idem::body_hash("agent_backend.connect", &json!({ "protocol": protocol }));
    if let Some(response) = idem::replay(&app, &p, &headers, &hash).await? { return Ok(response); }
    let name = (*name).to_string();
    let program = *program;
    idem::run(&app, &p, &headers, &hash, move |tx, now| {
        let existing: Option<String> = tx.query_row(
            "SELECT id FROM model_profiles WHERE protocol=?1 AND model='default' AND enabled=1 AND deleted_at IS NULL AND base_url='' AND secret_id IS NULL ORDER BY created_at, id LIMIT 1",
            [&protocol], |row| row.get(0),
        ).optional()?;
        if let Some(id) = existing {
            return Ok((StatusCode::OK, serde_json::to_value(get_profile(tx, &id)?)?));
        }
        if crate::deps::find_in_path(program).is_none() {
            return Err(crate::deps::missing(program));
        }
        let id = crate::util::new_id();
        tx.execute(
            "INSERT INTO model_profiles (id, name, protocol, base_url, model, options, created_at, updated_at, enabled) VALUES (?1, ?2, ?3, '', 'default', '{}', ?4, ?4, 1)",
            params![id, name, protocol, now],
        )?;
        let profile = get_profile(tx, &id)?;
        events::append(tx, now, "profile.changed", None, None, &serde_json::to_value(&profile)?)?;
        Ok((StatusCode::CREATED, serde_json::to_value(profile)?))
    }).await
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
    let mut st = c.prepare(&format!("SELECT p.name FROM model_profiles p WHERE p.deleted_at IS NULL AND {} ORDER BY p.name", crate::model_headers::SECRET_USAGE))?;
    let mut used_by = st.query_map(params![id], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
    used_by.extend(crate::mcp::secret_users(c, id)?);
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
        // 읽을 수 없는 옛 키도 명시적 재입력으로 복구한다. try_decrypt의 null은 동일성 미확인이다.
        let unchanged: bool = tx.query_row("SELECT COALESCE(grove_try_decrypt(value)=?2,0) FROM secrets WHERE id=?1",
            params![id, b.value.trim()], |row| row.get(0)).optional()?.ok_or_else(|| ApiError::not_found("비밀이 없습니다"))?;
        if !unchanged {
            crate::mcp::secret_changed(tx, now, &id)?;
            let active: bool = tx.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM turns t JOIN model_profiles p ON p.id=t.profile_id \
                 WHERE {} AND t.status IN ('queued','running','awaiting_approval'))", crate::model_headers::SECRET_USAGE),
                [&id], |row| row.get(0),
            )?;
            if active { return Err(ApiError::busy("이 비밀을 사용하는 모델이 실행 중입니다. 먼저 실행을 끝내거나 취소하세요")); }
        }
        tx.execute("UPDATE secrets SET label = ?2, value = grove_encrypt(?3), updated_at = ?4 WHERE id = ?1", params![id, b.label.trim(), b.value.trim(), now])?;
        if !unchanged {
            tx.execute(&format!("DELETE FROM profile_checks WHERE profile_id IN (SELECT p.id FROM model_profiles p WHERE {})", crate::model_headers::SECRET_USAGE), [&id])?;
            tx.execute(&format!("UPDATE model_profiles AS p SET revision=revision+1,updated_at=?2 WHERE p.deleted_at IS NULL AND {}", crate::model_headers::SECRET_USAGE), params![id, now])?;
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
            return Err(ApiError::conflict("in_use", "모델 프로필 또는 MCP 서버가 사용 중인 키입니다").with_details(json!({ "used_by": info.used_by })));
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
    pub enabled: bool,
    pub capabilities: crate::model_capabilities::ModelCapabilities,
}

const PCOLS: &str = "id, name, protocol, base_url, model, secret_id, options, revision, created_at, updated_at, \
    (SELECT json_object('ok', json(CASE WHEN k.ok THEN 'true' ELSE 'false' END), 'code', k.code, 'message', k.message, 'latency_ms', k.latency_ms, \
     'checked_at', k.checked_at, 'detail', json(k.detail)) FROM profile_checks k WHERE k.profile_id = model_profiles.id), enabled";

fn profile_row(r: &Row) -> rusqlite::Result<ModelProfile> {
    let o: String = r.get(6)?;
    let options = serde_json::from_str(&o).unwrap_or(json!({}));
    let protocol: String = r.get(2)?;
    let capabilities = crate::model_capabilities::resolve(&protocol, &options);
    Ok(ModelProfile {
        id: r.get(0)?,
        name: r.get(1)?,
        protocol,
        base_url: r.get(3)?,
        model: r.get(4)?,
        secret_id: r.get(5)?,
        options,
        capabilities,
        revision: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
        last_check: r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok()),
        enabled: r.get(11)?,
    })
}

/// 연결 확인(AUTH-001): 생성 요청 없이 provider에 한 번 닿아 보고 결과를 남긴다. 비밀 원문은 응답·기록에 넣지 않는다.
pub async fn check_profile(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let pid = id.clone();
    let (checked, rp) = app.db.call(move |c| configured_profile(c, &pid)).await?;
    let started = std::time::Instant::now();
    let r = crate::provider::check(&rp).await;
    let ms = started.elapsed().as_millis() as i64;
    // 오류 본문에 키가 되돌아오는 서버가 있어도 기록·응답에는 남기지 않는다.
    let (ok, code, message, detail) = match &r {
        Ok(d) => (true, None, None, d.clone()),
        Err(e) => (false, Some(e.code.to_string()), Some(scrub_provider_text(&rp, &e.message)), json!({ "status": e.status, "retryable": e.retryable })),
    };
    let now = crate::util::fmt_time(app.clock.now());
    let prof = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let (current, current_runtime) = configured_profile(&tx, &id)?;
            if !same_check_target(&checked, &rp, &current, &current_runtime) {
                return Err(ApiError::conflict("profile_changed", "연결 확인 중 모델·endpoint·키·헤더가 바뀌었습니다. 현재 설정으로 다시 확인하세요"));
            }
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

pub fn get_enabled_profile(c: &Connection, id: &str) -> ApiResult<ModelProfile> {
    let profile = get_profile(c, id)?;
    if !profile.enabled {
        return Err(ApiError::conflict("profile_disabled", "이 모델 프로필은 비활성화돼 있습니다. 다른 프로필을 명시적으로 선택하거나 설정에서 활성화하세요"));
    }
    Ok(profile)
}

#[derive(Serialize, ts_rs::TS)]
pub struct ModelCatalog {
    pub profile_id: String,
    pub profile_revision: i64,
    pub models: Vec<provider::AvailableModel>,
    pub fetched_at: String,
}

pub async fn catalog(State(app): State<App>, Owner(_p): Owner, Path(id): Path<String>) -> ApiResult<Json<ModelCatalog>> {
    let pid = id.clone();
    let (profile, runtime) = app.db.call(move |c| configured_profile(c, &pid)).await?;
    let mut models = provider::list_models(&runtime).await.map_err(|error| {
        ApiError::new(StatusCode::BAD_GATEWAY, error.code, scrub_provider_text(&runtime, &error.message))
            .with_details(json!({ "provider_status": error.status, "retryable": error.retryable }))
    })?;
    for model in &mut models {
        if scrub_provider_text(&runtime, &model.id) != model.id {
            return Err(ApiError::new(StatusCode::BAD_GATEWAY, "catalog_invalid", "공급자가 비밀정보를 포함한 모델 식별자를 반환해 목록을 표시하지 않았습니다"));
        }
        model.name = scrub_provider_text(&runtime, &model.name);
    }
    let revision = profile.revision;
    app.db.call(move |c| {
        let current = get_profile(c, &id)?;
        if current.revision != revision { return Err(ApiError::revision_conflict(serde_json::to_value(current)?)); }
        Ok(())
    }).await?;
    Ok(Json(ModelCatalog { profile_id: profile.id, profile_revision: revision, models, fetched_at: app.now() }))
}

/// 실행용 provider 설정(비밀 원문 포함). 서버 내부에서만 사용한다.
pub fn runtime_profile(c: &Connection, id: &str) -> ApiResult<(ModelProfile, Profile)> {
    provider_profile(c, get_enabled_profile(c, id)?)
}

fn configured_profile(c: &Connection, id: &str) -> ApiResult<(ModelProfile, Profile)> {
    provider_profile(c, get_profile(c, id)?)
}

fn header_identity(options: &Value) -> Vec<(String, Value)> {
    let mut headers: Vec<_> = options["headers"].as_object().into_iter().flat_map(|headers| headers.iter())
        .map(|(key, value)| (key.to_ascii_lowercase(), value.clone())).collect();
    // 이름은 대소문자를 구분하지 않지만, 중복 이름의 값 순서는 바꾸지 않는다.
    headers.sort_by(|a, b| a.0.cmp(&b.0));
    headers
}

fn same_check_target(a: &ModelProfile, ar: &Profile, b: &ModelProfile, br: &Profile) -> bool {
    let headers = |headers: &[(String, String)]| {
        let mut values: Vec<_> = headers.iter().map(|(name, value)| (name.to_ascii_lowercase(), value.clone())).collect();
        values.sort_by(|a, b| a.0.cmp(&b.0));
        values
    };
    a.protocol == b.protocol && a.base_url == b.base_url && a.model == b.model
        && ar.api_key == br.api_key && headers(&ar.extra_headers) == headers(&br.extra_headers)
}

#[cfg(test)]
#[test]
fn header_identity_normalizes_names_without_hiding_value_changes() {
    assert_eq!(header_identity(&json!({})), header_identity(&json!({"headers":{}})));
    assert_eq!(header_identity(&json!({"headers":{"X-Scope":"public"}})), header_identity(&json!({"headers":{"x-scope":"public"}})));
    assert_ne!(header_identity(&json!({"headers":{"X-Scope":"public"}})), header_identity(&json!({"headers":{"x-scope":"private"}})));
}

pub(crate) fn decrypt_secret(c: &Connection, id: &str) -> ApiResult<String> {
    c.query_row("SELECT grove_decrypt(value) FROM secrets WHERE id = ?1", [id], |r| r.get(0)).optional().map_err(|e| match e {
            rusqlite::Error::UserFunctionError(m) => ApiError::conflict("secret_unreadable", m.to_string()),
            rusqlite::Error::SqliteFailure(f, Some(m)) if f.code == rusqlite::ErrorCode::Unknown => ApiError::conflict("secret_unreadable", m),
            other => other.into(),
    })?.ok_or_else(|| ApiError::conflict("secret_unreadable", "참조한 비밀이 없습니다"))
}

fn provider_profile(c: &Connection, p: ModelProfile) -> ApiResult<(ModelProfile, Profile)> {
    let key = p.secret_id.as_deref().map(|id| decrypt_secret(c, id)).transpose()?;
    let timeout = p.options["timeout_secs"].as_u64().unwrap_or(300).clamp(5, 3600);
    let (headers, sensitive_headers) = if provider::cli::is_cli(&p.protocol) { (vec![], vec![]) }
        else { crate::model_headers::load(c, &p.options)? };
    let rp = Profile {
        protocol: p.protocol.clone(),
        base_url: p.base_url.clone(),
        model: p.model.clone(),
        api_key: key,
        timeout: Duration::from_secs(timeout),
        extra_headers: headers,
        sensitive_headers,
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
    pub enabled: Option<bool>,
}

// OpenAI-compatible endpoint는 그대로 /models·/chat/completions 경로를 붙여 쓴다.
// URL 자격 증명이 프로필·이벤트에 평문으로 저장되지 않게 secret 참조로 분리한다.
fn validate_http_endpoint(protocol: &str, base_url: &str) -> ApiResult<()> {
    if protocol != "openai" { return Ok(()); }
    let url = reqwest::Url::parse(base_url.trim()).map_err(|_| ApiError::invalid("endpoint는 올바른 HTTP(S) URL이어야 합니다"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(ApiError::invalid("endpoint는 올바른 HTTP(S) URL이어야 합니다"));
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err(ApiError::invalid("endpoint에 계정·키·query·fragment를 넣을 수 없습니다. 필요한 키는 secret_id로 연결하세요"));
    }
    Ok(())
}

fn validate_options(protocol: &str, o: &Value) -> ApiResult<()> {
    let obj = o.as_object().ok_or_else(|| ApiError::invalid("options는 객체여야 합니다"))?;
    for (k, v) in obj {
        match k.as_str() {
            "timeout_secs" | "max_tokens" => {
                if !v.as_u64().is_some_and(|n| n > 0 && (k == "timeout_secs" || n <= u64::from(u32::MAX))) {
                    return Err(ApiError::invalid(format!("{k}는 양의 정수여야 합니다")));
                }
            }
            "temperature" => {
                if !v.as_f64().is_some_and(|t| (0.0..=2.0).contains(&t)) {
                    return Err(ApiError::invalid("temperature는 0~2여야 합니다"));
                }
            }
            "headers" => {
                crate::model_headers::validate(v)?;
            }
            "context_window" => {
                if !v.as_u64().is_some_and(|n| n > 0) {
                    return Err(ApiError::invalid("context_window는 양의 정수여야 합니다"));
                }
            }
            "auto_clear_minutes" => {
                if !v.as_u64().is_some_and(|n| n <= 525_600) {
                    return Err(ApiError::invalid("auto_clear_minutes는 0~525600 정수여야 합니다(0=자동 초기화 없음)"));
                }
            }
            "capabilities" => {}
            "fallback" => crate::model_fallback::validate(protocol, v)?,
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
    crate::model_capabilities::validate_options(protocol, o)
}

pub async fn create_profile(State(app): State<App>, Owner(p): Owner, headers: HeaderMap, Json(b): Json<CreateProfile>) -> ApiResult<Response> {
    provider::validate_profile(&b.protocol, &b.base_url, &b.model).map_err(ApiError::invalid)?;
    if b.name.trim().is_empty() || b.name.chars().count() > 80 {
        return Err(ApiError::invalid("이름은 1~80자여야 합니다"));
    }
    let options = b.options.unwrap_or(json!({}));
    let enabled = b.enabled.unwrap_or(true);
    let mut request = json!({ "n": b.name, "p": b.protocol, "u": b.base_url, "m": b.model, "s": b.secret_id, "o": options });
    if !enabled { request["enabled"] = json!(false); }
    let h = idem::body_hash("profile.create", &request);
    // 옛 receipt는 비밀을 참조로 옮긴 응답으로 재생한다. 새 평문 자격 헤더는 받지 않는다.
    if let Some(response) = idem::replay(&app, &p, &headers, &h).await? { return Ok(response); }
    validate_http_endpoint(&b.protocol, &b.base_url)?;
    validate_options(&b.protocol, &options)?;
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        crate::model_headers::validate_references(tx, &options)?;
        if let Some(s) = &b.secret_id {
            secret_info(tx, s)?;
        }
        let id = crate::util::new_id();
        if let Some(fallback) = options.get("fallback") {
            crate::model_fallback::validate_references(tx, &id, fallback)?;
        }
        tx.execute(
            "INSERT INTO model_profiles (id, name, protocol, base_url, model, secret_id, options, created_at, updated_at, enabled) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)",
            params![id, b.name.trim(), b.protocol, b.base_url.trim().trim_end_matches('/'), b.model.trim(), b.secret_id, options.to_string(), now, enabled],
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
    pub enabled: Option<bool>,
}

pub async fn update_profile(
    State(app): State<App>,
    Owner(p): Owner,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<UpdateProfile>,
) -> ApiResult<Response> {
    let mut request = json!({ "id": id, "r": b.expected_revision, "n": b.name, "u": b.base_url, "m": b.model, "s": b.secret_id, "o": b.options });
    if b.secret_id.as_ref().is_some_and(Option::is_none) { request["secret_cleared"] = json!(true); }
    if let Some(enabled) = b.enabled { request["enabled"] = json!(enabled); }
    let h = idem::body_hash("profile.update", &request);
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get_profile(tx, &id)?;
        if let Some(options) = &b.options { validate_options(&cur.protocol, options)?; }
        if cur.revision != b.expected_revision {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        if b.enabled == Some(false) && cur.enabled { ensure_profile_idle(tx, &id)?; }
        let base_url = b.base_url.map(|u| u.trim().trim_end_matches('/').to_string()).unwrap_or(cur.base_url.clone());
        let model = b.model.map(|m| m.trim().to_string()).unwrap_or(cur.model.clone());
        provider::validate_profile(&cur.protocol, &base_url, &model).map_err(ApiError::invalid)?;
        validate_http_endpoint(&cur.protocol, &base_url)?;
        let options = b.options.unwrap_or_else(|| {
            let mut options = cur.options.clone();
            if base_url != cur.base_url || model != cur.model {
                // 다른 모델·endpoint의 확인값을 그대로 지원 보증으로 승격하지 않는다.
                if let Some(object) = options.as_object_mut() {
                    object.remove("capabilities");
                    object.remove("context_window");
                }
            }
            options
        });
        crate::model_headers::validate_references(tx, &options)?;
        if let Some(fallback) = options.get("fallback") {
            crate::model_fallback::validate_references(tx, &id, fallback)?;
        }
        let secret = match b.secret_id {
            Some(s) => s,
            None => cur.secret_id.clone(),
        };
        if let Some(s) = &secret {
            secret_info(tx, s)?;
        }
        if base_url != cur.base_url || model != cur.model || secret != cur.secret_id
            || header_identity(&options) != header_identity(&cur.options) {
            ensure_profile_idle(tx, &id)?;
            tx.execute("DELETE FROM profile_checks WHERE profile_id=?1", [&id])?;
        }
        tx.execute(
            "UPDATE model_profiles SET name = ?2, base_url = ?3, model = ?4, secret_id = ?5, options = ?6, revision = revision + 1, updated_at = ?7, enabled = ?8 WHERE id = ?1",
            params![id, b.name.unwrap_or(cur.name.clone()), base_url, model, secret, options.to_string(), now, b.enabled.unwrap_or(cur.enabled)],
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
        ensure_profile_idle(tx, &id)?;
        tx.execute("UPDATE model_profiles SET deleted_at = ?2 WHERE id = ?1", params![id, now])?;
        events::append(tx, now, "profile.changed", None, None, &json!({ "id": id, "deleted": true }))?;
        Ok((StatusCode::OK, json!({ "deleted": true })))
    })
    .await
}

fn ensure_profile_idle(c: &Connection, id: &str) -> ApiResult<()> {
    let active: i64 = c.query_row(
        "SELECT COUNT(*) FROM turns WHERE profile_id = ?1 AND status IN ('queued','running','awaiting_approval')", [id], |row| row.get(0),
    )?;
    if active > 0 { return Err(ApiError::busy("이 프로필로 실행 중인 턴이 있습니다. 먼저 실행을 끝내거나 취소하세요")); }
    Ok(())
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
