//! 암호화 연결 하나에서 여러 HTTP 요청을 다중화한다(handshake version 2).
//! 요청마다 relay 연결·handshake를 새로 맺던 지연과 끊김 영향을 없앤다.
//! frame 평문: [종류 1byte][stream ID u32 BE][payload]. 방향별 AES-GCM nonce 순서를 위해 쓰기는 한 곳에서만 한다.
//! handler는 연결이 끊겨도 끝까지 실행한다. 응답을 받지 못한 변경은 기존처럼 같은 요청 키로 결과를 확인한다.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use axum::extract::{Request, ws::{Message, WebSocket}};
use axum::response::{IntoResponse, Response};
use futures_util::{Sink, SinkExt, StreamExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tower::ServiceExt;
use super::{CHUNK, Cipher, Failure, IO_WAIT, MAX_BODY, Operation, headers_frame, http_request, invalid};
use crate::App;

// 브라우저 → 서버
pub(super) const OPEN: u8 = 0x01;
pub(super) const ACK: u8 = 0x02;
pub(super) const CANCEL: u8 = 0x03;
pub(super) const PING: u8 = 0x04;
pub(super) const OPEN_BODY: u8 = 0x05;
pub(super) const BODY: u8 = 0x06;
pub(super) const BODY_END: u8 = 0x07;
// 서버 → 브라우저
pub(super) const HEADERS: u8 = 0x11;
pub(super) const DATA: u8 = 0x12;
pub(super) const END: u8 = 0x13;
pub(super) const FAIL: u8 = 0x14;
pub(super) const PONG: u8 = 0x15;
pub(super) const BODY_ACK: u8 = 0x16;

const BODY_CHUNK: usize = 1024 * 1024;
struct Incoming {
    request: Request,
    bytes: Vec<u8>,
    permits: [OwnedSemaphorePermit; 3],
    updated: tokio::time::Instant,
}

/// 연결당 동시에 처리하는 stream 수. 넘으면 그 요청만 실패로 알린다.
const STREAMS: usize = 64;
/// ACK 없이 먼저 보낼 수 있는 본문 chunk 수. 응답마다 왕복을 한 번 더 기다리지 않게 하면서
/// 느린 화면의 메모리 상한(stream당 WINDOW × CHUNK)을 유지한다.
const WINDOW: usize = 8;
/// 브라우저는 15초마다 PING을 보낸다. 이 시간 동안 아무 frame도 없으면 죽은 연결로 보고 닫는다.
const IDLE: Duration = Duration::from_secs(60);

pub(super) fn frame(kind: u8, id: u32, payload: &[u8]) -> Vec<u8> {
    [&[kind][..], &id.to_be_bytes(), payload].concat()
}

async fn write<S>(sink: &mut S, tx: &mut Cipher, plain: &[u8]) -> Result<(), Failure>
where S: Sink<Message> + Unpin, S::Error: std::error::Error + Send + Sync + 'static {
    let sealed = tx.seal(plain)?;
    tokio::time::timeout(IO_WAIT, sink.send(Message::Binary(sealed.into()))).await??;
    Ok(())
}

