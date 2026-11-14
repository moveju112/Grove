//! 브라우저↔데몬 암호화 전송. 중계자는 주소·시간·크기만 볼 수 있다.
//! 신뢰하는 경로로 전달한 Ed25519 공개키를 pin하고 매 연결의 X25519 키를 서명한다.
//! HKDF-SHA256으로 방향별 AES-256-GCM 키를 분리한다. nonce는 연결별 단조 증가한다.
//! HTTP·SSE는 한 연결당 한 요청, 터미널은 한 연결당 한 WebSocket이다.
//! 웹앱 배포자는 신뢰 경계 안이다. 이 전송은 악성 JavaScript나 감염된 단말을 막지 않는다.

use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use axum::{Json, body::Body, extract::{ConnectInfo, Request, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode}, middleware::Next,
    response::{IntoResponse, Response}};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use curve25519_dalek::montgomery::MontgomeryPoint;
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use hkdf::Hkdf;
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{net::SocketAddr, path::Path, sync::Arc, time::Duration};
use tokio::sync::Semaphore;
use tower::ServiceExt;
use crate::{App, auth::Owner, error::{ApiError, ApiResult}};

mod mux;

const LABEL: &[u8] = b"grove-e2ee-v1";
const MAX_FRAME: usize = 12 * 1024 * 1024;
const MAX_BODY: usize = 8 * 1024 * 1024;
const CHUNK: usize = 48 * 1024;
const HANDSHAKE: Duration = Duration::from_secs(10);
const IO_WAIT: Duration = Duration::from_secs(60);
pub const PAGES_ORIGIN: &str = "https://grove.choondoggy.com";

pub struct Transport {
    identity: SigningKey,
    pub(crate) relay: Option<Arc<crate::relay::Settings>>,
    slots: Arc<Semaphore>,
    request_slots: Arc<Semaphore>,
    bridge_secret: String,
}

impl Transport {
    pub fn load(dir: &Path) -> Result<Self, std::io::Error> {
        let path = dir.join("e2ee-identity.key");
        // 손상된 키는 자동 교체하지 않는다. 기존 pin이 조용히 바뀌지 않게 한다.
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut bytes = [0u8; 32];
                rand::rng().fill_bytes(&mut bytes);
                use std::io::Write;
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)] {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut file = options.open(&path)?;
                file.write_all(&bytes)?;
                file.sync_all()?;
                bytes.to_vec()
            }
            Err(e) => return Err(e),
        };
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "E2EE identity key length"))?;
        let identity = SigningKey::from_bytes(&bytes);
        let relay = crate::relay::Settings::load(dir, identity.verifying_key().as_bytes())?;
        Ok(Self { identity, relay, slots: Arc::new(Semaphore::new(128)), request_slots: Arc::new(Semaphore::new(128)), bridge_secret: crate::util::random_secret(32) })
    }

    pub fn public_key(&self) -> String { B64.encode(self.identity.verifying_key().as_bytes()) }
    #[cfg(test)]
    pub(crate) fn identity_for_test(&self) -> [u8; 32] { self.identity.verifying_key().to_bytes() }
}

pub async fn identity(State(app): State<App>, _: Owner) -> Json<serde_json::Value> {
    Json(json!({ "version": 1, "key": app.e2ee.public_key(), "client": PAGES_ORIGIN,
        "endpoint": app.e2ee.relay.as_ref().map(|r| r.endpoint()) }))
}

#[derive(Clone)]
pub(crate) struct Encrypted;

fn local_host(host: &str) -> bool {
    host == "localhost" || host.starts_with("localhost:") || host == "127.0.0.1"
        || host.starts_with("127.0.0.1:") || host == "[::1]" || host.starts_with("[::1]:")
}

