//! 기존 Paseo 대화 가져오기(MIG-004~015, FLOW-08).
mod common;

use common::fixture::{self, Fixture};
use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};
use std::path::Path;
use std::process::Command;

fn item(ts: &str, it: Value) -> Value {
    json!({ "timestamp": ts, "item": it })
}

/// 실제 원본 형식(version 2)과 같은 모양의 대화 파일.
fn write_source(dir: &Path, project: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    let s1 = json!({
        "version": 2, "id": "src-1", "cwd": project.to_string_lossy(), "promptHash": "h", "nativeSessionId": "n",
        "createdAt": 1_790_000_000_000i64, "updatedAt": 1_790_000_100_000i64, "historyTruncated": false, "active": { "turnId": "t9" },
        "receipts": { "r": { "state": "completed" } }, "usage": { "t1": { "inputTokens": 5 } },
        "items": [
            item("2026-09-21T10:00:00.000Z", json!({ "type": "user_message", "id": "u1", "clientMessageId": "c1", "text": "배포 스크립트 고쳐줘\n자세히" })),
            item("2026-09-21T10:00:01.000Z", json!({ "type": "assistant_message", "id": "a1", "phase": "commentary", "text": "먼저 파일을 볼게" })),
            item("2026-09-21T10:00:02.000Z", json!({ "type": "tool_call", "id": "x1", "callId": "k1", "name": "read", "status": "completed", "error": null, "detail": { "type": "plain_text", "text": "deploy.sh 내용…" } })),
            item("2026-09-21T10:00:03.000Z", json!({ "type": "compaction", "id": "cp", "status": "completed", "trigger": "auto", "preTokens": 120000 })),
            item("2026-09-21T10:00:04.000Z", json!({ "type": "assistant_message", "id": "a2", "phase": "final_answer", "text": "고쳤어" })),
            item("2026-09-21T10:00:05.000Z", json!({ "type": "notification", "id": "n1", "level": "warning", "message": "할당량 경고" })),
            item("2026-09-21T10:00:06.000Z", json!({ "type": "tool_call", "id": "x2", "callId": "k2", "name": "shell", "status": "running", "error": null, "detail": { "type": "plain_text", "text": "rm -rf build" } })),
        ],
    });
    let s2 = json!({
        "version": 2, "id": "src-2", "cwd": "/no/such/old/project", "promptHash": "h", "nativeSessionId": "n",
        "createdAt": 1_790_000_200_000i64, "updatedAt": 1_790_000_200_000i64, "historyTruncated": true, "active": null,
        "receipts": {}, "usage": {},
        "items": [ item("2026-09-21T11:00:00.000Z", json!({ "type": "user_message", "id": "u", "clientMessageId": "c", "text": "옛 프로젝트 질문" })) ],
    });
    std::fs::write(dir.join("src-1.json"), s1.to_string()).unwrap();
    std::fs::write(dir.join("src-2.json"), s2.to_string()).unwrap();
    std::fs::write(dir.join("src-1.json.lock"), "").unwrap();
    std::fs::write(dir.join("broken.json"), "{not json").unwrap();
}

fn tree_hash(dir: &Path) -> Vec<(String, String)> {
    let mut v: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| {
            let p = e.unwrap().path();
            (p.file_name().unwrap().to_string_lossy().to_string(), grove::util::sha256_hex(&std::fs::read(&p).unwrap()))
        })
        .collect();
    v.sort();
    v
}

fn import(src: &Path, data: &Path, dry: bool) -> (bool, Value, String) {
    let mut c = Command::new(env!("CARGO_BIN_EXE_grove"));
    c.args(["import", "paseo"]).arg(src).arg("--data-dir").arg(data);
    if dry {
        c.arg("--dry-run");
    }
    let o = c.output().unwrap();
    let out = String::from_utf8_lossy(&o.stdout).to_string();
    (o.status.success(), serde_json::from_str(&out).unwrap_or(Value::Null), String::from_utf8_lossy(&o.stderr).to_string())
}

