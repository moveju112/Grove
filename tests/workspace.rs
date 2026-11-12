mod common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

fn layout_two(pa: &str, sa: &str, pb: &str, sb: &str, dir: &str) -> Value {
    json!({
        "schema": 1,
        "focused_leaf": "L2",
        "root": {
            "type": "split", "direction": dir, "ratio": 0.4,
            "children": [
                { "type": "leaf", "id": "L1", "active_tab": "t1", "tabs": [{ "id": "t1", "kind": "session", "project_id": pa, "resource_id": sa }] },
                { "type": "leaf", "id": "L2", "active_tab": "t2", "tabs": [{ "id": "t2", "kind": "session", "project_id": pb, "resource_id": sb }] }
            ]
        }
    })
}

/// START-004 / FLOW-12 서버 측: 두 프로젝트 세션을 최근 항목·분할로 저장하고 재시작 후 복원.
#[tokio::test]
async fn two_projects_recent_and_split_survive_restart() {
    let mut s = TestServer::start().await;
    let a = s.create_project("A").await;
    let b = s.create_project("B").await;
    let (pa, pb) = (a["id"].as_str().unwrap().to_string(), b["id"].as_str().unwrap().to_string());
    let sa = s.create_session(&pa).await["id"].as_str().unwrap().to_string();
    let sb = s.create_session(&pb).await["id"].as_str().unwrap().to_string();

    for (p, sid) in [(&pa, &sa), (&pb, &sb), (&pa, &sa)] {
        let (st, v) = s.post("/api/v1/recent/touch", json!({ "kind": "session", "project_id": p, "resource_id": sid })).await;
        assert_eq!(st, StatusCode::OK, "{v}");
    }
    let (_, recent) = s.get("/api/v1/recent").await;
    let items = recent["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "같은 자원 재열기는 중복 항목을 만들지 않는다");
    assert_eq!(items[0]["resource_id"], sa.as_str(), "가장 최근 접근이 먼저");
    assert_eq!(items[0]["project_name"], "A");

    // 세션 B를 고정하면 맨 앞
    let rb = items.iter().find(|i| i["resource_id"] == sb.as_str()).unwrap();
    let (st, v) = s
        .send(Method::PATCH, &format!("/api/v1/recent/{}", rb["id"].as_str().unwrap()), json!({ "expected_revision": rb["revision"], "pinned": true }))
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let (_, recent) = s.get("/api/v1/recent").await;
    assert_eq!(recent["items"][0]["resource_id"], sb.as_str());
    let (_, pinned) = s.get("/api/v1/recent?filter=pinned").await;
    assert_eq!(pinned["items"].as_array().unwrap().len(), 1);
    let (_, found) = s.get("/api/v1/recent?q=b").await;
    assert_eq!(found["items"].as_array().unwrap().len(), 1);

    // 좌우 분할 저장 → 위아래로 변경 → 재시작 후 복원
    let (st, v) = s.send(Method::PUT, "/api/v1/layouts/pc-1", json!({ "expected_revision": 0, "layout": layout_two(&pa, &sa, &pb, &sb, "row") })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let (st, _) = s.send(Method::PUT, "/api/v1/layouts/pc-1", json!({ "expected_revision": 1, "layout": layout_two(&pa, &sa, &pb, &sb, "column") })).await;
    assert_eq!(st, StatusCode::OK);
    // 다른 기기(폰)는 PC 배치를 강제로 복사받지 않는다
    let (_, phone) = s.get("/api/v1/layouts/phone-1").await;
    assert!(phone["layout"].is_null());
    s.restart().await;
    let (_, l) = s.get("/api/v1/layouts/pc-1").await;
    assert_eq!(l["revision"], 2);
    assert_eq!(l["layout"]["root"]["direction"], "column");
    assert_eq!(l["layout"]["root"]["children"][1]["tabs"][0]["project_id"], pb.as_str());
    let (_, recent) = s.get("/api/v1/recent").await;
    assert_eq!(recent["items"][0]["pinned"], true);
}

#[tokio::test]
async fn layout_validation_and_conflict() {
    let s = TestServer::start().await;
    let bad = [
        json!({ "schema": 2, "root": { "type": "leaf", "id": "a", "tabs": [] } }),
        json!({ "schema": 1, "root": { "type": "split", "direction": "diag", "ratio": 0.5, "children": [] } }),
        json!({ "schema": 1, "root": { "type": "split", "direction": "row", "ratio": 0.95, "children": [
            { "type": "leaf", "id": "a", "tabs": [] }, { "type": "leaf", "id": "b", "tabs": [] }] } }),
        json!({ "schema": 1, "root": { "type": "leaf", "id": "a", "tabs": [{ "id": "t", "kind": "session", "resource_id": "x" }] } }),
        json!({ "schema": 1, "root": { "type": "split", "direction": "row", "ratio": 0.5, "children": [
            { "type": "leaf", "id": "a", "tabs": [] }, { "type": "leaf", "id": "a", "tabs": [] }] } }),
    ];
    for l in bad {
        let (st, v) = s.send(Method::PUT, "/api/v1/layouts/d1", json!({ "expected_revision": 0, "layout": l })).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{v}");
    }
    let ok = json!({ "schema": 1, "root": { "type": "leaf", "id": "a", "tabs": [] } });
    let (st, _) = s.send(Method::PUT, "/api/v1/layouts/d1", json!({ "expected_revision": 0, "layout": ok })).await;
    assert_eq!(st, StatusCode::OK);
    let (st, v) = s.send(Method::PUT, "/api/v1/layouts/d1", json!({ "expected_revision": 0, "layout": ok })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["details"]["current"]["revision"], 1);
    let (st, _) = s.get("/api/v1/layouts/bad%20id").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

/// FLOW-12: 동시 초안은 무음 덮어쓰기 없이 충돌로 알린다.
#[tokio::test]
async fn drafts_conflict_instead_of_silent_overwrite() {
    let s = TestServer::start().await;
    let p = s.create_project("p").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let key = format!("session:{sid}");
    let (_, d) = s.get(&format!("/api/v1/drafts/{key}")).await;
    assert_eq!(d["revision"], 0);
    let (st, _) = s.send(Method::PUT, &format!("/api/v1/drafts/{key}"), json!({ "expected_revision": 0, "text": "PC 초안", "device_name": "pc" })).await;
    assert_eq!(st, StatusCode::OK);
    // 폰이 오래된 revision으로 저장 시도
    let (st, v) = s.send(Method::PUT, &format!("/api/v1/drafts/{key}"), json!({ "expected_revision": 0, "text": "폰 초안", "device_name": "phone" })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["details"]["current"]["text"], "PC 초안");
    assert_eq!(v["error"]["details"]["current"]["device_name"], "pc");
    let (_, d) = s.get(&format!("/api/v1/drafts/{key}")).await;
    assert_eq!(d["text"], "PC 초안");
    let (st, _) = s.get("/api/v1/drafts/other:1").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn recent_status_reflects_archived_and_hidden() {
    let s = TestServer::start().await;
    let p = s.create_project("p").await;
    let pid = p["id"].as_str().unwrap();
    let sess = s.create_session(pid).await;
    let sid = sess["id"].as_str().unwrap();
    let (_, item) = s.post("/api/v1/recent/touch", json!({ "kind": "session", "project_id": pid, "resource_id": sid })).await;
    assert_eq!(item["status"], "active");
    assert_eq!(item["unread"], false);
    for filter in ["all", "pinned", "running", "awaiting_approval", "awaiting_input", "unread", "hidden"] {
        let (st, page) = s.get(&format!("/api/v1/recent?filter={filter}")).await;
        assert_eq!(st, StatusCode::OK, "{filter}: {page}");
        assert!(page["items"].is_array(), "{filter}: {page}");
    }
    s.post(&format!("/api/v1/sessions/{sid}/messages"), json!({ "text": "new" })).await;
    let (_, unread) = s.get("/api/v1/recent?filter=unread").await;
    assert_eq!(unread["items"].as_array().unwrap().len(), 1);
    // 읽음 처리
    let (st, item) = s
        .send(Method::PATCH, &format!("/api/v1/recent/{}", item["id"].as_str().unwrap()), json!({ "expected_revision": item["revision"], "view_state": { "last_seen_seq": 1 } }))
        .await;
    assert_eq!(st, StatusCode::OK, "{item}");
    assert_eq!(item["unread"], false);
    s.send(Method::PATCH, &format!("/api/v1/sessions/{sid}"), json!({ "expected_revision": 1, "archived": true })).await;
    let (_, list) = s.get("/api/v1/recent").await;
    assert_eq!(list["items"][0]["status"], "archived");
    // 최근 목록에서 숨기기는 세션 삭제가 아니다
    let it = &list["items"][0];
    s.send(Method::PATCH, &format!("/api/v1/recent/{}", it["id"].as_str().unwrap()), json!({ "expected_revision": it["revision"], "hidden": true })).await;
    let (_, list) = s.get("/api/v1/recent").await;
    assert!(list["items"].as_array().unwrap().is_empty());
    let (_, hidden) = s.get("/api/v1/recent?filter=hidden").await;
    assert_eq!(hidden["items"].as_array().unwrap().len(), 1);
    let (st, _) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    assert_eq!(st, StatusCode::OK);
    // 다른 프로젝트의 세션을 섞어 등록할 수 없다
    let q = s.create_project("q").await;
    let (st, _) = s.post("/api/v1/recent/touch", json!({ "kind": "session", "project_id": q["id"], "resource_id": sid })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn recent_pagination_offsets() {
    let s = TestServer::start().await;
    let p = s.create_project("p").await;
    let pid = p["id"].as_str().unwrap();
    for i in 0..5 {
        s.post("/api/v1/recent/touch", json!({ "kind": "file", "project_id": pid, "resource_id": format!("f{i}.txt") })).await;
    }
    let (_, a) = s.get("/api/v1/recent?limit=2").await;
    assert_eq!(a["total"], 5);
    assert_eq!(a["next_offset"], 2);
    let (_, c) = s.get("/api/v1/recent?limit=2&offset=4").await;
    assert_eq!(c["items"].as_array().unwrap().len(), 1);
    assert!(c["next_offset"].is_null());
    let _: Value = c;
}
