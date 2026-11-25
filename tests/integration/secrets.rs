//! 저장 비밀정보 암호화(SEC-018, SEC-019).
use crate::common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::StatusCode;
use serde_json::json;

const KEY: &str = "sk-test-secret-value-1234";

fn raw_values(db: &std::path::Path) -> Vec<String> {
    let c = rusqlite::Connection::open(db).unwrap();
    let mut st = c.prepare("SELECT value FROM secrets").unwrap();
    st.query_map([], |r| r.get(0)).unwrap().map(|x| x.unwrap()).collect()
}

#[tokio::test]
async fn secrets_are_encrypted_at_rest_and_in_snapshots() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await; // KEY 값으로 secret 생성
    let db = s.data_dir().join("grove.db");
    let vals = raw_values(&db);
    assert_eq!(vals.len(), 1);
    assert!(vals[0].starts_with("v1:") && !vals[0].contains(KEY), "DB에 평문이 없다: {}", vals[0]);
    // 목록은 마스킹(복호화 후)
    let (_, list) = s.get("/api/v1/secrets").await;
    let masked = list[0]["masked"].as_str().unwrap();
    assert!(!masked.contains(KEY) && masked.ends_with("1234"), "{masked}");
    // 모델 호출은 그대로 동작(복호화된 키 사용)
    let p = s.create_project("sec").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    f.push(fixture::text("ok"));
    let (_, t) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "q", "profile_id": prof })).await;
    s.wait_status(t["turn"]["id"].as_str().unwrap(), "completed").await;
    let auth = f.headers(0).get("authorization").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    assert!(auth.contains(KEY), "provider에는 복호화된 키가 간다");
    // snapshot 파일에도 평문 없음
    let snap = s.dir.path().join("snap.db");
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_grove")).arg("snapshot").arg(&snap).arg("--data-dir").arg(s.data_dir()).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let bytes = std::fs::read(&snap).unwrap();
    assert!(!bytes.windows(KEY.len()).any(|w| w == KEY.as_bytes()), "snapshot에 평문 키가 있다");
    // 키 파일 없이 복원한 서버: 목록은 '해독 불가', 실행은 명확한 오류
    let restored_dir = tempfile::tempdir().unwrap();
    let restored = restored_dir.path().join("data");
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_grove")).arg("restore").arg(&snap).arg(&restored).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    s.stop().await;
    let mut r = TestServer::start_with(restored_dir, common::config(&restored)).await;
    let (_, list) = r.get("/api/v1/secrets").await;
    assert!(list[0]["masked"].as_str().unwrap().contains("해독 불가"), "{list}");
    let (_, sessions) = r.get("/api/v1/sessions/search").await;
    let sid2 = sessions["items"][0]["session"]["id"].as_str().unwrap();
    let (st, e) = r.post(&format!("/api/v1/sessions/{sid2}/turns"), json!({ "text": "q", "profile_id": prof })).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{e}");
    let tv = r.wait_status(e["turn"]["id"].as_str().unwrap(), "failed").await;
    assert_eq!(tv["error"]["code"], "secret_unreadable", "{tv}");
    r.stop().await;
}

#[tokio::test]
async fn legacy_plaintext_is_encrypted_on_start() {
    let mut s = TestServer::start().await;
    let db = s.data_dir().join("grove.db");
    s.stop().await;
    {
        let c = rusqlite::Connection::open(&db).unwrap();
        c.execute("INSERT INTO secrets (id, label, value, created_at, updated_at) VALUES ('old', 'old', 'sk-legacy-plain-0000', 't', 't')", []).unwrap();
    }
    s.restart().await;
    let vals = raw_values(&db);
    assert!(vals.iter().all(|v| v.starts_with("v1:")), "{vals:?}");
    let (_, list) = s.get("/api/v1/secrets").await;
    assert!(list[0]["masked"].as_str().unwrap().ends_with("0000"));
}
