//! 터미널(TERM-001~006, 008). Linux PTY·Windows ConPTY는 `portable-pty`가 맡는다.
//!
//! - 출력은 고정 크기 scrollback(ring)과 broadcast로 내보낸다. PTY reader는 느린 클라이언트 때문에 멈추지 않는다.
//!   뒤처진 구독자는 `reset` 후 snapshot을 다시 받는다(TERM-006).
//! - ring push와 broadcast 송신, 그리고 구독 시작과 snapshot 복사는 같은 lock 안에서 해 중복·누락이 없다.
//! - WebSocket은 인증 헤더를 못 보내므로 인증된 POST로 받은 일회용 60초 티켓으로 연결한다(교차 사이트 연결 차단).
//! - 서버가 재시작되면 프로세스는 함께 끝난다. 화면은 파일에서 읽기 전용으로 복원하고 상태는 `lost`로 둔다(TERM-008).

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::idem;
use crate::tools::fs::{rel_display, resolve};
use axum::Json;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, watch};

/// 화면 복원용 scrollback 상한.
pub const SCROLLBACK: usize = 512 * 1024;
const MAX_RUNNING: i64 = 16;
const TICKET_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
pub struct Terminal {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub cwd: String,
    pub shell: String,
    pub status: String,
    pub exit_code: Option<i64>,
    pub reason: Option<String>,
    pub cols: i64,
    pub rows: i64,
    pub revision: i64,
    pub created_at: String,
    pub ended_at: Option<String>,
}

const COLS: &str = "id, project_id, name, cwd, shell, status, exit_code, reason, cols, rows, revision, created_at, ended_at";

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<Terminal> {
    Ok(Terminal {
        id: r.get(0)?,
        project_id: r.get(1)?,
        name: r.get(2)?,
        cwd: r.get(3)?,
        shell: r.get(4)?,
        status: r.get(5)?,
        exit_code: r.get(6)?,
        reason: r.get(7)?,
        cols: r.get(8)?,
        rows: r.get(9)?,
        revision: r.get(10)?,
        created_at: r.get(11)?,
        ended_at: r.get(12)?,
    })
}

pub fn get(c: &Connection, id: &str) -> ApiResult<Terminal> {
    c.query_row(&format!("SELECT {COLS} FROM terminals WHERE id = ?1"), params![id], from_row)
        .optional()?
        .ok_or_else(|| ApiError::not_found("터미널이 없습니다"))
}

struct Ring {
    buf: VecDeque<u8>,
    dirty: bool,
}

impl Ring {
    fn push(&mut self, b: &[u8]) {
        self.buf.extend(b);
        let over = self.buf.len().saturating_sub(SCROLLBACK);
        if over > 0 {
            self.buf.drain(..over);
        }
        self.dirty = true;
    }
    fn snapshot(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }
}

/// 실행 중 터미널.
pub struct Live {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    ring: Mutex<Ring>,
    tx: broadcast::Sender<Bytes>,
    exited: watch::Sender<Option<i64>>,
    closing: AtomicBool,
}

#[derive(Default)]
pub struct Terminals {
    live: Mutex<HashMap<String, Arc<Live>>>,
    tickets: Mutex<HashMap<String, (String, Instant)>>,
}

impl Terminals {
    fn get(&self, id: &str) -> Option<Arc<Live>> {
        self.live.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned()
    }
    fn all(&self) -> Vec<(String, Arc<Live>)> {
        self.live.lock().unwrap_or_else(|e| e.into_inner()).iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }
    fn issue_ticket(&self, id: &str) -> String {
        let t = crate::util::random_secret(24);
        let mut m = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        m.retain(|_, v| v.1 > now);
        m.insert(t.clone(), (id.to_string(), now + TICKET_TTL));
        t
    }
    /// 일회용: 쓰면 바로 지운다.
    fn take_ticket(&self, t: &str) -> Option<String> {
        let mut m = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
        m.remove(t).filter(|v| v.1 > Instant::now()).map(|v| v.0)
    }
}

fn screen_path(app: &App, id: &str) -> std::path::PathBuf {
    app.cfg.data_dir.join("terminals").join(format!("{id}.screen"))
}

fn save_screen(app: &App, id: &str, live: &Live) {
    let snap = {
        let mut r = live.ring.lock().unwrap_or_else(|e| e.into_inner());
        if !r.dirty {
            return;
        }
        r.dirty = false;
        r.snapshot()
    };
    let p = screen_path(app, id);
    let _ = std::fs::create_dir_all(p.parent().unwrap_or(&p));
    let _ = crate::tools::fs::atomic_write(&p, &snap);
}

fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".into()
    } else {
        std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/bash".into())
    }
}

