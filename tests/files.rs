//! 파일 탐색·편집 API(FILEUI-001~006, 012).
mod common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::json;

async fn setup() -> (TestServer, String, std::path::PathBuf) {
    let s = TestServer::start().await;
    let p = s.create_project("f").await;
    let root = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
    (s, p["id"].as_str().unwrap().to_string(), root)
}

#[tokio::test]
async fn list_sorts_dirs_first_hides_dotfiles_and_blocks_escape() {
    let (s, pid, root) = setup().await;
    std::fs::create_dir(root.join("zdir")).unwrap();
    std::fs::write(root.join("b.txt"), "b").unwrap();
    std::fs::write(root.join("A.txt"), "aaa").unwrap();
    std::fs::write(root.join(".env"), "SECRET=1").unwrap();
    let outside = s.dir.path().join("outside.txt");
    std::fs::write(&outside, "x").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
    let (st, v) = s.get(&format!("/api/v1/projects/{pid}/files")).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let names: Vec<&str> = v["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert_eq!(&names[..3], ["zdir", "A.txt", "b.txt"], "폴더 먼저, 이름은 대소문자 무시: {names:?}");
    assert!(!names.contains(&".env"));
    #[cfg(unix)]
    assert_eq!(v["entries"].as_array().unwrap().iter().find(|e| e["name"] == "link").unwrap()["kind"], "link_outside");
    let (_, v) = s.get(&format!("/api/v1/projects/{pid}/files?hidden=true&sort=size")).await;
    assert!(v["entries"].as_array().unwrap().iter().any(|e| e["name"] == ".env"));
    for bad in ["../", "/etc", "link"] {
        let (st, _) = s.get(&format!("/api/v1/projects/{pid}/files/content?path={bad}")).await;
        assert!(st == StatusCode::BAD_REQUEST, "{bad}: {st}");
    }
}

#[tokio::test]
async fn save_detects_external_change_and_converges_on_replay() {
    let (s, pid, root) = setup().await;
    std::fs::write(root.join("a.md"), "one\n").unwrap();
    let (_, c) = s.get(&format!("/api/v1/projects/{pid}/files/content?path=a.md")).await;
    assert_eq!(c["text"], "one\n");
    let sha = c["sha256"].as_str().unwrap().to_string();
    let body = json!({ "path": "a.md", "expected_sha256": sha, "text": "two\n" });
    let (st, v) = s.send(Method::PUT, &format!("/api/v1/projects/{pid}/files/content"), body.clone()).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["changed"], true);
    // 같은 요청 재전송: 이미 반영됐으므로 성공
    let (st, v) = s.send(Method::PUT, &format!("/api/v1/projects/{pid}/files/content"), body).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["changed"], false);
    // 외부 변경 뒤 오래된 sha로 저장 → 충돌, 파일 보존
    std::fs::write(root.join("a.md"), "external\n").unwrap();
    let (st, v) = s.send(Method::PUT, &format!("/api/v1/projects/{pid}/files/content"), json!({ "path": "a.md", "expected_sha256": sha, "text": "mine\n" })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["code"], "file_changed");
    assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "external\n");
    // 새 파일 생성은 expected null, 이미 있으면 거부
    let (st, _) = s.send(Method::PUT, &format!("/api/v1/projects/{pid}/files/content"), json!({ "path": "new.md", "expected_sha256": null, "text": "n" })).await;
    assert_eq!(st, StatusCode::OK);
    let (st, v) = s.send(Method::PUT, &format!("/api/v1/projects/{pid}/files/content"), json!({ "path": "new.md", "expected_sha256": null, "text": "other" })).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"]["code"], "already_exists");
    // binary는 편집기 텍스트로 열지 않는다
    std::fs::write(root.join("b.bin"), [0u8, 159, 146, 150]).unwrap();
    let (_, c) = s.get(&format!("/api/v1/projects/{pid}/files/content?path=b.bin")).await;
    assert!(c["text"].is_null());
    assert_eq!(c["reason"], "binary");
}

