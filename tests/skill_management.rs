//! Grove 관리 root만 사용하며 실제 모델·사용자 설정 없이 HTTP/DB/파일 경계를 검증한다.
mod common;

use common::{TestServer, fixture::{self, Fixture}};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

fn url(sid: &str) -> String { format!("/api/v1/sessions/{sid}/skills") }
fn binding(entry: &Value) -> Value {
    json!({"id":entry["id"],"source":entry["source"],"revision":entry["revision"]})
}
async fn context(s: &TestServer, name: &str) -> (Value, String, PathBuf) {
    let project = s.create_project(name).await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    let root = PathBuf::from(project["root_path"].as_str().unwrap());
    (project, session["id"].as_str().unwrap().to_owned(), root)
}
async fn view(s: &TestServer, sid: &str) -> Value {
    let (status, body) = s.get(&url(sid)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}
async fn manage(s: &TestServer, sid: &str, body: Value) -> (StatusCode, Value) {
    s.send(Method::PUT, &format!("{}/management", url(sid)), body).await
}
async fn add(s: &TestServer, sid: &str, scope: &str, name: &str, text: &str) -> Value {
    let (status, body) = manage(s, sid, json!({"op":"add","scope":scope,"name":name,"text":text})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let snapshot = view(s, sid).await;
    snapshot["listing"]["entries"].as_array().unwrap().iter()
        .find(|e| e["id"] == body["id"]).unwrap().clone()
}
async fn select(s: &TestServer, sid: &str, selection: &Value, selected: bool) {
    let (status, body) = s.send(Method::PUT, &format!("{}/selection", url(sid)),
        json!({"selection":selection,"selected":selected})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn add_save_reload_use_approved_roots_and_never_refresh_bindings() {
    let mut s = TestServer::start().await;
    let (_, sid, root) = context(&s, "managed").await;
    assert_eq!(view(&s, &sid).await["listing"]["entries"], json!([]));
    let global = add(&s, &sid, "global", "검토", "GLOBAL_BODY").await;
    let project = add(&s, &sid, "project", "검토", "---\nunknown: kept\n---\nPROJECT_BODY").await;
    assert_eq!(global["enabled"], true);
    assert_eq!(fs::read_to_string(s.data_dir().join("skills/검토/SKILL.md")).unwrap(), "GLOBAL_BODY");
    assert_eq!(fs::read_to_string(root.join(".agents/skills/검토/SKILL.md")).unwrap(), "---\nunknown: kept\n---\nPROJECT_BODY");
    let before = binding(&project);
    select(&s, &sid, &before, true).await;
    let (status, changed) = manage(&s, &sid, json!({"op":"save","selection":before,"text":"NEW_BODY"})).await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert_ne!(changed["revision"], before["revision"]);
    let snapshot = view(&s, &sid).await;
    assert_eq!(snapshot["selected"], json!([before]));
    assert_eq!(snapshot["validation_error"]["code"], "skill_changed");
    let stale = manage(&s, &sid, json!({"op":"save","selection":before,"text":"NEW_BODY"})).await;
    assert_eq!(stale.0, StatusCode::CONFLICT, "{stale:?}"); // 같은 bytes여도 stale expected는 거절한다.
    assert_eq!(manage(&s, &sid, json!({"op":"add","scope":"project","name":"검토","text":"overwrite"})).await.0, StatusCode::CONFLICT);
    let file = root.join(".agents/skills/검토/SKILL.md");
    fs::write(&file, "EXTERNAL_CHANGE").unwrap();
    let observed = view(&s, &sid).await;
    assert_eq!(observed["selected"], json!([before]));
    assert_eq!(observed["validation_error"]["code"], "skill_changed");
    s.restart().await;
    assert_eq!(view(&s, &sid).await["selected"], json!([before]));
    select(&s, &sid, &before, false).await;
    let current = view(&s, &sid).await["listing"]["entries"].as_array().unwrap().iter()
        .find(|e| e["source"]["kind"] == "project").unwrap().clone();
    select(&s, &sid, &binding(&current), true).await;
    assert!(view(&s, &sid).await["validation_error"].is_null());
}

#[tokio::test]
async fn disabling_blocks_real_model_calls_and_reenabling_does_not_revive_old_selection() {
    let mut s = TestServer::start().await;
    let fixture = Fixture::start().await;
    let profile = s.fixture_profile(&fixture.base).await;
    let (_, sid, _) = context(&s, "enabled").await;
    let entry = add(&s, &sid, "global", "review", "MODEL_MANAGED_FIXTURE").await;
    let original = binding(&entry);
    select(&s, &sid, &original, true).await;
    fixture.push(fixture::text("first"));
    let (_, turn) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"before disable","profile_id":profile})).await;
    s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
    assert!(fixture.requests()[0]["messages"][0]["content"].as_str().unwrap().contains("MODEL_MANAGED_FIXTURE"));
    assert_eq!(manage(&s, &sid, json!({"op":"set_enabled","selection":original,"enabled":false})).await.0, StatusCode::OK);
    let disabled = view(&s, &sid).await;
    assert_eq!(disabled["selected"], json!([original]));
    assert_eq!(disabled["listing"]["entries"][0]["enabled"], false);
    assert_eq!(disabled["validation_error"]["code"], "skill_disabled");
    let mut disabled_binding = binding(&disabled["listing"]["entries"][0]);
    let (status, body) = s.post(&format!("{}/body", url(&sid)), json!({"selection":disabled_binding})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["text"], "MODEL_MANAGED_FIXTURE"); // 비활성 본문은 여전히 관측/편집 가능.
    let (status, body) = s.send(Method::PUT, &format!("{}/selection", url(&sid)),
        json!({"selection":disabled_binding,"selected":true})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let (_, turn) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"disabled","profile_id":profile})).await;
    let failed = s.wait_status(turn["turn"]["id"].as_str().unwrap(), "failed").await;
    assert_eq!(failed["error"]["code"], "skill_disabled");
    assert_eq!(fixture.requests().len(), 1);
    s.restart().await;
    assert_eq!(view(&s, &sid).await["validation_error"]["code"], "skill_disabled");
    assert_eq!(manage(&s, &sid, json!({"op":"save","selection":disabled_binding,"text":"EDITED_WHILE_DISABLED"})).await.0, StatusCode::OK);
    let edited = view(&s, &sid).await;
    assert_eq!(edited["validation_error"]["code"], "skill_disabled");
    disabled_binding = binding(&edited["listing"]["entries"][0]);
    let (_, other, _) = context(&s, "global-disabled").await;
    assert_eq!(view(&s, &other).await["listing"]["entries"][0]["enabled"], false);
    assert_eq!(manage(&s, &sid, json!({"op":"set_enabled","selection":disabled_binding,"enabled":true})).await.0, StatusCode::OK);
    let enabled = view(&s, &sid).await;
    assert_eq!(enabled["validation_error"]["code"], "skill_changed");
    assert_eq!(enabled["selected"], json!([original]));
    assert_ne!(binding(&enabled["listing"]["entries"][0]), original);
    // 같은 enabled 요청은 새 key여도 generation을 올리지 않는다.
    let current = binding(&enabled["listing"]["entries"][0]);
    assert_eq!(manage(&s, &sid, json!({"op":"set_enabled","selection":current,"enabled":true})).await.0, StatusCode::OK);
    assert_eq!(binding(&view(&s, &sid).await["listing"]["entries"][0]), current);
    select(&s, &sid, &original, false).await;
    select(&s, &sid, &current, true).await;
    fixture.push(fixture::text("second"));
    let (_, turn) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"explicitly reselected","profile_id":profile})).await;
    s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
    assert_eq!(fixture.requests().len(), 2);
    assert!(fixture.requests()[1]["messages"][0]["content"].as_str().unwrap().contains("EDITED_WHILE_DISABLED"));
}

