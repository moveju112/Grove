//! 범위별 설정(SETTINGS, CONFIG, FLOW-14).
mod common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

fn item<'a>(v: &'a Value, key: &str) -> &'a Value {
    v["items"].as_array().unwrap().iter().find(|i| i["key"] == key).unwrap()
}

#[tokio::test]
async fn precedence_and_isolation_between_projects() {
    let s = TestServer::start().await;
    let a = s.create_project("a").await;
    let b = s.create_project("b").await;
    let (pa, pb) = (a["id"].as_str().unwrap(), b["id"].as_str().unwrap());
    let sa = s.create_session(pa).await;
    let sid = sa["id"].as_str().unwrap();
    let (_, eff) = s.get(&format!("/api/v1/settings/effective?project_id={pa}")).await;
    assert_eq!(item(&eff, "output.language")["source"], "default");

    let put = |scope: &str, id: &str, key: &str, rev: i64, value: Value| {
        let path = format!("/api/v1/settings/{scope}/{id}/{key}");
        let body = json!({ "expected_revision": rev, "value": value });
        (path, body)
    };
    let (p, b1) = put("server", "-", "output.language", 0, json!("영어"));
    assert_eq!(s.send(Method::PUT, &p, b1).await.0, StatusCode::OK);
    let (p, b1) = put("project", pa, "output.language", 0, json!("한국어"));
    let (st, v) = s.send(Method::PUT, &p, b1).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["applies"], "next_turn");
    // FLOW-14: 프로젝트 A 변경이 B에 적용되지 않는다
    let (_, ea) = s.get(&format!("/api/v1/settings/effective?project_id={pa}")).await;
    let (_, eb) = s.get(&format!("/api/v1/settings/effective?project_id={pb}")).await;
    assert_eq!(item(&ea, "output.language")["effective"], "한국어");
    assert_eq!(item(&ea, "output.language")["source"], "project");
    assert_eq!(item(&eb, "output.language")["effective"], "영어");
    // 대화 범위가 가장 우선, 대화는 자기 프로젝트를 상속
    let (p, b1) = put("session", sid, "output.language", 0, json!("일본어"));
    s.send(Method::PUT, &p, b1).await;
    let (_, es) = s.get(&format!("/api/v1/settings/effective?session_id={sid}")).await;
    assert_eq!(es["project_id"], pa);
    assert_eq!(item(&es, "output.language")["effective"], "일본어");
    assert_eq!(item(&es, "output.language")["layers"]["project"]["value"], "한국어");
    // override 제거(null) → 상위 값
    let (p, b1) = put("session", sid, "output.language", 1, Value::Null);
    let (st, v) = s.send(Method::PUT, &p, b1).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["item"]["effective"], "한국어");
}

#[tokio::test]
async fn invalid_values_scope_and_conflicts_keep_previous() {
    let s = TestServer::start().await;
    let p = s.create_project("p").await;
    let pid = p["id"].as_str().unwrap();
    let ok = s.send(Method::PUT, "/api/v1/settings/server/-/approval.ttl_secs", json!({ "expected_revision": 0, "value": 600 })).await;
    assert_eq!(ok.0, StatusCode::OK);
    for (path, body) in [
        ("/api/v1/settings/server/-/approval.ttl_secs", json!({ "expected_revision": 1, "value": 1 })),
        ("/api/v1/settings/server/-/approval.ttl_secs", json!({ "expected_revision": 1, "value": "600" })),
        ("/api/v1/settings/server/-/instructions.mode", json!({ "expected_revision": 0, "value": "everything" })),
        ("/api/v1/settings/server/x/output.language", json!({ "expected_revision": 0, "value": "a" })),
    ] {
        let (st, v) = s.send(Method::PUT, path, body).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{path}: {v}");
    }
    // 프로젝트 범위를 지원하지 않는 설정
    let (st, _) = s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/approval.ttl_secs"), json!({ "expected_revision": 0, "value": 60 })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = s.send(Method::PUT, "/api/v1/settings/server/-/nope", json!({ "expected_revision": 0, "value": 1 })).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    // 오래된 revision → 충돌, 현재값 반환, 기존 값 유지
    let (st, v) = s.send(Method::PUT, "/api/v1/settings/server/-/approval.ttl_secs", json!({ "expected_revision": 0, "value": 900 })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["details"]["current"]["effective"], 600);
    let (_, eff) = s.get("/api/v1/settings/effective").await;
    assert_eq!(item(&eff, "approval.ttl_secs")["effective"], 600);
    let (_, reg) = s.get("/api/v1/settings/registry").await;
    assert!(reg.as_array().unwrap().iter().all(|d| d["scopes"].is_array() && d["applies"].is_string()));
}

#[tokio::test]
async fn instructions_and_language_reach_model_and_are_fixed_per_turn() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("p").await;
    let root = p["root_path"].as_str().unwrap();
    std::fs::write(format!("{root}/AGENTS.md"), "항상 테스트를 먼저 작성한다").unwrap();
    std::fs::write(format!("{root}/CLAUDE.md"), "클로드 지침").unwrap();
    let pid = p["id"].as_str().unwrap();
    s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/instructions.mode"), json!({ "expected_revision": 0, "value": "agents_md" })).await;
    s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/output.language"), json!({ "expected_revision": 0, "value": "한국어" })).await;
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    f.push(fixture::text("ok"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "hi", "profile_id": prof })).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let sys = f.requests()[0]["messages"][0]["content"].as_str().unwrap().to_string();
    assert!(sys.contains("항상 테스트를 먼저 작성한다"));
    assert!(!sys.contains("클로드 지침"), "agents_md 모드에서는 CLAUDE.md를 넣지 않는다");
    assert!(sys.contains("Respond in 한국어"));
    assert_eq!(t["definition"]["instructions"][0]["file"], "AGENTS.md");
    assert!(t["definition"]["instructions"][0].get("body").is_none(), "응답에는 원문 대신 hash만");
    // 끄면 다음 턴부터 빠진다
    s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/instructions.mode"), json!({ "expected_revision": 1, "value": "off" })).await;
    f.push(fixture::text("ok"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "hi2", "profile_id": prof })).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let sys = f.requests()[1]["messages"][0]["content"].as_str().unwrap().to_string();
    assert!(!sys.contains("항상 테스트를 먼저 작성한다"));
}
