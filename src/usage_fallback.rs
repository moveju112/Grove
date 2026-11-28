//! 계속 도는 보조 작업(제목·압축·Maintainer·보조 역할)이 Claude·Codex 계정 한도 소진으로 멈추지 않게 한다.
//! 작업별로 사용자가 고른 대체 모델만 쓴다. 한도는 공식 CLI 조회의 캐시값(최대 5분)이라 실제 소진보다 늦게 반영될 수 있다.
use crate::{App, account_usage::AccountUsage, error::ApiResult, models::ModelSelection};
use rusqlite::Connection;

/// 보조 작업 모델 설정 key와 한도 소진 시 대체 모델 설정 key.
pub const KEYS: &[(&str, &str)] = &[
    ("session.title_profile", "session.title_fallback"),
    ("context.summary_profile", "context.summary_fallback"),
    ("memory.profile", "memory.fallback"),
    ("agents.profile.context-explorer", "agents.fallback.context-explorer"),
    ("agents.profile.failure-analyst", "agents.fallback.failure-analyst"),
    ("agents.profile.handoff-summarizer", "agents.fallback.handoff-summarizer"),
];

pub fn fallback_key(profile_key: &str) -> Option<&'static str> {
    KEYS.iter().find(|(key, _)| *key == profile_key).map(|(_, fallback)| *fallback)
}

/// 한도를 공유하는 계정 단위. Codex OAuth와 CLI는 같은 계정 한도를 쓴다.
fn account(protocol: &str) -> Option<&'static str> {
    match protocol {
        "claude_code" => Some("claude_code"),
        "codex_cli" | "codex_oauth" => Some("codex_cli"),
        _ => None,
    }
}

/// 실행 직전에 관측한 한도 소진 계정. 동기 DB 경로에 넘기려고 transaction 밖에서 만든다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Exhausted(Vec<&'static str>);

impl Exhausted {
    fn contains(&self, protocol: &str) -> bool {
        account(protocol).is_some_and(|account| self.0.contains(&account))
    }
}

/// 남은 사용률이 0인 창이 아직 초기화되지 않았고, 남은 크레딧·무제한 크레딧도 없으면 소진으로 본다.
pub(crate) fn exhausted(usage: &AccountUsage, now: &str) -> bool {
    if usage.status != "available" { return false; }
    let now = crate::util::parse_time(now);
    let credits = usage.limits.iter().any(|limit| limit.remaining.as_deref()
        .is_some_and(|value| value == "무제한" || value.parse::<f64>().is_ok_and(|n| n > 0.0)));
    !credits && usage.limits.iter().any(|limit| {
        let reset = limit.resets_at.as_deref().and_then(crate::util::parse_time);
        limit.remaining_percent.is_some_and(|left| left <= 0.0)
            && !matches!((reset, now), (Some(reset), Some(now)) if reset <= now)
    })
}

/// 대체 모델을 설정한 작업만 계정 한도를 조회한다. 조회 실패는 소진이 아닌 것으로 본다.
pub async fn observe(app: &App, fallback_key: &'static str) -> Exhausted {
    let accounts = app.db.call(move |c| {
        if ModelSelection::parse(&crate::settings::effective(c, fallback_key, None, None)?)?.is_none() { return Ok(vec![]); }
        crate::account_usage::account_protocols(c)
    }).await.unwrap_or_default();
    let now = app.now();
    let mut out = Exhausted::default();
    for protocol in accounts {
        if exhausted(&app.account_usage.read(&protocol, &now).await, &now)
            && let Some(account) = account(&protocol)
        {
            out.0.push(account);
        }
    }
    out
}

