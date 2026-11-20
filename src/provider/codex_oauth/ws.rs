//! 턴 안에서만 연결과 응답 체인을 재사용한다. 재연결·SSE에는 Grove 이력 전체를 보낸다.
use super::{BASE, CLIENT_VERSION, Credentials, ModelOutput, OnDelta, ProviderError, RequestDiagnostics,
    auth_required, invalid, observe_request_id, read_event};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::{collections::BTreeMap, time::Duration};
use tokio::{net::TcpStream, time::timeout};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Error, Message, client::IntoClientRequest, protocol::WebSocketConfig}};

const URL: &str = "wss://chatgpt.com/backend-api/codex/responses";
const WIRE_LIMIT: usize = crate::provider::MAX_OUTPUT_BYTES * 2;
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Default)]
pub(crate) struct Session {
    transport: Transport,
    #[cfg(test)]
    pub(super) fixture: Option<String>,
}

#[derive(Default)]
enum Transport {
    #[default]
    Connect,
    WebSocket(Box<Connection>),
    Sse,
}

struct Connection {
    socket: Socket,
    identity: (String, Option<String>),
    chain: Option<Chain>,
}

struct Chain {
    id: String,
    options: String,
    input_len: usize,
    input_hash: String,
    output_len: usize,
    output_hash: String,
}

#[derive(Serialize)]
struct Frame<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(flatten)]
    options: &'a BTreeMap<&'a str, &'a Value>,
    input: &'a [Value],
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_response_id: Option<&'a str>,
}

fn fingerprint(value: &(impl Serialize + ?Sized)) -> String {
    crate::util::sha256_hex(&serde_json::to_vec(value).expect("JSON request fingerprint"))
}

impl Chain {
    fn delta<'a>(&self, options: &str, input: &'a [Value]) -> Option<&'a [Value]> {
        if self.options != options { return None; }
        let (prefix, rest) = input.split_at_checked(self.input_len)?;
        let (replayed, tail) = rest.split_at_checked(self.output_len)?;
        (fingerprint(prefix) == self.input_hash && fingerprint(replayed) == self.output_hash)
            .then_some(tail)
    }
}

// 서버 출력이 다음 Grove 요청의 표현으로 손실 없이 바뀔 때만 빼도 된다.
// 구조·순서가 다르거나 Grove가 출력 일부를 보존하지 않으면 full frame으로 돌아간다.
fn replay_items(response: &Value, scope: Option<&str>) -> Option<Vec<Value>> {
    let mut replay = Vec::new();
    for item in response["output"].as_array()? {
        let normalized = match item["type"].as_str()? {
            "function_call" => {
                let args: Value = serde_json::from_str(item["arguments"].as_str()?).ok()?;
                args.as_object()?;
                serde_json::json!({"type":"function_call","call_id":item["call_id"],"name":item["name"],
                    "arguments":args.to_string()})
            }
            "reasoning" if scope.is_some() && item["encrypted_content"].is_string()
                && item["id"].is_string() && item["summary"].is_array() => {
                serde_json::json!({"type":"reasoning","id":item["id"],"summary":item["summary"],
                    "encrypted_content":item["encrypted_content"]})
            }
            "message" if item["role"] == "assistant" => {
                let [part] = item["content"].as_array()?.as_slice() else { return None };
                if part["type"] != "output_text" || !part["annotations"].as_array().is_none_or(Vec::is_empty) { return None; }
                serde_json::json!({"role":"assistant","content":[{"type":"output_text","text":part["text"]}]})
            }
            _ => return None,
        };
        replay.push(normalized);
    }
    Some(replay)
}

struct Failure {
    error: ProviderError,
    fallback: bool,
}

impl From<ProviderError> for Failure {
    fn from(error: ProviderError) -> Self {
        Self { error, fallback: false }
    }
}

impl Failure {
    fn link(timed_out: bool) -> Self {
        let mut error = if timed_out {
            ProviderError::new("timeout", "Codex WebSocket 응답 대기 시간이 초과됐습니다")
        } else {
            ProviderError::new("stream_incomplete", "Codex WebSocket 연결이 끊겼습니다")
        };
        error.retryable = true;
        Self { error, fallback: true }
    }

