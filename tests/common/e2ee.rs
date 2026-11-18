//! 독립 클라이언트로 실제 WebSocket wire를 확인한다.
use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use curve25519_dalek::montgomery::MontgomeryPoint;
use ed25519_dalek::{Signature, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use hkdf::Hkdf;
use rand::RngCore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::{Message, client::IntoClientRequest}};

pub struct Channel {
    pub socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    pub receive_timeout: std::time::Duration,
    send: Aes256Gcm,
    receive: Aes256Gcm,
    sent: u64,
    received: u64,
}

impl Channel {
    pub async fn open(server: &super::TestServer, host: Option<&str>, origin: Option<&str>) -> Self {
        let identity: [u8; 32] = B64.decode(server.server.as_ref().unwrap().app.e2ee.public_key()).unwrap().try_into().unwrap();
        Self::open_with_identity(&server.base, identity, host, origin).await
    }
    pub async fn open_with_identity(base: &str, identity: [u8; 32], host: Option<&str>, origin: Option<&str>) -> Self {
        Self::open_version(base, identity, host, origin, 1).await
    }
    pub async fn open_mux(server: &super::TestServer) -> Self {
        let identity = B64.decode(server.server.as_ref().unwrap().app.e2ee.public_key()).unwrap().try_into().unwrap();
        Self::open_version(&server.base, identity, None, None, 2).await
    }
    async fn open_version(base: &str, identity: [u8; 32], host: Option<&str>, origin: Option<&str>, version: u8) -> Self {
        let mut request = format!("{}/api/e2ee", base.replace("http:", "ws:")).into_client_request().unwrap();
        if let Some(host) = host { request.headers_mut().insert("host", host.parse().unwrap()); }
        if let Some(origin) = origin { request.headers_mut().insert("origin", origin.parse().unwrap()); }
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        let mut secret = [0u8; 32];
        rand::rng().fill_bytes(&mut secret);
        let public = MontgomeryPoint::mul_base_clamped(secret).to_bytes();
        socket.send(Message::Text(json!({ "version": version, "key": B64.encode(public) }).to_string().into())).await.unwrap();
        let hello: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(hello["version"], version);
        if version == 2 { assert_eq!(hello["request_body_chunks"], true); }
        let peer: [u8; 32] = B64.decode(hello["key"].as_str().unwrap()).unwrap().try_into().unwrap();
        let transcript = [b"grove-e2ee-v1".as_slice(), &public, &peer, &identity].concat();
        let signature = Signature::from_slice(&B64.decode(hello["signature"].as_str().unwrap()).unwrap()).unwrap();
        VerifyingKey::from_bytes(&identity).unwrap().verify_strict(&transcript, &signature).unwrap();
        let shared = MontgomeryPoint(peer).mul_clamped(secret).to_bytes();
        let hk = Hkdf::<Sha256>::new(Some(&Sha256::digest(&transcript)), &shared);
        let mut send = [0u8; 32];
        let mut receive = [0u8; 32];
        hk.expand(b"grove-e2ee-v1/c2s", &mut send).unwrap();
        hk.expand(b"grove-e2ee-v1/s2c", &mut receive).unwrap();
        Self { socket, receive_timeout: std::time::Duration::from_secs(5), send: Aes256Gcm::new_from_slice(&send).unwrap(), receive: Aes256Gcm::new_from_slice(&receive).unwrap(), sent: 0, received: 0 }
    }
    pub fn seal(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut nonce = [0u8; 12];
        nonce[4..].copy_from_slice(&self.sent.to_be_bytes());
        self.sent += 1;
        self.send.encrypt(Nonce::from_slice(&nonce), bytes).unwrap()
    }
    pub async fn send(&mut self, bytes: &[u8]) {
        let sealed = self.seal(bytes);
        self.socket.send(Message::Binary(sealed.into())).await.unwrap();
    }
    pub async fn receive(&mut self) -> Vec<u8> {
        let message = tokio::time::timeout(self.receive_timeout, self.socket.next()).await.unwrap().unwrap().unwrap();
        assert!(message.is_binary(), "application data must be ciphertext");
        let mut nonce = [0u8; 12];
        nonce[4..].copy_from_slice(&self.received.to_be_bytes());
        self.received += 1;
        self.receive.decrypt(Nonce::from_slice(&nonce), message.into_data().as_ref()).unwrap()
    }
    pub async fn request(&mut self, method: &str, path: &str, headers: Vec<(&str, String)>, body: Value) -> Value {
        self.send(json!({ "kind": "http", "method": method, "path": path, "headers": headers,
            "body": if body.is_null() { String::new() } else { B64.encode(body.to_string()) } }).to_string().as_bytes()).await;
        serde_json::from_slice(&self.receive().await).unwrap()
    }
    pub async fn body(&mut self) -> Vec<u8> {
        let mut body = vec![];
        loop {
            let frame = self.receive().await;
            if frame == [2] { break; }
            assert_eq!(frame[0], 1);
            body.extend_from_slice(&frame[1..]);
            self.send(&[1]).await;
        }
        body
    }
    pub async fn mux_send(&mut self, kind: u8, id: u32, payload: &[u8]) {
        self.send(&[&[kind][..], &id.to_be_bytes(), payload].concat()).await;
    }
    pub async fn mux_receive(&mut self) -> (u8, u32, Vec<u8>) {
        let frame = self.receive().await;
        assert!(frame.len() >= 5);
        (frame[0], u32::from_be_bytes(frame[1..5].try_into().unwrap()), frame[5..].to_vec())
    }
    pub async fn request_body(&mut self, method: &str, path: &str, headers: Vec<(&str, String)>, body: &[u8]) -> (Value, Vec<u8>) {
        self.mux_send(0x05, 1, json!({"kind":"http","method":method,"path":path,"headers":headers}).to_string().as_bytes()).await;
        assert_eq!(self.mux_receive().await, (0x16, 1, vec![]));
        for chunk in body.chunks(1024 * 1024) {
            self.mux_send(0x06, 1, chunk).await;
            assert_eq!(self.mux_receive().await, (0x16, 1, vec![]));
        }
        self.mux_send(0x07, 1, &[]).await;
        let mut meta = Value::Null;
        let mut bytes = vec![];
        loop {
            let (kind, id, payload) = self.mux_receive().await;
            assert_eq!(id, 1);
            match kind {
                0x11 => meta = serde_json::from_slice(&payload).unwrap(),
                0x12 => { bytes.extend_from_slice(&payload); self.mux_send(0x02, 1, &[]).await; }
                0x13 => return (meta, bytes),
                other => panic!("unexpected upload response kind {other}"),
            }
        }
    }
}
