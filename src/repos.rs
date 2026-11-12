//! 저장소 clone·GitHub 저장소 검색·경로 제안(PROJECT-012). 원본의 같은 기능 범위를 유지한다.
//!
//! - 검색은 서버 PC의 GitHub CLI(`gh`, `Config::gh_command`)로만 한다. 결과 상태를 success / unavailable(gh 없음) /
//!   unauthenticated(로그인 필요) / error로 나눠 화면이 원인별로 안내한다. 토큰을 Grove가 따로 저장하지 않는다.
//! - clone은 `owner/name`(+https|ssh) 또는 원격 URL(https·ssh·`git@host:`·file)을 받는다. 대상 폴더 아래 같은 이름이
//!   이미 있으면 거절하고, 임시 폴더에 받은 뒤 이름을 바꿔 부분 clone이 프로젝트 경로에 남지 않게 한다. 실패하면 Grove가
//!   만든 임시 폴더만 지운다. 끝나면 같은 Idempotency-Key 응답에 프로젝트를 등록한다.
//! - 경로 제안은 폴더 이름만 돌려준다(파일 내용 없음). 절대 경로·`~`는 그 폴더의 하위 폴더 접두어로, 그 밖은 홈 아래를
//!   제한된 깊이·개수로 찾는다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::idem;
use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;

const CLONE_TIMEOUT: Duration = Duration::from_secs(300);
const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);
/// clone은 한 번에 하나씩(같은 대상 경로 경합·디스크 폭주 방지).
static CLONE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn expand(raw: &str) -> Option<PathBuf> {
    if raw == "~" {
        return home();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return home().map(|h| h.join(rest));
    }
    Some(PathBuf::from(raw))
}

fn valid_segment(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && !s.starts_with('.') && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

#[derive(Debug, PartialEq)]
pub struct Repo {
    /// 화면 표시용(owner/name 또는 원격 경로, 자격 증명 제외)
    pub display: String,
    pub name: String,
    pub url: String,
}

/// URL의 사용자 정보(토큰 등)를 가린다.
fn redact(s: &str) -> String {
    let mut out = String::new();
    for word in s.split_inclusive(char::is_whitespace) {
        match (word.find("://"), word.find('@')) {
            (Some(scheme), Some(at)) if at > scheme => {
                out.push_str(&word[..scheme + 3]);
                out.push_str("***");
                out.push_str(&word[at..]);
            }
            _ => out.push_str(word),
        }
    }
    out
}

pub fn normalize(repo: &str, protocol: Option<&str>) -> ApiResult<Repo> {
    let t = repo.trim();
    if t.is_empty() {
        return Err(ApiError::invalid("저장소를 입력하세요"));
    }
    if t.starts_with('-') || t.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(ApiError::invalid("저장소 주소가 올바르지 않습니다"));
    }
    let remote = ["https://", "ssh://", "file://"].iter().find_map(|p| t.strip_prefix(p).map(|rest| (*p, rest)));
    let path = match remote {
        Some(("file://", rest)) => Some(rest.to_string()),
        Some((_, rest)) => Some(rest.split_once('/').map(|(_, p)| p.to_string()).unwrap_or_default()),
        None => t.strip_prefix("git@").and_then(|r| r.split_once(':')).map(|(_, p)| p.to_string()),
    };
    if let Some(path) = path {
        let trimmed = path.trim_end_matches('/');
        let last = trimmed.rsplit('/').next().unwrap_or("");
        let name = last.strip_suffix(".git").unwrap_or(last);
        if !valid_segment(name) {
            return Err(ApiError::invalid("저장소 이름에 쓸 수 없는 문자가 있습니다"));
        }
        let display = if t.starts_with("file://") { trimmed.to_string() } else { trimmed.trim_start_matches('/').to_string() };
        return Ok(Repo { display: redact(&display), name: name.into(), url: t.into() });
    }
    if t.contains("://") || t.contains(':') {
        return Err(ApiError::invalid("https·ssh·git@·file 원격 주소 또는 owner/name만 쓸 수 있습니다"));
    }
    let mut parts = t.split('/');
    let (owner, raw, extra) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next());
    let name = raw.strip_suffix(".git").unwrap_or(raw);
    if extra.is_some() || !valid_segment(owner) || !valid_segment(name) {
        return Err(ApiError::invalid("owner/name 형식으로 입력하세요"));
    }
    let url = match protocol {
        Some("https") => format!("https://github.com/{owner}/{name}.git"),
        Some("ssh") => format!("git@github.com:{owner}/{name}.git"),
        _ => return Err(ApiError::invalid("owner/name은 clone 방식(https 또는 ssh)을 골라야 합니다")),
    };
    Ok(Repo { display: format!("{owner}/{name}"), name: name.into(), url })
}

