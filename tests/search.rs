//! 세션 검색(SESSION-005): 제목·본문·날짜·프로젝트·상태 필터.
mod common;

use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};

fn titles(v: &Value) -> Vec<String> {
    let mut t: Vec<String> = v["items"].as_array().unwrap().iter().map(|x| x["title"].as_str().unwrap().to_string()).collect();
    t.sort();
    t
}

#[tokio::test]
async fn session_list_shows_preview_and_unread_until_seen() {
    let s = TestServer::start().await;
    let p = s.create_project("pv").await;
    let pid = p["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_string();
    let (_, v) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    assert_eq!(v["unread"], false, "메시지가 없으면 읽지 않은 것이 없다");
    assert!(v["preview"].is_null());
    s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": "첫 줄\n둘째 줄 내용" })).await;
    let (_, page) = s.get(&format!("/api/v1/projects/{pid}/sessions")).await;
    let it = &page["items"][0];
    assert_eq!(it["preview"], "첫 줄 둘째 줄 내용");
    assert_eq!(it["unread"], true);
    s.post("/api/v1/recent/touch", json!({ "kind": "session", "project_id": pid, "resource_id": sid, "view_state": { "last_seen_seq": 1 } })).await;
    let (_, v) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    assert_eq!(v["unread"], false);
}

#[tokio::test]
async fn search_by_title_body_project_date_and_status() {
    let s = TestServer::start().await;
    let pa = s.create_project("pa").await;
    let pb = s.create_project("pb").await;
    let (a, b) = (pa["id"].as_str().unwrap(), pb["id"].as_str().unwrap());
    let mk = |pid: String, title: &'static str| {
        let s = &s;
        async move {
            let (_, v) = s.post(&format!("/api/v1/projects/{pid}/sessions"), json!({ "title": title })).await;
            v["id"].as_str().unwrap().to_string()
        }
    };
    let s1 = mk(a.into(), "배포 점검").await;
    let s2 = mk(a.into(), "회의 메모").await;
    let s3 = mk(b.into(), "다른 프로젝트 배포").await;
    s.post(&format!("/api/v1/sessions/{s2}/messages"), json!({ "text": "다음 주 Kubernetes 업그레이드 일정을 정리" })).await;
    s.post(&format!("/api/v1/sessions/{s1}/messages"), json!({ "text": "text 라는 단어" })).await;

    // 제목
    let (_, v) = s.get("/api/v1/sessions/search?q=%EB%B0%B0%ED%8F%AC").await; // "배포"
    assert_eq!(titles(&v), ["다른 프로젝트 배포", "배포 점검"]);
    // 프로젝트 필터
    let (_, v) = s.get(&format!("/api/v1/sessions/search?q=%EB%B0%B0%ED%8F%AC&project_id={a}")).await;
    assert_eq!(titles(&v), ["배포 점검"]);
    // 본문: 끄면 제목만, 켜면 발췌와 seq
    let (_, v) = s.get("/api/v1/sessions/search?q=kubernetes").await;
    assert_eq!(v["total"], 0);
    let (_, v) = s.get("/api/v1/sessions/search?q=kubernetes&body=true").await;
    assert_eq!(titles(&v), ["회의 메모"]);
    assert!(v["items"][0]["snippet"].as_str().unwrap().contains("Kubernetes"));
    assert_eq!(v["items"][0]["match_seq"], 1);
    assert_eq!(v["items"][0]["project_name"], pa["name"]);
    // JSON 키("text")에는 걸리지 않고 실제 본문에만 걸린다
    let (_, v) = s.get("/api/v1/sessions/search?q=text&body=true").await;
    assert_eq!(titles(&v), ["배포 점검"]);
    // 날짜 필터
    let (_, v) = s.get("/api/v1/sessions/search?to=2000-01-01T00:00:00Z").await;
    assert_eq!(v["total"], 0);
    let (_, v) = s.get("/api/v1/sessions/search?from=2000-01-01T00:00:00Z").await;
    assert_eq!(v["total"], 3);
    // 상태: 보관은 기본 제외, archived 필터로만
    let (_, cur) = s.get(&format!("/api/v1/sessions/{s3}")).await;
    s.send(reqwest::Method::PATCH, &format!("/api/v1/sessions/{s3}"), json!({ "expected_revision": cur["revision"], "archived": true })).await;
    let (_, v) = s.get("/api/v1/sessions/search").await;
    assert_eq!(v["total"], 2);
    let (_, v) = s.get("/api/v1/sessions/search?status=archived").await;
    assert_eq!(titles(&v), ["다른 프로젝트 배포"]);
    // 페이지
    let (_, v) = s.get("/api/v1/sessions/search?limit=1&offset=1").await;
    assert_eq!(v["items"].as_array().unwrap().len(), 1);
    assert_eq!(v["total"], 2);
    // 잘못된 입력
    let (st, _) = s.get("/api/v1/sessions/search?status=weird").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = s.get("/api/v1/sessions/search?from=yesterday").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}
