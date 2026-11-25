//! registry 연결 전에도 실제 소유 모듈을 시험 target에 포함한다. 대체 구현은 만들지 않는다.
use grove::tools;

#[path = "../../src/tools/web_fetch/mod.rs"]
mod web_fetch;

use serde_json::json;
use tokio::sync::watch;

#[test]
fn plan_binds_normalized_url_and_limits_and_rejects_credentials() {
    let planned = web_fetch::plan(&json!({"url": "https://example.com/page#section", "max_bytes": 20})).unwrap();
    assert_eq!(planned.target, json!({"tool": "web_fetch", "url": "https://example.com/page", "max_bytes": 20}));
    for args in [
        json!({"url": "https://example.com", "headers": {"Authorization": "synthetic"}}),
        json!({"url": "https://example.com", "max_bytes": 0}),
        json!({"url": "https://example.com", "max_bytes": 32769}),
        json!({"url": "https://example.com", "max_bytes": "20"}),
        json!({"url": "https://user:synthetic@example.com"}),
    ] {
        assert!(web_fetch::plan(&args).is_err());
    }
    assert!(tools::needs_approval(web_fetch::spec().effect));
}

#[test]
fn execution_future_is_send_for_the_async_runner() {
    fn assert_send<T: Send>(_: T) {}
    let args = json!({"url": "https://example.com"});
    let planned = web_fetch::plan(&args).unwrap();
    let (_tx, cancel) = watch::channel(false);
    assert_send(web_fetch::execute(&args, &planned, cancel));
}

#[tokio::test]
async fn execution_rejects_changed_approved_target_without_network() {
    let args = json!({"url": "https://example.com/a"});
    let planned = web_fetch::plan(&args).unwrap();
    let (_tx, cancel) = watch::channel(false);
    let error = web_fetch::execute(&json!({"url": "https://example.com/b"}), &planned, cancel).await.unwrap_err();
    assert_eq!(error.code, "stale_plan");
}

#[tokio::test]
async fn pre_cancelled_execution_never_starts_network() {
    let args = json!({"url": "https://example.com"});
    let planned = web_fetch::plan(&args).unwrap();
    let (_tx, cancel) = watch::channel(true);
    assert_eq!(web_fetch::execute(&args, &planned, cancel).await.unwrap_err().code, "cancelled");
}