pub(super) async fn serve(app: &App, host: &str, ws: &mut WebSocket, mut rx: Cipher, mut tx: Cipher) -> Result<(), Failure> {
    let (mut sink, mut stream) = (&mut *ws).split();
    // stream task가 만든 평문 frame. 암호화·전송은 이 loop에서만 해 nonce 순서를 지킨다.
    let (out, mut outgoing) = mpsc::channel::<Vec<u8>>(256);
    // stream별 ACK 전달. sender를 버리면(CANCEL·연결 종료) task가 응답 전송을 멈춘다.
    let mut streams: HashMap<u32, mpsc::Sender<()>> = HashMap::new();
    let mut incoming: HashMap<u32, Incoming> = HashMap::new();
    let mut expiry = tokio::time::interval(Duration::from_secs(5));
    let idle = tokio::time::sleep(IDLE);
    tokio::pin!(idle);
    let slots = Arc::new(Semaphore::new(STREAMS));
    loop {
        tokio::select! {
            _ = &mut idle => return Err(invalid()),
            _ = expiry.tick() => {
                let expired: Vec<_> = incoming.iter().filter(|(_, upload)| upload.updated.elapsed() >= IO_WAIT)
                    .map(|(id, _)| *id).collect();
                for id in expired {
                    incoming.remove(&id);
                    write(&mut sink, &mut tx, &frame(FAIL, id, &[])).await?;
                }
            }
            Some(plain) = outgoing.recv() => write(&mut sink, &mut tx, &plain).await?,
            message = stream.next() => {
                let message = message.ok_or_else(invalid)??;
                idle.as_mut().reset(tokio::time::Instant::now() + IDLE);
                let bytes = match message {
                    Message::Binary(bytes) => bytes,
                    Message::Ping(_) | Message::Pong(_) => continue,
                    Message::Close(_) => return Ok(()),
                    Message::Text(_) => return Err(invalid()),
                };
                let plain = rx.open(&bytes)?;
                if plain.len() < 5 { return Err(invalid()); }
                let id = u32::from_be_bytes([plain[1], plain[2], plain[3], plain[4]]);
                let payload = &plain[5..];
                match plain[0] {
                    PING => write(&mut sink, &mut tx, &frame(PONG, id, &[])).await?,
                    ACK => { if let Some(ack) = streams.get(&id) { let _ = ack.try_send(()); } }
                    CANCEL => { streams.remove(&id); incoming.remove(&id); }
                    OPEN_BODY => {
                        streams.retain(|_, ack| !ack.is_closed());
                        if streams.contains_key(&id) || incoming.contains_key(&id) { return Err(invalid()); }
                        let request = (payload.len() <= 64 * 1024).then(|| serde_json::from_slice::<Operation>(payload).ok())
                            .flatten().filter(|op| op.body.is_empty()).and_then(|op| http_request(host, op).ok());
                        let Some(request) = request.filter(|_| streams.len() + incoming.len() < STREAMS) else {
                            write(&mut sink, &mut tx, &frame(FAIL, id, &[])).await?;
                            continue;
                        };
                        // 큰 본문용 슬롯은 인증한 요청만 쓴다. 완성 뒤에도 API의 원래 인증·권한 검사를 거친다.
                        if let Err(error) = crate::auth::authenticate(app, request.headers()).await {
                            let (ack, acks) = mpsc::channel(WINDOW);
                            streams.insert(id, ack);
                            let out = out.clone();
                            tokio::spawn(async move { respond_response(error.into_response(), id, out, acks).await; });
                            continue;
                        }
                        let permits = slots.clone().try_acquire_owned().ok()
                            .zip(app.e2ee.request_slots.clone().try_acquire_owned().ok())
                            .zip(app.e2ee.upload_slots.clone().try_acquire_owned().ok());
                        let Some(((connection, request_slot), upload)) = permits else {
                            write(&mut sink, &mut tx, &frame(FAIL, id, &[])).await?;
                            continue;
                        };
                        incoming.insert(id, Incoming { request, bytes: vec![], permits: [connection, request_slot, upload], updated: tokio::time::Instant::now() });
                        write(&mut sink, &mut tx, &frame(BODY_ACK, id, &[])).await?;
                    }
                    BODY => {
                        let valid = incoming.get_mut(&id).filter(|upload| !payload.is_empty()
                            && payload.len() <= BODY_CHUNK && payload.len() <= MAX_BODY - upload.bytes.len());
                        if let Some(upload) = valid {
                            upload.bytes.extend_from_slice(payload);
                            upload.updated = tokio::time::Instant::now();
                            write(&mut sink, &mut tx, &frame(BODY_ACK, id, &[])).await?;
                        } else {
                            incoming.remove(&id);
                            write(&mut sink, &mut tx, &frame(FAIL, id, &[])).await?;
                        }
                    }
                    BODY_END => {
                        let upload = incoming.remove(&id).filter(|_| payload.is_empty());
                        let Some(mut upload) = upload else {
                            write(&mut sink, &mut tx, &frame(FAIL, id, &[])).await?;
                            continue;
                        };
                        *upload.request.body_mut() = axum::body::Body::from(upload.bytes);
                        let (ack, acks) = mpsc::channel(WINDOW);
                        streams.insert(id, ack);
                        let (app, out) = (app.clone(), out.clone());
                        tokio::spawn(async move {
                            // 전송 중단·연결 종료로 실행 중인 handler의 슬롯이 먼저 풀리지 않게 한다.
                            let _permits = upload.permits;
                            respond(app, upload.request, id, out, acks).await;
                        });
                    }
                    OPEN => {
                        streams.retain(|_, ack| !ack.is_closed());
                        if streams.contains_key(&id) || incoming.contains_key(&id) { return Err(invalid()); }
                        let request = serde_json::from_slice::<Operation>(payload).ok()
                            .and_then(|op| http_request(host, op).ok());
                        let Some(request) = request.filter(|_| streams.len() + incoming.len() < STREAMS) else {
                            write(&mut sink, &mut tx, &frame(FAIL, id, &[])).await?;
                            continue;
                        };
                        let permits = slots.clone().try_acquire_owned().ok()
                            .zip(app.e2ee.request_slots.clone().try_acquire_owned().ok());
                        let Some(permits) = permits else {
                            write(&mut sink, &mut tx, &frame(FAIL, id, &[])).await?;
                            continue;
                        };
                        let (ack, acks) = mpsc::channel(WINDOW);
                        streams.insert(id, ack);
                        let app = app.clone();
                        let out = out.clone();
                        tokio::spawn(async move {
                            // CANCEL·연결 종료 뒤에도 실행 중인 handler가 끝날 때까지 슬롯을 보유한다.
                            // 재연결이나 취소 반복으로 실행 개수 상한을 우회하지 못한다.
                            let _permits = permits;
                            respond(app, request, id, out, acks).await;
                        });
                    }
                    _ => return Err(invalid()),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD as B64};
    use curve25519_dalek::montgomery::MontgomeryPoint;
    use serde_json::{Value, json};
    use tokio_tungstenite::tungstenite::Message as T;

    type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

    async fn next_frame(socket: &mut Socket, rx: &mut Cipher) -> (u8, u32, Vec<u8>) {
        loop {
            let message = tokio::time::timeout(Duration::from_secs(10), socket.next()).await.unwrap().unwrap().unwrap();
            if let T::Binary(bytes) = message {
                let plain = rx.open(&bytes).unwrap();
                return (plain[0], u32::from_be_bytes([plain[1], plain[2], plain[3], plain[4]]), plain[5..].to_vec());
            }
        }
    }

    async fn put(socket: &mut Socket, tx: &mut Cipher, kind: u8, id: u32, payload: &[u8]) {
        socket.send(T::Binary(tx.seal(&frame(kind, id, payload)).unwrap().into())).await.unwrap();
    }

    fn get(path: &str) -> Vec<u8> {
        json!({ "kind": "http", "method": "GET", "path": path, "headers": [], "body": "" }).to_string().into_bytes()
    }

    #[tokio::test]
    async fn one_connection_serves_concurrent_requests_ping_and_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = crate::config::Config::from_env(Some(dir.path().into()), Some("127.0.0.1:0".parse().unwrap())).unwrap();
        let server = crate::server::start(cfg, Arc::new(crate::util::SystemClock)).await.unwrap();
        let identity = server.app.e2ee.identity_for_test();
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{}/api/e2ee", server.addr)).await.unwrap();
        let secret: [u8; 32] = rand::random();
        let public = MontgomeryPoint::mul_base_clamped(secret).to_bytes();
        socket.send(T::Text(json!({ "version": 2, "key": B64.encode(public) }).to_string().into())).await.unwrap();
        let hello: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(hello["version"], 2, "요청한 다중화 버전으로 응답해야 한다");
        let peer: [u8; 32] = B64.decode(hello["key"].as_str().unwrap()).unwrap().try_into().unwrap();
        let transcript = super::super::transcript(&public, &peer, &identity);
        let (mut tx, mut rx) = super::super::keys(&MontgomeryPoint(peer).mul_clamped(secret).to_bytes(), &transcript);

        // 같은 연결에서 세 요청을 한꺼번에 보낸다. 응답 순서와 무관하게 stream ID별로 끝까지 받는다.
        put(&mut socket, &mut tx, OPEN, 1, &get("/api/v1/health")).await;
        put(&mut socket, &mut tx, OPEN, 3, &get("/api/v1/projects")).await;
        put(&mut socket, &mut tx, OPEN, 5, &get("/api/v1/health")).await;
        let mut status: HashMap<u32, u64> = HashMap::new();
        let mut ended = Vec::new();
        while ended.len() < 3 {
            let (kind, id, payload) = next_frame(&mut socket, &mut rx).await;
            match kind {
                HEADERS => { status.insert(id, serde_json::from_slice::<Value>(&payload).unwrap()["status"].as_u64().unwrap()); }
                DATA => put(&mut socket, &mut tx, ACK, id, &[]).await,
                END => ended.push(id),
                other => panic!("예상하지 못한 frame {other}"),
            }
        }
        ended.sort();
        assert_eq!(ended, [1, 3, 5]);
        assert_eq!((status[&1], status[&3], status[&5]), (200, 401, 200), "인증은 stream마다 따로 판단한다");

        put(&mut socket, &mut tx, PING, 7, &[]).await;
        assert_eq!(next_frame(&mut socket, &mut rx).await.0, PONG);

        // 잘못된 요청은 그 stream만 실패로 알리고 연결은 유지한다.
        put(&mut socket, &mut tx, OPEN, 9, b"{}").await;
        assert_eq!(next_frame(&mut socket, &mut rx).await, (FAIL, 9, vec![]));
        put(&mut socket, &mut tx, PING, 11, &[]).await;
        assert_eq!(next_frame(&mut socket, &mut rx).await.0, PONG);

        // 다른 연결에서 실행 중인 작업까지 서버 전체 상한에 포함한다.
        let occupied = server.app.e2ee.request_slots.clone().acquire_many_owned(128).await.unwrap();
        put(&mut socket, &mut tx, OPEN, 13, &get("/api/v1/health")).await;
        assert_eq!(next_frame(&mut socket, &mut rx).await, (FAIL, 13, vec![]));
        drop(occupied);
        put(&mut socket, &mut tx, OPEN, 15, &get("/api/v1/health")).await;
        loop {
            let (kind, id, _) = next_frame(&mut socket, &mut rx).await;
            assert_eq!(id, 15);
            if kind == DATA { put(&mut socket, &mut tx, ACK, id, &[]).await; }
            if kind == END { break; }
            assert_ne!(kind, FAIL, "실행 슬롯이 반환되면 같은 연결에서 다시 처리해야 한다");
        }

        // 취소한 요청이 있어도 연결은 계속 쓴다. 취소한 stream의 늦은 frame은 무시해도 된다.
        put(&mut socket, &mut tx, OPEN, 17, &get("/api/v1/health")).await;
        put(&mut socket, &mut tx, CANCEL, 17, &[]).await;
        put(&mut socket, &mut tx, OPEN, 19, &get("/api/v1/health")).await;
        loop {
            let (kind, id, _) = next_frame(&mut socket, &mut rx).await;
            if id == 19 && kind == DATA { put(&mut socket, &mut tx, ACK, 19, &[]).await; }
            if id == 19 && kind == END { break; }
            assert!(id == 17 || id == 19, "다른 stream frame이 섞이면 안 된다");
        }

        server.stop().await;
    }
}

async fn respond(app: App, request: Request, id: u32, out: mpsc::Sender<Vec<u8>>, acks: mpsc::Receiver<()>) {
    // 로그인 시 IP를 위조하지 않는다. 원격 E2EE 로그인은 하나의 잠금 bucket을 공유한다.
    let response = match crate::router(app).oneshot(request).await { Ok(response) => response, Err(never) => match never {} };
    respond_response(response, id, out, acks).await;
}

async fn respond_response(response: Response, id: u32, out: mpsc::Sender<Vec<u8>>, mut acks: mpsc::Receiver<()>) {
    let (parts, body) = response.into_parts();
    if out.send(frame(HEADERS, id, &headers_frame(&parts))).await.is_err() { return; }
    let mut body = body.into_data_stream();
    // 브라우저가 아직 소비하지 않은(ACK 전) chunk 수.
    let mut outstanding = 0usize;
    loop {
        // 다음 본문을 기다리는 동안 ACK를 반영하고 CANCEL·연결 종료(ACK 채널 닫힘)를 감지한다. SSE는 여기서 오래 기다린다.
        let next = tokio::select! {
            next = body.next() => next,
            ack = acks.recv() => match ack {
                Some(()) => { outstanding = outstanding.saturating_sub(1); continue; }
                None => return,
            },
        };
        match next {
            None => { let _ = out.send(frame(END, id, &[])).await; return; }
            Some(Err(_)) => { let _ = out.send(frame(FAIL, id, &[])).await; return; }
            Some(Ok(bytes)) => for chunk in bytes.chunks(CHUNK) {
                // 브라우저가 소비해 ACK할 때까지 WINDOW개를 넘겨 보내지 않는다.
                while outstanding >= WINDOW {
                    match tokio::time::timeout(IO_WAIT, acks.recv()).await {
                        Ok(Some(())) => outstanding -= 1,
                        Ok(None) => return,
                        Err(_) => { let _ = out.send(frame(FAIL, id, &[])).await; return; }
                    }
                }
                if out.send(frame(DATA, id, chunk)).await.is_err() { return; }
                outstanding += 1;
            },
        }
    }
}
