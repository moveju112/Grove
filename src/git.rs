//! Git 조회·stage·commit·branch(GIT-001~004, 006, 015, 016).
//! - `git` 실행 파일을 호출한다(GIT-020: 기본 패키지에 포함하지 않고 시스템 git 사용, 없으면 명시적 오류).
//! - 저장소별 변경 작업은 직렬화한다. 읽기는 `--no-optional-locks`로 index lock을 잡지 않는다.
//! - stage·commit은 사용자가 본 diff fingerprint와 현재 상태가 같을 때만 수행한다(stale diff 거부).
//! - stash·reset·clean·checkout으로 사용자 변경을 자동으로 버리지 않는다(GIT-006).

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::idem;
use crate::util::sha256_hex;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MAX_DIFF: usize = 512 * 1024;

#[derive(Default)]
pub struct RepoLocks {
    map: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl RepoLocks {
    pub(crate) fn get(&self, project: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.map.lock().expect("repo locks").entry(project.to_string()).or_default().clone()
    }
}

pub struct GitOut {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

pub async fn git(root: &std::path::Path, args: &[&str], read_only: bool) -> ApiResult<GitOut> {
    let mut cmd = tokio::process::Command::new("git");
    if read_only {
        cmd.arg("--no-optional-locks");
    }
    cmd.args(["-c", "core.quotepath=false", "-c", "color.ui=false"])
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", if read_only { "0" } else { "1" })
        .env("LC_ALL", "C")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(60), cmd.output())
        .await
        .map_err(|_| ApiError::new(StatusCode::GATEWAY_TIMEOUT, "timeout", "git 명령이 60초 안에 끝나지 않았습니다"))?
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => ApiError::unsupported("git 실행 파일이 없습니다. 서버에 git을 설치하세요"),
            _ => ApiError::internal(format!("git 실행 실패: {e}")),
        })?;
    Ok(GitOut { code: out.status.code().unwrap_or(-1), stdout: out.stdout, stderr: String::from_utf8_lossy(&out.stderr).trim().to_string() })
}

pub(crate) fn fail(out: &GitOut, what: &str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "git_failed", format!("{what} 실패: {}", out.stderr.lines().take(5).collect::<Vec<_>>().join(" / ")))
}

pub(crate) async fn root_of(app: &App, project_id: &str) -> ApiResult<PathBuf> {
    let pid = project_id.to_string();
    app.db.call(move |c| crate::projects::active_root(c, &pid)).await
}

pub(crate) async fn is_repo(root: &std::path::Path) -> ApiResult<bool> {
    let o = git(root, &["rev-parse", "--is-inside-work-tree"], true).await?;
    Ok(o.code == 0 && String::from_utf8_lossy(&o.stdout).trim() == "true")
}

/// `git status --porcelain=v2 -z` 파싱
pub fn parse_status(raw: &[u8]) -> Value {
    let mut branch = json!({});
    let mut entries = vec![];
    let mut parts = raw.split(|b| *b == 0).peekable();
    while let Some(p) = parts.next() {
        let s = String::from_utf8_lossy(p).to_string();
        if s.is_empty() {
            continue;
        }
        if let Some(h) = s.strip_prefix("# ") {
            let (k, v) = h.split_once(' ').unwrap_or((h, ""));
            match k {
                "branch.head" => branch["head"] = json!(v),
                "branch.oid" => branch["oid"] = json!(v),
                "branch.upstream" => branch["upstream"] = json!(v),
                "branch.ab" => {
                    let mut it = v.split(' ');
                    branch["ahead"] = json!(it.next().and_then(|a| a.trim_start_matches('+').parse::<i64>().ok()));
                    branch["behind"] = json!(it.next().and_then(|b| b.trim_start_matches('-').parse::<i64>().ok()));
                }
                _ => {}
            }
            continue;
        }
        let kind = &s[..1];
        match kind {
            "1" => {
                let f: Vec<&str> = s.splitn(9, ' ').collect();
                let xy = f.get(1).copied().unwrap_or("..");
                entries.push(json!({ "path": f.get(8).copied().unwrap_or(""), "index": &xy[..1], "worktree": &xy[1..2], "kind": "changed" }));
            }
            "2" => {
                let f: Vec<&str> = s.splitn(10, ' ').collect();
                let xy = f.get(1).copied().unwrap_or("..");
                let orig = parts.next().map(|o| String::from_utf8_lossy(o).to_string()).unwrap_or_default();
                entries.push(json!({ "path": f.get(9).copied().unwrap_or(""), "orig_path": orig, "index": &xy[..1], "worktree": &xy[1..2], "kind": "renamed" }));
            }
            "u" => {
                let f: Vec<&str> = s.splitn(11, ' ').collect();
                entries.push(json!({ "path": f.get(10).copied().unwrap_or(""), "index": "U", "worktree": "U", "kind": "conflict" }));
            }
            "?" => entries.push(json!({ "path": &s[2..], "index": "?", "worktree": "?", "kind": "untracked" })),
            "!" => {}
            _ => {}
        }
    }
    json!({ "branch": branch, "entries": entries })
}

