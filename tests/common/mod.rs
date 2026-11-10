//! 통합 시험 harness: 임시 데이터 디렉터리로 실제 서버를 기동하고 HTTP로 호출한다.
#![allow(dead_code)]

pub mod fixture;

use grove::config::Config;
use grove::server::Server;
use grove::util::SystemClock;
use reqwest::{Client, Method, Response, StatusCode};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

pub struct TestServer {
    pub server: Option<Server>,
    pub base: String,
    pub token: String,
    pub client: Client,
    pub dir: tempfile::TempDir,
    counter: AtomicU64,
}

pub fn config(data_dir: &Path) -> Config {
    Config {
        data_dir: data_dir.to_path_buf(),
        listen: "127.0.0.1:0".parse().unwrap(),
        allowed_origins: vec![],
        allowed_hosts: vec![],
        tls_terminated: false,
        web_dir: None,
        enable_tool_loop: true,
        approval_ttl_secs: 1800,
        scheduler_tick_ms: 100,
    }
}

impl TestServer {
    pub async fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config(&dir.path().join("data"));
        Self::start_with(dir, cfg).await
    }

    pub async fn start_with(dir: tempfile::TempDir, cfg: Config) -> Self {
        let server = grove::server::start(cfg, Arc::new(SystemClock)).await.expect("server start");
        let base = format!("http://{}", server.addr);
        let token = server.owner_token.clone();
        Self { server: Some(server), base, token, client: Client::new(), dir, counter: AtomicU64::new(0) }
    }

    pub fn data_dir(&self) -> PathBuf {
        self.dir.path().join("data")
    }

    /// 프로젝트 root로 쓸 임시 디렉터리를 만든다.
    pub fn make_project_dir(&self, name: &str) -> PathBuf {
        let p = self.dir.path().join("projects").join(name);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    pub fn key(&self) -> String {
        format!("k-{}", self.counter.fetch_add(1, Ordering::SeqCst))
    }

    pub async fn raw(&self, method: Method, path: &str, body: Option<Value>, key: Option<&str>, token: Option<&str>) -> Response {
        let mut rb = self.client.request(method, format!("{}{}", self.base, path));
        if let Some(t) = token.or(Some(self.token.as_str())) {
            if !t.is_empty() {
                rb = rb.bearer_auth(t);
            }
        }
        if let Some(k) = key {
            rb = rb.header("Idempotency-Key", k);
        }
        if let Some(b) = body {
            rb = rb.json(&b);
        }
        rb.send().await.unwrap()
    }

    pub async fn get(&self, path: &str) -> (StatusCode, Value) {
        let r = self.raw(Method::GET, path, None, None, None).await;
        let s = r.status();
        (s, r.json().await.unwrap_or(Value::Null))
    }

    pub async fn send(&self, method: Method, path: &str, body: Value) -> (StatusCode, Value) {
        let k = self.key();
        let r = self.raw(method, path, Some(body), Some(&k), None).await;
        let s = r.status();
        (s, r.json().await.unwrap_or(Value::Null))
    }

    pub async fn post(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.send(Method::POST, path, body).await
    }

    pub async fn create_project(&self, name: &str) -> Value {
        let dir = self.make_project_dir(name);
        let (s, v) = self.post("/api/v1/projects", json!({ "root_path": dir })).await;
        assert_eq!(s, StatusCode::CREATED, "{v}");
        v
    }

    pub async fn create_session(&self, project_id: &str) -> Value {
        let (s, v) = self.post(&format!("/api/v1/projects/{project_id}/sessions"), json!({})).await;
        assert_eq!(s, StatusCode::CREATED, "{v}");
        v
    }

    /// fixture endpoint를 가리키는 OpenAI 호환 모델 프로필을 만든다.
    pub async fn fixture_profile(&self, base_url: &str) -> String {
        let (st, sec) = self.post("/api/v1/secrets", json!({ "label": "fixture", "value": "sk-test-secret-value-1234" })).await;
        assert_eq!(st, StatusCode::CREATED, "{sec}");
        let (st, p) = self
            .post(
                "/api/v1/model-profiles",
                json!({ "name": "fixture", "protocol": "openai", "base_url": base_url, "model": "fixture-model", "secret_id": sec["id"], "options": { "timeout_secs": 30 } }),
            )
            .await;
        assert_eq!(st, StatusCode::CREATED, "{p}");
        p["id"].as_str().unwrap().to_string()
    }

    /// 턴 상태가 조건을 만족할 때까지 기다린다.
    pub async fn wait_turn(&self, turn_id: &str, pred: impl Fn(&Value) -> bool) -> Value {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let (_, t) = self.get(&format!("/api/v1/turns/{turn_id}")).await;
            if pred(&t) {
                return t;
            }
            if tokio::time::Instant::now() > deadline {
                panic!("turn wait timeout: {t}");
            }
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
    }

    pub async fn wait_status(&self, turn_id: &str, status: &str) -> Value {
        let s = status.to_string();
        self.wait_turn(turn_id, move |t| t["status"] == s.as_str()).await
    }

    pub async fn stop(&mut self) {
        if let Some(s) = self.server.take() {
            s.stop().await;
        }
    }

    /// 같은 데이터 디렉터리로 재시작한다.
    pub async fn restart(&mut self) {
        self.stop().await;
        let cfg = config(&self.data_dir());
        let server = grove::server::start(cfg, Arc::new(SystemClock)).await.expect("server restart");
        self.base = format!("http://{}", server.addr);
        self.token = server.owner_token.clone();
        self.server = Some(server);
    }

    /// SSE를 cursor부터 읽어 `n`개의 `event` 이벤트 또는 timeout까지 모은다.
    pub async fn read_events(&self, cursor: Option<i64>, sessions: &str, want: usize, timeout_ms: u64) -> Vec<(String, Value)> {
        read_sse(&self.client, &self.base, &self.token, cursor, sessions, want, timeout_ms).await
    }
}

