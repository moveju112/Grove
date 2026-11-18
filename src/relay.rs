//! 아웃바운드 전용 릴레이 연결. 로컬 E2EE WebSocket에 불투명 frame만 전달한다.
//! 릴레이 URL이나 인증 헤더를 오류 로그에 남기지 않는다.
use std::{net::SocketAddr, sync::Arc, time::Duration};
use futures_util::{SinkExt, StreamExt};
use tokio::{sync::watch, task::{JoinHandle, JoinSet}};
use tokio_tungstenite::{connect_async_with_config, tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message}};
use sha2::{Digest, Sha256};

pub struct Settings {
    base: String,
    token: String,
    room: String,
}

impl Settings {
    pub fn load(dir: &std::path::Path, public_key: &[u8]) -> Result<Option<Arc<Self>>, std::io::Error> {
        // 파일이 없는 설치는 로컬 모드다. 잘못된 설정은 조용히 무시하지 않는다.
        let bytes = match std::fs::read(dir.join("relay.json")) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input { url: String, token: String }
        let input: Input = serde_json::from_slice(&bytes).map_err(|_| std::io::Error::other("relay.json 형식 오류"))?;
        let base = Self::validate_url(&input.url).ok_or_else(|| std::io::Error::other("릴레이 URL은 경로 없는 wss:// 주소여야 합니다(로컬 시험 스택만 ws://127.0.0.1 허용)"))?;
        if input.token.len() != 64 || !input.token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(std::io::Error::other("릴레이 인증 비밀은 32-byte hex여야 합니다"));
        }
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            if std::fs::metadata(dir.join("relay.json"))?.permissions().mode() & 0o077 != 0 {
                return Err(std::io::Error::other("relay.json 권한은 0600이어야 합니다"));
            }
        }
        let room = Sha256::digest(public_key).iter().map(|b| format!("{b:02x}")).collect();
        Ok(Some(Arc::new(Self { base, token: input.token, room })))
    }

    fn validate_url(value: &str) -> Option<String> {
        let url = reqwest::Url::parse(value).ok()?;
        // 평문 ws://는 같은 기기의 로컬 시험 스택(scripts/relay_stack.py)에만 허용한다.
        let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        let secure = url.scheme() == "wss" || (url.scheme() == "ws" && loopback);
        if !secure || url.host_str().is_none() || !url.username().is_empty()
            || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || url.path() != "/" {
            return None;
        }
        Some(url.as_str().trim_end_matches('/').to_string())
    }

    pub fn endpoint(&self) -> String { format!("{}/api/e2ee/{}", self.base, self.room) }
}

type Error = Box<dyn std::error::Error + Send + Sync>;
#[derive(Debug, thiserror::Error)]
enum SessionError {
    #[error("heartbeat_timeout")]
    HeartbeatTimeout,
    #[error("invalid_control")]
    InvalidControl,
    #[error("control_closed")]
    ControlClosed,
}

// 원본 오류에는 URL·응답 헤더가 포함될 수 있다. 로그에는 분류와 HTTP 상태만 남긴다.
fn failure_details(error: &Error) -> (&'static str, Option<u16>) {
    if let Some(error) = error.downcast_ref::<SessionError>() {
        return (match error {
            SessionError::HeartbeatTimeout => "heartbeat_timeout",
            SessionError::InvalidControl => "invalid_control",
            SessionError::ControlClosed => "control_closed",
        }, None);
    }
    if error.is::<tokio::time::error::Elapsed>() { return ("timeout", None); }
    if let Some(error) = error.downcast_ref::<tokio_tungstenite::tungstenite::Error>() {
        use tokio_tungstenite::tungstenite::Error;
        return match error {
            Error::Http(response) => (match response.status().as_u16() {
                401 | 403 => "authentication_rejected",
                409 => "control_conflict",
                429 => "rate_limited",
                _ => "http_rejected",
            }, Some(response.status().as_u16())),
            Error::Io(_) => ("network", None),
            Error::Tls(_) => ("tls", None),
            Error::ConnectionClosed | Error::AlreadyClosed => ("connection_closed", None),
            _ => ("websocket", None),
        };
    }
    ("transport", None)
}

