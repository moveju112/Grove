//! GIT-005: 모든 변경은 격리된 시험 저장소에만 수행한다.
mod common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(root).output().unwrap();
    assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

async fn repo() -> (TestServer, String, PathBuf) {
    let server = TestServer::start().await;
    let project = server.create_project("stash").await;
    let root = PathBuf::from(project["root_path"].as_str().unwrap());
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.email", "test@example.invalid"]);
    git(&root, &["config", "user.name", "Tester"]);
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    std::fs::write(root.join("b.txt"), "base b\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "base"]);
    (server, project["id"].as_str().unwrap().to_string(), root)
}

fn url(pid: &str, op: &str) -> String { format!("/api/v1/projects/{pid}/git/{op}") }

async fn fingerprint(server: &TestServer, pid: &str) -> Value {
    let (status, body) = server.get(&url(pid, "status")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["fingerprint"].clone()
}

async fn review(server: &TestServer, pid: &str, action: Value) -> Value {
    let (status, body) = server.post(&url(pid, "review"), action).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["summary"].is_string());
    json!({ "action": body["action"], "expected_fingerprint": body["expected_fingerprint"], "confirmed": true })
}

async fn save(server: &TestServer, pid: &str) -> Value {
    let fp = fingerprint(server, pid).await;
    let (status, body) = server.post(&url(pid, "stash-save"), json!({ "message": "작업 보관", "expected_fingerprint": fp })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["stashes"][0]["oid"].clone()
}

#[tokio::test]
async fn save_list_pop_restore_index_and_replay_only_once() {
    let (server, pid, root) = repo().await;
    std::fs::write(root.join("a.txt"), "staged\n").unwrap();
    git(&root, &["add", "a.txt"]);
    std::fs::write(root.join("a.txt"), "staged\nunstaged\n").unwrap();
    std::fs::write(root.join("new.txt"), "untracked\n").unwrap();
    let oid = save(&server, &pid).await;
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "base\n");
    assert_eq!(std::fs::read_to_string(root.join("new.txt")).unwrap(), "untracked\n");
    let (status, list) = server.get(&url(&pid, "stashes")).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["stashes"][0]["oid"], oid);
    assert!(list["stashes"][0]["subject"].as_str().unwrap().contains("작업 보관"));
    let body = review(&server, &pid, json!({ "operation": "stash_pop", "stash_oid": oid })).await;
    let key = server.key();
    let first = server.raw(Method::POST, &url(&pid, "confirm"), Some(body.clone()), Some(&key), None).await;
    assert_eq!(first.status(), StatusCode::OK, "{}", first.text().await.unwrap());
    assert_eq!(git(&root, &["show", ":a.txt"]), "staged\n");
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "staged\nunstaged\n");
    assert_eq!(git(&root, &["stash", "list"]), "");
    std::fs::write(root.join("a.txt"), "new later edit\n").unwrap();
    let replay = server.raw(Method::POST, &url(&pid, "confirm"), Some(body), Some(&key), None).await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "new later edit\n");
}

#[tokio::test]
async fn stash_save_rejects_stale_state_without_saving() {
    let (server, pid, root) = repo().await;
    let fp = fingerprint(&server, &pid).await;
    let (status, body) = server.post(&url(&pid, "stash-save"), json!({ "message": "빈 저장", "expected_fingerprint": fp })).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "nothing_to_stash");
    std::fs::write(root.join("a.txt"), "later\n").unwrap();
    let (status, body) = server.post(&url(&pid, "stash-save"), json!({ "message": "-m harmless", "expected_fingerprint": fp })).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "stale_diff");
    assert_eq!(git(&root, &["stash", "list"]), "");
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "later\n");
}