#[derive(Deserialize)]
pub struct CloneBody {
    pub repo: String,
    /// owner/name일 때 https | ssh
    pub protocol: Option<String>,
    /// clone할 상위 폴더(없으면 만든다). 결과는 `<target_directory>/<저장소 이름>`.
    pub target_directory: String,
}

pub async fn clone(State(app): State<App>, p: Principal, headers: HeaderMap, Json(b): Json<CloneBody>) -> ApiResult<Response> {
    let repo = normalize(&b.repo, b.protocol.as_deref())?;
    let parent = expand(b.target_directory.trim()).filter(|x| x.is_absolute()).ok_or_else(|| ApiError::invalid("대상 폴더는 절대 경로나 ~로 입력하세요"))?;
    let h = idem::body_hash("project.clone", &json!({ "url": repo.url, "target": parent }));
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? {
        return Ok(r);
    }
    let _g = CLONE_LOCK.lock().await;
    crate::auth::revalidate(&app, &p).await?;
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? {
        return Ok(r);
    }
    std::fs::create_dir_all(&parent).map_err(|e| ApiError::new(StatusCode::FORBIDDEN, "permission_denied", format!("대상 폴더를 만들 수 없습니다: {e}")))?;
    let parent = crate::util::canonical(&parent).map_err(|e| ApiError::invalid(format!("대상 폴더를 확인할 수 없습니다: {e}")))?;
    let checkout = parent.join(&repo.name);
    if std::fs::symlink_metadata(&checkout).is_ok() {
        return Err(ApiError::conflict("already_exists", format!("이미 있는 경로입니다: {}", checkout.display())).with_details(json!({ "path": checkout })));
    }
    let staging = parent.join(format!(".grove-clone-{}", crate::util::new_id()));
    let result = run_clone(&repo.url, &parent, &staging).await;
    if let Err(e) = result {
        // Grove가 만든 임시 폴더만 정리한다. 대상 경로·다른 파일은 건드리지 않는다.
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&staging, &checkout) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(ApiError::conflict("clone_failed", format!("clone한 폴더를 옮기지 못했습니다: {e}")));
    }
    let root = crate::util::canonical(&checkout).map_err(|e| ApiError::internal(e.to_string()))?.to_string_lossy().to_string();
    let (name, display) = (repo.name.clone(), repo.display.clone());
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let project = crate::projects::insert(tx, now, &root, &name)?;
        Ok((StatusCode::CREATED, json!({ "project": project, "checkout_path": root, "repo": display })))
    })
    .await
}

async fn run_clone(url: &str, parent: &Path, staging: &Path) -> ApiResult<()> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(["clone", "--quiet", "--"]).arg(url).arg(staging)
        .current_dir(parent)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        // 사람이 없는 서버에서 ssh 비밀번호·host key 질문으로 멈추지 않게 한다.
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    let out = tokio::time::timeout(CLONE_TIMEOUT, cmd.output())
        .await
        .map_err(|_| ApiError::new(StatusCode::GATEWAY_TIMEOUT, "timeout", "clone이 5분 안에 끝나지 않아 중단했습니다"))?
        .map_err(|e| if crate::deps::is_missing("git", Some(&e)) { crate::deps::missing("git") } else { ApiError::internal(format!("git clone 실행 실패: {e}")) })?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).lines().filter(|l| !l.trim().is_empty()).take(5).collect::<Vec<_>>().join(" / ");
        return Err(ApiError::conflict("clone_failed", format!("clone 실패: {}", redact(&msg))));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    pub q: String,
    pub limit: Option<u32>,
}

