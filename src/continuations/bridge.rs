//! Native Codex/Claude use the same registry, approval and task execution path as API models.
use crate::{
    App,
    error::{ApiError, ApiResult},
};
use axum::{Json, Router, extract::State, http::HeaderMap, routing::post};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::io::{BufRead, Read, Write};
use std::time::Duration;
use tokio::sync::watch;

/// 턴 MCP의 일반 도구 응답 한도. 질문은 사용자 답을 기다려야 하므로 따로 둔다.
pub(crate) const TOOL_WAIT: Duration = Duration::from_secs(360);
/// 질문 답변 대기 한도. 넘기면 Grove가 질문을 닫고 모델에 알린다.
pub(crate) const QUESTION_WAIT: Duration = Duration::from_secs(24 * 3600);
/// CLI·MCP 연결 한도는 Grove가 질문을 닫고 결과를 돌려줄 여유를 더한다.
pub(crate) const QUESTION_CLIENT_WAIT: Duration = Duration::from_secs(QUESTION_WAIT.as_secs() + 120);

#[derive(Clone)]
pub struct Link {
    pub file: std::path::PathBuf,
    /// 턴 MCP를 띄울 grove 실행 파일(`continuation-mcp`).
    pub exe: std::path::PathBuf,
    pub waiting: Arc<AtomicUsize>,
    pub tools: Vec<&'static str>,
}
impl Link {
    pub(crate) fn claude_tools(&self) -> String {
        self.tools.iter().map(|name| format!("mcp__grove_continuations__{name}")).collect::<Vec<_>>().join(",")
    }
}
impl std::fmt::Debug for Link {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ContinuationLink(<turn-scoped>)")
    }
}
struct Waiting(Arc<AtomicUsize>);
impl Drop for Waiting {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct Bridge {
    task: tokio::task::JoinHandle<()>,
    _dir: tempfile::TempDir,
    revoke: watch::Sender<bool>,
    app: App,
    turn: String,
    pub link: Link,
}
impl Drop for Bridge {
    fn drop(&mut self) {
        self.revoke.send_replace(true);
        self.task.abort();
        let (app, turn) = (self.app.clone(), self.turn.clone());
        tokio::spawn(async move {
            let cancels = app.cancels.clone();
            let now = app.now();
            let result=app.db.call(move |c| {
                let tx=c.transaction()?;
                for call in crate::approvals::list_for_turn(&tx,&turn)? {
                    if !call.provider_call_id.as_deref().is_some_and(|v|v.starts_with("continuation-cli:")) { continue; }
                    cancels.cancel(&call.id);
                    crate::approvals::finish(&tx,&now,&call.id,&["pending_approval","approved"],"cancelled",Some(json!({"error":{"code":"turn_ended","message":"턴 도구 연결이 종료돼 시작하지 않았습니다"}})))?;
                }
                tx.commit()?; Ok(())
            }).await;
            if let Err(e) = result {
                tracing::warn!(code = e.code, "후속 작업 연결 정리 실패");
            }
            app.notify_events().await;
        });
    }
}

#[derive(Clone)]
struct Scope {
    app: App,
    turn: String,
    token: String,
    cancel: watch::Receiver<bool>,
    revoked: watch::Receiver<bool>,
    waiting: Arc<AtomicUsize>,
    tools: Vec<&'static str>,
}

impl Bridge {
    pub async fn start(
        app: &App,
        turn: &str,
        cancel: watch::Receiver<bool>,
    ) -> ApiResult<Option<Self>> {
        let tid = turn.to_string();
        let tools = app
            .db
            .call(move |c| {
                let t = crate::runner::get_turn(c, &tid)?;
                if t.definition["limits"].is_object() { return Ok(vec![]); }
                Ok([super::NAME, "shell", "agent", "ask_user"].into_iter()
                    .filter(|name| super::check_permission(c, &t, name).is_ok()
                        && (*name != "shell" || super::check_permission(c, &t, super::NAME).is_ok()))
                    .collect::<Vec<_>>())
            })
            .await?;
        if tools.is_empty() {
            return Ok(None);
        }
        let exe = app.cfg.internal_exe()
            .ok_or_else(|| ApiError::internal("턴 도구 실행 경로를 확인하지 못했습니다"))?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| ApiError::internal("후속 작업 연결을 시작하지 못했습니다"))?;
        let addr = listener
            .local_addr()
            .map_err(|_| ApiError::internal("후속 작업 주소를 확인하지 못했습니다"))?;
        let token = crate::util::random_secret(32);
        let credentials = json!({"url":format!("http://{addr}/"),"token":token,"tools":tools}).to_string();
        let (dir, file) = tokio::task::spawn_blocking(move || -> ApiResult<_> {
            let dir = tempfile::Builder::new()
                .prefix("grove-continuation-")
                .tempdir()
                .map_err(|_| ApiError::internal("턴 연결 파일을 만들지 못했습니다"))?;
            let file = dir.path().join("link.json");
            crate::auth::write_secret_file(&file, &credentials)
                .map_err(|_| ApiError::internal("턴 연결 자격을 기록하지 못했습니다"))?;
            Ok((dir, file))
        })
        .await
        .map_err(|_| ApiError::internal("턴 연결 파일을 준비하지 못했습니다"))??;
        let (revoke, revoked) = watch::channel(false);
        let waiting = Arc::new(AtomicUsize::new(0));
        let scope = Scope {
            app: app.clone(),
            turn: turn.into(),
            token,
            cancel,
            revoked,
            waiting: waiting.clone(),
            tools: tools.clone(),
        };
        let router = Router::new()
            .route("/", post(call))
            .layer(axum::extract::DefaultBodyLimit::max(32 * 1024))
            .with_state(scope);
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Ok(Some(Self {
            task,
            _dir: dir,
            revoke,
            link: Link { file, exe, waiting, tools },
            app: app.clone(),
            turn: turn.into(),
        }))
    }
}

