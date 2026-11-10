//! Git 조회·stage·commit·branch(GIT-001~004, 006, 016). 임시 저장소에서만 실행한다.
mod common;

use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};
use std::process::Command;

fn sh(dir: &std::path::Path, args: &[&str]) -> String {
    let o = Command::new("git").args(args).current_dir(dir).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).to_string()
}

async fn repo() -> (TestServer, String, std::path::PathBuf) {
    let s = TestServer::start().await;
    let p = s.create_project("repo").await;
    let root = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
    sh(&root, &["init", "-q", "-b", "main"]);
    sh(&root, &["config", "user.email", "t@example.invalid"]);
    sh(&root, &["config", "user.name", "Tester"]);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    sh(&root, &["add", "a.txt"]);
    sh(&root, &["commit", "-q", "-m", "init"]);
    (s, p["id"].as_str().unwrap().to_string(), root)
}

#[tokio::test]
async fn status_diff_stage_commit_with_stale_protection() {
    let (s, pid, root) = repo().await;
    std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(root.join("새 파일.txt"), "new\n").unwrap();
    let (st, v) = s.get(&format!("/api/v1/projects/{pid}/git/status")).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["branch"]["head"], "main");
    let entries = v["entries"].as_array().unwrap();
    assert!(entries.iter().any(|e| e["path"] == "a.txt" && e["worktree"] == "M"));
    assert!(entries.iter().any(|e| e["path"] == "새 파일.txt" && e["kind"] == "untracked"), "Unicode 경로 그대로: {v}");
    let fp = v["fingerprint"].as_str().unwrap().to_string();
    let (_, d) = s.get(&format!("/api/v1/projects/{pid}/git/diff?path=a.txt")).await;
    assert!(d["diff"].as_str().unwrap().contains("+two"));

    // 확인 이후 파일이 바뀌면 stage 거부(GIT-002)
    std::fs::write(root.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    let (st, v) = s.post(&format!("/api/v1/projects/{pid}/git/stage"), json!({ "paths": ["a.txt"], "expected_fingerprint": fp })).await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"]["code"], "stale_diff");
    assert_eq!(sh(&root, &["diff", "--cached", "--name-only"]), "", "거부 시 index 불변");
    let fp = v["error"]["details"]["fingerprint"].as_str().unwrap().to_string();
    let (st, v) = s.post(&format!("/api/v1/projects/{pid}/git/stage"), json!({ "paths": ["a.txt"], "expected_fingerprint": fp })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let fp = v["fingerprint"].as_str().unwrap().to_string();
    let (_, staged) = s.get(&format!("/api/v1/projects/{pid}/git/diff?staged=true")).await;
    assert!(staged["diff"].as_str().unwrap().contains("+three"));
    // 경로 인자 공격 거부
    for bad in ["--all", "../x", "/etc/passwd"] {
        let (st, _) = s.post(&format!("/api/v1/projects/{pid}/git/stage"), json!({ "paths": [bad], "expected_fingerprint": fp })).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{bad}");
    }
    let (st, v) = s.post(&format!("/api/v1/projects/{pid}/git/commit"), json!({ "message": "두 줄 추가\n\n본문", "expected_fingerprint": fp })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(sh(&root, &["log", "-1", "--format=%s"]).trim(), "두 줄 추가");
    // untracked 파일은 커밋되지 않고 그대로 남는다
    assert!(root.join("새 파일.txt").exists());
    assert!(sh(&root, &["-c", "core.quotepath=false", "status", "--porcelain"]).contains("새 파일.txt"));
    let (_, log) = s.get(&format!("/api/v1/projects/{pid}/git/log?limit=5")).await;
    assert_eq!(log["commits"].as_array().unwrap().len(), 2);
    // 빈 stage 커밋 거부
    let (_, st2) = s.get(&format!("/api/v1/projects/{pid}/git/status")).await;
    let (st, _) = s.post(&format!("/api/v1/projects/{pid}/git/commit"), json!({ "message": "x", "expected_fingerprint": st2["fingerprint"] })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn unstage_keeps_worktree_and_branch_switch_never_discards_changes() {
    let (s, pid, root) = repo().await;
    std::fs::write(root.join("a.txt"), "changed\n").unwrap();
    let (_, v) = s.get(&format!("/api/v1/projects/{pid}/git/status")).await;
    let (_, v) = s.post(&format!("/api/v1/projects/{pid}/git/stage"), json!({ "paths": ["a.txt"], "expected_fingerprint": v["fingerprint"] })).await;
    let (st, _) = s.post(&format!("/api/v1/projects/{pid}/git/unstage"), json!({ "paths": ["a.txt"], "expected_fingerprint": v["fingerprint"] })).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "changed\n", "unstage는 작업 트리를 건드리지 않는다");
    // 브랜치 생성·목록
    for bad in ["-f", "a..b", "x y"] {
        let (st, _) = s.post(&format!("/api/v1/projects/{pid}/git/branches"), json!({ "name": bad })).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
    }
    let (st, _) = s.post(&format!("/api/v1/projects/{pid}/git/branches"), json!({ "name": "feat/x" })).await;
    assert_eq!(st, StatusCode::OK);
    let (_, b) = s.get(&format!("/api/v1/projects/{pid}/git/branches")).await;
    let names: Vec<&str> = b["branches"].as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"feat/x") && names.contains(&"main"));
    // feat/x에서 a.txt를 다르게 커밋해 두면, main의 미커밋 변경이 있는 상태로 전환은 거절되어야 한다
    sh(&root, &["stash", "-q"]); // 시험 준비(제품은 stash를 쓰지 않음)
    sh(&root, &["switch", "-q", "feat/x"]);
    std::fs::write(root.join("a.txt"), "branch\n").unwrap();
    sh(&root, &["commit", "-qam", "b"]);
    sh(&root, &["switch", "-q", "main"]);
    sh(&root, &["stash", "pop", "-q"]);
    let (st, v) = s.post(&format!("/api/v1/projects/{pid}/git/switch"), json!({ "name": "feat/x" })).await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "changed\n", "사용자 변경 보존(GIT-006)");
    assert_eq!(sh(&root, &["branch", "--show-current"]).trim(), "main");
}