    fn wire(error: Error) -> Self {
        match error {
            Error::Capacity(_) => ProviderError::new("output_too_large", "Codex 응답이 너무 큽니다").into(),
            _ => Self::link(false),
        }
    }

    fn handshake(error: Error) -> Self {
        let Error::Http(response) = error else { return Self::link(false) };
        let status = response.status().as_u16();
        let (code, retryable) = crate::provider::classify(status, "", None);
        let mut error = if status == 401 { auth_required() } else {
            ProviderError::new(code, format!("Codex WebSocket 연결에 실패했습니다 (HTTP {status})"))
        };
        error.status = Some(status);
        error.retryable = retryable;
        // 401의 갱신은 기존 SSE 계정 경로가 맡는다. 권한 거부나 429를 우회하지 않는다.
        Self { error, fallback: matches!(status, 400 | 401 | 404 | 405 | 426 | 500..=599) }
    }
}

impl Connection {
    async fn open(url: &str, auth: &Credentials, identity: (String, Option<String>), wait: Duration) -> Result<Self, Failure> {
        let mut req = url.into_client_request().map_err(|_| invalid())?;
        let headers = req.headers_mut();
        let mut bearer: tokio_tungstenite::tungstenite::http::HeaderValue =
            format!("Bearer {}", auth.access_token).parse().map_err(|_| auth_required())?;
        bearer.set_sensitive(true);
        headers.insert("authorization", bearer);
        headers.insert("originator", "codex_cli_rs".parse().expect("fixed header"));
        headers.insert("user-agent", format!("codex_cli_rs/{CLIENT_VERSION}").parse().expect("fixed header"));
        headers.insert("openai-beta", "responses_websockets=2026-02-06".parse().expect("fixed header"));
        if let Some(account) = &auth.account_id {
            let mut value: tokio_tungstenite::tungstenite::http::HeaderValue = account.parse().map_err(|_| auth_required())?;
            value.set_sensitive(true);
            headers.insert("chatgpt-account-id", value);
        }
        let config = WebSocketConfig::default().max_message_size(Some(WIRE_LIMIT)).max_frame_size(Some(WIRE_LIMIT));
        let (socket, _) = timeout(wait.min(Duration::from_secs(15)), connect_async_with_config(req, Some(config), false))
            .await.map_err(|_| Failure::link(true))?.map_err(Failure::handshake)?;
        Ok(Self { socket, identity, chain: None })
    }

    async fn next_text(&mut self) -> Result<tokio_tungstenite::tungstenite::Utf8Bytes, Failure> {
        loop {
            match self.socket.next().await.transpose().map_err(Failure::wire)? {
                Some(Message::Text(text)) => return Ok(text),
                Some(Message::Ping(_)) => self.socket.flush().await.map_err(Failure::wire)?,
                Some(Message::Pong(_)) => {}
                Some(Message::Close(_)) | None => return Err(Failure::link(false)),
                _ => return Err(invalid().into()),
            }
        }
    }

