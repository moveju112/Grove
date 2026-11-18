//! 외부 편집기는 격리된 자식 시험 프로세스의 임시 PATH만 사용한다. 실제 GUI는 띄우지 않는다.
mod common;
#[path = "common/e2ee.rs"]
mod wire;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::json;

#[test]
fn external_editor_types_match_rust() {
    use ts_rs::TS;
    let want = format!(
        "// 이 파일은 tests/external_editor.rs에서 Rust 계약과 대조한다.\nexport {}\nexport {}\n",
        grove::external_editor::Editor::decl(), grove::external_editor::Listing::decl(),
    );
    assert_eq!(include_str!("../web/app/api/generated.externalEditor.ts"), want);
}

#[cfg(target_os = "linux")]
#[test]
fn isolated_pc_scenarios() {
    use std::os::unix::fs::PermissionsExt;
    for scenario in ["desktop", "wayland", "headless", "missing", "ssh", "public", "tls"] {
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("code");
        if scenario != "missing" {
            std::fs::write(&executable, "#!/bin/sh\nprintf '%s\\n' \"$#\" \"$1\" \"$PWD\" >> \"$EDITOR_RECORD\"\n").unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            // 실행 권한 없는 고정 후보와 고정 후보 밖 실행 파일은 발견하지 않는다.
            std::fs::write(dir.path().join("cursor"), "not executable").unwrap();
            std::fs::write(dir.path().join("custom-editor"), "#!/bin/sh\nexit 99\n").unwrap();
            std::fs::set_permissions(dir.path().join("custom-editor"), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "pc_fixture", "--ignored", "--nocapture"])
            .env("EDITOR_SCENARIO", scenario).env("PATH", dir.path())
            .env("EDITOR_RECORD", dir.path().join("record"))
            .env_remove("DISPLAY").env_remove("WAYLAND_DISPLAY").env_remove("SSH_CONNECTION").env_remove("SSH_TTY");
        if scenario == "wayland" { command.env("WAYLAND_DISPLAY", "wayland-fixture"); }
        else if scenario != "headless" { command.env("DISPLAY", ":fixture"); }
        if scenario == "ssh" { command.env("SSH_CONNECTION", "fixture"); }
        let output = command.output().unwrap();
        assert!(output.status.success(), "{scenario}\n{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "isolated_pc_scenarios가 격리된 환경으로 호출"]
async fn pc_fixture() {
    let scenario = std::env::var("EDITOR_SCENARIO").unwrap();
    let mut s = if matches!(scenario.as_str(), "public" | "tls") {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = config(&dir.path().join("data"));
        if scenario == "public" { cfg.listen = "0.0.0.0:0".parse().unwrap(); }
        if scenario == "tls" { cfg.tls_terminated = true; }
        let mut s = TestServer::start_with(dir, cfg).await;
        s.base = format!("http://127.0.0.1:{}", s.server.as_ref().unwrap().addr.port());
        s
    } else { TestServer::start().await };
    if matches!(scenario.as_str(), "public" | "tls") {
        // 공개 listener·TLS 종단의 API는 평문을 거절한다. 암호화 연결 안에서도
        // 외부 편집기의 로컬 PC 제한이 유지되는지 확인한다.
        assert_eq!(s.get("/api/v1/external-editors").await.0, StatusCode::UPGRADE_REQUIRED);
        let mut channel = wire::Channel::open(&s, None, None).await;
        let headers = || vec![
            ("authorization", format!("Bearer {}", s.token)),
            ("content-type", "application/json".into()),
            ("idempotency-key", s.key()),
        ];
        let unauthenticated = channel.request("GET", "/api/v1/external-editors", vec![], serde_json::Value::Null).await;
        assert_eq!(unauthenticated["status"], 401);
        channel.body().await;
        let root = s.make_project_dir("editor");
        std::fs::write(root.join("file.txt"), "keep me").unwrap();
        // 이 wire helper의 v1 연결은 요청 하나만 처리한다.
        let mut channel = wire::Channel::open(&s, None, None).await;
        let created = channel.request("POST", "/api/v1/projects", headers(), json!({"root_path":root})).await;
        assert_eq!(created["status"], 201, "{created}");
        let project: serde_json::Value = serde_json::from_slice(&channel.body().await).unwrap();
        let mut channel = wire::Channel::open(&s, None, None).await;
        let listing = channel.request("GET", "/api/v1/external-editors", headers(), serde_json::Value::Null).await;
        assert_eq!(listing["status"], 200, "{listing}");
        let listing: serde_json::Value = serde_json::from_slice(&channel.body().await).unwrap();
        assert_eq!(listing["available"], false);
        assert_eq!(listing["editors"], json!([]));
        assert!(listing["reason"].as_str().unwrap().contains("로컬"));
        let mut channel = wire::Channel::open(&s, None, None).await;
        let denied = channel.request("POST", &format!("/api/v1/projects/{}/external-editor", project["id"].as_str().unwrap()),
            headers(), json!({"editor_id":"vscode","path":"file.txt"})).await;
        assert_eq!(denied["status"], 403, "{denied}");
        channel.body().await;
        assert!(!std::path::PathBuf::from(std::env::var_os("EDITOR_RECORD").unwrap()).exists());
        s.stop().await;
        return;
    }
    let project = s.create_project("editor").await;
    let id = project["id"].as_str().unwrap();
    let root = std::path::PathBuf::from(project["root_path"].as_str().unwrap());
    let file = "-한 글;$(not-a-command).txt";
    std::fs::write(root.join(file), "keep me").unwrap();
    let route = format!("/api/v1/projects/{id}/external-editor");
    let body = json!({"editor_id":"vscode","path":file});

    let unauthenticated = s.raw(Method::GET, "/api/v1/external-editors", None, None, Some("")).await;
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
    let unauthenticated = s.raw(Method::POST, &route, Some(body.clone()), Some("unauthenticated"), Some("")).await;
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
    let (status, listing) = s.get("/api/v1/external-editors").await;
    assert_eq!(status, StatusCode::OK, "{listing}");
    let (_, health) = s.get("/api/v1/health").await;
    assert!(health["capabilities"].as_array().unwrap().iter().any(|v| v == "external_editor_v1"));
    if !matches!(scenario.as_str(), "desktop" | "wayland") {
        assert_eq!(listing["available"], false, "{listing}");
        assert_eq!(listing["editors"], json!([]));
        let reason = listing["reason"].as_str().unwrap();
        assert!(reason.contains(match scenario.as_str() { "missing" => "찾지 못", _ => "GUI" }), "{reason}");
        let (status, _) = s.post(&route, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!std::path::PathBuf::from(std::env::var_os("EDITOR_RECORD").unwrap()).exists());
        s.stop().await;
        return;
    }
    assert_eq!(listing, json!({"available":true,"reason":null,"editors":[{"id":"vscode","name":"VS Code"}]}));
    for (header, value) in [("x-forwarded-for", "127.0.0.1"), ("forwarded", "for=127.0.0.1"), ("user-agent", "Android Mobile"), ("user-agent", "iPad")] {
        let listing: serde_json::Value = s.client.get(format!("{}/api/v1/external-editors", s.base))
            .bearer_auth(&s.token).header(header, value).send().await.unwrap().json().await.unwrap();
        assert_eq!(listing["available"], false, "{listing}");
        let status = s.client.post(format!("{}{route}", s.base)).bearer_auth(&s.token)
            .header(header, value).header("idempotency-key", s.key()).json(&body).send().await.unwrap().status();
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    let outside = s.dir.path().join("outside");
    std::fs::write(&outside, "outside").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
    std::os::unix::fs::symlink(s.dir.path(), root.join("escape-dir")).unwrap();
    for bad in ["../outside", "escape", "escape-dir/outside", "/etc/passwd", ".", "missing", "a\\b", ""] {
        let (status, _) = s.post(&route, json!({"editor_id":"vscode","path":bad})).await;
        assert!(matches!(status, StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND), "{bad}: {status}");
    }
    let (status, _) = s.post(&route, json!({"editor_id":"/bin/sh","path":file})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = s.post(&route, json!({"editor_id":"vscode","path":file,"args":["--wait"]})).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, _) = s.send(Method::PUT, "/api/v1/settings/server/-/tools.mode", json!({"value":"read_only","expected_revision":0})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = s.post(&route, body.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = s.send(Method::PUT, "/api/v1/settings/server/-/tools.mode", json!({"value":"ask","expected_revision":1})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/settings/project/{id}/tools.mode"), json!({"value":"read_only","expected_revision":0})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = s.post(&route, body.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = s.send(Method::PUT, &format!("/api/v1/settings/project/{id}/tools.mode"), json!({"value":"ask","expected_revision":1})).await;
    assert_eq!(status, StatusCode::OK);
    let record = std::path::PathBuf::from(std::env::var_os("EDITOR_RECORD").unwrap());
    assert!(!record.exists(), "거절된 요청은 실행하지 않는다");

    let key = s.key();
    let response = s.raw(Method::POST, &route, Some(body.clone()), Some(&key), None).await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert_eq!(response.json::<serde_json::Value>().await.unwrap(), json!({"launched":true}));
    let expected = format!("1\n{}\n{}\n", root.join(file).display(), root.display());
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if std::fs::read_to_string(&record).is_ok_and(|value| value == expected) { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    for _ in 0..2 {
        let response = s.raw(Method::POST, &route, Some(body.clone()), Some(&key), None).await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(response.headers()["idempotent-replayed"], "true");
    }
    let conflicting = s.raw(Method::POST, &route, Some(json!({"editor_id":"vscode","path":"different.txt"})), Some(&key), None).await;
    assert_eq!(conflicting.status(), StatusCode::CONFLICT);
    assert_eq!(conflicting.json::<serde_json::Value>().await.unwrap()["error"]["code"], "idempotency_conflict");
    // 부작용 전에 접수 기록을 쓰지 못하면 실행하지 않는다.
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_editor BEFORE INSERT ON idempotency BEGIN SELECT RAISE(FAIL,'fixture editor accept'); END;").unwrap();
    let (status, _) = s.post(&route, body.clone()).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    db.execute_batch("DROP TRIGGER fail_editor").unwrap();
    assert_eq!(std::fs::read_to_string(&record).unwrap(), expected);
    // spawn 뒤 완료 기록 실패는 결과 불명으로 남기고 같은 키로 다시 실행하지 않는다.
    db.execute_batch("CREATE TRIGGER fail_editor BEFORE UPDATE ON idempotency BEGIN SELECT RAISE(FAIL,'fixture editor complete'); END;").unwrap();
    let unknown_key = s.key();
    let unknown = s.raw(Method::POST, &route, Some(body.clone()), Some(&unknown_key), None).await;
    assert_eq!(unknown.status(), StatusCode::CONFLICT);
    assert_eq!(unknown.json::<serde_json::Value>().await.unwrap()["error"]["code"], "result_unknown");
    db.execute_batch("DROP TRIGGER fail_editor").unwrap();
    let expected = expected.repeat(2);
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if std::fs::read_to_string(&record).is_ok_and(|value| value == expected) { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    for _ in 0..2 {
        let response = s.raw(Method::POST, &route, Some(body.clone()), Some(&unknown_key), None).await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(response.headers()["idempotent-replayed"], "true");
    }
    // 실행 파일을 깨뜨린 뒤에도 재전송은 실행하지 않고 원래 접수 결과를 돌려준다.
    let executable = std::env::split_paths(&std::env::var_os("PATH").unwrap()).next().unwrap().join("code");
    std::fs::write(&executable, "#!/nonexistent/fixture-interpreter\n").unwrap();
    let replay = s.raw(Method::POST, &route, Some(body.clone()), Some(&key), None).await;
    assert_eq!(replay.status(), StatusCode::ACCEPTED);
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    let (status, error) = s.post(&route, body.clone()).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "editor_launch_failed");
    assert_eq!(std::fs::read_to_string(record).unwrap(), expected);
    assert_eq!(std::fs::read_to_string(root.join(file)).unwrap(), "keep me");
    s.stop().await;
}