/// 로컬 UI는 기존 경로를 유지한다. 외부·TLS proxy 입구에서는 평문 API를 거절한다.
pub async fn require_encryption(State(app): State<App>, mut req: Request, next: Next) -> Response {
    let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|p| p.0);
    let bridge = req.headers_mut().remove("x-grove-e2ee-bridge");
    if peer.is_some_and(|p| p.ip().is_loopback())
        && bridge.as_ref().is_some_and(|v| crate::util::ct_eq(v.as_bytes(), app.e2ee.bridge_secret.as_bytes()))
    {
        req.extensions_mut().insert(Encrypted);
    }
    let host = req.headers().get("host").and_then(|v| v.to_str().ok()).unwrap_or("");
    if !app.cfg.host_allowed(host) {
        return ApiError::forbidden("허용되지 않은 Host입니다").into_response();
    }
    let local = !app.cfg.tls_terminated && app.cfg.listen.ip().is_loopback()
        && peer.is_some_and(|p| p.ip().is_loopback()) && local_host(host);
    if req.extensions().get::<Encrypted>().is_none() && !local {
        return ApiError::new(StatusCode::UPGRADE_REQUIRED, "e2ee_required", "암호화 연결이 필요합니다. 서버의 연결 링크로 다시 연결하세요.").into_response();
    }
    next.run(req).await
}

pub async fn upgrade(State(app): State<App>, headers: HeaderMap, ws: WebSocketUpgrade) -> ApiResult<Response> {
    let host = headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or("");
    if !app.cfg.host_allowed(host) { return Err(ApiError::forbidden("허용되지 않은 Host입니다")); }
    // WS는 fetch의 CORS가 적용되지 않는다. 브라우저 Origin은 별도로 검증한다.
    if let Some(origin) = headers.get("origin") {
        let origin = origin.to_str().map_err(|_| ApiError::forbidden("허용되지 않은 Origin입니다"))?;
        let same = format!("{}://{host}", if app.cfg.tls_terminated { "https" } else { "http" });
        if origin != same && origin != PAGES_ORIGIN && !app.cfg.allowed_origins.iter().any(|v| v == origin) {
            return Err(ApiError::forbidden("허용되지 않은 Origin입니다"));
        }
    }
    let permit = app.e2ee.slots.clone().try_acquire_owned()
        .map_err(|_| ApiError::new(StatusCode::TOO_MANY_REQUESTS, "e2ee_busy", "연결이 많습니다. 잠시 뒤 다시 시도하세요."))?;
    let host = host.to_string();
    Ok(ws.max_message_size(MAX_FRAME).max_frame_size(MAX_FRAME).on_upgrade(move |mut ws| async move {
        let _permit = permit;
        let mut shutdown = app.shutdown_rx.clone();
        tokio::select! {
            _ = serve(&app, &host, &mut ws) => {},
            _ = shutdown.wait_for(|v| *v) => {},
        }
        let _ = ws.close().await;
    }))
}

type Failure = Box<dyn std::error::Error + Send + Sync>;
fn invalid() -> Failure { "invalid encrypted transport".into() }

pub(crate) struct Cipher {
    cipher: Aes256Gcm,
    counter: u64,
}

impl Cipher {
    pub(crate) fn new(key: &[u8]) -> Self { Self { cipher: Aes256Gcm::new_from_slice(key).expect("32-byte key"), counter: 0 } }
    fn nonce(&mut self) -> Result<[u8; 12], Failure> {
        // 연결당 2^32 frame 이내에서 종료한다.
        if self.counter >= u32::MAX as u64 { return Err(invalid()); }
        let mut nonce = [0u8; 12];
        nonce[4..].copy_from_slice(&self.counter.to_be_bytes());
        self.counter += 1;
        Ok(nonce)
    }
    pub(crate) fn seal(&mut self, plain: &[u8]) -> Result<Vec<u8>, Failure> {
        let nonce = self.nonce()?;
        self.cipher.encrypt(Nonce::from_slice(&nonce), plain).map_err(|_| invalid())
    }
    pub(crate) fn open(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>, Failure> {
        let nonce = self.nonce()?;
        self.cipher.decrypt(Nonce::from_slice(&nonce), ciphertext).map_err(|_| invalid())
    }
}

pub(crate) fn transcript(client: &[u8; 32], server: &[u8; 32], identity: &[u8; 32]) -> Vec<u8> {
    [LABEL, client, server, identity].concat()
}

pub(crate) fn keys(shared: &[u8; 32], transcript: &[u8]) -> (Cipher, Cipher) {
    let hk = Hkdf::<Sha256>::new(Some(&Sha256::digest(transcript)), shared);
    let mut c2s = [0u8; 32];
    let mut s2c = [0u8; 32];
    hk.expand(b"grove-e2ee-v1/c2s", &mut c2s).expect("HKDF length");
    hk.expand(b"grove-e2ee-v1/s2c", &mut s2c).expect("HKDF length");
    (Cipher::new(&c2s), Cipher::new(&s2c))
}

/// 1: 연결당 요청 하나. 2: 한 연결에서 여러 HTTP 요청을 stream ID로 다중화한다.
async fn handshake(app: &App, ws: &mut WebSocket) -> Result<(Cipher, Cipher, u8), Failure> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Hello { version: u8, key: String }
    let Message::Text(text) = ws.recv().await.ok_or_else(invalid)?? else { return Err(invalid()); };
    if text.len() > 256 { return Err(invalid()); }
    let hello: Hello = serde_json::from_str(&text)?;
    if !matches!(hello.version, 1 | 2) { return Err(invalid()); }
    let client: [u8; 32] = B64.decode(&hello.key)?.try_into().map_err(|_| invalid())?;
    let mut secret = [0u8; 32];
    rand::rng().fill_bytes(&mut secret);
    let public = MontgomeryPoint::mul_base_clamped(secret).to_bytes();
    let shared = MontgomeryPoint(client).mul_clamped(secret).to_bytes();
    if shared == [0; 32] { return Err(invalid()); }
    let transcript = transcript(&client, &public, app.e2ee.identity.verifying_key().as_bytes());
    let signature = app.e2ee.identity.sign(&transcript);
    ws.send(Message::Text(json!({ "version": hello.version, "key": B64.encode(public), "signature": B64.encode(signature.to_bytes()) }).to_string().into())).await?;
    let (rx, tx) = keys(&shared, &transcript);
    Ok((rx, tx, hello.version))
}

