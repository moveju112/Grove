//! 프로젝트 제거(보관)와 실제 디렉터리 삭제 분리(PROJECT-003).
mod common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::json;

/// PROJECT-001: 서버 폴더 둘러보기(폴더 이름만)와 새 폴더로 프로젝트 만들기.
#[tokio::test]
async fn browse_dirs_and_create_project_in_new_folder() {
    let s = TestServer::start().await;
    let base = s.make_project_dir("browse");
    std::fs::create_dir(base.join("alpha")).unwrap();
    std::fs::create_dir(base.join(".hidden")).unwrap();
    std::fs::write(base.join("file.txt"), "x").unwrap();
    let q = |p: &std::path::Path, extra: &str| format!("/api/v1/fs/dirs?path={}{extra}", urlencode(&p.to_string_lossy()));
    let (st, v) = s.get(&q(&base, "")).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let names: Vec<&str> = v["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["alpha"], "폴더만, 숨김 제외");
    assert_eq!(v["parent"].as_str().unwrap(), base.canonicalize().unwrap().parent().unwrap().to_str().unwrap());
    let (_, v) = s.get(&q(&base, "&hidden=true")).await;
    assert_eq!(v["entries"].as_array().unwrap().len(), 2);
    let (st, _) = s.get(&q(&base.join("nope"), "")).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, _) = s.get("/api/v1/fs/dirs?path=relative/dir").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let r = s.raw(Method::GET, &q(&base, ""), None, None, Some("bad-token")).await;
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED, "인증 필요");

    // 없는 경로: create 없이는 거부, create면 마지막 폴더 하나만 만든다
    let new = base.join("fresh");
    let (st, _) = s.post("/api/v1/projects", json!({ "root_path": new })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert!(!new.exists());
    let (st, v) = s.post("/api/v1/projects", json!({ "root_path": new, "create": true })).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    assert!(new.is_dir());
    assert_eq!(v["name"], "fresh");
    let deep = base.join("missing-parent").join("child");
    let (st, v) = s.post("/api/v1/projects", json!({ "root_path": deep, "create": true })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{v}");
    assert!(!base.join("missing-parent").exists(), "상위 폴더까지 만들지 않는다");
    // 이미 있는 폴더에 create를 줘도 그대로 등록한다
    let (st, _) = s.post("/api/v1/projects", json!({ "root_path": base.join("alpha"), "create": true })).await;
    assert_eq!(st, StatusCode::CREATED);
}

/// PROJECT-002: 아이콘 설정·해제와 이름순·최근 활동순 정렬.
#[tokio::test]
async fn project_icon_and_sort_by_recent_activity() {
    let s = TestServer::start().await;
    let a = s.create_project("aaa").await;
    let b = s.create_project("bbb").await;
    let (aid, bid) = (a["id"].as_str().unwrap().to_string(), b["id"].as_str().unwrap().to_string());
    assert!(a["icon"].is_null());
    let (st, v) = s.send(Method::PATCH, &format!("/api/v1/projects/{aid}"), json!({ "expected_revision": a["revision"], "icon": "🌱" })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["icon"], "🌱");
    assert_eq!(v["name"], "aaa", "이름은 그대로");
    let (st, _) = s.send(Method::PATCH, &format!("/api/v1/projects/{aid}"), json!({ "expected_revision": v["revision"], "icon": "123456789" })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "너무 긴 아이콘 거부");
    // icon 필드 없이 이름만 바꾸면 아이콘 유지, null이면 해제
    let (_, v) = s.send(Method::PATCH, &format!("/api/v1/projects/{aid}"), json!({ "expected_revision": v["revision"], "name": "aaa2" })).await;
    assert_eq!(v["icon"], "🌱");
    let (_, v) = s.send(Method::PATCH, &format!("/api/v1/projects/{aid}"), json!({ "expected_revision": v["revision"], "icon": null })).await;
    assert!(v["icon"].is_null(), "{v}");

    let order = |v: &serde_json::Value| v.as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    let (_, v) = s.get("/api/v1/projects?sort=name").await;
    assert_eq!(order(&v), vec![aid.clone(), bid.clone()]);
    // bbb에 대화 활동이 생기면 최근 활동순에서 앞
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    s.create_session(&bid).await;
    let (_, v) = s.get("/api/v1/projects?sort=recent").await;
    assert_eq!(order(&v), vec![bid.clone(), aid.clone()], "{v}");
    let pb = v.as_array().unwrap().iter().find(|p| p["id"] == bid.as_str()).unwrap();
    assert_ne!(pb["last_activity_at"], pb["updated_at"], "대화 활동 시각이 반영된다");
    let (st, _) = s.get("/api/v1/projects?sort=size").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

#[tokio::test]
async fn archive_removes_from_list_but_never_touches_directory() {
    let s = TestServer::start().await;
    let p = s.create_project("keep").await;
    let id = p["id"].as_str().unwrap().to_string();
    let root = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
    std::fs::write(root.join("important.txt"), "data").unwrap();
    let sid = s.create_session(&id).await["id"].as_str().unwrap().to_string();

    let (st, v) = s.send(Method::PATCH, &format!("/api/v1/projects/{id}"), json!({ "expected_revision": p["revision"], "archived": true })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    // 디렉터리·파일 그대로
    assert_eq!(std::fs::read_to_string(root.join("important.txt")).unwrap(), "data");
    // 목록에서 빠지고 보관 목록에 있음
    let (_, list) = s.get("/api/v1/projects").await;
    assert!(list.as_array().unwrap().iter().all(|x| x["id"] != id.as_str()));
    let (_, arch) = s.get("/api/v1/projects?archived=true").await;
    assert!(arch.as_array().unwrap().iter().any(|x| x["id"] == id.as_str()));
    // 보관 중에는 실행 요청을 받지 않는다
    let (st, _) = s.post(&format!("/api/v1/projects/{id}/sessions"), json!({})).await;
    assert!(st.is_client_error());
    // 같은 경로 재등록은 중복으로 거부(복원으로 되살린다)
    let (st, e) = s.post("/api/v1/projects", json!({ "root_path": root })).await;
    assert_eq!(st, StatusCode::CONFLICT, "{e}");
    // 복원하면 대화 이력도 그대로
    let (st, v) = s.send(Method::PATCH, &format!("/api/v1/projects/{id}"), json!({ "expected_revision": v["revision"], "archived": false })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let (st, sess) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    assert_eq!(st, StatusCode::OK);
    assert!(sess["archived_at"].is_null());
    // 디렉터리를 밖에서 지우면 프로젝트는 남고 사용 불가로 표시된다(서버가 지우거나 다시 만들지 않음)
    std::fs::remove_dir_all(&root).unwrap();
    let (_, pv) = s.get(&format!("/api/v1/projects/{id}")).await;
    assert_eq!(pv["available"], false);
    assert!(!root.exists());
}

#[tokio::test]
async fn permanent_session_delete_requires_archive_title_and_no_dependents() {
    use common::fixture::{self, Fixture};
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("del").await;
    let pid = p["id"].as_str().unwrap().to_string();
    let (_, sv) = s.post(&format!("/api/v1/projects/{pid}/sessions"), json!({ "title": "지울 대화" })).await;
    let sid = sv["id"].as_str().unwrap().to_string();
    f.push(fixture::text("답"));
    let (_, t) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({ "text": "질문", "profile_id": prof })).await;
    s.wait_status(t["turn"]["id"].as_str().unwrap(), "completed").await;
    s.post(&format!("/api/v1/sessions/{sid}/goals"), json!({ "title": "g" })).await;
    s.post("/api/v1/recent/touch", json!({ "kind": "session", "project_id": pid, "resource_id": sid })).await;
    s.send(Method::PUT, &format!("/api/v1/drafts/session:{sid}"), json!({ "expected_revision": 0, "text": "초안", "device_name": "t" })).await;
    // 분기 대화
    let (_, fork) = s.post(&format!("/api/v1/sessions/{sid}/fork"), json!({ "from_seq": 1, "inherit_context": true })).await;
    let fid = fork["id"].as_str().unwrap().to_string();

    let del = |id: String, title: &'static str| {
        let s = &s;
        async move {
            let (_, cur) = s.get(&format!("/api/v1/sessions/{id}")).await;
            s.post(&format!("/api/v1/sessions/{id}/delete"), json!({ "expected_revision": cur["revision"], "confirm_title": title })).await
        }
    };
    let archive = |id: String| {
        let s = &s;
        async move {
            let (_, cur) = s.get(&format!("/api/v1/sessions/{id}")).await;
            s.send(Method::PATCH, &format!("/api/v1/sessions/{id}"), json!({ "expected_revision": cur["revision"], "archived": true })).await
        }
    };
    let (st, e) = del(sid.clone(), "지울 대화").await;
    assert_eq!((st, e["error"]["code"].clone()), (StatusCode::CONFLICT, json!("not_archived")));
    archive(sid.clone()).await;
    let (st, _) = del(sid.clone(), "다른 제목").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, e) = del(sid.clone(), "지울 대화").await;
    assert_eq!(e["error"]["details"]["reason"], "forks", "{st} {e}");
    // 분기 대화 먼저 삭제
    archive(fid.clone()).await;
    let ftitle: &'static str = Box::leak(fork["title"].as_str().unwrap().to_string().into_boxed_str());
    let (st, e) = del(fid.clone(), ftitle).await;
    assert_eq!(st, StatusCode::OK, "{e}");
    let (st, e) = del(sid.clone(), "지울 대화").await;
    assert_eq!(st, StatusCode::OK, "{e}");
    let (st, _) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (_, hits) = s.get("/api/v1/sessions/search?q=%EC%A7%88%EB%AC%B8&body=true&status=archived").await;
    assert_eq!(hits["total"], 0);
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    for (table, col) in [("messages", "session_id"), ("turns", "session_id"), ("tool_calls", "session_id"), ("goals", "session_id"), ("events", "session_id"), ("recent_items", "resource_id")] {
        let n: i64 = db.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE {col} = ?1"), [&sid], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "{table}에 남음");
    }
    let n: i64 = db.query_row("SELECT COUNT(*) FROM drafts WHERE resource_key = ?1", [format!("session:{sid}")], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
    let ok: String = db.query_row("PRAGMA foreign_key_check", [], |r| r.get(0)).unwrap_or_else(|_| "ok".into());
    assert_eq!(ok, "ok");
}

#[tokio::test]
async fn relink_moved_folder_keeps_history_and_rejects_conflicts() {
    let s = TestServer::start().await;
    let p = s.create_project("old").await;
    let other = s.create_project("other").await;
    let id = p["id"].as_str().unwrap().to_string();
    let sid = s.create_session(&id).await["id"].as_str().unwrap().to_string();
    let old = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
    let moved = s.dir.path().join("projects").join("moved");
    std::fs::rename(&old, &moved).unwrap();
    let (_, pv) = s.get(&format!("/api/v1/projects/{id}")).await;
    assert_eq!(pv["available"], false);
    // 실행 요청은 거부(경로 없음)
    let (st, _) = s.post(&format!("/api/v1/projects/{id}/sessions"), json!({})).await;
    assert_eq!(st, StatusCode::GONE);
    // 없는 경로·다른 프로젝트 경로·오래된 revision 거부
    let (st, _) = s.send(Method::PATCH, &format!("/api/v1/projects/{id}"), json!({ "expected_revision": pv["revision"], "root_path": "/no/such/dir" })).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, e) = s.send(Method::PATCH, &format!("/api/v1/projects/{id}"), json!({ "expected_revision": pv["revision"], "root_path": other["root_path"] })).await;
    assert_eq!((st, e["error"]["code"].clone()), (StatusCode::CONFLICT, json!("already_exists")));
    // 다시 연결
    let (st, v) = s.send(Method::PATCH, &format!("/api/v1/projects/{id}"), json!({ "expected_revision": pv["revision"], "root_path": moved })).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["available"], true);
    assert_eq!(v["root_path"], std::fs::canonicalize(&moved).unwrap().to_string_lossy().as_ref());
    let (st, _) = s.get(&format!("/api/v1/sessions/{sid}")).await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = s.post(&format!("/api/v1/projects/{id}/sessions"), json!({})).await;
    assert_eq!(st, StatusCode::CREATED);
}