#[tokio::test]
async fn file_mutation_receipts_survive_database_failures_without_reexecution() {
    for op in ["save", "mkdir", "rename", "duplicate"] {
        for fault in ["accept", "accept_commit", "complete", "event", "commit"] {
            let (mut s, pid, root) = setup().await;
            std::fs::write(root.join("a.txt"), "before\n").unwrap();
            let (method, route, body) = if op == "save" {
                (Method::PUT, "content", json!({"path":"a.txt","expected_sha256":grove::util::sha256_hex(b"before\n"),"text":"after\n"}))
            } else {
                (Method::POST, "op", if op == "mkdir" { json!({"op":op,"path":"new"}) } else { json!({"op":op,"path":"a.txt","to":"new"}) })
            };
            let path = format!("/api/v1/projects/{pid}/files/{route}");
            let key = s.key();
            let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
            let sql = match fault {
                "accept" => "CREATE TRIGGER fail_file BEFORE INSERT ON idempotency BEGIN SELECT RAISE(FAIL,'fixture file accept'); END;",
                "accept_commit" => "CREATE TABLE fixture_failed_commit (project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_file AFTER INSERT ON idempotency BEGIN INSERT INTO fixture_failed_commit VALUES ('missing-fixture-project'); END;",
                "complete" => "CREATE TRIGGER fail_file BEFORE UPDATE ON idempotency BEGIN SELECT RAISE(FAIL,'fixture file complete'); END;",
                "event" => "CREATE TRIGGER fail_file BEFORE INSERT ON events WHEN NEW.kind='file.changed' BEGIN SELECT RAISE(FAIL,'fixture file event'); END;",
                _ => "CREATE TABLE fixture_failed_commit (project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_file AFTER UPDATE ON idempotency BEGIN INSERT INTO fixture_failed_commit VALUES ('missing-fixture-project'); END;",
            };
            db.execute_batch(sql).unwrap();
            let response = s.raw(method.clone(), &path, Some(body.clone()), Some(&key), None).await;
            let accepted = fault != "accept" && fault != "accept_commit";
            assert_eq!(response.status(), if accepted { StatusCode::CONFLICT } else { StatusCode::INTERNAL_SERVER_ERROR }, "{op}/{fault}");
            let mut interrupted_stage = None;
            if accepted {
                let unknown = response.json::<serde_json::Value>().await.unwrap();
                assert_eq!(unknown["error"]["code"], "result_unknown");
                if op == "duplicate" {
                    let name = unknown["error"]["details"]["staging"].as_str().unwrap();
                    assert!(name.starts_with(".grove-copy-") && !name.contains(['/', '\\']));
                    let stage = root.join(name);
                    assert!(!stage.exists());
                    // 접수 이후 복사 중 중단된 디스크 상태도 같은 receipt가 보존한다.
                    std::fs::create_dir(&stage).unwrap();
                    std::fs::write(stage.join("payload"), "partial copy").unwrap();
                    interrupted_stage = Some(stage);
                }
                assert_eq!(db.query_row("SELECT status FROM idempotency WHERE key=?1", [&key], |r| r.get::<_,i64>(0)).unwrap(), 409);
            } else {
                assert_eq!(db.query_row("SELECT COUNT(*) FROM idempotency WHERE key=?1", [&key], |r| r.get::<_,i64>(0)).unwrap(), 0);
            }
            assert_eq!(db.query_row("SELECT COUNT(*) FROM events WHERE kind='file.changed'", [], |r| r.get::<_,i64>(0)).unwrap(), 0);
            match op {
                "save" => assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), if accepted { "after\n" } else { "before\n" }),
                "mkdir" => assert_eq!(root.join("new").is_dir(), accepted),
                "rename" => {
                    assert_eq!(root.join("a.txt").exists(), !accepted);
                    assert_eq!(root.join("new").exists(), accepted);
                }
                _ => {
                    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "before\n");
                    assert_eq!(root.join("new").exists(), accepted);
                }
            }
            db.execute_batch("DROP TRIGGER fail_file").unwrap();
            if accepted {
                s.restart().await;
                // 이 시험이 만든 결과만 되돌려, 같은 키가 실행 가능한 상태여도 재실행하지 않는지 확인한다.
                match op {
                    "save" => std::fs::write(root.join("a.txt"), "before\n").unwrap(),
                    "mkdir" => std::fs::remove_dir(root.join("new")).unwrap(),
                    "rename" => std::fs::rename(root.join("new"), root.join("a.txt")).unwrap(),
                    _ => std::fs::remove_file(root.join("new")).unwrap(),
                }
                let response = s.raw(method, &path, Some(body), Some(&key), None).await;
                assert_eq!(response.status(), StatusCode::CONFLICT);
                assert_eq!(response.headers()["idempotent-replayed"], "true");
                assert_eq!(response.json::<serde_json::Value>().await.unwrap()["error"]["code"], "result_unknown");
                assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "before\n");
                assert!(!root.join("new").exists());
                if let Some(stage) = interrupted_stage {
                    let app = s.server.as_ref().unwrap().app.clone();
                    tokio::task::spawn_blocking(move || grove::storage::gc(&app)).await.unwrap().unwrap();
                    assert_eq!(std::fs::read(stage.join("payload")).unwrap(), b"partial copy", "미확정 복제 원문은 자동 정리하지 않는다");
                }
            }
        }
    }
}

