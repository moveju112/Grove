//! 유한 수명의 MCP 연결 확인. 서버가 제공한 본문·stderr를 오류 로그로 내보내지 않는다.
use super::ServerConfig;
use crate::error::{ApiError, ApiResult};
use crate::procs::{self, Limits};
use crate::provider::sse::SseParser;
use axum::http::StatusCode;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const MAX_FRAME: usize = 1024 * 1024;
const MAX_TOTAL: usize = 4 * MAX_FRAME;
const MAX_MESSAGES: usize = 512;
const VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

fn protocol() -> ApiError { ApiError::new(StatusCode::BAD_GATEWAY, "mcp_protocol", "MCP 응답 형식이 올바르지 않거나 지원 범위를 벗어났습니다") }
fn transport() -> ApiError { ApiError::new(StatusCode::BAD_GATEWAY, "mcp_transport", "MCP 연결이 끊겼거나 요청을 전달하지 못했습니다") }
fn too_large() -> ApiError { ApiError::new(StatusCode::BAD_GATEWAY, "mcp_limit", "MCP 응답·도구 목록이 허용 한도를 넘었습니다") }
fn http_status(status: reqwest::StatusCode) -> ApiError {
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        ApiError::new(StatusCode::FAILED_DEPENDENCY, "mcp_auth_required", "MCP 서버 인증이 필요합니다")
    } else {
        ApiError::new(StatusCode::BAD_GATEWAY, "mcp_http", format!("MCP 서버 HTTP 오류 ({})", status.as_u16()))
    }
}

struct Process {
    child: Option<Child>,
    owned: Option<procs::Owned>,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    scratch: Option<Scratch>,
}

struct Scratch(Option<PathBuf>);
impl Scratch {
    async fn close(mut self) {
        if let Some(path) = self.0.take() { let _ = tokio::fs::remove_dir_all(path).await; }
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            // 할당 작업의 대기가 취소돼도 성공적으로 생성한 디렉터리는 회수한다.
            let _ = std::thread::Builder::new().name("mcp-scratch-cleanup".into()).spawn(move || { let _ = std::fs::remove_dir_all(path); });
        }
    }
}

impl Process {
    async fn close(&mut self) {
        self.input.take();
        if let Some(mut child) = self.child.take() {
            let exited = tokio::time::timeout(std::time::Duration::from_millis(200), child.wait()).await.is_ok_and(|r| r.is_ok());
            if let Some(owned) = self.owned.take() {
                let _ = tokio::task::spawn_blocking(move || owned.kill_tree(!exited)).await;
            }
            let _ = child.wait().await;
        }
        if let Some(scratch) = self.scratch.take() {
            // 이 연결 확인에서 고유하게 만든 임시 디렉터리만 지운다.
            scratch.close().await;
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        // HTTP 응답 대기가 폐기돼도 소유한 자식과 임시 디렉터리를 정리한다.
        self.input.take();
        let child = self.child.take();
        let owned = self.owned.take();
        let scratch = self.scratch.take();
        if child.is_some() || scratch.is_some() {
            tokio::spawn(async move {
                if let Some(mut child) = child {
                    if let Some(owned) = owned {
                        let _ = tokio::task::spawn_blocking(move || owned.kill_tree(true)).await;
                    }
                    let _ = child.wait().await;
                }
                if let Some(scratch) = scratch { scratch.close().await; }
            });
        }
    }
}

struct Http {
    client: reqwest::Client,
    endpoint: reqwest::Url,
    headers: HeaderMap,
    session: Option<String>,
    version: Option<String>,
    legacy: Option<reqwest::Response>,
    parser: SseParser,
    incoming: VecDeque<Value>,
}

impl Drop for Http {
    fn drop(&mut self) {
        if let Some(session) = self.session.take() {
            let (client, endpoint, headers, version) = (self.client.clone(),self.endpoint.clone(),self.headers.clone(),self.version.clone());
            tokio::spawn(terminate_http(client,endpoint,headers,session,version));
        }
    }
}

async fn terminate_http(client: reqwest::Client, endpoint: reqwest::Url, headers: HeaderMap, session: String, version: Option<String>) {
    let mut request = client.delete(endpoint).headers(headers).header("mcp-session-id",session_header(&session));
    if let Some(version) = version { request = request.header("mcp-protocol-version",version); }
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1),request.send()).await;
}

