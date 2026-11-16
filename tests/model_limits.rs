//! 실제 로컬 HTTP 추론의 공유 한도·독립 자원·보조 호출·제어 요청을 검증한다.
mod common;

use common::{TestServer, fixture::{self, Fixture}};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn configure(s: &TestServer, provider: i64, account: i64) {
    for (key, value) in [("runs.max_active", 2), ("runs.provider_max_active", provider), ("runs.account_max_active", account)] {
        let (status, body) = s.send(Method::PUT, &format!("/api/v1/settings/server/-/{key}"), json!({ "expected_revision":0, "value":value })).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
}

async fn profile(s: &TestServer, f: &Fixture, key: &str) -> String {
    // 같은 값의 별도 secret 행도 실제 자격이 같으므로 같은 계정으로 묶어야 한다.
    let (_, secret) = s.post("/api/v1/secrets", json!({ "label":"limit fixture", "value":key })).await;
    let (status, p) = s.post("/api/v1/model-profiles", json!({
        "name":"limit profile", "protocol":"openai", "base_url":f.base, "model":"fixture",
        "secret_id":secret["id"], "options":{"context_window":1000000},
    })).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    p["id"].as_str().unwrap().into()
}

async fn turn(s: &TestServer, project: &str, profile: &str, text: &str) -> (String, String) {
    let session = s.create_session(project).await["id"].as_str().unwrap().to_string();
    let (status, t) = s.post(&format!("/api/v1/sessions/{session}/turns"), json!({ "profile_id":profile, "text":text })).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{t}");
    (session, t["turn"]["id"].as_str().unwrap().into())
}

async fn cancel(s: &TestServer, turn: &str) {
    s.post(&format!("/api/v1/turns/{turn}/cancel"), json!({})).await;
    s.wait_status(turn, "cancelled").await;
}

#[tokio::test]
async fn defaults_allow_ten_concurrent_calls_and_queue_the_eleventh() {
    let s = TestServer::start().await;
    let (status, registry) = s.get("/api/v1/settings/registry").await;
    assert_eq!(status, StatusCode::OK);
    for key in ["runs.max_active", "runs.provider_max_active", "runs.account_max_active"] {
        let setting = registry.as_array().unwrap().iter().find(|setting| setting["key"] == key).unwrap();
        assert_eq!(setting["default"], 10, "{key}");
    }
    let f = Fixture::start().await;
    let p = profile(&s, &f, "synthetic-default-account").await;
    let project = s.create_project("default-limits").await["id"].as_str().unwrap().to_string();
    let mut active = Vec::new();
    for index in 0..10 {
        let marker = format!("MARK_HOLD_{index}_");
        f.push_for(&marker, fixture::Step::Hang(vec![]));
        let (_, id) = turn(&s, &project, &p, &marker).await;
        s.wait_turn(&id, |_| f.requests().len() == index + 1).await;
        active.push(id);
    }
    assert_eq!(s.server.as_ref().unwrap().app.fair.counts(), (10, 0));
    let (_, queued) = turn(&s, &project, &p, "MARK_ELEVENTH").await;
    let waiting = s.wait_turn(&queued, |turn| turn["queue"]["limit"] == 10).await;
    assert_eq!(waiting["queue"]["active"], 10);
    assert_eq!(f.requests().len(), 10);
    cancel(&s, &queued).await;
    for id in active {
        cancel(&s, &id).await;
    }
    assert_eq!(s.server.as_ref().unwrap().app.fair.counts(), (0, 0));
}

#[tokio::test]
async fn profiles_with_identical_credentials_share_accounts_without_blocking_other_accounts() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    configure(&s, 2, 1).await;
    let a = profile(&s, &f, "synthetic-account-one").await;
    let same = profile(&s, &f, "synthetic-account-one").await;
    let other = profile(&s, &f, "synthetic-account-two").await;
    let (_, profiles) = s.get("/api/v1/model-profiles").await;
    let current = profiles.as_array().unwrap().iter().find(|p| p["id"] == same).unwrap();
    let (status, header) = s.post("/api/v1/secrets", json!({"label":"unrelated header","value":"synthetic-unrelated"})).await;
    assert_eq!(status, StatusCode::CREATED, "{header}");
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{same}"),
        json!({ "expected_revision":current["revision"], "options":{"headers":{"x-unused-token":{"secret_id":header["id"]}}} })).await;
    assert_eq!(status, StatusCode::OK);
    let project = s.create_project("accounts").await["id"].as_str().unwrap().to_string();
    f.push_for("MARK_FIRST", fixture::Step::Hang(vec![]));
    f.push_for("MARK_OTHER", fixture::text("other account"));
    let (_, first) = turn(&s, &project, &a, "MARK_FIRST").await;
    s.wait_turn(&first, |_| f.requests().len() == 1).await;
    let (_, blocked) = turn(&s, &project, &same, "MARK_BLOCKED").await;
    let queued = s.wait_turn(&blocked, |t| t["queue"]["reason"] == "account").await;
    assert_eq!(queued["queue"]["active"], 1);
    assert_eq!(queued["queue"]["limit"], 1);
    let visible = queued.to_string();
    assert!(!visible.contains("synthetic-account-one") && !visible.contains("synthetic-account-two"));
    let (_, independent) = turn(&s, &project, &other, "MARK_OTHER").await;
    s.wait_status(&independent, "completed").await;
    assert_eq!(f.requests().len(), 2);
    // 상태·기기·메타데이터 확인은 포화된 추론 큐 밖에서 계속 동작한다.
    let (status, _) = s.post(&format!("/api/v1/model-profiles/{same}/check"), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    cancel(&s, &blocked).await;
    cancel(&s, &first).await;
    assert!(f.requests().iter().all(|r| !r.to_string().contains("MARK_BLOCKED")));
    assert_eq!(s.server.as_ref().unwrap().app.fair.counts(), (0, 0));
}

