//! 터미널(TERM-001~006, 008). 실제 PTY와 WebSocket을 쓴다(Linux).
#![cfg(unix)]
mod common;

use common::*;
use futures_util::{SinkExt, StreamExt};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message as WsMsg;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn open(s: &TestServer, tid: &str) -> Ws {
    let (st, t) = s.post(&format!("/api/v1/terminals/{tid}/ticket"), json!({})).await;
    assert_eq!(st, StatusCode::OK, "{t}");
    let url = format!("{}{}", s.base.replace("http://", "ws://"), t["url"].as_str().unwrap());
    let (ws, _) = tokio_tungstenite::connect_async(url).await.expect("ws connect");
    ws
}

/// `needle`이 나올 때까지 binary 출력을 모은다.
async fn read_until(ws: &mut Ws, needle: &str, ms: u64) -> String {
    let mut acc = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
    while !acc.contains(needle) {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(left, ws.next()).await {
            Ok(Some(Ok(WsMsg::Binary(b)))) => acc.push_str(&String::from_utf8_lossy(&b)),
            Ok(Some(Ok(_))) => {}
            _ => panic!("'{needle}'을 받지 못함. 받은 출력: {acc}"),
        }
    }
    acc
}

async fn input(ws: &mut Ws, data: &str) {
    ws.send(WsMsg::Text(json!({ "type": "input", "data": data }).to_string().into())).await.unwrap();
}

async fn create(s: &TestServer, pid: &str) -> Value {
    let (st, t) = s.post(&format!("/api/v1/projects/{pid}/terminals"), json!({ "name": "빌드", "cols": 80, "rows": 24 })).await;
    assert_eq!(st, StatusCode::CREATED, "{t}");
    t
}