#[derive(Deserialize)]
pub struct DiffQuery {
    pub staged: Option<bool>,
    pub path: Option<String>,
}

fn check_path(p: &str) -> ApiResult<()> {
    if p.is_empty() || p.starts_with('-') || p.contains('\0') || p.split('/').any(|c| c == "..") || p.starts_with('/') {
        return Err(ApiError::invalid(format!("허용되지 않는 경로: {p}")));
    }
    Ok(())
}

async fn diff_text(root: &std::path::Path, staged: bool, path: Option<&str>) -> ApiResult<(String, bool)> {
    let mut args = vec!["diff", "--no-ext-diff", "--patch", "--find-renames"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    if let Some(p) = path {
        args.push(p);
    }
    let o = git(root, &args, true).await?;
    if o.code != 0 {
        return Err(fail(&o, "diff"));
    }
    let truncated = o.stdout.len() > MAX_DIFF;
    let mut text = String::from_utf8_lossy(&o.stdout[..o.stdout.len().min(MAX_DIFF)]).to_string();
    if truncated {
        text.push_str("\n…(diff가 너무 커서 생략)\n");
    }
    Ok((text, truncated))
}

/// 사용자가 본 상태를 식별하는 fingerprint: 전체 diff(작업 트리·index)와 untracked 목록과 HEAD.
async fn fingerprint(root: &std::path::Path) -> ApiResult<String> {
    let st = git(root, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"], true).await?;
    let wt = git(root, &["diff", "--no-ext-diff", "--binary"], true).await?;
    let ix = git(root, &["diff", "--no-ext-diff", "--binary", "--cached"], true).await?;
    let mut buf = st.stdout;
    buf.extend_from_slice(b"\n--wt--\n");
    buf.extend_from_slice(&wt.stdout);
    buf.extend_from_slice(b"\n--ix--\n");
    buf.extend_from_slice(&ix.stdout);
    Ok(sha256_hex(&buf))
}

pub async fn status(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let root = root_of(&app, &id).await?;
    if !is_repo(&root).await? {
        return Ok(Json(json!({ "is_repo": false })));
    }
    let o = git(&root, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"], true).await?;
    if o.code != 0 {
        return Err(fail(&o, "status"));
    }
    let mut v = parse_status(&o.stdout);
    v["is_repo"] = json!(true);
    v["fingerprint"] = json!(fingerprint(&root).await?);
    Ok(Json(v))
}

pub async fn diff(State(app): State<App>, _p: Principal, Path(id): Path<String>, Query(q): Query<DiffQuery>) -> ApiResult<Json<Value>> {
    let root = root_of(&app, &id).await?;
    if let Some(p) = &q.path {
        check_path(p)?;
    }
    let (text, truncated) = diff_text(&root, q.staged.unwrap_or(false), q.path.as_deref()).await?;
    Ok(Json(json!({ "diff": text, "truncated": truncated, "fingerprint": fingerprint(&root).await? })))
}

#[derive(Deserialize)]
pub struct LogQuery {
    pub limit: Option<u32>,
}

pub async fn log(State(app): State<App>, _p: Principal, Path(id): Path<String>, Query(q): Query<LogQuery>) -> ApiResult<Json<Value>> {
    let root = root_of(&app, &id).await?;
    let n = q.limit.unwrap_or(50).clamp(1, 500).to_string();
    let o = git(&root, &["log", "-n", &n, "--format=%H%x1f%an%x1f%aI%x1f%s%x1e"], true).await?;
    if o.code != 0 {
        // 커밋이 없는 새 저장소
        return Ok(Json(json!({ "commits": [] })));
    }
    let commits: Vec<Value> = String::from_utf8_lossy(&o.stdout)
        .split('\u{1e}')
        .filter_map(|r| {
            let f: Vec<&str> = r.trim().split('\u{1f}').collect();
            (f.len() == 4).then(|| json!({ "hash": f[0], "author": f[1], "date": f[2], "subject": f[3] }))
        })
        .collect();
    Ok(Json(json!({ "commits": commits })))
}

pub async fn branches(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let root = root_of(&app, &id).await?;
    let o = git(&root, &["branch", "--format=%(refname:short)%1f%(HEAD)%1f%(objectname:short)"], true).await?;
    if o.code != 0 {
        return Err(fail(&o, "branch 목록"));
    }
    let list: Vec<Value> = String::from_utf8_lossy(&o.stdout)
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\u{1f}').collect();
            (f.len() == 3).then(|| json!({ "name": f[0], "current": f[1] == "*", "head": f[2] }))
        })
        .collect();
    Ok(Json(json!({ "branches": list })))
}

/// 변경 작업 공통: 저장소 잠금 → fingerprint 대조 → 실행 → 이벤트 기록(idempotent).
async fn mutate(
    app: App,
    p: Principal,
    headers: HeaderMap,
    project_id: String,
    route: &'static str,
    body: Value,
    expected: Option<String>,
    run: impl for<'a> FnOnce(&'a std::path::Path) -> std::pin::Pin<Box<dyn std::future::Future<Output = ApiResult<Value>> + Send + 'a>> + Send,
) -> ApiResult<Response> {
    let root = root_of(&app, &project_id).await?;
    if !is_repo(&root).await? {
        return Err(ApiError::invalid("Git 저장소가 아닙니다"));
    }
    let lock = app.repo_locks.get(&project_id);
    let _g = lock.lock().await;
    let h = idem::body_hash(route, &json!({ "p": project_id, "b": body, "e": expected }));
    // 같은 키 재전송이면 실행 없이 저장된 결과를 돌려준다.
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? {
        return Ok(r);
    }
    if let Some(exp) = &expected {
        let cur = fingerprint(&root).await?;
        if &cur != exp {
            return Err(ApiError::conflict("stale_diff", "확인한 뒤 저장소 상태가 바뀌었습니다. 변경을 다시 확인하세요")
                .with_details(json!({ "fingerprint": cur })));
        }
    }
    let result = run(&root).await?;
    let fp = fingerprint(&root).await?;
    let pid = project_id.clone();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let mut r = result;
        r["fingerprint"] = json!(fp);
        events::append(tx, now, "git.changed", Some(&pid), None, &json!({ "op": route }))?;
        Ok((StatusCode::OK, r))
    })
    .await
}

