//! 백그라운드 셸 작업(EXEC-003~013).
//!
//! - 출력은 stream별 파일에 상한(`MAX_LOG`)까지 기록하고 전체 바이트 수를 센다. 메모리에는 쌓지 않는다.
//! - hard timeout(프로세스 종료)과 hold(호출자가 기다리는 시간)는 별개다.
//! - 결과 기록: `detached`인 작업이 끝나면 같은 transaction에서 상태 전이와 함께 세션에 note를 한 번만 남긴다.
//!   hold 중에 끝난 작업은 호출자(도구 결과)가 직접 결과를 받으므로 note를 남기지 않는다.
//! - 재시작으로 확인할 수 없게 된 작업은 `unknown`으로 표시한다. 프로세스 트리 소유·정리는 `procs`가 맡는다
//!   (Linux: 작업 ID 표식으로 잔여 프로세스 종료, Windows: Job Object가 서버와 함께 트리 종료).

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::idem;
use crate::tools::fs::{rel_display, resolve};
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::watch;

/// stream별 로그 파일 상한.
pub const MAX_LOG: u64 = 8 * 1024 * 1024;
/// 결과 note·도구 결과에 넣는 꼬리 크기.
const TAIL: u64 = 4 * 1024;
/// 세션당 동시 실행 상한.
const MAX_RUNNING_PER_SESSION: i64 = 8;

#[derive(Debug, Clone, Serialize)]
pub struct Task {
    pub id: String,
    pub session_id: String,
    pub project_id: String,
    pub call_id: Option<String>,
    pub command: String,
    pub cwd: String,
    pub timeout_ms: i64,
    pub status: String,
    pub detached: bool,
    pub pid: Option<i64>,
    pub exit_code: Option<i64>,
    pub signal: Option<i64>,
    pub stdout_bytes: i64,
    pub stderr_bytes: i64,
    pub reason: Option<String>,
    pub result_message_id: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub script: Option<crate::project_scripts::Snapshot>,
}

const COLS: &str = "id, session_id, project_id, call_id, command, cwd, timeout_ms, status, detached, pid, exit_code, signal, \
                    stdout_bytes, stderr_bytes, reason, result_message_id, started_at, ended_at, script_snapshot";

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        session_id: r.get(1)?,
        project_id: r.get(2)?,
        call_id: r.get(3)?,
        command: r.get(4)?,
        cwd: r.get(5)?,
        timeout_ms: r.get(6)?,
        status: r.get(7)?,
        detached: r.get::<_, i64>(8)? != 0,
        pid: r.get(9)?,
        exit_code: r.get(10)?,
        signal: r.get(11)?,
        stdout_bytes: r.get(12)?,
        stderr_bytes: r.get(13)?,
        reason: r.get(14)?,
        result_message_id: r.get(15)?,
        started_at: r.get(16)?,
        ended_at: r.get(17)?,
        script: r.get::<_, Option<String>>(18)?.map(|raw| serde_json::from_str(&raw)
            .map_err(|error| rusqlite::Error::FromSqlConversionFailure(18,rusqlite::types::Type::Text,Box::new(error)))).transpose()?,
    })
}

pub fn get(c: &Connection, id: &str) -> ApiResult<Task> {
    c.query_row(&format!("SELECT {COLS} FROM tasks WHERE id = ?1"), params![id], from_row)
        .optional()?
        .ok_or_else(|| ApiError::not_found("작업이 없습니다"))
}

pub fn running_in_session(c: &Connection, session_id: &str) -> ApiResult<i64> {
    Ok(c.query_row("SELECT COUNT(*) FROM tasks WHERE session_id = ?1 AND status = 'running'", params![session_id], |r| r.get(0))?)
}

/// 실행 중 작업의 메모리 핸들. 취소 신호와 완료 알림.
#[derive(Default)]
pub struct Tasks {
    pub(crate) admission: crate::project_resources::ProjectQueues,
    running: Mutex<HashMap<String, (watch::Sender<bool>, watch::Receiver<bool>)>>,
}

impl Tasks {
    fn insert(&self, id: &str) -> (watch::Receiver<bool>, watch::Sender<bool>) {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (done_tx, done_rx) = watch::channel(false);
        self.running.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), (cancel_tx, done_rx));
        (cancel_rx, done_tx)
    }
    fn remove(&self, id: &str) {
        self.running.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }
    pub fn cancel(&self, id: &str) -> bool {
        match self.running.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
            Some((c, _)) => {
                c.send_replace(true);
                true
            }
            None => false,
        }
    }
    pub fn done_rx(&self, id: &str) -> Option<watch::Receiver<bool>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner()).get(id).map(|(_, d)| d.clone())
    }
    fn all_ids(&self) -> Vec<String> {
        self.running.lock().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect()
    }
}

fn log_path(app: &App, id: &str, stream: &str) -> PathBuf {
    crate::task_logs::path(&app.cfg.data_dir, id, stream)
}

/// 파일 꼬리(lossy UTF-8).
fn tail(path: &std::path::Path, n: u64) -> String {
    let Ok(mut f) = crate::task_logs::open_read(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(n);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = vec![];
    let _ = f.take(n).read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).to_string()
}

