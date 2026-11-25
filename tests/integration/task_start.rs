#![cfg(unix)]
use crate::common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn setup() -> (TestServer, String, std::path::PathBuf) {
    let s = TestServer::start().await;
    let p = s.create_project("start-receipt").await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let root = std::path::PathBuf::from(p["root_path"].as_str().unwrap());
    (s, sid, root)
}

#[tokio::test]
async fn failed_acceptance_commit_does_not_create_or_execute_a_task() {
    let (s, sid, root) = setup().await;
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_task_accept BEFORE INSERT ON idempotency WHEN NEW.key='reject-accept' BEGIN SELECT RAISE(ABORT,'fixture acceptance failure'); END;").unwrap();
    let r = s
        .raw(
            Method::POST,
            &format!("/api/v1/sessions/{sid}/tasks"),
            Some(json!({"command":"printf once >> marker"})),
            Some("reject-accept"),
            None,
        )
        .await;
    assert_eq!(r.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0,
        "접수 transaction 실패는 task/log/event도 되돌려야 한다"
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM task_logs", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(!root.join("marker").exists());
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM events WHERE kind='task.changed'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[tokio::test]
async fn concurrent_same_key_starts_once_and_rejects_changed_or_missing_key() {
    let (s, sid, root) = setup().await;
    let path = format!("/api/v1/sessions/{sid}/tasks");
    let body = json!({"command":"printf once >> marker"});
    let (a, b) = tokio::join!(
        s.raw(
            Method::POST,
            &path,
            Some(body.clone()),
            Some("concurrent"),
            None
        ),
        s.raw(
            Method::POST,
            &path,
            Some(body.clone()),
            Some("concurrent"),
            None
        ),
    );
    let mut ids = vec![];
    let mut created = 0;
    for r in [a, b] {
        let status = r.status();
        let v: Value = r.json().await.unwrap();
        if status == StatusCode::CREATED {
            created += 1;
            ids.push(v["id"].as_str().unwrap().to_string());
        } else {
            assert_eq!(status, StatusCode::CONFLICT, "{v}");
            assert_eq!(v["error"]["code"], "result_unknown");
            ids.push(
                v["error"]["details"]["task_id"]
                    .as_str()
                    .unwrap()
                    .to_string(),
            );
        }
    }
    assert!(created >= 1);
    assert_eq!(ids[0], ids[1]);
    let (_, done) = s
        .get(&format!("/api/v1/tasks/{}/wait?timeout_ms=10000", ids[0]))
        .await;
    assert_eq!(done["status"], "completed", "{done}");
    assert_eq!(
        std::fs::read_to_string(root.join("marker")).unwrap(),
        "once"
    );
    let r = s
        .raw(
            Method::POST,
            &path,
            Some(body.clone()),
            Some("concurrent"),
            None,
        )
        .await;
    assert_eq!(r.status(), StatusCode::CREATED);
    assert_eq!(r.headers()["idempotent-replayed"], "true");
    assert_eq!(r.json::<Value>().await.unwrap()["id"], ids[0]);
    let r = s
        .raw(
            Method::POST,
            &path,
            Some(json!({"command":"printf twice >> marker"})),
            Some("concurrent"),
            None,
        )
        .await;
    assert_eq!(r.status(), StatusCode::CONFLICT);
    assert_eq!(
        r.json::<Value>().await.unwrap()["error"]["code"],
        "idempotency_conflict"
    );
    let r = s.raw(Method::POST, &path, Some(body), None, None).await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    let (_, tasks) = s.get(&path).await;
    assert_eq!(tasks["tasks"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn final_receipt_failure_survives_prune_and_restart_without_reexecution() {
    let (mut s, sid, root) = setup().await;
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_task_receipt BEFORE UPDATE ON idempotency WHEN NEW.key='finish-fail' AND NEW.status=201 BEGIN SELECT RAISE(ABORT,'fixture final receipt failure'); END;").unwrap();
    let path = format!("/api/v1/sessions/{sid}/tasks");
    let body = json!({"command":"printf once >> marker"});
    let r = s
        .raw(
            Method::POST,
            &path,
            Some(body.clone()),
            Some("finish-fail"),
            None,
        )
        .await;
    assert_eq!(r.status(), StatusCode::CONFLICT);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["error"]["code"], "result_unknown");
    let id = v["error"]["details"]["task_id"].as_str().unwrap();
    let (_, done) = s
        .get(&format!("/api/v1/tasks/{id}/wait?timeout_ms=10000"))
        .await;
    assert_eq!(done["status"], "completed", "{done}");
    db.execute_batch("DROP TRIGGER fail_task_receipt; UPDATE idempotency SET created_at='2020-01-01T00:00:00Z' WHERE key='finish-fail';").unwrap();
    grove::events::prune(&db).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM idempotency WHERE key='finish-fail'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    drop(db);
    s.restart().await;
    let r = s
        .raw(Method::POST, &path, Some(body), Some("finish-fail"), None)
        .await;
    assert_eq!(r.status(), StatusCode::CONFLICT);
    assert_eq!(r.headers()["idempotent-replayed"], "true");
    assert_eq!(r.json::<Value>().await.unwrap(), v);
    let (_, tasks) = s.get(&path).await;
    assert_eq!(tasks["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(
        std::fs::read_to_string(root.join("marker")).unwrap(),
        "once"
    );
}

#[tokio::test]
async fn accepted_but_unlaunched_task_recovers_as_unknown_without_execution() {
    let (mut s, sid, root) = setup().await;
    s.stop().await;
    let mut db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    // 접수 commit 직후, 프로세스 시작 전 중단된 영속 상태를 구성한다.
    let id = grove::util::new_id();
    let now = grove::util::fmt_time(time::OffsetDateTime::now_utc());
    let cmd = "printf forbidden >> marker";
    // 이전 버전이 timeout 생략을 24시간으로 정규화해 저장한 receipt.
    let timeout = 24 * 3600 * 1000;
    let hash = grove::idem::body_hash("task.start", &json!({"s":sid,"c":cmd,"w":null,"t":timeout}));
    let pending =
        grove::error::ApiError::conflict("result_unknown", "fixture interrupted acceptance")
            .with_details(json!({"task_id":id,"session_id":sid}))
            .body();
    let tx = db.transaction().unwrap();
    tx.execute("INSERT INTO tasks(id,session_id,project_id,command,cwd,timeout_ms,status,detached,started_at) SELECT ?1,id,project_id,?3,'.',?4,'running',1,?5 FROM sessions WHERE id=?2",rusqlite::params![id,sid,cmd,timeout as i64,now]).unwrap();
    for stream in ["out", "err"] {
        tx.execute("INSERT INTO task_logs(task_id,stream,storage_key,state,updated_at) VALUES(?1,?2,?3,'writing',?4)",rusqlite::params![id,stream,format!("tasks/{id}.{stream}"),now]).unwrap();
    }
    assert_eq!(tx.execute("INSERT INTO idempotency(owner_id,key,request_hash,status,response,created_at) SELECT id,'before-launch',?1,409,?2,?3 FROM tokens WHERE kind='owner' AND revoked_at IS NULL",rusqlite::params![hash,pending.to_string(),now]).unwrap(),1);
    tx.commit().unwrap();
    drop(db);
    s.restart().await;
    let (_, t) = s.get(&format!("/api/v1/tasks/{id}")).await;
    assert_eq!(t["status"], "unknown", "{t}");
    let r = s
        .raw(
            Method::POST,
            &format!("/api/v1/sessions/{sid}/tasks"),
            Some(json!({"command":cmd})),
            Some("before-launch"),
            None,
        )
        .await;
    assert_eq!(r.status(), StatusCode::CONFLICT);
    assert_eq!(r.headers()["idempotent-replayed"], "true");
    assert_eq!(r.json::<Value>().await.unwrap(), pending);
    assert!(!root.join("marker").exists());
    assert!(
        !s.data_dir()
            .join("tasks")
            .join(format!("{id}.out"))
            .exists()
    );
}
