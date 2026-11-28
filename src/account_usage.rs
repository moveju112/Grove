//! 공식 CLI 출력만 사용하는 계정 한도. OAuth 자격을 직접 읽거나 비공개 API를 호출하지 않는다.
use crate::{App, auth::Principal, error::ApiResult};
use axum::{Json, extract::State, response::{IntoResponse, Response}};
use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, Instant};

const CLAUDE_USAGE_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
pub struct AccountUsageLimit {
    pub label: String,
    pub remaining_percent: Option<f64>,
    pub remaining: Option<String>,
    pub resets_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
pub struct AccountUsage {
    pub protocol: String,
    pub name: String,
    /// available | unsupported | authentication_required | unavailable | rate_limited
    pub status: String,
    pub limits: Vec<AccountUsageLimit>,
    pub checked_at: String,
}

#[derive(Clone, Serialize, ts_rs::TS)]
pub struct AccountUsageReport {
    pub accounts: Vec<AccountUsage>,
}

#[derive(Default)]
pub struct Cache {
    codex: tokio::sync::Mutex<Option<(Instant, AccountUsage)>>,
    claude: tokio::sync::Mutex<Option<(Instant, AccountUsage)>>,
    /// 실행이 한도 오류로 거절된 계정과 다시 시도할 시각. 조회 캐시가 따라오기 전까지 보조 작업을 대체 모델로 보낸다.
    blocked: std::sync::Mutex<std::collections::HashMap<String, Instant>>,
}

impl Cache {
    pub(crate) fn block(&self, account: &str, ttl: Duration) {
        self.blocked.lock().unwrap_or_else(|e| e.into_inner()).insert(account.into(), Instant::now() + ttl);
    }

    pub(crate) fn is_blocked(&self, account: &str) -> bool {
        let mut blocked = self.blocked.lock().unwrap_or_else(|e| e.into_inner());
        blocked.retain(|_, until| *until > Instant::now());
        blocked.contains_key(account)
    }

    fn entry(&self, protocol: &str) -> &tokio::sync::Mutex<Option<(Instant, AccountUsage)>> {
        if protocol == "codex_cli" { &self.codex } else { &self.claude }
    }

    pub async fn clear(&self, protocol: &str) { *self.entry(protocol).lock().await = None; }

    pub(crate) async fn read(&self, protocol: &str, now: &str) -> AccountUsage {
        // 여러 기기의 동시 조회도 공급자 요청 한 번으로 합친다.
        let mut cache = self.entry(protocol).lock().await;
        if let Some((_, usage)) = cache.as_ref().filter(|(until, _)| *until > Instant::now()) {
            return usage.clone();
        }
        let result = if protocol == "codex_cli" {
            crate::provider::cli::account_limits().await.and_then(|value| codex_limits(&value))
        } else {
            read_claude().await
        };
        let (limits, status) = match result {
            Ok(limits) if !limits.is_empty() => (limits, "available"),
            Ok(_) | Err("unsupported") => (vec![], "unsupported"),
            Err("authentication_required") => (vec![], "authentication_required"),
            Err("rate_limited") => (vec![], "rate_limited"),
            Err(_) => (vec![], "unavailable"),
        };
        let usage = AccountUsage {
            protocol: protocol.into(),
            name: if protocol == "codex_cli" { "Codex" } else { "Claude" }.into(),
            status: status.into(), limits, checked_at: now.into(),
        };
        // 탭·기기·수동 새로고침과 무관하게 `/usage` 요청의 빈도를 제한한다.
        let ttl = if protocol == "claude_code" && status != "authentication_required" {
            CLAUDE_USAGE_TTL
        } else { Duration::from_secs(60) };
        *cache = Some((Instant::now() + ttl, usage.clone()));
        usage
    }
}

/// 활성 프로필이 있는 CLI 계정. Codex OAuth는 Codex CLI 계정 한도를 공유한다.
pub(crate) fn account_protocols(c: &rusqlite::Connection) -> ApiResult<Vec<String>> {
    let mut statement = c.prepare("SELECT DISTINCT CASE WHEN protocol='codex_oauth' THEN 'codex_cli' ELSE protocol END AS account_protocol
        FROM model_profiles WHERE enabled=1 AND deleted_at IS NULL AND protocol IN ('codex_cli','codex_oauth','claude_code') ORDER BY account_protocol")?;
    Ok(statement.query_map([], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?)
}

pub async fn get(State(app): State<App>, _p: Principal) -> ApiResult<Response> {
    let protocols = app.db.call(|c| account_protocols(c)).await?;
    let now = app.now();
    let accounts = futures_util::future::join_all(protocols.iter().map(|protocol| app.account_usage.read(protocol, &now))).await;
    Ok(([("cache-control", "no-store")], Json(AccountUsageReport { accounts })).into_response())
}

fn percent(value: &Value) -> Result<f64, &'static str> {
    value.as_f64().filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| (100.0 - value).clamp(0.0, 100.0)).ok_or("invalid")
}

fn timestamp(value: &Value) -> Result<Option<String>, &'static str> {
    if value.is_null() { return Ok(None); }
    let time = value.as_i64().and_then(|value| time::OffsetDateTime::from_unix_timestamp(value).ok()).ok_or("invalid")?;
    Ok(Some(crate::util::fmt_time(time)))
}

