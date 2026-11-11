//! worktree 부작용과 DB 결과 확정 사이의 실패는 소유권과 같은 요청의 재생을 보존한다.
mod common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::{path::{Path, PathBuf}, process::Command};

fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(root).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

async fn repo() -> (TestServer, String, PathBuf) {
    let s = TestServer::start().await;
    let p = s.create_project("worktree-receipt").await;
    let root = PathBuf::from(p["root_path"].as_str().unwrap());
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.email", "fixture@example.invalid"]);
    git(&root, &["config", "user.name", "Fixture"]);
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    git(&root, &["add", "a.txt"]);
    git(&root, &["commit", "-qm", "base"]);
    (s, p["id"].as_str().unwrap().to_string(), root)
}

#[tokio::test]
async fn create_keeps_ownership_when_final_storage_fails_and_never_creates_again_after_restart() {
    for fault in ["event", "receipt", "commit"] {
        let (mut s, pid, root) = repo().await;
        let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
        db.execute_batch(match fault {
            "event" => "CREATE TRIGGER fail_wt BEFORE INSERT ON events WHEN NEW.kind='worktree.changed' AND json_extract(NEW.payload,'$.op')='create' BEGIN SELECT RAISE(FAIL,'fixture final event'); END;",
            "receipt" => "CREATE TRIGGER fail_wt BEFORE UPDATE ON idempotency BEGIN SELECT RAISE(FAIL,'fixture final receipt'); END;",
            _ => "CREATE TABLE fixture_wt_commit (project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED);
                CREATE TRIGGER fail_wt AFTER UPDATE ON idempotency BEGIN INSERT INTO fixture_wt_commit VALUES ('missing-fixture-project'); END;",
        }).unwrap();
        let path = format!("/api/v1/projects/{pid}/worktrees");
        let body = json!({"name":"saved"});
        let key = s.key();
        let response = s.raw(Method::POST, &path, Some(body.clone()), Some(&key), None).await;
        let status = response.status();
        let first: Value = response.json().await.unwrap();
        assert!(git(&root, &["branch", "--list", "grove/saved"]).contains("grove/saved"));
        assert_eq!(status, StatusCode::CONFLICT, "{fault}: {first}");
        assert_eq!(first["error"]["code"], "result_unknown");
        let wid = first["error"]["details"]["worktree_id"].as_str().unwrap();
        let owned: (String, String) = db.query_row("SELECT path,status FROM worktrees WHERE id=?1", [wid], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(owned.1, "unknown");
        let worktree = PathBuf::from(&owned.0);
        assert!(worktree.is_dir());
        std::fs::write(worktree.join("keep.txt"), "new unaccepted work\n").unwrap();
        db.execute_batch("DROP TRIGGER fail_wt;").unwrap();
        if fault == "commit" { db.execute_batch("DROP TABLE fixture_wt_commit;").unwrap(); }
        drop(db);
        s.restart().await;
        let response = s.raw(Method::POST, &path, Some(body), Some(&key), None).await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(response.headers()["idempotent-replayed"], "true");
        assert_eq!(response.json::<Value>().await.unwrap(), first);
        let (_, list) = s.get(&path).await;
        assert_eq!(list["worktrees"].as_array().unwrap().len(), 1);
        assert_eq!(list["worktrees"][0]["status"], "unknown");
        assert_eq!(list["unowned"], json!([]));
        assert_eq!(std::fs::read_to_string(worktree.join("keep.txt")).unwrap(), "new unaccepted work\n");
        assert_eq!(git(&root, &["worktree", "list", "--porcelain"]).matches("worktree ").count(), 2);
        let sid = s.create_session(&pid).await;
        let (status, _) = s.post(&format!("/api/v1/sessions/{}/worktree", sid["id"].as_str().unwrap()), json!({"worktree_id":wid})).await;
        assert_eq!(status, StatusCode::GONE, "미확정 생성을 실행 위치로 선택하지 않는다");
    }
}

#[tokio::test]
async fn failed_acceptance_never_creates_a_branch_or_worktree() {
    for deferred in [false, true] {
        let (s, pid, root) = repo().await;
        let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
        db.execute_batch(if deferred {
            "CREATE TABLE fixture_wt_accept (project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED);
             CREATE TRIGGER fail_accept AFTER INSERT ON idempotency BEGIN INSERT INTO fixture_wt_accept VALUES ('missing-fixture-project'); END;"
        } else {
            "CREATE TRIGGER fail_accept BEFORE INSERT ON idempotency BEGIN SELECT RAISE(FAIL,'fixture acceptance'); END;"
        }).unwrap();
        let response = s.raw(Method::POST, &format!("/api/v1/projects/{pid}/worktrees"), Some(json!({"name":"unaccepted"})), Some(&s.key()), None).await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(git(&root, &["branch", "--list", "grove/unaccepted"]).is_empty());
        assert_eq!(git(&root, &["worktree", "list", "--porcelain"]).matches("worktree ").count(), 1);
        let rows: i64 = db.query_row("SELECT COUNT(*) FROM worktrees", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0);
    }
}

#[tokio::test]
async fn merge_remove_and_prune_replay_unknown_results_without_touching_later_work() {
    for op in ["merge", "remove", "prune"] {
        for fault in ["event", "receipt", "commit"] {
            let (mut s, pid, root) = repo().await;
            let (_, worktree) = s.post(&format!("/api/v1/projects/{pid}/worktrees"), json!({"name":"operation"})).await;
            let wid = worktree["id"].as_str().unwrap();
            let target = PathBuf::from(worktree["path"].as_str().unwrap());
            if op == "merge" {
                std::fs::write(target.join("merged.txt"), "requested merge\n").unwrap();
                git(&target, &["add", "merged.txt"]);
                git(&target, &["commit", "-qm", "requested merge"]);
            } else if op == "prune" {
                std::fs::remove_dir_all(&target).unwrap();
            }
            let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
            db.execute_batch(match fault {
                "event" => "CREATE TRIGGER fail_final BEFORE INSERT ON events WHEN NEW.kind='worktree.changed' BEGIN SELECT RAISE(FAIL,'fixture final event'); END;",
                "receipt" => "CREATE TRIGGER fail_final BEFORE UPDATE ON idempotency BEGIN SELECT RAISE(FAIL,'fixture final receipt'); END;",
                _ => "CREATE TABLE fixture_final_commit (project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED);
                    CREATE TRIGGER fail_final AFTER UPDATE ON idempotency BEGIN INSERT INTO fixture_final_commit VALUES ('missing-fixture-project'); END;",
            }).unwrap();
            let path = if op == "prune" {
                format!("/api/v1/projects/{pid}/worktrees/prune")
            } else {
                format!("/api/v1/worktrees/{wid}{}", if op == "merge" { "/merge" } else { "" })
            };
            let method = if op == "remove" { Method::DELETE } else { Method::POST };
            let key = s.key();
            let response = s.raw(method.clone(), &path, Some(json!({})), Some(&key), None).await;
            let status = response.status();
            let first: Value = response.json().await.unwrap();
            assert_eq!(status, StatusCode::CONFLICT, "{op}/{fault}: {first}");
            assert_eq!(first["error"]["code"], "result_unknown");
            if op == "merge" {
                assert_eq!(std::fs::read_to_string(root.join("merged.txt")).unwrap(), "requested merge\n");
                std::fs::write(target.join("later.txt"), "new branch work\n").unwrap();
                git(&target, &["add", "later.txt"]);
                git(&target, &["commit", "-qm", "later branch work"]);
            } else {
                assert!(!target.exists());
                // 시험이 만든 새 폴더는 이전 제거·prune 요청의 대상이 아니다.
                std::fs::create_dir(&target).unwrap();
                std::fs::write(target.join("later.txt"), "new folder work\n").unwrap();
            }
            let head = git(&root, &["rev-parse", "HEAD"]);
            db.execute_batch("DROP TRIGGER fail_final;").unwrap();
            if fault == "commit" { db.execute_batch("DROP TABLE fixture_final_commit;").unwrap(); }
            drop(db);
            s.restart().await;
            let response = s.raw(method, &path, Some(json!({})), Some(&key), None).await;
            assert_eq!(response.status(), StatusCode::CONFLICT, "{op}/{fault}");
            assert_eq!(response.headers()["idempotent-replayed"], "true");
            assert_eq!(response.json::<Value>().await.unwrap(), first);
            assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
            assert!(!root.join("later.txt").exists(), "나중 commit을 옛 merge로 실행하지 않는다");
            assert!(target.join("later.txt").is_file(), "새 폴더를 옛 요청으로 삭제하지 않는다");
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn failed_merge_abort_is_unknown_instead_of_claiming_the_original_state_was_restored() {
    let (s, pid, root) = repo().await;
    std::fs::write(root.join(".gitattributes"), "a.txt merge=fixture\n").unwrap();
    git(&root, &["add", ".gitattributes"]);
    git(&root, &["commit", "-qm", "fixture attributes"]);
    let (_, w) = s.post(&format!("/api/v1/projects/{pid}/worktrees"), json!({"name":"conflict"})).await;
    let target = PathBuf::from(w["path"].as_str().unwrap());
    std::fs::write(target.join("a.txt"), "child change\n").unwrap();
    git(&target, &["add", "a.txt"]);
    git(&target, &["commit", "-qm", "child change"]);
    std::fs::write(root.join("a.txt"), "main change\n").unwrap();
    git(&root, &["add", "a.txt"]);
    git(&root, &["commit", "-qm", "main change"]);
    // 실제 merge 충돌 이후 abort의 ref 갱신을 실패시킨다.
    git(&root, &["config", "merge.fixture.driver", "touch .git/refs/heads/main.lock; exit 1"]);
    let path = format!("/api/v1/worktrees/{}/merge", w["id"].as_str().unwrap());
    let key = s.key();
    let response = s.raw(Method::POST, &path, Some(json!({})), Some(&key), None).await;
    assert!(root.join(".git/refs/heads/main.lock").exists(), "실제 merge driver가 실패 경계를 만들었다");
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let first: Value = response.json().await.unwrap();
    assert_eq!(first["error"]["code"], "result_unknown", "{first}");
    std::fs::remove_file(root.join(".git/refs/heads/main.lock")).unwrap();
    let response = s.raw(Method::POST, &path, Some(json!({})), Some(&key), None).await;
    assert_eq!(response.headers()["idempotent-replayed"], "true");
    assert_eq!(response.json::<Value>().await.unwrap(), first);
}

#[tokio::test]
async fn reviewing_current_state_requires_confirmation_and_matching_metadata_without_completing_the_old_request() {
    let (s, pid, _) = repo().await;
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_review_fixture BEFORE UPDATE ON idempotency BEGIN SELECT RAISE(FAIL,'fixture final storage'); END;").unwrap();
    let path = format!("/api/v1/projects/{pid}/worktrees");
    let key = s.key();
    let response = s.raw(Method::POST, &path, Some(json!({"name":"review"})), Some(&key), None).await;
    let pending: Value = response.json().await.unwrap();
    assert_eq!(pending["error"]["code"], "result_unknown", "{pending}");
    let wid = pending["error"]["details"]["worktree_id"].as_str().unwrap();
    let target: String = db.query_row("SELECT path FROM worktrees WHERE id=?1", [wid], |r| r.get(0)).unwrap();
    let target = PathBuf::from(target);
    db.execute_batch("DROP TRIGGER fail_review_fixture;").unwrap();
    let review_path = format!("/api/v1/worktrees/{wid}/review");
    let (status, _) = s.post(&review_path, json!({"reviewed":false})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // 임의의 다른 저장소가 같은 위치·브랜치 이름을 쓰더라도 소유 metadata와 다르면 거부한다.
    std::fs::rename(target.join(".git"), target.join(".git.fixture")).unwrap();
    git(&target, &["init","-q","-b","grove/review"]);
    let (status, rejected) = s.post(&review_path, json!({"reviewed":true})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{rejected}");
    assert_eq!(rejected["error"]["code"], "worktree_mismatch");
    std::fs::remove_dir_all(target.join(".git")).unwrap();
    std::fs::rename(target.join(".git.fixture"), target.join(".git")).unwrap();
    std::fs::write(target.join("reviewed.txt"), "kept current work\n").unwrap();
    let (status, reviewed) = s.post(&review_path, json!({"reviewed":true})).await;
    assert_eq!(status, StatusCode::OK, "{reviewed}");
    assert_eq!(reviewed["status"], "active");
    assert_eq!(std::fs::read_to_string(target.join("reviewed.txt")).unwrap(), "kept current work\n");
    let response = s.raw(Method::POST, &path, Some(json!({"name":"review"})), Some(&key), None).await;
    assert_eq!(response.headers()["idempotent-replayed"], "true");
    assert_eq!(response.json::<Value>().await.unwrap(), pending, "옛 생성 receipt를 성공으로 바꾸지 않는다");
}