async fn receive(ws: &mut WebSocket, cipher: &mut Cipher) -> Result<Vec<u8>, Failure> {
    loop {
        match ws.recv().await.ok_or_else(invalid)?? {
            Message::Binary(bytes) => return cipher.open(&bytes),
            Message::Ping(_) | Message::Pong(_) => continue,
            _ => return Err(invalid()),
        }
    }
}

async fn send(ws: &mut WebSocket, cipher: &mut Cipher, bytes: &[u8]) -> Result<(), Failure> {
    let sealed = cipher.seal(bytes)?;
    tokio::time::timeout(IO_WAIT, ws.send(Message::Binary(sealed.into()))).await??;
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Operation {
    kind: String,
    path: String,
    #[serde(default)]
    method: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    body: String,
}

fn valid_path(path: &str) -> bool {
    path.starts_with("/api/v1/") && !path.contains(['#', '\\', '\r', '\n'])
        && !path.contains("://") && path.len() <= 8192
}

/// 암호화 요청을 내부 API 요청으로 바꾼다. 경로·method·헤더는 API 계약 범위만 허용한다.
fn http_request(host: &str, op: Operation) -> Result<Request, Failure> {
    if !valid_path(&op.path) || op.kind != "http" || op.headers.len() > 32 { return Err(invalid()); }
    let body = B64.decode(&op.body)?;
    if body.len() > MAX_BODY { return Err(invalid()); }
    let method: axum::http::Method = op.method.parse()?;
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD") { return Err(invalid()); }
    let mut req = Request::builder().method(method).uri(&op.path).body(Body::from(body))?;
    for (name, value) in op.headers {
        // 전달 대상은 API 계약의 헤더뿐이다. 프록시·Origin·upgrade·framing 헤더는 받지 않는다.
        if matches!(name.to_ascii_lowercase().as_str(), "authorization" | "content-type" | "idempotency-key" | "x-request-id" | "x-grove-protocol" | "x-grove-require" | "last-event-id" | "cookie" | "range") {
            req.headers_mut().insert(HeaderName::from_bytes(name.as_bytes())?, HeaderValue::from_str(&value)?);
        }
    }
    req.headers_mut().insert("host", HeaderValue::from_str(host)?);
    req.extensions_mut().insert(Encrypted);
    Ok(req)
}

fn headers_frame(parts: &axum::http::response::Parts) -> Vec<u8> {
    let headers: Vec<_> = parts.headers.iter().filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str(), v))).collect();
    json!({ "type": "headers", "status": parts.status.as_u16(), "headers": headers }).to_string().into_bytes()
}