async fn call(
    State(scope): State<Scope>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let supplied = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if headers.contains_key("origin")
        || !crate::util::ct_eq(
            supplied.as_bytes(),
            format!("Bearer {}", scope.token).as_bytes(),
        )
    {
        return Err(ApiError::unauthorized("유효한 턴 연결이 아닙니다"));
    }
    if *scope.cancel.borrow() || *scope.revoked.borrow() {
        return Err(ApiError::conflict("turn_ended", "종료된 턴입니다"));
    }
    scope.waiting.fetch_add(1, Ordering::AcqRel);
    let _waiting = Waiting(scope.waiting.clone());
    let name = body["name"].as_str().unwrap_or("").to_string();
    if !scope.tools.contains(&name.as_str()) {
        return Err(ApiError::invalid("지원하지 않는 도구입니다"));
    }
    let args = body["arguments"].clone();
    let question = name == "ask_user";
    // This bridge exposes only the background variant; normal native tools remain native.
    if name == "shell" && (args["background"] != true || args["follow_up"].as_str().is_none()) {
        return Err(ApiError::invalid(
            "background=true와 follow_up이 필요합니다",
        ));
    }
    let request = body["request_id"]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .ok_or_else(|| ApiError::invalid("request_id가 필요합니다"))?
        .to_string();
    let (turn, epoch, now) = (scope.turn.clone(), scope.app.epoch.clone(), scope.app.now());
    let receipt = scope
        .app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let t = crate::runner::get_turn(&tx, &turn)?;
            if t.status != "running" || !t.error.is_null() {
                return Err(ApiError::conflict("turn_ended", "실행 중인 턴이 아닙니다"));
            }
            let owner: String =
                tx.query_row("SELECT owner_epoch FROM turns WHERE id=?1", [&turn], |r| {
                    r.get(0)
                })?;
            if owner != epoch {
                return Err(ApiError::conflict("turn_ended", "이 서버의 턴이 아닙니다"));
            }
            if t.definition["limits"].is_object() {
                return Err(ApiError::forbidden("예약 턴의 도구는 Grove 실행 루프를 사용합니다"));
            }
            super::check_permission(&tx, &t, &name)?;
            if name == "shell" { super::check_permission(&tx, &t, super::NAME)?; }
            let provider_id = format!("continuation-cli:{request}");
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM tool_calls WHERE turn_id=?1 AND provider_call_id=?2",
                    params![turn, provider_id],
                    |r| r.get(0),
                )
                .optional()?;
            let row = if let Some(id) = existing {
                let row = crate::approvals::get(&tx, &id)?;
                if row.args != args || row.name != name {
                    return Err(ApiError::conflict(
                        "idempotency_conflict",
                        "같은 request_id의 입력이 다릅니다",
                    ));
                }
                row
            } else {
                let s = crate::sessions::get_active(&tx, &t.session_id)?;
                let root = crate::sessions::exec_root(&tx, &s.id)?;
                crate::approvals::create_call(
                    &tx,
                    &now,
                    crate::approvals::approval_ttl(&tx, 300)?,
                    &s.id,
                    &s.project_id,
                    &root,
                    Some(&turn),
                    Some(&provider_id),
                    &name,
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
    let timer = tokio::time::sleep(QUESTION_WAIT);
    tokio::pin!(timer);
    let (mut expired, mut closed) = (false, false);
    loop {
        let id = receipt.id.clone();
        let row = scope
            .app
            .db
            .call(move |c| crate::approvals::get(c, &id))
            .await?;
        if crate::approvals::TERMINAL.contains(&row.status.as_str()) {
            return Ok(Json(
                json!({"content":[{"type":"text","text":json!({"call_id":row.id,"status":row.status,"result":row.result}).to_string()}],"isError":row.status!="succeeded"}),
            ));
        }
        tokio::select! {
            _=events.changed()=>{},
            _=&mut timer, if question && !expired=>expired = true,
            _=cancel.wait_for(|v|*v)=>return Err(ApiError::conflict("cancelled","취소된 턴입니다")),
            _=revoked.wait_for(|v|*v)=>return Err(ApiError::conflict("turn_ended","종료된 턴입니다")),
        }
        // select의 watch 참조가 풀린 뒤 닫는다. 다음 조회가 닫힌 결과를 돌려준다.
        if expired && !closed {
            closed = true;
            close_question(scope.app.clone(), receipt.id.clone()).await?;
        }
    }
}

/// 답이 오지 않은 질문을 닫는다. 이미 답했거나 닫혔으면 그대로 둔다.
async fn close_question(app: App, id: String) -> ApiResult<()> {
    let now = app.now();
    app.db.call(move |c| {
        let tx = c.transaction()?;
        crate::approvals::finish(&tx, &now, &id, &["awaiting_input"], "cancelled", Some(json!({
            "cancelled": true, "code": "question_timeout", "message": "답을 받지 못해 질문을 닫았습니다",
        })))?;
        tx.commit()?;
        Ok(())
    }).await?;
    app.notify_events().await;
    Ok(())
}

pub fn mcp_main(file: Option<&String>) -> i32 {
    let mut shell = crate::tools::spec("shell").expect("registered shell");
    shell.description = "사용자가 요청한 다운로드·설치 등 오래 걸리는 명령을 Grove 소유 백그라운드 작업으로 시작하고, 끝나면 follow_up 지시로 같은 대화에서 AI가 한 번 보고한다. background=true와 follow_up이 필수다. 명령 실행은 Grove의 기존 정책·승인을 거치며 이 도구 자체는 새 사용자 승인이 아니다. 서버 재시작으로 결과가 불명이면 명령을 재실행하지 않는다.";
    let mut agent = crate::tools::spec("agent").expect("registered agent");
    agent.description = "Grove 자식 에이전트에게 위임한다. spawn(agent_id·brief), send(run_id·brief), status/wait(run_id), list, cancel(run_id)을 쓴다. 위임은 Grove 정책과 승인을 따른다. status와 wait는 즉시 현재 상태를 반환한다. 응답을 보내면 Grove가 모델 호출 슬롯을 반환하고 이 턴이 시작한 자식의 결과를 기다린 뒤 알려준다.";
    let mut ask = crate::tools::spec("ask_user").expect("registered ask_user");
    ask.description = "사용자만 정할 수 있는 결정(선택지 고르기, 요청 범위 밖 작업 승인, 위험한 대상 확인)을 Grove 질문 창으로 묻고 답을 기다린다. 답변 본문에 질문을 글로 쓰지 말고 이 도구를 쓴다. options는 짧은 label과 한 줄 description으로 주고, allow_free_text(기본 true)면 직접 입력도 받는다. 결과는 사용자가 고른 choices와 입력한 text다. cancelled면 사용자가 답하지 않고 닫은 것이니 답을 추측하지 않는다. 스스로 알아낼 수 있는 사실은 묻지 않는다.";
    stdio_main(file, "grove-continuations", vec![super::spec(), shell, agent, ask])
}

/// 응답 본문 상한. 넘으면 결과 불명으로 돌려준다.
const MAX_REPLY: usize = 8 * 1024 * 1024;

/// Shared bounded stdio transport; the HTTP bridges retain independent authorization boundaries.
fn stdio_main(file:Option<&String>,server_name:&str,specs:Vec<crate::tools::ToolSpec>) -> i32 {
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
        let granted = link["tools"].as_array().ok_or("턴 도구 권한 목록이 없습니다")?;
        let specs: Vec<_> = specs.into_iter().filter(|spec| granted.iter().any(|name| name == spec.name)).collect();
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
                    json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":server_name,"version":crate::VERSION}})
                }
                Some("ping") => json!({}),
                Some("tools/list") => {
                    json!({"tools":specs.iter().map(|s|json!({"name":s.name,"description":s.description,"inputSchema":s.schema})).collect::<Vec<_>>()})
                }
                Some("tools/call") if specs.iter().any(|s|request["params"]["name"]==s.name) => {
                    let body = json!({"request_id":crate::util::new_id(),"name":request["params"]["name"],"arguments":request["params"]["arguments"]});
                    let wait = if request["params"]["name"] == "ask_user" { QUESTION_CLIENT_WAIT } else { TOOL_WAIT };
                    // 변경 요청은 자동 재시도하지 않는다. 응답 유실은 결과 불명으로 반환한다.
                    rt.block_on(async {
                        let response=client.post(&url).timeout(wait).bearer_auth(&token).json(&body).send().await;
                        match response {
                            Ok(response) if response.status().is_success()=>{
                                let bytes=response.bytes().await.ok().filter(|b|b.len()<=MAX_REPLY);
                                bytes.and_then(|b|serde_json::from_slice::<Value>(&b).ok()).unwrap_or_else(unknown_result)
                            },
                            Ok(response)=>{
                                let status=response.status();
                                match response.json::<Value>().await{
                                    Ok(error)=>json!({"content":[{"type":"text","text":format!("Tool request refused (HTTP {}): {}",status.as_u16(),error["error"]["code"])}],"isError":true}),
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
        eprintln!("턴 도구 MCP 연결을 종료했습니다");
        1
    } else {
        0
    }
}

fn unknown_result() -> Value {
    json!({"content":[{"type":"text","text":"Tool request outcome is unknown or unavailable. Do not replay input. Inspect the approval/call and continuation/task status, then fresh target state."}],"isError":true})
}
