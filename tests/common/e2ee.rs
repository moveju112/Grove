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
    send: Aes256Gcm,
    receive: Aes256Gcm,
    sent: u64,
    received: u64,
}

impl Channel {
    pub async fn open(server: &super::TestServer, host: Option<&str>, origin: Option<&str>) -> Self {
        let mut request = format!("{}/api/e2ee", server.base.replace("http:", "ws:")).into_client_request().unwrap();
        if let Some(host) = host { request.headers_mut().insert("host", host.parse().unwrap()); }
        if let Some(origin) = origin { request.headers_mut().insert("origin", origin.parse().unwrap()); }
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        let mut secret = [0u8; 32];
        rand::rng().fill_bytes(&mut secret);
        let public = MontgomeryPoint::mul_base_clamped(secret).to_bytes();
        socket.send(Message::Text(json!({ "version": 1, "key": B64.encode(public) }).to_string().into())).await.unwrap();
        let hello: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        let peer: [u8; 32] = B64.decode(hello["key"].as_str().unwrap()).unwrap().try_into().unwrap();
        let identity: [u8; 32] = B64.decode(server.server.as_ref().unwrap().app.e2ee.public_key()).unwrap().try_into().unwrap();
        let transcript = [b"grove-e2ee-v1".as_slice(), &public, &peer, &identity].concat();
        let signature = Signature::from_slice(&B64.decode(hello["signature"].as_str().unwrap()).unwrap()).unwrap();
        VerifyingKey::from_bytes(&identity).unwrap().verify_strict(&transcript, &signature).unwrap();
        let shared = MontgomeryPoint(peer).mul_clamped(secret).to_bytes();
        let hk = Hkdf::<Sha256>::new(Some(&Sha256::digest(&transcript)), &shared);
        let mut send = [0u8; 32];
        let mut receive = [0u8; 32];
        hk.expand(b"grove-e2ee-v1/c2s", &mut send).unwrap();
        hk.expand(b"grove-e2ee-v1/s2c", &mut receive).unwrap();
        Self { socket, send: Aes256Gcm::new_from_slice(&send).unwrap(), receive: Aes256Gcm::new_from_slice(&receive).unwrap(), sent: 0, received: 0 }
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
        let message = tokio::time::timeout(std::time::Duration::from_secs(5), self.socket.next()).await.unwrap().unwrap().unwrap();
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
}