pub async fn search(State(app): State<App>, _p: Principal, Query(q): Query<SearchQuery>) -> ApiResult<Json<Value>> {
    let limit = q.limit.unwrap_or(20).clamp(1, 50).to_string();
    let query = q.q.trim().to_string();
    let args: Vec<String> = if query.is_empty() {
        ["repo", "list", "--json", "id,name,nameWithOwner,description,isPrivate,updatedAt,url", "--limit", &limit].map(String::from).to_vec()
    } else {
        let mut a = ["search", "repos", "--json", "id,name,fullName,description,isPrivate,updatedAt,url", "--sort", "updated", "--order", "desc", "--limit", &limit]
            .map(String::from)
            .to_vec();
        a.extend(["--".into(), query]);
        a
    };
    let mut cmd = tokio::process::Command::new(&app.cfg.gh_command);
    cmd.args(&args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(h) = home().filter(|h| h.is_dir()) {
        cmd.current_dir(h);
    }
    let status = |status: &str, available: bool, error: Option<String>| json!({ "status": status, "available": available, "repositories": [], "error": error });
    let out = match tokio::time::timeout(SEARCH_TIMEOUT, cmd.output()).await {
        Err(_) => return Ok(Json(status("error", true, Some("GitHub 검색이 30초 안에 끝나지 않았습니다".into())))),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut v = status("unavailable", false, Some("서버 PC에 GitHub CLI(gh)가 없습니다. 설치하면 저장소를 검색할 수 있습니다".into()));
            v["reason"] = json!("gh_missing");
            return Ok(Json(v));
        }
        Ok(Err(e)) => return Ok(Json(status("error", true, Some(format!("gh 실행 실패: {e}"))))),
        Ok(Ok(o)) => o,
    };
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        let lower = err.to_lowercase();
        if out.status.code() == Some(4) || lower.contains("gh auth login") || lower.contains("not logged in") {
            return Ok(Json(status("unauthenticated", false, Some("서버 PC의 GitHub CLI가 로그인되어 있지 않습니다. 서버에서 `gh auth login`을 실행하세요".into()))));
        }
        let msg = err.lines().filter(|l| !l.trim().is_empty()).take(3).collect::<Vec<_>>().join(" / ");
        return Ok(Json(status("error", true, Some(if msg.is_empty() { "GitHub 검색 실패".into() } else { redact(&msg) }))));
    }
    let rows: Vec<Value> = serde_json::from_slice(&out.stdout).map_err(|_| ApiError::new(StatusCode::BAD_GATEWAY, "invalid_response", "gh 응답 형식을 해석하지 못했습니다"))?;
    let repositories: Vec<Value> = rows
        .iter()
        .filter_map(|r| {
            let full = r["nameWithOwner"].as_str().or(r["fullName"].as_str())?;
            Some(json!({
                "full_name": full, "name": r["name"], "description": r["description"], "private": r["isPrivate"].as_bool().unwrap_or(false),
                "updated_at": r["updatedAt"], "url": r["url"],
            }))
        })
        .collect();
    Ok(Json(json!({ "status": "success", "available": true, "repositories": repositories, "error": null })))
}

#[derive(Deserialize)]
pub struct SuggestQuery {
    #[serde(default)]
    pub q: String,
    pub limit: Option<usize>,
}

const SKIP: &[&str] = &["node_modules", "target", "dist", "build", "vendor", "__pycache__"];
const MAX_SCAN: usize = 5_000;
const MAX_DEPTH: usize = 4;

/// 경로 입력 제안. 폴더만 돌려준다.
pub async fn suggest(_p: Principal, Query(q): Query<SuggestQuery>) -> ApiResult<Json<Value>> {
    let limit = q.limit.unwrap_or(20).clamp(1, 100);
    let query = q.q.trim().to_string();
    if query.is_empty() {
        return Ok(Json(json!({ "directories": [], "truncated": false })));
    }
    tokio::task::spawn_blocking(move || Ok(Json(suggest_dirs(&query, limit))))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
}

