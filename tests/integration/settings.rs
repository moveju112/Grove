//! 범위별 설정(SETTINGS, CONFIG, FLOW-14).
use crate::common;

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
    assert_eq!(item(&eff, "output.style")["source"], "default");

    let put = |scope: &str, id: &str, key: &str, rev: i64, value: Value| {
        let path = format!("/api/v1/settings/{scope}/{id}/{key}");
        let body = json!({ "expected_revision": rev, "value": value });
        (path, body)
    };
    let (p, b1) = put("server", "-", "output.style", 0, json!("concise"));
    assert_eq!(s.send(Method::PUT, &p, b1).await.0, StatusCode::OK);
    let (p, b1) = put("project", pa, "output.style", 0, json!("detailed"));
    let (st, v) = s.send(Method::PUT, &p, b1).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["applies"], "next_turn");
    // FLOW-14: 프로젝트 A 변경이 B에 적용되지 않는다
    let (_, ea) = s.get(&format!("/api/v1/settings/effective?project_id={pa}")).await;
    let (_, eb) = s.get(&format!("/api/v1/settings/effective?project_id={pb}")).await;
    assert_eq!(item(&ea, "output.style")["effective"], "detailed");
    assert_eq!(item(&ea, "output.style")["source"], "project");
    assert_eq!(item(&eb, "output.style")["effective"], "concise");
    // 대화 범위가 가장 우선, 대화는 자기 프로젝트를 상속
    let (p, b1) = put("session", sid, "output.style", 0, json!("default"));
    s.send(Method::PUT, &p, b1).await;
    let (_, es) = s.get(&format!("/api/v1/settings/effective?session_id={sid}")).await;
    assert_eq!(es["project_id"], pa);
    assert_eq!(item(&es, "output.style")["effective"], "default");
    assert_eq!(item(&es, "output.style")["layers"]["project"]["value"], "detailed");
    // override 제거(null) → 상위 값
    let (p, b1) = put("session", sid, "output.style", 1, Value::Null);
    let (st, v) = s.send(Method::PUT, &p, b1).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["item"]["effective"], "detailed");
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
        ("/api/v1/settings/server/-/output.style", json!({ "expected_revision": 0, "value": "everything" })),
        ("/api/v1/settings/server/x/output.style", json!({ "expected_revision": 0, "value": "concise" })),
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
async fn role_models_are_server_wide_and_ignore_legacy_project_and_session_overrides() {
    let s = TestServer::start().await;
    let p = s.create_project("server-models").await;
    let pid = p["id"].as_str().unwrap();
    let other = s.create_project("other-models").await;
    let session = s.create_session(pid).await;
    let sid = session["id"].as_str().unwrap();
    let profile = s.fixture_profile("http://127.0.0.1:9/v1").await;
    let (_, registry) = s.get("/api/v1/settings/registry").await;
    let keys: Vec<_> = registry.as_array().unwrap().iter().filter(|d| {
        matches!(d["key"].as_str(), Some("context.summary_profile" | "session.title_profile" | "memory.profile"))
            || d["key"].as_str().unwrap().starts_with("agents.profile.")
    }).map(|d| {
        assert_eq!(d["scopes"], json!(["server"]));
        d["key"].as_str().unwrap()
    }).collect();
    assert!(!keys.is_empty());
    for key in keys {
        for (scope, id) in [("project", pid), ("session", sid)] {
            let (status, value) = s.send(Method::PUT, &format!("/api/v1/settings/{scope}/{id}/{key}"),
                json!({"expected_revision": 0, "value": profile})).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{value}");
            // 이전 버전에 저장한 override도 런타임 해석에 섞이지 않아야 한다.
            let c = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
            c.execute("INSERT INTO settings(scope,scope_id,key,value,revision,updated_at) VALUES(?1,?2,?3,'\"legacy-profile\"',1,?4)",
                rusqlite::params![scope, id, key, grove::util::fmt_time(time::OffsetDateTime::now_utc())]).unwrap();
        }
        let (status, value) = s.send(Method::PUT, &format!("/api/v1/settings/server/-/{key}"),
            json!({"expected_revision": 0, "value": profile})).await;
        assert_eq!(status, StatusCode::OK, "{value}");
        for query in [format!("project_id={pid}"), format!("project_id={}", other["id"].as_str().unwrap()), format!("session_id={sid}")] {
            let (_, effective) = s.get(&format!("/api/v1/settings/effective?{query}")).await;
            let setting = item(&effective, key);
            assert_eq!(setting["effective"], profile);
            assert_eq!(setting["source"], "server");
            assert_eq!(setting["layers"].as_object().unwrap().len(), 1);
        }
    }
}

