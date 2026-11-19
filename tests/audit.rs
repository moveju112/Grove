//! 감사 기록(SEC-023): 누가 무엇을 바꿨는지 남고, 비밀은 남지 않는다.
mod common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::json;

#[tokio::test]
async fn audit_records_changes_by_actor_without_secrets() {
    let s = TestServer::start().await;
    // 페어링 후 접근 자격은 응답에만 있다.
    let dev = s.registered_device("phone").await;
    let dev_token = dev["token"].as_str().unwrap().to_string();
    // 비밀 저장
    let (st, sec) = s.post("/api/v1/secrets", json!({ "label": "openai", "value": "sk-audit-secret-9999" })).await;
    assert_eq!(st, StatusCode::CREATED, "{sec}");
    // 페어링한 브라우저 토큰으로 설정 변경(행위자가 브라우저로 남아야 한다)
    let r = s
        .client
        .put(format!("{}/api/v1/settings/server/-/tools.mode", s.base))
        .bearer_auth(&dev_token)
        .header("Idempotency-Key", "dev-set-1")
        .header("X-Grove-Protocol", "1")
        .json(&json!({ "expected_revision": 1, "value": "bypass" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK, "{}", r.text().await.unwrap());
    // 기기 폐기
    let (st, _) = s.send(Method::DELETE, &format!("/api/v1/devices/{}", dev["id"].as_str().unwrap()), json!(null)).await;
    assert_eq!(st, StatusCode::OK);

    let (st, a) = s.get("/api/v1/audit").await;
    assert_eq!(st, StatusCode::OK, "{a}");
    let items = a["items"].as_array().unwrap();
    let actions: Vec<&str> = items.iter().map(|x| x["action"].as_str().unwrap()).collect();
    assert_eq!(actions, ["device.revoked", "setting.changed", "secret.created",
        "pairing.approved", "pairing.requested", "pairing.created"], "최신순");
    let set = &items[1];
    assert_eq!(set["actor"]["kind"], "browser");
    assert_eq!(set["actor"]["name"], "phone");
    assert_eq!(set["target"], "server:-:tools.mode");
    assert_eq!(set["detail"]["new"], "bypass");
    assert_eq!(items[0]["actor"]["kind"], "owner");
    // 비밀·토큰은 어디에도 없다
    let text = a.to_string();
    assert!(!text.contains("sk-audit-secret"), "비밀 값 없음");
    let secret_part = dev_token.rsplit('.').next().unwrap();
    assert!(!text.contains(secret_part), "토큰 원문 없음");
    // DB 파일에도 없다
    let c = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    let all: String = c.query_row("SELECT group_concat(detail, ' ') FROM audit_log", [], |r| r.get(0)).unwrap();
    assert!(!all.contains("sk-audit-secret") && !all.contains(secret_part));

    // 페이지(cursor)
    let (_, p1) = s.get("/api/v1/audit?limit=3").await;
    let cur = p1["next_cursor"].as_i64().unwrap();
    let (_, p2) = s.get(&format!("/api/v1/audit?limit=3&before={cur}")).await;
    let older: Vec<_> = p2["items"].as_array().unwrap().iter().map(|x| x["action"].as_str().unwrap()).collect();
    assert_eq!(older, &actions[3..]);
    assert!(p2["next_cursor"].is_null());
}

#[tokio::test]
async fn audit_requires_a_registered_device() {
    let s = TestServer::start().await;
    let dev = s.registered_device("tablet").await;
    let r = s.client.get(format!("{}/api/v1/audit", s.base)).bearer_auth(dev["token"].as_str().unwrap()).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
}