#[tokio::test]
async fn provider_saturation_does_not_reserve_a_global_slot_or_block_other_origins() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let independent = Fixture::start().await;
    configure(&s, 1, 2).await;
    let a = profile(&s, &f, "synthetic-one").await;
    let b = profile(&s, &f, "synthetic-two").await;
    let c = profile(&s, &independent, "synthetic-three").await;
    let project = s.create_project("providers").await["id"].as_str().unwrap().to_string();
    f.push_for("MARK_FIRST", fixture::Step::Hang(vec![]));
    independent.push(fixture::text("other origin"));
    let (_, first) = turn(&s, &project, &a, "MARK_FIRST").await;
    s.wait_turn(&first, |_| f.requests().len() == 1).await;
    let (_, blocked) = turn(&s, &project, &b, "MARK_BLOCKED").await;
    s.wait_turn(&blocked, |t| t["queue"]["reason"] == "provider").await;
    let (_, other) = turn(&s, &project, &c, "MARK_OTHER").await;
    s.wait_status(&other, "completed").await;
    assert_eq!(independent.requests().len(), 1);
    cancel(&s, &blocked).await;
    cancel(&s, &first).await;
    assert_eq!(f.requests().len(), 1);
    assert_eq!(s.server.as_ref().unwrap().app.fair.counts(), (0, 0));
}

#[tokio::test]
async fn summary_and_title_share_inference_limits_and_release_them_before_committing() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    configure(&s, 1, 1).await;
    let p = profile(&s, &f, "synthetic-shared-auxiliary").await;
    let (_, profiles) = s.get("/api/v1/model-profiles").await;
    let current = profiles.as_array().unwrap().iter().find(|profile| profile["id"] == p).unwrap();
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{p}"), json!({
        "expected_revision":current["revision"],
        "options":{"context_window":1000000,"capabilities":{"max_output_tokens":16}},
    })).await;
    assert_eq!(status, StatusCode::OK);
    let project = s.create_project("auxiliary").await["id"].as_str().unwrap().to_string();
    f.push(fixture::text("history answer"));
    let (history, completed) = turn(&s, &project, &p, "history").await;
    s.wait_status(&completed, "completed").await;
    s.post(&format!("/api/v1/sessions/{history}/messages"), json!({ "text":"newer user" })).await;
    f.push_for("MARK_HOLD", fixture::Step::Hang(vec![]));
    let (_, held) = turn(&s, &project, &p, "MARK_HOLD").await;
    s.wait_turn(&held, |_| f.requests().len() == 2).await;
    f.push_for("You name conversations", fixture::text("Shared title"));
    f.push_for("Summarize the conversation above", fixture::text("Shared summary"));
    let launch = |suffix: &str, key: &str| {
        let request = s.client.post(format!("{}/api/v1/sessions/{history}/{suffix}", s.base))
            .bearer_auth(&s.token).header("X-Grove-Protocol", "1").header("Idempotency-Key", key)
            .json(&json!({ "profile_id":p }));
        tokio::spawn(async move {
            let response = request.send().await.unwrap();
            (response.status(), response.json::<Value>().await.unwrap())
        })
    };
    let title = launch("title", "title-queue");
    let summary = launch("compact", "summary-queue");
    s.wait_turn(&held, |_| s.server.as_ref().unwrap().app.fair.counts().1 == 2).await;
    assert_eq!(f.requests().len(), 2);
    cancel(&s, &held).await;
    let (title, summary) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        (title.await.unwrap(), summary.await.unwrap())
    }).await.unwrap();
    assert_eq!(title.0, StatusCode::OK, "{}", title.1);
    assert_eq!(title.1["applied"], true);
    assert_eq!(summary.0, StatusCode::CREATED, "{}", summary.1);
    assert_eq!(f.requests().len(), 4);
    assert!(f.requests().iter().all(|r| r["max_tokens"] == 16), "제목·요약도 선택한 모델의 출력 상한을 지킨다");
    assert_eq!(s.server.as_ref().unwrap().app.fair.counts(), (0, 0));
}