#[tokio::test]
async fn io_resize_single_use_ticket_and_exit() {
    let s = TestServer::start().await;
    let p = s.create_project("term").await;
    let pid = p["id"].as_str().unwrap();
    let t = create(&s, pid).await;
    let tid = t["id"].as_str().unwrap();
    assert_eq!(t["status"], "running");
    let (st, tk) = s.post(&format!("/api/v1/terminals/{tid}/ticket"), json!({})).await;
    assert_eq!(st, StatusCode::OK);
    let url = format!("{}{}", s.base.replace("http://", "ws://"), tk["url"].as_str().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    // 일회용: 같은 티켓으로 두 번째 연결은 거부
    assert!(tokio_tungstenite::connect_async(&url).await.is_err());
    match ws.next().await {
        Some(Ok(WsMsg::Text(h))) => assert!(h.contains("hello")),
        o => panic!("{o:?}"),
    }
    // 입력한 문자열 자체가 아니라 셸이 계산한 결과를 기다린다
    input(&mut ws, "echo grove-$((40+2))\n").await;
    read_until(&mut ws, "grove-42", 5000).await;
    // 한글 입력·출력
    input(&mut ws, "printf '%s\\n' \"한글-$((1+1))\"\n").await;
    read_until(&mut ws, "한글-2", 5000).await;
    // resize
    ws.send(WsMsg::Text(json!({ "type": "resize", "cols": 100, "rows": 30 }).to_string().into())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    input(&mut ws, "stty size\n").await;
    read_until(&mut ws, "30 100", 5000).await;
    // 재연결: 새 티켓으로 snapshot에 이전 출력이 있다
    let mut ws2 = open(&s, tid).await;
    let _hello = ws2.next().await;
    match ws2.next().await {
        Some(Ok(WsMsg::Binary(b))) => assert!(String::from_utf8_lossy(&b).contains("grove-42"), "snapshot 복원"),
        o => panic!("{o:?}"),
    }
    // 이름 변경(revision 검사)
    let (st, r) = s.send(Method::PATCH, &format!("/api/v1/terminals/{tid}"), json!({ "expected_revision": t["revision"], "name": "테스트" })).await;
    assert_eq!(st, StatusCode::OK, "{r}");
    let (st, _) = s.send(Method::PATCH, &format!("/api/v1/terminals/{tid}"), json!({ "expected_revision": t["revision"], "name": "x" })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    // 실행 중 삭제 거부
    let (st, _) = s.send(Method::DELETE, &format!("/api/v1/terminals/{tid}"), json!({})).await;
    assert_eq!(st, StatusCode::CONFLICT);
    // 셸이 스스로 끝나면 exit 알림, 상태 exited
    input(&mut ws, "exit 7\n").await;
    let mut got_exit = None;
    while let Ok(Some(Ok(m))) = tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
        if let WsMsg::Text(t) = m
            && t.contains("\"exit\"")
        {
            got_exit = Some(t.to_string());
            break;
        }
    }
    let ex: Value = serde_json::from_str(&got_exit.expect("exit 메시지")).unwrap();
    assert_eq!(ex["code"], 7);
    let (_, l) = s.get(&format!("/api/v1/projects/{pid}/terminals")).await;
    let row = &l["terminals"][0];
    assert_eq!(row["status"], "exited");
    assert_eq!(row["exit_code"], 7);
    assert_eq!(row["name"], "테스트");
    // 끝난 터미널에는 티켓을 주지 않는다
    let (st, _) = s.post(&format!("/api/v1/terminals/{tid}/ticket"), json!({})).await;
    assert_eq!(st, StatusCode::CONFLICT);
    let (st, _) = s.send(Method::DELETE, &format!("/api/v1/terminals/{tid}"), json!({})).await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    // 위조 티켓
    let bad = format!("{}/api/v1/terminal-ws/forged", s.base.replace("http://", "ws://"));
    assert!(tokio_tungstenite::connect_async(bad).await.is_err());
}

#[tokio::test]
async fn kill_and_restart_keeps_screen_but_marks_lost() {
    let mut s = TestServer::start().await;
    let p = s.create_project("term2").await;
    let pid = p["id"].as_str().unwrap().to_string();
    // kill
    let t = create(&s, &pid).await;
    let (_, k) = s.post(&format!("/api/v1/terminals/{}/kill", t["id"].as_str().unwrap()), json!({})).await;
    assert_eq!(k["status"], "exited", "{k}");
    assert_eq!(k["reason"], "사용자가 종료함");
    // 재시작
    let t = create(&s, &pid).await;
    let tid = t["id"].as_str().unwrap().to_string();
    let mut ws = open(&s, &tid).await;
    input(&mut ws, "echo marker-$((6*7))\n").await;
    read_until(&mut ws, "marker-42", 5000).await;
    drop(ws);
    s.restart().await;
    let (_, l) = s.get(&format!("/api/v1/projects/{pid}/terminals")).await;
    let row = l["terminals"].as_array().unwrap().iter().find(|r| r["id"] == tid.as_str()).unwrap().clone();
    // 정상 종료 경로는 프로세스를 끝내고 exited로, 비정상이면 lost로 남는다. 어느 쪽이든 running이 아니어야 한다.
    assert_ne!(row["status"], "running", "{row}");
    let r = s.raw(Method::GET, &format!("/api/v1/terminals/{tid}/screen"), None, None, None).await;
    assert!(String::from_utf8_lossy(&r.bytes().await.unwrap()).contains("marker-42"), "화면 복원");
    let (st, _) = s.post(&format!("/api/v1/terminals/{tid}/ticket"), json!({})).await;
    assert_eq!(st, StatusCode::CONFLICT);
}

#[tokio::test]
async fn crash_leftover_running_row_becomes_lost() {
    let mut s = TestServer::start().await;
    let p = s.create_project("term3").await;
    let pid = p["id"].as_str().unwrap().to_string();
    let t = create(&s, &pid).await;
    let tid = t["id"].as_str().unwrap().to_string();
    s.stop().await;
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute("UPDATE terminals SET status = 'running', ended_at = NULL WHERE id = ?1", [&tid]).unwrap();
    drop(db);
    s.restart().await;
    let (_, l) = s.get(&format!("/api/v1/projects/{pid}/terminals")).await;
    assert_eq!(l["terminals"][0]["status"], "lost");
    assert!(l["terminals"][0]["reason"].as_str().unwrap().contains("재시작"));
}

#[tokio::test]
async fn output_flood_does_not_block_server_and_slow_client_gets_reset() {
    let s = TestServer::start().await;
    let p = s.create_project("flood").await;
    let pid = p["id"].as_str().unwrap();
    let t = create(&s, pid).await;
    let tid = t["id"].as_str().unwrap();
    let mut ws = open(&s, tid).await;
    // 출력 폭주 시작 후 클라이언트는 한동안 읽지 않는다
    input(&mut ws, "head -c 30000000 /dev/zero | tr '\\0' x; echo; echo flood-$((1+2))\n").await;
    for _ in 0..5 {
        let started = std::time::Instant::now();
        let (st, _) = s.get(&format!("/api/v1/projects/{pid}/terminals")).await;
        assert_eq!(st, StatusCode::OK);
        assert!(started.elapsed() < Duration::from_secs(1), "폭주 중에도 API 응답");
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    let mut saw_reset = false;
    let mut tail = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(10), ws.next()).await {
            Ok(Some(Ok(WsMsg::Text(t)))) if t.contains("reset") => saw_reset = true,
            Ok(Some(Ok(WsMsg::Binary(b)))) => {
                tail.push_str(&String::from_utf8_lossy(&b));
                if tail.len() > 4096 {
                    tail = tail[tail.len() - 4096..].to_string();
                }
                if tail.contains("flood-3") {
                    break;
                }
            }
            Ok(Some(Ok(_))) => {}
            o => panic!("{o:?}"),
        }
    }
    assert!(saw_reset, "뒤처진 클라이언트는 reset을 받는다");
    assert!(tail.contains("flood-3"), "결국 최신 출력까지 받는다");
    let r = s.raw(Method::GET, &format!("/api/v1/terminals/{tid}/screen"), None, None, None).await;
    assert!(r.bytes().await.unwrap().len() <= grove::terminals::SCROLLBACK);
}