fn clamp_size(cols: Option<u16>, rows: Option<u16>) -> (u16, u16) {
    (cols.unwrap_or(80).clamp(10, 500), rows.unwrap_or(24).clamp(4, 300))
}

#[derive(Deserialize)]
pub struct CreateBody {
    pub name: Option<String>,
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

pub async fn create(State(app): State<App>, p: Principal, headers: HeaderMap, Path(project_id): Path<String>, Json(b): Json<CreateBody>) -> ApiResult<Response> {
    let h = idem::body_hash("terminal.create", &json!({ "p": project_id, "n": b.name, "c": b.cwd, "w": b.cols, "r": b.rows }));
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? {
        return Ok(r);
    }
    let pid = project_id.clone();
    let (root, running) = app
        .db
        .call(move |c| {
            let root = crate::projects::active_root(c, &pid)?;
            let n: i64 = c.query_row("SELECT COUNT(*) FROM terminals WHERE status = 'running'", [], |r| r.get(0))?;
            Ok((root, n))
        })
        .await?;
    if running >= MAX_RUNNING {
        return Err(ApiError::busy(format!("터미널은 동시에 {MAX_RUNNING}개까지 열 수 있습니다")));
    }
    let cwd = resolve(&root, b.cwd.as_deref().unwrap_or(".")).map_err(|e| ApiError::invalid(e.message))?;
    if !cwd.is_dir() {
        return Err(ApiError::invalid("cwd 디렉터리가 없습니다"));
    }
    let name = b.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| "터미널".into());
    if name.chars().count() > 100 {
        return Err(ApiError::invalid("이름은 100자 이하여야 합니다"));
    }
    let (cols, rows) = clamp_size(b.cols, b.rows);
    let shell = default_shell();
    let id = crate::util::new_id();

    // PTY 생성은 blocking.
    let (sh, cwd2) = (shell.clone(), cwd.clone());
    let spawned = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("PTY 생성 실패: {e}"))?;
        let mut cmd = CommandBuilder::new(&sh);
        cmd.cwd(&cwd2);
        cmd.env("TERM", "xterm-256color");
        cmd.env("GROVE_TERMINAL", "1");
        let child = pair.slave.spawn_command(cmd).map_err(|e| format!("셸 실행 실패: {e}"))?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        Ok((pair.master, child, reader, writer))
    })
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?
    .map_err(|e| ApiError::new(StatusCode::CONFLICT, "spawn_failed", e))?;
    let (master, mut child, mut reader, writer) = spawned;
    let (tx, _) = broadcast::channel(256);
    let (exit_tx, _) = watch::channel(None);
    let live = Arc::new(Live {
        writer: Mutex::new(writer),
        master: Mutex::new(master),
        killer: Mutex::new(child.clone_killer()),
        ring: Mutex::new(Ring { buf: VecDeque::new(), dirty: false }),
        tx,
        exited: exit_tx,
        closing: AtomicBool::new(false),
    });
    app.terminals.live.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), live.clone());

    // 출력 reader: blocking read → ring + broadcast(같은 lock 안에서)
    {
        let live = live.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut r = live.ring.lock().unwrap_or_else(|e| e.into_inner());
                        r.push(&buf[..n]);
                        let _ = live.tx.send(Bytes::copy_from_slice(&buf[..n]));
                    }
                }
            }
        });
    }
    // 종료 감시: blocking wait → DB 기록, 화면 저장
    {
        let (app2, live, id2) = (app.clone(), live.clone(), id.clone());
        let handle = tokio::runtime::Handle::current();
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code() as i64);
            // reader가 마지막 출력을 ring에 넣을 시간을 준다.
            std::thread::sleep(Duration::from_millis(100));
            save_screen(&app2, &id2, &live);
            let reason = if live.closing.load(Ordering::SeqCst) { Some("사용자가 종료함") } else { None };
            handle.block_on(async {
                let now = app2.now();
                let i = id2.clone();
                let _ = app2
                    .db
                    .call(move |c| {
                        let tx = c.transaction()?;
                        let n = tx.execute(
                            "UPDATE terminals SET status = 'exited', exit_code = ?2, reason = COALESCE(reason, ?3), ended_at = ?4, revision = revision + 1 \
                             WHERE id = ?1 AND status = 'running'",
                            params![i, code, reason, now],
                        )?;
                        if n == 1 {
                            let t = get(&tx, &i)?;
                            events::append(&tx, &now, "terminal.changed", Some(&t.project_id), None, &serde_json::to_value(&t)?)?;
                        }
                        tx.commit()?;
                        Ok(())
                    })
                    .await;
                app2.notify_events().await;
            });
            live.exited.send_replace(Some(code.unwrap_or(-1)));
            app2.terminals.live.lock().unwrap_or_else(|e| e.into_inner()).remove(&id2);
        });
    }

    let now = app.now();
    let (pid, id2, cwd_rel) = (project_id.clone(), id.clone(), rel_display(&root, &cwd));
    idem::run(&app, &p, &headers, &h, move |tx, _| {
        tx.execute(
            "INSERT INTO terminals (id, project_id, name, cwd, shell, status, cols, rows, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6, ?7, ?8)",
            params![id2, pid, name, cwd_rel, shell, cols as i64, rows as i64, now],
        )?;
        let t = get(tx, &id2)?;
        events::append(tx, &now, "terminal.changed", Some(&pid), None, &serde_json::to_value(&t)?)?;
        Ok((StatusCode::CREATED, serde_json::to_value(t)?))
    })
    .await
}

