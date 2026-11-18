//! 모델 provider 어댑터(MODEL, ADAPTER). Rust 내부 구현이며 Node 엔진을 호출하지 않는다.
//!
//! 구조: 공통 요청/응답 모델 → protocol별 요청 매핑 → HTTP stream framing(sse.rs) → protocol별 delta 누적기.
//! 재시도(MODEL-016·017): 모델 호출 한 번 안에서, 응답 조각이 하나도 오기 전의 재시도 가능 오류(429·5xx·timeout·연결)만
//! 최대 `MAX_RETRIES`번 다시 보낸다(Retry-After 준수, 상한 초과 시 포기). 모델 호출 자체는 부작용이 없고 도구 실행은 별도 단계라
//! 실행된 도구가 다시 돌지 않는다. 조각을 보낸 뒤의 오류·취소·CLI 백엔드는 재시도하지 않는다. 그 밖의 재시도는 사용자가 새 턴으로 한다.

pub mod anthropic;
mod catalog;
pub use catalog::{AvailableModel, ModelServiceTier, list_models};
pub mod cli;
pub(crate) mod codex_oauth;
pub mod gemini;
pub mod openai;
mod prompt_cache;
#[cfg(test)]
mod prompt_cache_tests;
pub mod sse;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::watch;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageInput {
    pub id: String,
    pub sha256: String,
    pub width: u32,
    pub height: u32,
    pub mime: String,
    #[serde(skip)]
    pub data: String,
}
impl std::fmt::Debug for ImageInput {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result { f.debug_struct("ImageInput").field("id",&self.id).field("width",&self.width).field("height",&self.height).finish_non_exhaustive() }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChatMsg {
    User { text: String, images: Vec<ImageInput> },
    Assistant { text: String, tool_calls: Vec<ToolCall>, native: Option<NativeContent> },
    Tool { call_id: String, name: String, content: String, is_error: bool },
}

/// 공급자의 서명된 원문. 표시용 reasoning과 분리하고 생성한 endpoint·모델에만 돌려준다.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeContent {
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    pub blocks: Vec<Value>,
}

impl std::fmt::Debug for NativeContent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeContent").field("protocol", &self.protocol).field("blocks", &self.blocks.len()).finish_non_exhaustive()
    }
}

impl NativeContent {
    fn matches(&self, profile: &Profile) -> bool {
        self.protocol == profile.protocol && self.base_url == profile.base_url && self.model == profile.model
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// 파싱된 인자. 잘못된 JSON이면 `{"__invalid_json": "<원문>"}`
    pub arguments: Value,
}

#[derive(Debug, Clone)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub schema: Value,
}

#[derive(Debug, Clone)]
pub struct ModelRequest {
    pub system: String,
    pub messages: Vec<ChatMsg>,
    pub tools: Vec<ToolDef>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f64>,
    /// 추론 옵션. None(auto)이면 보내지 않아 provider 기본값을 쓴다.
    pub effort: Option<String>,
    /// CLI 백엔드(claude_code·codex_cli)의 실행 문맥. HTTP provider는 쓰지 않는다.
    pub cli: Option<cli::CliContext>,
}

/// 사용량(USAGE-001). provider가 따로 알려 주지 않는 값은 None으로 둬 0과 구분한다.
/// reasoning_tokens는 output_tokens에 포함된 부분이다(합산하지 않는다).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
}

impl Usage {
    pub fn add(&mut self, o: &Usage) {
        self.input_tokens += o.input_tokens;
        self.output_tokens += o.output_tokens;
        self.cache_read_tokens += o.cache_read_tokens;
        let add = |a: Option<u64>, b: Option<u64>| match (a, b) {
            (None, None) => None,
            (x, y) => Some(x.unwrap_or(0) + y.unwrap_or(0)),
        };
        self.cache_write_tokens = add(self.cache_write_tokens, o.cache_write_tokens);
        self.reasoning_tokens = add(self.reasoning_tokens, o.reasoning_tokens);
    }
}

