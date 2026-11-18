//! 접속 경로와 무관한 HTTP 계약(NET-005). 실제 TCP 서버에 Host·Origin 경계만 바꿔 요청한다.
//! 실제 VPN 라우팅·TLS 인증서·방화벽 상태를 검증하는 시험은 아니다.
mod common;
#[path = "common/e2ee.rs"]
mod wire;

use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};

#[tokio::test]
async fn local_lan_vpn_and_remote_authorities_share_auth_api_state_and_events() {
    let mut s = TestServer::start().await;
    let (_, enrolled) = s.pair_browser("network").await;
    let cookie_value = |cookie: &str| cookie.split(';').next().unwrap().split_once('=').unwrap().1.to_string();
    let mut refresh_value = cookie_value(enrolled.headers()["set-cookie"].to_str().unwrap());
    let mut cfg = config(&s.data_dir());
    cfg.listen = "0.0.0.0:0".parse().unwrap();
    cfg.allowed_hosts = vec!["localhost".into(), "grove.lan".into(), "grove.vpn".into(), "grove.example".into()];
    cfg.tls_terminated = true;
    s.stop().await;
    let running = grove::server::start(cfg, std::sync::Arc::new(grove::util::SystemClock)).await.unwrap();
    let port = running.addr.port();
    s.base = format!("http://127.0.0.1:{port}");
    s.server = Some(running);
    let base = format!("http://127.0.0.1:{port}/api/v1");
    let root = s.make_project_dir("network");
    let mut project_id = None;
    for host in ["localhost", "grove.lan", "grove.vpn", "grove.example"] {
        let origin = format!("https://{host}");
        let unauth = s.client.get(format!("{base}/projects")).header("host", host).header("origin", &origin).send().await.unwrap();
        assert_eq!(unauth.status(), StatusCode::UPGRADE_REQUIRED);
        let mut login = wire::Channel::open(&s, Some(host), Some(&origin)).await;
        let metadata = login.request("POST", "/api/v1/auth/refresh",
            vec![("cookie", format!("grove_refresh={refresh_value}"))], Value::Null).await;
        assert_eq!(metadata["status"], 200);
        let cookie = metadata["headers"].as_array().unwrap().iter().find(|h| h[0] == "set-cookie").unwrap()[1].as_str().unwrap();
        assert!(cookie.contains("Secure") && cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
        refresh_value = cookie_value(cookie);
        let credentials: Value = serde_json::from_slice(&login.body().await).unwrap();
        let token = credentials["access_token"].as_str().unwrap();
        let mut r = wire::Channel::open(&s, Some(host), Some(&origin)).await;
        let metadata = r.request("POST", "/api/v1/projects", vec![("authorization", format!("Bearer {token}")),
            ("content-type", "application/json".into()), ("idempotency-key", "same-project-through-any-network".into())],
            json!({ "root_path": root })).await;
        assert_eq!(metadata["status"], 201);
        assert!(metadata["headers"].as_array().unwrap().iter().any(|h| h[0] == "x-grove-protocol" && h[1] == grove::PROTOCOL_VERSION.to_string()));
        let project: Value = serde_json::from_slice(&r.body().await).unwrap();
        if let Some(id) = &project_id { assert_eq!(project["id"], *id); }
        else { project_id = Some(project["id"].clone()); }
        let mut r = wire::Channel::open(&s, Some(host), Some(&origin)).await;
        let metadata = r.request("GET", "/api/v1/projects", vec![("authorization", format!("Bearer {token}"))], Value::Null).await;
        assert_eq!(metadata["status"], 200);
        assert_eq!(serde_json::from_slice::<Value>(&r.body().await).unwrap().as_array().unwrap().len(), 1);
        let mut events = wire::Channel::open(&s, Some(host), Some(&origin)).await;
        let metadata = events.request("GET", "/api/v1/events", vec![("authorization", format!("Bearer {token}"))], Value::Null).await;
        assert_eq!(metadata["status"], 200);
        let mut body = String::new();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !body.contains("\n\n") {
                let chunk = events.receive().await;
                assert_eq!(chunk[0], 1);
                body.push_str(&String::from_utf8_lossy(&chunk[1..]));
                events.send(&[1]).await;
            }
        }).await.unwrap();
        assert!(body.contains("event: hello"));
        let data = body.lines().find_map(|line| line.strip_prefix("data:")).unwrap();
        let hello: Value = serde_json::from_str(data).unwrap();
        assert_eq!(hello["protocol"], grove::PROTOCOL_VERSION);
        assert_eq!(hello["capabilities"], json!(grove::CAPABILITIES));
    }
    for (host, origin) in [("attacker.example", "https://attacker.example"), ("grove.example", "https://attacker.example")] {
        let r = s.client.get(format!("{base}/projects")).header("host", host).header("origin", origin)
            .bearer_auth(&s.token).send().await.unwrap();
        assert_eq!(r.status(), if host == "attacker.example" { StatusCode::FORBIDDEN } else { StatusCode::UPGRADE_REQUIRED });
    }
}