#[tokio::test]
async fn hunk_level_stage_and_unstage() {
    let (s, pid, root) = repo().await;
    let lines: Vec<String> = (1..=30).map(|i| format!("line{i}\n")).collect();
    std::fs::write(root.join("a.txt"), lines.concat()).unwrap();
    sh(&root, &["commit", "-qam", "30줄"]);
    let mut changed = lines.clone();
    changed[1] = "LINE2\n".into();
    changed[27] = "LINE28\n".into();
    std::fs::write(root.join("a.txt"), changed.concat()).unwrap();
    let (_, h) = s.get(&format!("/api/v1/projects/{pid}/git/hunks?path=a.txt")).await;
    assert_eq!(h["hunks"].as_array().unwrap().len(), 2, "{h}");
    // 두 번째 hunk만 stage
    let (st, v) = s.post(&format!("/api/v1/projects/{pid}/git/stage-hunks"), json!({ "path": "a.txt", "hunks": [1], "expected_fingerprint": h["fingerprint"] })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let cached = sh(&root, &["diff", "--cached"]);
    assert!(cached.contains("+LINE28") && !cached.contains("+LINE2\n"), "{cached}");
    let wt = sh(&root, &["diff"]);
    assert!(wt.contains("+LINE2\n") && !wt.contains("LINE28"), "작업 트리에는 첫 hunk만 남음: {wt}");
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), changed.concat(), "파일 내용 불변");
    // 범위 밖 번호·오래된 fingerprint 거부
    let (st, _) = s.post(&format!("/api/v1/projects/{pid}/git/stage-hunks"), json!({ "path": "a.txt", "hunks": [5], "expected_fingerprint": v["fingerprint"] })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = s.post(&format!("/api/v1/projects/{pid}/git/stage-hunks"), json!({ "path": "a.txt", "hunks": [0], "expected_fingerprint": h["fingerprint"] })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    // stage된 hunk 내리기
    let (_, hs) = s.get(&format!("/api/v1/projects/{pid}/git/hunks?path=a.txt&staged=true")).await;
    assert_eq!(hs["hunks"].as_array().unwrap().len(), 1);
    let (st, _) = s.post(&format!("/api/v1/projects/{pid}/git/stage-hunks"), json!({ "path": "a.txt", "hunks": [0], "unstage": true, "expected_fingerprint": hs["fingerprint"] })).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(sh(&root, &["diff", "--cached"]), "");
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), changed.concat());
}

