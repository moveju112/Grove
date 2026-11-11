//! Grove worktree(GIT-007~010). 임시 저장소에서만 실행한다.
mod common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;

fn sh(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("git").args(args).current_dir(dir).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).to_string()
}

async fn repo() -> (TestServer, String, PathBuf) {
    let s = TestServer::start().await;
    let p = s.create_project("repo").await;
    let root = PathBuf::from(p["root_path"].as_str().unwrap());
    sh(&root, &["init", "-q", "-b", "main"]);
    sh(&root, &["config", "user.email", "t@example.invalid"]);
    sh(&root, &["config", "user.name", "Tester"]);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    sh(&root, &["add", "a.txt"]);
    sh(&root, &["commit", "-q", "-m", "init"]);
    (s, p["id"].as_str().unwrap().to_string(), root)
}

/// 대화에서 백그라운드 작업으로 파일을 만들고 끝날 때까지 기다린다(실행 위치 확인용).
async fn touch_via_task(s: &TestServer, sid: &str, name: &str) {
    let (st, t) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({ "command": format!("touch {name}") })).await;
    assert_eq!(st, StatusCode::CREATED, "{t}");
    let (_, w) = s.get(&format!("/api/v1/tasks/{}/wait?timeout_ms=10000", t["id"].as_str().unwrap())).await;
    assert_eq!(w["status"], "completed", "{w}");
}

fn wt_path(v: &Value) -> PathBuf {
    PathBuf::from(v["path"].as_str().unwrap())
}

#[tokio::test]
async fn create_with_dirty_choice_enter_run_merge_and_remove() {
    let (s, pid, root) = repo().await;
    // 원래 폴더에 커밋하지 않은 변경: 선택 없이 만들면 거부하고 아무것도 만들지 않는다(GIT-009).
    std::fs::write(root.join("a.txt"), "one\ncarried\n").unwrap();
    std::fs::write(root.join("u.txt"), "untracked\n").unwrap();
    let before = sh(&root, &["status", "--porcelain"]);
    let (st, v) = s.post(&format!("/api/v1/projects/{pid}/worktrees"), json!({ "name": "feat" })).await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"]["code"], "worktree_dirty_choice");
    assert_eq!(v["error"]["details"]["changed"], 2);
    assert_eq!(sh(&root, &["worktree", "list"]).lines().count(), 1, "선택 전에는 worktree를 만들지 않는다");
    // 잘못된 이름
    let (st, _) = s.post(&format!("/api/v1/projects/{pid}/worktrees"), json!({ "name": "../x", "carry": "leave" })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    // carry: 변경을 복사해 가고, 원래 폴더는 그대로 둔다.
    let (st, w1) = s.post(&format!("/api/v1/projects/{pid}/worktrees"), json!({ "name": "feat", "carry": "carry" })).await;
    assert_eq!(st, StatusCode::CREATED, "{w1}");
    assert_eq!(w1["branch"], "grove/feat");
    assert_eq!(w1["carried"], true);
    let p1 = wt_path(&w1);
    assert_eq!(std::fs::read_to_string(p1.join("a.txt")).unwrap(), "one\ncarried\n");
    assert_eq!(std::fs::read_to_string(p1.join("u.txt")).unwrap(), "untracked\n");
    assert_eq!(sh(&root, &["status", "--porcelain"]), before, "carry도 원래 폴더의 변경은 바꾸지 않는다");
    // leave: 변경 없이 HEAD에서 시작한다.
    let (st, w2) = s.post(&format!("/api/v1/projects/{pid}/worktrees"), json!({ "name": "clean", "carry": "leave" })).await;
    assert_eq!(st, StatusCode::CREATED, "{w2}");
    let p2 = wt_path(&w2);
    assert_eq!(std::fs::read_to_string(p2.join("a.txt")).unwrap(), "one\n");
    assert!(!p2.join("u.txt").exists());
    // 같은 이름(이미 있는 브랜치)은 덮어쓰지 않는다.
    let (st, v) = s.post(&format!("/api/v1/projects/{pid}/worktrees"), json!({ "name": "feat", "carry": "leave" })).await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");

    // 새 대화를 worktree에서 시작하면 작업이 그 경로에서 실행된다(GIT-008).
    let (st, sess) = s.post(&format!("/api/v1/projects/{pid}/sessions"), json!({ "title": "wt", "worktree_id": w1["id"] })).await;
    assert_eq!(st, StatusCode::CREATED, "{sess}");
    assert_eq!(sess["worktree_id"], w1["id"]);
    let sid = sess["id"].as_str().unwrap().to_string();
    touch_via_task(&s, &sid, "made-in-wt.txt").await;
    assert!(p1.join("made-in-wt.txt").exists());
    assert!(!root.join("made-in-wt.txt").exists());
    // 기본 대화는 프로젝트 폴더에서 실행한다(자동 격리 없음).
    let plain = s.create_session(&pid).await;
    assert!(plain["worktree_id"].is_null());
    // 대화가 들어가 있는 worktree는 제거하지 않는다.
    let (st, v) = s.send(Method::DELETE, &format!("/api/v1/worktrees/{}", w1["id"].as_str().unwrap()), json!({})).await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"]["code"], "worktree_in_use");
    // 복귀: 프로젝트 폴더로 돌아오면 거기서 실행한다.
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/worktree"), json!({ "worktree_id": null })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert!(v["worktree_id"].is_null());
    touch_via_task(&s, &sid, "made-in-root.txt").await;
    assert!(root.join("made-in-root.txt").exists());
    std::fs::remove_file(root.join("made-in-root.txt")).unwrap();
    // 다시 진입·다른 프로젝트의 worktree 거부
    let other = s.create_project("other").await;
    let osess = s.create_session(other["id"].as_str().unwrap()).await;
    let (st, _) = s.post(&format!("/api/v1/sessions/{}/worktree", osess["id"].as_str().unwrap()), json!({ "worktree_id": w1["id"] })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    // merge: worktree에 커밋하지 않은 변경이 있으면 거부(GIT-007).
    let w1id = w1["id"].as_str().unwrap().to_string();
    let (st, v) = s.post(&format!("/api/v1/worktrees/{w1id}/merge"), json!({})).await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"]["code"], "worktree_dirty");
    sh(&p1, &["add", "-A"]);
    sh(&p1, &["-c", "user.email=t@example.invalid", "-c", "user.name=Tester", "commit", "-q", "-m", "wt 작업"]);
    // 원래 폴더도 merge할 수 있게 정리(시험이 만든 변경만 되돌린다)
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    std::fs::remove_file(root.join("u.txt")).unwrap();
    let (st, v) = s.post(&format!("/api/v1/worktrees/{w1id}/merge"), json!({})).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(sh(&root, &["log", "-1", "--format=%s"]).trim(), "wt 작업");
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "one\ncarried\n");

    // 제거: 변경 중이면 force 없이 거부하고 파일을 남긴다(GIT-010).
    std::fs::write(p2.join("wip.txt"), "wip\n").unwrap();
    let w2id = w2["id"].as_str().unwrap().to_string();
    let (st, v) = s.send(Method::DELETE, &format!("/api/v1/worktrees/{w2id}"), json!({})).await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"]["code"], "worktree_dirty");
    assert!(p2.join("wip.txt").exists());
    let (st, v) = s.send(Method::DELETE, &format!("/api/v1/worktrees/{w2id}?force=true"), json!({})).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "removed");
    assert!(!p2.exists());
    assert!(sh(&root, &["branch", "--list", "grove/clean"]).contains("grove/clean"), "제거해도 브랜치는 남긴다");
    // 제거된 worktree에는 들어갈 수 없다.
    let (st, _) = s.post(&format!("/api/v1/sessions/{sid}/worktree"), json!({ "worktree_id": w2id })).await;
    assert_eq!(st, StatusCode::GONE);
}

