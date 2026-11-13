mod common;

use common::*;
use reqwest::{Method, StatusCode};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

fn baseline(d: &Value) -> Value {
    json!({
        "name": d["baseline_name"], "description": d["baseline_description"],
        "body": d["baseline_body"], "sha256": d["baseline_sha256"]
    })
}

#[tokio::test]
async fn previous_overrides_survive_reads_restart_and_selected_restore() {
    let mut s = TestServer::start().await;
    // 이전 앱이 보존한 override를 기존 저장 형식 그대로 넣는다. 실제 번들은 바꾸지 않는다.
    {
        let db = Connection::open(s.data_dir().join("grove.db")).unwrap();
        db.execute(
            "INSERT INTO definitions(kind,id,builtin,name,description,body,enabled,revision,created_at,updated_at) \
             VALUES('agent','reviewer',1,'이전 사용자 이름','이전 사용자 설명','이전 사용자 본문',0,7,'old','old')",
            [],
        ).unwrap();
    }
    let path = "/api/v1/definitions/agent/reviewer";
    let (_, before) = s.get(path).await;
    assert_eq!(before["modified_fields"], json!(["name", "description", "body"]));
    assert_ne!(before["body"], before["baseline_body"]);
    let builtin = grove::definitions::find_builtin("agent", "reviewer").unwrap();
    let (name, description, body) = grove::definitions::builtin_fields(builtin);
    assert_eq!(before["baseline_name"], name);
    assert_eq!(before["baseline_description"], description);
    assert_eq!(before["baseline_body"], body);
    s.get("/api/v1/definitions?kind=agent").await;
    s.restart().await;
    assert_eq!(s.get(path).await.1, before, "읽기와 재시작은 mutation이 아니다");

    let request = json!({ "expected_revision": 7, "fields": ["name"], "expected_baseline": baseline(&before) });
    let key = s.key();
    let response = s.raw(Method::POST, &format!("{path}/restore"), Some(request.clone()), Some(&key), None).await;
    assert_eq!(response.status(), StatusCode::OK);
    let restored: Value = response.json().await.unwrap();
    assert_eq!(restored["name"], name);
    assert_eq!(restored["description"], before["description"]);
    assert_eq!(restored["body"], before["body"]);
    assert_eq!(restored["enabled"], false);
    assert_eq!(restored["revision"], 8);
    let (_, latest) = s.send(Method::PUT, path, json!({ "expected_revision": 8, "body": "복원 후 다른 기기 편집" })).await;
    s.restart().await;
    let replay = s.raw(Method::POST, &format!("{path}/restore"), Some(request.clone()), Some(&key), None).await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    assert_eq!(replay.json::<Value>().await.unwrap(), restored);
    assert_eq!(s.get(path).await.1, latest, "receipt 재조회가 이후 편집을 덮어쓰지 않는다");
    let mut different = request;
    different["expected_baseline"]["description"] = json!("다른 번들");
    assert_eq!(s.raw(Method::POST, &format!("{path}/restore"), Some(different), Some(&key), None).await.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn stale_baseline_revision_invalid_selection_and_auth_never_mutate() {
    let s = TestServer::start().await;
    let path = "/api/v1/definitions/workflow/headless";
    let (_, original) = s.get(path).await;
    let (_, edited) = s.send(Method::PUT, path, json!({
        "expected_revision": 0, "name": "수정 이름", "description": "수정 설명", "body": "수정 본문", "enabled": false
    })).await;
    for field in ["name", "description", "body", "sha256"] {
        let mut stale = baseline(&original);
        stale[field] = json!("이전 번들의 값");
        let (status, error) = s.post(&format!("{path}/restore"), json!({
            "expected_revision": 1, "fields": ["description"], "expected_baseline": stale
        })).await;
        assert_eq!(status, StatusCode::CONFLICT, "{error}");
        assert_eq!(error["error"]["code"], "baseline_conflict");
        assert_eq!(error["error"]["details"]["current"], edited);
    }
    let (status, error) = s.post(&format!("{path}/restore"), json!({
        "expected_revision": 0, "fields": ["body"], "expected_baseline": baseline(&original)
    })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "revision_conflict");
    for fields in [json!([]), json!(["enabled"]), json!(["body", "unknown"])] {
        assert_eq!(s.post(&format!("{path}/restore"), json!({ "expected_revision": 1, "fields": fields })).await.0, StatusCode::BAD_REQUEST);
    }
    let request = json!({ "expected_revision": 1, "fields": ["description"], "expected_baseline": baseline(&original) });
    assert_eq!(s.raw(Method::POST, &format!("{path}/restore"), Some(request.clone()), Some(&s.key()), Some("")).await.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(s.raw(Method::POST, &format!("{path}/restore"), Some(request.clone()), None, None).await.status(), StatusCode::BAD_REQUEST);
    assert_eq!(s.get(path).await.1, edited);
    let (status, restored) = s.post(&format!("{path}/restore"), request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(restored["description"], original["description"]);
    assert_eq!(restored["name"], edited["name"]);
    assert_eq!(restored["body"], edited["body"]);
    assert_eq!(restored["enabled"], false);
    let (_, custom) = s.post("/api/v1/definitions/agent", json!({ "id": "custom-update", "name": "사용자", "body": "사용자 본문" })).await;
    assert_eq!(s.post("/api/v1/definitions/agent/custom-update/restore", json!({
        "expected_revision": custom["revision"], "fields": ["body"], "expected_baseline": baseline(&original)
    })).await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn unrelated_update_preserves_explicit_overrides_even_when_equal_to_current_bundle() {
    let s = TestServer::start().await;
    let path = "/api/v1/definitions/agent/worker";
    let (_, original) = s.get(path).await;
    {
        let db = Connection::open(s.data_dir().join("grove.db")).unwrap();
        db.execute(
            "INSERT INTO definitions(kind,id,builtin,name,description,body,enabled,revision,created_at,updated_at) \
             VALUES('agent','worker',1,?1,?2,?3,1,1,'old','old')",
            params![original["name"].as_str().unwrap(), original["description"].as_str().unwrap(), original["body"].as_str().unwrap()],
        ).unwrap();
    }
    let (status, updated) = s.send(Method::PUT, path, json!({ "expected_revision": 1, "enabled": false })).await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    let db = Connection::open(s.data_dir().join("grove.db")).unwrap();
    let stored: (String, String, String) = db.query_row(
        "SELECT name,description,body FROM definitions WHERE kind='agent' AND id='worker'", [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    ).unwrap();
    assert_eq!(stored, (
        original["name"].as_str().unwrap().to_owned(),
        original["description"].as_str().unwrap().to_owned(),
        original["body"].as_str().unwrap().to_owned()
    ));
    let (status, restored) = s.post(&format!("{path}/restore"), json!({
        "expected_revision": 2, "fields": ["body"], "expected_baseline": baseline(&original)
    })).await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    let stored: (Option<String>, Option<String>, Option<String>, bool) = db.query_row(
        "SELECT name,description,body,enabled FROM definitions WHERE kind='agent' AND id='worker'", [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
    ).unwrap();
    assert_eq!(stored.0.as_deref(), original["name"].as_str());
    assert_eq!(stored.1.as_deref(), original["description"].as_str());
    assert_eq!(stored.2, None, "같은 값의 명시적 override도 선택 복원으로만 해제한다");
    assert!(!stored.3);
}
