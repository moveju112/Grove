//! Claude Code의 SDK JSONL 연결을 같은 대화의 호환되는 턴에서 재사용한다.
use super::{CliStream, ModelOutput, ModelRequest, OnDelta, Profile, ProviderError, args_for_run, claude, prompt, read_line_into};
use serde_json::{Value, json};
use std::{collections::HashMap, path::{Path, PathBuf}, process::Stdio, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tokio::{io::{AsyncWriteExt, BufReader}, process::{Child, ChildStdin}};

const IDLE_TTL: Duration = Duration::from_secs(120);
const MAX_IDLE: usize = 4;

#[derive(Default)]
pub(crate) struct Sessions(Mutex<State>);

#[derive(Default)]
struct State {
    idle: HashMap<String, Idle>,
    closed: bool,
}

struct Idle {
    key: Key,
    at: Instant,
    process: Process,
}

#[derive(PartialEq, Eq)]
struct Key {
    profile: String,
    program: PathBuf,
    cwd: PathBuf,
    launch: Vec<String>,
    system_hash: String,
    effort: Option<String>,
    service_tier: Option<String>,
    bridge: bool,
}

#[derive(Clone)]
pub(crate) struct Handle {
    pub sessions: Arc<Sessions>,
    pub session: String,
    pub profile: String,
}

impl std::fmt::Debug for Handle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ClaudeSession(<conversation>)")
    }
}

impl Sessions {
    pub(crate) fn close(&self) {
        let mut state = self.0.lock().expect("Claude sessions");
        state.closed = true;
        state.idle.clear();
    }

    pub(crate) fn expire(&self) {
        self.0.lock().expect("Claude sessions").idle.retain(|_, idle| idle.at.elapsed() < IDLE_TTL);
    }
}

impl Handle {
    pub(crate) fn discard(&self) {
        self.sessions.0.lock().expect("Claude sessions").idle.remove(&self.session);
    }

    fn checkout(&self, key: &Key, resume: Option<&str>) -> Result<Option<Process>, ProviderError> {
        let mut state = self.sessions.0.lock().expect("Claude sessions");
        if state.closed { return Err(ProviderError::new("cancelled", "서버가 종료 중입니다")); }
        Ok(state.idle.remove(&self.session).filter(|idle|
            idle.at.elapsed() < IDLE_TTL && &idle.key == key && resume == Some(idle.process.native_id.as_str()))
            .map(|idle| idle.process)
            .filter(|process| process.child.id().is_some())
            .and_then(|mut process| process.child.try_wait().ok().filter(Option::is_none).map(|_| process)))
    }

    fn park(&self, key: Key, process: Process) {
        let mut state = self.sessions.0.lock().expect("Claude sessions");
        if state.closed { return; }
        if state.idle.len() >= MAX_IDLE
            && let Some(oldest) = state.idle.iter().min_by_key(|(_, idle)| idle.at).map(|(id, _)| id.clone())
        {
            state.idle.remove(&oldest);
        }
        state.idle.insert(self.session.clone(), Idle { key, at: Instant::now(), process });
    }
}

struct Process {
    child: Child,
    owned: crate::procs::Owned,
    stdin: ChildStdin,
    lines: BufReader<Box<dyn tokio::io::AsyncRead + Unpin + Send>>,
    pending: Vec<u8>,
    native_id: String,
    export: Option<super::rate_events::Export>,
    api_ms_total: Option<u64>,
    _scratch: tempfile::TempDir,
}

impl Drop for Process {
    fn drop(&mut self) {
        self.owned.kill_tree(self.child.id().is_some());
    }
}

/// CLI는 `/`로 시작하는 입력을 슬래시 명령으로 받는다. 실행 중 합치기에서는 다음 모델 호출에 넣지 않고
/// CLI 턴이 끝난 뒤 처리하므로, Grove가 보낸 글은 명령으로 읽히지 않게 감싼다.
fn plain_text(text: String) -> String {
    if text.trim_start().starts_with('/') { format!("<user_message>\n{text}\n</user_message>") } else { text }
}