#[tokio::test]
async fn concurrent_saves_conflict_and_receipts_never_reapply_past_success() {
    let s = TestServer::start().await;
    let (_, sid, root) = context(&s, "concurrency").await;
    let entry = add(&s, &sid, "project", "review", "original").await;
    let original = binding(&entry);
    let a = json!({"op":"save","selection":original,"text":"FIRST"});
    let b = json!({"op":"save","selection":original,"text":"SECOND"});
    let (first, second) = tokio::join!(manage(&s, &sid, a), manage(&s, &sid, b));
    assert!((first.0 == StatusCode::OK && second.0 == StatusCode::CONFLICT)
        || (second.0 == StatusCode::OK && first.0 == StatusCode::CONFLICT), "{first:?} {second:?}");
    let current = binding(&view(&s, &sid).await["listing"]["entries"][0]);
    let body = json!({"op":"save","selection":current,"text":"PRIVATE_BODY_NO_EVENT"});
    let route = format!("{}/management", url(&sid));
    let response = s.raw(Method::PUT, &route, Some(body.clone()), Some("save-replay"), None).await;
    assert_eq!(response.status(), StatusCode::OK);
    let saved: Value = response.json().await.unwrap();
    fs::write(root.join(".agents/skills/review/SKILL.md"), "external after success").unwrap();
    let replay = s.raw(Method::PUT, &route, Some(body.clone()), Some("save-replay"), None).await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    assert_eq!(replay.json::<Value>().await.unwrap(), saved);
    assert_eq!(fs::read_to_string(root.join(".agents/skills/review/SKILL.md")).unwrap(), "external after success");
    assert_eq!(s.raw(Method::PUT, &route, Some(json!({"op":"save","selection":current,"text":"different"})), Some("save-replay"), None).await.status(), StatusCode::CONFLICT);
    assert_eq!(s.raw(Method::PUT, &route, Some(body), None, None).await.status(), StatusCode::BAD_REQUEST);
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    let events: String = db.query_row("SELECT group_concat(payload) FROM events WHERE kind='skill.changed'", [], |r|r.get(0)).unwrap();
    assert!(!events.contains("PRIVATE_BODY_NO_EVENT"));
    assert!(!events.contains("SKILL.md"));
    assert!(!events.contains(root.to_str().unwrap()));
    let receipts: String = db.query_row("SELECT group_concat(response) FROM idempotency WHERE key='save-replay'", [], |r|r.get(0)).unwrap();
    assert!(!receipts.contains("PRIVATE_BODY_NO_EVENT"));
}

