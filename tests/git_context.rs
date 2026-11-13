//! FILEUI-009: 실제 외부 GitHub 대신 고정 argv를 검사하는 격리 gh fixture.
mod common;

use common::{TestServer, config};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn git(root: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").args(args).current_dir(root)
        .env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap();
    assert!(out.status.success(), "fixture git failed");
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

fn init(root: &Path, commit: bool) {
    std::fs::create_dir_all(root).unwrap();
    git(root, &["init", "-q", "-b", "main"]);
    git(root, &["config", "user.name", "Fixture"]);
    git(root, &["config", "user.email", "fixture@example.invalid"]);
    if commit {
        std::fs::write(root.join("file.txt"), "base\n").unwrap();
        git(root, &["add", "file.txt"]);
        git(root, &["commit", "-qm", "base"]);
    }
}

async fn add(s: &TestServer, root: &Path) -> String {
    let (status, project) = s.post("/api/v1/projects", json!({"root_path": root})).await;
    assert_eq!(status, StatusCode::CREATED, "{project}");
    project["id"].as_str().unwrap().to_string()
}

async fn context(s: &TestServer, id: &str) -> Value {
    let (status, body) = s.get(&format!("/api/v1/projects/{id}/git/context")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

fn action<'a>(data: &'a Value, name: &str) -> &'a Value {
    data["authority"]["actions"].as_array().unwrap().iter().find(|v| v["id"] == name).unwrap()
}

#[cfg(unix)]
async fn fixture() -> (TestServer, PathBuf, String) {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    init(&root, true);
    let head = git(&root, &["rev-parse", "HEAD"]);
    let bin = dir.path().join("gh-fixture");
    std::fs::write(dir.path().join("head"), &head).unwrap();
    std::fs::write(dir.path().join("mode"), "ok").unwrap();
    std::fs::write(&bin, r#"#!/usr/bin/python3
import json, pathlib, sys, time
root = pathlib.Path(__file__).parent
args = sys.argv[1:]
assert args[:6] == ["api", "--hostname", "github.com", "--method", "GET", args[5]]
endpoint = args[5]
assert endpoint.startswith("repos/fixture/repository/commits/")
assert "?" in endpoint and len(args) == 6
with (root / "calls").open("a") as f: f.write(json.dumps(args) + "\n")
mode = (root / "mode").read_text()
head = (root / "head").read_text()
if mode == "race":
    (root / "started").touch()
    deadline = time.monotonic() + 5
    while not (root / "release").exists() and time.monotonic() < deadline: time.sleep(.01)
if mode == "timeout": time.sleep(12)
if mode in ["denied", "unauthenticated", "error"]:
    print({"denied": "HTTP 403", "unauthenticated": "HTTP 401", "error": "raw error"}[mode] + " https://secret:credential@private.invalid /private/server/home", file=sys.stderr)
    sys.exit(1)
if mode == "malformed": print("not json"); sys.exit()
if "/pulls?" in endpoint:
    print(json.dumps([
        {"number": 9, "state": "open", "draft": False, "merged_at": None, "head": {"sha": head}, "base": {"repo": {"full_name": "fixture/repository"}}},
        {"number": 8, "state": "open", "draft": False, "merged_at": None, "head": {"sha": "0" * 40}, "base": {"repo": {"full_name": "fixture/repository"}}}
    ]))
elif "/check-runs?" in endpoint:
    print(json.dumps({"total_count": 1, "check_runs": [{"head_sha": head, "status": "completed", "conclusion": "failure" if mode == "failure" else "success"}]}))
elif "/status?" in endpoint:
    print(json.dumps({"sha": head, "total_count": 1, "statuses": [{"state": "pending" if mode == "pending" else "success"}]}))
else: raise AssertionError("unsupported fixture operation")
"#).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut cfg = config(&dir.path().join("data"));
    cfg.gh_command = bin.to_string_lossy().to_string();
    let s = TestServer::start_with(dir, cfg).await;
    git(&root, &["remote", "add", "origin", "https://secret:credential@github.com/fixture/repository.git"]);
    let id = add(&s, &root).await;
    (s, root, id)
}

#[cfg(unix)]
#[tokio::test]
async fn exact_head_pr_ci_read_is_non_mutating_and_redacted() {
    let (s, root, id) = fixture().await;
    let before = [".git/index", ".git/HEAD", ".git/config"].map(|p| std::fs::read(root.join(p)).unwrap());
    let registered = git(&root, &["worktree", "list", "--porcelain"]);
    let refs = git(&root, &["show-ref"]);
    let data = context(&s, &id).await;
    assert_eq!(data["status"], "ok");
    assert_eq!(data["location"]["head"], git(&root, &["rev-parse", "HEAD"]));
    assert_eq!(data["location"]["kind"], "branch");
    assert_eq!(data["location"]["worktree"], "main");
    assert_eq!(data["location"]["project_relative_to_worktree"], ".");
    assert_eq!(data["location"]["git_registered"], true);
    assert_eq!(data["github"]["repository"], "fixture/repository");
    assert_eq!(data["github"]["pr"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(data["github"]["pr"]["items"][0]["number"], 9);
    assert_eq!(data["github"]["ci"], json!({"status": "success", "count": 2}));
    assert_eq!(action(&data, "commit")["status"], "blocked");
    assert_eq!(action(&data, "push")["status"], "conditional");
    let text = data.to_string();
    for secret in ["secret", "credential", root.to_str().unwrap(), "/private/server"] {
        assert!(!text.contains(secret));
    }
    assert_eq!(before, [".git/index", ".git/HEAD", ".git/config"].map(|p| std::fs::read(root.join(p)).unwrap()));
    assert_eq!(registered, git(&root, &["worktree", "list", "--porcelain"]));
    assert_eq!(refs, git(&root, &["show-ref"]));
    for (mode, expected) in [("pending", "pending"), ("failure", "failure")] {
        std::fs::write(s.dir.path().join("mode"), mode).unwrap();
        assert_eq!(context(&s, &id).await["github"]["ci"]["status"], expected);
    }
    // 같은 branch 이름이어도 새 HEAD에 이전 PR/CI를 붙이지 않는다.
    git(&root, &["commit", "--allow-empty", "-qm", "new HEAD"]);
    let data = context(&s, &id).await;
    assert_eq!(data["github"]["pr"]["status"], "none");
    assert_eq!(data["github"]["ci"]["status"], "stale");
    assert!(data["github"]["pr"]["items"].as_array().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn unsupported_absent_cli_auth_denial_timeout_and_unknown_are_distinct() {
    use std::os::unix::fs::PermissionsExt;
    let (s, root, id) = fixture().await;
    for (mode, expected) in [("denied", "denied"), ("unauthenticated", "unauthenticated"), ("error", "unknown"), ("malformed", "unknown"), ("timeout", "timeout")] {
        std::fs::write(s.dir.path().join("mode"), mode).unwrap();
        let data = context(&s, &id).await;
        assert_eq!(data["github"]["pr"]["status"], expected);
        assert_eq!(data["github"]["ci"]["status"], expected);
        for secret in ["credential", "private.invalid", "/private/server", "raw error"] {
            assert!(!data.to_string().contains(secret));
        }
    }
    let bin = s.dir.path().join("gh-fixture");
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(context(&s, &id).await["github"]["pr"]["status"], "denied");
    std::fs::rename(&bin, s.dir.path().join("gh-fixture-hidden")).unwrap();
    assert_eq!(context(&s, &id).await["github"]["pr"]["status"], "missing");
    let calls = std::fs::read(s.dir.path().join("calls")).unwrap();
    for remote in ["https://gitlab.example/fixture/repository.git", "https://github.com.evil.invalid/fixture/repository", "file:///private/server/repo", "https://github.com/fixture/repository?token=credential", "ssh://git@github.com:2222/fixture/repository"] {
        git(&root, &["remote", "set-url", "origin", remote]);
        assert_eq!(context(&s, &id).await["github"]["pr"]["status"], "unsupported");
    }
    git(&root, &["remote", "remove", "origin"]);
    assert_eq!(context(&s, &id).await["github"]["pr"]["status"], "no_remote");
    assert_eq!(calls, std::fs::read(s.dir.path().join("calls")).unwrap());
}

#[tokio::test]
async fn unborn_detached_linked_nested_and_actual_device_authority() {
    let s = TestServer::start().await;
    let root = s.dir.path().join("repo");
    init(&root, false);
    let id = add(&s, &root).await;
    std::fs::write(root.join("file.txt"), "base\n").unwrap();
    git(&root, &["add", "file.txt"]);
    let data = context(&s, &id).await;
    assert_eq!(data["location"]["kind"], "unborn");
    assert_eq!(data["location"]["head"], Value::Null);
    assert_eq!(data["github"]["pr"]["status"], "unborn");
    assert_eq!(action(&data, "commit")["status"], "conditional");
    assert_eq!(action(&data, "unstage")["status"], "conditional");
    assert_eq!(action(&data, "push")["status"], "blocked");
    git(&root, &["remote", "add", "origin", "file:///isolated-fixture-not-contacted"]);
    assert_eq!(action(&context(&s, &id).await, "pull")["status"], "conditional");
    git(&root, &["remote", "remove", "origin"]);
    let (_, expected) = s.get(&format!("/api/v1/projects/{id}/git/context?head=(initial)")).await;
    assert_eq!(expected["status"], "ok");
    // read_only 모델 정책은 직접 Git 변경 API의 권한과 혼동하지 않는다.
    let (status, _) = s.send(Method::PUT, "/api/v1/settings/server/-/tools.mode", json!({"expected_revision": 0, "value": "read_only"})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/settings/project/{id}/tools.mode"), json!({"expected_revision": 0, "value": "ask"})).await;
    assert_eq!(status, StatusCode::OK);
    let (_, device) = s.post("/api/v1/devices", json!({"name": "fixture-device"})).await;
    let token = device["token"].as_str().unwrap();
    let response = s.raw(Method::GET, &format!("/api/v1/projects/{id}/git/context"), None, None, Some(token)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let data: Value = response.json().await.unwrap();
    assert_eq!(data["authority"]["is_owner"], false);
    assert_eq!(data["authority"]["tool_mode"], "read_only");
    assert_eq!(data["authority"]["direct_git"], "authenticated");
    let (_, status) = s.get(&format!("/api/v1/projects/{id}/git/status")).await;
    let response = s.raw(Method::POST, &format!("/api/v1/projects/{id}/git/commit"),
        Some(json!({"message": "device commit", "expected_fingerprint": status["fingerprint"]})), Some("device-commit"), Some(token)).await;
    assert_eq!(response.status(), StatusCode::OK, "직접 Git API의 실제 권한");
    git(&root, &["switch", "--detach", "-q"]);
    let data = context(&s, &id).await;
    assert_eq!(data["location"]["kind"], "detached");
    assert_eq!(action(&data, "push")["status"], "blocked");
    let linked = s.dir.path().join("linked");
    git(&root, &["worktree", "add", "-qb", "linked", linked.to_str().unwrap()]);
    let linked_id = add(&s, &linked).await;
    let data = context(&s, &linked_id).await;
    assert_eq!(data["location"]["worktree"], "linked");
    assert_eq!(data["location"]["branch"], "linked");
    assert_eq!(data["location"]["git_registered"], true);
    assert_eq!(data["location"]["worktree_count"], 2);
    let nested = linked.join("nested");
    std::fs::create_dir(&nested).unwrap();
    let nested_id = add(&s, &nested).await;
    assert_eq!(context(&s, &nested_id).await["location"]["project_relative_to_worktree"], "nested");
    let empty = s.create_project("not-git").await;
    assert_eq!(context(&s, empty["id"].as_str().unwrap()).await["status"], "not_repo");
    assert_eq!(s.get("/api/v1/projects/nonexistent/git/context").await.0, StatusCode::NOT_FOUND);
    let response = s.raw(Method::GET, &format!("/api/v1/projects/{linked_id}/git/context"), None, None, Some("")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    // 기존 서버는 유효한 기기에 프로젝트별 ACL을 두지 않는다. 거짓 거부 규칙을 만들지 않는다.
    let (_, _) = s.send(Method::DELETE, &format!("/api/v1/devices/{}", device["id"].as_str().unwrap()), json!({})).await;
    let response = s.raw(Method::GET, &format!("/api/v1/projects/{linked_id}/git/context"), None, None, Some(token)).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[cfg(unix)]
#[tokio::test]
async fn head_race_and_expected_head_mismatch_clear_results_and_permissions() {
    let (s, root, id) = fixture().await;
    let (_, data) = s.get(&format!("/api/v1/projects/{id}/git/context?head={}", "0".repeat(40))).await;
    assert_eq!(data["status"], "stale");
    assert_eq!(data["authority"]["actions"], json!([]));
    assert!(!s.dir.path().join("calls").exists());
    std::fs::write(s.dir.path().join("mode"), "race").unwrap();
    let request = context(&s, &id);
    let race = async {
        tokio::time::timeout(std::time::Duration::from_secs(4), async {
            while !s.dir.path().join("started").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        git(&root, &["commit", "--allow-empty", "-qm", "concurrent HEAD"]);
        std::fs::write(s.dir.path().join("release"), "").unwrap();
    };
    let (data, _) = tokio::join!(request, race);
    assert_eq!(data["status"], "stale");
    assert_eq!(data["github"]["pr"], json!({"status": "stale"}));
    assert_eq!(data["github"]["ci"], json!({"status": "stale"}));
    assert_eq!(data["authority"]["actions"], json!([]));
    std::fs::write(s.dir.path().join("head"), git(&root, &["rev-parse", "HEAD"])).unwrap();
    assert_eq!(context(&s, &id).await["status"], "ok");
}

#[cfg(unix)]
#[tokio::test]
async fn device_revoked_during_gh_read_cannot_receive_project_results() {
    let (s, _, id) = fixture().await;
    let (status, device) = s.post("/api/v1/devices", json!({"name": "revoked-during-read"})).await;
    assert_eq!(status, StatusCode::CREATED);
    std::fs::write(s.dir.path().join("mode"), "race").unwrap();
    let path = format!("/api/v1/projects/{id}/git/context");
    let request = s.raw(Method::GET, &path, None, None, Some(device["token"].as_str().unwrap()));
    let revoke = async {
        tokio::time::timeout(std::time::Duration::from_secs(4), async {
            while !s.dir.path().join("started").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        let (status, _) = s.send(Method::DELETE,
            &format!("/api/v1/devices/{}", device["id"].as_str().unwrap()), json!({})).await;
        assert_eq!(status, StatusCode::OK);
        std::fs::write(s.dir.path().join("release"), "").unwrap();
    };
    let (response, _) = tokio::join!(request, revoke);
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let data: Value = response.json().await.unwrap();
    assert!(data.get("location").is_none());
    assert!(data.get("github").is_none());
}