#[tokio::test]
async fn pop_conflict_keeps_stash_and_reports_actual_conflict_status() {
    let (server, pid, root) = repo().await;
    std::fs::write(root.join("a.txt"), "stashed\n").unwrap();
    let oid = save(&server, &pid).await;
    std::fs::write(root.join("a.txt"), "other commit\n").unwrap();
    git(&root, &["commit", "-qam", "diverge"]);
    let body = review(&server, &pid, json!({ "operation": "stash_pop", "stash_oid": oid })).await;
    let key = server.key();
    let response = server.raw(Method::POST, &url(&pid, "confirm"), Some(body.clone()), Some(&key), None).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let result: Value = response.json().await.unwrap();
    assert_eq!(result["error"]["code"], "stash_conflict");
    assert_eq!(result["error"]["details"]["stash_retained"], true);
    assert!(result["error"]["details"]["status"]["entries"].as_array().unwrap().iter().any(|e| e["kind"] == "conflict"));
    assert_eq!(git(&root, &["rev-parse", "stash@{0}"]).trim(), oid.as_str().unwrap());
    assert!(std::fs::read_to_string(root.join("a.txt")).unwrap().contains("<<<<<<<"));
    let state = git(&root, &["status", "--porcelain=v2"]);
    let replay = server.raw(Method::POST, &url(&pid, "confirm"), Some(body), Some(&key), None).await;
    assert_eq!(replay.status(), StatusCode::CONFLICT);
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    assert_eq!(git(&root, &["status", "--porcelain=v2"]), state);
}

#[tokio::test]
async fn pop_rejects_changed_stash_stack_and_untracked_content() {
    let (server, pid, root) = repo().await;
    std::fs::write(root.join("a.txt"), "stash one\n").unwrap();
    let oid = save(&server, &pid).await;
    std::fs::write(root.join("new.txt"), "first\n").unwrap();
    let action = json!({ "operation": "stash_pop", "stash_oid": oid });
    let body = review(&server, &pid, action.clone()).await;
    std::fs::write(root.join("new.txt"), "second\n").unwrap();
    let (status, error) = server.post(&url(&pid, "confirm"), body).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["error"]["code"], "stale_diff");
    let body = review(&server, &pid, action).await;
    std::fs::write(root.join("b.txt"), "stash two\n").unwrap();
    save(&server, &pid).await;
    // 작업 트리·HEAD는 동일해도 stash stack이 바뀌면 거부한다.
    let (status, error) = server.post(&url(&pid, "confirm"), body).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["error"]["code"], "stale_diff");
    assert_eq!(git(&root, &["stash", "list"]).lines().count(), 2);
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "base\n");
}

#[tokio::test]
async fn discard_requires_confirmation_and_current_target_bound_fingerprint() {
    let (server, pid, root) = repo().await;
    std::fs::write(root.join("a.txt"), "staged\n").unwrap();
    git(&root, &["add", "a.txt"]);
    std::fs::write(root.join("a.txt"), "unstaged\n").unwrap();
    std::fs::write(root.join("b.txt"), "keep b\n").unwrap();
    std::fs::write(root.join("new.txt"), "keep new\n").unwrap();
    let action = json!({ "operation": "discard", "paths": ["a.txt"] });
    let body = review(&server, &pid, action.clone()).await;
    let mut no = body.clone();
    no["confirmed"] = json!(false);
    assert_eq!(server.post(&url(&pid, "confirm"), no).await.0, StatusCode::BAD_REQUEST);
    let mut wrong = body.clone();
    wrong["action"]["paths"] = json!(["b.txt"]);
    assert_eq!(server.post(&url(&pid, "confirm"), wrong).await.0, StatusCode::CONFLICT);
    std::fs::write(root.join("a.txt"), "later edit\n").unwrap();
    let (status, error) = server.post(&url(&pid, "confirm"), body).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["error"]["code"], "stale_diff");
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "later edit\n");
    let body = review(&server, &pid, action).await;
    let (status, result) = server.post(&url(&pid, "confirm"), body).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(git(&root, &["show", ":a.txt"]), "base\n");
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "base\n");
    assert_eq!(std::fs::read_to_string(root.join("b.txt")).unwrap(), "keep b\n");
    assert_eq!(std::fs::read_to_string(root.join("new.txt")).unwrap(), "keep new\n");
}