#[tokio::test]
async fn file_mutations_require_keys_and_replay_before_revalidating_changed_paths() {
    for op in ["save", "mkdir", "rename", "duplicate"] {
        let (mut s, pid, root) = setup().await;
        std::fs::write(root.join("a.txt"), "before\n").unwrap();
        let (method, route, body, target) = if op == "save" {
            (Method::PUT, "content", json!({"path":"a.txt","expected_sha256":grove::util::sha256_hex(b"before\n"),"text":"after\n"}), "a.txt")
        } else {
            (Method::POST, "op", if op == "mkdir" { json!({"op":op,"path":"new"}) } else { json!({"op":op,"path":"a.txt","to":"new"}) }, "new")
        };
        let path = format!("/api/v1/projects/{pid}/files/{route}");
        let missing = s.raw(method.clone(), &path, Some(body.clone()), None, None).await;
        assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
        assert_eq!(std::fs::read(root.join("a.txt")).unwrap(), b"before\n");
        assert!(!root.join("new").exists());
        let key = s.key();
        let (first, concurrent) = tokio::join!(
            s.raw(method.clone(), &path, Some(body.clone()), Some(&key), None),
            s.raw(method.clone(), &path, Some(body.clone()), Some(&key), None)
        );
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(concurrent.status(), StatusCode::OK);
        assert_eq!(usize::from(first.headers().contains_key("idempotent-replayed")) + usize::from(concurrent.headers().contains_key("idempotent-replayed")), 1);
        let first = first.json::<serde_json::Value>().await.unwrap();
        assert_eq!(concurrent.json::<serde_json::Value>().await.unwrap(), first);
        if op == "mkdir" { std::fs::remove_dir(root.join(target)).unwrap(); }
        std::fs::write(root.join(target), "user edit\n").unwrap();
        s.restart().await;
        let replay = s.raw(method.clone(), &path, Some(body.clone()), Some(&key), None).await;
        assert_eq!(replay.status(), StatusCode::OK);
        assert_eq!(replay.headers()["idempotent-replayed"], "true");
        assert_eq!(replay.json::<serde_json::Value>().await.unwrap(), first);
        assert_eq!(std::fs::read(root.join(target)).unwrap(), b"user edit\n");
        let mut different = body;
        different["path"] = json!("other");
        let response = s.raw(method, &path, Some(different), Some(&key), None).await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(response.json::<serde_json::Value>().await.unwrap()["error"]["code"], "idempotency_conflict");
        let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
        assert_eq!(db.query_row("SELECT COUNT(*) FROM events WHERE kind='file.changed'", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
        assert!(!root.join("other").exists());
    }
}

#[tokio::test]
async fn ops_need_confirmation_never_overwrite_and_delete_goes_to_trash() {
    let (s, pid, root) = setup().await;
    let op = |b: serde_json::Value| (format!("/api/v1/projects/{pid}/files/op"), b);
    let (p, b) = op(json!({ "op": "mkdir", "path": "d" }));
    assert_eq!(s.post(&p, b).await.0, StatusCode::OK);
    std::fs::write(root.join("d/x.txt"), "x").unwrap();
    std::fs::write(root.join("y.txt"), "y").unwrap();
    let (p, b) = op(json!({ "op": "rename", "path": "y.txt", "to": "d/x.txt" }));
    let (st, _) = s.post(&p, b).await;
    assert_eq!(st, StatusCode::CONFLICT, "덮어쓰지 않는다");
    assert_eq!(std::fs::read_to_string(root.join("d/x.txt")).unwrap(), "x");
    let (p, b) = op(json!({ "op": "duplicate", "path": "d", "to": "d2" }));
    assert_eq!(s.post(&p, b).await.0, StatusCode::OK);
    assert_eq!(std::fs::read_to_string(root.join("d2/x.txt")).unwrap(), "x");
    let (p, b) = op(json!({ "op": "duplicate", "path": "d", "to": "d/inner" }));
    assert_eq!(s.post(&p, b).await.0, StatusCode::BAD_REQUEST);
    let (p, b) = op(json!({ "op": "rename", "path": "y.txt", "to": "z.txt" }));
    assert_eq!(s.post(&p, b).await.0, StatusCode::OK);
    // 삭제: 확인 문구 불일치 → 거부
    let (p, b) = op(json!({ "op": "delete", "path": "d2", "confirm": "d" }));
    let (st, v) = s.post(&p, b).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"]["code"], "confirmation_required");
    assert!(root.join("d2").exists());
    let (p, b) = op(json!({ "op": "delete", "path": ".", "confirm": "." }));
    assert_eq!(s.post(&p, b).await.0, StatusCode::BAD_REQUEST);
    let (p, b) = op(json!({ "op": "delete", "path": "d2", "confirm": "d2" }));
    let (st, v) = s.post(&p, b).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert!(!root.join("d2").exists());
    let trash = s.data_dir().join("trash").join(v["trash"].as_str().unwrap());
    assert_eq!(std::fs::read_to_string(trash.join("payload/x.txt")).unwrap(), "x", "휴지통에서 복구 가능");
    assert!(std::fs::read_to_string(trash.join("origin.json")).unwrap().contains("\"d2\""));
}

/// FILEUI-005: 업로드는 덮어쓰지 않고 내용 hash를 확인하며, 응답을 잃은 뒤 원문 없이 같은 키로 결과를 확인한다.
#[tokio::test]
async fn upload_never_overwrites_checks_hash_and_replays_without_the_original() {
    use base64::Engine;
    let (s, pid, root) = setup().await;
    let url = format!("/api/v1/projects/{pid}/files/upload");
    let post = |body: serde_json::Value, key: &'static str| {
        let (s, url) = (&s, url.clone());
        async move {
            let r = s.raw(Method::POST, &url, Some(body), Some(key), None).await;
            let st = r.status();
            (st, r.json::<serde_json::Value>().await.unwrap_or_default())
        }
    };
    let bytes: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let sha = grove::util::sha256_hex(&bytes);
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    std::fs::create_dir(root.join("in")).unwrap();
    let (st, v) = post(json!({ "path": "in/a.bin", "sha256": sha, "data_base64": data }), "up-1").await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v, json!({ "op": "upload", "path": "in/a.bin", "sha256": sha, "bytes": 200_000 }));
    assert_eq!(std::fs::read(root.join("in/a.bin")).unwrap(), bytes);
    // 응답 유실 뒤 새로고침: 원문 없이 같은 키로 물으면 저장된 결과
    let (st, again) = post(json!({ "path": "in/a.bin", "sha256": sha }), "up-1").await;
    assert_eq!((st, &again), (StatusCode::OK, &v));
    // 다른 키로 같은 경로 → 덮어쓰지 않는다
    let other = base64::engine::general_purpose::STANDARD.encode(b"other");
    let (st, e) = post(json!({ "path": "in/a.bin", "sha256": grove::util::sha256_hex(b"other"), "data_base64": other }), "up-2").await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(e["error"]["code"], "already_exists");
    assert_eq!(std::fs::read(root.join("in/a.bin")).unwrap(), bytes);
    // 결과 기록이 없는 키를 원문 없이 물으면 실행하지 않고 다시 고르게 한다
    let (st, e) = post(json!({ "path": "in/b.bin", "sha256": sha }), "up-3").await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(e["error"]["code"], "upload_data_required");
    assert!(!root.join("in/b.bin").exists());
    // 내용이 hash와 다르면 거부, 상위 폴더 없음·프로젝트 밖 경로 거부
    let (st, _) = post(json!({ "path": "in/c.bin", "sha256": sha, "data_base64": other }), "up-4").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = post(json!({ "path": "none/c.bin", "sha256": sha, "data_base64": data }), "up-5").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = post(json!({ "path": "../c.bin", "sha256": sha, "data_base64": data }), "up-6").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    // 상한(5MiB)을 넘으면 413과 한도
    let big = vec![7u8; 5 * 1024 * 1024 + 1];
    let (st, e) = post(json!({ "path": "in/big.bin", "sha256": grove::util::sha256_hex(&big), "data_base64": base64::engine::general_purpose::STANDARD.encode(&big) }), "up-7").await;
    assert_eq!(st, StatusCode::PAYLOAD_TOO_LARGE, "{e}");
    assert_eq!(e["error"]["details"]["limit"], 5 * 1024 * 1024);
    assert!(!root.join("in/big.bin").exists());
    // 임시 파일이 남지 않는다
    let names: Vec<String> = std::fs::read_dir(root.join("in")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    assert_eq!(names, ["a.bin"]);
}

/// FILEUI-005: 내려받기는 미리보기 상한(32MiB)보다 큰 파일도 길이를 밝혀 흘려보낸다.
#[tokio::test]
async fn download_streams_files_larger_than_the_preview_limit() {
    let (s, pid, root) = setup().await;
    let size = 33 * 1024 * 1024 + 123;
    let f = std::fs::File::create(root.join("big.bin")).unwrap();
    f.set_len(size).unwrap();
    drop(f);
    let r = s.raw(Method::GET, &format!("/api/v1/projects/{pid}/files/raw?path=big.bin"), None, None, None).await;
    assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE, "미리보기는 상한 유지");
    let r = s.raw(Method::GET, &format!("/api/v1/projects/{pid}/files/raw?path=big.bin&download=true"), None, None, None).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers().get("content-length").unwrap(), &size.to_string());
    let body = r.bytes().await.unwrap();
    assert_eq!(body.len() as u64, size);
    assert!(body.iter().all(|b| *b == 0));
}