#[tokio::test]
async fn incomplete_receipt_survives_restart_and_observation_does_not_execute_it() {
    let mut s = TestServer::start().await;
    let (_, sid, root) = context(&s, "recovery").await;
    let body = json!({"op":"add","scope":"project","name":"pending","text":"NEVER_WRITE"});
    let hash = grove::idem::body_hash("skills.manage", &json!({"session":sid,"body":body}));
    let owner = grove::auth::parse_token(&s.token).unwrap().0;
    let unknown = json!({"error":{"code":"result_unknown","message":"fixture interrupted receipt"}});
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute("INSERT INTO idempotency(owner_id,key,request_hash,status,response,created_at) VALUES(?1,'pending-skill',?2,409,?3,'2026-01-01T00:00:00Z')",
        rusqlite::params![owner, hash, unknown.to_string()]).unwrap();
    drop(db);
    s.restart().await;
    let route = format!("{}/management", url(&sid));
    let replay = s.raw(Method::PUT, &route, Some(body), Some("pending-skill"), None).await;
    assert_eq!(replay.status(), StatusCode::CONFLICT);
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    assert_eq!(replay.json::<Value>().await.unwrap()["error"]["code"], "result_unknown");
    assert_eq!(view(&s, &sid).await["listing"]["entries"], json!([]));
    assert!(!root.join(".agents/skills/pending").exists());
}

#[tokio::test]
async fn receipt_commit_failure_after_atomic_save_is_unknown_and_never_reexecutes() {
    let mut s = TestServer::start().await;
    let (_, sid, root) = context(&s, "receipt-failure").await;
    let entry = add(&s, &sid, "project", "review", "before").await;
    let selection = binding(&entry);
    select(&s, &sid, &selection, true).await;
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute_batch(
        "CREATE TRIGGER management_receipt_fault BEFORE UPDATE ON idempotency
         WHEN OLD.key='file-result-fault' BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END;"
    ).unwrap();
    let body = json!({"op":"save","selection":selection,"text":"ATOMICALLY_SAVED_WITHOUT_RECEIPT"});
    let route = format!("{}/management", url(&sid));
    let response = s.raw(Method::PUT, &route, Some(body.clone()), Some("file-result-fault"), None).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(response.json::<Value>().await.unwrap()["error"]["code"], "result_unknown");
    let file = root.join(".agents/skills/review/SKILL.md");
    assert_eq!(fs::read_to_string(&file).unwrap(), "ATOMICALLY_SAVED_WITHOUT_RECEIPT");
    assert_eq!(view(&s, &sid).await["selected"], json!([selection]));
    assert_eq!(view(&s, &sid).await["validation_error"]["code"], "skill_changed");
    db.execute_batch("DROP TRIGGER management_receipt_fault").unwrap();
    drop(db);
    fs::write(&file, "EXTERNAL_AFTER_FAILURE").unwrap();
    s.restart().await;
    let replay = s.raw(Method::PUT, &route, Some(body), Some("file-result-fault"), None).await;
    assert_eq!(replay.status(), StatusCode::CONFLICT);
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    assert_eq!(replay.json::<Value>().await.unwrap()["error"]["code"], "result_unknown");
    assert_eq!(fs::read_to_string(&file).unwrap(), "EXTERNAL_AFTER_FAILURE");
}