/// CLI의 현재 문맥 점유량. 여러 요청을 합산하는 과금 Usage와 분리한다.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, ts_rs::TS)]
pub struct ContextUsage {
    #[ts(type = "number | null")]
    pub tokens: Option<u64>,
    #[ts(type = "number | null")]
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct ModelOutput {
    pub text: String,
    /// CLI가 보낸 개별 응답. 앞선 진행 설명과 마지막 답변의 표시 경계를 보존한다.
    pub response_parts: Vec<String>,
    pub reasoning: String,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Usage,
    pub context_usage: Option<ContextUsage>,
    pub finish_reason: String,
    /// CLI 백엔드가 알려 준 자기 세션 ID(다음 요청에서 resume)
    pub native_session: Option<String>,
    /// CLI 백엔드가 자기 안에서 실행한 도구 활동(표시 전용, Grove가 다시 실행하지 않음)
    pub activity: Vec<Value>,
    pub native: Option<NativeContent>,
    /// 표시할 생성 이미지. 원문·호스트 경로는 첨부로 가져온 뒤 HTTP 응답에서 제외한다.
    pub generated_images: Vec<GeneratedImage>,
}

#[derive(Clone)]
pub struct GeneratedImage {
    pub id: String,
    pub source: GeneratedImageSource,
}

#[derive(Clone)]
pub enum GeneratedImageSource {
    Base64(String),
    File { root: std::path::PathBuf, path: std::path::PathBuf },
}

impl std::fmt::Debug for GeneratedImage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GeneratedImage").finish_non_exhaustive()
    }
}

/// 진행 중 delta를 UI snapshot으로 보내기 위한 콜백.
pub type OnDelta<'a> = &'a mut (dyn FnMut(&ModelOutput) + Send);

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderError {
    pub code: &'static str,
    pub message: String,
    pub status: Option<u16>,
    pub retryable: bool,
    /// provider가 Retry-After로 알려 준 대기 시간(초)
    pub retry_after_secs: Option<u64>,
    stream_failure: Option<StreamFailure>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct StreamFailure {
    event: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    incomplete_reason: Option<String>,
}

impl ProviderError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), status: None, retryable: false, retry_after_secs: None, stream_failure: None }
    }
    pub fn to_json(&self) -> Value {
        let mut error = json!({ "code": self.code, "message": self.message, "status": self.status, "retryable": self.retryable });
        if let Some(detail) = &self.stream_failure {
            error["provider_stream"] = json!(detail);
        }
        error
    }
}

#[derive(Debug, Clone)]
pub struct Profile {
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
    pub timeout: Duration,
    pub extra_headers: Vec<(String, String)>,
    /// 공개 이름의 헤더라도 vault 참조로 지정했으면 오류 본문에서 비밀로 취급한다.
    pub sensitive_headers: Vec<String>,
}

pub(crate) fn is_credential_header(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.ends_with("key") || ["authorization", "cookie", "token", "secret", "password", "credential"].iter().any(|part| name.contains(part))
}

pub(crate) fn scrub_provider_text(profile: &Profile, text: &str) -> String {
    let headers = profile.extra_headers.iter().filter(|(name, _)| is_credential_header(name)
        || profile.sensitive_headers.iter().any(|private| private.eq_ignore_ascii_case(name)));
    profile.api_key.iter().chain(headers.map(|(_, value)| value))
        .filter(|value| !value.is_empty()).fold(text.to_string(), |text, secret| text.replace(secret.as_str(), "[redacted]"))
}

/// endpoint·모델·timeout 정규화와 요청 전 검증(ADAPTER-001).
pub fn validate_profile(protocol: &str, base_url: &str, model: &str) -> Result<(), String> {
    if !matches!(protocol, "openai" | "anthropic" | "gemini" | "claude_code" | "codex_cli" | codex_oauth::PROTOCOL) {
        return Err("지원하지 않는 모델 protocol입니다".into());
    }
    let u = base_url.trim();
    // CLI와 Codex OAuth는 사용자가 설정하는 endpoint를 쓰지 않는다.
    if cli::is_cli(protocol) || protocol == codex_oauth::PROTOCOL {
        if !u.is_empty() {
            return Err("이 연결은 base_url을 쓰지 않습니다(비워 두세요)".into());
        }
    } else if !(u.starts_with("http://") || u.starts_with("https://")) || u.len() < 10 || u.contains(char::is_whitespace) {
        return Err("base_url은 http(s) URL이어야 합니다".into());
    }
    if model.trim().is_empty() || model.len() > 200 || model.contains(char::is_whitespace) {
        return Err("model 이름이 올바르지 않습니다".into());
    }
    Ok(())
}

