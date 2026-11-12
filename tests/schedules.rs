//! 예약 실행과 영속 알림(AUTO-001~007, 011, 012).
mod common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};
use std::time::Duration;

fn fmt(t: time::OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339).unwrap()
}

struct Ctx {
    s: TestServer,
    f: Fixture,
    prof: String,
    pid: String,
}

async fn ctx() -> Ctx {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("sch").await;
    let pid = p["id"].as_str().unwrap().to_string();
    Ctx { s, f, prof, pid }
}

impl Ctx {
    async fn create(&self, extra: Value) -> (StatusCode, Value) {
        let mut b = json!({ "name": "아침 점검", "prompt": "상태를 확인해", "profile_id": self.prof, "kind": "interval", "interval_minutes": 600 });
        for (k, v) in extra.as_object().unwrap() {
            b[k] = v.clone();
        }
        self.s.post(&format!("/api/v1/projects/{}/schedules", self.pid), b).await
    }

    async fn runs(&self, id: &str) -> Vec<Value> {
        self.s.get(&format!("/api/v1/schedules/{id}/runs")).await.1.as_array().unwrap().clone()
    }

    async fn wait_run(&self, id: &str, pred: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        for _ in 0..150 {
            let r = self.runs(id).await;
            if pred(&r) {
                return r;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("실행 로그가 기대 상태가 되지 않음: {:?}", self.runs(id).await);
    }
}

#[tokio::test]
async fn crud_validation_pause_resume_delete() {
    let c = ctx().await;
    let (st, v) = c.create(json!({ "allowed_tools": ["read"], "tools": true, "max_total_tokens": 5000, "on_approval": "fail" })).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let id = v["id"].as_str().unwrap().to_string();
    assert_eq!(v["status"], "active");
    assert!(v["next_run_at"].is_string());
    assert_eq!(v["allowed_tools"], json!(["read"]));
    assert_eq!(v["max_total_tokens"], 5000);
    assert!(v["owner_id"].is_string());
    // 검증
    for (extra, why) in [
        (json!({ "kind": "weekly" }), "kind"),
        (json!({ "kind": "once", "at": "2001-01-01T00:00:00Z" }), "과거 시각"),
        (json!({ "kind": "daily", "daily_time": "25:00" }), "시각 형식"),
        (json!({ "interval_minutes": 0 }), "간격"),
        (json!({ "tools": true, "allowed_tools": ["nope"] }), "알 수 없는 도구"),
        (json!({ "allowed_tools": ["read"] }), "도구 꺼짐"),
        (json!({ "on_approval": "auto" }), "승인 우회 금지"),
        (json!({ "session_mode": "same" }), "대화 없음"),
        (json!({ "profile_id": "missing" }), "프로필"),
    ] {
        let (st, e) = c.create(extra).await;
        assert!(st.is_client_error(), "{why}: {st} {e}");
    }
    // 목록
    let (_, l) = c.s.get(&format!("/api/v1/schedules?project_id={}", c.pid)).await;
    assert_eq!(l.as_array().unwrap().len(), 1);
    // 수정: 오래된 revision 거부
    let upd = json!({ "expected_revision": 0, "name": "저녁 점검", "prompt": "p", "profile_id": c.prof, "kind": "daily", "daily_time": "18:30", "tz_offset_minutes": 540 });
    let (st, _) = c.s.send(reqwest::Method::PATCH, &format!("/api/v1/schedules/{id}"), upd.clone()).await;
    assert_eq!(st, StatusCode::CONFLICT);
    let mut upd = upd;
    upd["expected_revision"] = v["revision"].clone();
    let (st, u) = c.s.send(reqwest::Method::PATCH, &format!("/api/v1/schedules/{id}"), upd).await;
    assert_eq!(st, StatusCode::OK, "{u}");
    assert_eq!(u["kind"], "daily");
    assert!(u["next_run_at"].as_str().unwrap().ends_with("09:30:00Z"), "서울 18:30 = UTC 09:30: {u}");
    // 일시 정지·재개
    let (st, pz) = c.s.post(&format!("/api/v1/schedules/{id}/pause"), json!({ "expected_revision": u["revision"] })).await;
    assert_eq!(st, StatusCode::OK, "{pz}");
    assert_eq!(pz["status"], "paused");
    let (st, _) = c.s.post(&format!("/api/v1/schedules/{id}/pause"), json!({ "expected_revision": pz["revision"] })).await;
    assert_eq!(st, StatusCode::CONFLICT, "이미 정지됨");
    let (st, rs) = c.s.post(&format!("/api/v1/schedules/{id}/resume"), json!({ "expected_revision": pz["revision"] })).await;
    assert_eq!(st, StatusCode::OK, "{rs}");
    assert_eq!(rs["status"], "active");
    // 삭제
    let (st, _) = c.s.post(&format!("/api/v1/schedules/{id}/delete"), json!({ "expected_revision": rs["revision"] })).await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = c.s.get(&format!("/api/v1/schedules/{id}")).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn once_fires_exactly_once_and_leaves_persistent_notification() {
    let c = ctx().await;
    c.f.push(fixture::text("예약 답변입니다"));
    let at = fmt(time::OffsetDateTime::now_utc() + time::Duration::seconds(1));
    let (st, v) = c.create(json!({ "kind": "once", "at": at })).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let id = v["id"].as_str().unwrap().to_string();
    let runs = c.wait_run(&id, |r| r.first().is_some_and(|x| x["status"] == "completed")).await;
    assert_eq!(runs.len(), 1);
    let sid = runs[0]["session_id"].as_str().unwrap();
    // 새 대화에 예약 출처가 남는다
    let (_, msgs) = c.s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let user = msgs["items"].as_array().or(msgs.as_array()).unwrap().iter().find(|m| m["role"] == "user").unwrap().clone();
    assert_eq!(user["content"]["source"]["kind"], "schedule");
    assert!(user["content"]["source"].get("limits").is_none(), "제약은 snapshot에만 둔다");
    // 끝난 한 번 실행은 done, 다시 실행하지 않는다
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(c.runs(&id).await.len(), 1);
    let (_, s) = c.s.get(&format!("/api/v1/schedules/{id}")).await;
    assert_eq!(s["status"], "done");
    assert!(s["next_run_at"].is_null());
    // 영속 알림(모델 재호출 없음: fixture 대본을 더 쓰지 않았다)
    let (_, n) = c.s.get("/api/v1/notifications?unread=true").await;
    assert_eq!(n["unread"], 1, "{n}");
    let item = &n["items"][0];
    assert!(item["title"].as_str().unwrap().contains("완료"));
    assert!(item["body"].as_str().unwrap().contains("예약 답변"));
    assert_eq!(c.f.requests().len(), 1, "알림이 모델을 다시 부르지 않는다");
    let (st, _) = c.s.post(&format!("/api/v1/notifications/{}/read", item["id"].as_str().unwrap()), json!({})).await;
    assert_eq!(st, StatusCode::OK);
    let (_, n) = c.s.get("/api/v1/notifications?unread=true").await;
    assert_eq!(n["unread"], 0);
}

/// SCHEDULE-007: 같은 데이터 디렉터리로 서버를 하나 더 띄우면 거부되고, 실제 짧은 주기 예약은 한 번만 실행된다.
#[tokio::test]
async fn duplicate_server_start_is_refused_and_schedule_fires_once() {
    let c = ctx().await;
    c.f.push(fixture::text("한 번만"));
    let at = fmt(time::OffsetDateTime::now_utc() + time::Duration::seconds(1));
    let (_, v) = c.create(json!({ "kind": "once", "at": at })).await;
    let id = v["id"].as_str().unwrap().to_string();
    let second = grove::server::start(config(&c.s.data_dir()), std::sync::Arc::new(grove::util::SystemClock)).await;
    let Err(e) = second else { panic!("두 번째 서버가 같은 데이터로 시작됨") };
    assert!(e.to_string().contains("이미 서버가 실행 중"), "{e}");
    c.wait_run(&id, |r| r.first().is_some_and(|x| x["status"] == "completed")).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(c.runs(&id).await.len(), 1);
    assert_eq!(c.f.requests().len(), 1);
}

/// AUTO-009: 반복 예약의 최대 횟수·종료 시각, 연속 실패 backoff와 자동 정지, 재개 시 초기화.
#[tokio::test]
async fn repeat_limits_backoff_and_auto_pause_after_failures() {
    let c = ctx().await;
    let soon = |s: i64| fmt(time::OffsetDateTime::now_utc() + time::Duration::seconds(s));
    // 검증: 한 번 실행에는 횟수·종료 불가, 범위 밖·과거 종료 거부
    for (extra, why) in [
        (json!({ "kind": "once", "at": soon(60), "max_runs": 2 }), "한 번 실행 횟수"),
        (json!({ "max_runs": 0 }), "횟수 0"),
        (json!({ "end_at": "2001-01-01T00:00:00Z" }), "과거 종료"),
        (json!({ "pause_after_failures": 0 }), "정지 0"),
    ] {
        let (st, e) = c.create(extra).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{why}: {e}");
    }
    let (_, d) = c.create(json!({ "name": "기본" })).await;
    assert_eq!(d["pause_after_failures"], 5, "생략하면 5회 연속 실패에 멈춘다");
    assert_eq!(d["runs_used"], 0);

    // 최대 1회: 첫 자동 실행 뒤 끝난다(다음 시각 없음)
    c.f.push(fixture::text("한 번만"));
    let (st, v) = c.create(json!({ "name": "한 번만", "interval_minutes": 1, "at": soon(1), "max_runs": 1 })).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let once = v["id"].as_str().unwrap().to_string();
    c.wait_run(&once, |r| r.first().is_some_and(|x| x["status"] == "completed")).await;
    let (_, s) = c.s.get(&format!("/api/v1/schedules/{once}")).await;
    assert_eq!((s["status"].as_str(), s["runs_used"].as_i64(), s["next_run_at"].is_null()), (Some("done"), Some(1), true), "{s}");

    // 종료 시각: 다음 시각(1분 뒤)이 종료 시각보다 뒤라 첫 실행 뒤 끝난다
    c.f.push(fixture::text("종료 전"));
    let (_, v) = c.create(json!({ "name": "종료", "interval_minutes": 1, "at": soon(1), "end_at": soon(30) })).await;
    let ended = v["id"].as_str().unwrap().to_string();
    c.wait_run(&ended, |r| r.first().is_some_and(|x| x["status"] == "completed")).await;
    let (_, s) = c.s.get(&format!("/api/v1/schedules/{ended}")).await;
    assert_eq!(s["status"], "done", "{s}");

    // 연속 실패: 한 번 실패하면 자동 실행은 backoff 동안 건너뛰고(수동 실행은 가능), 두 번째 실패에 자동 정지
    let (_, v) = c.create(json!({ "name": "실패", "interval_minutes": 1, "at": soon(4), "max_total_tokens": 5, "pause_after_failures": 2 })).await;
    let bad = v["id"].as_str().unwrap().to_string();
    c.f.push(fixture::text("너무 길다"));
    let (_, r) = c.s.post(&format!("/api/v1/schedules/{bad}/run"), json!({})).await;
    c.s.wait_status(r["turn_id"].as_str().unwrap(), "failed").await;
    c.wait_run(&bad, |r| r.iter().any(|x| x["status"] == "failed")).await;
    let (_, s) = c.s.get(&format!("/api/v1/schedules/{bad}")).await;
    assert_eq!(s["consecutive_failures"], 1, "{s}");
    assert!(s["backoff_until"].is_string());
    let runs = c.wait_run(&bad, |r| r.iter().any(|x| x["status"] == "missed")).await;
    let skipped = runs.iter().find(|x| x["status"] == "missed").unwrap();
    assert!(skipped["detail"].as_str().unwrap().contains("연속 1회 실패"), "{skipped}");
    assert_eq!(skipped["manual"], false);
    let (_, s) = c.s.get(&format!("/api/v1/schedules/{bad}")).await;
    assert_eq!((s["status"].as_str(), s["runs_used"].as_i64()), (Some("active"), Some(0)), "건너뛴 자동 실행은 횟수에 들지 않는다: {s}");
    c.f.push(fixture::text("또 길다"));
    let (_, r) = c.s.post(&format!("/api/v1/schedules/{bad}/run"), json!({})).await;
    c.s.wait_status(r["turn_id"].as_str().unwrap(), "failed").await;
    let mut paused = Value::Null;
    for _ in 0..50 {
        paused = c.s.get(&format!("/api/v1/schedules/{bad}")).await.1;
        if paused["status"] == "paused" { break; }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!((paused["status"].as_str(), paused["paused_reason"].as_str(), paused["consecutive_failures"].as_i64()), (Some("paused"), Some("failures"), Some(2)), "{paused}");
    let (_, n) = c.s.get("/api/v1/notifications?unread=true").await;
    assert!(n["items"].as_array().unwrap().iter().any(|i| i["title"].as_str().unwrap().contains("자동 일시 정지")), "{n}");
    // 재개하면 연속 실패를 지우고 사용자 정지와 구분한다
    let (st, rs) = c.s.post(&format!("/api/v1/schedules/{bad}/resume"), json!({ "expected_revision": paused["revision"] })).await;
    assert_eq!(st, StatusCode::OK, "{rs}");
    assert_eq!((rs["consecutive_failures"].as_i64(), rs["paused_reason"].is_null(), rs["backoff_until"].is_null()), (Some(0), true, true), "{rs}");
    let (_, pz) = c.s.post(&format!("/api/v1/schedules/{bad}/pause"), json!({ "expected_revision": rs["revision"] })).await;
    assert_eq!(pz["paused_reason"], "user");

    // 사용자 취소는 실패로 세지 않는다
    let (_, v) = c.create(json!({ "name": "취소", "tools": true })).await;
    let cancel = v["id"].as_str().unwrap().to_string();
    c.f.push(fixture::tool_calls(&[("w9", "write", json!({ "path": "c.txt", "content": "c" }))]));
    let (_, r) = c.s.post(&format!("/api/v1/schedules/{cancel}/run"), json!({})).await;
    c.s.wait_status(r["turn_id"].as_str().unwrap(), "awaiting_approval").await;
    c.s.post(&format!("/api/v1/turns/{}/cancel", r["turn_id"].as_str().unwrap()), json!({})).await;
    c.wait_run(&cancel, |r| r[0]["status"] == "cancelled").await;
    assert_eq!(c.s.get(&format!("/api/v1/schedules/{cancel}")).await.1["consecutive_failures"], 0);
}

#[tokio::test]
async fn approval_policy_overlap_allowed_tools_and_budget() {
    let c = ctx().await;
    // on_approval=fail: 쓰기 도구가 승인 대기 대신 실패로 끝난다
    let (_, v) = c.create(json!({ "tools": true, "on_approval": "fail" })).await;
    let id = v["id"].as_str().unwrap().to_string();
    c.f.push(fixture::tool_calls(&[("w1", "write", json!({ "path": "x.txt", "content": "hi" }))]));
    let (st, r) = c.s.post(&format!("/api/v1/schedules/{id}/run"), json!({})).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{r}");
    assert_eq!(r["manual"], true);
    let t = c.s.wait_status(r["turn_id"].as_str().unwrap(), "failed").await;
    assert_eq!(t["error"]["code"], "approval_required");
    assert_eq!(t["tool_calls"][0]["status"], "cancelled", "승인 없이 실행하지 않는다");
    c.wait_run(&id, |r| r[0]["status"] == "failed").await;
    assert!(!c.s.make_project_dir("sch").join("x.txt").exists());

    // on_approval=wait: 승인 대기 중이면 다음 실행은 overlap으로 거부된다
    let (_, v) = c.create(json!({ "name": "대기", "tools": true })).await;
    let id2 = v["id"].as_str().unwrap().to_string();
    c.f.push(fixture::tool_calls(&[("w2", "write", json!({ "path": "y.txt", "content": "hi" }))]));
    let (_, r) = c.s.post(&format!("/api/v1/schedules/{id2}/run"), json!({})).await;
    c.s.wait_status(r["turn_id"].as_str().unwrap(), "awaiting_approval").await;
    let (st, e) = c.s.post(&format!("/api/v1/schedules/{id2}/run"), json!({})).await;
    assert_eq!(st, StatusCode::CONFLICT, "{e}");
    assert_eq!(c.runs(&id2).await[0]["status"], "running");
    c.s.post(&format!("/api/v1/turns/{}/cancel", r["turn_id"].as_str().unwrap()), json!({})).await;
    c.wait_run(&id2, |r| r[0]["status"] == "cancelled").await;

    // 허용 도구 밖의 호출은 실행 없이 실패로 기록되고 모델이 마무리한다
    let (_, v) = c.create(json!({ "name": "읽기만", "tools": true, "allowed_tools": ["read"] })).await;
    let id3 = v["id"].as_str().unwrap().to_string();
    c.f.push(fixture::tool_calls(&[("s3", "shell", json!({ "command": "touch z.txt" }))]));
    c.f.push(fixture::text("못 했어요"));
    let (_, r) = c.s.post(&format!("/api/v1/schedules/{id3}/run"), json!({})).await;
    let t = c.s.wait_status(r["turn_id"].as_str().unwrap(), "completed").await;
    assert_eq!(t["tool_calls"][0]["status"], "failed", "{t}");
    assert!(!c.s.make_project_dir("sch").join("z.txt").exists());

    // token 한도 초과
    let (_, v) = c.create(json!({ "name": "예산", "max_total_tokens": 5 })).await;
    let id4 = v["id"].as_str().unwrap().to_string();
    c.f.push(fixture::text("길다"));
    let (_, r) = c.s.post(&format!("/api/v1/schedules/{id4}/run"), json!({})).await;
    let t = c.s.wait_status(r["turn_id"].as_str().unwrap(), "failed").await;
    assert_eq!(t["error"]["code"], "budget_exceeded");
}

#[tokio::test]
async fn restart_interrupts_running_without_replay_and_records_missed() {
    let mut c = ctx().await;
    let (_, v) = c.create(json!({ "missed_grace_minutes": 5 })).await;
    let id = v["id"].as_str().unwrap().to_string();
    c.f.push(fixture::slow_text(&["a", "b", "c", "d"], 2000));
    let (_, r) = c.s.post(&format!("/api/v1/schedules/{id}/run"), json!({})).await;
    c.s.wait_status(r["turn_id"].as_str().unwrap(), "running").await;
    c.s.stop().await;
    // 서버가 꺼져 있는 동안 예정 시각이 지났다고 만든다(1시간 전 → 허용 5분 초과)
    {
        let db = rusqlite::Connection::open(c.s.data_dir().join("grove.db")).unwrap();
        let past = fmt(time::OffsetDateTime::now_utc().replace_nanosecond(0).unwrap() - time::Duration::hours(1));
        db.execute("UPDATE schedules SET next_run_at = ?1 WHERE id = ?2", rusqlite::params![past, id]).unwrap();
    }
    c.s.restart().await;
    let runs = c.wait_run(&id, |r| r.len() == 2 && r.iter().any(|x| x["status"] == "missed")).await;
    let manual = runs.iter().find(|x| x["manual"] == true).unwrap();
    assert_eq!(manual["status"], "interrupted", "재시작 뒤 자동 재실행하지 않는다: {runs:?}");
    let (_, t) = c.s.get(&format!("/api/v1/turns/{}", r["turn_id"].as_str().unwrap())).await;
    assert_eq!(t["status"], "interrupted");
    // 다음 예정 시각은 미래로 넘어갔고 추가 실행은 없다
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(c.runs(&id).await.len(), 2);
    let (_, s) = c.s.get(&format!("/api/v1/schedules/{id}")).await;
    let next = time::OffsetDateTime::parse(s["next_run_at"].as_str().unwrap(), &time::format_description::well_known::Rfc3339).unwrap();
    assert!(next > time::OffsetDateTime::now_utc());
    let (_, n) = c.s.get("/api/v1/notifications").await;
    let titles: Vec<&str> = n["items"].as_array().unwrap().iter().map(|x| x["title"].as_str().unwrap()).collect();
    assert!(titles.iter().any(|t| t.contains("놓쳤습니다")), "{titles:?}");
    assert!(titles.iter().any(|t| t.contains("중단")), "{titles:?}");
}
