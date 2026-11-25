use crate::common;

use common::{TestServer, fixture::{self, Fixture, Step}};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn profile(s: &TestServer, id: &str) -> Value {
    let (_, all) = s.get("/api/v1/model-profiles").await;
    all.as_array().unwrap().iter().find(|p| p["id"] == id).unwrap().clone()
}

async fn options(s: &TestServer, id: &str, value: Value) {
    let p = profile(s, id).await;
    let (status, body) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{id}"),
        json!({"expected_revision":p["revision"],"options":value})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

async fn enable(s: &TestServer, source: &str, targets: &[&str]) {
    let mut candidates = vec![];
    for id in targets {
        let p = profile(s, id).await;
        candidates.push(json!({"profile_id":id,"revision":p["revision"]}));
    }
    let mut opts = profile(s, source).await["options"].clone();
    opts["fallback"] = json!({"enabled":true,"destination_change_confirmed":true,"candidates":candidates});
    options(s, source, opts).await;
}

async fn session(s: &TestServer) -> String {
    let p = s.create_project(&grove::util::new_id()).await;
    s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string()
}

async fn start(s: &TestServer, sid: &str, pid: &str, tools: bool) -> String {
    let (status, body) = s.post(&format!("/api/v1/sessions/{sid}/turns"),
        json!({"profile_id":pid,"text":"fallback local fixture","tools":tools})).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    body["turn"]["id"].as_str().unwrap().to_string()
}

fn errors(f: &Fixture, status: u16) {
    for _ in 0..=grove::provider::MAX_RETRIES {
        f.push(Step::Error(status, "synthetic fixture provider failure".into()));
    }
}

#[tokio::test]
async fn explicit_http_switch_is_bounded_atomic_attributed_and_idempotent() {
    for status in [429, 503] {
        let s = TestServer::start().await;
        let a = Fixture::start().await;
        let b = Fixture::start().await;
        let pa = s.fixture_profile(&a.base).await;
        let pb = s.fixture_profile(&b.base).await;
        enable(&s, &pa, &[&pb]).await;
        errors(&a, status);
        b.push(fixture::text("actual fallback response"));
        let sid = session(&s).await;
        let path = format!("/api/v1/sessions/{sid}/turns");
        let body = json!({"profile_id":pa,"text":"idempotent fallback fixture"});
        let response = s.raw(Method::POST, &path, Some(body.clone()), Some("fallback-accept-once"), None).await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let accepted: Value = response.json().await.unwrap();
        let tid = accepted["turn"]["id"].as_str().unwrap();
        let turn = s.wait_status(tid, "completed").await;
        let replay: Value = s.raw(Method::POST, &path, Some(body), Some("fallback-accept-once"), None).await.json().await.unwrap();
        assert_eq!(replay["turn"]["id"], tid);
        assert_eq!(turn["profile_id"], pb);
        assert_eq!(turn["definition"]["fallback"]["original_profile_id"], pa);
        assert_eq!(turn["definition"]["fallback"]["actual_profile_id"], pb);
        assert_eq!(turn["definition"]["fallback"]["attempts"][0]["error"]["status"], status);
        assert_eq!(turn["definition"]["fallback"]["attempts"].as_array().unwrap().len(), 2);
        assert_eq!(a.requests().len(), 3);
        assert_eq!(b.requests().len(), 1);
        let (_, messages) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
        let items = messages["items"].as_array().unwrap();
        assert_eq!(items.iter().filter(|m| m["content"]["type"] == "model_fallback").count(), 1);
        assert!(items.iter().any(|m| m["role"] == "assistant" && m["content"]["text"] == "actual fallback response"));
        let now = time::OffsetDateTime::now_utc();
        let from = grove::util::fmt_time(now - time::Duration::hours(1));
        let to = grove::util::fmt_time(now + time::Duration::hours(1));
        let (_, usage) = s.get(&format!("/api/v1/usage?from={from}&to={to}&group_by=profile")).await;
        assert!(usage["rows"].as_array().unwrap().iter().any(|g| g["key"] == pb && g["responses"] == 1), "{usage}");
        assert!(!usage["rows"].as_array().unwrap().iter().any(|g| g["key"] == pa), "{usage}");
    }
}

#[tokio::test]
async fn default_off_and_existing_same_model_retry_are_preserved() {
    let s = TestServer::start().await;
    let a = Fixture::start().await;
    let b = Fixture::start().await;
    let pa = s.fixture_profile(&a.base).await;
    let pb = s.fixture_profile(&b.base).await;
    errors(&a, 503);
    let sid = session(&s).await;
    let tid = start(&s, &sid, &pa, false).await;
    let failed = s.wait_status(&tid, "failed").await;
    assert!(failed["definition"].get("fallback").is_none());
    assert!(b.requests().is_empty());
    enable(&s, &pa, &[&pb]).await;
    a.push(Step::Error(429, "retry locally".into()));
    a.push(fixture::text("same model recovered"));
    let tid = start(&s, &sid, &pa, false).await;
    let done = s.wait_status(&tid, "completed").await;
    assert_eq!(done["profile_id"], pa);
    assert_eq!(a.requests().len(), 5);
    assert!(b.requests().is_empty());
}

#[tokio::test]
async fn exhausted_candidates_never_cycle_or_follow_their_own_fallback() {
    let s = TestServer::start().await;
    let a = Fixture::start().await;
    let b = Fixture::start().await;
    let pa = s.fixture_profile(&a.base).await;
    let pb = s.fixture_profile(&b.base).await;
    enable(&s, &pb, &[&pa]).await;
    enable(&s, &pa, &[&pb]).await;
    errors(&a, 503);
    errors(&b, 429);
    let sid = session(&s).await;
    let tid = start(&s, &sid, &pa, false).await;
    let failed = s.wait_status(&tid, "failed").await;
    assert_eq!(a.requests().len(), 3);
    assert_eq!(b.requests().len(), 3);
    assert_eq!(failed["definition"]["fallback"]["attempts"][1]["error"]["status"], 429);
}

#[tokio::test]
async fn forbidden_statuses_and_partial_text_reasoning_tool_or_empty_stream_never_switch() {
    let s = TestServer::start().await;
    let a = Fixture::start().await;
    let b = Fixture::start().await;
    let pa = s.fixture_profile(&a.base).await;
    let pb = s.fixture_profile(&b.base).await;
    enable(&s, &pa, &[&pb]).await;
    for status in [400, 401, 403, 404, 413, 422, 408, 504] {
        let retries = matches!(status, 408 | 504);
        for _ in 0..if retries { 3 } else { 1 } {
            a.push(Step::Error(status, "synthetic forbidden failure".into()));
        }
        let sid = session(&s).await;
        let tid = start(&s, &sid, &pa, false).await;
        let failed = s.wait_status(&tid, "failed").await;
        assert_eq!(failed["profile_id"], pa);
        assert!(b.requests().is_empty(), "status {status}");
    }
    for delta in [
        json!({"content":"partial"}),
        json!({"reasoning_content":"partial reasoning"}),
        json!({"tool_calls":[{"index":0,"id":"fragment","function":{"name":"read","arguments":"{"}}]}),
        json!({}),
    ] {
        // 수신한 조각 뒤 stream 오류: 성공 응답이나 다른 HTTP 오류로 바꾸지 않는다.
        a.push(Step::Frames(vec![
            json!({"choices":[{"delta":delta}]}).to_string(),
            json!({"error":{"message":"stream lost"}}).to_string(),
        ], 0));
        let sid = session(&s).await;
        let tid = start(&s, &sid, &pa, true).await;
        s.wait_status(&tid, "failed").await;
        assert!(b.requests().is_empty());
    }
}

#[tokio::test]
async fn transport_loss_and_cancellation_never_switch() {
    let s = TestServer::start().await;
    let b = Fixture::start().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let closed = format!("http://{}/v1", listener.local_addr().unwrap());
    drop(listener);
    let pa = s.fixture_profile(&closed).await;
    let pb = s.fixture_profile(&b.base).await;
    enable(&s, &pa, &[&pb]).await;
    let sid = session(&s).await;
    let tid = start(&s, &sid, &pa, false).await;
    s.wait_status(&tid, "failed").await;
    assert!(b.requests().is_empty());
    let a = Fixture::start().await;
    let pa = s.fixture_profile(&a.base).await;
    enable(&s, &pa, &[&pb]).await;
    a.push(Step::Hang(vec![]));
    let tid = start(&s, &sid, &pa, false).await;
    s.wait_turn(&tid, |_| a.requests().len() == 1).await;
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    s.wait_status(&tid, "cancelled").await;
    assert!(b.requests().is_empty());
}

#[tokio::test]
async fn no_switch_after_a_successful_tool_step() {
    let s = TestServer::start().await;
    let a = Fixture::start().await;
    let b = Fixture::start().await;
    let pa = s.fixture_profile(&a.base).await;
    let pb = s.fixture_profile(&b.base).await;
    enable(&s, &pa, &[&pb]).await;
    a.push(fixture::tool_calls(&[("read-once", "read", json!({"path":"missing.txt"}))]));
    errors(&a, 503);
    let sid = session(&s).await;
    let tid = start(&s, &sid, &pa, true).await;
    let failed = s.wait_status(&tid, "failed").await;
    assert_eq!(failed["step"], 1);
    assert_eq!(a.requests().len(), 4);
    assert!(b.requests().is_empty());
}

#[tokio::test]
async fn changed_deleted_disabled_or_rotated_candidate_is_not_silently_replaced() {
    for change in ["model", "delete", "disable", "secret"] {
        let s = TestServer::start().await;
        let a = Fixture::start().await;
        let b = Fixture::start().await;
        let pa = s.fixture_profile(&a.base).await;
        let pb = s.fixture_profile(&b.base).await;
        enable(&s, &pa, &[&pb]).await;
        errors(&a, 503);
        let sid = session(&s).await;
        let tid = start(&s, &sid, &pa, false).await;
        s.wait_turn(&tid, |_| a.requests().len() == 1).await;
        let p = profile(&s, &pb).await;
        let (status, body) = match change {
            "delete" => s.send(Method::DELETE, &format!("/api/v1/model-profiles/{pb}"), json!({})).await,
            "secret" => s.send(Method::PUT, &format!("/api/v1/secrets/{}", p["secret_id"].as_str().unwrap()),
                json!({"label":"synthetic fixture rotated","value":"synthetic-local-new-key"})).await,
            _ => s.send(Method::PUT, &format!("/api/v1/model-profiles/{pb}"),
                if change == "model" { json!({"expected_revision":p["revision"],"model":"changed"}) }
                else { json!({"expected_revision":p["revision"],"enabled":false}) }).await,
        };
        assert_eq!(status, StatusCode::OK, "{body}");
        let failed = s.wait_status(&tid, "failed").await;
        assert_eq!(failed["profile_id"], pa);
        assert_eq!(failed["definition"]["fallback"]["attempts"][0]["error"]["status"], 503);
        assert!(failed["definition"]["fallback"]["blocked"].is_object());
        assert!(b.requests().is_empty());
    }
}

#[tokio::test]
async fn actual_profile_is_protected_and_restart_does_not_repeat_a_call() {
    let mut s = TestServer::start().await;
    let a = Fixture::start().await;
    let b = Fixture::start().await;
    let pa = s.fixture_profile(&a.base).await;
    let pb = s.fixture_profile(&b.base).await;
    enable(&s, &pa, &[&pb]).await;
    errors(&a, 503);
    b.push(Step::Hang(vec![]));
    let sid = session(&s).await;
    let tid = start(&s, &sid, &pa, false).await;
    s.wait_turn(&tid, |_| b.requests().len() == 1).await;
    let p = profile(&s, &pb).await;
    for patch in [
        json!({"model":"changed"}), json!({"enabled":false}),
        json!({"base_url":a.base}), json!({"options":{"headers":{"x-scope":"different"}}}),
        json!({"secret_id":null}),
    ] {
        let mut body = patch;
        body["expected_revision"] = p["revision"].clone();
        let (status, _) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{pb}"), body).await;
        assert_eq!(status, StatusCode::CONFLICT);
    }
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/secrets/{}", p["secret_id"].as_str().unwrap()),
        json!({"label":"synthetic rotated","value":"synthetic-local-rotated"})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    s.stop().await;
    // 종료한 격리 DB에 비정상 종료 직전의 running 상태를 복원해 실제 startup 복구를 통과시킨다.
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute("UPDATE turns SET status='running',finished_at=NULL,owner_epoch='previous-process' WHERE id=?1", [&tid]).unwrap();
    drop(db);
    s.restart().await;
    let recovered = s.wait_status(&tid, "interrupted").await;
    assert_eq!(recovered["profile_id"], pb);
    assert_eq!(recovered["definition"]["fallback"]["original_profile_id"], pa);
    assert_eq!(recovered["definition"]["fallback"]["attempts"].as_array().unwrap().len(), 2);
    assert_eq!(a.requests().len(), 3);
    assert_eq!(b.requests().len(), 1);
}

#[tokio::test]
async fn invalid_options_references_confirmation_and_cli_are_rejected() {
    let s = TestServer::start().await;
    let a = Fixture::start().await;
    let pa = s.fixture_profile(&a.base).await;
    let pb = s.fixture_profile(&a.base).await;
    let candidate = json!({"profile_id":pb,"revision":1});
    for fallback in [
        json!({"enabled":true,"destination_change_confirmed":false,"candidates":[candidate]}),
        json!({"enabled":true,"destination_change_confirmed":true,"candidates":[]}),
        json!({"enabled":true,"destination_change_confirmed":true,"candidates":[candidate,candidate]}),
        json!({"enabled":true,"destination_change_confirmed":true,"candidates":[{"profile_id":pa,"revision":1}]}),
        json!({"enabled":true,"destination_change_confirmed":true,"candidates":[{"profile_id":"missing","revision":1}]}),
        json!({"enabled":true,"destination_change_confirmed":true,"candidates":[{"profile_id":pb,"revision":999}]}),
        json!({"enabled":true,"destination_change_confirmed":true,"candidates":[candidate],"unknown":true}),
    ] {
        let p = profile(&s, &pa).await;
        let (status, _) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{pa}"),
            json!({"expected_revision":p["revision"],"options":{"fallback":fallback}})).await;
        assert!(status.is_client_error());
    }
    let (status, cli) = s.post("/api/v1/model-profiles", json!({"name":"local cli (never executed)","protocol":"codex_cli","base_url":"","model":"fixture"})).await;
    assert_eq!(status, StatusCode::CREATED, "{cli}");
    let id = cli["id"].as_str().unwrap();
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{id}"),
        json!({"expected_revision":cli["revision"],"options":{"fallback":{"enabled":true,"destination_change_confirmed":true,"candidates":[candidate]}}})).await;
    assert!(status.is_client_error());
    let p = profile(&s, &pa).await;
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{pa}"),
        json!({"expected_revision":p["revision"],"options":{"fallback":{"enabled":true,"destination_change_confirmed":true,"candidates":[{"profile_id":id,"revision":cli["revision"]}]}}})).await;
    assert!(status.is_client_error());
    assert!(a.requests().is_empty());
}