#[tokio::test]
async fn unowned_worktrees_are_listed_but_never_touched_and_prune_marks_missing() {
    let (s, pid, root) = repo().await;
    // 사용자가 직접 만든 worktree
    let manual = root.parent().unwrap().join(format!("manual-{}", pid));
    sh(&root, &["worktree", "add", "-q", "-b", "manual", manual.to_str().unwrap()]);
    let (st, w) = s.post(&format!("/api/v1/projects/{pid}/worktrees"), json!({ "name": "gone" })).await;
    assert_eq!(st, StatusCode::CREATED, "{w}");
    let (st, list) = s.get(&format!("/api/v1/projects/{pid}/worktrees")).await;
    assert_eq!(st, StatusCode::OK, "{list}");
    assert_eq!(list["worktrees"].as_array().unwrap().len(), 1);
    assert_eq!(list["worktrees"][0]["dirty_count"], 0);
    let unowned = list["unowned"].as_array().unwrap();
    assert_eq!(unowned.len(), 1, "{list}");
    assert_eq!(unowned[0]["branch"], "manual");
    let (st, sess) = s.post(&format!("/api/v1/projects/{pid}/sessions"), json!({ "worktree_id": w["id"] })).await;
    assert_eq!(st, StatusCode::CREATED, "{sess}");
    // Grove worktree 폴더가 밖에서 사라짐 → prune은 기록만 정리하고 missing으로 표시한다.
    std::fs::remove_dir_all(wt_path(&w)).unwrap();
    // 사라진 worktree에 들어가 있던 대화는 다른 폴더에서 실행하지 않고 거부한다.
    let (st, v) = s.post(&format!("/api/v1/sessions/{}/tasks", sess["id"].as_str().unwrap()), json!({ "command": "touch x" })).await;
    assert_eq!(st, StatusCode::GONE, "{v}");
    assert!(!root.join("x").exists());
    let (st, v) = s.post(&format!("/api/v1/projects/{pid}/worktrees/prune"), json!({})).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["missing"], json!([w["id"]]));
    assert!(manual.is_dir(), "소유하지 않은 worktree는 그대로");
    let listed = sh(&root, &["worktree", "list", "--porcelain"]);
    assert!(listed.contains(manual.to_str().unwrap()));
    assert!(!listed.contains(w["path"].as_str().unwrap()));
    let (_, list) = s.get(&format!("/api/v1/projects/{pid}/worktrees")).await;
    assert_eq!(list["worktrees"][0]["status"], "missing");
    assert_eq!(list["worktrees"][0]["exists"], false);
    // 시험이 만든 수동 worktree 정리
    sh(&root, &["worktree", "remove", manual.to_str().unwrap()]);
}

#[tokio::test]
async fn large_repo_requires_confirmation() {
    let (s, pid, root) = repo().await;
    let dir = root.join("many");
    std::fs::create_dir(&dir).unwrap();
    for i in 0..20_001 {
        std::fs::write(dir.join(format!("{i}")), "").unwrap();
    }
    sh(&root, &["add", "many"]);
    sh(&root, &["commit", "-q", "-m", "many"]);
    let (st, v) = s.post(&format!("/api/v1/projects/{pid}/worktrees"), json!({ "name": "big" })).await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"]["code"], "worktree_large_repo");
    assert_eq!(sh(&root, &["worktree", "list"]).lines().count(), 1);
    let (st, v) = s.post(&format!("/api/v1/projects/{pid}/worktrees"), json!({ "name": "big", "confirm_large": true })).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
}
