//! 원격 job 완료 감시(EXEC-014~017). 원격 서버는 loopback HTTP fixture다(실제 HTTPS 서비스 검증 아님).
mod common;

use axum::http::{HeaderMap, Method as AxMethod, StatusCode as AxStatus, Uri};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Remote {
    /// (응답 상태, 본문)
    reply: Arc<Mutex<(u16, String)>>,
    /// (method, path, Authorization·Cookie 헤더 유무)
    hits: Arc<Mutex<Vec<(String, String, bool)>>>,
}

async fn remote() -> (Remote, String) {
    let r = Remote::default();
    *r.reply.lock().unwrap() = (200, json!({ "job": { "state": "running" } }).to_string());
    let st = r.clone();
    let app = axum::Router::new().fallback(move |m: AxMethod, uri: Uri, h: HeaderMap| {
        let st = st.clone();
        async move {
            st.hits.lock().unwrap().push((m.to_string(), uri.path().to_string(), h.contains_key("authorization") || h.contains_key("cookie")));
            let (code, body) = st.reply.lock().unwrap().clone();
            let mut resp = axum::response::Response::new(axum::body::Body::from(body));
            *resp.status_mut() = AxStatus::from_u16(code).unwrap();
            if (300..400).contains(&code) {
                resp.headers_mut().insert("location", "http://127.0.0.1:9/elsewhere".parse().unwrap());
            }
            resp
        }
    });
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (r, base)
}

async fn setup() -> (TestServer, String) {
    let s = TestServer::start().await;
    let p = s.create_project("proj").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    (s, sid)
}

async fn wait_watch(s: &TestServer, id: &str, pred: impl Fn(&Value) -> bool) -> Value {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let (_, w) = s.get(&format!("/api/v1/remote-watches/{id}")).await;
        if pred(&w) {
            return w;
        }
        assert!(std::time::Instant::now() < deadline, "감시 대기 시간 초과: {w}");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

fn body(url: &str) -> Value {
    json!({ "title": "배포", "url": url, "status_pointer": "/job/state", "success_values": ["success"], "failure_values": ["failure", "cancelled"], "interval_secs": 10, "timeout_mins": 30 })
}

// EXEC-014·015·017: 등록 즉시 GET으로 확인하고, 성공 값이면 감시를 끝내며 알림 저장·앱 전달·열람을 따로 둔다.
#[tokio::test]
async fn watch_reports_remote_success_separately_from_local_task_and_notification() {
    let (s, sid) = setup().await;
    let (r, base) = remote().await;
    // 원격 job을 접수한 로컬 명령(성공 종료)
    let (_, task) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({ "command": "echo submitted" })).await;
    let task_id = task["id"].as_str().unwrap().to_string();
    let mut b = body(&format!("{base}/api/jobs/42?view=status"));
    b["task_id"] = json!(task_id);
    let resp = s.raw(Method::POST, &format!("/api/v1/sessions/{sid}/remote-watches"), Some(b.clone()), Some("watch-1"), None).await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let w: Value = resp.json().await.unwrap();
    let id = w["id"].as_str().unwrap().to_string();
    assert_eq!(w["status"], "watching");
    // 같은 키 재전송은 감시를 하나 더 만들지 않는다
    let again = s.raw(Method::POST, &format!("/api/v1/sessions/{sid}/remote-watches"), Some(b), Some("watch-1"), None).await;
    assert_eq!(again.headers().get("idempotent-replayed").unwrap(), "true");
    let w = wait_watch(&s, &id, |w| w["checks"] == 1).await;
    assert_eq!(w["status"], "watching");
    assert_eq!(w["remote_value"], "running");
    assert!(w["next_check_at"].is_string());

    r.reply.lock().unwrap().1 = json!({ "job": { "state": "success" } }).to_string();
    let (st, _) = s.post(&format!("/api/v1/remote-watches/{id}/check"), json!({ "expected_revision": w["revision"] })).await;
    assert_eq!(st, StatusCode::OK);
    let w = wait_watch(&s, &id, |w| w["status"] != "watching").await;
    assert_eq!(w["status"], "succeeded");
    assert_eq!(w["remote_value"], "success");
    assert_eq!(w["task_id"], task_id.as_str());
    assert!(w["finished_at"].is_string() && w["next_check_at"].is_null());
    let hits = r.hits.lock().unwrap().clone();
    assert_eq!(hits.len(), 2, "등록·지금 확인 각 1회만 조회: {hits:?}");
    assert!(hits.iter().all(|(m, p, cred)| m == "GET" && p == "/api/jobs/42" && !cred), "GET만, 인증·쿠키 없이: {hits:?}");

    // 알림은 저장됐지만 앱 전달·열람은 아직이다(감시 성공과 별개)
    let (_, n) = s.get("/api/v1/notifications?limit=10").await;
    let note = n["items"].as_array().unwrap().iter().find(|x| x["ref_id"] == id.as_str()).cloned().expect("종료 알림");
    assert_eq!(note["id"], w["notification_id"]);
    assert_eq!(note["title"], "원격 작업 배포: 성공");
    assert!(note["delivered_at"].is_null() && note["read_at"].is_null());
    let (_, msgs) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let results: Vec<_> = msgs["items"].as_array().unwrap().iter().filter(|m| m["content"]["type"] == "remote_watch_result").collect();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["content"]["status"], "succeeded");
    // 끝난 감시는 다시 확인·취소하지 않는다
    let (st, e) = s.post(&format!("/api/v1/remote-watches/{id}/cancel"), json!({ "expected_revision": w["revision"] })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(e["error"]["code"], "not_watching");
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    assert_eq!(r.hits.lock().unwrap().len(), 2, "끝난 감시는 더 조회하지 않는다");
}