#[tokio::test]
async fn candidate_capabilities_input_and_currency_limits_are_not_bypassed() {
    for kind in ["tools", "context", "currency"] {
        let s = TestServer::start().await;
        let a = Fixture::start().await;
        let b = Fixture::start().await;
        let pa = s.fixture_profile(&a.base).await;
        let pb = s.fixture_profile(&b.base).await;
        let pricing = json!({"currency":"USD","version":"acceptance","input_per_mtok":1.0,"output_per_mtok":1.0});
        options(&s, &pa, json!({"pricing":pricing})).await;
        let mut target = json!({"pricing":pricing});
        match kind {
            "tools" => target["capabilities"] = json!({"tools":false}),
            "context" => target["context_window"] = json!(1),
            "currency" => target["pricing"]["currency"] = json!("KRW"),
            _ => unreachable!(),
        }
        options(&s, &pb, target.clone()).await;
        enable(&s, &pa, &[&pb]).await;
        let sid = session(&s).await;
        if kind == "currency" {
            let (status, _) = s.post(&format!("/api/v1/sessions/{sid}/turns"),
                json!({"profile_id":pa,"text":"reject currency boundary"})).await;
            assert!(status.is_client_error());
            assert!(a.requests().is_empty() && b.requests().is_empty());
            continue;
        }
        errors(&a, 503);
        b.push(fixture::text("expensive response"));
        let tid = start(&s, &sid, &pa, kind == "tools").await;
        let failed = s.wait_status(&tid, "failed").await;
        let _ = failed;
        assert!(b.requests().is_empty(), "{kind}");
    }
}