fn suggest_dirs(query: &str, limit: usize) -> Value {
    let dirs_of = |dir: &Path| -> Vec<(String, PathBuf)> {
        std::fs::read_dir(dir)
            .map(|rd| {
                rd.flatten()
                    .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                    .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
                    .collect()
            })
            .unwrap_or_default()
    };
    // 경로처럼 입력하면 그 폴더의 하위 폴더 이름 접두어로 제안한다.
    if query.starts_with('/') || query.starts_with('~') || (cfg!(windows) && query.get(1..3) == Some(":\\")) {
        let Some(full) = expand(query) else { return json!({ "directories": [], "truncated": false }) };
        let text = full.to_string_lossy().to_string();
        let (dir, prefix) = if text.ends_with(std::path::MAIN_SEPARATOR) || text.ends_with('/') {
            (full.clone(), String::new())
        } else {
            (full.parent().map(Path::to_path_buf).unwrap_or(full.clone()), full.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default())
        };
        let mut out: Vec<(String, PathBuf)> = dirs_of(&dir)
            .into_iter()
            .filter(|(n, _)| n.to_lowercase().starts_with(&prefix) && (prefix.starts_with('.') || !n.starts_with('.')))
            .collect();
        out.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
        let truncated = out.len() > limit;
        out.truncate(limit);
        return json!({ "directories": out.into_iter().map(|(_, p)| p.to_string_lossy().to_string()).collect::<Vec<_>>(), "truncated": truncated });
    }
    // 이름으로 입력하면 홈 아래를 얕게 찾는다(숨김·빌드 산출물 폴더 제외, 검사 개수 상한).
    let Some(h) = home() else { return json!({ "directories": [], "truncated": false }) };
    let needle = query.to_lowercase();
    let mut queue = std::collections::VecDeque::from([(h, 0usize)]);
    let (mut scanned, mut found): (usize, Vec<(u8, usize, PathBuf)>) = (0, vec![]);
    while let Some((dir, depth)) = queue.pop_front() {
        for (name, path) in dirs_of(&dir) {
            if name.starts_with('.') || SKIP.contains(&name.as_str()) {
                continue;
            }
            scanned += 1;
            let lower = name.to_lowercase();
            if lower.contains(&needle) {
                found.push((u8::from(!lower.starts_with(&needle)), path.as_os_str().len(), path.clone()));
            }
            if depth + 1 < MAX_DEPTH {
                queue.push_back((path, depth + 1));
            }
            if scanned >= MAX_SCAN {
                break;
            }
        }
        if scanned >= MAX_SCAN {
            break;
        }
    }
    found.sort();
    let truncated = scanned >= MAX_SCAN || found.len() > limit;
    found.truncate(limit);
    json!({ "directories": found.into_iter().map(|(_, _, p)| p.to_string_lossy().to_string()).collect::<Vec<_>>(), "truncated": truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_slugs_and_remote_urls_without_leaking_credentials() {
        assert_eq!(normalize("octo/hello", Some("https")).unwrap().url, "https://github.com/octo/hello.git");
        assert_eq!(normalize("octo/hello.git", Some("ssh")).unwrap().url, "git@github.com:octo/hello.git");
        assert!(normalize("octo/hello", None).is_err(), "owner/name은 방식 필요");
        let r = normalize("https://user:secret@example.com/team/app.git", None).unwrap();
        assert_eq!((r.name.as_str(), r.display.contains("secret")), ("app", false));
        assert_eq!(normalize("git@github.com:o/n.git", None).unwrap().name, "n");
        assert_eq!(normalize("file:///srv/git/lib.git", None).unwrap().name, "lib");
        for bad in ["", "-u", "o/n/x", "ext::sh -c x", "http://example.com/a.git", "../x", "o/.hidden", "https://example.com/"] {
            assert!(normalize(bad, Some("https")).is_err(), "{bad}");
        }
        assert_eq!(redact("fatal: https://u:tok@h/x not found"), "fatal: https://***@h/x not found");
    }
}