#[tokio::test]
async fn profile_settings_require_an_existing_enabled_target_and_allow_inheritance() {
    let s = TestServer::start().await;
    let profile = s.fixture_profile("http://127.0.0.1:9/v1").await;
    for key in ["model.default_profile", "context.summary_profile", "session.title_profile", "memory.profile", "agents.profile.worker"] {
        let (status, value) = s.send(Method::PUT, &format!("/api/v1/settings/server/-/{key}"),
            json!({ "expected_revision": 0, "value": profile })).await;
        assert_eq!(status, StatusCode::OK, "{value}");
    }
    assert_eq!(s.send(Method::PUT, &format!("/api/v1/model-profiles/{profile}"),
        json!({ "expected_revision": 1, "enabled": false })).await.0, StatusCode::OK);
    for key in ["model.default_profile", "context.summary_profile", "session.title_profile", "memory.profile", "agents.profile.worker"] {
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
async fn output_style_reaches_model_without_injecting_project_instruction_files() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("p").await;
    let root = p["root_path"].as_str().unwrap();
    std::fs::write(format!("{root}/AGENTS.md"), "항상 테스트를 먼저 작성한다").unwrap();
    std::fs::write(format!("{root}/CLAUDE.md"), "클로드 지침").unwrap();
    let pid = p["id"].as_str().unwrap();
    s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/output.style"), json!({ "expected_revision": 0, "value": "concise" })).await;
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    f.push(fixture::text("ok"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "hi", "profile_id": prof })).await;
    let t = s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let sys = f.requests()[0]["messages"][0]["content"].as_str().unwrap().to_string();
    assert!(!sys.contains("항상 테스트를 먼저 작성한다"));
    assert!(!sys.contains("클로드 지침"));
    assert!(sys.contains("the core causal"));
    assert!(t["definition"].get("instructions").is_none());
    // 파일은 수정하지 않고 CLI 기본 로더가 읽도록 둔다.
    assert_eq!(std::fs::read_to_string(format!("{root}/AGENTS.md")).unwrap(), "항상 테스트를 먼저 작성한다");
    assert_eq!(std::fs::read_to_string(format!("{root}/CLAUDE.md")).unwrap(), "클로드 지침");
    s.send(Method::PUT, &format!("/api/v1/settings/project/{pid}/output.style"), json!({ "expected_revision": 1, "value": "detailed" })).await;
    f.push(fixture::text("ok"));
    let (_, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "hi2", "profile_id": prof })).await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let sys = f.requests()[1]["messages"][0]["content"].as_str().unwrap().to_string();
    assert!(sys.contains("the mechanism step by step") && !sys.contains("the core causal"));
}

#[tokio::test]
async fn retired_instruction_setting_is_hidden_and_ignored_even_with_saved_overrides() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("retired-instructions").await;
    let pid = project["id"].as_str().unwrap();
    let path = std::path::Path::new(project["root_path"].as_str().unwrap()).join("AGENTS.md");
    std::fs::write(path, "RETIRED_INSTRUCTION_FIXTURE").unwrap();
    {
        let c = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
        for (scope, id) in [("server", "-"), ("project", pid)] {
            c.execute("INSERT INTO settings(scope,scope_id,key,value,revision,updated_at) VALUES(?1,?2,'instructions.mode','\"both\"',1,?3)",
                rusqlite::params![scope, id, grove::util::fmt_time(time::OffsetDateTime::now_utc())]).unwrap();
        }
    }
    let (_, registry) = s.get("/api/v1/settings/registry").await;
    assert!(registry.as_array().unwrap().iter().all(|d| d["key"] != "instructions.mode"));
    let (_, effective) = s.get(&format!("/api/v1/settings/effective?project_id={pid}")).await;
    assert!(effective["items"].as_array().unwrap().iter().all(|d| d["key"] != "instructions.mode"));
    for (scope, id) in [("server", "-"), ("project", pid)] {
        let (status, _) = s.send(Method::PUT, &format!("/api/v1/settings/{scope}/{id}/instructions.mode"),
            json!({"expected_revision":1,"value":"both"})).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
    let session = s.create_session(pid).await;
    f.push(fixture::text("ok"));
    let (_, accepted) = s.post(&format!("/api/v1/sessions/{}/turns", session["id"].as_str().unwrap()), json!({"text":"hi","profile_id":profile})).await;
    let turn = s.wait_status(accepted["turn"]["id"].as_str().unwrap(), "completed").await;
    let request = &f.requests()[0];
    let system = request["messages"][0]["content"].as_str().unwrap();
    assert!(!system.contains("RETIRED_INSTRUCTION_FIXTURE"));
    assert!(turn["definition"].get("instructions").is_none());
}

#[tokio::test]
async fn role_model_selection_validates_and_preserves_atomic_profile_and_model() {
    let s = TestServer::start().await;
    let profile = s.fixture_profile("http://127.0.0.1:9/v1").await;
    let path = "/api/v1/settings/server/-/session.title_profile";
    let selected = json!({"profile_id":profile,"model":"title-small","effort":"low"});
    assert_eq!(s.send(Method::PUT,path,json!({"expected_revision":0,"value":selected})).await.0,StatusCode::OK);
    for invalid in [json!({"profile_id":profile,"model":"bad model"}),json!({"profile_id":"","model":"small"}),
        json!({"profile_id":profile,"model":""}), json!({"profile_id":profile,"effort":"invalid"}),
        json!({"profile_id":profile,"model":"small","service_tier":"priority"})] {
        assert_eq!(s.send(Method::PUT,path,json!({"expected_revision":1,"value":invalid})).await.0,StatusCode::BAD_REQUEST);
    }
    assert_eq!(s.send(Method::PUT,path,json!({"expected_revision":1,"value":{"profile_id":"missing","model":"small"}})).await.0,StatusCode::NOT_FOUND);
    let (_,effective)=s.get("/api/v1/settings/effective").await;
    assert_eq!(item(&effective,"session.title_profile")["effective"],selected);
    assert_eq!(item(&effective,"session.title_profile")["layers"]["server"]["revision"],1);
}