fn disconnected() -> ProviderError {
    ProviderError::new("cli_exited", "Claude Code 프로세스가 턴을 끝내기 전에 종료되었습니다")
}

fn timeout() -> ProviderError {
    ProviderError::new("idle_timeout", "Claude Code 프로세스의 입출력 대기 시간을 넘었습니다")
}

impl Process {
    async fn control(&mut self, request: Value, idle: Duration) -> Result<Value, ProviderError> {
        let id = crate::util::new_id();
        let line = format!("{}\n", json!({"type":"control_request","request_id":id,"request":request}));
        tokio::time::timeout(idle, async {
            self.stdin.write_all(line.as_bytes()).await.map_err(|_| disconnected())?;
            loop {
                let line = read_line_into(&mut self.lines, &mut self.pending, super::MAX_LINE_BYTES)
                    .await?.ok_or_else(disconnected)?;
                let Ok(event) = serde_json::from_slice::<Value>(&line) else { continue };
                if event["type"] == "control_response" && event["response"]["request_id"] == id {
                    let response = &event["response"];
                    if response["subtype"] == "success" { return Ok(response["response"].clone()); }
                    return Err(ProviderError::new("cli_failed", "Claude Code가 세션 설정을 적용하지 못했습니다"));
                }
            }
        }).await.map_err(|_| timeout())?
    }

    async fn mcp(&mut self, servers: Value, idle: Duration) -> Result<(), ProviderError> {
        let response = self.control(json!({"subtype":"mcp_set_servers","servers":servers}), idle).await?;
        if response["errors"].as_object().is_some_and(|errors| !errors.is_empty()) {
            return Err(ProviderError::new("cli_failed", "Claude Code 턴 도구 연결을 갱신하지 못했습니다"));
        }
        Ok(())
    }
}

