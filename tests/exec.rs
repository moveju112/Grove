//! `grove exec` 단발 실행(ONCE). 실제 실행 파일을 격리 HTTP fixture와 임시 프로젝트로 실행한다.
mod common;

use common::fixture::{self, Fixture};
use serde_json::{Value, json};
use std::process::Stdio;

struct Run {
    code: i32,
    out: Value,
    err: String,
}

fn cmd(project: &std::path::Path, run_dir: &std::path::Path, f: &Fixture, extra: &[&str]) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(env!("CARGO_BIN_EXE_grove"));
    c.arg("exec").args(["--base-url", &f.base, "--model", "fixture-model", "--project"]).arg(project).arg("--run-dir").arg(run_dir);
    c.args(extra);
    // 개인 데이터 경로를 건드리지 않는지 보려고 빈 임시 경로로 둔다.
    c.env("GROVE_DATA_DIR", run_dir.with_extension("personal")).env("EXEC_TEST_KEY", "sk-test-secret-value-7777");
    c.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::piped());
    c
}

async fn run(mut c: tokio::process::Command) -> Run {
    let o = c.output().await.unwrap();
    let out = serde_json::from_slice(&o.stdout).unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&o.stdout) }));
    Run { code: o.status.code().unwrap_or(-1), out, err: String::from_utf8_lossy(&o.stderr).into() }
}

fn setup() -> (tempfile::TempDir, std::path::PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("proj");
    std::fs::create_dir_all(&p).unwrap();
    std::fs::write(p.join("AGENTS.md"), "PROJECT_RULE_MARKER").unwrap();
    (d, p)
}

// ONCE-002·003·008·011: 정상 실행은 버전 있는 JSON·종료 코드 0, 프로젝트 지침은 기본 제외, show는 다시 실행하지 않는다.
#[tokio::test]
async fn success_excludes_project_instructions_and_show_does_not_rerun() {
    let (d, p) = setup();
    let f = Fixture::start().await;
    f.push(fixture::text("완료했어"));
    let rd = d.path().join("run1");
    let r = run(cmd(&p, &rd, &f, &["--prompt", "요약해 줘", "--api-key-env", "EXEC_TEST_KEY"])).await;
    assert_eq!(r.code, 0, "{} {}", r.out, r.err);
    assert_eq!(r.out["schema"], "grove.exec.v1");
    assert_eq!(r.out["status"], "succeeded");
    assert_eq!(r.out["text"], "완료했어");
    assert_eq!(r.out["isolation"], "none");
    let req = f.requests()[0].to_string();
    assert!(req.contains("요약해 줘") && !req.contains("PROJECT_RULE_MARKER"), "지침 파일 기본 제외: {req}");
    assert!(!r.err.contains("sk-test-secret-value-7777") && !r.out.to_string().contains("sk-test-secret-value-7777"));
    assert!(!d.path().join("run1.personal").exists(), "개인 데이터 경로를 만들지 않는다");
    let saved: Value = serde_json::from_slice(&std::fs::read(rd.join("result.json")).unwrap()).unwrap();
    assert_eq!(saved, r.out);
    // 재조회는 같은 결과·종료 코드이며 모델을 다시 부르지 않는다
    let o = tokio::process::Command::new(env!("CARGO_BIN_EXE_grove")).args(["exec", "show"]).arg(&rd).output().await.unwrap();
    assert_eq!(o.status.code(), Some(0));
    assert_eq!(serde_json::from_slice::<Value>(&o.stdout).unwrap(), saved);
    assert_eq!(f.requests().len(), 1);
    // 같은 run 디렉터리는 다시 쓰지 않는다
    let r = run(cmd(&p, &rd, &f, &["--prompt", "또"])).await;
    assert_eq!(r.code, 2, "{}", r.err);
    assert_eq!(f.requests().len(), 1);
    // 명시적으로 넣으면 지침이 들어간다
    f.push(fixture::text("지침 포함"));
    let r = run(cmd(&p, &d.path().join("run2"), &f, &["--prompt", "다시", "--with-project-instructions"])).await;
    assert_eq!(r.code, 0, "{}", r.err);
    assert!(f.requests()[1].to_string().contains("PROJECT_RULE_MARKER"));
    assert_eq!(r.out["included_context"][0]["kind"], "project_instructions");
    // 응답이 중간에 끊기면 실행 실패(1)
    f.push(fixture::truncated());
    let r = run(cmd(&p, &d.path().join("run3"), &f, &["--prompt", "끊김"])).await;
    assert_eq!(r.code, 1, "{} {}", r.out, r.err);
    assert_eq!(r.out["status"], "failed");
}

// ONCE-004·008: 입력·인증 오류는 모델을 부르지 않고 구분된 종료 코드로 끝난다.
#[tokio::test]
async fn input_and_auth_errors_end_before_any_model_call() {
    let (d, p) = setup();
    let f = Fixture::start().await;
    let r = run(cmd(&p, &d.path().join("a"), &f, &[])).await;
    assert_eq!(r.code, 2, "prompt 없음: {}", r.err);
    let r = run(cmd(&p, &d.path().join("b"), &f, &["--prompt", "x", "--api-key-env", "NO_SUCH_EXEC_KEY"])).await;
    assert_eq!(r.code, 3, "{}", r.err);
    assert!(r.err.contains("NO_SUCH_EXEC_KEY"));
    let r = run(cmd(&p, &d.path().join("c"), &f, &["--prompt", "x", "--effort", "max"])).await;
    assert_eq!(r.code, 3, "{} {}", r.out, r.err);
    assert_eq!(r.out["status"], "config_error");
    assert!(f.requests().is_empty(), "모델 호출 없음");
}

