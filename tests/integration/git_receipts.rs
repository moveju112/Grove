//! Git 부작용 뒤 결과 저장 실패·재시작·재전송은 index를 다시 바꾸지 않는다.
use crate::common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value,json};
use std::{path::Path,process::Command};

fn git(root: &Path, args: &[&str]) -> String {
    let result=Command::new("git").args(args).current_dir(root).output().unwrap();
    assert!(result.status.success(),"git {args:?}: {}",String::from_utf8_lossy(&result.stderr));
    String::from_utf8(result.stdout).unwrap()
}

#[tokio::test]
async fn saved_unknown_git_results_survive_failures_and_restart_without_restaging_new_content() {
    for fault in ["event","receipt","commit"] {
        let mut s=TestServer::start().await;
        let project=s.create_project("git-receipt").await;
        let pid=project["id"].as_str().unwrap();
        let root=Path::new(project["root_path"].as_str().unwrap());
        git(root,&["init","-q"]);
        std::fs::write(root.join("a.txt"),b"before\n").unwrap();
        git(root,&["add","a.txt"]);
        std::fs::write(root.join("a.txt"),b"first request\n").unwrap();
        let (status,state)=s.get(&format!("/api/v1/projects/{pid}/git/status")).await;
        assert_eq!(status,StatusCode::OK,"{state}");
        let db=rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
        let sql=match fault {
            "event"=>"CREATE TRIGGER fail_git BEFORE INSERT ON events WHEN NEW.kind='git.changed' BEGIN SELECT RAISE(FAIL,'fixture git event'); END;",
            "receipt"=>"CREATE TRIGGER fail_git BEFORE UPDATE ON idempotency BEGIN SELECT RAISE(FAIL,'fixture git receipt'); END;",
            _=>"CREATE TABLE fixture_git_commit (project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED);
                CREATE TRIGGER fail_git AFTER INSERT ON events WHEN NEW.kind='git.changed' BEGIN INSERT INTO fixture_git_commit VALUES ('missing-fixture-project'); END;",
        };
        db.execute_batch(sql).unwrap();
        let path=format!("/api/v1/projects/{pid}/git/stage");
        let body=json!({"paths":["a.txt"],"expected_fingerprint":state["fingerprint"]});
        let key=s.key();
        let response=s.raw(Method::POST,&path,Some(body.clone()),Some(&key),None).await;
        let status=response.status();
        let result:Value=response.json().await.unwrap();
        assert_eq!(git(root,&["show",":a.txt"]),"first request\n");
        assert_eq!(status,StatusCode::CONFLICT,"{fault}: {result}");
        assert_eq!(result["error"]["code"],"result_unknown","{fault}: {result}");
        std::fs::write(root.join("a.txt"),b"new unaccepted edit\n").unwrap();
        db.execute_batch("DROP TRIGGER fail_git;").unwrap();
        if fault=="commit" { db.execute_batch("DROP TABLE fixture_git_commit;").unwrap(); }
        drop(db);
        s.restart().await;
        let response=s.raw(Method::POST,&path,Some(body),Some(&key),None).await;
        assert_eq!(response.status(),StatusCode::CONFLICT);
        assert_eq!(response.headers()["idempotent-replayed"],"true");
        assert_eq!(response.json::<Value>().await.unwrap(),result);
        assert_eq!(git(root,&["show",":a.txt"]),"first request\n","새 편집을 옛 요청으로 stage하지 않는다");
        assert_eq!(std::fs::read(root.join("a.txt")).unwrap(),b"new unaccepted edit\n");
    }
}