#[tokio::test]
async fn finite_order_reaches_the_third_profile_without_replacing_accepted_prices() {
    let s = TestServer::start().await;
    let a = Fixture::start().await;
    let b = Fixture::start().await;
    let c = Fixture::start().await;
    let pa = s.fixture_profile(&a.base).await;
    let pb = s.fixture_profile(&b.base).await;
    let pc = s.fixture_profile(&c.base).await;
    enable(&s, &pa, &[&pb, &pc]).await;
    errors(&a, 429);
    errors(&b, 503);
    c.push(fixture::text("third profile"));
    let sid = session(&s).await;
    let tid = start(&s, &sid, &pa, false).await;
    let turn = s.wait_status(&tid, "completed").await;
    assert_eq!(turn["profile_id"], pc);
    let attempts = turn["definition"]["fallback"]["attempts"].as_array().unwrap();
    assert_eq!(attempts.iter().map(|a| a["profile_id"].clone()).collect::<Vec<_>>(), vec![json!(pa), json!(pb), json!(pc)]);
    assert_eq!((a.requests().len(), b.requests().len(), c.requests().len()), (3, 3, 1));
}

#[tokio::test]
async fn fallback_reenters_provider_fair_queue_and_cancel_never_calls_the_waiting_destination() {
    let s = TestServer::start().await;
    for (key, value) in [("runs.max_active", 2), ("runs.provider_max_active", 1), ("runs.account_max_active", 1)] {
        let (status, body) = s.send(Method::PUT, &format!("/api/v1/settings/server/-/{key}"),
            json!({"expected_revision":0,"value":value})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let a = Fixture::start().await;
    let b = Fixture::start().await;
    let pa = s.fixture_profile(&a.base).await;
    let pb = s.fixture_profile(&b.base).await;
    enable(&s, &pa, &[&pb]).await;
    b.push(Step::Hang(vec![]));
    let hold_sid = session(&s).await;
    let held = start(&s, &hold_sid, &pb, false).await;
    s.wait_turn(&held, |_| b.requests().len() == 1).await;
    errors(&a, 503);
    let sid = session(&s).await;
    let tid = start(&s, &sid, &pa, false).await;
    let queued = s.wait_turn(&tid, |t| t["queue"]["reason"] == "provider" || t["queue"]["reason"] == "account").await;
    assert_eq!(queued["profile_id"], pb);
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({})).await;
    s.wait_status(&tid, "cancelled").await;
    s.post(&format!("/api/v1/turns/{held}/cancel"), json!({})).await;
    s.wait_status(&held, "cancelled").await;
    assert_eq!(b.requests().len(), 1);
    assert_eq!(s.server.as_ref().unwrap().app.fair.counts(), (0, 0));
}

#[tokio::test]
async fn original_deadline_limit_survives_switching() {
    let s = TestServer::start().await;
    let a = Fixture::start().await;
    let b = Fixture::start().await;
    let pa = s.fixture_profile(&a.base).await;
    let pb = s.fixture_profile(&b.base).await;
    enable(&s, &pa, &[&pb]).await;
    let timed_sid = session(&s).await;
    let (status, body) = s.send(Method::PUT, &format!("/api/v1/settings/session/{timed_sid}/runs.budget.max_minutes"),
        json!({"expected_revision":0,"value":1})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let app = s.server.as_ref().unwrap().app.clone();
    let epoch = app.epoch.clone();
    let tid = app.db.call(move |c| {
        let tx = c.transaction()?;
        let old = grove::util::fmt_time(time::OffsetDateTime::now_utc() - time::Duration::minutes(2));
        let (turn, _) = grove::runner::enqueue_turn(&tx, &old, &epoch, "local-fixture-owner", &timed_sid,
            "expired original deadline", &pa, None, false, None)?;
        tx.commit()?;
        Ok(turn.id)
    }).await.unwrap();
    grove::runner::kick_queued(&app).await;
    let failed = s.wait_status(&tid, "failed").await;
    assert_eq!(failed["error"]["code"], "time_budget_exceeded");
    assert!(a.requests().is_empty() && b.requests().is_empty(), "시간 예산이 지난 요청은 후보를 호출하지 않는다");
}