#[derive(Clone)]
pub struct Spawn {
    pub session_id: String,
    pub call_id: Option<String>,
    /// `exec.shell` 선택값(EXEC-001). 승인된 도구 호출은 계획 때 고정한 값을 쓴다.
    pub shell: String,
    /// 자원 한도(SEC-017). 승인된 도구 호출은 계획 때 고정한 값을 쓴다.
    pub limits: crate::procs::Limits,
    pub inherit_credentials: bool,
    pub command: String,
    pub cwd_rel: String,
    pub timeout_ms: u64,
    pub detached: bool,
    pub script: Option<crate::project_scripts::Snapshot>,
    /// 프로젝트의 초기 설정 script 실행(PROJECT-010). 작업 접수와 같은 transaction에서 실행 위치별 기록을 남긴다.
    pub setup: bool,
}

/// 작업을 기록하고 프로세스를 시작한다. 반환 시점에 row는 commit되어 있다.
pub async fn spawn(app: &App, s: Spawn) -> ApiResult<Task> {
    let (_sender, mut cancel) = watch::channel(false);
    spawn_with_cancel(app,s,&mut cancel).await
}

async fn spawn_with_cancel(app: &App, s: Spawn, cancel: &mut watch::Receiver<bool>) -> ApiResult<Task> {
    let sid = s.session_id.clone();
    let project = app.db.call(move |c| Ok(crate::sessions::get_active(c,&sid)?.project_id)).await?;
    let resource = app.project_resources.tool(app,&project,crate::tools::Effect::Execute,cancel).await
        .map_err(|e|ApiError::conflict(e.code,e.message))?;
    if let Some(call)=s.call_id.clone() { app.db.call(move |c|crate::approvals::check_running_execution(c,&call)).await?; }
    let id = crate::util::new_id();
    let now = app.now();
    let (plan, id2) = (s.clone(), id.clone());
    let root = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let root = record_start(&tx, &id2, &plan, &now, None)?;
            tx.commit()?;
            Ok(root)
        })
        .await?;
    launch(app,s,id,root,resource,Some(cancel.clone())).await
}

/// 도구 실행과 직접 사용자 요청이 같은 작업/로그/이벤트 접수 경계를 쓴다.
fn record_start(c: &Connection, id: &str, s: &Spawn, now: &str, expected_root: Option<&std::path::Path>) -> ApiResult<PathBuf> {
    let sess=crate::sessions::get_active(c,&s.session_id)?;
    if running_in_session(c,&s.session_id)? >= MAX_RUNNING_PER_SESSION {
        return Err(ApiError::busy(format!("세션당 백그라운드 작업은 {MAX_RUNNING_PER_SESSION}개까지 실행할 수 있습니다")));
    }
    let root=crate::sessions::exec_root(c,&s.session_id)?;
    if expected_root.is_some_and(|expected| expected != root) {
        return Err(ApiError::conflict("project_changed", "프로젝트 경로가 바뀌었습니다. 다시 확인한 뒤 실행하세요"));
    }
    if let Some(script) = &s.script {
        let setting = crate::settings::effective(c, "exec.shell", Some(&sess.project_id), Some(&s.session_id))?;
        let shell = crate::tools::shell::resolve_shell(setting.as_str().unwrap_or("default"));
        if shell != s.shell {
            return Err(ApiError::conflict("script_changed", "실행 셸이 바뀌었습니다. 프로젝트·셸·명령을 다시 확인하세요"));
        }
        crate::project_scripts::prepare(c,&sess.project_id,&crate::project_scripts::Intent {
            id:script.id.clone(),expected_revision:script.revision,expected_execution:script.execution.clone(),
        },&s.command,&root,&s.shell)?;
    }
    c.execute(
        "INSERT INTO tasks (id,session_id,project_id,call_id,command,cwd,timeout_ms,status,detached,started_at,script_snapshot) VALUES (?1,?2,?3,?4,?5,?6,?7,'running',?8,?9,?10)",
        params![id,s.session_id,sess.project_id,s.call_id,s.command,s.cwd_rel,s.timeout_ms as i64,s.detached as i64,now,s.script.as_ref().map(serde_json::to_string).transpose()?],
    )?;
    if s.setup {
        let script = s.script.as_ref().ok_or_else(|| ApiError::invalid("초기 설정 실행은 프로젝트 script로만 할 수 있습니다"))?;
        let chosen: Option<String> = c.query_row("SELECT setup_script_id FROM projects WHERE id = ?1", [&sess.project_id], |r| r.get(0))?;
        if chosen.as_deref() != Some(script.id.as_str()) {
            return Err(ApiError::conflict("setup_script_changed", "초기 설정 script 지정이 바뀌었습니다. 다시 확인하세요"));
        }
        c.execute(
            "INSERT INTO setup_runs (task_id, project_id, worktree_id, script_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, sess.project_id, sess.worktree_id, script.id, now],
        )?;
    }
    crate::task_logs::begin(c,id,now)?;
    let t=get(c,id)?;
    events::append(c,now,"task.changed",Some(&t.project_id),Some(&t.session_id),&serde_json::to_value(&t)?)?;
    Ok(root)
}