async fn serve(app: &App, host: &str, ws: &mut WebSocket) -> Result<(), Failure> {
    let (mut rx, mut tx, version) = tokio::time::timeout(HANDSHAKE, handshake(app, ws)).await??;
    if version == 2 { return mux::serve(app, host, ws, rx, tx).await; }
    let plain = tokio::time::timeout(HANDSHAKE, receive(ws, &mut rx)).await??;
    let op: Operation = serde_json::from_slice(&plain)?;
    if !valid_path(&op.path) { return Err(invalid()); }
    if op.kind == "ws" { return terminal(app, host, ws, &mut rx, &mut tx, op).await; }
    let req = http_request(host, op)?;
    // 로그인 시 IP를 위조하지 않는다. 원격 E2EE 로그인은 하나의 잠금 bucket을 공유한다.
    let response = crate::router(app.clone()).oneshot(req).await?;
    let (parts, body) = response.into_parts();
    send(ws, &mut tx, &headers_frame(&parts)).await?;
    let mut stream = body.into_data_stream();
    // 각 chunk를 소비한 뒤 ACK한다. 느린 브라우저에서 WebSocket 메모리가 무한 증가하지 않는다.
    while let Some(bytes) = stream.next().await {
        for chunk in bytes?.chunks(CHUNK) {
            send(ws, &mut tx, &[&[1u8], chunk].concat()).await?;
            let ack = tokio::time::timeout(IO_WAIT, receive(ws, &mut rx)).await??;
            if ack != [1] { return Err(invalid()); }
        }
    }
    send(ws, &mut tx, &[2]).await?;
    Ok(())
}

async fn terminal(app: &App, host: &str, ws: &mut WebSocket, rx: &mut Cipher, tx: &mut Cipher, op: Operation) -> Result<(), Failure> {
    // 임의 URL·SSRF를 허용하지 않는다. 동일 데몬의 기존 일회용 티켓 handler만 호출한다.
    let uri: axum::http::Uri = op.path.parse()?;
    let path = uri.path();
    if !path.starts_with("/api/v1/terminal-ws/") { return Err(invalid()); }
    use tokio_tungstenite::{connect_async, tungstenite::{client::IntoClientRequest, Message as TMessage}};
    let ip = if app.cfg.listen.is_ipv6() { "[::1]" } else { "127.0.0.1" };
    let mut req = format!("ws://{ip}:{}{}", app.cfg.listen.port(), op.path).into_client_request()?;
    req.headers_mut().insert("host", HeaderValue::from_str(host)?);
    req.headers_mut().insert("x-grove-e2ee-bridge", HeaderValue::from_str(&app.e2ee.bridge_secret)?);
    let (mut inner, _) = tokio::time::timeout(HANDSHAKE, connect_async(req)).await??;
    send(ws, tx, &[0]).await?;
    loop {
        tokio::select! {
            incoming = receive(ws, rx) => {
                let bytes = incoming?;
                let (&kind, data) = bytes.split_first().ok_or_else(invalid)?;
                let message = match kind {
                    1 => TMessage::Text(String::from_utf8(data.to_vec())?.into()),
                    2 => TMessage::Binary(data.to_vec().into()),
                    _ => return Err(invalid()),
                };
                tokio::time::timeout(IO_WAIT, inner.send(message)).await??;
            }
            message = inner.next() => {
                let Some(message) = message else { break };
                match message? {
                    TMessage::Text(text) => send(ws, tx, &[&[1u8], text.as_bytes()].concat()).await?,
                    TMessage::Binary(bytes) => send(ws, tx, &[&[2u8], &bytes[..]].concat()).await?,
                    TMessage::Close(_) => break,
                    _ => {},
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_is_stable_and_corruption_is_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let key = Transport::load(dir.path()).unwrap().public_key();
        assert_eq!(Transport::load(dir.path()).unwrap().public_key(), key);
        std::fs::write(dir.path().join("e2ee-identity.key"), b"broken").unwrap();
        assert!(Transport::load(dir.path()).is_err());
    }
    #[test]
    fn rejects_tampering_replay_and_wrong_direction() {
        let (mut c, mut s) = keys(&[7; 32], b"test");
        let (mut receiver, _) = keys(&[7; 32], b"test");
        let sealed = c.seal(b"secret").unwrap();
        assert_eq!(receiver.open(&sealed).unwrap(), b"secret");
        assert!(receiver.open(&sealed).is_err());
        assert!(s.open(&sealed).is_err());
        let (mut receiver, _) = keys(&[7; 32], b"test");
        let mut damaged = sealed;
        damaged[0] ^= 1;
        assert!(receiver.open(&damaged).is_err());
    }
}