async fn connect(settings: &Settings, path: &str) -> Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Error> {
    let mut request = format!("{}/relay/{}/{}", settings.base, settings.room, path).into_client_request()?;
    request.headers_mut().insert("Authorization", format!("Bearer {}", settings.token).parse()?);
    let config = WebSocketConfig::default().max_message_size(Some(crate::e2ee::MAX_FRAME))
        .max_frame_size(Some(crate::e2ee::MAX_FRAME));
    Ok(tokio::time::timeout(Duration::from_secs(10), connect_async_with_config(request, Some(config), true)).await??.0)
}

async fn bridge(settings: Arc<Settings>, addr: SocketAddr, id: String) -> Result<(), Error> {
    let config = WebSocketConfig::default().max_message_size(Some(crate::e2ee::MAX_FRAME))
        .max_frame_size(Some(crate::e2ee::MAX_FRAME));
    let (mut local, _) = tokio::time::timeout(Duration::from_secs(10),
        connect_async_with_config(format!("ws://{addr}/api/e2ee"), Some(config), true)).await??;
    let mut remote = connect(&settings, &format!("data/{id}")).await?;
    let result = relay_frames(&mut local, &mut remote).await;
    // 한쪽이 끝나도 다른 쪽을 그냥 drop하지 않는다. close frame을 보내야 직전에 보낸 응답 끝 frame이
    // 릴레이에 먼저 도착한다. drop하면 TCP가 끊겨 릴레이가 응답 끝 전에 브라우저 연결을 1008로 닫는다.
    let close = Duration::from_secs(5);
    // 상대의 close까지 읽어 낸 뒤 끊는다. 읽지 않은 frame이 남은 채 끊으면 TCP RST로 직전 frame이 버려질 수 있다.
    let _ = tokio::time::timeout(close, async {
        let _ = remote.close(None).await;
        while let Some(Ok(_)) = remote.next().await {}
    }).await;
    let _ = tokio::time::timeout(close, async {
        let _ = local.close(None).await;
        while let Some(Ok(_)) = local.next().await {}
    }).await;
    result
}

async fn relay_frames<L, R>(local: &mut L, remote: &mut R) -> Result<(), Error>
where
    L: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
    R: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    loop {
        tokio::select! {
            message = remote.next() => {
                let Some(message) = message else { break; };
                match message? {
                    Message::Text(t) => tokio::time::timeout(Duration::from_secs(30), local.send(Message::Text(t))).await??,
                    Message::Binary(b) => tokio::time::timeout(Duration::from_secs(30), local.send(Message::Binary(b))).await??,
                    Message::Close(_) => break,
                    _ => {},
                }
            }
            message = local.next() => {
                let Some(message) = message else { break; };
                match message? {
                    Message::Text(t) => tokio::time::timeout(Duration::from_secs(30), remote.send(Message::Text(t))).await??,
                    Message::Binary(b) => tokio::time::timeout(Duration::from_secs(30), remote.send(Message::Binary(b))).await??,
                    Message::Close(_) => break,
                    _ => {},
                }
            }
        }
    }
    Ok(())
}

async fn session(settings: Arc<Settings>, addr: SocketAddr) -> Result<(), Error> {
    let mut control = connect(&settings, "control").await?;
    let mut children = JoinSet::new();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    let mut alive = true;
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if !alive { return Err(SessionError::HeartbeatTimeout.into()); }
                alive = false;
                tokio::time::timeout(Duration::from_secs(10), control.send(Message::Text("ping".into()))).await??;
            }
            message = control.next() => {
                let Some(message) = message else { return Err(SessionError::ControlClosed.into()); };
                match message? {
                    Message::Text(text) if text == "pong" => alive = true,
                    Message::Text(text) => {
                        if text.len() > 256 { return Err(SessionError::InvalidControl.into()); }
                        #[derive(serde::Deserialize)]
                        #[serde(deny_unknown_fields)]
                        struct Open { r#type: String, id: String }
                        let open: Open = serde_json::from_str(&text).map_err(|_| SessionError::InvalidControl)?;
                        let id = uuid::Uuid::parse_str(&open.id).map_err(|_| SessionError::InvalidControl)?;
                        if open.r#type != "open" || id.get_version_num() != 4 || id.to_string() != open.id {
                            return Err(SessionError::InvalidControl.into());
                        }
                        if children.len() < 64 {
                            let settings = settings.clone();
                            children.spawn(async move {
                                if let Err(error) = bridge(settings, addr, open.id).await {
                                    let (reason, http_status) = failure_details(&error);
                                    tracing::warn!(reason, http_status, "릴레이 데이터 연결에 실패했습니다");
                                }
                            });
                        }
                    }
                    Message::Close(_) => break,
                    Message::Ping(_) | Message::Pong(_) => {},
                    _ => return Err(SessionError::InvalidControl.into()),
                }
            }
            _ = children.join_next(), if !children.is_empty() => {},
        }
    }
    // JoinSet drop은 모든 연결을 종료한다. 제어 연결이 끊기면 기존 data 연결도 재사용하지 않는다.
    Ok(())
}

