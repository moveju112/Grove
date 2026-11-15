//! CLI에만 주는 턴 한정 MCP 연결. owner token·사용자 MCP 설정을 전달하지 않는다.
use super::*;
use axum::{Router, http::HeaderMap, routing::post};
use std::io::{BufRead, Read};

#[derive(Clone)]
pub struct Link {
    pub file: std::path::PathBuf,
    pub waiting: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl std::fmt::Debug for Link {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ComputerLink(<turn-scoped>)")
    }
}

pub struct Bridge {
    task: tokio::task::JoinHandle<()>,
    revoke: watch::Sender<bool>,
    app: App,
    turn: String,
    _dir: tempfile::TempDir,
    pub link: Link,
}
impl Drop for Bridge {
    fn drop(&mut self) {
        self.revoke.send_replace(true);
        self.task.abort();
        self.app
            .computer
            .cli_turns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.turn);
        let (app, turn) = (self.app.clone(), self.turn.clone());
        tokio::spawn(async move {
            let cancels = app.cancels.clone();
            let result = app
                .db
                .call(move |c| {
                    let tx = c.transaction()?;
                    let now = crate::util::fmt_time(time::OffsetDateTime::now_utc());
                    for call in crate::approvals::list_for_turn(&tx, &turn)? {
                        if call.name != "computer"
                            || !call
                                .provider_call_id
                                .as_deref()
                                .is_some_and(|s| s.starts_with("computer-cli:"))
                        {
                            continue;
                        }
                        cancels.cancel(&call.id);
                        crate::approvals::finish(
                            &tx,
                            &now,
                            &call.id,
                            &["pending_approval", "approved"],
                            "cancelled",
                            Some(
                                ToolError::new(
                                    "turn_ended",
                                    "CLI 턴 연결이 종료돼 실행하지 않았습니다",
                                )
                                .to_json(),
                            ),
                        )?;
                    }
                    tx.commit()?;
                    Ok(())
                })
                .await;
            if let Err(e) = result {
                tracing::error!(code = e.code, "computer bridge cleanup failed");
            }
            app.notify_events().await;
        });
    }
}