async fn start(key: &Key, mut argv: Vec<String>, native_id: String, data_dir: Option<&Path>) -> Result<Process, ProviderError> {
    // 실행 중 합치기는 CLI가 대화에 넣을 때 같은 uuid로 replay한 user 이벤트를 ACK로 쓴다.
    argv.extend(["--input-format".into(), "stream-json".into(), "--replay-user-messages".into()]);
    if key.bridge {
        argv.extend(["--allowedTools".into(), "mcp__grove_continuations__*".into()]);
    }
    let scratch = tempfile::Builder::new().prefix("grove-claude-").tempdir()
        .map_err(|_| ProviderError::new("cli_failed", "Claude Code 임시 디렉터리를 만들지 못했습니다"))?;
    let mut cmd = claude::command(&key.program);
    cmd.args(argv).current_dir(&key.cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    for name in ["TMPDIR", "TMP", "TEMP"] { cmd.env(name, scratch.path()); }
    if key.service_tier.as_deref() == Some(super::STANDARD_SERVICE_TIER) {
        cmd.env("CLAUDE_CODE_DISABLE_FAST_MODE", "1");
    }
    if let Some(effort) = &key.effort { cmd.env("CLAUDE_CODE_EFFORT_LEVEL", effort); }
    let tag = crate::util::new_id();
    crate::procs::prepare(&mut cmd, &tag);
    let mut child = cmd.spawn().map_err(|e| ProviderError::new("cli_failed", format!("Claude Code 실행 실패: {e}")))?;
    let owned = crate::procs::adopt(&mut child, &tag).map_err(|e| ProviderError::new("cli_failed", e))?;
    let export = super::rate_events::Export::new(data_dir).await;
    Ok(Process { stdin: child.stdin.take().expect("stdin"), lines: BufReader::new(super::rate_events::observe_stdout(child.stdout.take().expect("stdout"), export.clone())),
        child, owned, export, pending: Vec::new(), native_id, api_ms_total: Some(0), _scratch: scratch })
}

pub(super) async fn run(
    handle: &Handle, profile: &Profile, req: &ModelRequest, on_delta: OnDelta<'_>, program: Option<&Path>,
) -> Result<ModelOutput, ProviderError> {
    let ctx = req.cli.as_ref().expect("Claude context");
    let generated = uuid::Uuid::new_v4().to_string();
    let (argv, name) = args_for_run(profile, req, &generated, false).await;
    // 세션 인자와 시스템 원문을 제외한 실행 옵션만 보존한다. 시스템 지침은 hash로 비교한다.
    let mut launch = argv[..argv.len() - 2].to_vec();
    if let Some(i) = launch.iter().position(|arg| arg == "--append-system-prompt") {
        launch.drain(i..=i+1);
    }
    let tier = super::service_tier(req);
    let key = Key {
        profile: handle.profile.clone(), program: program.map(Path::to_path_buf).unwrap_or_else(|| name.into()),
        cwd: ctx.cwd.clone(), launch, system_hash: crate::util::sha256_hex(req.system.as_bytes()),
        effort: req.effort.clone().or_else(|| (tier == Some(super::STANDARD_SERVICE_TIER)).then(|| "auto".into())),
        service_tier: tier.map(str::to_owned), bridge: ctx.continuations.is_some(),
    };
    let mut process = match handle.checkout(&key, ctx.resume.as_deref())? {
        Some(process) => process,
        None => {
            let mut process = start(&key, argv, ctx.resume.clone().unwrap_or(generated), ctx.usage_data_dir.as_deref()).await?;
            process.control(json!({"subtype":"initialize"}), profile.timeout).await?;
            process
        }
    };
    if let Some(link) = &ctx.continuations {
        process.mcp(json!({"grove_continuations":{"type":"stdio","command":link.exe,"args":["continuation-mcp",link.file]}}), profile.timeout).await?;
    }
    let usage_turn = super::rate_events::Export::turn(process.export.as_ref());
    let resumed = ctx.resume.is_some();
    let text = plain_text(prompt(req, false));
    let mut content = vec![json!({"type":"text","text":text})];
    content.extend(super::claude_images(req, resumed)?.into_iter().map(|image|
        json!({"type":"image","source":{"type":"base64","media_type":image.mime,"data":image.data}})));
    let input = format!("{}\n", json!({"type":"user","parent_tool_use_id":null,"session_id":process.native_id,
        "message":{"role":"user","content":content}}));
    let mut stream = CliStream::new(req);
    let idle = profile.timeout;
    let native_id = process.native_id.clone();
    let live = ctx.steers.clone();
    // 합치기 ACK 전에 끝난 CLI 턴의 답변과 사용량. 남은 합치기는 CLI가 이어지는 턴으로 처리한다.
    let mut answers: Vec<String> = Vec::new();
    let mut usage = super::super::Usage::default();
    let mut model_ms = Some(0u64);
    let Process { stdin, lines, pending: buffer, child, api_ms_total, .. } = &mut process;
    let stdin = tokio::sync::Mutex::new(stdin);
    let write = async {
        let mut stdin = stdin.lock().await;
        tokio::time::timeout(idle, stdin.write_all(input.as_bytes())).await
            .map_err(|_| timeout())?.map_err(|_| disconnected())
    };
    let read = async {
        let mut next = Box::pin(super::codex::next_steer(&live));
        let mut sent: Vec<crate::followups::live::Delivery> = Vec::new();
        loop {
            let line = tokio::select! {
                biased;
                line = tokio::time::timeout(idle, read_line_into(lines, buffer, super::MAX_LINE_BYTES)) => line,
                id = &mut next => {
                    let link = live.as_ref().expect("합치기 연결");
                    if let Some(delivery) = link.claim(&id?).await.map_err(|e| ProviderError::new(e.code, e.message))? {
                        // sending 접수가 commit된 뒤에만 쓴다. 쓰기 오류는 재전송하지 않고 결과 불명으로 남긴다.
                        let mut content = delivery.content.clone();
                        if let Some(text) = content.first_mut().and_then(|block| block["text"].as_str().map(str::to_owned)) {
                            content[0]["text"] = json!(plain_text(text));
                        }
                        let message = format!("{}\n", json!({"type":"user","parent_tool_use_id":null,"session_id":native_id,
                            "uuid":delivery.id,"message":{"role":"user","content":content}}));
                        sent.push(delivery);
                        let mut stdin = stdin.lock().await;
                        tokio::time::timeout(idle, stdin.write_all(message.as_bytes())).await
                            .map_err(|_| timeout())?.map_err(|_| disconnected())?;
                    }
                    next = Box::pin(super::codex::next_steer(&live));
                    continue;
                }
            };
            let next_line = match line {
                Err(_) if ctx.waiting_for_grove_tool() => continue,
                Err(_) => {
                    if sent.is_empty() && buffer.is_empty() && stream.claude_completion.tasks.is_empty()
                        && !stream.output.activity.iter().any(|item| item["status"] == "running")
                        && let Some(text) = stream.claude_completion.completed.take()
                        && child.try_wait().map_err(|_| disconnected())?.is_none()
                    {
                        stream.final_text = Some(text);
                        stream.output.finish_reason = "claude_end_turn".into();
                        return Ok(false);
                    }
                    return Err(timeout());
                }
                Ok(next) => next?.ok_or_else(disconnected)?,
            };
            let Ok(event) = serde_json::from_slice::<Value>(&next_line) else {
                stream.claude_completion.invalidate();
                continue;
            };
            if event["type"] == "user" && event["isReplay"] == true
                && let Some(index) = sent.iter().position(|d| event["uuid"].as_str() == Some(d.id.as_str()))
            {
                let delivery = sent.remove(index);
                let boundary = (delivery.id.clone(), stream.output.response_parts.len());
                // Claude 입력은 이미지를 base64로 담아 보냈으므로 임시 파일을 유지할 필요가 없다.
                live.as_ref().expect("합치기 연결").acknowledge(delivery, true).await
                    .map_err(|e| ProviderError::new(e.code, e.message))?;
                stream.output.response_steers.push(boundary);
                on_delta(&stream.output);
                continue;
            }
            stream.apply("claude_code", &event)?;
            if event["type"] == "result" {
                // CLI의 duration_api_ms는 열린 프로세스의 누적값이다. 이전 result 이후의 시간만 이 출력에 붙인다.
                let total = stream.output.usage.model_request_ms;
                let previous = std::mem::replace(api_ms_total, total);
                let elapsed = total.zip(previous).and_then(|(now, before)| now.checked_sub(before));
                stream.output.usage.model_request_ms = elapsed.filter(|&ms| ms > 0);
                // 출력이 있는 모든 결과에 시간이 있어야 합산 출력과 짝을 맞출 수 있다.
                if stream.output.usage.output_tokens > 0 {
                    model_ms = model_ms.zip(stream.output.usage.model_request_ms).and_then(|(sum, ms)| sum.checked_add(ms));
                }
                usage.add(&stream.output.usage);
                if sent.is_empty() { return Ok(true); }
                // 도구 경계 없이 끝난 턴 뒤에는 CLI가 남은 합치기를 이어지는 턴으로 처리한다.
                answers.extend(stream.final_text.take());
                stream.output.finish_reason.clear();
            }
            on_delta(&stream.output);
        }
    };
    let (_, complete) = tokio::try_join!(write, read)?;
    usage.model_request_ms = model_ms.filter(|&ms| complete && ms > 0);
    stream.output.usage = usage;
    if !answers.is_empty() {
        answers.extend(stream.final_text.take());
        stream.final_text = Some(answers.join("\n\n"));
    }
    let mut out = stream.output;
    if let Some(final_text) = stream.final_text { out.text = final_text; }
    let clean = complete && stream.claude_completion.tasks.is_empty()
        && !out.activity.iter().any(|item| item["status"] == "running")
        && out.native_session.as_deref() == Some(process.native_id.as_str());
    usage_turn.finish().await;
    if clean && (!key.bridge || process.mcp(json!({}), idle.min(Duration::from_secs(5))).await.is_ok()) {
        handle.park(key, process);
    }
    Ok(out)
}

#[cfg(all(test, unix))]
#[path = "claude_session_tests.rs"]
mod tests;