/// 서버 전역에서 공유하는 HTTP client(연결 풀 재사용, ARCH-015). timeout은 client 설정이라 값별로 하나씩 둔다.
pub fn http_client(timeout: Duration) -> reqwest::Client {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CLIENTS: OnceLock<Mutex<HashMap<Duration, reqwest::Client>>> = OnceLock::new();
    let mut m = CLIENTS.get_or_init(Default::default).lock().expect("http clients");
    // reqwest::Client는 내부가 Arc라 clone은 같은 연결 풀을 공유한다.
    m.entry(timeout).or_insert_with(|| build_client(timeout)).clone()
}

#[cfg(test)]
static BUILT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn build_client(timeout: Duration) -> reqwest::Client {
    #[cfg(test)]
    BUILT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(timeout)
        // provider 응답의 redirect로 자격 증명이 다른 host에 전달되는 것을 막는다.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("http client")
}

#[cfg(test)]
mod error_tests {
    use super::*;

    #[test]
    fn classify_distinguishes_context_and_model_errors() {
        assert_eq!(classify(400, "This model's maximum context length is 8192 tokens", None), ("context_too_long", false));
        assert_eq!(classify(400, "bad", Some("context_length_exceeded")), ("context_too_long", false));
        assert_eq!(classify(400, "prompt is too long: 250000 tokens > 200000 maximum", Some("invalid_request_error")), ("context_too_long", false));
        assert_eq!(classify(404, "The model `x` does not exist", None), ("model_not_found", false));
        assert_eq!(classify(400, "model foo is not supported", None), ("model_not_found", false));
        assert_eq!(classify(400, "temperature must be <= 2", None), ("bad_request", false));
        assert_eq!(classify(401, "", None), ("auth_failed", false));
        assert_eq!(classify(429, "slow down", None), ("rate_limited", true));
        assert_eq!(classify(503, "", None), ("provider_unavailable", true));
    }

    #[test]
    fn retry_delay_respects_retry_after_and_cap() {
        let mut e = ProviderError::new("rate_limited", "x");
        e.retry_after_secs = Some(3);
        assert_eq!(retry_delay(0, &e, 0.0), Some(Duration::from_secs(3)));
        e.retry_after_secs = Some(MAX_RETRY_WAIT_SECS + 1);
        assert_eq!(retry_delay(0, &e, 0.0), None, "상한보다 길면 기다리지 않는다");
        e.retry_after_secs = None;
        assert_eq!(retry_delay(0, &e, 0.0), Some(Duration::from_millis(500)));
        assert_eq!(retry_delay(1, &e, 1.0), Some(Duration::from_millis(1500)));
    }
}

#[cfg(test)]
mod timeout_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn client(ms: u64) -> reqwest::Client {
        reqwest::Client::builder().connect_timeout(Duration::from_secs(5)).read_timeout(Duration::from_millis(ms)).build().unwrap()
    }

    /// 헤더 전 무응답 = 첫 응답 timeout, 본문 중 무응답 = idle timeout, 닫힌 포트 = 연결 실패(MODEL-014).
    #[tokio::test]
    async fn timeouts_are_distinguished_by_phase() {
        // 1) 연결은 받지만 아무것도 보내지 않는 서버
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let a = l.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut b = [0u8; 1024];
            let _ = s.read(&mut b).await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let e = send(client(200).get(format!("http://{a}/"))).await.unwrap_err();
        assert_eq!(e.code, "first_response_timeout", "{e:?}");
        assert!(e.retryable);

        // 2) 헤더와 일부 본문 뒤 멈추는 서버
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let a = l.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut b = [0u8; 1024];
            let _ = s.read(&mut b).await;
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n5\r\ndata:\r\n").await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let mut resp = send(client(200).get(format!("http://{a}/"))).await.unwrap();
        let e = loop {
            match resp.chunk().await {
                Ok(Some(_)) => continue,
                Ok(None) => panic!("끝나면 안 된다"),
                Err(e) => break transport_error(e),
            }
        };
        assert_eq!(e.code, "idle_timeout", "{e:?}");

        // 3) 닫힌 포트
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let a = l.local_addr().unwrap();
        drop(l);
        let e = send(client(200).get(format!("http://{a}/"))).await.unwrap_err();
        assert_eq!(e.code, "connect_failed", "{e:?}");
    }
}

#[cfg(test)]
mod client_tests {
    use super::*;