pub fn spawn(settings: Arc<Settings>, addr: SocketAddr, mut shutdown: watch::Receiver<bool>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut delay = 1;
        while !*shutdown.borrow() {
            let began = std::time::Instant::now();
            let result = tokio::select! {
                _ = shutdown.wait_for(|v| *v) => break,
                result = session(settings.clone(), addr) => result,
            };
            if *shutdown.borrow() { break; }
            if began.elapsed() > Duration::from_secs(60) { delay = 1; }
            let (reason, http_status) = result.as_ref().err().map(failure_details).unwrap_or(("control_closed", None));
            tracing::warn!(reason, http_status, retry_after_seconds = delay, "릴레이 연결이 종료됐습니다. 다시 연결합니다");
            tokio::select! {
                _ = shutdown.wait_for(|v| *v) => break,
                _ = tokio::time::sleep(Duration::from_secs(delay)) => {},
            }
            delay = (delay * 2).min(60);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relay_failures_report_only_classification_and_http_status() {
        use tokio_tungstenite::tungstenite::{Error as WsError, http::Response};
        for (status, expected) in [(401, "authentication_rejected"), (403, "authentication_rejected"),
            (409, "control_conflict"), (429, "rate_limited"), (503, "http_rejected")] {
            let error: Error = WsError::Http(Box::new(Response::builder().status(status).body(None).unwrap())).into();
            assert_eq!(failure_details(&error), (expected, Some(status)));
        }
        let error: Error = SessionError::HeartbeatTimeout.into();
        assert_eq!(failure_details(&error), ("heartbeat_timeout", None));
        let error: Error = SessionError::InvalidControl.into();
        assert_eq!(failure_details(&error), ("invalid_control", None));
    }

    #[test]
    fn rejects_unsafe_relay_addresses() {
        for url in ["ws://example.com", "ws://10.0.0.1:8787", "wss://user:secret@example.com", "wss://example.com/path", "wss://example.com?token=x", "wss://example.com#x"] {
            assert!(Settings::validate_url(url).is_none());
        }
        assert_eq!(Settings::validate_url("wss://relay.example.com").unwrap(), "wss://relay.example.com");
        assert_eq!(Settings::validate_url("ws://127.0.0.1:8787").unwrap(), "ws://127.0.0.1:8787");
    }
    #[test]
    fn absent_is_local_but_invalid_config_is_fatal() {
        let dir = tempfile::tempdir().unwrap();
        assert!(Settings::load(dir.path(), &[1; 32]).unwrap().is_none());
        std::fs::write(dir.path().join("relay.json"), "{}").unwrap();
        assert!(Settings::load(dir.path(), &[1; 32]).is_err());
    }

    #[tokio::test]
    async fn real_relay_preserves_e2ee_authentication_and_shutdown() {
        use base64::{Engine, engine::general_purpose::STANDARD as B64};
        use curve25519_dalek::montgomery::MontgomeryPoint;
        use ed25519_dalek::{Signature, VerifyingKey};
        use tokio::io::{AsyncBufReadExt, BufReader};
        use serde_json::{json, Value};
        let dir = tempfile::tempdir().unwrap();
        let cfg = crate::config::Config::from_env(Some(dir.path().into()), Some("127.0.0.1:0".parse().unwrap())).unwrap();
        let server = crate::server::start(cfg, Arc::new(crate::util::SystemClock)).await.unwrap();
        let identity = server.app.e2ee.identity_for_test();
        let room: String = Sha256::digest(identity).iter().map(|b| format!("{b:02x}")).collect();
        let token = crate::util::random_secret(32);
        let token: String = Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        let mut fixture = tokio::process::Command::new("node").arg("relay/fixture.mjs")
            .env("TEST_ROOM", &room).env("TEST_TOKEN", &token)
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit()).kill_on_drop(true).spawn().unwrap();
        let mut lines = BufReader::new(fixture.stdout.take().unwrap()).lines();
        let url = tokio::time::timeout(Duration::from_secs(15), lines.next_line()).await.unwrap().unwrap().unwrap();
        let base = url.trim_end_matches('/').replace("http:", "ws:");
        let settings = Arc::new(Settings { base: base.clone(), token, room: room.clone() });
        // 실제 제어 연결의 완료를 기다리고 임의 sleep·접속 재시도는 쓰지 않는다.
        let mut control = connect(&settings, "control").await.unwrap();
        let task = tokio::spawn(async move {
            loop {
                let text = control.next().await.unwrap().unwrap();
                if let Message::Text(text) = text {
                    let open: Value = serde_json::from_str(&text).unwrap();
                    return bridge(settings, server.addr, open["id"].as_str().unwrap().into()).await;
                }
            }
        });
        let mut request = format!("{base}/api/e2ee/{room}").into_client_request().unwrap();
        request.headers_mut().insert("Origin", crate::e2ee::PAGES_ORIGIN.parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        let secret: [u8; 32] = rand::random();
        let public = MontgomeryPoint::mul_base_clamped(secret).to_bytes();
        socket.send(Message::Text(json!({ "version": 1, "key": B64.encode(public) }).to_string().into())).await.unwrap();
        let hello = tokio::time::timeout(Duration::from_secs(10), socket.next()).await.unwrap().unwrap().unwrap();
        let hello: Value = serde_json::from_str(hello.to_text().unwrap()).unwrap();
        let peer: [u8; 32] = B64.decode(hello["key"].as_str().unwrap()).unwrap().try_into().unwrap();
        let transcript = crate::e2ee::transcript(&public, &peer, &identity);
        VerifyingKey::from_bytes(&identity).unwrap().verify_strict(&transcript,
            &Signature::from_slice(&B64.decode(hello["signature"].as_str().unwrap()).unwrap()).unwrap()).unwrap();
        let shared = MontgomeryPoint(peer).mul_clamped(secret).to_bytes();
        let (mut tx, mut rx) = crate::e2ee::keys(&shared, &transcript);
        let op = json!({ "kind": "http", "method": "GET", "path": "/api/v1/projects", "headers": [], "body": "" });
        socket.send(Message::Binary(tx.seal(op.to_string().as_bytes()).unwrap().into())).await.unwrap();
        let response = tokio::time::timeout(Duration::from_secs(10), socket.next()).await.unwrap().unwrap().unwrap();
        assert!(response.is_binary(), "API 본문은 릴레이에 평문으로 전달하면 안 된다");
        let headers: Value = serde_json::from_slice(&rx.open(&response.into_data()).unwrap()).unwrap();
        assert_eq!(headers["status"], 401, "릴레이 접속 자체는 API 권한을 주지 않는다");
        socket.close(None).await.unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(5), task).await.unwrap();
        server.stop().await;
        drop(fixture.stdin.take());
        assert!(tokio::time::timeout(Duration::from_secs(10), fixture.wait()).await.unwrap().unwrap().success());
    }

    /// 데몬이 응답 끝 frame을 보낸 직후 연결을 닫아도 릴레이는 끝 frame을 먼저 브라우저에 전달해야 한다.
    /// bridge가 릴레이 쪽 연결을 close 없이 drop하면 일부 요청이 끝 frame 없이 1008로 끊겼다.
    #[tokio::test]
    async fn real_relay_delivers_response_end_before_close() {
        use base64::{Engine, engine::general_purpose::STANDARD as B64};
        use curve25519_dalek::montgomery::MontgomeryPoint;
        use tokio::io::{AsyncBufReadExt, BufReader};
        use serde_json::{json, Value};
        let dir = tempfile::tempdir().unwrap();
        let cfg = crate::config::Config::from_env(Some(dir.path().into()), Some("127.0.0.1:0".parse().unwrap())).unwrap();
        let server = crate::server::start(cfg, Arc::new(crate::util::SystemClock)).await.unwrap();
        let identity = server.app.e2ee.identity_for_test();
        let room: String = Sha256::digest(identity).iter().map(|b| format!("{b:02x}")).collect();
        let token = crate::util::random_secret(32);
        let token: String = Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        let mut fixture = tokio::process::Command::new("node").arg("relay/fixture.mjs")
            .env("TEST_ROOM", &room).env("TEST_TOKEN", &token)
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit()).kill_on_drop(true).spawn().unwrap();
        let mut lines = BufReader::new(fixture.stdout.take().unwrap()).lines();
        let url = tokio::time::timeout(Duration::from_secs(15), lines.next_line()).await.unwrap().unwrap().unwrap();
        let base = url.trim_end_matches('/').replace("http:", "ws:");
        let settings = Arc::new(Settings { base: base.clone(), token, room: room.clone() });
        // 실서비스와 같은 제어 연결 처리(session)로 요청마다 bridge를 연다.
        let (_stop, stop_rx) = watch::channel(false);
        let relay = spawn(settings, server.addr, stop_rx);
        let mut failures = Vec::new();
        for attempt in 0..30 {
            let mut request = format!("{base}/api/e2ee/{room}").into_client_request().unwrap();
            request.headers_mut().insert("Origin", crate::e2ee::PAGES_ORIGIN.parse().unwrap());
            // 제어 연결이 붙기 전이면 릴레이가 503을 준다. 시험 시작의 그 상태만 다시 시도한다.
            let mut socket = loop {
                match tokio_tungstenite::connect_async(request.clone()).await {
                    Ok((socket, _)) => break socket,
                    Err(tokio_tungstenite::tungstenite::Error::Http(r)) if r.status() == 503 && attempt == 0 => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    Err(e) => panic!("릴레이 접속 실패: {e}"),
                }
            };
            let secret: [u8; 32] = rand::random();
            let public = MontgomeryPoint::mul_base_clamped(secret).to_bytes();
            socket.send(Message::Text(json!({ "version": 1, "key": B64.encode(public) }).to_string().into())).await.unwrap();
            let hello = tokio::time::timeout(Duration::from_secs(10), socket.next()).await.unwrap().unwrap().unwrap();
            let hello: Value = serde_json::from_str(hello.to_text().unwrap()).unwrap();
            let peer: [u8; 32] = B64.decode(hello["key"].as_str().unwrap()).unwrap().try_into().unwrap();
            let transcript = crate::e2ee::transcript(&public, &peer, &identity);
            let shared = MontgomeryPoint(peer).mul_clamped(secret).to_bytes();
            let (mut tx, mut rx) = crate::e2ee::keys(&shared, &transcript);
            let op = json!({ "kind": "http", "method": "GET", "path": "/api/v1/health", "headers": [], "body": "" });
            socket.send(Message::Binary(tx.seal(op.to_string().as_bytes()).unwrap().into())).await.unwrap();
            let mut finished = false;
            let mut frames = 0;
            while let Ok(Some(Ok(message))) = tokio::time::timeout(Duration::from_secs(10), socket.next()).await {
                let Message::Binary(bytes) = message else { break };
                let plain = rx.open(&bytes).unwrap();
                frames += 1;
                if frames == 1 { continue; }
                if plain == [2] { finished = true; break; }
                socket.send(Message::Binary(tx.seal(&[1]).unwrap().into())).await.unwrap();
            }
            if !finished { failures.push(attempt); }
            let _ = socket.close(None).await;
        }
        relay.abort();
        server.stop().await;
        drop(fixture.stdin.take());
        let _ = tokio::time::timeout(Duration::from_secs(10), fixture.wait()).await;
        assert!(failures.is_empty(), "응답 끝 frame 없이 끊긴 요청: {failures:?}");
    }
}
