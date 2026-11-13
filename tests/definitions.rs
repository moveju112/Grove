mod common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::json;

#[tokio::test]
async fn builtin_agents_and_workflows_preserved_byte_for_byte() {
    let s = TestServer::start().await;
    let (_, agents) = s.get("/api/v1/definitions?kind=agent").await;
    assert_eq!(agents.as_array().unwrap().len(), 13);
    let (_, wfs) = s.get("/api/v1/definitions?kind=workflow").await;
    assert_eq!(wfs.as_array().unwrap().len(), 2);
    // 고정한 원문 hash(assets/baseline-manifest.json)와 API 본문을 바이트 단위로 대조한다.
    let manifest: serde_json::Value = serde_json::from_str(grove::definitions::BASELINE_MANIFEST).unwrap();
    let (_, w) = s.get("/api/v1/definitions/agent/worker").await;
    assert_eq!(w["body_sha256"], manifest["files"]["agents/worker/AGENT.md"]);
    assert_eq!(w["name"], "Worker");
    assert_eq!(w["builtin"], true);
    assert_eq!(w["revision"], 0);
    assert_eq!(w["baseline_sha256"], w["body_sha256"]);
    assert!(w["modified_fields"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn edit_compare_restore_and_conflict() {
    let s = TestServer::start().await;
    let (_, orig) = s.get("/api/v1/definitions/agent/reviewer").await;
    let (st, v) = s.send(Method::PUT, "/api/v1/definitions/agent/reviewer", json!({ "expected_revision": 0, "body": "내 리뷰 지침" })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["revision"], 1);
    assert_eq!(v["modified_fields"], json!(["body"]));
    assert_eq!(v["baseline_body"], orig["body"]);
    // 다른 기기의 오래된 revision 편집은 충돌, 수정본 보존
    let (st, v) = s.send(Method::PUT, "/api/v1/definitions/agent/reviewer", json!({ "expected_revision": 0, "body": "다른" })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["details"]["current"]["body"], "내 리뷰 지침");
    // 이름만 바꾸고 이름만 복원
    let (_, v) = s.send(Method::PUT, "/api/v1/definitions/agent/reviewer", json!({ "expected_revision": 1, "name": "검토자" })).await;
    assert_eq!(v["modified_fields"], json!(["name", "body"]));
    let (st, v) = s.post("/api/v1/definitions/agent/reviewer/restore", json!({ "expected_revision": 2, "fields": ["name"] })).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["modified_fields"], json!(["body"]));
    assert_eq!(v["body"], "내 리뷰 지침");
    // 전체 복원
    let (_, v) = s.post("/api/v1/definitions/agent/reviewer/restore", json!({ "expected_revision": 3 })).await;
    assert_eq!(v["body"], orig["body"]);
    assert!(v["modified_fields"].as_array().unwrap().is_empty());
    assert_eq!(v["revision"], 4, "복원도 revision을 올려 ABA를 막는다");
    // 빈 본문 거절
    let (st, _) = s.send(Method::PUT, "/api/v1/definitions/agent/reviewer", json!({ "expected_revision": 4, "body": "  " })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    // 원문과 같은 값으로 저장하면 수정 없음으로 계산
    let (_, v) = s.send(Method::PUT, "/api/v1/definitions/agent/reviewer", json!({ "expected_revision": 4, "body": orig["body"] })).await;
    assert!(v["modified_fields"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn custom_definitions_lifecycle() {
    let s = TestServer::start().await;
    for bad in ["Bad", "-x", "worker"] {
        let (st, _) = s.post("/api/v1/definitions/agent", json!({ "id": bad, "name": "n", "body": "b" })).await;
        assert!(st == StatusCode::BAD_REQUEST || st == StatusCode::CONFLICT, "{bad}: {st}");
    }
    let (st, v) = s.post("/api/v1/definitions/workflow", json!({ "id": "review-first", "name": "리뷰 우선", "body": "먼저 검토" })).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let (_, wfs) = s.get("/api/v1/definitions?kind=workflow").await;
    assert_eq!(wfs.as_array().unwrap().len(), 3);
    // 세션에 적용
    let p = s.create_project("p").await;
    let sess = s.create_session(p["id"].as_str().unwrap()).await;
    let sid = sess["id"].as_str().unwrap();
    let (st, v) = s.send(Method::PATCH, &format!("/api/v1/sessions/{sid}"), json!({ "expected_revision": 1, "workflow_id": "review-first" })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    // 비활성화하면 새로 선택할 수 없다
    let (_, v) = s.send(Method::PUT, "/api/v1/definitions/workflow/review-first", json!({ "expected_revision": 1, "enabled": false })).await;
    assert_eq!(v["enabled"], false);
    let other = s.create_session(p["id"].as_str().unwrap()).await;
    let (st, v) = s
        .send(Method::PATCH, &format!("/api/v1/sessions/{}", other["id"].as_str().unwrap()), json!({ "expected_revision": 1, "workflow_id": "review-first" }))
        .await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    // 기본 워크플로우는 비활성화 불가
    let (st, _) = s.send(Method::PUT, "/api/v1/definitions/workflow/default", json!({ "expected_revision": 0, "enabled": false })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    // 삭제: 기본 정의는 불가, 사용자 정의는 가능하며 세션은 기본값으로 돌아간다
    let (st, _) = s.send(Method::DELETE, "/api/v1/definitions/agent/worker?expected_revision=0", json!({})).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = s.send(Method::DELETE, "/api/v1/definitions/workflow/review-first?expected_revision=2", json!({})).await;
    assert_eq!(st, StatusCode::OK);
    let (_, sv) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    assert!(sv["workflow_id"].is_null());
    let (st, _) = s.get("/api/v1/definitions/workflow/review-first").await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    // 같은 ID 재생성 시 revision은 이어서 증가
    let (_, v) = s.post("/api/v1/definitions/workflow", json!({ "id": "review-first", "name": "다시", "body": "b" })).await;
    assert_eq!(v["revision"], 4);
}
