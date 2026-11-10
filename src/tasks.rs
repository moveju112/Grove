//! 백그라운드 셸 작업(EXEC-003~013).
//!
//! - 출력은 stream별 파일에 상한(`MAX_LOG`)까지 기록하고 전체 바이트 수를 센다. 메모리에는 쌓지 않는다.
//! - hard timeout(프로세스 종료)과 hold(호출자가 기다리는 시간)는 별개다.
//! - 결과 기록: `detached`인 작업이 끝나면 같은 transaction에서 상태 전이와 함께 세션에 note를 한 번만 남긴다.
//!   hold 중에 끝난 작업은 호출자(도구 결과)가 직접 결과를 받으므로 note를 남기지 않는다.
//! - 재시작으로 확인할 수 없게 된 작업은 `unknown`으로 표시한다. 남아 있을 수 있는 프로세스는
//!   PID 재사용 위험 때문에 자동으로 종료하지 않는다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::idem;
use crate::tools::fs::{rel_display, resolve};
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
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
}

const COLS: &str = "id, session_id, project_id, call_id, command, cwd, timeout_ms, status, detached, pid, exit_code, signal, \
                    stdout_bytes, stderr_bytes, reason, result_message_id, started_at, ended_at";

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
    app.cfg.data_dir.join("tasks").join(format!("{id}.{stream}"))
}

/// 파일 꼬리(lossy UTF-8).
fn tail(path: &std::path::Path, n: u64) -> String {
    let Ok(mut f) = std::fs::File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(n);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = vec![];
    let _ = f.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).to_string()
}

async fn pump<R: AsyncRead + Unpin>(mut r: R, path: PathBuf) -> u64 {
    let mut f = match tokio::fs::File::create(&path).await {
        Ok(f) => Some(f),
        Err(_) => None,
    };
    let mut written = 0u64;
    let mut total = 0u64;
    let mut buf = [0u8; 16 * 1024];
    loop {
        match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                total += n as u64;
                // 상한을 넘어도 계속 읽어 pipe가 막혀 자식이 멈추지 않게 한다.
                if let Some(f) = f.as_mut()
                    && written < MAX_LOG
                {
                    let take = (n as u64).min(MAX_LOG - written) as usize;
                    if f.write_all(&buf[..take]).await.is_ok() {
                        written += take as u64;
                    }
                }
            }
        }
    }
    if let Some(mut f) = f {
        let _ = f.flush().await;
    }
    total
}

pub struct Spawn {
    pub session_id: String,
    pub call_id: Option<String>,
    pub command: String,
    pub cwd_rel: String,
    pub timeout_ms: u64,
    pub detached: bool,
}