async fn launch(app: &App, s: Spawn, id: String, root: PathBuf, _resource: Option<crate::project_resources::Lease>, initial_cancel: Option<watch::Receiver<bool>>) -> ApiResult<Task> {
    let (data, log_id) = (app.cfg.data_dir.clone(), id.clone());
    let files = match tokio::task::spawn_blocking(move || crate::task_logs::create(&data, &log_id)).await {
        Ok(Ok(f)) => f,
        _ => {
            finalize(
                app, &id, End::SpawnFailed("작업 로그 파일을 만들 수 없어 실행하지 않았습니다".into()),
                [crate::task_logs::Report::failed("log_create_failed"), crate::task_logs::Report::failed("log_create_failed")],
            ).await?;
            let i = id.clone();
            return app.db.call(move |c| get(c, &i)).await;
        }
    };
    if app.is_shutting_down() || initial_cancel.as_ref().is_some_and(|cancel| *cancel.borrow()) {
        drop(files);
        finalize(app,&id,End::Cancelled(if app.is_shutting_down() {"server_shutdown before spawn"} else {"turn cancelled before spawn"}),[crate::task_logs::Report::empty(),crate::task_logs::Report::empty()]).await?;
        return app.db.call(move |c| get(c,&id)).await;
    }
    let started = match resolve(&root, &s.cwd_rel) {
        // 작업 ID가 실행 표식이다: 재시작 때 잔여 프로세스를 PID 재사용과 무관하게 찾는다(EXEC-010).
        Ok(cwd) if cwd.is_dir() => crate::tools::shell::command(&s.shell, &s.command, &cwd, &id, s.limits, s.inherit_credentials)
            .spawn()
            .map_err(|e| crate::tools::shell::spawn_message(&s.shell, &e).1)
            .and_then(|mut c| crate::procs::adopt(&mut c, &id, s.limits).map(|o| (c, o))),
        Ok(_) => Err("cwd 디렉터리가 없습니다".into()),
        Err(e) => Err(e.message),
    };
    let (mut child, owned) = match started {
        Ok(c) => c,
        Err(msg) => {
            drop(files);
            finalize(app, &id, End::SpawnFailed(msg), [crate::task_logs::Report::empty(), crate::task_logs::Report::empty()]).await?;
            let i = id.clone();
            return app.db.call(move |c| get(c, &i)).await;
        }
    };
    {
        let (i, pid) = (id.clone(), owned.pid());
        let _ = app.db.call(move |c| Ok(c.execute("UPDATE tasks SET pid = ?2 WHERE id = ?1", params![i, pid as i64])?)).await;
    }
    let (mut cancel_rx, done_tx) = app.tasks.insert(&id);
    let [out, err] = files;
    let out_h = tokio::spawn(crate::task_logs::pump(child.stdout.take().expect("stdout"), out));
    let err_h = tokio::spawn(crate::task_logs::pump(child.stderr.take().expect("stderr"), err));
    let app2 = app.clone();
    let id2 = id.clone();
    let mut shutdown = app.shutdown_rx.clone();
    tokio::spawn(async move {
        let end = tokio::select! {
            r = child.wait() => match r { Ok(st) => End::Exit(st), Err(e) => End::WaitErr(e.to_string()) },
            _ = tokio::time::sleep(Duration::from_millis(s.timeout_ms)) => End::Timeout,
            _ = cancel_rx.wait_for(|c| *c) => End::Cancelled("user"),
            _ = shutdown.wait_for(|v| *v) => End::Cancelled("server_shutdown"),
        };
        // 셸이 끝났어도 같은 트리에 남은 자식까지 정리한다.
        let exited = matches!(end, End::Exit(_));
        owned.kill_tree(!exited);
        if !exited {
            let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
        }
        drop(owned);
        let o = crate::task_logs::join(out_h).await;
        let e = crate::task_logs::join(err_h).await;
        if let Err(e) = finalize(&app2, &id2, end, [o, e]).await {
            tracing::error!(code = e.code, "작업 종료 기록 저장 실패");
        }
        app2.tasks.remove(&id2);
        done_tx.send_replace(true);
    });
    let i = id.clone();
    app.notify_events().await;
    app.db.call(move |c| get(c, &i)).await
}