    #[test]
    fn clients_are_shared_per_timeout() {
        use std::sync::atomic::Ordering;
        // 다른 시험과 겹치지 않는 timeout 값으로 생성 횟수 증가분만 본다.
        let before = BUILT.load(Ordering::SeqCst);
        for _ in 0..5 {
            let _ = http_client(Duration::from_secs(4321));
        }
        let _ = http_client(Duration::from_secs(4322));
        assert_eq!(BUILT.load(Ordering::SeqCst) - before, 2, "timeout 값마다 한 번만 만든다");
    }
}

/// 최대 응답 본문(오류 본문 포함) 크기.
pub const MAX_ERROR_BODY: usize = 16 * 1024;
/// 한 번의 응답에서 누적할 최대 텍스트(폭주 방지).
pub const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

pub async fn stream(
    profile: &Profile,
    req: &ModelRequest,
    cancel: &mut watch::Receiver<bool>,
    on_delta: OnDelta<'_>,
) -> Result<ModelOutput, ProviderError> {
    stream_with_service_tier(profile, req, None, cancel, on_delta).await
}

pub(crate) async fn stream_with_service_tier(
    profile: &Profile,
    req: &ModelRequest,
    service_tier: Option<&str>,
    cancel: &mut watch::Receiver<bool>,
    on_delta: OnDelta<'_>,
) -> Result<ModelOutput, ProviderError> {
    if *cancel.borrow() {
        return Err(ProviderError::new("cancelled", "취소되었습니다"));
    }
    // 다른 공급자·endpoint·모델로 전환해도 서명된 원문을 유출하지 않는다.
    let filtered;
    let req = if req.messages.iter().any(|m| matches!(m, ChatMsg::Assistant { native: Some(native), .. } if !native.matches(profile))) {
        let mut request = req.clone();
        for message in &mut request.messages {
            if let ChatMsg::Assistant { native, .. } = message {
                if native.as_ref().is_some_and(|n| !n.matches(profile)) { *native = None; }
            }
        }
        filtered = request;
        &filtered
    } else { req };
    let client = http_client(profile.timeout);
    let mut attempt = 0u32;
    loop {
        // 이 시도에서 사용자에게 보낸 조각이 있으면 재시도하지 않는다(같은 응답을 두 번 보여 주지 않게).
        let mut emitted = false;
        let mut wrapped = |o: &ModelOutput| {
            if !o.text.is_empty() || !o.reasoning.is_empty() || !o.tool_calls.is_empty() {
                emitted = true;
            }
            on_delta(o)
        };
        let fut = async {
            match profile.protocol.as_str() {
                "claude_code" | "codex_cli" => cli::stream(profile, req, &mut wrapped).await,
                codex_oauth::PROTOCOL => codex_oauth::stream(&client, profile, req, service_tier, &mut wrapped).await,
                "openai" => openai::stream(&client, profile, req, &mut wrapped).await,
                "anthropic" => anthropic::stream(&client, profile, req, &mut wrapped).await,
                "gemini" => gemini::stream(&client, profile, req, &mut wrapped).await,
                other => Err(ProviderError::new("unsupported", format!("지원하지 않는 protocol: {other}"))),
            }
        };
        let r = tokio::select! {
            r = fut => r,
            _ = cancel.wait_for(|c| *c) => return Err(ProviderError::new("cancelled", "취소되었습니다")),
        };
        let e = match r {
            Ok(mut o) => {
                if let Some(native) = &mut o.native {
                    native.protocol = profile.protocol.clone();
                    native.base_url = profile.base_url.clone();
                    native.model = profile.model.clone();
                }
                return Ok(o);
            }
            Err(mut e) => {
                e.message = scrub_provider_text(profile, &e.message);
                e
            }
        };
        // CLI 백엔드는 자기 도구를 이미 실행했을 수 있어 재시도하지 않는다.
        let delay = (e.retryable && !emitted && attempt < MAX_RETRIES && !cli::is_cli(&profile.protocol))
            .then(|| retry_delay(attempt, &e, rand::random::<f64>()))
            .flatten();
        let Some(d) = delay else { return Err(e) };
        tracing::info!(code = e.code, attempt, "모델 호출 재시도 {:?} 후", d);
        tokio::select! {
            _ = tokio::time::sleep(d) => {}
            _ = cancel.wait_for(|c| *c) => return Err(ProviderError::new("cancelled", "취소되었습니다")),
        }
        attempt += 1;
    }
}