#[tokio::test]
async fn interrupted_add_staging_is_not_a_catalog_or_selection_candidate() {
    let s = TestServer::start().await;
    let (_, sid, root) = context(&s, "staging").await;
    let staging = root.join(".agents/skills/.grove-skill-interrupted");
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join("SKILL.md"), "UNPUBLISHED_BODY").unwrap();
    let snapshot = view(&s, &sid).await;
    assert_eq!(snapshot["listing"]["entries"], json!([]));
    assert_eq!(snapshot["listing"]["issues"], json!([]));
    assert!(!snapshot.to_string().contains("UNPUBLISHED_BODY"));
    add(&s, &sid, "project", "published", "safe").await;
    assert_eq!(view(&s, &sid).await["listing"]["entries"].as_array().unwrap().len(), 1);
    assert_eq!(fs::read_to_string(staging.join("SKILL.md")).unwrap(), "UNPUBLISHED_BODY");
}

#[tokio::test]
async fn authentication_read_only_layers_and_archived_project_apply_even_to_replays() {
    let s = TestServer::start().await;
    let (project, sid, root) = context(&s, "policy").await;
    let route = format!("{}/management", url(&sid));
    let body = json!({"op":"add","scope":"global","name":"review","text":"safe"});
    assert_eq!(s.raw(Method::PUT, &route, Some(body.clone()), Some("policy"), Some("")).await.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(s.raw(Method::PUT, &route, Some(body.clone()), Some("policy"), None).await.status(), StatusCode::OK);
    for scope in ["server/-".to_owned(), format!("project/{}",project["id"].as_str().unwrap()), format!("session/{sid}")] {
        let settings = format!("/api/v1/settings/{scope}/tools.mode");
        assert_eq!(s.send(Method::PUT, &settings, json!({"expected_revision":0,"value":"read_only"})).await.0, StatusCode::OK);
        assert_eq!(s.raw(Method::PUT, &route, Some(body.clone()), Some("policy"), None).await.status(), StatusCode::FORBIDDEN);
        assert_eq!(manage(&s, &sid, json!({"op":"add","scope":"project","name":"blocked","text":"no"})).await.0, StatusCode::FORBIDDEN);
        assert_eq!(s.send(Method::PUT, &settings, json!({"expected_revision":1,"value":"ask"})).await.0, StatusCode::OK);
    }
    assert!(!root.join(".agents/skills/blocked").exists());
    let (status, value) = s.send(Method::PATCH, &format!("/api/v1/projects/{}",project["id"].as_str().unwrap()),
        json!({"expected_revision":project["revision"],"archived":true})).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(s.raw(Method::PUT, &route, Some(body), Some("policy"), None).await.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn invalid_requests_and_forged_sources_cannot_write_other_files() {
    let s = TestServer::start().await;
    let (_, sid, _) = context(&s, "invalid").await;
    for name in ["", ".", "..", "../escape", "/absolute", "a/b", "a\\b", ".grove-stage"] {
        assert_eq!(manage(&s, &sid, json!({"op":"add","scope":"project","name":name,"text":"no"})).await.0, StatusCode::BAD_REQUEST);
    }
    for text in ["\0".to_owned(), "x".repeat(grove::skills::MAX_BODY_BYTES as usize + 1)] {
        assert_eq!(manage(&s, &sid, json!({"op":"add","scope":"global","name":"invalid","text":text})).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    }
    assert_eq!(manage(&s, &sid, json!({"op":"add","scope":"global","name":"valid","text":"safe","path":"/private"})).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    let entry = add(&s, &sid, "project", "valid", "safe").await;
    let mut forged = binding(&entry);
    forged["source"]["root_id"] = json!("../unapproved");
    assert_eq!(manage(&s, &sid, json!({"op":"save","selection":forged,"text":"no"})).await.0, StatusCode::CONFLICT);
    let (_, other, _) = context(&s, "other").await;
    assert_eq!(manage(&s, &other, json!({"op":"save","selection":binding(&entry),"text":"no"})).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn running_project_process_blocks_management_without_consuming_the_key() {
    let s = TestServer::start().await;
    let (_, sid, root) = context(&s, "busy-project").await;
    let (_, task) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({"command":"sleep 10"})).await;
    let task_id = task["id"].as_str().unwrap();
    let route = format!("{}/management", url(&sid));
    let body = json!({"op":"add","scope":"project","name":"after-task","text":"safe"});
    let response = s.raw(Method::PUT, &route, Some(body.clone()), Some("busy-skill"), None).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(response.json::<Value>().await.unwrap()["error"]["code"], "resource_busy");
    assert!(!root.join(".agents/skills/after-task").exists());
    s.post(&format!("/api/v1/tasks/{task_id}/cancel"), json!({})).await;
    let (_, stopped) = s.get(&format!("/api/v1/tasks/{task_id}/wait?timeout_ms=5000")).await;
    assert_ne!(stopped["status"], "running");
    let response = s.raw(Method::PUT, &route, Some(body), Some("busy-skill"), None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(fs::read_to_string(root.join(".agents/skills/after-task/SKILL.md")).unwrap(), "safe");
}

#[cfg(unix)]
#[tokio::test]
async fn symlink_escape_is_denied_and_read_aliases_are_not_replaced_by_saves() {
    use std::os::unix::fs::symlink;
    let s = TestServer::start().await;
    let (_, sid, root) = context(&s, "boundary").await;
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.join(".agents")).unwrap();
    symlink(outside.path(), root.join(".agents/skills")).unwrap();
    let (status, body) = manage(&s, &sid, json!({"op":"add","scope":"project","name":"escape","text":"no"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(!body.to_string().contains(outside.path().to_str().unwrap()));
    assert!(!outside.path().join("escape").exists());
    fs::remove_file(root.join(".agents/skills")).unwrap();
    let entry = add(&s, &sid, "project", "real", "original").await;
    symlink("real", root.join(".agents/skills/alias")).unwrap();
    let snapshot = view(&s, &sid).await;
    let alias = snapshot["listing"]["entries"].as_array().unwrap().iter().find(|e|e["name"]=="alias").unwrap();
    let (status, body) = manage(&s, &sid, json!({"op":"save","selection":binding(alias),"text":"no"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "skill_read_only");
    assert_eq!(fs::read_to_string(root.join(".agents/skills/real/SKILL.md")).unwrap(), "original");
    assert_eq!(binding(&entry), binding(snapshot["listing"]["entries"].as_array().unwrap().iter().find(|e|e["name"]=="real").unwrap()));
}

#[cfg(unix)]
#[tokio::test]
async fn internal_root_alias_cannot_modify_read_only_source_definitions() {
    use std::os::unix::fs::symlink;
    let s = TestServer::start().await;
    let (_, sid, root) = context(&s, "source-read-only").await;
    let original = root.join(".claude/skills/review/SKILL.md");
    fs::create_dir_all(original.parent().unwrap()).unwrap();
    fs::write(&original, "SOURCE_DEFINITION").unwrap();
    fs::create_dir_all(root.join(".agents")).unwrap();
    symlink("../.claude/skills", root.join(".agents/skills")).unwrap();
    let snapshot = view(&s, &sid).await; // 기존 내부 root alias 조회 정책은 그대로다.
    let selection = binding(&snapshot["listing"]["entries"][0]);
    for body in [
        json!({"op":"add","scope":"project","name":"new","text":"no"}),
        json!({"op":"save","selection":selection,"text":"no"}),
        json!({"op":"set_enabled","selection":selection,"enabled":false}),
    ] {
        let (status, body) = manage(&s, &sid, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["error"]["code"], "skill_read_only");
    }
    assert_eq!(fs::read_to_string(&original).unwrap(), "SOURCE_DEFINITION");
    assert!(!root.join(".claude/skills/new").exists());
    // root 자체가 아직 없더라도 상위 .agents alias를 통해 원본 위치를 만들지 않는다.
    fs::remove_file(root.join(".agents/skills")).unwrap();
    fs::remove_dir(root.join(".agents")).unwrap();
    symlink(".claude", root.join(".agents")).unwrap();
    assert_eq!(manage(&s, &sid, json!({"op":"save","selection":selection,"text":"no"})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(fs::read_to_string(original).unwrap(), "SOURCE_DEFINITION");
    let (_, empty_sid, empty_root) = context(&s, "source-missing-skills").await;
    fs::create_dir(empty_root.join(".codex")).unwrap();
    symlink(".codex", empty_root.join(".agents")).unwrap();
    assert_eq!(manage(&s, &empty_sid, json!({"op":"add","scope":"project","name":"new","text":"no"})).await.0, StatusCode::FORBIDDEN);
    assert!(!empty_root.join(".codex/skills").exists());
}