fn session_header(id: &str) -> HeaderValue {
    let mut value=HeaderValue::from_str(id).expect("validated visible ASCII MCP session id");
    value.set_sensitive(true);
    value
}

enum Transport { Stdio(Process), Http(Http) }

pub struct Client {
    transport: Transport,
    next_id: u64,
    bytes: usize,
    messages: usize,
    pending: Option<u64>,
    pub(super) catalog_changed: bool,
    pub(super) progress: Option<tokio::sync::watch::Sender<Value>>,
    progress_token: Option<String>,
    last_progress: Option<f64>,
}

impl Client {
    /// 참조한 secret만 받고 부모 프로세스의 자격증명 환경을 상속하지 않는다.
    pub async fn open(config: &ServerConfig, secrets: &BTreeMap<String, String>, tag: &str, limits: Limits, cwd: Option<&std::path::Path>) -> ApiResult<Self> {
        let transport = match config {
            ServerConfig::Stdio { command, args, env_secrets } => {
                let path = std::env::temp_dir().join(format!("grove-mcp-{}", crate::util::new_id()));
                let scratch = tokio::task::spawn_blocking(move || {
                    let mut builder = std::fs::DirBuilder::new();
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::DirBuilderExt;
                        builder.mode(0o700);
                    }
                    builder.create(&path)?;
                    Ok::<_,std::io::Error>(Scratch(Some(path)))
                }).await.map_err(|_| ApiError::internal("MCP 임시 디렉터리 준비가 중단됐습니다"))?
                    .map_err(|_| ApiError::internal("MCP 임시 디렉터리를 만들 수 없습니다"))?;
                let mut cmd = Command::new(command);
                cmd.args(args).current_dir(cwd.unwrap_or_else(||scratch.0.as_ref().expect("allocated scratch").as_path())).env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
                for name in ["PATH", "HOME", "USERPROFILE", "SystemRoot", "COMSPEC", "TEMP", "TMP", "TMPDIR"] {
                    if let Some(v) = std::env::var_os(name) { cmd.env(name, v); }
                }
                for (name, id) in env_secrets {
                    cmd.env(name, secrets.get(id).ok_or_else(|| ApiError::invalid("MCP secret 참조를 읽을 수 없습니다"))?);
                }
                procs::prepare(&mut cmd, tag, limits);
                let mut child = match cmd.spawn() {
                    Ok(child) => child,
                    Err(e) => {
                        scratch.close().await;
                        let code = if e.kind() == std::io::ErrorKind::NotFound { "dependency_missing" } else { "mcp_spawn" };
                        return Err(ApiError::new(StatusCode::FAILED_DEPENDENCY, code, "MCP 실행 파일을 시작할 수 없습니다"));
                    }
                };
                let owned = match procs::adopt(&mut child, tag, limits) {
                    Ok(owned) => owned,
                    Err(_) => {
                        let _ = child.kill().await;
                        scratch.close().await;
                        return Err(ApiError::new(StatusCode::FAILED_DEPENDENCY, "mcp_isolation", "MCP 프로세스 소유권을 확보하지 못했습니다"));
                    }
                };
                let input = child.stdin.take().expect("piped stdin");
                let output = BufReader::new(child.stdout.take().expect("piped stdout"));
                Transport::Stdio(Process { child: Some(child), owned: Some(owned), input: Some(input), output, scratch: Some(scratch) })
            }
            ServerConfig::Http { endpoint, header_secrets } | ServerConfig::Sse { endpoint, header_secrets } => {
                let mut headers = HeaderMap::new();
                for (name, id) in header_secrets {
                    let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| protocol())?;
                    let mut value = HeaderValue::from_str(secrets.get(id).ok_or_else(|| ApiError::invalid("MCP secret 참조를 읽을 수 없습니다"))?)
                        .map_err(|_| ApiError::invalid("MCP secret을 헤더 값으로 사용할 수 없습니다"))?;
                    value.set_sensitive(true);
                    headers.insert(name, value);
                }
                // 인증 헤더가 다른 origin으로 넘어가지 않게 redirect·환경 proxy를 사용하지 않는다.
                let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().build().map_err(|_| transport())?;
                let mut http = Http {
                    client, endpoint: reqwest::Url::parse(endpoint).map_err(|_| protocol())?, headers,
                    session: None, version: None, legacy: None, parser: SseParser::default(), incoming: VecDeque::new(),
                };
                if matches!(config, ServerConfig::Sse { .. }) {
                    let mut stream = http.client.get(http.endpoint.clone()).headers(http.headers.clone()).header("accept", "text/event-stream")
                        .send().await.map_err(|_| transport())?;
                    if !stream.status().is_success() { return Err(http_status(stream.status())); }
                    check_content_type(&stream, "text/event-stream")?;
                    let original = http.endpoint.clone();
                    let mut size = 0;
                    'endpoint: loop {
                        let chunk = stream.chunk().await.map_err(|_| transport())?.ok_or_else(transport)?;
                        size += chunk.len();
                        if size > MAX_FRAME { return Err(too_large()); }
                        let mut found = false;
                        for event in http.parser.push(&chunk).map_err(|_| protocol())? {
                            if event.event.as_deref() == Some("endpoint") {
                                let endpoint = original.join(&event.data).map_err(|_| protocol())?;
                                if endpoint.origin() != original.origin() || !endpoint.username().is_empty() || endpoint.password().is_some() || endpoint.fragment().is_some() {
                                    return Err(protocol());
                                }
                                http.endpoint = endpoint;
                                found = true;
                            } else if !event.data.is_empty() {
                                return Err(protocol());
                            }
                        }
                        if found { break 'endpoint; }
                    }
                    http.legacy = Some(stream);
                }
                Transport::Http(http)
            }
        };
        Ok(Self { transport, next_id: 1, bytes: 0, messages: 0, pending: None, catalog_changed:false,
            progress:None,progress_token:None,last_progress:None })
    }

    fn count(&mut self, n: usize) -> ApiResult<()> {
        self.bytes += n;
        self.messages += 1;
        if self.bytes > MAX_TOTAL || self.messages > MAX_MESSAGES { Err(too_large()) } else { Ok(()) }
    }

    async fn send(&mut self, message: &Value) -> ApiResult<Option<reqwest::Response>> {
        let data = serde_json::to_vec(message)?;
        match &mut self.transport {
            Transport::Stdio(p) => {
                let input = p.input.as_mut().ok_or_else(transport)?;
                input.write_all(&data).await.map_err(|_| transport())?;
                input.write_all(b"\n").await.map_err(|_| transport())?;
                input.flush().await.map_err(|_| transport())?;
                Ok(None)
            }
            Transport::Http(h) => {
                let mut request = h.client.post(h.endpoint.clone()).headers(h.headers.clone())
                    .header("accept", "application/json, text/event-stream").header("content-type", "application/json").body(data);
                if let Some(session) = &h.session { request = request.header("mcp-session-id", session_header(session)); }
                if let Some(version) = &h.version { request = request.header("mcp-protocol-version", version); }
                let response = request.send().await.map_err(|_| transport())?;
                if !response.status().is_success() { return Err(http_status(response.status())); }
                if h.legacy.is_some() || message.get("method").is_none() || message.get("id").is_none() {
                    if response.status() != StatusCode::ACCEPTED { return Err(protocol()); }
                    Ok(None)
                } else {
                    if self.next_id == 2 {
                        if let Some(id) = response.headers().get("mcp-session-id") {
                            let id = id.to_str().map_err(|_| protocol())?;
                            if id.is_empty() || id.len() > 1024 || !id.bytes().all(|b| (0x21..=0x7e).contains(&b)) { return Err(protocol()); }
                            h.session = Some(id.to_string());
                        }
                    }
                    Ok(Some(response))
                }
            }
        }
    }

    async fn receive(&mut self, response: &mut Option<reqwest::Response>, parser: &mut SseParser, json: bool, buffer: &mut Vec<u8>) -> ApiResult<Value> {
        match &mut self.transport {
            Transport::Stdio(p) => {
                let mut line = Vec::new();
                let n = (&mut p.output).take((MAX_FRAME + 1) as u64).read_until(b'\n', &mut line).await.map_err(|_| transport())?;
                if n == 0 { return Err(transport()); }
                if n > MAX_FRAME || line.last() != Some(&b'\n') { return Err(too_large()); }
                self.count(n)?;
                serde_json::from_slice(&line).map_err(|_| protocol())
            }
            Transport::Http(h) => {
                loop {
                    if let Some(message) = h.incoming.pop_front() { return Ok(message); }
                    let legacy = h.legacy.is_some();
                    let resp = if legacy { h.legacy.as_mut() } else { response.as_mut() }.ok_or_else(protocol)?;
                    let chunk = resp.chunk().await.map_err(|_| transport())?;
                    let Some(chunk) = chunk else {
                        if json {
                            self.messages += 1;
                            if self.messages > MAX_MESSAGES { return Err(too_large()); }
                            return serde_json::from_slice(buffer).map_err(|_| protocol());
                        }
                        return Err(transport());
                    };
                    self.bytes += chunk.len();
                    if self.bytes > MAX_TOTAL { return Err(too_large()); }
                    if json {
                        buffer.extend_from_slice(&chunk);
                        if buffer.len() > MAX_FRAME { return Err(too_large()); }
                    } else {
                        let events = if legacy { h.parser.push(&chunk) } else { parser.push(&chunk) }.map_err(|_| protocol())?;
                        for ev in events {
                            if ev.data.len() > MAX_FRAME { return Err(too_large()); }
                            if !ev.data.is_empty() {
                                self.messages += 1;
                                if self.messages > MAX_MESSAGES { return Err(too_large()); }
                                h.incoming.push_back(serde_json::from_str(&ev.data).map_err(|_| protocol())?);
                            }
                        }
                    }
                }
            }
        }
    }

    fn report_progress(&mut self, params: &Value) {
        let Some(token)=self.progress_token.as_deref() else { return; };
        if self.pending.is_none() || params["progressToken"].as_str()!=Some(token) { return; }
        let Some(value)=params["progress"].as_f64().filter(|v|v.is_finite()) else { return; };
        if self.last_progress.is_some_and(|last|value<=last) { return; }
        self.last_progress=Some(value);
        if let Some(sender)=&self.progress {
            let total=params.get("total").filter(|v|v.as_f64().is_some_and(f64::is_finite));
            // 원격 자유문구는 credential을 반사할 수 있으므로 숫자만 전달한다.
            sender.send_replace(json!({"value":params["progress"],"total":total}));
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> ApiResult<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.pending = Some(id);
        let mut response = self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
        let json = if let Some(r) = &response {
            if content_type(r) == Some("application/json") { true }
            else { check_content_type(r, "text/event-stream")?; false }
        } else { false };
        let mut parser = SseParser::default();
        let mut buffer = Vec::new();
        loop {
            let message = self.receive(&mut response, &mut parser, json, &mut buffer).await?;
            if message["jsonrpc"] != "2.0" || !message.is_object() { return Err(protocol()); }
            if let Some(method) = message.get("method").and_then(Value::as_str) {
                if method=="notifications/tools/list_changed" { self.catalog_changed=true; }
                if method=="notifications/progress" && message.get("id").is_none() { self.report_progress(&message["params"]); }
                if let Some(request_id) = message.get("id") {
                    let answer = if method == "ping" {
                        json!({ "jsonrpc": "2.0", "id": request_id, "result": {} })
                    } else {
                        json!({ "jsonrpc": "2.0", "id": request_id, "error": { "code": -32601, "message": "Method not supported" } })
                    };
                    self.send(&answer).await?;
                }
                if json { return Err(protocol()); }
                continue;
            }
            if message["id"] != id { return Err(protocol()); }
            self.pending = None;
            if message.get("error").is_some() {
                // 원격 error.message/data가 자격증명이나 본문을 반사할 수 있다.
                return Err(ApiError::new(StatusCode::BAD_GATEWAY, "mcp_rpc", "MCP 서버가 요청을 거절했습니다"));
            }
            return message.get("result").cloned().ok_or_else(protocol);
        }
    }

    pub async fn inspect(&mut self, namespace: &str) -> ApiResult<Value> {
        let init = self.request("initialize", json!({
            "protocolVersion": VERSIONS[0], "capabilities": {},
            "clientInfo": { "name": "grove", "version": crate::VERSION },
        })).await?;
        let version = init["protocolVersion"].as_str().filter(|v| VERSIONS.contains(v)).ok_or_else(protocol)?;
        if !init["capabilities"].is_object() || !init["serverInfo"]["name"].is_string() || !init["serverInfo"]["version"].is_string() { return Err(protocol()); }
        if let Transport::Http(h) = &mut self.transport { h.version = Some(version.to_string()); }
        self.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await?;
        self.catalog_changed=false;
        let mut tools = vec![];
        let mut names = BTreeSet::new();
        let mut cursors = BTreeSet::new();
        let mut cursor: Option<String> = None;
        if init["capabilities"].get("tools").is_some() {
            if !init["capabilities"]["tools"].is_object() { return Err(protocol()); }
            loop {
                let page = self.request("tools/list", cursor.as_ref().map(|c| json!({ "cursor": c })).unwrap_or_else(|| json!({}))).await?;
                for tool in page["tools"].as_array().ok_or_else(protocol)? {
                    let name = tool["name"].as_str().ok_or_else(protocol)?;
                    if name.is_empty() || name.len() > 128 || !name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
                        || !names.insert(name.to_string()) || tools.len() == 256 || tool["inputSchema"]["type"] != "object"
                    { return Err(protocol()); }
                    if !valid_schema(&tool["inputSchema"],0,&mut 4096) { return Err(protocol()); }
                    tools.push(json!({
                        "name": name, "namespace": format!("{namespace}/{name}"),
                        "description": tool.get("description").and_then(Value::as_str).unwrap_or(""),
                        "input_schema": tool["inputSchema"],
                        // 원격 annotation으로 Grove 권한·read-only 판정을 바꾸지 않는다.
                        "callable": false,
                    }));
                }
                cursor = match page.get("nextCursor") {
                    None => None,
                    Some(v) => Some(v.as_str().filter(|s| !s.is_empty() && s.len() <= 4096).ok_or_else(protocol)?.to_string()),
                };
                let Some(next) = &cursor else { break };
                if !cursors.insert(next.clone()) { return Err(protocol()); }
            }
        }
        let info = &init["serverInfo"];
        if self.catalog_changed {
            return Err(ApiError::conflict("mcp_schema_changed","조회 중 MCP 도구 목록이 바뀌었습니다. 연결을 다시 확인하세요"));
        }
        Ok(json!({
            "protocol_version": version, "server_info": { "name": info["name"], "version": info["version"] },
            "tools": tools, "tool_count": tools.len(), "connection_closed_after_check": true,
        }))
    }

    pub async fn call_tool(&mut self, name: &str, arguments: &Value, progress_token: &str) -> ApiResult<Value> {
        self.progress_token=Some(progress_token.to_string());
        self.last_progress=None;
        let result=self.request("tools/call",json!({"name":name,"arguments":arguments,"_meta":{"progressToken":progress_token}})).await;
        self.progress_token=None;
        let result=result?;
        if !result.is_object() || (result.get("content").is_some_and(|v|!v.is_array()))
            || (result.get("isError").is_some_and(|v|!v.is_boolean()))
            || (result.get("content").is_none() && !result.get("structuredContent").is_some_and(Value::is_object))
        { return Err(protocol()); }
        if serde_json::to_vec(&result)?.len()>crate::tools::MAX_OUTPUT-512 { return Err(too_large()); }
        Ok(result)
    }

    pub async fn close(&mut self) {
        // 프로토콜상 client는 initialize 요청을 취소할 수 없다.
        if let Some(id) = self.pending.take().filter(|id|*id!=1) {
            let cancellation = json!({ "jsonrpc":"2.0", "method":"notifications/cancelled", "params":{ "requestId":id, "reason":"Connection check ended" } });
            let _ = tokio::time::timeout(std::time::Duration::from_millis(200),self.send(&cancellation)).await;
        }
        match &mut self.transport {
            Transport::Stdio(p) => p.close().await,
            Transport::Http(h) => {
                h.legacy.take();
                if let Some(session) = h.session.take() {
                    terminate_http(h.client.clone(),h.endpoint.clone(),h.headers.clone(),session,h.version.clone()).await;
                }
            }
        }
    }
}