/// effort 값 검증(auto는 None).
pub fn parse_effort(v: Option<&str>) -> Result<Option<String>, String> {
    match v {
        None | Some("auto") | Some("") => Ok(None),
        Some(e @ ("low" | "medium" | "high" | "xhigh" | "max" | "ultra")) => Ok(Some(e.to_string())),
        Some(_) => Err("지원하지 않는 추론 옵션입니다".into()),
    }
}

pub fn parse_service_tier(value: Option<&str>) -> Result<Option<String>, String> {
    value.map(|tier| {
        if tier.is_empty() || tier.len() > 40 || !tier.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
            Err("지원하지 않는 속도 옵션입니다".into())
        } else { Ok(tier.to_string()) }
    }).transpose()
}

/// 요청한 effort가 이 protocol에서 실제로 어떤 값으로 보내지는지(EFF-002·009). auto는 아무것도 보내지 않는다.
/// 요청값·적용값을 화면·사용량에서 구분하는 데 쓴다. 턴 접수 때 고정하며 턴 도중 바꾸지 않는다.
pub fn effort_application(protocol: &str, effort: Option<&str>) -> serde_json::Value {
    let Some(e) = effort else {
        return serde_json::json!({ "requested": "auto", "field": null, "value": null });
    };
    let (field, value) = match protocol {
        "openai" => ("reasoning_effort", serde_json::json!(e)),
        "anthropic" => ("thinking.budget_tokens", serde_json::json!(effort_budget(e))),
        "gemini" => ("thinkingConfig.thinkingBudget", serde_json::json!(effort_budget(e))),
        "codex_cli" => ("model_reasoning_effort", serde_json::json!(e)),
        codex_oauth::PROTOCOL => ("reasoning.effort", serde_json::json!(e)),
        "claude_code" => ("MAX_THINKING_TOKENS", serde_json::json!(effort_budget(e))),
        _ => return serde_json::json!({ "requested": e, "field": null, "value": null }),
    };
    serde_json::json!({ "requested": e, "field": field, "value": value })
}

/// 생각 token 예산으로 표현하는 provider(Anthropic thinking·Gemini thinkingBudget·Claude Code)의 effort 환산.
pub fn effort_budget(effort: &str) -> u32 {
    match effort {
        "low" => 1024,
        "medium" => 4096,
        _ => 16384,
    }
}

/// 연결 확인(AUTH-001). 생성 요청 없이 모델 목록을 한 번 조회한다(token·비용 없음). CLI 백엔드는 실행 파일 버전 확인.
/// 성공이면 목록 크기와 프로필 모델이 목록에 있는지(없을 수도 있음: 목록을 주지 않는 호환 서버)를 돌려준다.
pub async fn check(profile: &Profile) -> Result<Value, ProviderError> {
    if cli::is_cli(&profile.protocol) {
        return cli::check(profile).await;
    }
    let models = list_models(profile).await?;
    let listed = models.iter().any(|m| m.id == profile.model
        || (profile.protocol == codex_oauth::PROTOCOL && profile.model == "default" && m.is_default == Some(true)));
    Ok(json!({ "models": models.len(), "model_listed": listed }))
}

/// HTTP 오류 응답을 표준 오류로 변환한다. 본문은 제한된 크기만 읽고 비밀정보를 포함하지 않게 한다.
pub async fn http_error(resp: reqwest::Response) -> ProviderError {
    let status = resp.status().as_u16();
    let retry_after = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(String::from);
    let mut body = Vec::new();
    let mut s = resp;
    while let Ok(Some(chunk)) = s.chunk().await {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_ERROR_BODY {
            body.truncate(MAX_ERROR_BODY);
            break;
        }
    }
    let text = String::from_utf8_lossy(&body).to_string();
    let parsed = serde_json::from_str::<Value>(&text).ok();
    let detail = parsed
        .as_ref()
        .and_then(|v| v["error"]["message"].as_str().or(v["message"].as_str()).map(String::from))
        .unwrap_or_else(|| text.chars().take(500).collect());
    let err_code = parsed.as_ref().and_then(|v| v["error"]["code"].as_str().or(v["error"]["type"].as_str()).map(String::from));
    let (code, retryable) = classify(status, &detail, err_code.as_deref());
    let mut msg = format!("HTTP {status}: {detail}");
    if let Some(r) = &retry_after {
        msg.push_str(&format!(" (retry-after {r})"));
    }
    // Retry-After는 초 단위만 쓴다(HTTP 날짜 형식은 무시하고 backoff로 대체).
    let retry_after_secs = retry_after.and_then(|r| r.trim().parse::<u64>().ok());
    ProviderError { code, message: msg, status: Some(status), retryable, retry_after_secs, stream_failure: None }
}