#[tokio::test]
async fn failed_git_acceptance_never_changes_the_index_and_the_unaccepted_key_can_be_used_after_recovery() {
    for deferred in [false,true] {
        let mut s=TestServer::start().await;
        let project=s.create_project("git-acceptance").await;
        let pid=project["id"].as_str().unwrap();
        let root=Path::new(project["root_path"].as_str().unwrap());
        git(root,&["init","-q"]);
        std::fs::write(root.join("a.txt"),b"before\n").unwrap();
        git(root,&["add","a.txt"]);
        std::fs::write(root.join("a.txt"),b"requested\n").unwrap();
        let (_,state)=s.get(&format!("/api/v1/projects/{pid}/git/status")).await;
        let path=format!("/api/v1/projects/{pid}/git/stage");
        let body=json!({"paths":["a.txt"],"expected_fingerprint":state["fingerprint"]});
        let key=s.key();
        let db=rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
        db.execute_batch(if deferred {
            "CREATE TABLE fixture_git_accept (project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED);
             CREATE TRIGGER fail_git_accept AFTER INSERT ON idempotency BEGIN INSERT INTO fixture_git_accept VALUES ('missing-fixture-project'); END;"
        } else {
            "CREATE TRIGGER fail_git_accept BEFORE INSERT ON idempotency BEGIN SELECT RAISE(FAIL,'fixture git acceptance'); END;"
        }).unwrap();
        let response=s.raw(Method::POST,&path,Some(body.clone()),Some(&key),None).await;
        assert_eq!(response.status(),StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(git(root,&["show",":a.txt"]),"before\n");
        let receipts:i64=db.query_row("SELECT COUNT(*) FROM idempotency WHERE key=?1",[&key],|r|r.get(0)).unwrap();
        assert_eq!(receipts,0);
        db.execute_batch("DROP TRIGGER fail_git_accept;").unwrap();
        if deferred { db.execute_batch("DROP TABLE fixture_git_accept;").unwrap(); }
        drop(db);
        s.restart().await;
        let response=s.raw(Method::POST,&path,Some(body),Some(&key),None).await;
        assert_eq!(response.status(),StatusCode::OK);
        assert_eq!(git(root,&["show",":a.txt"]),"requested\n");
    }
}

#[tokio::test]
async fn a_known_git_command_failure_replays_without_fetching_again_after_the_remote_is_fixed() {
    let s=TestServer::start().await;
    let project=s.create_project("git-known-error").await;
    let pid=project["id"].as_str().unwrap();
    let root=Path::new(project["root_path"].as_str().unwrap());
    git(root,&["init","-q"]);
    let path=format!("/api/v1/projects/{pid}/git/fetch");
    let body=json!({"remote":"receipt_fixture"});
    let key=s.key();
    let response=s.raw(Method::POST,&path,Some(body.clone()),Some(&key),None).await;
    let status=response.status();
    let first:Value=response.json().await.unwrap();
    assert!(!status.is_success());
    assert_ne!(first["error"]["code"],"result_unknown");
    let remote=s.make_project_dir("remote-target");
    git(&remote,&["init","--bare","-q"]);
    git(root,&["remote","add","receipt_fixture",remote.to_str().unwrap()]);
    let response=s.raw(Method::POST,&path,Some(body),Some(&key),None).await;
    assert_eq!(response.status(),status);
    assert_eq!(response.headers()["idempotent-replayed"],"true");
    assert_eq!(response.json::<Value>().await.unwrap(),first);
}

#[cfg(unix)]
#[tokio::test]
async fn failed_confirmation_after_a_real_commit_remains_unknown_and_is_never_reexecuted() {
    use std::os::unix::fs::PermissionsExt;
    let s=TestServer::start().await;
    let project=s.create_project("git-confirmation").await;
    let pid=project["id"].as_str().unwrap();
    let root=Path::new(project["root_path"].as_str().unwrap());
    git(root,&["init","-q","-b","main"]);
    git(root,&["config","user.email","fixture@example.invalid"]);
    git(root,&["config","user.name","Fixture"]);
    std::fs::write(root.join("a.txt"),b"before\n").unwrap();
    git(root,&["add","a.txt"]);
    git(root,&["commit","-qm","base"]);
    std::fs::write(root.join("a.txt"),b"requested\n").unwrap();
    git(root,&["add","a.txt"]);
    let hook=root.join(".git/hooks/post-commit");
    std::fs::write(&hook,b"#!/bin/sh\nmv .git/HEAD .git/HEAD.after-fixture\n").unwrap();
    std::fs::set_permissions(&hook,std::fs::Permissions::from_mode(0o700)).unwrap();
    let (_,state)=s.get(&format!("/api/v1/projects/{pid}/git/status")).await;
    let path=format!("/api/v1/projects/{pid}/git/commit");
    let body=json!({"message":"requested commit","expected_fingerprint":state["fingerprint"]});
    let key=s.key();
    let response=s.raw(Method::POST,&path,Some(body.clone()),Some(&key),None).await;
    assert!(root.join(".git/HEAD.after-fixture").exists(),"실제 commit의 post-commit hook까지 실행됐다");
    assert_eq!(response.status(),StatusCode::CONFLICT);
    let first:Value=response.json().await.unwrap();
    assert_eq!(first["error"]["code"],"result_unknown");
    // 시험이 잠시 옮긴 자기 HEAD만 복원하고, 자기가 만든 hook만 제거한다.
    std::fs::rename(root.join(".git/HEAD.after-fixture"),root.join(".git/HEAD")).unwrap();
    std::fs::remove_file(&hook).unwrap();
    assert_eq!(git(root,&["rev-list","--count","HEAD"]).trim(),"2");
    let response=s.raw(Method::POST,&path,Some(body),Some(&key),None).await;
    assert_eq!(response.status(),StatusCode::CONFLICT);
    assert_eq!(response.headers()["idempotent-replayed"],"true");
    assert_eq!(response.json::<Value>().await.unwrap(),first);
    assert_eq!(git(root,&["rev-list","--count","HEAD"]).trim(),"2");
}