#[derive(Clone)]
struct Scope {
    app: App,
    turn: String,
    session: String,
    token: String,
    cancel: watch::Receiver<bool>,
    revoked: watch::Receiver<bool>,
    waiting: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

struct Waiting(std::sync::Arc<std::sync::atomic::AtomicBool>);
impl Drop for Waiting {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

fn permitted(c: &rusqlite::Connection, turn: &str) -> ApiResult<bool> {
    let t = crate::runner::get_turn(c, turn)?;
    let allowed = t.definition["limits"]["allowed_tools"].as_array();
    if allowed.is_some_and(|a| !a.iter().any(|v| v == super::NAME)) {
        return Ok(false);
    }
    let session = crate::sessions::get(c, &t.session_id)?;
    if let crate::approvals::PolicyDecision::Deny(..) =
        crate::approvals::tool_policy(c, &session.project_id, &t.session_id, &super::spec())?
    {
        return Ok(false);
    }
    Ok(true)
}

impl Bridge {
    pub async fn start(
        app: &App,
        turn: &str,
        session: &str,
        cancel: watch::Receiver<bool>,
    ) -> ApiResult<Option<Self>> {
        if !app.db.call(|c| super::enabled(c)).await? {
            return Ok(None);
        }
        let tid = turn.to_string();
        let allowed = app.db.call(move |c| permitted(c, &tid)).await?;
        if !allowed {
            return Ok(None);
        }
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?;
        let port = listener
            .local_addr()
            .map_err(|e| ApiError::internal(e.to_string()))?
            .port();
        let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let (revoke, revoked) = watch::channel(false);
        let waiting = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let scope = Scope {
            app: app.clone(),
            turn: turn.into(),
            session: session.into(),
            token: token.clone(),
            cancel,
            revoked,
            waiting: waiting.clone(),
        };
        let router = Router::new()
            .route("/", post(call))
            .layer(axum::extract::DefaultBodyLimit::max(32 * 1024))
            .with_state(scope);
        let dir = tempfile::Builder::new()
            .prefix("grove-computer-")
            .tempdir()
            .map_err(|e| ApiError::internal(e.to_string()))?;
        let file = dir.path().join("bridge.json");
        crate::auth::write_secret_file(
            &file,
            &json!({"url":format!("http://127.0.0.1:{port}/"),"token":token}).to_string(),
        )
        .map_err(|e| ApiError::internal(e.to_string()))?;
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        app.computer
            .cli_turns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(turn.into());
        Ok(Some(Self {
            task,
            revoke,
            app: app.clone(),
            turn: turn.into(),
            _dir: dir,
            link: Link { file, waiting },
        }))
    }
}

async fn call(
    State(scope): State<Scope>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    // 브라우저 요청은 이 내부 IPC 표면을 사용할 수 없다.
    if headers.contains_key("origin")
        || headers.get("authorization").and_then(|h| h.to_str().ok())
            != Some(&format!("Bearer {}", scope.token))
    {
        return Err(ApiError::unauthorized("유효한 턴 연결이 아닙니다"));
    }
    if *scope.cancel.borrow() || *scope.revoked.borrow() {
        return Err(ApiError::conflict("cancelled", "종료된 턴 연결입니다"));
    }
    if scope
        .waiting
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_err()
    {
        return Err(ApiError::busy("앞 PC 제어 요청이 끝나지 않았습니다"));
    }
    let _waiting = Waiting(scope.waiting.clone());
    let args = body["arguments"].clone();
    let request = body["request_id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .ok_or_else(|| ApiError::invalid("request_id가 필요합니다"))?
        .to_string();
    super::validate(&args).map_err(|e| ApiError::invalid(e.message))?;
    let (turn, session, now, epoch) = (
        scope.turn.clone(),
        scope.session.clone(),
        scope.app.now(),
        scope.app.epoch.clone(),
    );
    let receipt = scope
        .app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let t = crate::runner::get_turn(&tx, &turn)?;
            if !permitted(&tx, &turn)? {
                return Err(ApiError::forbidden("이 대화는 PC 제어를 허용하지 않습니다"));
            }
            if t.session_id != session || t.status != "running" || !t.error.is_null() {
                return Err(ApiError::conflict(
                    "turn_ended",
                    "실행 중인 대화가 아닙니다",
                ));
            }
            let owner: String =
                tx.query_row("SELECT owner_epoch FROM turns WHERE id=?1", [&turn], |r| {
                    r.get(0)
                })?;
            if owner != epoch {
                return Err(ApiError::conflict(
                    "turn_ended",
                    "이 서버가 실행하는 턴이 아닙니다",
                ));
            }
            // 잃어버린 HTTP 응답의 재확인은 같은 request_id로만 한다.
            let existing: Option<String> = {
                use rusqlite::OptionalExtension;
                tx.query_row(
                    "SELECT id FROM tool_calls WHERE turn_id=?1 AND provider_call_id=?2",
                    rusqlite::params![turn, format!("computer-cli:{request}")],
                    |r| r.get(0),
                )
                .optional()?
            };
            let row = if let Some(id) = existing {
                let row = crate::approvals::get(&tx, &id)?;
                if row.args != args {
                    return Err(ApiError::conflict(
                        "idempotency_conflict",
                        "같은 요청 ID의 입력이 다릅니다",
                    ));
                }
                row
            } else {
                let session = crate::sessions::get_active(&tx, &session)?;
                let root = crate::sessions::exec_root(&tx, &session.id)?;
                crate::approvals::create_call(
                    &tx,
                    &now,
                    crate::approvals::approval_ttl(&tx, 300)?,
                    &session.id,
                    &session.project_id,
                    &root,
                    Some(&turn),
                    Some(&format!("computer-cli:{request}")),
                    super::NAME,
                    &args,
                )?
            };
            tx.commit()?;
            Ok(row)
        })
        .await?;
    scope.app.notify_events().await;
    if receipt.status == "approved" {
        crate::approvals::spawn_execute(&scope.app, receipt.id.clone());
    }
    let mut events = scope.app.seq_tx.subscribe();
    let mut cancel = scope.cancel.clone();
    let mut revoked = scope.revoked.clone();
    loop {
        let id = receipt.id.clone();
        let row = scope
            .app
            .db
            .call(move |c| crate::approvals::get(c, &id))
            .await?;
        if crate::approvals::TERMINAL.contains(&row.status.as_str()) {
            let mut content = vec![
                json!({"type":"text","text":json!({"call_id":row.id,"status":row.status,"result":row.result}).to_string()}),
            ];
            if row.status == "succeeded" {
                let data = scope.app.cfg.data_dir.clone();
                let sid = scope.session.clone();
                let output = row.result.clone();
                let image = tokio::task::spawn_blocking(move || super::image(&data, &sid, &output))
                    .await
                    .map_err(|e| ApiError::internal(e.to_string()))?
                    .map_err(|e| ApiError::conflict(e.code, e.message))?;
                if let Some(image) = image {
                    content.push(json!({"type":"image","mimeType":image.mime,"data":image.data}));
                }
            }
            return Ok(Json(
                json!({"content":content,"isError":row.status!="succeeded"}),
            ));
        }
        tokio::select! {
            changed=events.changed()=>{if changed.is_err(){return Err(ApiError::conflict("turn_ended","서버가 종료됐습니다"));}}
            _=cancel.wait_for(|v|*v)=>return Err(ApiError::conflict("cancelled","취소된 턴입니다")),
            _=revoked.wait_for(|v|*v)=>return Err(ApiError::conflict("cancelled","종료된 턴 연결입니다")),
        }
    }
}

/// 공식 CLI가 stdio MCP로 시작한다. 한 줄 JSON-RPC, stdout에는 protocol 외 출력을 쓰지 않는다.
pub fn mcp_main(file: Option<&String>) -> i32 {
    let result = (|| -> Result<(), String> {
        let file = file.ok_or("턴 연결 파일이 필요합니다")?;
        let mut bytes = vec![];
        std::fs::File::open(file)
            .and_then(|f| f.take(8193).read_to_end(&mut bytes))
            .map_err(|_| "턴 연결을 읽지 못했습니다")?;
        if bytes.len() > 8192 {
            return Err("턴 연결이 너무 큽니다".into());
        }
        let link: Value =
            serde_json::from_slice(&bytes).map_err(|_| "턴 연결 형식이 잘못됐습니다")?;
        let url = link["url"]
            .as_str()
            .ok_or("턴 연결 주소가 없습니다")?
            .to_string();
        let parsed = reqwest::Url::parse(&url).map_err(|_| "턴 연결 주소가 잘못됐습니다")?;
        if parsed.scheme() != "http"
            || parsed.host_str() != Some("127.0.0.1")
            || parsed.path() != "/"
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("loopback 턴 연결만 허용합니다".into());
        }
        let token = link["token"]
            .as_str()
            .ok_or("턴 연결 자격이 없습니다")?
            .to_string();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "MCP 실행기를 시작하지 못했습니다")?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(360))
            .build()
            .map_err(|_| "턴 연결을 시작하지 못했습니다")?;
        let mut input = std::io::stdin().lock();
        loop {
            let mut line = String::new();
            let n = input
                .by_ref()
                .take(32 * 1024 + 1)
                .read_line(&mut line)
                .map_err(|_| "MCP 입력을 읽지 못했습니다")?;
            if n == 0 {
                break;
            }
            if n > 32 * 1024 {
                return Err("MCP 입력 한도를 넘었습니다".into());
            }
            let request: Value =
                serde_json::from_str(&line).map_err(|_| "MCP 입력 형식이 잘못됐습니다")?;
            let Some(id) = request.get("id") else {
                continue;
            };
            let answer = match request["method"].as_str() {
                Some("initialize") => {
                    json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"grove-computer","version":crate::VERSION}})
                }
                Some("ping") => json!({}),
                Some("tools/list") => {
                    json!({"tools":[{"name":"computer","description":super::spec().description,"inputSchema":super::spec().schema}]})
                }
                Some("tools/call") if request["params"]["name"] == "computer" => {
                    let body = json!({"request_id":crate::util::new_id(),"arguments":request["params"]["arguments"]});
                    // 변경 요청은 자동 재시도하지 않는다. 응답 유실은 결과 불명으로 반환한다.
                    rt.block_on(async {
                        let response=client.post(&url).bearer_auth(&token).json(&body).send().await;
                        match response {
                            Ok(response) if response.status().is_success()=>{
                                let bytes=response.bytes().await.ok().filter(|b|b.len()<=super::MAX_REPLY);
                                bytes.and_then(|b|serde_json::from_slice::<Value>(&b).ok()).unwrap_or_else(unknown_result)
                            },
                            Ok(response)=>{
                                let status=response.status();
                                match response.json::<Value>().await{
                                    Ok(error)=>json!({"content":[{"type":"text","text":format!("Computer request refused (HTTP {}): {}",status.as_u16(),error["error"]["code"])}],"isError":true}),
                                    Err(_)=>unknown_result(),
                                }
                            },
                            Err(_)=>unknown_result(),
                        }
                    })
                }
                _ => {
                    println!(
                        "{}",
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Unsupported method"}})
                    );
                    continue;
                }
            };
            println!("{}", json!({"jsonrpc":"2.0","id":id,"result":answer}));
            std::io::stdout()
                .flush()
                .map_err(|_| "MCP 연결이 끊겼습니다")?;
        }
        Ok(())
    })();
    if result.is_err() {
        eprintln!("Computer Use MCP 연결을 종료했습니다");
        1
    } else {
        0
    }
}

fn unknown_result() -> Value {
    json!({"content":[{"type":"text","text":"Computer request outcome is unknown or unavailable. Do not replay input. Inspect the approval/call status and fresh target state."}],"isError":true})
}