pub async fn read_sse(
    client: &Client,
    base: &str,
    token: &str,
    cursor: Option<i64>,
    sessions: &str,
    want: usize,
    timeout_ms: u64,
) -> Vec<(String, Value)> {
    use futures_util::StreamExt;
    let mut url = format!("{base}/api/v1/events?sessions={sessions}");
    if let Some(c) = cursor {
        url.push_str(&format!("&cursor={c}"));
    }
    let resp = client.get(url).bearer_auth(token).send().await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut out = vec![];
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        let next = tokio::time::timeout_at(deadline, stream.next()).await;
        let Ok(Some(Ok(chunk))) = next else { break };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(idx) = buf.find("\n\n") {
            let frame = buf[..idx].to_string();
            buf.drain(..idx + 2);
            let mut name = "message".to_string();
            let mut data = String::new();
            for line in frame.lines() {
                if let Some(v) = line.strip_prefix("event:") {
                    name = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("data:") {
                    data.push_str(v.trim_start());
                }
            }
            if data.is_empty() {
                continue;
            }
            let v: Value = serde_json::from_str(&data).unwrap_or(Value::String(data));
            let is_event = name == "event";
            out.push((name.clone(), v));
            if name == "resync" || name == "shutdown" {
                return out;
            }
            if is_event && out.iter().filter(|(n, _)| n == "event").count() >= want {
                return out;
            }
        }
    }
    out
}

pub fn events_of<'a>(evs: &'a [(String, Value)], kind: &str) -> Vec<&'a Value> {
    evs.iter().filter(|(n, v)| n == "event" && v["kind"] == kind).map(|(_, v)| v).collect()
}

pub fn file_sha(path: &Path) -> String {
    grove::util::sha256_hex(&std::fs::read(path).unwrap())
}
