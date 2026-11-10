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
    assert_eq!(std::fs::read_to_string(trash.join("d2/x.txt")).unwrap(), "x", "휴지통에서 복구 가능");
    assert!(std::fs::read_to_string(trash.join("origin.json")).unwrap().contains("\"d2\""));
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