pub async fn list(State(app): State<App>, _p: Principal, Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let v = app
        .db
        .call(move |c| {
            crate::projects::get(c, &project_id)?;
            let mut st = c.prepare(&format!("SELECT {COLS} FROM terminals WHERE project_id = ?1 ORDER BY created_at"))?;
            let rows: Vec<Terminal> = st.query_map(params![project_id], from_row)?.collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .await?;
    Ok(Json(json!({ "terminals": v })))
}

#[derive(Deserialize)]
pub struct RenameBody {
    pub expected_revision: i64,
    pub name: String,
}

pub async fn rename(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<RenameBody>) -> ApiResult<Response> {
    let name = b.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::invalid("이름은 1~100자여야 합니다"));
    }
    let h = idem::body_hash("terminal.rename", &json!({ "i": id, "r": b.expected_revision, "n": name }));
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get(tx, &id)?;
        if cur.revision != b.expected_revision {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        tx.execute("UPDATE terminals SET name = ?2, revision = revision + 1 WHERE id = ?1", params![id, name])?;
        let t = get(tx, &id)?;
        events::append(tx, now, "terminal.changed", Some(&t.project_id), None, &serde_json::to_value(&t)?)?;
        Ok((StatusCode::OK, serde_json::to_value(t)?))
    })
    .await
}

/// 프로세스 종료. 이미 끝났으면 현재 상태를 그대로 돌려준다.
pub async fn kill(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    if let Some(live) = app.terminals.get(&id) {
        live.closing.store(true, Ordering::SeqCst);
        let mut rx = live.exited.subscribe();
        let _ = live.killer.lock().unwrap_or_else(|e| e.into_inner()).kill();
        let _ = tokio::time::timeout(Duration::from_secs(5), rx.wait_for(|v| v.is_some())).await;
    }
    let t = app.db.call(move |c| get(c, &id)).await?;
    Ok(Json(serde_json::to_value(t)?))
}