#[tokio::test]
async fn import_is_read_only_verified_idempotent_and_resumes_text_only() {
    let work = tempfile::tempdir().unwrap();
    let project = work.path().join("proj");
    std::fs::create_dir_all(&project).unwrap();
    let src = work.path().join("sessions");
    write_source(&src, &project);
    let before = tree_hash(&src);
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");

    // dry-run: 보고만, 가져오지 않음
    let (_, r, _) = import(&src, &data, true);
    assert_eq!(r["counts"]["importable"], 2, "{r}");
    assert_eq!(r["counts"]["failed"], 1, "깨진 파일은 실패로 보고");
    assert_eq!(r["counts"]["interrupted_items"], 2, "실행 중 도구 1 + 활성 턴 1");
    assert_eq!(r["missing_project_paths"], 1);
    assert!(r["not_imported"]["always"].to_string().contains("재로그인"));
    let c = rusqlite::Connection::open(data.join("grove.db")).unwrap();
    assert_eq!(c.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    drop(c);

    // 실제 가져오기: 깨진 파일 때문에 종료 코드는 실패지만 나머지는 들어간다
    let (ok, r, err) = import(&src, &data, false);
    assert!(!ok && err.contains("다시 실행하면"), "{err}");
    assert_eq!(r["counts"]["imported"], 2, "{r}");
    assert_eq!(tree_hash(&src), before, "원본은 한 바이트도 바뀌지 않는다");
    // 다시 실행: 중복 없음
    let (_, r, _) = import(&src, &data, false);
    assert_eq!(r["counts"]["already_imported"], 2, "{r}");
    // 원본이 바뀌면 덮어쓰지 않고 보고
    let p1 = src.join("src-2.json");
    let mut v: Value = serde_json::from_str(&std::fs::read_to_string(&p1).unwrap()).unwrap();
    v["items"][0]["item"]["text"] = json!("바뀐 질문");
    std::fs::write(&p1, v.to_string()).unwrap();
    let (_, r, _) = import(&src, &data, false);
    assert_eq!(r["changed_since_import"], json!(["src-2"]), "{r}");

    // 서버로 열람·재개
    let f = Fixture::start().await;
    let s = TestServer::start_with(dir, config(&data)).await;
    // 서버 실행 중에는 가져오기 거부(같은 잠금)
    let (ok, _, err) = import(&src, &data, true);
    assert!(!ok && err.contains("이미 서버가 실행 중"), "{err}");
    let (_, list) = s.get("/api/v1/sessions/search?q=").await;
    let items = list["items"].as_array().unwrap();
    let s1 = items.iter().find(|x| x["title"] == "배포 스크립트 고쳐줘").expect("첫 줄이 제목");
    let sid = s1["id"].as_str().unwrap().to_string();
    let (_, msgs) = s.get(&format!("/api/v1/sessions/{sid}/messages")).await;
    let m = msgs["items"].as_array().unwrap();
    assert_eq!(m.len(), 8, "안내 1 + 원본 7");
    assert_eq!(m[0]["content"]["type"], "import_notice");
    assert_eq!(m[0]["content"]["resume"], "text_only");
    assert_eq!(m[3]["content"]["type"], "imported_tool");
    assert_eq!(m[7]["content"]["status"], "interrupted", "실행 중이던 도구는 결과 불명");
    assert_eq!(m[1]["created_at"], "2026-09-21T10:00:00Z", "원본 시각 유지");
    // 실행 기록은 만들지 않는다(재실행 없음)
    let (_, turns) = s.get(&format!("/api/v1/sessions/{sid}/turns")).await;
    assert_eq!(turns.as_array().map(Vec::len).unwrap_or(turns["items"].as_array().map(Vec::len).unwrap_or(0)), 0);
    // 없는 경로의 프로젝트는 사용 불가 상태로 표시(재연결 대상)
    let (_, projects) = s.get("/api/v1/projects").await;
    let old = projects.as_array().unwrap().iter().find(|p| p["root_path"] == "/no/such/old/project").expect("프로젝트 생성");
    assert_eq!(old["available"], false);

    // 후속 요청: 모델 입력에는 user/assistant 텍스트만(도구 표시·안내·압축 표시 제외)
    let prof = s.fixture_profile(&f.base).await;
    f.push(fixture::text("이어서 답함"));
    let (st, t) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "이어서 해줘", "profile_id": prof })).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{t}");
    s.wait_status(t["turn"]["id"].as_str().unwrap(), "completed").await;
    let req = f.requests().last().cloned().unwrap();
    let body = req.to_string();
    let texts: Vec<String> = req["messages"].as_array().unwrap().iter().filter(|m| m["role"] != "system").map(|m| m["content"].to_string()).collect();
    assert_eq!(texts.len(), 4, "user, assistant, assistant, 새 user: {texts:?}");
    assert!(body.contains("먼저 파일을 볼게") && body.contains("고쳤어") && body.contains("이어서 해줘"));
    assert!(!body.contains("deploy.sh 내용") && !body.contains("할당량 경고") && !body.contains("import_notice"), "표시 전용 기록은 모델 입력에 없음");
}
