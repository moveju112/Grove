//! 읽기 전용 Git 위치·exact-HEAD GitHub 개요. 기존 변경 API의 승인을 대체하지 않는다.
use crate::{App, auth::Principal, error::{ApiError, ApiResult}, git};
use axum::{Json, extract::{Path, Query, State}};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::Path as FsPath, process::Stdio, time::Duration};

#[derive(Deserialize)]
pub struct ContextQuery {
    pub head: Option<String>,
}

async fn read(root: &FsPath, args: &[&str]) -> ApiResult<git::GitOut> {
    git::git(root, args, true).await.map_err(|e| {
        ApiError::new(e.status, e.code, "Git 위치를 확인하지 못했습니다")
    })
}

async fn checked(root: &FsPath, args: &[&str]) -> ApiResult<String> {
    let out = read(root, args).await?;
    if out.code != 0 {
        return Err(ApiError::conflict("unknown", "Git 위치를 확인하지 못했습니다"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

// 원격 URL 자체는 응답·오류·로그에 남기지 않는다. 검증 후 owner/name만 gh에 전달한다.
fn github_repo(remote: &str) -> Option<String> {
    let path = if let Some(path) = remote.strip_prefix("git@github.com:") {
        path.to_string()
    } else {
        let url = reqwest::Url::parse(remote).ok()?;
        if !matches!(url.scheme(), "https" | "ssh")
            || url.host_str()? != "github.com"
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return None;
        }
        url.path().trim_start_matches('/').to_string()
    };
    let path = path.trim_end_matches('/');
    if path.matches('/').count() != 1 || path.contains(':') { return None; }
    crate::repos::normalize(path, Some("https")).ok()
        .map(|r| r.display)
}

fn state(status: &str) -> Value {
    json!({"status": status})
}

async fn gh(app: &App, endpoint: &str) -> Result<Value, &'static str> {
    let mut cmd = tokio::process::Command::new(&app.cfg.gh_command);
    cmd.args(["api", "--hostname", "github.com", "--method", "GET", endpoint])
        .current_dir(&app.cfg.data_dir)
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let out = match tokio::time::timeout(Duration::from_secs(8), cmd.output()).await {
        Err(_) => return Err("timeout"),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => return Err("missing"),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::PermissionDenied => return Err("denied"),
        Ok(Err(_)) => return Err("unknown"),
        Ok(Ok(out)) => out,
    };
    if !out.status.success() {
        // 오류 원문은 분류에만 쓰고 절대로 반환하거나 기록하지 않는다.
        let error = String::from_utf8_lossy(&out.stderr).to_ascii_lowercase();
        return Err(if out.status.code() == Some(4) || error.contains("http 401")
            || error.contains("gh auth login") || error.contains("not logged in") {
            "unauthenticated"
        } else if error.contains("http 403") || error.contains("http 404") {
            "denied"
        } else { "unknown" });
    }
    if out.stdout.len() > 2 * 1024 * 1024 {
        return Err("unknown");
    }
    serde_json::from_slice(&out.stdout).map_err(|_| "unknown")
}

async fn pull_requests(app: &App, repo: &str, head: &str) -> Value {
    let data = match gh(app, &format!("repos/{repo}/commits/{head}/pulls?per_page=100")).await {
        Ok(data) => data,
        Err(reason) => return state(reason),
    };
    let Some(rows) = data.as_array().filter(|rows| rows.len() < 100) else { return state("unknown") };
    let mut items = vec![];
    for row in rows {
        let Some(sha) = row["head"]["sha"].as_str() else { return state("unknown") };
        if sha != head { continue; }
        if !row["base"]["repo"]["full_name"].as_str().is_some_and(|name| name.eq_ignore_ascii_case(repo)) {
            return state("unknown");
        }
        let (Some(number), Some(pr_state), Some(draft)) =
            (row["number"].as_u64(), row["state"].as_str(), row["draft"].as_bool()) else { return state("unknown") };
        if !matches!(pr_state, "open" | "closed") { return state("unknown"); }
        let merged = row["merged_at"].as_str().is_some();
        items.push(json!({"number": number, "state": if merged { "merged" } else { pr_state }, "draft": draft}));
    }
    json!({"status": if items.is_empty() { "none" } else { "ok" }, "items": items})
}

async fn ci(app: &App, repo: &str, head: &str) -> Value {
    let checks = match gh(app, &format!("repos/{repo}/commits/{head}/check-runs?per_page=100&filter=latest")).await {
        Ok(data) => data,
        Err(reason) => return state(reason),
    };
    let Some(rows) = checks["check_runs"].as_array() else { return state("unknown") };
    if checks["total_count"].as_u64() != Some(rows.len() as u64) || rows.len() >= 100 {
        return state("unknown");
    }
    let mut results = vec![];
    for row in rows {
        if row["head_sha"] != head { return state("stale"); }
        let result = match row["status"].as_str() {
            Some("queued" | "in_progress" | "waiting" | "pending" | "requested") => "pending",
            Some("completed") => match row["conclusion"].as_str() {
                Some("success") => "success",
                Some("failure" | "timed_out" | "cancelled" | "action_required" | "startup_failure") => "failure",
                Some("neutral" | "skipped") => "neutral",
                _ => return state("unknown"),
            },
            _ => return state("unknown"),
        };
        results.push(result);
    }
    let statuses = match gh(app, &format!("repos/{repo}/commits/{head}/status?per_page=100")).await {
        Ok(data) => data,
        Err(reason) => return state(reason),
    };
    if statuses["sha"] != head { return state("stale"); }
    let Some(rows) = statuses["statuses"].as_array() else { return state("unknown") };
    if statuses["total_count"].as_u64() != Some(rows.len() as u64) || rows.len() >= 100 {
        return state("unknown");
    }
    for row in rows {
        results.push(match row["state"].as_str() {
            Some("success") => "success",
            Some("pending") => "pending",
            Some("failure" | "error") => "failure",
            _ => return state("unknown"),
        });
    }
    let status = if results.is_empty() { "none" }
        else if results.contains(&"failure") { "failure" }
        else if results.contains(&"pending") { "pending" }
        else if results.iter().all(|r| *r == "neutral") { "neutral" }
        else { "success" };
    json!({"status": status, "count": results.len()})
}

fn action(id: &str, blocked: bool, reason: &str) -> Value {
    json!({"id": id, "status": if blocked { "blocked" } else { "conditional" }, "reason": reason})
}

fn actions(status: &Value, origin: bool) -> Vec<Value> {
    let entries = status["entries"].as_array().expect("parse_status entries");
    let staged = entries.iter().any(|e| !matches!(e["index"].as_str(), Some("." | "?")));
    let unstaged = entries.iter().any(|e| e["worktree"] != "." || e["index"] == "?");
    let tracked = entries.iter().any(|e| e["kind"] != "untracked");
    let conflict = entries.iter().any(|e| e["kind"] == "conflict");
    let detached = status["branch"]["head"] == "(detached)";
    let unborn = status["branch"]["oid"] == "(initial)";
    vec![
        action("stage", !unstaged, if unstaged { "파일·hunk와 fingerprint를 변경 API에서 재검사합니다" } else { "작업 트리 변경이 없습니다" }),
        action("unstage", !staged, if staged { "선택한 index와 fingerprint를 다시 확인합니다. 첫 커밋 전에는 index에서만 제거합니다" } else { "stage된 변경이 없습니다" }),
        action("commit", !staged || conflict, if conflict { "충돌 해결이 필요합니다" } else if staged { "메시지·fingerprint·Git hook/작성자 설정은 실행 시 확인합니다. detached에서도 커밋 자체는 가능합니다" } else { "stage된 변경이 없습니다" }),
        action("stash", !tracked || unborn || conflict, if unborn { "첫 커밋이 필요합니다" } else if conflict { "충돌 해결이 필요합니다" } else if tracked { "tracked 변경만 저장하며 fingerprint를 다시 확인합니다" } else { "저장할 tracked 변경이 없습니다" }),
        action("fetch", !origin, if origin { "기존 API는 origin을 사용합니다. 원격 자격·접근은 실행 시 확인합니다" } else { "기존 기본 작업 대상 origin이 없습니다" }),
        action("pull", !origin || detached || conflict, if detached { "현재 브랜치가 없습니다(detached HEAD)" } else if conflict { "충돌 해결이 필요합니다" } else if !origin { "origin이 없습니다" } else if unborn { "첫 커밋 전입니다. 원격의 현재 브랜치를 가져올 수 있는지는 Git이 판정합니다" } else if !entries.is_empty() { "변경이 있습니다. Git이 보존 가능한지와 fast-forward 여부를 실행 시 확인합니다" } else { "fast-forward·원격 브랜치·자격은 실행 시 확인합니다" }),
        action("push", !origin || detached || unborn, if detached { "현재 브랜치가 없습니다(detached HEAD)" } else if unborn { "첫 커밋이 필요합니다" } else if origin { "원격 쓰기 권한·원격 이력은 실행 시 확인합니다. 강제 push는 하지 않습니다" } else { "origin이 없습니다" }),
        action("discard / stash pop / branch / merge", false, "대상·revision·fingerprint·확인 dialog와 Git 충돌 검사가 필요합니다. 조회로 실행하지 않습니다"),
        action("PR 생성·merge / CI 재실행", true, "이 개요에서 제공하지 않는 작업입니다"),
    ]
}

pub async fn show(State(app): State<App>, p: Principal, Path(id): Path<String>, Query(q): Query<ContextQuery>) -> ApiResult<Json<Value>> {
    let _resource = app.project_resources.ui_read(&app, &id, &p).await?;
    let root = git::root_of(&app, &id).await?;
    if !git::is_repo(&root).await? {
        return Ok(Json(json!({"project_id": id, "status": "not_repo"})));
    }
    let raw = checked(&root, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]).await?;
    let local = git::parse_status(raw.as_bytes());
    let head = local["branch"]["oid"].as_str().filter(|s| *s != "(initial)").map(str::to_string);
    let metadata = checked(&root, &["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]).await?;
    let paths: Vec<_> = metadata.lines().collect();
    if paths.len() != 3 { return Err(ApiError::conflict("unknown", "Git 위치 형식을 확인하지 못했습니다")); }
    let canonical_root = std::fs::canonicalize(&root).map_err(|_| ApiError::gone("프로젝트 위치에 접근할 수 없습니다"))?;
    let relative = canonical_root.strip_prefix(paths[0]).ok()
        .map(|p| if p.as_os_str().is_empty() { ".".to_string() } else { p.to_string_lossy().to_string() });
    let worktrees = checked(&root, &["worktree", "list", "--porcelain", "-z"]).await?;
    let registered = worktrees.split('\0').filter_map(|s| s.strip_prefix("worktree ")).any(|path| path == paths[0]);
    let count = worktrees.split('\0').filter(|s| s.starts_with("worktree ")).count();
    let remote = read(&root, &["config", "--get", "remote.origin.url"]).await?;
    if !matches!(remote.code, 0 | 1) { return Err(ApiError::conflict("unknown", "origin을 확인하지 못했습니다")); }
    let remote = String::from_utf8_lossy(&remote.stdout).trim().to_string();
    let repo = github_repo(&remote);
    let initial_stale = q.head.as_ref().is_some_and(|expected| local["branch"]["oid"].as_str() != Some(expected));
    let reason = if initial_stale { Some("stale") } else if head.is_none() { Some("unborn") }
        else if remote.is_empty() { Some("no_remote") } else if repo.is_none() { Some("unsupported") } else { None };
    let (mut prs, mut checks) = if let Some(reason) = reason {
        (state(reason), state(reason))
    } else {
        let repo = repo.as_deref().expect("validated repo");
        let head = head.as_deref().expect("existing HEAD");
        (pull_requests(&app, repo, head).await, ci(&app, repo, head).await)
    };
    let current_root = git::root_of(&app, &id).await?;
    let now = checked(&root, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]).await?;
    let now_remote = read(&root, &["config", "--get", "remote.origin.url"]).await?;
    let now_metadata = checked(&root, &["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]).await?;
    let now_worktrees = checked(&root, &["worktree", "list", "--porcelain", "-z"]).await?;
    let stale = initial_stale || current_root != root || raw != now || metadata != now_metadata || worktrees != now_worktrees
        || !matches!(now_remote.code, 0 | 1) || remote != String::from_utf8_lossy(&now_remote.stdout).trim();
    crate::auth::revalidate(&app, &p).await?;
    let pid = id.clone();
    let tool_mode = app.db.call(move |c| {
        Ok(if crate::settings::all_layers(c, "tools.mode", Some(&pid), None)?.iter().any(|v| v == "read_only") {
            "read_only"
        } else { "ask" })
    }).await?;
    if stale { prs = state("stale"); checks = state("stale"); }
    Ok(Json(json!({
        "project_id": id, "status": if stale { "stale" } else { "ok" }, "observed_at": app.now(),
        "location": {
            "branch": local["branch"]["head"], "head": head,
            "kind": if head.is_none() { "unborn" } else if local["branch"]["head"] == "(detached)" { "detached" } else { "branch" },
            "project_relative_to_worktree": relative,
            "worktree": if paths[1] == paths[2] { "main" } else { "linked" },
            "git_registered": registered, "worktree_count": count,
        },
        "github": {"repository": repo, "remote": "origin", "head": head, "pr": prs, "ci": checks},
        "authority": {
            "authenticated": true, "is_owner": p.is_owner, "tool_mode": tool_mode,
            "direct_git": "authenticated", "remote_permission": "unknown",
            "actions": if stale { vec![] } else { actions(&local, !remote.is_empty()) },
        }
    })))
}