#[tokio::test]
async fn discard_rejects_untracked_paths_directories_and_path_injection() {
    let (server, pid, root) = repo().await;
    std::fs::write(root.join("new.txt"), "keep new\n").unwrap();
    for path in ["new.txt", ".", ":(glob)*", "--all", "../a.txt", "/tmp/a.txt"] {
        let (status, body) = server.post(&url(&pid, "review"), json!({ "operation": "discard", "paths": [path] })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: {body}");
    }
    // staged deletion과 같은 이름으로 생긴 untracked 파일도 덮어쓰면 안 된다.
    git(&root, &["rm", "--cached", "a.txt"]);
    let (status, body) = server.post(&url(&pid, "review"), json!({ "operation": "discard", "paths": ["a.txt"] })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "base\n");
    assert!(root.join("new.txt").exists());
    std::fs::write(root.join(".gitignore"), "a.txt\n").unwrap();
    let (status, body) = server.post(&url(&pid, "review"), json!({ "operation": "discard", "paths": ["a.txt"] })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "ignored라도 새 파일을 덮어쓰면 안 된다: {body}");
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "base\n");
}

#[tokio::test]
async fn discard_uses_literal_filename_instead_of_glob() {
    let (server, pid, root) = repo().await;
    std::fs::write(root.join("*.txt"), "literal\n").unwrap();
    git(&root, &["--literal-pathspecs", "add", "--", "*.txt"]);
    git(&root, &["commit", "-qm", "literal filename"]);
    std::fs::write(root.join("*.txt"), "discard literal\n").unwrap();
    std::fs::write(root.join("b.txt"), "keep b\n").unwrap();
    let body = review(&server, &pid, json!({ "operation": "discard", "paths": ["*.txt"] })).await;
    let (status, result) = server.post(&url(&pid, "confirm"), body).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(std::fs::read_to_string(root.join("*.txt")).unwrap(), "literal\n");
    assert_eq!(std::fs::read_to_string(root.join("b.txt")).unwrap(), "keep b\n");
}

#[tokio::test]
async fn stash_routes_require_authentication_and_validate_oid() {
    let (server, pid, _) = repo().await;
    for op in ["stashes", "stash-save", "review", "confirm"] {
        let method = if op == "stashes" { Method::GET } else { Method::POST };
        let response = server.raw(method, &url(&pid, op), Some(json!({})), Some(&server.key()), Some("")).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{op}");
    }
    for bad in ["--all", "../x", "HEAD", "stash@{0}"] {
        let (status, body) = server.post(&url(&pid, "review"), json!({ "operation": "stash_pop", "stash_oid": bad })).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"]["code"], "stash_changed");
    }
}

#[tokio::test]
async fn linked_worktrees_share_stash_serialization_and_reject_second_pop_before_applying() {
    let (server, pid, root) = repo().await;
    let linked = server.dir.path().join("linked");
    git(&root, &["worktree", "add", "-q", "-b", "linked", linked.to_str().unwrap()]);
    let (status, project) = server.post("/api/v1/projects", json!({ "root_path": linked })).await;
    assert_eq!(status, StatusCode::CREATED, "{project}");
    let linked_pid = project["id"].as_str().unwrap();
    std::fs::write(root.join("a.txt"), "stashed\n").unwrap();
    let oid = save(&server, &pid).await;
    let action = json!({ "operation": "stash_pop", "stash_oid": oid });
    let original_body = review(&server, &pid, action.clone()).await;
    let linked_body = review(&server, linked_pid, action).await;
    let original_url = url(&pid, "confirm");
    let linked_url = url(linked_pid, "confirm");
    let (original, other) = tokio::join!(server.post(&original_url, original_body), server.post(&linked_url, linked_body));
    assert!(matches!((original.0, other.0), (StatusCode::OK, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::OK)),
        "{original:?} / {other:?}");
    let changed = [&root, &linked].iter().filter(|dir| std::fs::read_to_string(dir.join("a.txt")).unwrap() == "stashed\n").count();
    assert_eq!(changed, 1, "거부된 두 번째 pop은 파일을 적용하지 않아야 한다");
    assert_eq!(git(&root, &["stash", "list"]), "");
}
