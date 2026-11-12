//! 휴지통 복원·영구 삭제와 저장 공간 정리(DB-013·014·018·019).
mod common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::time::{Duration, SystemTime};

fn age(p: &std::path::Path, d: Duration) {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    options.write(true);
    options
        .open(p)
        .unwrap()
        .set_modified(SystemTime::now() - d)
        .unwrap();
}

async fn gc(s: &TestServer) -> Value {
    let app = s.server.as_ref().unwrap().app.clone();
    tokio::task::spawn_blocking(move || grove::storage::gc(&app))
        .await
        .unwrap()
        .unwrap()
}

/// 사용자 직접 도구 요청을 승인하고 끝날 때까지 기다린다.
async fn run_tool(s: &TestServer, sid: &str, name: &str, args: Value) {
    let (_, c) = s
        .post(
            &format!("/api/v1/sessions/{sid}/tool-requests"),
            json!({ "name": name, "args": args }),
        )
        .await;
    let id = c["id"].as_str().unwrap().to_string();
    s.post(
        &format!("/api/v1/tool-calls/{id}/decision"),
        json!({ "decision": "approve", "expected_revision": c["revision"] }),
    )
    .await;
    for _ in 0..200 {
        let (_, c) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
        if c["status"] == "succeeded" {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("도구 실행이 끝나지 않음");
}

#[tokio::test]
async fn trash_restore_and_permanent_delete() {
    let s = TestServer::start().await;
    let p = s.create_project("tr").await;
    let (pid, root) = (
        p["id"].as_str().unwrap().to_string(),
        p["root_path"].as_str().unwrap().to_string(),
    );
    std::fs::write(format!("{root}/a.txt"), "원본").unwrap();
    let (st, v) = s
        .post(
            &format!("/api/v1/projects/{pid}/files/op"),
            json!({ "op": "delete", "path": "a.txt", "confirm": "a.txt" }),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let (_, t) = s.get(&format!("/api/v1/projects/{pid}/trash")).await;
    let items = t["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["path"], "a.txt");
    assert!(items[0]["deleted_at"].is_string());
    let tid = items[0]["id"].as_str().unwrap().to_string();
    // 같은 이름 파일이 생기면 덮어쓰지 않는다
    std::fs::write(format!("{root}/a.txt"), "새 파일").unwrap();
    let (st, _) = s
        .post(&format!("/api/v1/trash/{tid}/restore"), json!({}))
        .await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(
        std::fs::read_to_string(format!("{root}/a.txt")).unwrap(),
        "새 파일"
    );
    std::fs::remove_file(format!("{root}/a.txt")).unwrap();
    let (st, _) = s
        .post(&format!("/api/v1/trash/{tid}/restore"), json!({}))
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(
        std::fs::read_to_string(format!("{root}/a.txt")).unwrap(),
        "원본"
    );
    let (_, t) = s.get(&format!("/api/v1/projects/{pid}/trash")).await;
    assert!(t["items"].as_array().unwrap().is_empty());
    // 다시 지우고 영구 삭제: 확인 문구가 다르면 거부
    s.post(
        &format!("/api/v1/projects/{pid}/files/op"),
        json!({ "op": "delete", "path": "a.txt", "confirm": "a.txt" }),
    )
    .await;
    let (_, t) = s.get(&format!("/api/v1/projects/{pid}/trash")).await;
    let tid = t["items"][0]["id"].as_str().unwrap().to_string();
    let (st, _) = s
        .post(
            &format!("/api/v1/trash/{tid}/delete"),
            json!({ "confirm": "b.txt" }),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = s
        .post(
            &format!("/api/v1/trash/{tid}/delete"),
            json!({ "confirm": "a.txt" }),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let (_, t) = s.get(&format!("/api/v1/projects/{pid}/trash")).await;
    assert!(t["items"].as_array().unwrap().is_empty());
    // 경로 탈출 ID 거부
    let (st, _) = s
        .post("/api/v1/trash/..%2Fgrove.db/restore", json!({}))
        .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn gc_removes_only_unreferenced_or_expired_and_marks_missing_blobs() {
    let s = TestServer::start().await;
    let p = s.create_project("gc").await;
    let pid = p["id"].as_str().unwrap().to_string();
    let root = p["root_path"].as_str().unwrap().to_string();
    let sid = s.create_session(&pid).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    run_tool(
        &s,
        &sid,
        "write",
        json!({ "path": "k.txt", "content": "keep\n" }),
    )
    .await;
    run_tool(
        &s,
        &sid,
        "edit",
        json!({ "path": "k.txt", "old_string": "keep", "new_string": "kept" }),
    )
    .await;
    let dd = s.data_dir();
    let blobs: Vec<std::path::PathBuf> = std::fs::read_dir(dd.join("blobs"))
        .unwrap()
        .flatten()
        .flat_map(|d| {
            std::fs::read_dir(d.path())
                .unwrap()
                .flatten()
                .map(|f| f.path())
        })
        .collect();
    assert_eq!(blobs.len(), 2, "keep·kept 두 blob");
    for b in &blobs {
        age(b, Duration::from_secs(7200));
    }
    // 참조 없는 blob: 유예 안이면 유지, 지나면 정리
    let orphan_new = dd.join("blobs").join("aa").join("a".repeat(64));
    let orphan_old = dd.join("blobs").join("bb").join("b".repeat(64));
    for o in [&orphan_new, &orphan_old] {
        std::fs::create_dir_all(o.parent().unwrap()).unwrap();
        std::fs::write(o, "x").unwrap();
    }
    age(&orphan_old, Duration::from_secs(7200));
    // 기록 없는 작업 로그
    std::fs::create_dir_all(dd.join("tasks")).unwrap();
    std::fs::write(dd.join("tasks").join("no-such-task.out"), "log").unwrap();
    let r = gc(&s).await;
    assert_eq!(r["blobs_removed"], 1, "{r}");
    assert_eq!(r["task_logs_removed"], 1, "{r}");
    assert!(orphan_new.exists() && !orphan_old.exists());
    assert!(blobs.iter().all(|b| b.exists()), "참조된 blob은 유지");

    // 참조된 blob이 사라지면 그 변경은 보관 안 됨으로 바뀌어 되돌리기를 막는다
    std::fs::remove_file(&blobs[0]).unwrap();
    let r = gc(&s).await;
    assert!(r["changes_marked_unstored"].as_u64().unwrap() >= 1, "{r}");
    let (_, ch) = s.get(&format!("/api/v1/sessions/{sid}/file-changes")).await;
    assert!(
        ch.as_array().unwrap().iter().any(|c| c["stored"] == false),
        "{ch}"
    );
    let ids: Vec<Value> = ch
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["stored"] == false)
        .map(|c| c["id"].clone())
        .collect();
    let (st, _) = s
        .post(
            &format!("/api/v1/sessions/{sid}/file-changes/undo"),
            json!({ "change_ids": ids }),
        )
        .await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(
        std::fs::read_to_string(format!("{root}/k.txt")).unwrap(),
        "kept\n"
    );

    // 휴지통 보존 기간: 기본 0이면 오래돼도 유지, 설정하면 넘은 항목만 정리
    std::fs::write(format!("{root}/old.txt"), "o").unwrap();
    s.post(
        &format!("/api/v1/projects/{pid}/files/op"),
        json!({ "op": "delete", "path": "old.txt", "confirm": "old.txt" }),
    )
    .await;
    let (_, t) = s.get(&format!("/api/v1/projects/{pid}/trash")).await;
    let tdir = dd.join("trash").join(t["items"][0]["id"].as_str().unwrap());
    age(&tdir, Duration::from_secs(3 * 86_400));
    let mut origin: Value =
        serde_json::from_slice(&std::fs::read(tdir.join("origin.json")).unwrap()).unwrap();
    origin["deleted_at"] = json!(grove::util::fmt_time(
        time::OffsetDateTime::now_utc() - time::Duration::days(3)
    ));
    std::fs::write(tdir.join("origin.json"), origin.to_string()).unwrap();
    assert_eq!(gc(&s).await["trash_removed"], 0);
    assert!(tdir.exists());
    let (st, v) = s
        .send(
            Method::PUT,
            "/api/v1/settings/server/-/storage.trash_retention_days",
            json!({ "expected_revision": 0, "value": 2 }),
        )
        .await;
    assert!(st.is_success(), "{v}");
    assert_eq!(gc(&s).await["trash_removed"], 1);
    assert!(!tdir.exists());
}

#[tokio::test]
async fn trash_keeps_metadata_names_and_replays_mutations() {
    let s = TestServer::start().await;
    let p = s.create_project("metadata").await;
    let pid = p["id"].as_str().unwrap();
    let root = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
    for name in ["origin.json", "payload", "한글 폴더"] {
        std::fs::write(root.join(name), "원본").unwrap();
        let path = format!("/api/v1/projects/{pid}/files/op");
        let body = json!({ "op": "delete", "path": name, "confirm": name });
        let key = s.key();
        let r = s
            .raw(Method::POST, &path, Some(body.clone()), Some(&key), None)
            .await;
        assert_eq!(r.status(), StatusCode::OK);
        let first: Value = r.json().await.unwrap();
        std::fs::write(root.join(name), "새 파일").unwrap();
        let r = s
            .raw(Method::POST, &path, Some(body), Some(&key), None)
            .await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers().get("idempotent-replayed").unwrap(), "true");
        assert_eq!(r.json::<Value>().await.unwrap(), first);
        assert_eq!(std::fs::read_to_string(root.join(name)).unwrap(), "새 파일");
        std::fs::remove_file(root.join(name)).unwrap();

        let (_, t) = s.get(&format!("/api/v1/projects/{pid}/trash")).await;
        let item = t["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["path"] == name)
            .expect("파일명과 무관하게 휴지통에 표시");
        let path = format!("/api/v1/trash/{}/restore", item["id"].as_str().unwrap());
        let key = s.key();
        let r = s
            .raw(Method::POST, &path, Some(json!({})), Some(&key), None)
            .await;
        assert_eq!(r.status(), StatusCode::OK);
        let first: Value = r.json().await.unwrap();
        let r = s
            .raw(Method::POST, &path, Some(json!({})), Some(&key), None)
            .await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.json::<Value>().await.unwrap(), first);
        assert_eq!(std::fs::read_to_string(root.join(name)).unwrap(), "원본");
    }
}

#[tokio::test]
async fn trash_purge_replays_and_notifies_other_clients() {
    let s = TestServer::start().await;
    let p = s.create_project("purge").await;
    let pid = p["id"].as_str().unwrap();
    let root = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
    std::fs::write(root.join("a"), "keep").unwrap();
    let (_, v) = s
        .post(
            &format!("/api/v1/projects/{pid}/files/op"),
            json!({ "op": "delete", "path": "a", "confirm": "a" }),
        )
        .await;
    let path = format!("/api/v1/trash/{}/delete", v["trash"].as_str().unwrap());
    let body = json!({ "confirm": "a" });
    let key = s.key();
    for _ in 0..2 {
        let r = s
            .raw(Method::POST, &path, Some(body.clone()), Some(&key), None)
            .await;
        assert_eq!(r.status(), StatusCode::OK);
    }
    let r = s
        .raw(
            Method::POST,
            &path,
            Some(json!({ "confirm": "other" })),
            Some(&key),
            None,
        )
        .await;
    assert_eq!(r.status(), StatusCode::CONFLICT);
    let app = &s.server.as_ref().unwrap().app;
    let n = app.db.call(|c| Ok(c.query_row("SELECT COUNT(*) FROM events WHERE kind = 'file.changed' AND json_extract(payload, '$.op') = 'purge'", [], |r| r.get::<_, i64>(0))?)).await.unwrap();
    assert_eq!(n, 1, "다른 클라이언트용 이벤트도 한 번만 기록");
}

#[tokio::test]
async fn trash_commit_failure_is_unknown_after_restart_and_never_collected() {
    let mut s = TestServer::start().await;
    let p = s.create_project("unknown").await;
    let pid = p["id"].as_str().unwrap().to_string();
    let root = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
    std::fs::write(root.join("a"), "원본").unwrap();
    s.server.as_ref().unwrap().app.db.call(|c| {
        c.execute_batch("CREATE TRIGGER fail_storage_event BEFORE INSERT ON events WHEN NEW.kind = 'file.changed' BEGIN SELECT RAISE(FAIL, 'fixture disk failure'); END;")?;
        Ok(())
    }).await.unwrap();
    let path = format!("/api/v1/projects/{pid}/files/op");
    let body = json!({ "op": "delete", "path": "a", "confirm": "a" });
    let key = s.key();
    let r = s
        .raw(Method::POST, &path, Some(body.clone()), Some(&key), None)
        .await;
    assert_eq!(r.status(), StatusCode::CONFLICT);
    let unknown: Value = r.json().await.unwrap();
    assert_eq!(unknown["error"]["code"], "result_unknown");
    let tid = unknown["error"]["details"]["trash_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        !root.join("a").exists(),
        "파일 이동 뒤 최종 DB 기록 실패를 검증"
    );
    std::fs::write(root.join("a"), "새 파일").unwrap();
    s.server.as_ref().unwrap().app.db.call(|c| {
        c.execute_batch("DROP TRIGGER fail_storage_event; UPDATE idempotency SET created_at = '2000-01-01T00:00:00Z' WHERE json_extract(response, '$.error.code') = 'result_unknown';")?;
        grove::events::prune(c)?;
        Ok(())
    }).await.unwrap();
    s.restart().await;
    let r = s
        .raw(Method::POST, &path, Some(body), Some(&key), None)
        .await;
    assert_eq!(r.status(), StatusCode::CONFLICT);
    assert_eq!(r.json::<Value>().await.unwrap(), unknown);
    assert_eq!(std::fs::read_to_string(root.join("a")).unwrap(), "새 파일");
    let dir = s.data_dir().join("trash").join(&tid);
    let mut origin: Value =
        serde_json::from_slice(&std::fs::read(dir.join("origin.json")).unwrap()).unwrap();
    origin["deleted_at"] = json!("2000-01-01T00:00:00Z");
    std::fs::write(dir.join("origin.json"), origin.to_string()).unwrap();
    s.send(
        Method::PUT,
        "/api/v1/settings/server/-/storage.trash_retention_days",
        json!({ "expected_revision": 0, "value": 1 }),
    )
    .await;
    assert_eq!(gc(&s).await["trash_removed"], 0);
    assert_eq!(
        std::fs::read_to_string(dir.join("payload")).unwrap(),
        "원본"
    );
}

#[tokio::test]
async fn gc_is_bounded_and_advances_past_referenced_blobs() {
    let s = TestServer::start().await;
    let p = s.create_project("bounded").await;
    let pid = p["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    run_tool(&s, &sid, "write", json!({ "path": "x", "content": "keep" })).await;
    let count = grove::storage::MAX_PER_RUN + 1;
    let dd = s.data_dir();
    let mut paths = vec![];
    for n in 0..count {
        let sha = format!("{n:064x}");
        let path = dd.join("blobs").join(&sha[..2]).join(&sha);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "x").unwrap();
        age(&path, Duration::from_secs(7200));
        paths.push(path);
    }
    // 파일 시스템 열거 순서의 끝을 orphan으로 정해 이전의 앞부분 반복 검사를 잡는다.
    let entries: Vec<_> = std::fs::read_dir(dd.join("blobs").join("00"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    let orphan = entries.last().unwrap().clone();
    let reference: Vec<_> = paths
        .iter()
        .filter(|p| *p != &orphan)
        .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
        .collect();
    s.server.as_ref().unwrap().app.db.call(move |c| {
        let tx = c.transaction()?;
        for (n, sha) in reference.iter().enumerate() {
            tx.execute("INSERT INTO file_changes (id, session_id, call_id, tool, path, before_sha, created_at, seq) SELECT ?1, session_id, call_id, tool, path, ?2, created_at, seq FROM file_changes LIMIT 1", rusqlite::params![format!("ref-{n}"), sha])?;
        }
        // 실제 누락도 한 번에 전체를 읽거나 변경하지 않고 다음 실행으로 이어가야 한다.
        for n in 0..count {
            tx.execute("INSERT INTO file_changes (id, session_id, call_id, tool, path, before_sha, created_at, seq) SELECT ?1, session_id, call_id, tool, path, ?2, created_at, seq FROM file_changes LIMIT 1", rusqlite::params![format!("missing-{n}"), format!("{:064x}", count + n)])?;
        }
        tx.commit()?;
        Ok(())
    }).await.unwrap();
    let mut removed = 0;
    let mut marked = 0;
    for _ in 0..12 {
        let r = gc(&s).await;
        assert!(
            r["changes_marked_unstored"].as_u64().unwrap() < count as u64,
            "누락 검사도 제한됨: {r}"
        );
        removed += r["blobs_removed"].as_u64().unwrap();
        marked += r["changes_marked_unstored"].as_u64().unwrap();
    }
    assert_eq!(removed, 1);
    assert_eq!(marked, count as u64);
    assert!(!orphan.exists(), "반복 실행하면 뒤쪽 orphan까지 도달");
    assert!(paths.iter().filter(|p| *p != &orphan).all(|p| p.exists()));
}

#[tokio::test]
async fn trash_validates_key_and_restores_legacy_directories() {
    let s = TestServer::start().await;
    let p = s.create_project("legacy").await;
    let pid = p["id"].as_str().unwrap();
    let root = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
    std::fs::write(root.join("a"), "keep").unwrap();
    let r = s
        .raw(
            Method::POST,
            &format!("/api/v1/projects/{pid}/files/op"),
            Some(json!({ "op": "delete", "path": "a", "confirm": "a" })),
            None,
            None,
        )
        .await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    assert!(root.join("a").exists());
    let legacy = s.data_dir().join("trash/legacy");
    std::fs::create_dir_all(legacy.join("old/nested")).unwrap();
    std::fs::write(legacy.join("old/nested/data"), "이전 데이터").unwrap();
    std::fs::write(
        legacy.join("origin.json"),
        json!({ "project_id": pid, "path": "old" }).to_string(),
    )
    .unwrap();
    let (st, _) = s.post("/api/v1/trash/legacy/restore", json!({})).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(
        std::fs::read_to_string(root.join("old/nested/data")).unwrap(),
        "이전 데이터"
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn trash_round_trip_across_filesystems_keeps_directory_and_links() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let s = TestServer::start().await;
    let root = tempfile::tempdir_in("/dev/shm").expect("Linux cross-filesystem fixture");
    assert_ne!(
        root.path().metadata().unwrap().dev(),
        s.data_dir().metadata().unwrap().dev()
    );
    let (st, p) = s
        .post(
            "/api/v1/projects",
            json!({ "name": "crossfs", "root_path": root.path().to_string_lossy() }),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED, "{p}");
    let pid = p["id"].as_str().unwrap();
    std::fs::create_dir_all(root.path().join("folder/nested")).unwrap();
    std::fs::write(root.path().join("folder/nested/origin.json"), "실제 내용").unwrap();
    std::os::unix::fs::symlink("nested/origin.json", root.path().join("folder/link")).unwrap();
    std::fs::set_permissions(
        root.path().join("folder"),
        std::fs::Permissions::from_mode(0o750),
    )
    .unwrap();
    std::fs::set_permissions(
        root.path().join("folder/nested"),
        std::fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let (st, v) = s
        .post(
            &format!("/api/v1/projects/{pid}/files/op"),
            json!({ "op": "delete", "path": "folder", "confirm": "folder" }),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert!(!root.path().join("folder").exists());
    let id = v["trash"].as_str().unwrap();
    assert_eq!(
        s.data_dir()
            .join("trash")
            .join(id)
            .join("payload/nested")
            .metadata()
            .unwrap()
            .mode()
            & 0o777,
        0o700,
        "휴지통 복사도 폴더 권한을 보존한다"
    );
    let (st, v) = s
        .post(&format!("/api/v1/trash/{id}/restore"), json!({}))
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(
        std::fs::read_to_string(root.path().join("folder/link")).unwrap(),
        "실제 내용"
    );
    assert!(
        root.path()
            .join("folder/link")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(!s.data_dir().join("trash").join(id).exists());
    assert_eq!(
        root.path().join("folder").metadata().unwrap().mode() & 0o777,
        0o750
    );
    assert_eq!(
        root.path().join("folder/nested").metadata().unwrap().mode() & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::read_dir(root.path()).unwrap().count(),
        1,
        "임시 복사본 정리"
    );
}

#[tokio::test]
async fn event_and_receipt_pruning_is_bounded() {
    let s = TestServer::start().await;
    s.server.as_ref().unwrap().app.db.call(|c| {
        c.execute_batch("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 55000)
            INSERT INTO events (created_at, kind, payload) SELECT '2000-01-01T00:00:00Z', 'fixture', '{}' FROM n;
            WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 5000)
            INSERT INTO idempotency (owner_id, key, request_hash, status, response, created_at) SELECT 'fixture', CAST(x AS TEXT), 'h', 200, '{}', '2000-01-01T00:00:00Z' FROM n;")?;
        for _ in 0..4 {
            assert!(grove::events::prune(c)? <= 4000);
        }
        assert_eq!(c.query_row("SELECT COUNT(*) FROM events", [], |r| r.get::<_, i64>(0))?, grove::events::RETAIN_EVENTS);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM idempotency WHERE owner_id = 'fixture'", [], |r| r.get::<_, i64>(0))?, 0);
        Ok(())
    }).await.unwrap();
}

#[tokio::test]
async fn gc_drains_large_trash_in_batches_and_resumes_after_restart() {
    let mut s = TestServer::start().await;
    let p = s.create_project("large-trash").await;
    let pid = p["id"].as_str().unwrap();
    let root = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
    std::fs::create_dir(root.join("large")).unwrap();
    for i in 0..1000 {
        std::fs::write(root.join("large").join(i.to_string()), "x").unwrap();
    }
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("keep"), "보존").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), root.join("large/external")).unwrap();
    let (st, deleted) = s
        .post(
            &format!("/api/v1/projects/{pid}/files/op"),
            json!({"op":"delete","path":"large","confirm":"large"}),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let dir = s
        .data_dir()
        .join("trash")
        .join(deleted["trash"].as_str().unwrap());
    let mut origin: Value =
        serde_json::from_slice(&std::fs::read(dir.join("origin.json")).unwrap()).unwrap();
    origin["deleted_at"] = json!(grove::util::fmt_time(
        time::OffsetDateTime::now_utc() - time::Duration::days(3)
    ));
    std::fs::write(dir.join("origin.json"), origin.to_string()).unwrap();
    let (st, _) = s
        .send(
            Method::PUT,
            "/api/v1/settings/server/-/storage.trash_retention_days",
            json!({"expected_revision":0,"value":2}),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(
        gc(&s).await["trash_removed"],
        0,
        "큰 폴더를 한 호출에 전부 삭제하지 않는다"
    );
    let left = std::fs::read_dir(dir.join("payload")).unwrap().count();
    assert!(left > 0 && left < 1000, "한도 내에서 일부만 진행: {left}");
    let (_, trash) = s.get(&format!("/api/v1/projects/{pid}/trash")).await;
    assert_eq!(trash["items"][0]["status"], "purging");
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    let response =
        json!({"error":{"code":"result_unknown","details":{"trash_id":deleted["trash"]}}});
    db.execute("INSERT INTO idempotency(owner_id,key,request_hash,status,response,created_at) VALUES ('fixture','uncertain-purge','fixture',409,?1,?2)", rusqlite::params![response.to_string(),s.server.as_ref().unwrap().app.now()]).unwrap();
    gc(&s).await;
    assert_eq!(
        std::fs::read_dir(dir.join("payload")).unwrap().count(),
        left,
        "정리 도중 결과 불명이 된 항목도 보존"
    );
    db.execute(
        "DELETE FROM idempotency WHERE owner_id='fixture' AND key='uncertain-purge'",
        [],
    )
    .unwrap();
    drop(db);
    s.restart().await;
    for _ in 0..20 {
        gc(&s).await;
        if !dir.exists() {
            break;
        }
    }
    assert!(!dir.exists(), "재시작 후 남은 정리를 이어간다");
    assert_eq!(
        std::fs::read_to_string(outside.path().join("keep")).unwrap(),
        "보존"
    );
}

#[tokio::test]
async fn gc_recovers_final_purge_commit_after_restart_without_duplicate_events() {
    let mut s = TestServer::start().await;
    let p = s.create_project("purge-final-commit").await;
    let pid = p["id"].as_str().unwrap().to_string();
    std::fs::write(
        std::path::Path::new(p["root_path"].as_str().unwrap()).join("gone"),
        b"old",
    )
    .unwrap();
    let (status, deleted) = s
        .post(
            &format!("/api/v1/projects/{pid}/files/op"),
            json!({"op":"delete","path":"gone","confirm":"gone"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let tid = deleted["trash"].as_str().unwrap().to_string();
    let dir = s.data_dir().join("trash").join(&tid);
    let meta = dir.join("origin.json");
    let mut origin: Value = serde_json::from_slice(&std::fs::read(&meta).unwrap()).unwrap();
    origin["deleted_at"] = json!("2000-01-01T00:00:00Z");
    std::fs::write(meta, origin.to_string()).unwrap();
    s.send(
        Method::PUT,
        "/api/v1/settings/server/-/storage.trash_retention_days",
        json!({"expected_revision":0,"value":2}),
    )
    .await;
    s.server.as_ref().unwrap().app.db.call(|c| {
        c.execute_batch("CREATE TRIGGER fail_purge_event BEFORE INSERT ON events WHEN NEW.kind='file.changed' AND json_extract(NEW.payload,'$.op')='purge' BEGIN SELECT RAISE(FAIL,'fixture purge commit'); END;")?;
        Ok(())
    }).await.unwrap();
    let app = s.server.as_ref().unwrap().app.clone();
    assert!(
        tokio::task::spawn_blocking(move || grove::storage::gc(&app))
            .await
            .unwrap()
            .is_err()
    );
    assert!(!dir.exists(), "파일 정리 뒤 완료 DB 기록이 실패하는 경계");
    s.restart().await;
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM trash_gc", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(db.query_row("SELECT COUNT(*) FROM events WHERE kind='file.changed' AND json_extract(payload,'$.op')='purge'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    db.execute_batch("DROP TRIGGER fail_purge_event").unwrap();
    gc(&s).await;
    gc(&s).await;
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM trash_gc", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(db.query_row("SELECT COUNT(*) FROM events WHERE kind='file.changed' AND json_extract(payload,'$.op')='purge'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
}

#[tokio::test]
async fn gc_finish_reconciles_interrupted_files_and_preserves_changed_entries() {
    let mut s = TestServer::start().await;
    let p = s.create_project("finish-recovery").await;
    let pid = p["id"].as_str().unwrap();
    let root = s.data_dir().join("trash");
    std::fs::create_dir_all(&root).unwrap();
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    let mut dirs = vec![];
    for name in [
        "metadata",
        "empty",
        "foreign-child",
        "changed-origin",
        "uncertain",
        "linked",
        "metadata-child",
    ] {
        let id = grove::util::new_id();
        let dir = root.join(&id);
        std::fs::create_dir(&dir).unwrap();
        let origin = json!({"format":2,"state":"purging","project_id":pid,"path":name,"deleted_at":"2000-01-01T00:00:00Z"});
        let bytes = origin.to_string();
        std::fs::write(dir.join("origin.json"), &bytes).unwrap();
        db.execute(
            "INSERT INTO trash_gc(id,project_id,path,origin_sha256) VALUES (?1,?2,?3,?4)",
            rusqlite::params![id, pid, name, grove::util::sha256_hex(bytes.as_bytes())],
        )
        .unwrap();
        if !matches!(name, "metadata" | "changed-origin" | "metadata-child") {
            std::fs::remove_file(dir.join("origin.json")).unwrap();
        }
        match name {
            "foreign-child" | "metadata-child" => {
                std::fs::write(dir.join("keep"), b"new data").unwrap()
            }
            "changed-origin" => std::fs::write(
                dir.join("origin.json"),
                bytes.replace("2000-01-01", "2001-01-01"),
            )
            .unwrap(),
            "uncertain" => {
                let receipt = json!({"error":{"code":"result_unknown","details":{"trash_id":id}}});
                db.execute("INSERT INTO idempotency(owner_id,key,request_hash,status,response,created_at) VALUES ('fixture','finish-uncertain','fixture',409,?1,?2)",rusqlite::params![receipt.to_string(),s.server.as_ref().unwrap().app.now()]).unwrap();
            }
            _ => {}
        }
        dirs.push(dir);
    }
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("keep"), b"outside").unwrap();
    #[cfg(unix)]
    {
        std::fs::remove_dir(&dirs[5]).unwrap();
        std::os::unix::fs::symlink(outside.path(), &dirs[5]).unwrap();
    }
    #[cfg(not(unix))]
    std::fs::write(dirs[5].join("keep"), b"new data").unwrap();
    s.restart().await;
    // 0=보존 무기한이어도 이미 원문 정리가 끝난 journal은 마무리한다.
    assert_eq!(gc(&s).await["trash_removed"], 2);
    assert_eq!(gc(&s).await["trash_removed"], 0);
    assert!(!dirs[0].exists() && !dirs[1].exists());
    assert_eq!(std::fs::read(dirs[2].join("keep")).unwrap(), b"new data");
    assert!(
        std::fs::read_to_string(dirs[3].join("origin.json"))
            .unwrap()
            .contains("2001-01-01")
    );
    assert!(dirs[4].is_dir());
    assert_eq!(std::fs::read(dirs[6].join("keep")).unwrap(), b"new data");
    assert!(dirs[6].join("origin.json").exists());
    assert_eq!(
        std::fs::read(outside.path().join("keep")).unwrap(),
        b"outside"
    );
    assert!(dirs[5].symlink_metadata().is_ok());
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM trash_gc", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        5
    );
    assert_eq!(db.query_row("SELECT COUNT(*) FROM events WHERE kind='file.changed' AND json_extract(payload,'$.op')='purge'", [], |r| r.get::<_,i64>(0)).unwrap(), 2);
    // 앞선 복구가 실패한 journal은 일반 purging scan에서도 재귀 삭제하지 않는다.
    s.send(
        Method::PUT,
        "/api/v1/settings/server/-/storage.trash_retention_days",
        json!({"expected_revision":0,"value":2}),
    )
    .await;
    gc(&s).await;
    assert_eq!(std::fs::read(dirs[2].join("keep")).unwrap(), b"new data");
    assert!(dirs[3].join("origin.json").exists());
    db.execute(
        "DELETE FROM idempotency WHERE owner_id='fixture' AND key='finish-uncertain'",
        [],
    )
    .unwrap();
    gc(&s).await;
    assert!(!dirs[4].exists());
    // 사용자의 명시적 영구 삭제는 journal도 같은 완료 transaction에서 해제한다.
    let id = dirs[3].file_name().unwrap().to_str().unwrap();
    let (status, _) = s
        .post(
            &format!("/api/v1/trash/{id}/delete"),
            json!({"confirm":"changed-origin"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM trash_gc WHERE id=?1", [id], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    gc(&s).await;
    assert_eq!(db.query_row("SELECT COUNT(*) FROM events WHERE kind='file.changed' AND json_extract(payload,'$.op')='purge'", [], |r| r.get::<_,i64>(0)).unwrap(), 4);
}

#[tokio::test]
async fn gc_finish_is_bounded_and_advances_past_preserved_entries() {
    let s = TestServer::start().await;
    let p = s.create_project("finish-batch").await;
    let pid = p["id"].as_str().unwrap();
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    for i in 0..=250 {
        let id = format!("blocked-{i}");
        let dir = s.data_dir().join("trash").join(&id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("keep"), b"preserve").unwrap();
        db.execute(
            "INSERT INTO trash_gc(id,project_id,path,origin_sha256) VALUES (?1,?2,?1,'fixture')",
            rusqlite::params![id, pid],
        )
        .unwrap();
    }
    db.execute("INSERT INTO trash_gc(id,project_id,path,origin_sha256) VALUES ('finished',?1,'gone','fixture')",[pid]).unwrap();
    assert_eq!(
        gc(&s).await["trash_removed"],
        0,
        "최초 250행 이내에서 멈춘다"
    );
    assert_eq!(
        gc(&s).await["trash_removed"],
        1,
        "다음 호출에서 뒤쪽 완료 행에 도달한다"
    );
    assert_eq!(gc(&s).await["trash_removed"], 0);
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM trash_gc", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        251
    );
    assert!((0..=250).all(|i| {
        s.data_dir()
            .join("trash")
            .join(format!("blocked-{i}/keep"))
            .exists()
    }));
}

#[tokio::test]
async fn migration_adds_purge_journal_and_resumes_legacy_purging_metadata() {
    let mut s = TestServer::start().await;
    let p = s.create_project("journal-migration").await;
    let pid = p["id"].as_str().unwrap();
    let dir = s.data_dir().join("trash/legacy-purging");
    std::fs::create_dir_all(&dir).unwrap();
    let origin = json!({"format":2,"state":"purging","project_id":pid,"path":"gone","deleted_at":"2000-01-01T00:00:00Z"}).to_string();
    std::fs::write(dir.join("origin.json"), &origin).unwrap();
    s.send(
        Method::PUT,
        "/api/v1/settings/server/-/storage.trash_retention_days",
        json!({"expected_revision":0,"value":2}),
    )
    .await;
    s.stop().await;
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    // 버전 34 상태를 흉내 낸다: 35(trash_gc)와 그 뒤 migration의 결과를 모두 되돌린다.
    db.execute_batch(
        "DROP TABLE memories; ALTER TABLE cli_sessions DROP COLUMN system_sha256; DROP TABLE credential_backfills; ALTER TABLE model_profiles DROP COLUMN enabled; DROP INDEX notifications_ref_created; ALTER TABLE notifications DROP COLUMN delivered_at; DROP TABLE pairings; DROP TABLE trash_gc; DROP TABLE worktrees; ALTER TABLE sessions DROP COLUMN worktree_id; PRAGMA user_version=34;",
    )
    .unwrap();
    s.restart().await;
    assert_eq!(
        std::fs::read_to_string(dir.join("origin.json")).unwrap(),
        origin
    );
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        grove::store::MIGRATIONS.len() as i64
    );
    assert_eq!(gc(&s).await["trash_removed"], 1);
    assert!(!dir.exists());
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM trash_gc", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn gc_preserves_metadata_if_purge_intent_commit_fails() {
    let mut s = TestServer::start().await;
    let p = s.create_project("intent-failure").await;
    let pid = p["id"].as_str().unwrap();
    let dir = s.data_dir().join("trash/fixture-intent");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("origin.json"), json!({"format":2,"state":"purging","project_id":pid,"path":"gone","deleted_at":"2000-01-01T00:00:00Z"}).to_string()).unwrap();
    s.send(
        Method::PUT,
        "/api/v1/settings/server/-/storage.trash_retention_days",
        json!({"expected_revision":0,"value":2}),
    )
    .await;
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_purge_intent BEFORE INSERT ON trash_gc BEGIN SELECT RAISE(FAIL,'fixture intent commit'); END;").unwrap();
    let app = s.server.as_ref().unwrap().app.clone();
    assert!(
        tokio::task::spawn_blocking(move || grove::storage::gc(&app))
            .await
            .unwrap()
            .is_err()
    );
    assert!(dir.join("origin.json").exists());
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM trash_gc", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    s.restart().await;
    db.execute_batch("DROP TRIGGER fail_purge_intent").unwrap();
    assert_eq!(gc(&s).await["trash_removed"], 1);
    assert!(!dir.exists());
}

#[tokio::test]
async fn gc_preserves_deep_trash_for_review_and_continues_other_entries() {
    let mut s = TestServer::start().await;
    let project = s.create_project("deep-trash").await;
    let pid = project["id"].as_str().unwrap();
    let root = std::path::PathBuf::from(project["root_path"].as_str().unwrap());
    let mut tail = std::path::PathBuf::new();
    let mut deep = root.join("deep");
    std::fs::create_dir(&deep).unwrap();
    for _ in 0..80 {
        tail.push("d");
        deep.push("d");
        std::fs::create_dir(&deep).unwrap();
    }
    std::fs::write(deep.join("keep"), b"preserve").unwrap();
    std::fs::write(root.join("ordinary"), b"expired").unwrap();
    let mut trash = vec![];
    for name in ["deep", "ordinary"] {
        let (status, result) = s
            .post(
                &format!("/api/v1/projects/{pid}/files/op"),
                json!({"op":"delete","path":name,"confirm":name}),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        let dir = s
            .data_dir()
            .join("trash")
            .join(result["trash"].as_str().unwrap());
        let meta = dir.join("origin.json");
        let mut origin: Value = serde_json::from_slice(&std::fs::read(&meta).unwrap()).unwrap();
        origin["deleted_at"] = json!("2000-01-01T00:00:00Z");
        std::fs::write(meta, origin.to_string()).unwrap();
        trash.push(dir);
    }
    let (status, _) = s
        .send(
            Method::PUT,
            "/api/v1/settings/server/-/storage.trash_retention_days",
            json!({"expected_revision":0,"value":2}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    // 상태 파일은 기록됐지만 알림 transaction이 실패하는 실제 경계를 주입한다.
    s.server.as_ref().unwrap().app.db.call(|c| {
        c.execute_batch("CREATE TRIGGER fail_review_event BEFORE INSERT ON events WHEN NEW.kind='file.changed' AND json_extract(NEW.payload,'$.op')='needs_review' BEGIN SELECT RAISE(FAIL,'fixture event failure'); END;")?;
        Ok(())
    }).await.unwrap();
    let app = s.server.as_ref().unwrap().app.clone();
    assert!(
        tokio::task::spawn_blocking(move || grove::storage::gc(&app))
            .await
            .unwrap()
            .is_err()
    );
    s.server
        .as_ref()
        .unwrap()
        .app
        .db
        .call(|c| {
            c.execute_batch("DROP TRIGGER fail_review_event")?;
            Ok(())
        })
        .await
        .unwrap();
    for _ in 0..3 {
        gc(&s).await;
    }
    assert_eq!(
        std::fs::read(trash[0].join("payload").join(&tail).join("keep")).unwrap(),
        b"preserve"
    );
    assert!(
        !trash[1].exists(),
        "깊은 항목이 다른 만료 항목의 정리를 막지 않는다"
    );
    let (status, list) = s.get(&format!("/api/v1/projects/{pid}/trash")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    assert_eq!(list["items"][0]["status"], "needs_review");
    s.restart().await;
    gc(&s).await;
    assert!(trash[0].join("origin.json").exists());
    assert!(trash[0].join("payload").join(tail).join("keep").exists());
}

#[tokio::test]
async fn gc_preserves_live_unknown_and_unlimited_task_logs() {
    let s = TestServer::start().await;
    let p = s.create_project("logs").await;
    let pid = p["id"].as_str().unwrap();
    let session = s.create_session(pid).await;
    let sid = session["id"].as_str().unwrap();
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    let log_dir = s.data_dir().join("tasks");
    std::fs::create_dir_all(&log_dir).unwrap();
    let old = grove::util::fmt_time(time::OffsetDateTime::now_utc() - time::Duration::days(3));
    for status in [
        "running",
        "unknown",
        "completed",
        "failed",
        "timeout",
        "cancelled",
    ] {
        db.execute("INSERT INTO tasks(id,session_id,project_id,command,cwd,timeout_ms,status,detached,started_at,ended_at) VALUES (?1,?2,?3,'fixture',?4,1000,?1,0,?5,?5)", rusqlite::params![status,sid,pid,p["root_path"].as_str().unwrap(),old]).unwrap();
        for ext in ["out", "err"] {
            std::fs::write(log_dir.join(format!("{status}.{ext}")), "log").unwrap();
        }
    }
    assert_eq!(
        gc(&s).await["task_logs_removed"],
        0,
        "기본 보존 기간은 무기한"
    );
    let (st, _) = s
        .send(
            Method::PUT,
            "/api/v1/settings/server/-/storage.task_log_retention_days",
            json!({"expected_revision":0,"value":2}),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(gc(&s).await["task_logs_removed"], 8);
    for status in ["running", "unknown"] {
        for ext in ["out", "err"] {
            assert!(log_dir.join(format!("{status}.{ext}")).exists());
        }
    }
    assert_eq!(std::fs::read_dir(log_dir).unwrap().count(), 4);
}

#[tokio::test]
async fn file_write_repairs_corrupt_reused_blob_and_oversize_storage_disables_undo() {
    let s = TestServer::start().await;
    let p = s.create_project("blob-repair").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let content = "정상 원문\n";
    let sha = grove::util::sha256_hex(content.as_bytes());
    let blob = s.data_dir().join("blobs").join(&sha[..2]).join(&sha);
    std::fs::create_dir_all(blob.parent().unwrap()).unwrap();
    std::fs::write(&blob, "손상 원문").unwrap();
    run_tool(
        &s,
        &sid,
        "write",
        json!({"path":"kept.txt","content":content}),
    )
    .await;
    assert_eq!(std::fs::read(&blob).unwrap(), content.as_bytes());
    let (_, changes) = s.get(&format!("/api/v1/sessions/{sid}/file-changes")).await;
    assert_eq!(changes[0]["stored"], true);
    let id = changes[0]["id"].as_str().unwrap();
    let (_, diff) = s.get(&format!("/api/v1/file-changes/{id}/diff")).await;
    assert!(diff["diff"].as_str().unwrap().contains("+정상 원문"));
    std::fs::OpenOptions::new()
        .write(true)
        .open(&blob)
        .unwrap()
        .set_len(grove::changes::MAX_STORED + 1)
        .unwrap();
    let (_, diff) = s.get(&format!("/api/v1/file-changes/{id}/diff")).await;
    assert!(diff["diff"].is_null());
    assert_eq!(diff["unavailable"], "missing");
    assert_eq!(gc(&s).await["changes_marked_unstored"], 1);
    let (status, _) = s
        .post(
            &format!("/api/v1/sessions/{sid}/file-changes/undo"),
            json!({"change_ids":[id]}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        std::fs::read(std::path::Path::new(p["root_path"].as_str().unwrap()).join("kept.txt"))
            .unwrap(),
        content.as_bytes()
    );
}

#[tokio::test]
async fn gc_removes_only_owned_old_blob_staging_and_keeps_referenced_original() {
    let s = TestServer::start().await;
    let p = s.create_project("blob-staging").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    run_tool(
        &s,
        &sid,
        "write",
        json!({"path":"kept.txt","content":"known"}),
    )
    .await;
    let sha = grove::util::sha256_hex(b"known");
    let root = s.data_dir().join("blobs");
    let parent = root.join(&sha[..2]);
    let original = parent.join(&sha);
    let unicode = parent.join("원문");
    std::fs::write(&unicode, b"unrelated").unwrap();
    let name = || format!(".{sha}.grove-{}.tmp", grove::util::new_id());
    let old = parent.join(name());
    let fresh = parent.join(name());
    let foreign = parent.join(format!(".{sha}.grove-foreign.tmp"));
    let misplaced = root
        .join(if &sha[..2] == "ff" { "ee" } else { "ff" })
        .join(name());
    std::fs::create_dir_all(misplaced.parent().unwrap()).unwrap();
    for path in [&old, &fresh, &foreign, &misplaced] {
        std::fs::write(path, b"partial").unwrap();
    }
    for path in [&old, &foreign, &misplaced] {
        age(path, Duration::from_secs(7200));
    }
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("keep");
    std::fs::write(&target, b"outside").unwrap();
    #[cfg(unix)]
    let linked = {
        let linked = parent.join(name());
        std::os::unix::fs::symlink(&target, &linked).unwrap();
        linked
    };
    assert_eq!(gc(&s).await["blobs_removed"], 1);
    assert!(!old.exists());
    assert_eq!(std::fs::read(unicode).unwrap(), b"unrelated");
    assert!(fresh.exists() && foreign.exists() && misplaced.exists());
    assert_eq!(std::fs::read(original).unwrap(), b"known");
    assert_eq!(std::fs::read(target).unwrap(), b"outside");
    #[cfg(unix)]
    assert!(linked.symlink_metadata().unwrap().file_type().is_symlink());
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM blobs WHERE sha=?1", [&sha], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn failed_blob_storage_does_not_offer_undo_for_a_successful_file_write() {
    let s = TestServer::start().await;
    let p = s.create_project("full-blob-storage").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    // 디렉터리 대신 파일을 두어 권한/root 여부와 무관하게 보관 실패를 만든다.
    std::fs::write(s.data_dir().join("blobs"), "blocked").unwrap();
    run_tool(
        &s,
        &sid,
        "write",
        json!({"path":"written.txt","content":"보존할 사용자 파일"}),
    )
    .await;
    let root = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
    let (_, changes) = s.get(&format!("/api/v1/sessions/{sid}/file-changes")).await;
    assert_eq!(changes.as_array().unwrap().len(), 1);
    assert_eq!(changes[0]["stored"], false);
    let (st, _) = s
        .post(
            &format!("/api/v1/sessions/{sid}/file-changes/undo"),
            json!({"change_ids":[changes[0]["id"]]}),
        )
        .await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(
        std::fs::read_to_string(root.join("written.txt")).unwrap(),
        "보존할 사용자 파일"
    );
}

#[tokio::test]
async fn failed_file_change_transaction_preserves_files_and_recovers_without_reexecution() {
    for fault in ["blob", "history", "event", "commit"] {
        let mut s = TestServer::start().await;
        let project = s.create_project(&format!("failed-history-{fault}")).await;
        let sid = s.create_session(project["id"].as_str().unwrap()).await["id"]
            .as_str()
            .unwrap()
            .to_string();
        let file = std::path::Path::new(project["root_path"].as_str().unwrap()).join("a.txt");
        run_tool(
            &s,
            &sid,
            "write",
            json!({"path":"a.txt","content":"before\n"}),
        )
        .await;
        let request = format!("/api/v1/sessions/{sid}/tool-requests");
        let key = s.key();
        let body = json!({"name":"edit","args":{"path":"a.txt","old_string":"before","new_string":"after"}});
        let response = s
            .raw(Method::POST, &request, Some(body.clone()), Some(&key), None)
            .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let call = response.json::<Value>().await.unwrap();
        let id = call["id"].as_str().unwrap().to_string();
        let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
        let sql = match fault {
            "blob" => {
                "CREATE TRIGGER fail_change BEFORE INSERT ON blobs BEGIN SELECT RAISE(FAIL,'fixture blob metadata'); END;"
            }
            "history" => {
                "CREATE TRIGGER fail_change BEFORE INSERT ON file_changes BEGIN SELECT RAISE(FAIL,'fixture file history'); END;"
            }
            "event" => {
                "CREATE TRIGGER fail_change BEFORE INSERT ON events WHEN NEW.kind='file_changes.updated' BEGIN SELECT RAISE(FAIL,'fixture history event'); END;"
            }
            // 모든 SQL 문은 성공하지만 실제 COMMIT이 deferred FK 검사에서 실패한다.
            _ => {
                "CREATE TABLE fixture_failed_commit (call_id TEXT REFERENCES tool_calls(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_change AFTER INSERT ON file_changes BEGIN INSERT INTO fixture_failed_commit VALUES ('missing-fixture-call'); END;"
            }
        };
        db.execute_batch(sql).unwrap();
        // 승인 완료 직후의 상태에서 같은 실제 실행 경로를 호출하고 JoinHandle로 완료를 기다린다.
        db.execute("UPDATE tool_calls SET status='approved',approval_scope='once' WHERE id=?1", [&id])
            .unwrap();
        let app = s.server.as_ref().unwrap().app.clone();
        grove::approvals::spawn_execute(&app, id.clone())
            .await
            .unwrap();
        let (_, current) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
        assert_eq!(current["status"], "running", "{fault}: {current}");
        assert!(current["result"].is_null());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "after\n");
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM file_changes", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM blobs", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM events WHERE kind='file_changes.updated'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(db.query_row("SELECT COUNT(*) FROM events WHERE kind='tool_call.updated' AND json_extract(payload,'$.id')=?1 AND json_extract(payload,'$.status')='succeeded'", [&id], |r| r.get::<_, i64>(0)).unwrap(), 0);
        if fault == "commit" {
            assert_eq!(
                db.query_row("SELECT COUNT(*) FROM fixture_failed_commit", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        let sha = |bytes: &[u8]| {
            let sha = grove::util::sha256_hex(bytes);
            s.data_dir().join("blobs").join(&sha[..2]).join(sha)
        };
        let (before, after) = (sha(b"before\n"), sha(b"after\n"));
        assert_eq!(std::fs::read(&before).unwrap(), b"before\n");
        assert_eq!(std::fs::read(&after).unwrap(), b"after\n");
        assert_eq!(gc(&s).await["blobs_removed"], 0, "새 고아 blob은 유예한다");
        age(&after, Duration::from_secs(7200));
        assert_eq!(
            gc(&s).await["blobs_removed"],
            0,
            "running인 파일 도구는 정리하지 않는다"
        );
        assert!(after.exists());
        db.execute_batch("DROP TRIGGER fail_change").unwrap();
        s.restart().await;
        let (_, current) = s.get(&format!("/api/v1/tool-calls/{id}")).await;
        assert_eq!(current["status"], "unknown");
        let (_, session) = s.get(&format!("/api/v1/sessions/{sid}")).await;
        assert_eq!(session["unreviewed_unknown"], 1);
        let (_, observation) = s.get(&format!("/api/v1/tool-calls/{id}/observe")).await;
        assert_eq!(
            observation["observation"]["state"],
            "matches_expected_result"
        );
        // 재실행 가능한 원문으로 돌려도 접수 재전송과 새 승인 모두 파일을 바꾸지 않는다.
        std::fs::write(&file, "before\n").unwrap();
        let replay = s
            .raw(Method::POST, &request, Some(body), Some(&key), None)
            .await;
        assert_eq!(replay.status(), StatusCode::CREATED);
        assert_eq!(replay.headers()["idempotent-replayed"], "true");
        assert_eq!(replay.json::<Value>().await.unwrap()["id"], id);
        let (status, _) = s
            .post(
                &format!("/api/v1/tool-calls/{id}/decision"),
                json!({"decision":"approve","expected_revision":current["revision"]}),
            )
            .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "before\n");
        assert_eq!(gc(&s).await["blobs_removed"], 1);
        assert!(
            !after.exists() && before.exists(),
            "고아만 지우고 참조 원문은 보존한다"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "before\n");
        let (_, changes) = s.get(&format!("/api/v1/sessions/{sid}/file-changes")).await;
        assert_eq!(changes.as_array().unwrap().len(), 1);
        assert_eq!(changes[0]["tool"], "write");
    }
}
