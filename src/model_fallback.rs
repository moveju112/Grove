//! 명시적으로 확인한 유한 HTTP 순서. 재시도·실행·복구는 기존 runner/provider가 소유한다.
use crate::{
    error::{ApiError, ApiResult},
    models::{self, ModelProfile},
    provider::{self, Profile, ProviderError},
};
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};

pub const MAX_CANDIDATES: usize = 4;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Candidate {
    profile_id: String,
    revision: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Options {
    enabled: bool,
    destination_change_confirmed: bool,
    candidates: Vec<Candidate>,
}

fn options(value: &Value) -> ApiResult<Options> {
    serde_json::from_value(value.clone()).map_err(|_| ApiError::invalid(
        "fallback에는 enabled·destination_change_confirmed(boolean)와 candidates([{profile_id,revision}])만 허용됩니다",
    ))
}

pub fn validate(protocol: &str, value: &Value) -> ApiResult<()> {
    let o = options(value)?;
    if !matches!(protocol, "openai" | "anthropic" | "gemini") {
        return Err(ApiError::unsupported("CLI fallback은 지원하지 않습니다"));
    }
    if o.candidates.len() > MAX_CANDIDATES || (o.enabled && (o.candidates.is_empty() || !o.destination_change_confirmed)) {
        return Err(ApiError::invalid("fallback은 전송 대상 변경을 확인한 1~4개 HTTP 프로필 순서가 필요합니다"));
    }
    let mut seen = std::collections::HashSet::new();
    for candidate in &o.candidates {
        if candidate.profile_id.is_empty() || candidate.revision < 1 || !seen.insert(&candidate.profile_id) {
            return Err(ApiError::invalid("fallback 후보 ID·revision이 잘못됐거나 중복됐습니다"));
        }
    }
    Ok(())
}

pub fn validate_references(c: &Connection, source: &str, value: &Value) -> ApiResult<()> {
    let o = options(value)?;
    for candidate in o.candidates {
        if candidate.profile_id == source {
            return Err(ApiError::invalid("fallback에 원래 프로필을 다시 넣을 수 없습니다"));
        }
        let (p, _) = models::runtime_profile(c, &candidate.profile_id)?;
        if provider::cli::is_cli(&p.protocol) {
            return Err(ApiError::unsupported("CLI fallback은 지원하지 않습니다"));
        }
        if p.revision != candidate.revision {
            return Err(ApiError::conflict("fallback_changed", "fallback 전송 대상이 변경됐습니다. 현재 대상과 가격을 다시 확인하세요"));
        }
    }
    Ok(())
}

fn identity(p: &ModelProfile) -> Value {
    json!({
        "profile_id": p.id, "name": p.name, "revision": p.revision,
        "protocol": p.protocol, "base_url": p.base_url, "model": p.model,
        "secret_id": p.secret_id, "pricing": p.options.get("pricing"),
    })
}

/// 접수 transaction 안에서만 호출한다. 후보의 fallback 옵션은 따라가지 않는다.
pub fn snapshot(c: &Connection, source: &ModelProfile) -> ApiResult<Option<Value>> {
    let Some(value) = source.options.get("fallback") else { return Ok(None) };
    validate(&source.protocol, value)?;
    let o = options(value)?;
    if !o.enabled { return Ok(None); }
    validate_references(c, &source.id, value)?;
    let mut candidates = vec![identity(source)];
    for candidate in o.candidates {
        let (p, _) = models::runtime_profile(c, &candidate.profile_id)?;
        let currency = &source.options["pricing"]["currency"];
        let next_currency = &p.options["pricing"]["currency"];
        if !currency.is_null() && !next_currency.is_null() && currency != next_currency {
            return Err(ApiError::invalid("fallback 가격표의 통화가 달라 비용을 합산할 수 없습니다"));
        }
        candidates.push(identity(&p));
    }
    Ok(Some(json!({
        "original_profile_id": source.id, "actual_profile_id": source.id,
        "candidates": candidates,
        "attempts": [{"profile_id": source.id, "reason": "selected"}],
    })))
}

/// secret 교체도 profile revision을 올린다. 사용 후보를 몰래 최신 대상으로 바꾸지 않는다.
pub fn runtime(c: &Connection, definition: &Value, id: &str) -> ApiResult<(ModelProfile, Profile)> {
    let mut pair = models::runtime_profile(c, id)?;
    if let Some(fallback) = definition.get("fallback") {
        let candidate = fallback["candidates"].as_array().and_then(|a| a.iter().find(|v| v["profile_id"] == id))
            .ok_or_else(|| ApiError::invalid("접수한 fallback 후보가 없습니다"))?;
        if identity(&pair.0) != *candidate {
            return Err(ApiError::conflict("fallback_changed", "접수한 모델 프로필이 변경됐습니다. 다시 확인한 뒤 새 요청을 보내세요"));
        }
    }
    if definition["model_selection"]["profile_id"] == id
        && let Some(model) = definition["model_selection"]["model"].as_str()
    {
        pair.0.model = model.into();
        pair.1.model = model.into();
    }
    Ok(pair)
}

pub fn permitted(error: &ProviderError, step: i64, emitted: bool, cancelled: bool) -> bool {
    !cancelled && !emitted && step == 0
        && matches!((error.code, error.status),
            ("rate_limited" | crate::provider::USAGE_LIMIT, Some(429)) | ("provider_unavailable", Some(500..=599)))
}

/// 오류 기록·실제 프로필·예산 가격·화면 기록을 함께 확정한다.
/// 호출자는 취소 watch를 확인하고, 새 호출은 기존 load_step/FAIR/provider 경계를 다시 지난다.
pub fn after_error(
    c: &mut Connection, turn_id: &str, epoch: &str, error: &ProviderError, may_switch: bool,
) -> ApiResult<bool> {
    let tx = c.transaction()?;
    let (raw, session): (String, String) = tx.query_row(
        "SELECT definition_snapshot,session_id FROM turns WHERE id=?1 AND owner_epoch=?2 AND status='running'",
        params![turn_id, epoch], |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let mut def: Value = serde_json::from_str(&raw)?;
    let Some(fallback) = def.get_mut("fallback") else { return Ok(false) };
    let attempts = fallback["attempts"].as_array_mut().ok_or_else(|| ApiError::invalid("fallback 시도 기록이 손상됐습니다"))?;
    if let Some(last) = attempts.last_mut() {
        last["error"] = json!({"code": error.code, "status": error.status});
    }
    let index = attempts.len();
    let next = fallback["candidates"].get(index).cloned().filter(|_| may_switch);
    let no_steps_or_tools: bool = tx.query_row(
        "SELECT step=0 AND NOT EXISTS(SELECT 1 FROM tool_calls WHERE turn_id=?1) FROM turns WHERE id=?1",
        [turn_id], |r| r.get(0),
    )?;
    let next = next.filter(|_| no_steps_or_tools);
    let now = crate::util::fmt_time(time::OffsetDateTime::now_utc());
    let mut changed = false;
    let blocked = next.as_ref().and_then(|next| {
        runtime(&tx, &def, next["profile_id"].as_str().unwrap_or("")).err()
    });
    if let Some(error) = &blocked {
        def["fallback"]["blocked"] = json!({"code": error.code, "message": error.message});
    }
    if let Some(next) = next.filter(|_| blocked.is_none()) {
        let id = next["profile_id"].as_str().ok_or_else(|| ApiError::invalid("fallback 후보 ID가 없습니다"))?;
        // 이 transaction에서 actual profile을 바꾸면 기존 active-use 편집·secret 보호가 즉시 적용된다.
        def["fallback"]["actual_profile_id"] = json!(id);
        def["fallback"]["attempts"].as_array_mut().unwrap().push(json!({
            "profile_id": id, "reason": error.code, "status": error.status, "selected_at": now,
        }));
        tx.execute("UPDATE turns SET profile_id=?2 WHERE id=?1", params![turn_id, id])?;
        let from = def["fallback"]["candidates"][index - 1].clone();
        crate::sessions::append_message(&tx, &now, &session, "note", &json!({
            "type": "model_fallback", "original_profile_id": def["fallback"]["original_profile_id"],
            "from": from, "to": next, "reason": error.code, "status": error.status,
        }), Some(turn_id), None)?;
        changed = true;
    }
    tx.execute("UPDATE turns SET definition_snapshot=?2,updated_at=?3 WHERE id=?1",
        params![turn_id, def.to_string(), now])?;
    let turn = crate::runner::get_turn(&tx, turn_id)?;
    let project = crate::sessions::get(&tx, &session)?.project_id;
    crate::events::append(&tx, &now, "turn.updated", Some(&project), Some(&session), &serde_json::to_value(turn)?)?;
    tx.commit()?;
    if let Some(error) = blocked { return Err(error); }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_retry_exhausted_http_errors_before_any_progress() {
        for (code, status, allowed) in [
            ("rate_limited", Some(429), true), ("usage_limit", Some(429), true), ("provider_unavailable", Some(503), true),
            ("timeout", Some(504), false), ("provider_unavailable", None, false),
            ("transport_error", None, false), ("auth_failed", Some(403), false),
            ("bad_request", Some(400), false), ("unsupported", Some(503), false),
            ("provider_error", None, false), ("cancelled", None, false),
        ] {
            let mut e = ProviderError::new(code, "fixture");
            e.status = status;
            assert_eq!(permitted(&e, 0, false, false), allowed, "{code}");
            assert!(!permitted(&e, 1, false, false));
            assert!(!permitted(&e, 0, true, false));
            assert!(!permitted(&e, 0, false, true));
        }
    }

    #[test]
    fn configuration_is_explicit_finite_and_http_only() {
        let good = json!({"enabled":true,"destination_change_confirmed":true,"candidates":[{"profile_id":"b","revision":1}]});
        assert!(validate("openai", &good).is_ok());
        assert!(validate("codex_cli", &good).is_err());
        for bad in [
            json!({"enabled":true,"destination_change_confirmed":false,"candidates":[{"profile_id":"b","revision":1}]}),
            json!({"enabled":true,"destination_change_confirmed":true,"candidates":[]}),
            json!({"enabled":false,"destination_change_confirmed":false,"candidates":[],"extra":1}),
            json!({"enabled":true,"destination_change_confirmed":true,"candidates":vec![json!({"profile_id":"b","revision":1});5]}),
        ] {
            assert!(validate("openai", &bad).is_err());
        }
    }
}