/// 요청 단계(MODEL-014): timeout이 연결·첫 응답·무응답 중 어디서 났는지 구분한다.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Phase {
    /// 연결과 응답 헤더까지
    Head,
    /// 본문 stream 중(조각 사이 무응답)
    Body,
}

/// 요청을 보내고 응답 헤더를 받는다. 연결 timeout은 client 설정(15초), 첫 응답 timeout은 프로필 timeout.
pub async fn send(rb: reqwest::RequestBuilder) -> Result<reqwest::Response, ProviderError> {
    rb.send().await.map_err(|e| transport_error_in(e, Phase::Head))
}

pub fn transport_error(e: reqwest::Error) -> ProviderError {
    transport_error_in(e, Phase::Body)
}

pub fn transport_error_in(e: reqwest::Error, phase: Phase) -> ProviderError {
    let code = match (e.is_timeout(), e.is_connect(), phase) {
        (true, true, _) => "connect_timeout",
        (false, true, _) => "connect_failed",
        (true, false, Phase::Head) => "first_response_timeout",
        (true, false, Phase::Body) => "idle_timeout",
        _ => "transport",
    };
    // URL에 키가 들어갈 수 있는 provider가 있으므로 URL은 제거한다.
    ProviderError { code, message: e.without_url().to_string(), status: None, retryable: true, retry_after_secs: None, stream_failure: None }
}

/// HTTP 오류 정규화(MODEL-015). 상태 코드만으로 구분되지 않는 context 초과·모델 미지원은 provider 오류 code·본문으로 가린다.
pub fn classify(status: u16, detail: &str, err_code: Option<&str>) -> (&'static str, bool) {
    let d = detail.to_ascii_lowercase();
    let c = err_code.unwrap_or("").to_ascii_lowercase();
    let context = c.contains("context_length")
        || ["context length", "context window", "maximum context", "prompt is too long", "too many tokens", "input is too long", "exceeds the context"].iter().any(|p| d.contains(p));
    let model = c == "model_not_found"
        || ["model_not_found", "does not exist", "unknown model", "model not found", "unsupported model", "is not supported"].iter().any(|p| d.contains(p) && d.contains("model"));
    match status {
        400 | 413 | 422 if context => ("context_too_long", false),
        400 | 404 | 422 if model => ("model_not_found", false),
        401 | 403 => ("auth_failed", false),
        404 => ("model_not_found", false),
        408 | 504 => ("timeout", true),
        429 => ("rate_limited", true),
        400 | 413 | 422 => ("bad_request", false),
        s if s >= 500 => ("provider_unavailable", true),
        300..=399 => ("redirect_blocked", false),
        _ => ("provider_error", false),
    }
}

/// 자동 재시도(MODEL-016): 응답 조각이 하나도 오기 전의 재시도 가능 오류만, 최대 이 횟수까지.
pub const MAX_RETRIES: u32 = 2;
/// Retry-After 상한(초). 더 길면 기다리지 않고 오류를 돌려준다(사용자가 직접 다시 시도).
pub const MAX_RETRY_WAIT_SECS: u64 = 30;

/// 재시도 전 대기. Retry-After가 있으면 그 값, 없으면 지수 backoff + jitter.
pub fn retry_delay(attempt: u32, e: &ProviderError, jitter: f64) -> Option<Duration> {
    if let Some(s) = e.retry_after_secs {
        return (s <= MAX_RETRY_WAIT_SECS).then(|| Duration::from_secs(s));
    }
    let base = 500u64 * 2u64.pow(attempt);
    Some(Duration::from_millis(base + (base as f64 * 0.5 * jitter.clamp(0.0, 1.0)) as u64))
}