/// 원래 모델의 계정이 소진됐고 대체 모델은 쓸 수 있으면 대체 모델을 돌려준다.
/// 대체 모델이 없거나 비활성·삭제됐거나 같은 소진 계정이면 원래 모델을 유지한다.
pub fn apply(c: &Connection, profile_key: &str, primary: ModelSelection, exhausted: &Exhausted) -> ApiResult<ModelSelection> {
    if exhausted.0.is_empty() { return Ok(primary); }
    let Some(key) = fallback_key(profile_key) else { return Ok(primary) };
    let Ok(source) = crate::models::get_enabled_profile(c, &primary.profile_id) else { return Ok(primary) };
    if !exhausted.contains(&source.protocol) { return Ok(primary); }
    let Some(fallback) = ModelSelection::parse(&crate::settings::effective(c, key, None, None)?)? else { return Ok(primary) };
    let Ok((target, _)) = fallback.runtime(c) else { return Ok(primary) };
    if exhausted.contains(&target.protocol) { return Ok(primary); }
    tracing::info!(setting = profile_key, from = %source.protocol, to = %target.protocol, "계정 한도 소진으로 대체 모델 사용");
    Ok(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account_usage::AccountUsageLimit;
    use rusqlite::params;

    fn usage(status: &str, limits: Vec<AccountUsageLimit>) -> AccountUsage {
        AccountUsage { protocol: "codex_cli".into(), name: "Codex".into(), status: status.into(), limits, checked_at: "t".into() }
    }
    fn limit(left: Option<f64>, remaining: Option<&str>, resets_at: Option<&str>) -> AccountUsageLimit {
        AccountUsageLimit { label: "5시간".into(), remaining_percent: left, remaining: remaining.map(str::to_string), resets_at: resets_at.map(str::to_string) }
    }

    #[test]
    fn exhausted_needs_an_empty_window_that_has_not_reset_and_no_credits() {
        let now = "2026-11-28T05:00:00.000Z";
        assert!(exhausted(&usage("available", vec![limit(Some(40.0), None, None), limit(Some(0.0), None, Some("2026-11-28T07:00:00.000Z"))]), now));
        assert!(!exhausted(&usage("available", vec![limit(Some(0.5), None, None)]), now));
        assert!(!exhausted(&usage("available", vec![limit(Some(0.0), None, Some("2026-11-28T04:00:00.000Z"))]), now), "초기화 시각이 지났다");
        assert!(!exhausted(&usage("available", vec![limit(Some(0.0), None, None), limit(None, Some("12.5"), None)]), now), "크레딧 남음");
        assert!(!exhausted(&usage("available", vec![limit(Some(0.0), None, None), limit(None, Some("무제한"), None)]), now));
        assert!(exhausted(&usage("available", vec![limit(Some(0.0), None, None), limit(None, Some("0"), None)]), now));
        assert!(!exhausted(&usage("unavailable", vec![]), now));
    }

    fn database() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        for migration in crate::store::MIGRATIONS { c.execute_batch(migration).unwrap(); }
        for (id, protocol, enabled) in [("claude", "claude_code", 1), ("codex", "codex_cli", 1), ("off", "codex_cli", 0)] {
            c.execute("INSERT INTO model_profiles(id,name,protocol,base_url,model,enabled,created_at,updated_at) VALUES(?1,?1,?2,'','default',?3,'t','t')",
                params![id, protocol, enabled]).unwrap();
        }
        c
    }
    fn set(c: &Connection, key: &str, value: serde_json::Value) {
        c.execute("INSERT INTO settings(scope,scope_id,key,value,revision,updated_at) VALUES('server','-',?1,?2,1,'t')", params![key, value.to_string()]).unwrap();
    }

    #[test]
    fn apply_switches_only_when_the_source_account_is_exhausted_and_the_fallback_is_usable() {
        let c = database();
        let codex = ModelSelection::from_profile("codex".into());
        let none = Exhausted::default();
        let codex_out = Exhausted(vec!["codex_cli"]);
        // 대체 모델을 고르지 않으면 소진돼도 원래 모델을 유지한다.
        assert_eq!(apply(&c, "session.title_profile", codex.clone(), &codex_out).unwrap(), codex);
        set(&c, "session.title_fallback", serde_json::json!({"profile_id":"claude","model":"fixture-claude"}));
        assert_eq!(apply(&c, "session.title_profile", codex.clone(), &none).unwrap(), codex);
        let switched = apply(&c, "session.title_profile", codex.clone(), &codex_out).unwrap();
        assert_eq!((switched.profile_id.as_str(), switched.model.as_deref()), ("claude", Some("fixture-claude")));
        // 다른 작업의 대체 설정은 공유하지 않는다.
        assert_eq!(apply(&c, "memory.profile", codex.clone(), &codex_out).unwrap(), codex);
        // 대체 모델 계정도 소진됐으면 원래 모델을 유지한다.
        assert_eq!(apply(&c, "session.title_profile", codex.clone(), &Exhausted(vec!["codex_cli", "claude_code"])).unwrap(), codex);
        // 비활성 대체 모델로는 전환하지 않는다.
        set(&c, "memory.fallback", serde_json::json!("off"));
        assert_eq!(apply(&c, "memory.profile", ModelSelection::from_profile("codex".into()), &codex_out).unwrap(), codex);
    }
}