/// 끝난 터미널 기록과 화면 파일을 지운다. 실행 중이면 거부한다.
pub async fn remove(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let i = id.clone();
    app.db
        .call(move |c| {
            let tx = c.transaction()?;
            let t = get(&tx, &i)?;
            if t.status == "running" {
                return Err(ApiError::conflict("running", "실행 중인 터미널은 먼저 종료하세요"));
            }
            tx.execute("DELETE FROM terminals WHERE id = ?1", params![i])?;
            events::append(&tx, &crate::util::fmt_time(time::OffsetDateTime::now_utc()), "terminal.removed", Some(&t.project_id), None, &json!({ "id": i }))?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    let _ = std::fs::remove_file(screen_path(&app, &id));
    app.notify_events().await;
    Ok(StatusCode::NO_CONTENT)
}

/// 저장된 화면(끝난·lost 터미널 복원용).
pub async fn screen(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Response> {
    let i = id.clone();
    app.db.call(move |c| get(c, &i)).await?;
    let data = match app.terminals.get(&id) {
        Some(live) => live.ring.lock().unwrap_or_else(|e| e.into_inner()).snapshot(),
        None => std::fs::read(screen_path(&app, &id)).unwrap_or_default(),
    };
    Ok(([(axum::http::header::CONTENT_TYPE, "application/octet-stream")], data).into_response())
}

pub async fn ticket(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let i = id.clone();
    let t = app.db.call(move |c| get(c, &i)).await?;
    if t.status != "running" || app.terminals.get(&id).is_none() {
        return Err(ApiError::conflict("not_running", "실행 중인 터미널이 아닙니다"));
    }
    let tk = app.terminals.issue_ticket(&id);
    Ok(Json(json!({ "url": format!("/api/v1/terminal-ws/{tk}"), "expires_in": TICKET_TTL.as_secs() })))
}

pub async fn ws(State(app): State<App>, Path(ticket): Path<String>, up: WebSocketUpgrade) -> ApiResult<Response> {
    let id = app.terminals.take_ticket(&ticket).ok_or_else(|| ApiError::unauthorized("만료되었거나 이미 쓴 터미널 연결 티켓입니다"))?;
    let live = app.terminals.get(&id).ok_or_else(|| ApiError::conflict("not_running", "터미널이 이미 끝났습니다"))?;
    Ok(up.max_message_size(1024 * 1024).on_upgrade(move |sock| session(app, id, live, sock)))
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
}

/// snapshot과 구독을 같은 lock 안에서 얻는다.
fn subscribe(live: &Live) -> (broadcast::Receiver<Bytes>, Vec<u8>) {
    let r = live.ring.lock().unwrap_or_else(|e| e.into_inner());
    (live.tx.subscribe(), r.snapshot())
}

async fn session(app: App, id: String, live: Arc<Live>, mut sock: WebSocket) {
    let (mut rx, snap) = subscribe(&live);
    let mut exited = live.exited.subscribe();
    let mut shutdown = app.shutdown_rx.clone();
    if sock.send(Message::Text(json!({ "type": "hello", "id": id }).to_string().into())).await.is_err()
        || sock.send(Message::Binary(snap.into())).await.is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Ok(b) => if sock.send(Message::Binary(b)).await.is_err() { break },
                // 느린 클라이언트: 놓친 조각 대신 현재 화면 전체를 다시 보낸다.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let (nrx, snap) = subscribe(&live);
                    rx = nrx;
                    if sock.send(Message::Text(json!({ "type": "reset" }).to_string().into())).await.is_err()
                        || sock.send(Message::Binary(snap.into())).await.is_err() { break }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            inc = sock.recv() => match inc {
                Some(Ok(Message::Text(t))) => match serde_json::from_str::<ClientMsg>(&t) {
                    Ok(ClientMsg::Input { data }) => {
                        let mut w = live.writer.lock().unwrap_or_else(|e| e.into_inner());
                        let _ = w.write_all(data.as_bytes()).and_then(|_| w.flush());
                    }
                    Ok(ClientMsg::Resize { cols, rows }) => {
                        let (c, r) = clamp_size(Some(cols), Some(rows));
                        let _ = live.master.lock().unwrap_or_else(|e| e.into_inner()).resize(PtySize { rows: r, cols: c, pixel_width: 0, pixel_height: 0 });
                        let i = id.clone();
                        let _ = app.db.call(move |db| Ok(db.execute("UPDATE terminals SET cols = ?2, rows = ?3 WHERE id = ?1", params![i, c as i64, r as i64])?)).await;
                    }
                    Err(_) => {}
                },
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            code = async { exited.wait_for(|v| v.is_some()).await.ok().and_then(|v| *v) } => {
                // 남은 출력을 흘려보낸 뒤 종료를 알린다.
                while let Ok(b) = rx.try_recv() {
                    let _ = sock.send(Message::Binary(b)).await;
                }
                let _ = sock.send(Message::Text(json!({ "type": "exit", "code": code }).to_string().into())).await;
                break;
            }
            _ = async { let _ = shutdown.wait_for(|v| *v).await; } => break,
        }
    }
    let _ = sock.send(Message::Close(None)).await;
}

/// 주기적으로 화면을 파일에 저장한다(비정상 종료 대비).
pub fn spawn_saver(app: App) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut rx = app.shutdown_rx.clone();
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(2)) => {
                    for (id, live) in app.terminals.all() {
                        save_screen(&app, &id, &live);
                    }
                }
                _ = rx.changed() => break,
            }
        }
    })
}

/// 시작 시: 이전 프로세스의 터미널은 서버와 함께 끝났다.
pub fn recover_on_start(c: &Connection, now: &str) -> ApiResult<usize> {
    Ok(c.execute(
        "UPDATE terminals SET status = 'lost', reason = '서버가 재시작되어 프로세스가 종료되었습니다. 화면만 복원됩니다', ended_at = ?1, revision = revision + 1 \
         WHERE status = 'running'",
        params![now],
    )?)
}

/// 종료 시: 화면을 저장하고 프로세스를 끝낸다.
pub async fn stop_all(app: &App) {
    let all = app.terminals.all();
    for (id, live) in &all {
        save_screen(app, id, live);
        let i = id.clone();
        let _ = app
            .db
            .call(move |c| Ok(c.execute("UPDATE terminals SET reason = '서버 종료' WHERE id = ?1 AND status = 'running'", params![i])?))
            .await;
        let _ = live.killer.lock().unwrap_or_else(|e| e.into_inner()).kill();
    }
    for (_, live) in all {
        let mut rx = live.exited.subscribe();
        let _ = tokio::time::timeout(Duration::from_secs(3), rx.wait_for(|v| v.is_some())).await;
    }
}