#[derive(Deserialize)]
pub struct PathsBody {
    pub paths: Vec<String>,
    pub expected_fingerprint: String,
}

pub async fn stage(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<PathsBody>) -> ApiResult<Response> {
    if b.paths.is_empty() {
        return Err(ApiError::invalid("paths가 비어 있습니다"));
    }
    for x in &b.paths {
        check_path(x)?;
    }
    let paths = b.paths.clone();
    mutate(app, p, headers, id, "git.stage", json!(b.paths), Some(b.expected_fingerprint), move |root| {
        Box::pin(async move {
            let mut args = vec!["add", "--"];
            args.extend(paths.iter().map(String::as_str));
            let o = git(root, &args, false).await?;
            if o.code != 0 {
                return Err(fail(&o, "stage"));
            }
            Ok(json!({ "staged": paths }))
        })
    })
    .await
}

pub async fn unstage(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<PathsBody>) -> ApiResult<Response> {
    if b.paths.is_empty() {
        return Err(ApiError::invalid("paths가 비어 있습니다"));
    }
    for x in &b.paths {
        check_path(x)?;
    }
    let paths = b.paths.clone();
    mutate(app, p, headers, id, "git.unstage", json!(b.paths), Some(b.expected_fingerprint), move |root| {
        Box::pin(async move {
            // index만 되돌린다(작업 트리는 건드리지 않음). 커밋 없는 저장소는 rm --cached.
            let has_head = git(root, &["rev-parse", "--verify", "HEAD"], true).await?.code == 0;
            let mut args: Vec<&str> = if has_head { vec!["restore", "--staged", "--"] } else { vec!["rm", "--cached", "--quiet", "--"] };
            args.extend(paths.iter().map(String::as_str));
            let o = git(root, &args, false).await?;
            if o.code != 0 {
                return Err(fail(&o, "unstage"));
            }
            Ok(json!({ "unstaged": paths }))
        })
    })
    .await
}

