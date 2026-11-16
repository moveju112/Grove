mod common;

use common::*;
use reqwest::{Method, StatusCode};
use rusqlite::{Connection, params};
use serde_json::json;

#[tokio::test]
async fn previous_overrides_survive_reads_restart_and_removed_restore_requests() {
    let mut s = TestServer::start().await;
    {
        let db = Connection::open(s.data_dir().join("grove.db")).unwrap();
        db.execute(
            "INSERT INTO definitions(kind,id,builtin,name,description,body,enabled,revision,created_at,updated_at) \
             VALUES('agent','reviewer',1,'이전 사용자 이름','이전 사용자 설명','이전 사용자 본문',0,7,'old','old')", [],
        ).unwrap();
    }
    let path = "/api/v1/definitions/agent/reviewer";
    let (_, before) = s.get(path).await;
    assert_eq!(before["modified_fields"], json!(["name", "description", "body"]));
    assert_ne!(before["body"], before["baseline_body"]);
    s.restart().await;
    assert_eq!(s.get(path).await.1, before);
    assert_eq!(s.post(&format!("{path}/restore"), json!({"expected_revision":7})).await.0, StatusCode::NOT_FOUND);
    assert_eq!(s.get(path).await.1, before);
}

#[tokio::test]
async fn unrelated_update_preserves_explicit_overrides_even_when_equal_to_current_bundle() {
    let s = TestServer::start().await;
    let path = "/api/v1/definitions/agent/worker";
    let (_, original) = s.get(path).await;
    {
        let db = Connection::open(s.data_dir().join("grove.db")).unwrap();
        db.execute(
            "INSERT INTO definitions(kind,id,builtin,name,description,body,enabled,revision,created_at,updated_at) \
             VALUES('agent','worker',1,?1,?2,?3,1,1,'old','old')",
            params![original["name"].as_str().unwrap(), original["description"].as_str().unwrap(), original["body"].as_str().unwrap()],
        ).unwrap();
    }
    let (status, updated) = s.send(Method::PUT, path, json!({"expected_revision":1,"enabled":false})).await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    let db = Connection::open(s.data_dir().join("grove.db")).unwrap();
    let stored: (String, String, String) = db.query_row(
        "SELECT name,description,body FROM definitions WHERE kind='agent' AND id='worker'", [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    ).unwrap();
    assert_eq!(stored, (original["name"].as_str().unwrap().to_owned(), original["description"].as_str().unwrap().to_owned(), original["body"].as_str().unwrap().to_owned()));
}