fn content_type(response: &reqwest::Response) -> Option<&str> {
    response.headers().get("content-type")?.to_str().ok()?.split(';').next().map(str::trim)
}
fn check_content_type(response: &reqwest::Response, expected: &str) -> ApiResult<()> {
    if content_type(response) == Some(expected) { Ok(()) } else { Err(protocol()) }
}

/// 일반 JSON Schema의 형태·복잡도만 검사한다. $ref를 가져오거나 원격 schema를 코드로 실행하지 않는다.
/// 입력값의 최종 schema 검증은 MCP 서버가 수행하며 권한은 schema와 별개로 Grove가 강제한다.
fn valid_schema(value: &Value, depth: usize, budget: &mut usize) -> bool {
    if depth>32 || *budget==0 { return false; }
    *budget-=1;
    if value.is_boolean() { return true; }
    let Some(object)=value.as_object() else { return false; };
    if let Some(kind)=object.get("type") {
        let valid=|v:&Value|v.as_str().is_some_and(|s|matches!(s,"null"|"boolean"|"object"|"array"|"number"|"integer"|"string"));
        if !valid(kind) && !kind.as_array().is_some_and(|a|!a.is_empty() && a.iter().all(valid)) { return false; }
    }
    for (key,value) in object {
        let ok=match key.as_str() {
            "properties"|"patternProperties"|"$defs"|"definitions"|"dependentSchemas" =>
                value.as_object().is_some_and(|m|m.values().all(|v|valid_schema(v,depth+1,budget))),
            "allOf"|"anyOf"|"oneOf"|"prefixItems" =>
                value.as_array().is_some_and(|a|!a.is_empty() && a.iter().all(|v|valid_schema(v,depth+1,budget))),
            "items" => if let Some(a)=value.as_array() { a.iter().all(|v|valid_schema(v,depth+1,budget)) } else { valid_schema(value,depth+1,budget) },
            "additionalProperties"|"additionalItems"|"unevaluatedProperties"|"unevaluatedItems"|"contains"|"propertyNames"|"not"|"if"|"then"|"else" =>
                valid_schema(value,depth+1,budget),
            "required" => value.as_array().is_some_and(|a|a.iter().all(Value::is_string) && a.iter().filter_map(Value::as_str).collect::<BTreeSet<_>>().len()==a.len()),
            "dependentRequired" => value.as_object().is_some_and(|m|m.values().all(|v|v.as_array().is_some_and(|a|a.iter().all(Value::is_string)))),
            "enum" => value.as_array().is_some_and(|a|!a.is_empty()),
            "$ref"|"$id"|"$schema"|"$anchor"|"title"|"description"|"format"|"pattern" => value.is_string(),
            "minLength"|"maxLength"|"minItems"|"maxItems"|"minProperties"|"maxProperties"|"minContains"|"maxContains" => value.as_u64().is_some(),
            "minimum"|"maximum"|"exclusiveMinimum"|"exclusiveMaximum" => value.is_number(),
            "multipleOf" => value.as_f64().is_some_and(|n|n>0.0),
            "uniqueItems"|"readOnly"|"writeOnly"|"deprecated" => value.is_boolean(),
            _ => true,
        };
        if !ok { return false; }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn progress_without_an_active_requested_token_is_not_published() {
        let config=ServerConfig::Http {endpoint:"http://127.0.0.1:1/mcp".into(),header_secrets:BTreeMap::new()};
        let mut client=Client::open(&config,&BTreeMap::new(),"fixture",Limits::default(),None).await.unwrap();
        let (tx,rx)=tokio::sync::watch::channel(Value::Null);
        client.progress=Some(tx);
        client.pending=Some(1);
        client.report_progress(&json!({"progress":50,"total":100}));
        assert!(!rx.has_changed().unwrap(),"initialize never requested a progress token");
        client.pending=Some(2);
        client.progress_token=Some("owned".into());
        client.report_progress(&json!({"progressToken":"wrong","progress":50}));
        assert!(!rx.has_changed().unwrap());
        client.report_progress(&json!({"progressToken":"owned","progress":50}));
        assert_eq!(rx.borrow()["value"],50);
    }
}
