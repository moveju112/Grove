use super::*;
use serde_json::json;

#[test]
fn codex_uses_every_bucket_and_does_not_duplicate_the_legacy_view() {
    let value = json!({
        "accountId":"private-account",
        "rateLimits":{"primary":{"usedPercent":99}},
        "rateLimitsByLimitId":{
            "codex":{"primary":{"usedPercent":18,"windowDurationMins":300,"resetsAt":1800000000},
                "secondary":{"usedPercent":100,"windowDurationMins":10080,"resetsAt":null},
                "credits":{"balance":"12.50","unlimited":false}},
            "review":{"limitName":"Review","primary":{"usedPercent":1,"windowDurationMins":1440}},
            "spark":{"limitName":"Spark","primary":{"usedPercent":105,"windowDurationMins":300},
                "individualLimit":{"remainingPercent":40,"resetsAt":1800000000},
                "credits":{"unlimited":true}}
        }
    });
    let limits = codex_limits(&value).unwrap();
    assert_eq!(limits.len(), 7);
    assert_eq!(limits[0].label, "5시간");
    assert_eq!(limits[0].remaining_percent, Some(82.0));
    assert_eq!(limits[0].resets_at.as_deref(), Some("2027-01-15T08:00:00Z"));
    assert_eq!(limits[1].label, "주간");
    assert_eq!(limits[1].remaining_percent, Some(0.0));
    assert_eq!(limits[2].remaining.as_deref(), Some("12.5"));
    assert_eq!(limits[3].label, "Review 1일");
    assert_eq!(limits[4].remaining_percent, Some(0.0));
    assert_eq!(limits[5].remaining_percent, Some(40.0));
    assert_eq!(limits[6].remaining.as_deref(), Some("무제한"));
    assert!(!serde_json::to_string(&limits).unwrap().contains("private-account"));
}

#[test]
fn missing_windows_are_not_full_or_zero_and_durations_are_not_assumed() {
    assert!(codex_limits(&json!({"rateLimits":{}})).unwrap().is_empty());
    let limits = codex_limits(&json!({"rateLimits":{"secondary":{"usedPercent":0,"windowDurationMins":60}}})).unwrap();
    assert_eq!(limits[0].label, "1시간");
    assert_eq!(limits[0].remaining_percent, Some(100.0));
    assert!(limits[0].resets_at.is_none());
    for value in [
        json!({}), json!({"rateLimits":"invalid"}),
        json!({"rateLimits":{"primary":{"usedPercent":null}}}),
        json!({"rateLimits":{"primary":{"usedPercent":-1}}}),
        json!({"rateLimits":{"primary":{"usedPercent":3,"resetsAt":"invalid"}}}),
        json!({"rateLimits":{"credits":{"balance":"private-secret"}}}),
    ] { assert!(codex_limits(&value).is_err()); }
}

#[test]
fn claude_distinguishes_official_auth_status_without_inventing_limits() {
    assert!(claude_limits(Some(true)).unwrap().is_empty());
    assert_eq!(claude_limits(Some(false)).unwrap_err(), "authentication_required");
    assert_eq!(claude_limits(None).unwrap_err(), "unavailable");
}

#[tokio::test]
async fn cache_is_per_provider_and_clear_removes_old_account_values() {
    let cache = Cache::default();
    let usage = AccountUsage { protocol:"codex_cli".into(), name:"Codex".into(), status:"available".into(),
        limits:vec![], checked_at:"2026-01-01T00:00:00Z".into() };
    *cache.codex.lock().await = Some((Instant::now() + Duration::from_secs(60), usage.clone()));
    assert_eq!(cache.read("codex_cli", "ignored").await.checked_at, usage.checked_at);
    cache.clear("claude_code").await;
    assert!(cache.codex.lock().await.is_some());
    cache.clear("codex_cli").await;
    assert!(cache.codex.lock().await.is_none());
}
