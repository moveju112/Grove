//! 외부 도구가 없을 때의 안내(ARCH-018). PATH를 바꾸므로 이 파일에는 시험 하나만 둔다(같은 프로세스의 다른 시험에 영향 없음).
mod common;

use common::*;
use reqwest::StatusCode;
use serde_json::json;

#[tokio::test]
async fn missing_external_tools_report_purpose_and_install_without_installing() {
    let empty = tempfile::tempdir().unwrap();
    // SAFETY: 이 시험 바이너리의 유일한 시험이고 서버 시작 전에 바꾼다.
    unsafe { std::env::set_var("PATH", empty.path()) };
    let s = TestServer::start().await;
    let p = s.create_project("deps").await;
    let pid = p["id"].as_str().unwrap();

    // git: 쓰는 순간에만 진단하고, 무엇에 필요한지·설치 방법을 알린다.
    let (st, v) = s.get(&format!("/api/v1/projects/{pid}/git/status")).await;
    assert_eq!(st, StatusCode::FAILED_DEPENDENCY, "{v}");
    assert_eq!(v["error"]["code"], "dependency_missing");
    assert_eq!(v["error"]["details"]["program"], "git");
    assert_eq!(v["error"]["details"]["auto_install"], false);
    assert!(v["error"]["message"].as_str().unwrap().contains("설치"), "{v}");

    // 셸: 백그라운드 작업은 실패로 끝나고 사유에 설치·셸 변경 안내가 남는다.
    let sess = s.create_session(pid).await;
    let sid = sess["id"].as_str().unwrap();
    let (st, t) = s.post(&format!("/api/v1/sessions/{sid}/tasks"), json!({ "command": "echo hi" })).await;
    assert!(st.is_success(), "{t}");
    let (_, w) = s.get(&format!("/api/v1/tasks/{}/wait?timeout_ms=5000", t["id"].as_str().unwrap())).await;
    assert_eq!(w["status"], "failed", "{w}");
    let reason = w["reason"].as_str().unwrap_or("");
    assert!(reason.contains("실행 파일을 찾을 수 없습니다") && reason.contains("설정에서 셸"), "{w}");

    // CLI 모델 프로필 연결 확인: 설치 안내, 자동 설치 없음.
    let (st, prof) = s.post("/api/v1/model-profiles", json!({ "name": "cli", "protocol": "claude_code", "base_url": "", "model": "haiku" })).await;
    assert_eq!(st, StatusCode::CREATED, "{prof}");
    let (st, r) = s.post(&format!("/api/v1/model-profiles/{}/check", prof["id"].as_str().unwrap()), json!({})).await;
    assert_eq!(st, StatusCode::OK, "{r}");
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "cli_not_found");
    assert!(r["message"].as_str().unwrap_or("").contains("npm install"), "{r}");
    // 빈 PATH 폴더에 아무것도 설치하지 않았다.
    assert_eq!(std::fs::read_dir(empty.path()).unwrap().count(), 0);
}