/// 부분 JSON 인자를 최종 파싱한다(ADAPTER-003, MODEL-011).
pub fn parse_arguments(raw: &str) -> Value {
    if raw.trim().is_empty() {
        return json!({});
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(v @ Value::Object(_)) => v,
        Ok(other) => json!({ "__invalid_json": other.to_string() }),
        Err(_) => json!({ "__invalid_json": raw }),
    }
}

/// tool 결과를 provider에 보낼 문자열로 만든다.
pub fn tool_content_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod effort_tests {
    use super::*;

    #[test]
    fn service_tiers_cannot_inject_cli_configuration() {
        for tier in ["default", "priority"] {
            assert_eq!(parse_service_tier(Some(tier)).unwrap().as_deref(), Some(tier));
        }
        for tier in ["", "priority\"\\nother=true", "with space", "日本語"] {
            assert!(parse_service_tier(Some(tier)).is_err());
        }
        assert_eq!(parse_service_tier(None).unwrap(), None);
    }

    fn req(effort: Option<&str>) -> ModelRequest {
        ModelRequest {
            system: "s".into(),
            messages: vec![ChatMsg::User { text: "q".into(), images: vec![] }],
            tools: vec![],
            max_tokens: Some(1000),
            temperature: Some(0.2),
            effort: effort.map(str::to_string),
            cli: None,
        }
    }

    fn prof(protocol: &str) -> Profile {
        Profile { protocol: protocol.into(), base_url: "http://x".into(), model: "m".into(), api_key: None, timeout: Duration::from_secs(5), extra_headers: vec![], sensitive_headers: vec![] }
    }

    #[test]
    fn effort_maps_per_provider_and_auto_sends_nothing() {
        assert_eq!(parse_effort(None).unwrap(), None);
        assert_eq!(parse_effort(Some("auto")).unwrap(), None);
        assert_eq!(parse_effort(Some("low")).unwrap().as_deref(), Some("low"));
        for effort in ["xhigh", "max", "ultra"] {
            assert_eq!(parse_effort(Some(effort)).unwrap().as_deref(), Some(effort));
        }
        assert!(parse_effort(Some("invalid")).is_err());

        let o = openai::build_body(&prof("openai"), &req(Some("high")));
        assert_eq!(o["reasoning_effort"], "high");
        assert!(openai::build_body(&prof("openai"), &req(None)).get("reasoning_effort").is_none());

        let a = anthropic::build_body(&prof("anthropic"), &req(Some("medium")));
        assert_eq!(a["thinking"], serde_json::json!({ "type": "enabled", "budget_tokens": 4096 }));
        assert!(a["max_tokens"].as_u64().unwrap() > 4096, "max_tokens는 생각 예산보다 커야 한다");
        assert!(a.get("temperature").is_none(), "thinking과 temperature는 함께 보내지 않는다");
        let a0 = anthropic::build_body(&prof("anthropic"), &req(None));
        assert!(a0.get("thinking").is_none());
        assert_eq!(a0["temperature"], 0.2);

        let g = gemini::build_body(&req(Some("low")));
        assert_eq!(g["generationConfig"]["thinkingConfig"]["thinkingBudget"], 1024);

        let (args, _) = cli::args(&prof("codex_cli"), &req(Some("low")), "s");
        assert!(args.windows(2).any(|w| w[0] == "-c" && w[1] == "model_reasoning_effort=\"low\""), "{args:?}");
        let (args, _) = cli::args(&prof("codex_cli"), &req(None), "s");
        assert!(!args.iter().any(|a| a.contains("model_reasoning_effort")));
    }

    /// EFF-002: 기록하는 적용값은 실제 요청 본문에 넣는 값과 같다.
    #[test]
    fn effort_application_matches_what_each_adapter_sends() {
        for e in ["low", "medium", "high"] {
            let a = effort_application("openai", Some(e));
            assert_eq!(openai::build_body(&prof("openai"), &req(Some(e)))["reasoning_effort"], a["value"]);
            let a = effort_application("anthropic", Some(e));
            assert_eq!(anthropic::build_body(&prof("anthropic"), &req(Some(e)))["thinking"]["budget_tokens"], a["value"]);
            assert_eq!(gemini::build_body(&req(Some(e)))["generationConfig"]["thinkingConfig"]["thinkingBudget"], effort_application("gemini", Some(e))["value"]);
        }
        let auto = effort_application("openai", None);
        assert!(auto["field"].is_null() && auto["value"].is_null() && auto["requested"] == "auto");
    }
}