    async fn exchange(&mut self, body: &Value, model: &str, scope: Option<&str>, wait: Duration,
        diagnostics: &mut RequestDiagnostics, mut on_delta: OnDelta<'_>) -> Result<ModelOutput, Failure> {
        let options = body.as_object().ok_or_else(invalid)?.iter().filter(|(k, _)| *k != "input")
            .map(|(k, v)| (k.as_str(), v)).collect::<BTreeMap<_, _>>();
        let input = body["input"].as_array().ok_or_else(invalid)?;
        let options_hash = fingerprint(&options);
        let delta = self.chain.take().and_then(|c| c.delta(&options_hash, input).map(|tail| (c.id, tail)));
        let frame = Frame { kind: "response.create", options: &options,
            input: delta.as_ref().map_or(input.as_slice(), |(_, tail)| *tail),
            previous_response_id: delta.as_ref().map(|(id, _)| id.as_str()) };
        let text = serde_json::to_string(&frame).map_err(|_| invalid())?;
        diagnostics.frame_input_items = Some(frame.input.len());
        tracing::debug!(incremental = delta.is_some(), "Codex WebSocket 요청");
        timeout(wait, self.socket.send(Message::text(text))).await.map_err(|_| Failure::link(true))?
            .map_err(Failure::wire)?;
        let mut bytes = 0;
        let mut out = ModelOutput::default();
        loop {
            let text = timeout(wait, self.next_text()).await.map_err(|_| Failure::link(true))??;
            bytes += text.len();
            if bytes > WIRE_LIMIT {
                return Err(ProviderError::new("output_too_large", "Codex 응답이 너무 큽니다").into());
            }
            let event: Value = serde_json::from_str(text.as_str()).map_err(|_| invalid())?;
            observe_request_id(&mut diagnostics.request_id, &event);
            let completed = read_event(&event, &mut out, model, scope, &mut on_delta).map_err(|mut error| {
                // 이 소켓에서만 유효한 anchor가 사라지면 다음 시도는 새 연결에 full frame으로 간다.
                let code = error.stream_failure.as_ref().and_then(|f| f.code.as_deref());
                error.retryable |= matches!(code, Some("websocket_connection_limit_reached"))
                    || (delta.is_some() && code == Some("previous_response_not_found"));
                Failure::from(error)
            })?;
            if completed {
                let response = &event["response"];
                self.chain = response["id"].as_str().filter(|id| !id.is_empty() && id.len() <= 256)
                    .zip(replay_items(response, scope)).map(|(id, replay)| Chain {
                        id: id.into(), options: options_hash, input_len: input.len(), input_hash: fingerprint(input),
                        output_len: replay.len(), output_hash: fingerprint(&replay),
                    });
                return Ok(out);
            }
        }
    }
}

impl Session {
    fn ws_url(&self) -> String {
        #[cfg(test)]
        if let Some(addr) = &self.fixture { return format!("ws://{addr}/responses"); }
        URL.into()
    }

    pub(super) fn sse_url(&self) -> String {
        #[cfg(test)]
        if let Some(addr) = &self.fixture { return format!("http://{addr}/responses"); }
        format!("{BASE}/responses")
    }

    fn use_proxy(&self) -> bool {
        #[cfg(test)]
        if self.fixture.is_some() { return false; }
        // tungstenite는 HTTP CONNECT를 지원하지 않는다. 설정된 프록시를 우회하지 않는다.
        ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].iter()
            .any(|name| std::env::var_os(name).is_some_and(|v| !v.is_empty()))
    }

    // None이면 기존 SSE 호출로 넘긴다. 한 번 전환하면 이 턴에서는 SSE를 유지한다.
    pub(super) async fn send(&mut self, auth: &Credentials, body: &Value, model: &str, scope: Option<&str>,
        wait: Duration, on_delta: OnDelta<'_>) -> Result<Option<ModelOutput>, ProviderError> {
        if self.use_proxy() {
            self.transport = Transport::Sse;
        }
        let identity = (crate::util::sha256_hex(auth.access_token.as_bytes()), scope.map(str::to_owned));
        // in-flight 소켓의 유일한 소유권을 future로 이동한다. 취소·시간 예산·실패 시 소켓을 버린다.
        let mut emitted = false;
        let mut diagnostics = RequestDiagnostics::default();
        let result = async {
            let mut connection = match std::mem::take(&mut self.transport) {
                Transport::Sse => {
                    self.transport = Transport::Sse;
                    return Ok(None);
                }
                Transport::WebSocket(c) if c.identity == identity => c,
                _ => Box::new(Connection::open(&self.ws_url(), auth, identity, wait).await?),
            };
            let output = connection.exchange(body, model, scope, wait, &mut diagnostics, &mut |delta| {
                emitted |= !delta.text.is_empty() || !delta.reasoning.is_empty();
                on_delta(delta);
            }).await?;
            self.transport = Transport::WebSocket(connection);
            Ok::<_, Failure>(Some(output))
        }.await;
        if let Err(f) = &result {
            diagnostics.log_failure("websocket", body, model, auth, &f.error);
        }
        match result {
            Ok(output) => Ok(output),
            Err(f) if f.fallback && !emitted => {
                tracing::debug!(code = f.error.code, status = f.error.status, "Codex HTTP/SSE 전환");
                self.transport = Transport::Sse;
                Ok(None)
            }
            Err(f) => Err(f.error),
        }
    }
}

#[cfg(test)]
mod tests;