// EXEC-015: redirect는 따라가지 않고 감시를 멈춘다. 일시 오류(5xx)·형식 오류는 기록만 하고 계속 감시한다.
#[tokio::test]
async fn redirect_stops_watch_and_transient_errors_keep_watching() {
    let (s, sid) = setup().await;
    let (r, base) = remote().await;
    *r.reply.lock().unwrap() = (503, "busy".into());
    let (_, w) = s.post(&format!("/api/v1/sessions/{sid}/remote-watches"), body(&format!("{base}/job"))).await;
    let id = w["id"].as_str().unwrap().to_string();
    let w = wait_watch(&s, &id, |w| w["checks"] == 1).await;
    assert_eq!(w["status"], "watching");
    assert_eq!(w["last_error"]["code"], "http_status");
    *r.reply.lock().unwrap() = (200, "<html>".into());
    s.post(&format!("/api/v1/remote-watches/{id}/check"), json!({ "expected_revision": w["revision"] })).await;
    let w = wait_watch(&s, &id, |w| w["checks"] == 2).await;
    assert_eq!(w["last_error"]["code"], "not_json");
    *r.reply.lock().unwrap() = (302, String::new());
    s.post(&format!("/api/v1/remote-watches/{id}/check"), json!({ "expected_revision": w["revision"] })).await;
    let w = wait_watch(&s, &id, |w| w["status"] != "watching").await;
    assert_eq!(w["status"], "stopped");
    assert_eq!(w["last_error"]["code"], "redirect_refused");
    let hits = r.hits.lock().unwrap().clone();
    assert!(hits.iter().all(|(_, p, _)| p == "/job"), "redirect 대상은 조회하지 않는다: {hits:?}");
}

// EXEC-016: 감시 취소는 조회만 멈추고 원격에는 아무 요청도 보내지 않는다. 실패 값은 실패로 끝낸다.
#[tokio::test]
async fn cancel_stops_only_watching_and_failure_value_fails() {
    let (s, sid) = setup().await;
    let (r, base) = remote().await;
    let (_, w) = s.post(&format!("/api/v1/sessions/{sid}/remote-watches"), body(&format!("{base}/job"))).await;
    let id = w["id"].as_str().unwrap().to_string();
    let w = wait_watch(&s, &id, |w| w["checks"] == 1).await;
    let (st, e) = s.post(&format!("/api/v1/remote-watches/{id}/cancel"), json!({ "expected_revision": w["revision"].as_i64().unwrap() - 1 })).await;
    assert_eq!(st, StatusCode::CONFLICT, "{e}");
    assert_eq!(e["error"]["code"], "revision_conflict");
    let (st, c) = s.post(&format!("/api/v1/remote-watches/{id}/cancel"), json!({ "expected_revision": w["revision"] })).await;
    assert_eq!(st, StatusCode::OK, "{c}");
    assert_eq!(c["watch"]["status"], "cancelled");
    assert_eq!(c["remote_job_cancelled"], false);
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let hits = r.hits.lock().unwrap().clone();
    assert_eq!(hits.len(), 1, "취소 뒤 조회·원격 취소 요청 없음: {hits:?}");
    assert!(hits.iter().all(|(m, _, _)| m == "GET"));

    r.reply.lock().unwrap().1 = json!({ "job": { "state": "failure" } }).to_string();
    let (_, w) = s.post(&format!("/api/v1/sessions/{sid}/remote-watches"), body(&format!("{base}/job2"))).await;
    let w = wait_watch(&s, w["id"].as_str().unwrap(), |w| w["status"] != "watching").await;
    assert_eq!(w["status"], "failed");
    assert_eq!(w["remote_value"], "failure");
    let (_, n) = s.get("/api/v1/notifications?limit=10").await;
    assert!(n["items"].as_array().unwrap().iter().any(|x| x["ref_id"] == w["id"] && x["title"] == "원격 작업 배포: 실패"));
}