#[derive(Deserialize)]
pub struct CommitBody {
    pub message: String,
    pub expected_fingerprint: String,
}

pub async fn commit(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<CommitBody>) -> ApiResult<Response> {
    let msg = b.message.trim().to_string();
    if msg.is_empty() || msg.len() > 20_000 {
        return Err(ApiError::invalid("커밋 메시지는 1~20000바이트여야 합니다"));
    }
    mutate(app, p, headers, id, "git.commit", json!(msg), Some(b.expected_fingerprint), move |root| {
        Box::pin(async move {
            let staged = git(root, &["diff", "--cached", "--quiet"], true).await?;
            if staged.code == 0 {
                return Err(ApiError::invalid("stage된 변경이 없습니다"));
            }
            // 메시지는 stdin으로 넘겨 인자 해석을 피한다. 사용자 hook은 건너뛰지 않는다.
            let mut cmd = tokio::process::Command::new("git");
            cmd.args(["-c", "core.quotepath=false", "commit", "-q", "-F", "-"])
                .current_dir(root)
                .env("GIT_TERMINAL_PROMPT", "0")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let mut child = cmd.spawn().map_err(|e| ApiError::internal(format!("git commit 실행 실패: {e}")))?;
            {
                use tokio::io::AsyncWriteExt;
                let mut stdin = child.stdin.take().expect("stdin");
                stdin.write_all(msg.as_bytes()).await.map_err(|e| ApiError::internal(e.to_string()))?;
            }
            let out = child.wait_with_output().await.map_err(|e| ApiError::internal(e.to_string()))?;
            if !out.status.success() {
                let o = GitOut { code: out.status.code().unwrap_or(-1), stdout: out.stdout, stderr: String::from_utf8_lossy(&out.stderr).to_string() };
                return Err(fail(&o, "commit"));
            }
            let head = git(root, &["rev-parse", "HEAD"], true).await?;
            Ok(json!({ "commit": String::from_utf8_lossy(&head.stdout).trim() }))
        })
    })
    .await
}