/// 작업을 기록하고 프로세스를 시작한다. 반환 시점에 row는 commit되어 있다.
pub async fn spawn(app: &App, s: Spawn) -> ApiResult<Task> {
    let id = crate::util::new_id();
    let now = app.now();
    let (sid, cid, cmd_s, cwd_s, timeout, detached, id2) =
        (s.session_id.clone(), s.call_id.clone(), s.command.clone(), s.cwd_rel.clone(), s.timeout_ms as i64, s.detached, id.clone());
    let root = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let sess = crate::sessions::get_active(&tx, &sid)?;
            if running_in_session(&tx, &sid)? >= MAX_RUNNING_PER_SESSION {
                return Err(ApiError::busy(format!("세션당 백그라운드 작업은 {MAX_RUNNING_PER_SESSION}개까지 실행할 수 있습니다")));
            }
            let root = crate::projects::active_root(&tx, &sess.project_id)?;
            tx.execute(
                "INSERT INTO tasks (id, session_id, project_id, call_id, command, cwd, timeout_ms, status, detached, started_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', ?8, ?9)",
                params![id2, sid, sess.project_id, cid, cmd_s, cwd_s, timeout, detached as i64, now],
            )?;
            let t = get(&tx, &id2)?;
            events::append(&tx, &now, "task.changed", Some(&t.project_id), Some(&t.session_id), &serde_json::to_value(&t)?)?;
            tx.commit()?;
            Ok(root)
        })
        .await?;
    std::fs::create_dir_all(app.cfg.data_dir.join("tasks")).map_err(|e| ApiError::internal(format!("작업 로그 폴더: {e}")))?;
    let started = match resolve(&root, &s.cwd_rel) {
        Ok(cwd) if cwd.is_dir() => crate::tools::shell::command(&s.command, &cwd).spawn().map_err(|e| format!("셸 실행 실패: {e}")),
        Ok(_) => Err("cwd 디렉터리가 없습니다".into()),
        Err(e) => Err(e.message),
    };
    let mut child = match started {
        Ok(c) => c,
        Err(msg) => {
            finalize(app, &id, End::SpawnFailed(msg), 0, 0).await;
            let i = id.clone();
            return app.db.call(move |c| get(c, &i)).await;
        }
    };
    let pid = child.id();
    if let Some(pid) = pid {
        let i = id.clone();
        let _ = app.db.call(move |c| Ok(c.execute("UPDATE tasks SET pid = ?2 WHERE id = ?1", params![i, pid as i64])?)).await;
    }
    let (mut cancel_rx, done_tx) = app.tasks.insert(&id);
    let out_h = tokio::spawn(pump(child.stdout.take().expect("stdout"), log_path(app, &id, "out")));
    let err_h = tokio::spawn(pump(child.stderr.take().expect("stderr"), log_path(app, &id, "err")));
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
        if let Some(pid) = pid {
            // 셸이 끝났어도 같은 그룹에 남은 자식까지 정리한다.
            crate::tools::shell::kill_group(pid);
            if !matches!(end, End::Exit(_)) {
                let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
            }
        }
        let o = tokio::time::timeout(Duration::from_secs(5), out_h).await.ok().and_then(Result::ok).unwrap_or(0);
        let e = tokio::time::timeout(Duration::from_secs(5), err_h).await.ok().and_then(Result::ok).unwrap_or(0);
        finalize(&app2, &id2, end, o, e).await;
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
async fn finalize(app: &App, id: &str, end: End, out_bytes: u64, err_bytes: u64) {
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
    let tails = (tail(&log_path(app, id, "out"), TAIL), tail(&log_path(app, id, "err"), TAIL));
    let id = id.to_string();
    let now = app.now();
    let status = status.to_string();
    let _ = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let n = tx.execute(
                "UPDATE tasks SET status = ?2, exit_code = ?3, signal = ?4, reason = ?5, stdout_bytes = ?6, stderr_bytes = ?7, ended_at = ?8 \
                 WHERE id = ?1 AND status = 'running'",
                params![id, status, code, sig, reason, out_bytes as i64, err_bytes as i64, now],
            )?;
            if n == 0 {
                return Ok(());
            }
            let t = get(&tx, &id)?;
            record_note(&tx, &now, &t, &tails.0, &tails.1)?;
            let t = get(&tx, &id)?;
            events::append(&tx, &now, "task.changed", Some(&t.project_id), Some(&t.session_id), &serde_json::to_value(&t)?)?;
            tx.commit()?;
            Ok(())
        })
        .await;
    app.notify_events().await;
}

