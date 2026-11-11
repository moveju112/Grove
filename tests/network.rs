//! 접속 경로와 무관한 HTTP 계약(NET-005). 실제 TCP 서버에 Host·Origin 경계만 바꿔 요청한다.
//! 실제 VPN 라우팅·TLS 인증서·방화벽 상태를 검증하는 시험은 아니다.
mod common;

use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};

#[tokio::test]
async fn local_lan_vpn_and_remote_authorities_share_auth_api_state_and_events() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(&dir.path().join("data"));
    cfg.listen = "0.0.0.0:0".parse().unwrap();
    cfg.allowed_hosts = vec!["localhost".into(), "grove.lan".into(), "grove.vpn".into(), "grove.example".into()];
    cfg.tls_terminated = true;
    let s = TestServer::start_with(dir, cfg).await;
    let port = s.server.as_ref().unwrap().addr.port();
    let base = format!("http://127.0.0.1:{port}/api/v1");
    let root = s.make_project_dir("network");
    let mut project_id = None;
    for (index, host) in ["localhost", "grove.lan", "grove.vpn", "grove.example"].into_iter().enumerate() {
        let origin = format!("https://{host}");
        let unauth = s.client.get(format!("{base}/projects")).header("host", host).header("origin", &origin).send().await.unwrap();
        assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);
        let login = s.client.post(format!("{base}/auth/browser-login"))
            .header("host", host).header("origin", &origin)
            .json(&json!({ "token": s.token, "name": format!("network-{index}") })).send().await.unwrap();
        assert_eq!(login.status(), StatusCode::OK);
        let cookie = login.headers()["set-cookie"].to_str().unwrap();
        assert!(cookie.contains("Secure") && cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
        let credentials: Value = login.json().await.unwrap();
        let token = credentials["access_token"].as_str().unwrap();
        let r = s.client.post(format!("{base}/projects")).header("host", host).header("origin", &origin)
            .bearer_auth(token).header("idempotency-key", "same-project-through-any-network")
            .json(&json!({ "root_path": root })).send().await.unwrap();
        assert_eq!(r.status(), StatusCode::CREATED);
        assert_eq!(r.headers()["x-grove-protocol"], grove::PROTOCOL_VERSION.to_string());
        let project: Value = r.json().await.unwrap();
        if let Some(id) = &project_id { assert_eq!(project["id"], *id); }
        else { project_id = Some(project["id"].clone()); }
        let r = s.client.get(format!("{base}/projects")).header("host", host).header("origin", &origin)
            .bearer_auth(token).send().await.unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.json::<Value>().await.unwrap().as_array().unwrap().len(), 1);
        let mut events = s.client.get(format!("{base}/events")).header("host", host).header("origin", &origin)
            .bearer_auth(token).send().await.unwrap();
        assert_eq!(events.status(), StatusCode::OK);
        let mut body = String::new();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !body.contains("\n\n") {
                body.push_str(&String::from_utf8_lossy(&events.chunk().await.unwrap().unwrap()));
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
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
    }
}
