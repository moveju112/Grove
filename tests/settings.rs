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
async fn profile_settings_require_an_existing_enabled_target_and_allow_inheritance() {
    let s = TestServer::start().await;
    let profile = s.fixture_profile("http://127.0.0.1:9/v1").await;
    for key in ["model.default_profile", "context.summary_profile"] {
        let (status, value) = s.send(Method::PUT, &format!("/api/v1/settings/server/-/{key}"),
            json!({ "expected_revision": 0, "value": profile })).await;
        assert_eq!(status, StatusCode::OK, "{value}");
    }
    assert_eq!(s.send(Method::PUT, &format!("/api/v1/model-profiles/{profile}"),
        json!({ "expected_revision": 1, "enabled": false })).await.0, StatusCode::OK);
    for key in ["model.default_profile", "context.summary_profile"] {
        for (target, expected) in [("missing-profile", StatusCode::NOT_FOUND), (profile.as_str(), StatusCode::CONFLICT)] {
            let (status, value) = s.send(Method::PUT, &format!("/api/v1/settings/server/-/{key}"),
                json!({ "expected_revision": 1, "value": target })).await;
            assert_eq!(status, expected, "{value}");
            let (_, effective) = s.get("/api/v1/settings/effective").await;
            assert_eq!(item(&effective, key)["effective"], profile);
            assert_eq!(item(&effective, key)["layers"]["server"]["revision"], 1);
        }
        assert_eq!(s.send(Method::PUT, &format!("/api/v1/settings/server/-/{key}"),
            json!({ "expected_revision": 1, "value": "" })).await.0, StatusCode::OK);
        let (status, value) = s.send(Method::PUT, &format!("/api/v1/settings/server/-/{key}"),
            json!({ "expected_revision": 2, "value": null })).await;
        assert_eq!(status, StatusCode::OK, "{value}");
        assert_eq!(value["item"]["source"], "default");
    }
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

#[tokio::test]
async fn oversized_instruction_prefix_and_its_hash_reach_the_model_without_the_tail() {
    use std::io::{Seek, SeekFrom, Write};
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("instruction-limit").await;
    let pid = project["id"].as_str().unwrap();
    let path = std::path::Path::new(project["root_path"].as_str().unwrap()).join("AGENTS.md");
    let mut file = std::fs::File::create(path).unwrap();
    file.write_all(&vec![b'x'; 64 * 1024]).unwrap();
    file.set_len(4 * 1024 * 1024).unwrap();
    file.seek(SeekFrom::End(-32)).unwrap();
    file.write_all(b"UNSENT_INSTRUCTION_TAIL_FIXTURE").unwrap();
    drop(file);
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/instructions.mode"), json!({"expected_revision":0,"value":"agents_md"})).await;
    assert_eq!(status, StatusCode::OK);
    let session = s.create_session(pid).await;
    f.push(fixture::text("ok"));
    let (_, accepted) = s.post(&format!("/api/v1/sessions/{}/turns", session["id"].as_str().unwrap()), json!({"text":"hi","profile_id":profile})).await;
    let turn = s.wait_status(accepted["turn"]["id"].as_str().unwrap(), "completed").await;
    let expected = format!("{}\n…(지침 파일이 65536바이트를 넘어 잘림)", "x".repeat(64 * 1024));
    let request = &f.requests()[0];
    let system = request["messages"][0]["content"].as_str().unwrap();
    assert!(system.contains(&serde_json::to_string(&expected).unwrap()));
    assert!(!system.contains("UNSENT_INSTRUCTION_TAIL_FIXTURE"));
    assert_eq!(turn["definition"]["instructions"][0]["sha256"], grove::util::sha256_hex(expected.as_bytes()));
    assert!(turn["definition"]["instructions"][0].get("body").is_none());
}
