mod common;
use common::TestServer;
use reqwest::{Method, StatusCode};
use serde_json::{Value,json};

#[tokio::test]
async fn connections_are_owner_managed_revisioned_replayable_and_survive_restart_without_credentials_in_views() {
    let mut s = TestServer::start().await;
    let p = s.create_project("connections").await;
    let (_,bot) = s.post("/api/v1/bots",json!({"name":"연결 봇","project_id":p["id"],"profile_id":null})).await;
    let (_,server) = s.post("/api/v1/mcp/servers",json!({"name":"mail","config":{"transport":"stdio","command":"not-started","env_secrets":{}}})).await;
    let path = format!("/api/v1/bots/{}/connections",bot["id"].as_str().unwrap());
    let (_,view) = s.get(&path).await;
    assert_eq!(view["servers"][0],json!({"id":server["id"],"name":"mail","enabled":false,"selected":false}));
    assert!(!view.to_string().contains("not-started"));
    let body = json!({"expected_revision":view["revision"],"server_ids":[server["id"]]});
    let (_,device) = s.post("/api/v1/devices",json!({"name":"device"})).await;
    assert_eq!(s.raw(Method::PUT,&path,Some(body.clone()),Some(&s.key()),device["token"].as_str()).await.status(),StatusCode::FORBIDDEN);
    let key = s.key();
    let first = s.raw(Method::PUT,&path,Some(body.clone()),Some(&key),None).await;
    assert_eq!(first.status(),StatusCode::OK);
    let first: Value = first.json().await.unwrap();
    assert_eq!(first["servers"][0]["selected"],true);
    let replay = s.raw(Method::PUT,&path,Some(body.clone()),Some(&key),None).await;
    assert_eq!(replay.headers()["idempotent-replayed"],"true");
    assert_eq!(replay.json::<Value>().await.unwrap(),first);
    assert_eq!(s.send(Method::PUT,&path,body).await.0,StatusCode::CONFLICT);
    assert_eq!(s.send(Method::PUT,&path,json!({"expected_revision":first["revision"],"server_ids":["missing"]})).await.0,StatusCode::NOT_FOUND);
    s.restart().await;
    assert_eq!(s.get(&path).await.1,first);
    assert_eq!(s.send(Method::PUT,&path,json!({"expected_revision":first["revision"],"server_ids":[]})).await.0,StatusCode::OK);
    assert_eq!(s.get(&path).await.1["servers"][0]["selected"],false);
}
