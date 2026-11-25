use axum::{Json, Router, http::{StatusCode, header}, routing::any};
use grove::provider::{self, Profile};
use serde_json::json;
use std::{sync::{Arc, atomic::{AtomicUsize, Ordering}}, time::Duration};

#[tokio::test]
async fn provider_credentials_and_custom_headers_are_not_forwarded_to_redirect_targets() {
    let reached = Arc::new(AtomicUsize::new(0));
    let count = reached.clone();
    let receiver = Router::new().fallback(any(move || {
        let count = count.clone();
        async move { count.fetch_add(1, Ordering::SeqCst); Json(json!({ "data": [] })) }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let destination = format!("http://{}/private-target", listener.local_addr().unwrap());
    let receiver = tokio::spawn(async move { axum::serve(listener, receiver).await.unwrap(); });
    for code in [301, 302, 303, 307, 308] {
        let destination = destination.clone();
        let redirect = Router::new().fallback(any(move || {
            let destination = destination.clone();
            async move { (StatusCode::from_u16(code).unwrap(), [(header::LOCATION, destination)]) }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let redirect = tokio::spawn(async move { axum::serve(listener, redirect).await.unwrap(); });
        for protocol in ["openai", "anthropic", "gemini"] {
            let profile = Profile {
                protocol: protocol.into(), base_url: base.clone(), model: "fixture".into(),
                api_key: Some("not-a-real-provider-key".into()), timeout: Duration::from_secs(5),
                extra_headers: vec![("x-custom-credential".into(), "not-a-real-credential".into())], sensitive_headers: vec![],
            };
            let error = provider::check(&profile).await.unwrap_err();
            assert_eq!(error.code, "redirect_blocked");
        }
        let response = provider::http_client(Duration::from_secs(5)).post(&base)
            .header("x-api-key", "not-a-real-provider-key").json(&json!({ "prompt": "private fixture" })).send().await.unwrap();
        assert_eq!(response.status().as_u16(), code, "생성 POST에도 같은 HTTP client 정책을 적용한다");
        redirect.abort();
    }
    receiver.abort();
    assert_eq!(reached.load(Ordering::SeqCst), 0, "다른 주소로 자격·본문·추가 헤더를 보내지 않는다");
}
