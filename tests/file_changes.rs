//! 세션별 파일 변경 이력·patch·review·undo/redo(GIT-011~014). 모델 응답은 로컬 fixture.
mod common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};

/// 턴을 시작하고 승인 대기 호출을 모두 승인하며 완료까지 진행한다.
async fn run_turn(s: &TestServer, sid: &str, prof: &str, text: &str) -> String {
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": text, "profile_id": prof, "tools": true })).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let tid = v["turn"]["id"].as_str().unwrap().to_string();
    loop {
        let t = s.wait_turn(&tid, |t| t["status"] == "awaiting_approval" || t["status"] == "completed" || t["status"] == "failed").await;
        if t["status"] != "awaiting_approval" {
            assert_eq!(t["status"], "completed", "{t}");
            return tid;
        }
        for c in t["tool_calls"].as_array().unwrap().iter().filter(|c| c["status"] == "pending_approval") {
            s.post(&format!("/api/v1/tool-calls/{}/decision", c["id"].as_str().unwrap()), json!({ "decision": "approve", "expected_revision": c["revision"] }))
                .await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

fn ids(changes: &Value, turn: &str) -> Vec<Value> {
    changes.as_array().unwrap().iter().filter(|c| c["turn_id"] == turn).map(|c| c["id"].clone()).collect()
}

#[tokio::test]
async fn file_changes_patch_review_undo_redo() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("chg").await;
    let root = p["root_path"].as_str().unwrap().to_string();
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let read = |name: &str| std::fs::read_to_string(format!("{root}/{name}")).ok();

    // 턴 1: 새 파일 → 수정
    f.push(fixture::tool_calls(&[("w", "write", json!({ "path": "a.txt", "content": "one\n" }))]));
    f.push(fixture::tool_calls(&[("e", "edit", json!({ "path": "a.txt", "old_string": "one", "new_string": "two" }))]));
    f.push(fixture::text("1 끝"));
    let t1 = run_turn(&s, &sid, &prof, "1").await;
    // 턴 2: 패치로 새 파일 추가 + 수정
    let patch = "*** Begin Patch\n*** Add File: c.txt\n+see\n*** Update File: a.txt\n@@\n-two\n+three\n*** End Patch\n";
    f.push(fixture::tool_calls(&[("p", "apply_patch", json!({ "patch": patch }))]));
    f.push(fixture::text("2 끝"));
    let t2 = run_turn(&s, &sid, &prof, "2").await;
    assert_eq!((read("a.txt").as_deref(), read("c.txt").as_deref()), (Some("three\n"), Some("see\n")));

    // 목록: 순서·종류·턴 연결(GIT-011)
    let (_, ch) = s.get(&format!("/api/v1/sessions/{sid}/file-changes")).await;
    let rows: Vec<(String, String, String)> = ch
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["path"].as_str().unwrap().into(), c["op"].as_str().unwrap().into(), c["tool"].as_str().unwrap().into()))
        .collect();
    assert_eq!(
        rows,
        vec![
            ("a.txt".into(), "created".into(), "write".into()),
            ("a.txt".into(), "modified".into(), "edit".into()),
            ("a.txt".into(), "modified".into(), "apply_patch".into()),
            ("c.txt".into(), "created".into(), "apply_patch".into()),
        ],
        "{ch}"
    );
    assert_eq!(ids(&ch, &t1).len(), 2);
    // patch 한 건
    let (_, d) = s.get(&format!("/api/v1/file-changes/{}/diff", ch[1]["id"].as_str().unwrap())).await;
    assert!(d["diff"].as_str().unwrap().contains("-one") && d["diff"].as_str().unwrap().contains("+two"), "{d}");
    // 세션 전체 검토: 기준(첫 변경 전, 없음)과 지금 디스크 비교(GIT-014)
    let (_, r) = s.get(&format!("/api/v1/sessions/{sid}/review")).await;
    let a = r["files"].as_array().unwrap().iter().find(|f| f["path"] == "a.txt").unwrap();
    assert!(a["baseline_sha"].is_null());
    assert!(a["diff"].as_str().unwrap().contains("+three"), "{r}");

    // 턴 1만 되돌리기: 턴 2가 a.txt를 바꿨으므로 충돌, 아무것도 바꾸지 않음(GIT-012)
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/file-changes/undo"), json!({ "change_ids": ids(&ch, &t1) })).await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"]["details"]["files"][0]["path"], "a.txt");
    assert_eq!(read("a.txt").as_deref(), Some("three\n"));
    // 턴 2 되돌리기 → 다시 적용
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/file-changes/undo"), json!({ "change_ids": ids(&ch, &t2) })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!((read("a.txt").as_deref(), read("c.txt")), (Some("two\n"), None));
    let (st, _) = s.post(&format!("/api/v1/sessions/{sid}/file-changes/undo"), json!({ "change_ids": ids(&ch, &t2) })).await;
    assert_eq!(st, StatusCode::CONFLICT, "이미 되돌린 변경");
    let (st, _) = s.post(&format!("/api/v1/sessions/{sid}/file-changes/redo"), json!({ "change_ids": ids(&ch, &t2) })).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!((read("a.txt").as_deref(), read("c.txt").as_deref()), (Some("three\n"), Some("see\n")));
    // 전체 되돌리기: 같은 파일의 여러 변경을 최근 것부터 계산해 처음 상태(없음)로
    let all: Vec<Value> = ch.as_array().unwrap().iter().map(|c| c["id"].clone()).collect();
    let (st, v) = s.post(&format!("/api/v1/sessions/{sid}/file-changes/undo"), json!({ "change_ids": all })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!((read("a.txt"), read("c.txt")), (None, None));
    // 다시 적용한 뒤 바깥에서 파일을 바꾸면 되돌리기는 충돌로 거절하고 파일을 지킨다
    s.post(&format!("/api/v1/sessions/{sid}/file-changes/redo"), json!({ "change_ids": all })).await;
    assert_eq!(read("a.txt").as_deref(), Some("three\n"));
    std::fs::write(format!("{root}/a.txt"), "user edit\n").unwrap();
    let (st, _) = s.post(&format!("/api/v1/sessions/{sid}/file-changes/undo"), json!({ "change_ids": ids(&ch, &t2) })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!((read("a.txt").as_deref(), read("c.txt").as_deref()), (Some("user edit\n"), Some("see\n")), "충돌이면 c.txt도 건드리지 않는다");
    // 다른 세션의 변경 ID는 거부
    let other = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    let (st, _) = s.post(&format!("/api/v1/sessions/{other}/file-changes/undo"), json!({ "change_ids": ids(&ch, &t2) })).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    // 대화 rewind와 분리(GIT-013): 변경 이력은 대화 메시지가 아니다
    let (_, msgs) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    assert!(!msgs.to_string().contains("file_changes"));
}