#[tokio::test]
async fn raw_preview_is_sandboxed_and_html_is_not_rendered() {
    let (s, pid, root) = setup().await;
    std::fs::write(root.join("p.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>").unwrap();
    std::fs::write(root.join("x.html"), "<script>alert(1)</script>").unwrap();
    std::fs::write(root.join("한글.png"), [137u8, 80, 78, 71]).unwrap();
    let r = s.raw(Method::GET, &format!("/api/v1/projects/{pid}/files/raw?path=p.svg"), None, None, None).await;
    assert_eq!(r.status(), StatusCode::OK);
    let csp = r.headers().get("content-security-policy").unwrap().to_str().unwrap().to_string();
    assert!(csp.starts_with("sandbox") && csp.contains("default-src 'none'"), "{csp}");
    assert_eq!(r.headers().get("x-content-type-options").unwrap(), "nosniff");
    let r = s.raw(Method::GET, &format!("/api/v1/projects/{pid}/files/raw?path=x.html"), None, None, None).await;
    assert!(r.headers().get("content-type").unwrap().to_str().unwrap().starts_with("text/plain"), "HTML은 렌더하지 않는다");
    let r = s.raw(Method::GET, &format!("/api/v1/projects/{pid}/files/raw?path=%ED%95%9C%EA%B8%80.png&download=true"), None, None, None).await;
    assert_eq!(r.headers().get("content-type").unwrap(), "image/png");
    let disp = r.headers().get("content-disposition").unwrap().to_str().unwrap().to_string();
    assert!(disp.starts_with("attachment; filename*=UTF-8''%ED%95%9C"), "{disp}");
    // 인증 없이는 거부
    let r = reqwest::get(format!("{}/api/v1/projects/{pid}/files/raw?path=p.svg", s.base)).await.unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    // 티켓: 인증 헤더 없이 그 파일 하나만 연다
    let (st, t) = s.post(&format!("/api/v1/projects/{pid}/files/ticket"), json!({ "path": "p.svg" })).await;
    assert_eq!(st, StatusCode::OK, "{t}");
    let url = format!("{}{}", s.base, t["url"].as_str().unwrap());
    let r = reqwest::get(&url).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert!(r.headers().get("content-security-policy").unwrap().to_str().unwrap().starts_with("sandbox"));
    assert!(r.text().await.unwrap().contains("<svg"));
    let r = reqwest::get(format!("{}/api/v1/file-tickets/forged", s.base)).await.unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    let (st, _) = s.post(&format!("/api/v1/projects/{pid}/files/ticket"), json!({ "path": "../x" })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}