// ONCE-005·006: 사전 허용 밖의 변경 도구는 승인 창 없이 needs_approval로 끝나고, 허용한 도구만 실행한다.
#[tokio::test]
async fn unapproved_tool_needs_approval_and_allowed_tool_runs() {
    let (d, p) = setup();
    let f = Fixture::start().await;
    f.push(fixture::tool_calls(&[("w1", "write", json!({ "path": "out.txt", "content": "x" }))]));
    let r = run(cmd(&p, &d.path().join("a"), &f, &["--prompt", "파일 만들어", "--tools"])).await;
    assert_eq!(r.code, 4, "{} {}", r.out, r.err);
    assert_eq!(r.out["status"], "needs_approval");
    assert!(!p.join("out.txt").exists(), "승인 없이 쓰지 않는다");
    f.push(fixture::tool_calls(&[("w2", "write", json!({ "path": "out.txt", "content": "x" }))]));
    f.push(fixture::text("만들었어"));
    let r = run(cmd(&p, &d.path().join("b"), &f, &["--prompt", "파일 만들어", "--tools", "--allow-tool", "write"])).await;
    assert_eq!(r.code, 0, "{} {}", r.out, r.err);
    assert_eq!(std::fs::read_to_string(p.join("out.txt")).unwrap(), "x");
    assert_eq!(r.out["tool_calls"][0]["status"], "succeeded");
    assert_eq!(r.out["tool_calls"][0]["approval_scope"], "policy");
}

// ONCE-009·010: 종료 신호는 공용 취소 경로로 요청을 취소해 cancelled(6)로 끝내고, stdout pipe가 닫혀도 receipt는 남는다.
#[cfg(unix)]
#[tokio::test]
async fn sigterm_cancels_and_closed_stdout_keeps_receipt() {
    let (d, p) = setup();
    let f = Fixture::start().await;
    f.push(fixture::hang_after("..."));
    let rd = d.path().join("sig");
    let child = cmd(&p, &rd, &f, &["--prompt", "오래"]).spawn().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while f.requests().is_empty() {
        assert!(std::time::Instant::now() < deadline, "모델 요청 없음");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let pid = child.id().unwrap() as i32;
    unsafe { libc_kill(pid, 15) };
    let o = child.wait_with_output().await.unwrap();
    assert_eq!(o.status.code(), Some(6), "{}", String::from_utf8_lossy(&o.stderr));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["status"], "cancelled");

    f.push(fixture::text("닫힌 출력"));
    let rd = d.path().join("pipe");
    let mut child = cmd(&p, &rd, &f, &["--prompt", "출력"]).spawn().unwrap();
    drop(child.stdout.take());
    let st = child.wait().await.unwrap();
    assert_eq!(st.code(), Some(0), "출력 pipe 종료는 실행 결과를 바꾸지 않는다");
    let saved: Value = serde_json::from_slice(&std::fs::read(rd.join("result.json")).unwrap()).unwrap();
    assert_eq!(saved["text"], "닫힌 출력");
}

// ONCE-007·008: 실행 프로세스가 강제 종료되면 receipt가 없으므로 show는 다시 실행하지 않고 결과 불명(7)을 알리며 작업 데이터는 남는다.
#[cfg(unix)]
#[tokio::test]
async fn killed_run_is_reported_unknown_without_rerun() {
    let (d, p) = setup();
    let f = Fixture::start().await;
    f.push(fixture::hang_after("..."));
    let rd = d.path().join("kill");
    let child = cmd(&p, &rd, &f, &["--prompt", "오래"]).spawn().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while f.requests().is_empty() {
        assert!(std::time::Instant::now() < deadline, "모델 요청 없음");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    unsafe { libc_kill(child.id().unwrap() as i32, 9) };
    let _ = child.wait_with_output().await.unwrap();
    assert!(!rd.join("result.json").exists());
    assert!(rd.join("data/grove.db").exists(), "중단 증거(작업 DB)를 지우지 않는다");
    let o = tokio::process::Command::new(env!("CARGO_BIN_EXE_grove")).args(["exec", "show"]).arg(&rd).output().await.unwrap();
    assert_eq!(o.status.code(), Some(7));
    assert!(String::from_utf8_lossy(&o.stderr).contains("결과는 불명"));
    assert_eq!(f.requests().len(), 1, "다시 실행하지 않는다");
}

// ONCE-008: 시간 예산을 넘으면 timeout(5). 최소 예산이 1분이라 느린 시험으로 따로 실행한다(`--ignored`).
#[tokio::test]
#[ignore = "1분 시간 예산을 실제로 기다림"]
async fn time_budget_ends_with_timeout_code() {
    let (d, p) = setup();
    let f = Fixture::start().await;
    f.push(fixture::hang_after("..."));
    let r = run(cmd(&p, &d.path().join("t"), &f, &["--prompt", "오래", "--max-minutes", "1"])).await;
    assert_eq!(r.code, 5, "{} {}", r.out, r.err);
    assert_eq!(r.out["status"], "timeout");
    assert_eq!(r.out["error"]["code"], "time_budget_exceeded");
}

#[cfg(unix)]
unsafe fn libc_kill(pid: i32, sig: i32) {
    unsafe extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe { kill(pid, sig) };
}
