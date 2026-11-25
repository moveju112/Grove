//! 저장소 clone·GitHub 저장소 검색·경로 제안(PROJECT-012). 네트워크 없이 로컬 file 저장소와 가짜 gh로만 검증한다.
#![cfg(unix)]
use crate::common;

use common::*;
use reqwest::StatusCode;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) {
    let o = Command::new("git").args(args).current_dir(dir).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

fn leftovers(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.starts_with(".grove-clone-")).collect()
}

#[tokio::test]
async fn clone_registers_project_replays_once_and_never_leaves_partial_checkouts() {
    let s = TestServer::start().await;
    // 원격 대신 로컬 bare 저장소
    let src = s.make_project_dir("src-work");
    git(&src, &["init", "-q", "-b", "main"]);
    std::fs::write(src.join("README"), "hello\n").unwrap();
    git(&src, &["add", "README"]);
    git(&src, &["-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-q", "-m", "init"]);
    let bare = src.parent().unwrap().join("lib.git");
    git(src.parent().unwrap(), &["clone", "-q", "--bare", src.to_str().unwrap(), bare.to_str().unwrap()]);
    let target = src.parent().unwrap().join("clones");
    let url = format!("file://{}", bare.display());

    let body = json!({ "repo": url, "target_directory": target });
    let r = s.raw(reqwest::Method::POST, "/api/v1/projects/clone", Some(body.clone()), Some("clone-1"), None).await;
    assert_eq!(r.status(), StatusCode::CREATED);
    let v: serde_json::Value = r.json().await.unwrap();
    let checkout = target.join("lib");
    assert_eq!(std::fs::read_to_string(checkout.join("README")).unwrap(), "hello\n");
    assert_eq!(v["project"]["name"], "lib");
    assert_eq!(v["project"]["root_path"], std::fs::canonicalize(&checkout).unwrap().to_str().unwrap());
    // 같은 키 재전송은 clone을 다시 하지 않고 같은 프로젝트
    let again = s.raw(reqwest::Method::POST, "/api/v1/projects/clone", Some(body.clone()), Some("clone-1"), None).await;
    assert_eq!(again.headers()["idempotent-replayed"], "true");
    let again: serde_json::Value = again.json().await.unwrap();
    assert_eq!(again["project"]["id"], v["project"]["id"]);
    // 새 요청으로 같은 대상에 다시 받으면 거절하고 기존 폴더를 건드리지 않는다
    let (st, e) = s.post("/api/v1/projects/clone", body).await;
    assert_eq!((st, e["error"]["code"].as_str()), (StatusCode::CONFLICT, Some("already_exists")), "{e}");
    assert!(checkout.join("README").exists());
    // 없는 원격: 실패, 임시 폴더·대상 폴더가 남지 않는다
    let (st, e) = s.post("/api/v1/projects/clone", json!({ "repo": format!("file://{}/missing.git", target.display()), "target_directory": target })).await;
    assert_eq!((st, e["error"]["code"].as_str()), (StatusCode::CONFLICT, Some("clone_failed")), "{e}");
    assert!(!target.join("missing").exists());
    assert_eq!(leftovers(&target), Vec::<String>::new());
    // 형식 오류
    for (repo, proto) in [("octo/hello", None::<&str>), ("http://example.com/a.git", None), ("ext::sh", None)] {
        let (st, _) = s.post("/api/v1/projects/clone", json!({ "repo": repo, "protocol": proto, "target_directory": target })).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{repo}");
    }
    let (st, _) = s.post("/api/v1/projects/clone", json!({ "repo": url, "target_directory": "relative/dir" })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (_, list) = s.get("/api/v1/projects").await;
    assert_eq!(list.as_array().unwrap().iter().filter(|p| p["name"] == "lib").count(), 1);
}

#[tokio::test]
async fn repository_search_distinguishes_success_missing_unauthenticated_and_error() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("fake-gh");
    let log = dir.path().join("gh-args");
    // 모드 파일에 따라 응답을 바꾸는 가짜 gh. 받은 인자를 기록한다.
    std::fs::write(&bin, format!(r#"#!/bin/sh
printf '%s\n' "$@" > '{log}'
mode=$(cat '{mode}')
case "$mode" in
  unauth) echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4 ;;
  error) echo 'HTTP 502: bad gateway' >&2; exit 1 ;;
esac
if [ "$1" = repo ]; then echo '[{{"name":"mine","nameWithOwner":"me/mine","description":"d","isPrivate":true,"updatedAt":"2030-01-01T00:00:00Z","url":"https://github.com/me/mine"}}]'
else echo '[{{"name":"hello","fullName":"octo/hello","description":null,"isPrivate":false,"updatedAt":"2030-01-02T00:00:00Z","url":"https://github.com/octo/hello"}}]'; fi
"#, log = log.display(), mode = dir.path().join("mode").display())).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mode = |m: &str| std::fs::write(dir.path().join("mode"), m).unwrap();
    let sdir = tempfile::tempdir().unwrap();
    let mut cfg = config(&sdir.path().join("data"));
    cfg.gh_command = bin.to_string_lossy().to_string();
    let s = TestServer::start_with(sdir, cfg).await;

    mode("ok");
    let (_, v) = s.get("/api/v1/github/repos").await;
    assert_eq!(v["status"], "success", "{v}");
    assert_eq!(v["repositories"][0]["full_name"], "me/mine");
    assert_eq!(v["repositories"][0]["private"], true);
    let (_, v) = s.get("/api/v1/github/repos?q=-hello&limit=500").await;
    assert_eq!(v["repositories"][0]["full_name"], "octo/hello");
    let args: Vec<String> = std::fs::read_to_string(&log).unwrap().lines().map(String::from).collect();
    assert_eq!(args.iter().rev().take(2).cloned().collect::<Vec<_>>(), vec!["-hello", "--"], "검색어는 옵션으로 해석되지 않는다: {args:?}");
    assert!(args.windows(2).any(|w| w[0] == "--limit" && w[1] == "50"), "{args:?}");
    mode("unauth");
    let (_, v) = s.get("/api/v1/github/repos?q=x").await;
    assert_eq!((v["status"].as_str(), v["available"].as_bool()), (Some("unauthenticated"), Some(false)), "{v}");
    mode("error");
    let (_, v) = s.get("/api/v1/github/repos?q=x").await;
    assert_eq!(v["status"], "error");
    assert!(v["error"].as_str().unwrap().contains("502"), "{v}");
    std::fs::remove_file(&bin).unwrap();
    let (_, v) = s.get("/api/v1/github/repos?q=x").await;
    assert_eq!((v["status"].as_str(), v["reason"].as_str()), (Some("unavailable"), Some("gh_missing")), "{v}");
}

#[tokio::test]
async fn directory_suggestions_list_matching_child_folders_only() {
    let s = TestServer::start().await;
    let base = s.make_project_dir("suggest");
    for d in ["alpha", "Alpine", ".alhidden", "beta"] {
        std::fs::create_dir_all(base.join(d)).unwrap();
    }
    std::fs::write(base.join("alfile"), "x").unwrap();
    let q = format!("{}/al", base.display());
    let (st, v) = s.get(&format!("/api/v1/fs/suggest?q={}", urlencoding(&q))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let got: Vec<&str> = v["directories"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
    assert_eq!(got, vec![base.join("alpha").to_str().unwrap(), base.join("Alpine").to_str().unwrap()]);
    let q = format!("{}/.al", base.display());
    let (_, v) = s.get(&format!("/api/v1/fs/suggest?q={}", urlencoding(&q))).await;
    assert_eq!(v["directories"], json!([base.join(".alhidden")]), "점으로 시작하면 숨김 폴더도 제안");
    let (_, v) = s.get("/api/v1/fs/suggest?q=").await;
    assert_eq!(v["directories"], json!([]));
}

fn urlencoding(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}