fn window_name(minutes: Option<u64>, fallback: &str) -> String {
    match minutes {
        Some(10080) => "주간".into(),
        Some(minutes) if minutes > 0 && minutes % 1440 == 0 => format!("{}일", minutes / 1440),
        Some(minutes) if minutes > 0 && minutes % 60 == 0 => format!("{}시간", minutes / 60),
        Some(minutes) => format!("{minutes}분"),
        None => fallback.into(),
    }
}

fn safe_label(value: Option<&str>) -> String {
    value.unwrap_or_default().chars().filter(|c| !c.is_control()).take(80).collect()
}

pub(crate) fn codex_limits(value: &Value) -> Result<Vec<AccountUsageLimit>, &'static str> {
    let mut limits = Vec::new();
    let buckets: Vec<(&str, &Value)> = match value["rateLimitsByLimitId"].as_object().filter(|map| !map.is_empty()) {
        Some(map) => map.iter().map(|(key, value)| (key.as_str(), value)).collect(),
        None => vec![("codex", value.get("rateLimits").ok_or("invalid")?)],
    };
    for (key, bucket) in buckets {
        if !bucket.is_object() { return Err("invalid"); }
        let name = if key == "codex" { String::new() }
            else { safe_label(bucket["limitName"].as_str().or(Some(key))) };
        let label = |suffix: &str| if name.is_empty() { suffix.to_string() } else { format!("{name} {suffix}") };
        for (field, fallback) in [("primary", "단기"), ("secondary", "장기")] {
            let window = &bucket[field];
            if window.is_null() { continue; }
            limits.push(AccountUsageLimit {
                label: label(&window_name(window["windowDurationMins"].as_u64(), fallback)),
                remaining_percent: Some(percent(&window["usedPercent"])?),
                remaining: None, resets_at: timestamp(&window["resetsAt"])?,
            });
        }
        let individual = &bucket["individualLimit"];
        if !individual.is_null() {
            let remaining = individual["remainingPercent"].as_f64().filter(|v| v.is_finite()).ok_or("invalid")?;
            limits.push(AccountUsageLimit { label: label("개인 한도"), remaining_percent: Some(remaining.clamp(0.0, 100.0)),
                remaining: None, resets_at: timestamp(&individual["resetsAt"])? });
        }
        let credits = &bucket["credits"];
        if credits["unlimited"] == true {
            limits.push(AccountUsageLimit { label: label("크레딧"), remaining_percent: None, remaining: Some("무제한".into()), resets_at: None });
        } else if let Some(balance) = credits["balance"].as_str() {
            // 숫자만 반환한다. 공급자 원문을 임의의 UI 문자열로 전달하지 않는다.
            let number = balance.parse::<f64>().ok().filter(|v| v.is_finite() && *v >= 0.0).ok_or("invalid")?;
            limits.push(AccountUsageLimit { label: label("크레딧"), remaining_percent: None, remaining: Some(number.to_string()), resets_at: None });
        }
    }
    Ok(limits)
}

async fn read_claude() -> Result<Vec<AccountUsageLimit>, &'static str> {
    let report = crate::provider::cli::claude_usage::read(std::path::Path::new("claude")).await?;
    claude_limits(&report)
}

fn claude_limits(report: &Value) -> Result<Vec<AccountUsageLimit>, &'static str> {
    let rows = report["rate_limits"]["limits"].as_array().ok_or("unavailable")?;
    let mut limits = Vec::new();
    // 모델·제품 전용 한도가 아니라 전체 계정의 두 창만 사용한다.
    for (kind, label) in [("session", "5시간"), ("weekly_all", "주간")] {
        for row in rows.iter().filter(|row| row["kind"] == kind && row["scope"].is_null()) {
            let Some(used) = row["percent"].as_f64().filter(|v| (0.0..=100.0).contains(v)) else { continue; };
            let resets_at = match &row["resets_at"] {
                Value::Null => None,
                value => {
                    let Some(time) = value.as_str().and_then(crate::util::parse_time) else { continue; };
                    Some(crate::util::fmt_time(time.to_offset(time::UtcOffset::UTC)))
                }
            };
            limits.push(AccountUsageLimit { label: label.into(), remaining_percent: Some(100.0 - used), remaining: None, resets_at });
            break;
        }
    }
    Ok(limits)
}

#[cfg(test)]
#[path = "account_usage_tests.rs"]
mod tests;