// EXEC-014: 감시 시간이 지나면 결과 불명으로 끝내고, 재시작 뒤에도 감시 중인 항목을 이어서 조회한다.
#[tokio::test]
async fn deadline_times_out_and_watch_resumes_after_restart() {
    let (mut s, sid) = setup().await;
    let (r, base) = remote().await;
    let (_, w) = s.post(&format!("/api/v1/sessions/{sid}/remote-watches"), body(&format!("{base}/job"))).await;
    let id = w["id"].as_str().unwrap().to_string();
    wait_watch(&s, &id, |w| w["checks"] == 1).await;
    s.stop().await;
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute("UPDATE remote_watches SET next_check_at = '2000-01-01T00:00:00Z' WHERE id = ?1", [&id]).unwrap();
    drop(db);
    s.restart().await;
    let w = wait_watch(&s, &id, |w| w["checks"] == 2).await;
    assert_eq!(w["status"], "watching");
    assert_eq!(r.hits.lock().unwrap().len(), 2);
    s.stop().await;
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute("UPDATE remote_watches SET deadline_at = '2000-01-01T00:00:00Z' WHERE id = ?1", [&id]).unwrap();
    drop(db);
    s.restart().await;
    let w = wait_watch(&s, &id, |w| w["status"] != "watching").await;
    assert_eq!(w["status"], "timed_out");
    assert_eq!(w["remote_value"], "running", "마지막으로 본 원격 상태는 보존한다");
    let (_, n) = s.get("/api/v1/notifications?limit=10").await;
    assert!(n["items"].as_array().unwrap().iter().any(|x| x["ref_id"] == id.as_str() && x["title"] == "원격 작업 배포: 감시 시간 초과"));
}

// EXEC-017: 감시 결과는 모델을 부르지 않고 대화에 남으며, 다음 요청에서 신뢰하지 않는 외부 입력으로만 전달된다.
#[tokio::test]
async fn result_reaches_next_model_request_as_untrusted_note() {
    let (s, sid) = setup().await;
    let (r, base) = remote().await;
    r.reply.lock().unwrap().1 = json!({ "job": { "state": "success" } }).to_string();
    let f = common::fixture::Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let (_, w) = s.post(&format!("/api/v1/sessions/{sid}/remote-watches"), body(&format!("{base}/job"))).await;
    wait_watch(&s, w["id"].as_str().unwrap(), |w| w["status"] == "succeeded").await;
    assert!(f.requests().is_empty(), "감시 결과만으로 모델을 부르지 않는다");
    f.push(common::fixture::text("확인했어"));
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "배포 어때?", "profile_id": prof })).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed").await;
    let req = f.requests()[0].to_string();
    assert!(req.contains("[remote job watch result]") && req.contains("untrusted data") && req.contains("remote state: success"), "{req}");
}

#[tokio::test]
async fn registration_validates_url_values_and_task_scope() {
    let (s, sid) = setup().await;
    let p2 = s.create_project("other").await;
    let other = s.create_session(p2["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (_, task) = s.post(&format!("/api/v1/sessions/{other}/tasks"), json!({ "command": "true" })).await;
    let cases = [
        json!({ "url": "http://ci.example.com/job" }),
        json!({ "url": "https://ci.example.com/job#x" }),
        json!({ "success_values": ["done"], "failure_values": ["done"] }),
        json!({ "success_values": [] }),
        json!({ "interval_secs": 5 }),
        json!({ "status_pointer": "job/state" }),
        json!({ "task_id": task["id"] }),
    ];
    for c in cases {
        let mut b = body("https://ci.example.com/job");
        for (k, v) in c.as_object().unwrap() {
            b[k] = v.clone();
        }
        let (st, e) = s.post(&format!("/api/v1/sessions/{sid}/remote-watches"), b.clone()).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{b} → {e}");
    }
    let (_, list) = s.get(&format!("/api/v1/sessions/{sid}/remote-watches")).await;
    assert!(list.as_array().unwrap().is_empty());
}