#[tokio::test]
async fn rename_remote_ops_merge_and_history() {
    let (s, pid, root) = repo().await;
    let api = |p: &str| format!("/api/v1/projects/{pid}/git/{p}");
    // 이름 변경: 덮어쓰기 금지
    sh(&root, &["branch", "old"]);
    sh(&root, &["branch", "taken"]);
    let (st, _) = s.post(&api("branches/rename"), json!({ "from": "old", "to": "taken" })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    let (st, _) = s.post(&api("branches/rename"), json!({ "from": "old", "to": "new-name" })).await;
    assert_eq!(st, StatusCode::OK);
    assert!(sh(&root, &["branch", "--list", "new-name"]).contains("new-name"));
    // 로컬 bare 원격
    let remote = s.dir.path().join("remote.git");
    sh(s.dir.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    sh(&root, &["remote", "add", "origin", remote.to_str().unwrap()]);
    let (st, v) = s.post(&api("push"), json!({})).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["pushed"], "main");
    // 다른 clone에서 원격을 앞서게 한 뒤 fetch·pull(ff)
    let other = s.dir.path().join("other");
    sh(s.dir.path(), &["clone", "-q", remote.to_str().unwrap(), other.to_str().unwrap()]);
    sh(&other, &["config", "user.email", "o@example.invalid"]);
    sh(&other, &["config", "user.name", "Other"]);
    std::fs::write(other.join("b.txt"), "b\n").unwrap();
    sh(&other, &["add", "b.txt"]);
    sh(&other, &["commit", "-qm", "원격 커밋"]);
    sh(&other, &["push", "-q", "origin", "main"]);
    let (st, _) = s.post(&api("fetch"), json!({})).await;
    assert_eq!(st, StatusCode::OK);
    assert!(!root.join("b.txt").exists(), "fetch는 작업 트리를 바꾸지 않는다");
    let (st, v) = s.post(&api("pull"), json!({})).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert!(root.join("b.txt").exists());
    // 갈라진 상태의 pull은 거절(ff-only), 로컬 커밋 유지
    std::fs::write(other.join("b.txt"), "remote change\n").unwrap();
    sh(&other, &["commit", "-qam", "원격 2"]);
    sh(&other, &["push", "-q", "origin", "main"]);
    std::fs::write(root.join("c.txt"), "local\n").unwrap();
    sh(&root, &["add", "c.txt"]);
    sh(&root, &["commit", "-qm", "로컬"]);
    let head = sh(&root, &["rev-parse", "HEAD"]);
    let (st, _) = s.post(&api("pull"), json!({})).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(sh(&root, &["rev-parse", "HEAD"]), head);
    // push도 force 없이 거절
    let (st, _) = s.post(&api("push"), json!({})).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert!(sh(&other, &["log", "-1", "--format=%s"]).contains("원격 2"));
    // merge 충돌 → abort되어 원래 상태
    sh(&root, &["switch", "-q", "-c", "side"]);
    std::fs::write(root.join("a.txt"), "side\n").unwrap();
    sh(&root, &["commit", "-qam", "side"]);
    sh(&root, &["switch", "-q", "main"]);
    std::fs::write(root.join("a.txt"), "main\n").unwrap();
    sh(&root, &["commit", "-qam", "main"]);
    let before = sh(&root, &["rev-parse", "HEAD"]);
    let (_, stt) = s.get(&api("status")).await;
    let (st, v) = s.post(&api("merge"), json!({ "branch": "side", "expected_fingerprint": stt["fingerprint"] })).await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"]["code"], "merge_conflict");
    assert_eq!(v["error"]["details"]["conflicts"][0], "a.txt");
    assert_eq!(sh(&root, &["rev-parse", "HEAD"]), before);
    assert_eq!(sh(&root, &["status", "--porcelain", "--untracked-files=no"]), "", "충돌 흔적 없음");
    assert!(!root.join(".git/MERGE_HEAD").exists());
    // 충돌 없는 merge
    sh(&root, &["switch", "-q", "-c", "feat", "HEAD~1"]);
    std::fs::write(root.join("d.txt"), "d\n").unwrap();
    sh(&root, &["add", "d.txt"]);
    sh(&root, &["commit", "-qm", "feat d"]);
    sh(&root, &["switch", "-q", "main"]);
    let (_, stt) = s.get(&api("status")).await;
    let (st, v) = s.post(&api("merge"), json!({ "branch": "feat", "no_ff": true, "expected_fingerprint": stt["fingerprint"] })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert!(root.join("d.txt").exists());
    // commit 상세와 base 비교
    let feat_head = sh(&root, &["rev-parse", "feat"]).trim().to_string();
    let (st, c) = s.get(&api(&format!("commits/{feat_head}"))).await;
    assert_eq!(st, StatusCode::OK, "{c}");
    assert_eq!(c["message"], "feat d");
    assert_eq!(c["files"][0]["path"], "d.txt");
    assert_eq!(c["files"][0]["status"], "A");
    assert!(c["diff"].as_str().unwrap().contains("+d"));
    let (st, _) = s.get(&api("commits/--all")).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    sh(&root, &["switch", "-q", "feat"]);
    let (_, cmp) = s.get(&api("compare?base=side")).await;
    assert!(cmp["commits"].as_array().unwrap().iter().any(|c| c["subject"] == "feat d"), "{cmp}");
}

#[tokio::test]
async fn concurrent_mutations_are_serialized() {
    let (s, pid, root) = repo().await;
    std::fs::write(root.join("a.txt"), "two\n").unwrap();
    let (_, v) = s.get(&format!("/api/v1/projects/{pid}/git/status")).await;
    let (_, v) = s.post(&format!("/api/v1/projects/{pid}/git/stage"), json!({ "paths": ["a.txt"], "expected_fingerprint": v["fingerprint"] })).await;
    let fp = v["fingerprint"].clone();
    // 같은 fingerprint로 동시에 두 커밋: 하나만 성공하고 다른 하나는 바뀐 상태를 보고 거절된다
    let path = format!("/api/v1/projects/{pid}/git/commit");
    let (a, b) = tokio::join!(s.post(&path, json!({ "message": "A", "expected_fingerprint": fp })), s.post(&path, json!({ "message": "B", "expected_fingerprint": fp })));
    let mut codes = [a.0, b.0];
    codes.sort();
    assert_eq!(codes, [StatusCode::OK, StatusCode::CONFLICT], "{a:?} {b:?}");
    assert_eq!(sh(&root, &["rev-list", "--count", "HEAD"]).trim(), "2", "커밋은 하나만 추가");
}

#[tokio::test]
async fn non_repo_and_idempotent_replay() {
    let s = TestServer::start().await;
    let p = s.create_project("plain").await;
    let pid = p["id"].as_str().unwrap();
    let (st, v) = s.get(&format!("/api/v1/projects/{pid}/git/status")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["is_repo"], false);
    let (st, _) = s.post(&format!("/api/v1/projects/{pid}/git/commit"), json!({ "message": "x", "expected_fingerprint": "f" })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    let (s, pid, root) = repo().await;
    std::fs::write(root.join("a.txt"), "z\n").unwrap();
    let (_, v) = s.get(&format!("/api/v1/projects/{pid}/git/status")).await;
    let body = json!({ "paths": ["a.txt"], "expected_fingerprint": v["fingerprint"] });
    let r1 = s.raw(reqwest::Method::POST, &format!("/api/v1/projects/{pid}/git/stage"), Some(body.clone()), Some("stage-1"), None).await;
    assert_eq!(r1.status(), StatusCode::OK);
    // 같은 키 재전송: 상태가 바뀌었어도 stale로 거절하지 않고 원래 결과를 돌려준다
    let r2 = s.raw(reqwest::Method::POST, &format!("/api/v1/projects/{pid}/git/stage"), Some(body), Some("stage-1"), None).await;
    assert_eq!(r2.status(), StatusCode::OK);
    assert_eq!(r2.headers().get("idempotent-replayed").unwrap(), "true");
    let _: Value = r2.json().await.unwrap();
}