fn record_note(tx: &Connection, now: &str, t: &Task, out: &str, err: &str) -> ApiResult<()> {
    if !t.detached || t.result_message_id.is_some() {
        return Ok(());
    }
    let content = json!({
        "type": "task_result",
        "task_id": t.id, "command": t.command, "cwd": t.cwd,
        "status": t.status, "exit_code": t.exit_code, "signal": t.signal, "reason": t.reason,
        "stdout_tail": out, "stderr_tail": err,
        "stdout_bytes": t.stdout_bytes, "stderr_bytes": t.stderr_bytes,
        "truncated": t.stdout_bytes as u64 > TAIL || t.stderr_bytes as u64 > TAIL,
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
    s
}

/// 결과 요약(도구 결과·API 응답용).
pub fn summary(app: &App, t: &Task) -> Value {
    let mut v = serde_json::to_value(t).unwrap_or(Value::Null);
    v["stdout_tail"] = json!(tail(&log_path(app, &t.id, "out"), TAIL));
    v["stderr_tail"] = json!(tail(&log_path(app, &t.id, "err"), TAIL));
    v
}

/// 도구 호출 경로: hold 동안 기다리고, 안 끝나면 분리(detach)한다. 분리와 완료는 DB에서 원자적으로 경합한다.
pub async fn run_with_hold(app: &App, s: Spawn, hold_ms: u64, mut cancel: watch::Receiver<bool>) -> Result<Value, crate::tools::ToolError> {
    use crate::tools::ToolError;
    let t = spawn(app, s).await.map_err(|e| ToolError::new("spawn_failed", e.message))?;
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
    let v = summary(app, &t);
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

/// 시작 시: 이전 프로세스에서 실행 중이던 작업은 결과를 확인할 수 없다(EXEC-013).
pub fn recover_on_start(c: &mut Connection, now: &str) -> ApiResult<usize> {
    let tx = c.transaction()?;
    let ids: Vec<String> = {
        let mut st = tx.prepare("SELECT id FROM tasks WHERE status = 'running'")?;
        st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?
    };
    for id in &ids {
        tx.execute(
            "UPDATE tasks SET status = 'unknown', ended_at = ?2, reason = '서버가 재시작되어 결과를 확인할 수 없습니다. 프로세스가 남아 있을 수 있습니다' WHERE id = ?1",
            params![id, now],
        )?;
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
}

/// 사용자가 직접 시작하는 백그라운드 작업. 소유자가 명시적으로 실행하므로 승인 단계가 없다.
pub async fn start(State(app): State<App>, p: Principal, headers: HeaderMap, Path(session_id): Path<String>, Json(b): Json<StartBody>) -> ApiResult<Response> {
    if b.command.trim().is_empty() || b.command.len() > 64 * 1024 {
        return Err(ApiError::invalid("command가 비어 있거나 너무 깁니다"));
    }
    let timeout = b.timeout_ms.unwrap_or(crate::tools::shell::MAX_BACKGROUND_TIMEOUT_MS).clamp(100, crate::tools::shell::MAX_BACKGROUND_TIMEOUT_MS);
    // 같은 Idempotency-Key 재전송이 프로세스를 두 번 띄우지 않게, 기록된 응답이 있으면 그대로 돌려준다.
    let h = idem::body_hash("task.start", &json!({ "s": session_id, "c": b.command, "w": b.cwd, "t": timeout }));
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? {
        return Ok(r);
    }
    let sid = session_id.clone();
    let root = app
        .db
        .call(move |c| {
            let s = crate::sessions::get_active(c, &sid)?;
            crate::projects::active_root(c, &s.project_id)
        })
        .await?;
    let cwd = resolve(&root, b.cwd.as_deref().unwrap_or(".")).map_err(|e| ApiError::invalid(e.message))?;
    if !cwd.is_dir() {
        return Err(ApiError::invalid("cwd 디렉터리가 없습니다"));
    }
    let t = spawn(
        &app,
        Spawn { session_id, call_id: None, command: b.command, cwd_rel: rel_display(&root, &cwd), timeout_ms: timeout, detached: true },
    )
    .await?;
    let v = serde_json::to_value(&t)?;
    idem::run(&app, &p, &headers, &h, move |_, _| Ok((StatusCode::CREATED, v))).await
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
    Ok(Json(summary(&app, &t)))
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
    let path = log_path(&app, &t.id, stream);
    let limit = q.limit.unwrap_or(64 * 1024).min(1024 * 1024);
    let offset = q.offset.unwrap_or(0);
    let (data, size) = match std::fs::File::open(&path) {
        Ok(mut f) => {
            let size = f.metadata().map(|m| m.len()).unwrap_or(0);
            let mut buf = vec![];
            if offset < size {
                f.seek(SeekFrom::Start(offset)).map_err(|e| ApiError::internal(e.to_string()))?;
                f.take(limit).read_to_end(&mut buf).map_err(|e| ApiError::internal(e.to_string()))?;
            }
            (buf, size)
        }
        Err(_) => (vec![], 0),
    };
    let total = if stream == "out" { t.stdout_bytes } else { t.stderr_bytes } as u64;
    Ok(Json(json!({
        "task_id": t.id, "stream": q.stream.unwrap_or_else(|| "stdout".into()),
        "offset": offset, "next_offset": offset + data.len() as u64,
        "data": String::from_utf8_lossy(&data),
        "stored_bytes": size, "eof": offset + data.len() as u64 >= size && t.status != "running",
        "dropped_bytes": if t.status != "running" { total.saturating_sub(size) } else { 0 },
    })))
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
pub async fn wait(State(app): State<App>, _p: Principal, Path(id): Path<String>, Query(q): Query<WaitQuery>) -> ApiResult<Json<Value>> {
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
    let mut event_seq = None;
    let reason = loop {
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
    let t = app.db.call(move |c| get(c, &id)).await?;
    let mut v = summary(&app, &t);
    let reason = if t.status == "running" { reason } else { "completed" };
    v["wait_timed_out"] = json!(reason == "timeout");
    v["wake_reason"] = json!(reason);
    v["event_cursor"] = json!(cursor);
    v["wake_event_seq"] = json!(event_seq);
    Ok(Json(v))
}