enum End {
    Exit(std::process::ExitStatus),
    Timeout,
    Cancelled(&'static str),
    WaitErr(String),
    SpawnFailed(String),
}

/// 상태 전이 + (분리된 작업이면) 결과 note. running이 아니면 아무것도 하지 않아 중복 기록이 없다(EXEC-012).
async fn finalize(app: &App, id: &str, end: End, logs: [crate::task_logs::Report; 2]) -> ApiResult<()> {
    let (status, code, sig, reason): (&str, Option<i64>, Option<i64>, Option<String>) = match &end {
        End::Exit(st) => {
            #[cfg(unix)]
            let sig = {
                use std::os::unix::process::ExitStatusExt;
                st.signal().map(i64::from)
            };
            #[cfg(not(unix))]
            let sig: Option<i64> = None;
            let code = st.code().map(i64::from);
            (if code == Some(0) { "completed" } else { "failed" }, code, sig, None)
        }
        End::Timeout => ("timeout", None, None, Some("hard timeout으로 종료했습니다".into())),
        End::Cancelled(r) => ("cancelled", None, None, Some((*r).into())),
        End::WaitErr(e) => ("failed", None, None, Some(e.clone())),
        End::SpawnFailed(e) => ("failed", None, None, Some(e.clone())),
    };
    let paths = (log_path(app, id, "out"), log_path(app, id, "err"));
    let id = id.to_string();
    let now = app.now();
    let status = status.to_string();
    app.db
        .call(move |c| {
            let tails = (tail(&paths.0, TAIL), tail(&paths.1, TAIL));
            let tx = c.transaction()?;
            let n = tx.execute(
                "UPDATE tasks SET status = ?2, exit_code = ?3, signal = ?4, reason = ?5, stdout_bytes = ?6, stderr_bytes = ?7, ended_at = ?8 \
                 WHERE id = ?1 AND status = 'running'",
                params![id, status, code, sig, reason, logs[0].total.min(i64::MAX as u64) as i64, logs[1].total.min(i64::MAX as u64) as i64, now],
            )?;
            if n == 0 {
                return Ok(());
            }
            crate::task_logs::finish(&tx, &id, &logs, &now)?;
            let t = get(&tx, &id)?;
            record_note(&tx, &now, &t, &tails.0, &tails.1)?;
            let t = get(&tx, &id)?;
            events::append(&tx, &now, "task.changed", Some(&t.project_id), Some(&t.session_id), &serde_json::to_value(&t)?)?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    app.notify_events().await;
    Ok(())
}

fn record_note(tx: &Connection, now: &str, t: &Task, out: &str, err: &str) -> ApiResult<()> {
    if !t.detached || t.result_message_id.is_some() {
        return Ok(());
    }
    let log_errors: Vec<Value> = crate::task_logs::describe(tx, &t.id)?.into_iter()
        .filter(|l| l["state"] == "error").map(|l| json!({"stream":l["stream"],"code":l["error"]})).collect();
    let content = json!({
        "type": "task_result",
        "task_id": t.id, "command": t.command, "cwd": t.cwd,
        "status": t.status, "exit_code": t.exit_code, "signal": t.signal, "reason": t.reason,
        "stdout_tail": out, "stderr_tail": err,
        "stdout_bytes": t.stdout_bytes, "stderr_bytes": t.stderr_bytes,
        "truncated": t.stdout_bytes as u64 > TAIL || t.stderr_bytes as u64 > TAIL,
        "log_errors":log_errors,
        "script":t.script,
    });
    let m = crate::sessions::append_message(tx, now, &t.session_id, "note", &content, None, None)?;
    tx.execute("UPDATE tasks SET result_message_id = ?2 WHERE id = ?1", params![t.id, m.id])?;
    Ok(())
}

/// note를 모델·사람이 읽을 텍스트로.
pub fn note_text(c: &Value) -> String {
    let mut s = format!(
        "task {} `{}` (cwd {}): {}",
        c["task_id"].as_str().unwrap_or(""),
        c["command"].as_str().unwrap_or(""),
        c["cwd"].as_str().unwrap_or("."),
        c["status"].as_str().unwrap_or("")
    );
    if let Some(code) = c["exit_code"].as_i64() {
        s.push_str(&format!(", exit code {code}"));
    }
    if let Some(name) = c["script"]["name"].as_str() {
        s.push_str(&format!("\nproject script: {name} (revision {})", c["script"]["revision"]));
    }
    if let Some(r) = c["reason"].as_str() {
        s.push_str(&format!(" ({r})"));
    }
    for (k, label) in [("stdout_tail", "stdout"), ("stderr_tail", "stderr")] {
        let t = c[k].as_str().unwrap_or("");
        if !t.is_empty() {
            s.push_str(&format!("\n[{label} tail]\n{t}"));
        }
    }
    if c["truncated"].as_bool() == Some(true) {
        s.push_str("\n(출력 일부만 표시. 전체는 작업 출력에서 확인)");
    }
    if c["log_errors"].as_array().is_some_and(|v| !v.is_empty()) {
        s.push_str("\n로그 저장에 실패했습니다. 출력이 누락됐을 수 있습니다.");
    }
    s
}

/// 결과 요약(도구 결과·API 응답용).
pub async fn summary(app: &App, t: &Task) -> ApiResult<Value> {
    let paths = (log_path(app, &t.id, "out"), log_path(app, &t.id, "err"));
    let t = t.clone();
    app.db.call(move |c| {
        let mut v = serde_json::to_value(&t)?;
        v["stdout_tail"] = json!(tail(&paths.0, TAIL));
        v["stderr_tail"] = json!(tail(&paths.1, TAIL));
        v["logs"] = json!(crate::task_logs::describe(c, &t.id)?);
        Ok(v)
    }).await
}

/// 도구 호출 경로: hold 동안 기다리고, 안 끝나면 분리(detach)한다. 분리와 완료는 DB에서 원자적으로 경합한다.
pub async fn run_with_hold(app: &App, s: Spawn, hold_ms: u64, mut cancel: watch::Receiver<bool>) -> Result<Value, crate::tools::ToolError> {
    use crate::tools::ToolError;
    let t = spawn_with_cancel(app, s, &mut cancel).await.map_err(|e| ToolError::new(e.code, e.message))?;
    if let Some(mut done) = app.tasks.done_rx(&t.id) {
        let cancelled = tokio::select! {
            _ = async { let _ = done.wait_for(|d| *d).await; } => false,
            _ = tokio::time::sleep(Duration::from_millis(hold_ms)) => false,
            // hold 중 턴 취소는 작업 취소로 이어진다.
            _ = async { let _ = cancel.wait_for(|c| *c).await; } => true,
        };
        if cancelled {
            app.tasks.cancel(&t.id);
            let _ = done.wait_for(|d| *d).await.map(|_| ());
        }
    }
    let id = t.id.clone();
    let detached = app
        .db
        .call(move |c| Ok(c.execute("UPDATE tasks SET detached = 1 WHERE id = ?1 AND status = 'running'", params![id])? == 1))
        .await
        .map_err(|e| ToolError::new("internal", e.message))?;
    let id = t.id.clone();
    let t = app.db.call(move |c| get(c, &id)).await.map_err(|e| ToolError::new("internal", e.message))?;
    let v = summary(app, &t).await.map_err(|e| ToolError::new(e.code, e.message))?;
    if detached {
        return Ok(json!({ "task_id": t.id, "status": "running", "background": true,
            "note": "hold 시간 안에 끝나지 않아 백그라운드로 전환했습니다. 끝나면 결과가 대화에 기록됩니다.",
            "stdout_tail": v["stdout_tail"], "stderr_tail": v["stderr_tail"] }));
    }
    match t.status.as_str() {
        "completed" | "failed" => Ok(v),
        "cancelled" => Err(ToolError::new("cancelled", "사용자 취소로 종료했습니다. 부분 실행됐을 수 있습니다").with_output(v)),
        "timeout" => Err(ToolError::new("timeout", "hard timeout으로 종료했습니다. 부분 실행됐을 수 있습니다").with_output(v)),
        _ => Err(ToolError::new("failed", t.reason.clone().unwrap_or_default()).with_output(v)),
    }
}

/// 작업 프로세스와 그 자손이 물려받는 작업 ID 환경변수(실행 표식).
pub const TASK_ENV: &str = crate::procs::OWNER_ENV;

/// 시작 시: 이전 프로세스에서 실행 중이던 작업은 결과를 확인할 수 없다(EXEC-013).
/// 남은 프로세스는 표식으로 찾아 종료하되, 부작용 여부는 알 수 없으므로 상태는 unknown이다(EXEC-010).
pub fn recover_on_start(c: &mut Connection, now: &str) -> ApiResult<usize> {
    let tx = c.transaction()?;
    let ids: Vec<String> = {
        let mut st = tx.prepare("SELECT id FROM tasks WHERE status = 'running'")?;
        st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?
    };
    let killed = crate::procs::reap_leftovers(&ids);
    for id in &ids {
        let reason = if crate::procs::REAPS_LEFTOVERS {
            match killed.get(id) {
                Some(n) => format!("서버가 재시작되어 결과를 확인할 수 없습니다. 남아 있던 프로세스 {n}개를 종료했습니다"),
                None => "서버가 재시작되어 결과를 확인할 수 없습니다. 남은 프로세스는 없습니다".to_string(),
            }
        } else {
            "서버가 재시작되어 결과를 확인할 수 없습니다. 프로세스가 남아 있을 수 있습니다".to_string()
        };
        tx.execute("UPDATE tasks SET status = 'unknown', ended_at = ?2, reason = ?3 WHERE id = ?1", params![id, now, reason])?;
        // 분리되지 않은 작업(도구 호출이 기다리던 중)도 결과가 어디에도 없으므로 note를 남긴다.
        tx.execute("UPDATE tasks SET detached = 1 WHERE id = ?1", params![id])?;
        let t = get(&tx, id)?;
        record_note(&tx, now, &t, "", "")?;
        events::append(&tx, now, "task.changed", Some(&t.project_id), Some(&t.session_id), &serde_json::to_value(&t)?)?;
    }
    tx.commit()?;
    Ok(ids.len())
}

/// 종료 시: 실행 중 작업에 취소를 보내고 잠시 정리를 기다린다(EXEC-010).
pub async fn stop_all(app: &App) {
    let ids = app.tasks.all_ids();
    let waits: Vec<_> = ids.iter().filter_map(|id| app.tasks.done_rx(id)).collect();
    for id in &ids {
        app.tasks.cancel(id);
    }
    for mut d in waits {
        let _ = tokio::time::timeout(Duration::from_secs(8), d.wait_for(|v| *v)).await;
    }
}

// ---------------- API ----------------

#[derive(Deserialize)]
pub struct StartBody {
    pub command: String,
    pub cwd: Option<String>,
    pub timeout_ms: Option<u64>,
    pub script: Option<crate::project_scripts::Intent>,
    #[serde(default)]
    pub setup: bool,
}

/// 사용자가 직접 시작하는 백그라운드 작업. 소유자가 명시적으로 실행하므로 승인 단계가 없다.
pub async fn start(State(app): State<App>, p: Principal, headers: HeaderMap, Path(session_id): Path<String>, Json(b): Json<StartBody>) -> ApiResult<Response> {
    if b.command.trim().is_empty() || b.command.len() > 64 * 1024 {
        return Err(ApiError::invalid("command가 비어 있거나 너무 깁니다"));
    }
    let timeout = b.timeout_ms.unwrap_or(crate::tools::shell::MAX_BACKGROUND_TIMEOUT_MS).clamp(100, crate::tools::shell::MAX_BACKGROUND_TIMEOUT_MS);
    // 같은 Idempotency-Key 재전송이 프로세스를 두 번 띄우지 않게, 기록된 응답이 있으면 그대로 돌려준다.
    let mut hash_body = json!({ "s": session_id, "c": b.command, "w": b.cwd, "t": timeout });
    if let Some(script) = &b.script { hash_body["script"] = json!(script); }
    if b.setup { hash_body["setup"] = json!(true); }
    let h = idem::body_hash("task.start", &hash_body);
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? {
        return Ok(r);
    }
    let sid = session_id.clone();
    let (intent,command,explicit_cwd)=(b.script.clone(),b.command.clone(),b.cwd.clone());
    let (root, cwd_rel, shell, limits, project, script) = app
        .db
        .call(move |c| {
            let s = crate::sessions::get_active(c, &sid)?;
            let shell = crate::settings::effective(c, "exec.shell", Some(&s.project_id), Some(&sid))?;
            let limits = crate::procs::Limits::effective(c, Some(&s.project_id), Some(&sid))?;
            let shell = crate::tools::shell::resolve_shell(shell.as_str().unwrap_or("default")).to_string();
            let root = crate::sessions::exec_root(c, &sid)?;
            // 최초 계획에서만 설정을 읽는다. receipt 재전송·실제 spawn에는 고정한 상대 경로를 쓴다.
            let cwd = crate::settings::execution_cwd(c, &root, Some(&s.project_id), Some(&sid), explicit_cwd.as_deref())?;
            let cwd_rel = rel_display(&root, &cwd);
            let script = intent.as_ref().map(|intent| crate::project_scripts::prepare(c,&s.project_id,intent,&command,&root,&shell)).transpose()?;
            Ok((root,cwd_rel,shell,limits,s.project_id,script))
        })
        .await?;
    let queue=app.tasks.admission.get(&project);
    let admission=queue.lock().await;
    crate::auth::revalidate(&app,&p).await?;
    if let Some(response)=idem::replay(&app,&p,&headers,&h).await? { return Ok(response); }
    let resource = Some(crate::project_resources::Lease::Write { _guard:app.project_resources.process_start(&app,&project,&p).await? });
    let cwd = resolve(&root, &cwd_rel).map_err(|e| ApiError::invalid(e.message))?;
    if !cwd.is_dir() {
        return Err(ApiError::invalid("cwd 디렉터리가 없습니다"));
    }
    let id=crate::util::new_id();
    let unknown=ApiError::conflict("result_unknown","작업 접수 결과를 확정하지 못했습니다. 작업 목록에서 상태를 확인하세요")
        .with_details(json!({"task_id":id,"session_id":session_id}));
    let s=Spawn { session_id, call_id:None,shell,limits,inherit_credentials:false,command:b.command,cwd_rel:rel_display(&root,&cwd),timeout_ms:timeout,detached:true,script,setup:b.setup };
    let (plan, record_id, pending)=(s.clone(),id.clone(),unknown.body());
    let expected_root=root.clone();
    // receipt·작업·로그·이벤트를 먼저 commit한다. 경합한 요청은 저장된 ID만 받고 실행하지 않는다.
    let accepted=idem::run(&app,&p,&headers,&h,move |tx,now| {
        record_start(tx,&record_id,&plan,now,Some(&expected_root))?;
        Ok((StatusCode::CONFLICT,pending))
    }).await?;
    if accepted.headers().contains_key("idempotent-replayed") { return Ok(accepted); }
    drop(admission);
    let t=launch(&app,s,id,root,resource,None).await.map_err(|e| {
        tracing::warn!(code=e.code,"접수한 작업의 시작 결과 불명");
        unknown.clone()
    })?;
    let v = serde_json::to_value(&t)?;
    let (owner,key,response)=(p.root_id,idem::key_from(&headers)?,v.clone());
    app.db.call(move |c| {
        let tx=c.transaction()?;
        idem::complete(&tx,&owner,&key,&h,StatusCode::CREATED,&response)?;
        tx.commit()?;
        Ok(())
    }).await.map_err(|_|unknown)?;
    Ok((StatusCode::CREATED,Json(v)).into_response())
}

pub async fn list(State(app): State<App>, _p: Principal, Path(session_id): Path<String>) -> ApiResult<Json<Value>> {
    let v = app
        .db
        .call(move |c| {
            crate::sessions::get(c, &session_id)?;
            let mut st = c.prepare(&format!("SELECT {COLS} FROM tasks WHERE session_id = ?1 ORDER BY started_at DESC LIMIT 200"))?;
            let rows: Vec<Task> = st.query_map(params![session_id], from_row)?.collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .await?;
    Ok(Json(json!({ "tasks": v })))
}

pub async fn show(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let t = app.db.call(move |c| get(c, &id)).await?;
    Ok(Json(summary(&app, &t).await?))
}

#[derive(Deserialize)]
pub struct OutputQuery {
    pub stream: Option<String>,
    pub offset: Option<u64>,
    pub limit: Option<u64>,
}

/// 출력 읽기(EXEC-003). offset 기준 조각 읽기라 큰 출력도 나눠 볼 수 있다.
pub async fn output(State(app): State<App>, _p: Principal, Path(id): Path<String>, Query(q): Query<OutputQuery>) -> ApiResult<Json<Value>> {
    let i = id.clone();
    let t = app.db.call(move |c| get(c, &i)).await?;
    let stream = match q.stream.as_deref().unwrap_or("stdout") {
        "stdout" => "out",
        "stderr" => "err",
        _ => return Err(ApiError::invalid("stream은 stdout 또는 stderr입니다")),
    };
    let limit = q.limit.unwrap_or(64 * 1024).min(1024 * 1024);
    let offset = q.offset.unwrap_or(0);
    let data = app.cfg.data_dir.clone();
    let now = app.now();
    let v = app.db.call(move |c| {
        let tx = c.transaction()?;
        let t = get(&tx, &t.id)?;
        let result = crate::task_logs::output(&tx, &data, &t, stream, offset, limit, &now);
        if let Err(e) = &result {
            if e.code != "task_log_unavailable" { return Err(e.clone()); }
        }
        tx.commit()?;
        Ok(result)
    }).await?;
    app.notify_events().await;
    Ok(Json(v?))
}

pub async fn cancel(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let i = id.clone();
    let t = app.db.call(move |c| get(c, &i)).await?;
    if t.status != "running" {
        return Ok(Json(json!({ "task": t, "cancelled": false, "reason": "이미 끝난 작업입니다" })));
    }
    let sent = app.tasks.cancel(&id);
    if let Some(mut d) = app.tasks.done_rx(&id) {
        let _ = tokio::time::timeout(Duration::from_secs(10), d.wait_for(|v| *v)).await;
    }
    let t = app.db.call(move |c| get(c, &id)).await?;
    Ok(Json(json!({ "task": t, "cancelled": sent })))
}

#[derive(Deserialize)]
pub struct WaitQuery {
    pub timeout_ms: Option<u64>,
    /// 이전 wait가 반환한 cursor를 넘기면 요청 사이에 도착한 입력·알림도 놓치지 않는다.
    pub after_event_seq: Option<i64>,
}

/// 완료·같은 세션의 새 입력·관련 알림을 기다린다(EXEC-006). watch 알림 때만 DB를 읽고 주기적으로 조회하지 않는다.
/// 기다림이 끝나도 실행 중인 프로세스는 그대로 유지한다.
pub async fn wait(State(app): State<App>, p: Principal, Path(id): Path<String>, Query(q): Query<WaitQuery>) -> ApiResult<Json<Value>> {
    // snapshot보다 먼저 구독한다. snapshot 조회와 select 사이의 commit도 changed()가 감지한다.
    let mut events = app.seq_tx.subscribe();
    let mut shutdown = app.shutdown_rx.clone();
    let i = id.clone();
    let (initial, latest) = app.db.call(move |c| Ok((get(c, &i)?, events::latest_seq(c)?))).await?;
    let mut cursor = q.after_event_seq.unwrap_or(latest);
    if cursor < 0 || cursor > latest {
        return Err(ApiError::invalid("after_event_seq는 0부터 현재 이벤트 cursor 사이여야 합니다"));
    }
    let mut done = app.tasks.done_rx(&id);
    let deadline = tokio::time::sleep(Duration::from_millis(q.timeout_ms.unwrap_or(30_000).min(300_000)));
    tokio::pin!(deadline);
    let invalid = crate::auth::wait_until_invalid(app.clone(), p.clone());
    tokio::pin!(invalid);
    let mut event_seq = None;
    let reason = loop {
        crate::auth::revalidate(&app, &p).await?;
        let i = id.clone();
        if app.db.call(move |c| get(c, &i)).await?.status != "running" {
            break "completed";
        }
        let after = cursor;
        let (batch, oldest, latest) = app.db.call(move |c| Ok((events::read_after(c, after, 200)?, events::oldest_retained(c)?, events::latest_seq(c)?))).await?;
        if oldest.is_some_and(|o| cursor < o - 1) {
            cursor = latest;
            break "resync";
        }
        let full = batch.len() == 200;
        let mut wake = None;
        for event in batch {
            cursor = event.seq;
            let same_session = event.session_id.as_deref() == Some(initial.session_id.as_str());
            let reason = if same_session && ((event.kind == "message.created" && event.payload["role"] == "user")
                || (event.kind == "followups.changed" && event.payload["items"].as_array().is_some_and(|items| !items.is_empty())))
            {
                Some("new_input")
            } else if (event.kind == "notification.created" && (same_session || (event.session_id.is_none() && event.project_id.is_none())))
                || (same_session && event.kind == "message.created" && matches!(event.payload["content"]["type"].as_str(), Some("task_result" | "agent_result")))
            {
                Some("notification")
            } else {
                None
            };
            if let Some(reason) = reason {
                event_seq = Some(event.seq);
                wake = Some(reason);
                break;
            }
        }
        if let Some(reason) = wake {
            break reason;
        }
        if *shutdown.borrow() {
            break "server_shutdown";
        }
        if full {
            if tokio::time::Instant::now() >= deadline.deadline() {
                break "timeout";
            }
            continue;
        }
        tokio::select! {
            error = &mut invalid => return Err(error),
            _ = async {
                match done.as_mut() {
                    Some(d) => { let _ = d.wait_for(|v| *v).await; }
                    None => std::future::pending::<()>().await,
                }
            } => {}
            _ = events.changed() => {}
            _ = &mut deadline => break "timeout",
            _ = shutdown.wait_for(|v| *v) => break "server_shutdown",
        }
    };
    crate::auth::revalidate(&app, &p).await?;
    let t = app.db.call(move |c| get(c, &id)).await?;
    let mut v = summary(&app, &t).await?;
    let reason = if t.status == "running" { reason } else { "completed" };
    v["wait_timed_out"] = json!(reason == "timeout");
    v["wake_reason"] = json!(reason);
    v["event_cursor"] = json!(cursor);
    v["wake_event_seq"] = json!(event_seq);
    Ok(Json(v))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_acceptance_rechecks_shell_after_waiting_for_admission() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::store::Db::open(&dir.path().join("grove.db")).unwrap();
        let now = crate::util::fmt_time(time::OffsetDateTime::now_utc());
        db.call_sync(|c| {
            c.execute("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES('p','fixture',?1,?2,?2)", params![dir.path().to_string_lossy(),now])?;
            c.execute("INSERT INTO sessions(id,project_id,title,created_at,updated_at) VALUES('s','p','fixture',?1,?1)", [&now])?;
            c.execute("INSERT INTO project_scripts(id,project_id,name,command,created_at,updated_at) VALUES('script','p','check','echo fixture',?1,?1)", [&now])?;
            let shell = crate::tools::shell::resolve_shell("default");
            let project = crate::projects::get(c, "p")?;
            let root = crate::sessions::exec_root(c, "s")?;
            let execution = crate::util::sha256_hex(json!({
                "project":project.id,"revision":project.revision,"root":root.to_string_lossy(),"shell":shell
            }).to_string().as_bytes());
            let intent = crate::project_scripts::Intent { id:"script".into(),expected_revision:1,expected_execution:execution };
            let snapshot = crate::project_scripts::prepare(c,"p",&intent,"echo fixture",&root,shell)?;
            let plan = Spawn {
                session_id:"s".into(),call_id:None,shell:shell.into(),limits:crate::procs::Limits::default(),inherit_credentials:false,
                command:"echo fixture".into(),cwd_rel:".".into(),timeout_ms:1000,detached:true,script:Some(snapshot),setup:false,
            };
            let changed = if shell == "sh" { "bash" } else { "sh" };
            c.execute("INSERT INTO settings(scope,scope_id,key,value,revision,updated_at) VALUES('project','p','exec.shell',?1,1,?2)",
                params![json!(changed).to_string(),now])?;
            let tx = c.transaction()?;
            let error = record_start(&tx,"stale",&plan,&now,Some(&root)).unwrap_err();
            assert_eq!(error.code,"script_changed");
            let count: i64 = tx.query_row("SELECT COUNT(*) FROM tasks",[],|r|r.get(0))?;
            assert_eq!(count,0);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn acceptance_rejects_a_changed_project_root_without_records() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old");
        let new = dir.path().join("new");
        std::fs::create_dir(&old).unwrap();
        std::fs::create_dir(&new).unwrap();
        let db = crate::store::Db::open(&dir.path().join("grove.db")).unwrap();
        let now = crate::util::fmt_time(time::OffsetDateTime::now_utc());
        db.call_sync(|c| {
            c.execute("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES('p','fixture',?1,?2,?2)", params![new.to_string_lossy(), now])?;
            c.execute("INSERT INTO sessions(id,project_id,title,created_at,updated_at) VALUES('s','p','fixture',?1,?1)", [&now])?;
            let plan = Spawn {
                session_id: "s".into(), call_id: None, shell: "default".into(),
                limits: crate::procs::Limits::default(), inherit_credentials: false, command: "echo fixture".into(),
                cwd_rel: ".".into(), timeout_ms: 1000, detached: true,
                script: None, setup: false,
            };
            let tx = c.transaction()?;
            let error = record_start(&tx, "stale", &plan, &now, Some(&old)).unwrap_err();
            assert_eq!(error.code, "project_changed");
            for table in ["tasks", "task_logs", "events"] {
                let n: i64 = tx.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
                assert_eq!(n, 0, "경로가 바뀌면 접수 부작용을 남기지 않는다: {table}");
            }
            // 현재 경로가 일치하는 요청은 동일 접수 경계에서 정상 기록된다.
            assert_eq!(record_start(&tx, "current", &plan, &now, Some(&new))?, new);
            tx.commit()?;
            Ok(())
        }).unwrap();
    }
}