pub fn valid_branch(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("@{")
        && !name.contains("//")
        && name.chars().all(|c| !c.is_control() && !matches!(c, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
}

#[derive(Deserialize)]
pub struct BranchBody {
    pub name: String,
    /// true면 만든 뒤 전환한다. 작업 트리 변경은 git 규칙대로 유지되거나 충돌 시 거절된다.
    pub switch: Option<bool>,
}

pub async fn create_branch(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<BranchBody>) -> ApiResult<Response> {
    if !valid_branch(&b.name) {
        return Err(ApiError::invalid("브랜치 이름이 올바르지 않습니다"));
    }
    let (name, switch) = (b.name.clone(), b.switch.unwrap_or(false));
    mutate(app, p, headers, id, "git.branch", json!({ "n": b.name, "s": switch }), None, move |root| {
        Box::pin(async move {
            let args: Vec<&str> = if switch { vec!["switch", "-c", &name] } else { vec!["branch", &name] };
            let o = git(root, &args, false).await?;
            if o.code != 0 {
                return Err(fail(&o, "branch 생성"));
            }
            Ok(json!({ "branch": name, "switched": switch }))
        })
    })
    .await
}

#[derive(Deserialize)]
pub struct SwitchBody {
    pub name: String,
}

/// 브랜치 전환. 사용자 변경을 덮어쓰게 되면 git이 거절하며, 강제 옵션은 제공하지 않는다.
pub async fn switch_branch(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<SwitchBody>) -> ApiResult<Response> {
    if !valid_branch(&b.name) {
        return Err(ApiError::invalid("브랜치 이름이 올바르지 않습니다"));
    }
    let name = b.name.clone();
    mutate(app, p, headers, id, "git.switch", json!(b.name), None, move |root| {
        Box::pin(async move {
            let o = git(root, &["switch", "--no-guess", &name], false).await?;
            if o.code != 0 {
                return Err(fail(&o, "branch 전환"));
            }
            Ok(json!({ "branch": name }))
        })
    })
    .await
}

// ---------------- hunk 단위 stage(GIT-002) ----------------

/// 한 파일 diff를 머리(header)와 hunk 목록으로 나눈다.
pub fn split_hunks(diff: &str) -> (String, Vec<String>) {
    let mut header = String::new();
    let mut hunks: Vec<String> = vec![];
    for line in diff.split_inclusive('\n') {
        if line.starts_with("@@") {
            hunks.push(line.to_string());
        } else if let Some(h) = hunks.last_mut() {
            h.push_str(line);
        } else {
            header.push_str(line);
        }
    }
    (header, hunks)
}

async fn apply_cached(root: &std::path::Path, patch: &str, reverse: bool) -> ApiResult<()> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(["-c", "core.quotepath=false", "apply", "--cached", "--recount", "--whitespace=nowarn"]);
    if reverse {
        cmd.arg("--reverse");
    }
    cmd.arg("-")
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| ApiError::internal(format!("git apply 실행 실패: {e}")))?;
    {
        use tokio::io::AsyncWriteExt;
        let mut stdin = child.stdin.take().expect("stdin");
        stdin.write_all(patch.as_bytes()).await.map_err(|e| ApiError::internal(e.to_string()))?;
    }
    let out = child.wait_with_output().await.map_err(|e| ApiError::internal(e.to_string()))?;
    if !out.status.success() {
        let o = GitOut { code: out.status.code().unwrap_or(-1), stdout: out.stdout, stderr: String::from_utf8_lossy(&out.stderr).to_string() };
        return Err(fail(&o, "hunk 적용"));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct HunksQuery {
    pub path: String,
    pub staged: Option<bool>,
}

/// 파일의 hunk 목록(번호는 stage·unstage 요청에 그대로 쓴다).
pub async fn hunks(State(app): State<App>, _p: Principal, Path(id): Path<String>, Query(q): Query<HunksQuery>) -> ApiResult<Json<Value>> {
    check_path(&q.path)?;
    let root = root_of(&app, &id).await?;
    let (text, truncated) = diff_text(&root, q.staged.unwrap_or(false), Some(&q.path)).await?;
    let (_, hs) = split_hunks(&text);
    Ok(Json(json!({ "path": q.path, "hunks": hs, "truncated": truncated, "fingerprint": fingerprint(&root).await? })))
}

#[derive(Deserialize)]
pub struct HunkBody {
    pub path: String,
    pub hunks: Vec<usize>,
    pub expected_fingerprint: String,
    /// true면 stage된 hunk를 내린다.
    #[serde(default)]
    pub unstage: bool,
}

pub async fn stage_hunks(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<HunkBody>) -> ApiResult<Response> {
    check_path(&b.path)?;
    if b.hunks.is_empty() {
        return Err(ApiError::invalid("hunks가 비어 있습니다"));
    }
    let (path, sel, unstage) = (b.path.clone(), b.hunks.clone(), b.unstage);
    let route = if unstage { "git.unstage_hunks" } else { "git.stage_hunks" };
    mutate(app, p, headers, id, route, json!({ "p": b.path, "h": b.hunks }), Some(b.expected_fingerprint), move |root| {
        Box::pin(async move {
            // fingerprint가 같으므로 사용자가 본 diff와 지금 diff가 같다.
            let (text, truncated) = diff_text(root, unstage, Some(&path)).await?;
            if truncated {
                return Err(ApiError::invalid("diff가 너무 커서 hunk 단위로 처리할 수 없습니다"));
            }
            let (header, hs) = split_hunks(&text);
            if hs.is_empty() {
                return Err(ApiError::invalid("이 파일에는 hunk 단위로 고를 변경이 없습니다(새 파일·binary는 파일 단위로 처리)"));
            }
            let mut chosen = sel.clone();
            chosen.sort_unstable();
            chosen.dedup();
            if chosen.iter().any(|i| *i >= hs.len()) {
                return Err(ApiError::invalid(format!("hunk 번호는 0~{} 사이여야 합니다", hs.len() - 1)));
            }
            let mut patch = header;
            for i in &chosen {
                patch.push_str(&hs[*i]);
            }
            apply_cached(root, &patch, unstage).await?;
            Ok(json!({ "path": path, "hunks": chosen, "unstaged": unstage }))
        })
    })
    .await
}

// ---------------- 원격·merge(GIT-003) ----------------

fn valid_remote(name: &str) -> bool {
    !name.is_empty() && name.len() <= 100 && !name.starts_with('-') && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

#[derive(Deserialize)]
pub struct RemoteBody {
    pub remote: Option<String>,
    pub branch: Option<String>,
}

fn remote_args(b: &RemoteBody) -> ApiResult<(String, Option<String>)> {
    let remote = b.remote.clone().unwrap_or_else(|| "origin".into());
    if !valid_remote(&remote) {
        return Err(ApiError::invalid("remote 이름이 올바르지 않습니다"));
    }
    if let Some(br) = &b.branch
        && !valid_branch(br)
    {
        return Err(ApiError::invalid("브랜치 이름이 올바르지 않습니다"));
    }
    Ok((remote, b.branch.clone()))
}

/// fetch: 원격 참조만 갱신한다. 작업 트리·현재 브랜치는 바뀌지 않는다.
pub async fn fetch(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<RemoteBody>) -> ApiResult<Response> {
    let (remote, _) = remote_args(&b)?;
    mutate(app, p, headers, id, "git.fetch", json!({ "r": remote }), None, move |root| {
        Box::pin(async move {
            let o = git(root, &["fetch", "--prune", "--", &remote], false).await?;
            if o.code != 0 {
                return Err(fail(&o, "fetch"));
            }
            Ok(json!({ "fetched": remote }))
        })
    })
    .await
}

/// pull: fast-forward만 허용한다. 갈라졌으면 거절하고 merge·rebase는 사용자가 고른다.
pub async fn pull(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<RemoteBody>) -> ApiResult<Response> {
    let (remote, branch) = remote_args(&b)?;
    mutate(app, p, headers, id, "git.pull", json!({ "r": remote, "b": branch }), None, move |root| {
        Box::pin(async move {
            let before = git(root, &["rev-parse", "HEAD"], true).await?;
            // 브랜치를 안 주면 upstream의 원격 브랜치, upstream이 없으면 같은 이름의 원격 브랜치를 쓴다.
            let branch = match branch {
                Some(b) => b,
                None => {
                    let up = git(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], true).await?;
                    let up = String::from_utf8_lossy(&up.stdout).trim().to_string();
                    match up.strip_prefix(&format!("{remote}/")) {
                        Some(b) if !b.is_empty() => b.to_string(),
                        _ => {
                            let cur = git(root, &["branch", "--show-current"], true).await?;
                            let cur = String::from_utf8_lossy(&cur.stdout).trim().to_string();
                            if cur.is_empty() {
                                return Err(ApiError::invalid("현재 브랜치가 없습니다(detached HEAD). 가져올 브랜치를 지정하세요"));
                            }
                            cur
                        }
                    }
                }
            };
            let args = vec!["pull", "--ff-only", "--no-rebase", "--", remote.as_str(), branch.as_str()];
            let o = git(root, &args, false).await?;
            if o.code != 0 {
                return Err(fail(&o, "pull(fast-forward만 허용)"));
            }
            let after = git(root, &["rev-parse", "HEAD"], true).await?;
            Ok(json!({ "from": String::from_utf8_lossy(&before.stdout).trim(), "to": String::from_utf8_lossy(&after.stdout).trim() }))
        })
    })
    .await
}

/// push: force 옵션은 없다. 원격이 앞서 있으면 git이 거절한다.
pub async fn push(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<RemoteBody>) -> ApiResult<Response> {
    let (remote, branch) = remote_args(&b)?;
    mutate(app, p, headers, id, "git.push", json!({ "r": remote, "b": branch }), None, move |root| {
        Box::pin(async move {
            let cur = git(root, &["branch", "--show-current"], true).await?;
            let br = branch.unwrap_or_else(|| String::from_utf8_lossy(&cur.stdout).trim().to_string());
            if br.is_empty() {
                return Err(ApiError::invalid("현재 브랜치가 없습니다(detached HEAD)"));
            }
            let spec = format!("refs/heads/{br}:refs/heads/{br}");
            let o = git(root, &["push", "--porcelain", "--", &remote, &spec], false).await?;
            if o.code != 0 {
                return Err(fail(&o, "push"));
            }
            Ok(json!({ "pushed": br, "remote": remote }))
        })
    })
    .await
}

#[derive(Deserialize)]
pub struct MergeBody {
    pub branch: String,
    /// true면 fast-forward가 가능해도 merge commit을 만든다.
    #[serde(default)]
    pub no_ff: bool,
    pub expected_fingerprint: String,
}

/// merge: 충돌이 나면 즉시 abort해 저장소를 원래 상태로 돌려놓고 충돌 파일 목록을 알린다.
pub async fn merge(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<MergeBody>) -> ApiResult<Response> {
    if !valid_branch(&b.branch) {
        return Err(ApiError::invalid("브랜치 이름이 올바르지 않습니다"));
    }
    let (branch, no_ff) = (b.branch.clone(), b.no_ff);
    mutate(app, p, headers, id, "git.merge", json!({ "b": b.branch, "n": no_ff }), Some(b.expected_fingerprint), move |root| {
        Box::pin(async move { merge_into(root, &branch, no_ff).await })
    })
    .await
}

/// 현재 브랜치에 `branch`를 merge한다. 호출자가 저장소 잠금을 잡고 있어야 한다.
/// 커밋하지 않은 변경이 있으면 거부하고, 충돌이면 즉시 abort해 merge 전 상태로 돌려놓는다.
pub(crate) async fn merge_into(root: &std::path::Path, branch: &str, no_ff: bool) -> ApiResult<Value> {
    let dirty = git(root, &["status", "--porcelain", "--untracked-files=no"], true).await?;
    if !dirty.stdout.is_empty() {
        return Err(ApiError::conflict("dirty_tree", "커밋하지 않은 변경이 있어 merge하지 않습니다. 먼저 커밋하세요"));
    }
    let mut args = vec!["merge", "--no-edit"];
    if no_ff {
        args.push("--no-ff");
    }
    args.extend(["--", branch]);
    let o = git(root, &args, false).await?;
    if o.code != 0 {
        let conflicts = git(root, &["diff", "--name-only", "--diff-filter=U"], true).await?;
        let files: Vec<String> = String::from_utf8_lossy(&conflicts.stdout).lines().map(str::to_string).collect();
        let _ = git(root, &["merge", "--abort"], false).await;
        return Err(ApiError::conflict("merge_conflict", "merge 충돌이 있어 되돌렸습니다. 저장소는 merge 전 상태입니다")
            .with_details(json!({ "conflicts": files, "stderr": o.stderr })));
    }
    let head = git(root, &["rev-parse", "HEAD"], true).await?;
    Ok(json!({ "merged": branch, "head": String::from_utf8_lossy(&head.stdout).trim() }))
}

// ---------------- branch 이름 변경(GIT-004) ----------------

#[derive(Deserialize)]
pub struct RenameBody {
    pub from: String,
    pub to: String,
}

/// 덮어쓰기(-M)는 하지 않는다. 대상 이름이 있으면 git이 거절한다.
pub async fn rename_branch(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<RenameBody>) -> ApiResult<Response> {
    if !valid_branch(&b.from) || !valid_branch(&b.to) {
        return Err(ApiError::invalid("브랜치 이름이 올바르지 않습니다"));
    }
    let (from, to) = (b.from.clone(), b.to.clone());
    mutate(app, p, headers, id, "git.rename_branch", json!({ "f": b.from, "t": b.to }), None, move |root| {
        Box::pin(async move {
            let o = git(root, &["branch", "-m", "--", &from, &to], false).await?;
            if o.code != 0 {
                return Err(fail(&o, "branch 이름 변경"));
            }
            Ok(json!({ "from": from, "to": to }))
        })
    })
    .await
}

// ---------------- commit 상세·base 비교(GIT-015) ----------------

fn valid_rev(s: &str) -> bool {
    (4..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit())
}

pub async fn show_commit(State(app): State<App>, _p: Principal, Path((id, rev)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    if !valid_rev(&rev) {
        return Err(ApiError::invalid("commit hash가 올바르지 않습니다"));
    }
    let root = root_of(&app, &id).await?;
    let meta = git(&root, &["show", "-s", "--format=%H%x1f%an%x1f%aI%x1f%B", &rev, "--"], true).await?;
    if meta.code != 0 {
        return Err(ApiError::not_found("commit이 없습니다"));
    }
    let m = String::from_utf8_lossy(&meta.stdout).to_string();
    let f: Vec<&str> = m.splitn(4, '\u{1f}').collect();
    let files = git(&root, &["show", "--format=", "--name-status", "-z", "--find-renames", &rev, "--"], true).await?;
    let parts: Vec<String> = files.stdout.split(|b| *b == 0).map(|p| String::from_utf8_lossy(p).to_string()).filter(|s| !s.is_empty()).collect();
    let mut list = vec![];
    let mut i = 0;
    while i < parts.len() {
        let st = parts[i].clone();
        if st.starts_with('R') || st.starts_with('C') {
            list.push(json!({ "status": st, "from": parts.get(i + 1), "path": parts.get(i + 2) }));
            i += 3;
        } else {
            list.push(json!({ "status": st, "path": parts.get(i + 1) }));
            i += 2;
        }
    }
    let patch = git(&root, &["show", "--format=", "--patch", "--no-ext-diff", "--find-renames", &rev, "--"], true).await?;
    let truncated = patch.stdout.len() > MAX_DIFF;
    Ok(Json(json!({
        "hash": f.first(), "author": f.get(1), "date": f.get(2), "message": f.get(3).map(|s| s.trim()),
        "files": list, "diff": String::from_utf8_lossy(&patch.stdout[..patch.stdout.len().min(MAX_DIFF)]), "truncated": truncated,
    })))
}

#[derive(Deserialize)]
pub struct CompareQuery {
    pub base: String,
}

/// base 브랜치와 비교: merge-base 이후 현재 HEAD의 변경(`base...HEAD`).
pub async fn compare(State(app): State<App>, _p: Principal, Path(id): Path<String>, Query(q): Query<CompareQuery>) -> ApiResult<Json<Value>> {
    if !valid_branch(&q.base) {
        return Err(ApiError::invalid("base 브랜치 이름이 올바르지 않습니다"));
    }
    let root = root_of(&app, &id).await?;
    let range = format!("{}...HEAD", q.base);
    let o = git(&root, &["diff", "--no-ext-diff", "--find-renames", &range, "--"], true).await?;
    if o.code != 0 {
        return Err(fail(&o, "비교"));
    }
    let log = git(&root, &["log", "--format=%H%x1f%s", &format!("{}..HEAD", q.base), "--"], true).await?;
    let commits: Vec<Value> = String::from_utf8_lossy(&log.stdout)
        .lines()
        .filter_map(|l| l.split_once('\u{1f}').map(|(h, s)| json!({ "hash": h, "subject": s })))
        .collect();
    Ok(Json(json!({ "base": q.base, "commits": commits, "diff": String::from_utf8_lossy(&o.stdout[..o.stdout.len().min(MAX_DIFF)]), "truncated": o.stdout.len() > MAX_DIFF })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hunk_split_keeps_header_and_bodies() {
        let d = "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -10,1 +10,1 @@\n-z\n+Z\n";
        let (h, hs) = split_hunks(d);
        assert!(h.ends_with("+++ b/f\n"));
        assert_eq!(hs.len(), 2);
        assert!(hs[1].starts_with("@@ -10") && hs[1].ends_with("+Z\n"));
    }

    #[test]
    fn branch_names() {
        for ok in ["main", "feat/x", "a-b_c.1"] {
            assert!(valid_branch(ok), "{ok}");
        }
        for bad in ["", "-x", "a..b", "a b", "x.lock", "a~1", "a:b", "/a", "a/", "a@{1}", "a//b"] {
            assert!(!valid_branch(bad), "{bad}");
        }
    }

    #[test]
    fn porcelain_v2() {
        let raw = b"# branch.oid abc\0# branch.head main\0# branch.ab +1 -2\01 .M N... 100644 100644 100644 a a f.txt\02 R. N... 100644 100644 100644 a a R100 new.txt\0old.txt\0? u.txt\0";
        let v = parse_status(raw);
        assert_eq!(v["branch"]["head"], "main");
        assert_eq!(v["branch"]["ahead"], 1);
        assert_eq!(v["branch"]["behind"], 2);
        let e = v["entries"].as_array().unwrap();
        assert_eq!(e[0]["path"], "f.txt");
        assert_eq!(e[0]["worktree"], "M");
        assert_eq!(e[1]["orig_path"], "old.txt");
        assert_eq!(e[2]["kind"], "untracked");
    }
}
