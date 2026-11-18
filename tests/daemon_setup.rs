mod common;
use common::TestServer;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

const PATH: &str = "/api/v1/daemon-setup";

#[tokio::test]
async fn setup_accepts_a_registered_device_and_is_atomic_and_one_time() {
    let s = TestServer::start_default_permissions().await;
    assert_eq!(s.raw(Method::GET, PATH, None, None, Some("")).await.status(), StatusCode::UNAUTHORIZED);
    let initial = s.raw(Method::GET, PATH, None, None, None).await.json::<Value>().await.unwrap();
    assert_eq!(initial["required"], true);
    assert_eq!(initial["preferences"]["output_style"], "default");
    assert_eq!(initial["preferences"]["computer_enabled"], false);
    let device = s.registered_device("setup device").await;
    let token = device["token"].as_str().unwrap();
    let put = json!({"output_style":"simple", "output_style_revision":0, "computer_enabled":true, "computer_revision":0});
    let status = s.raw(Method::GET, PATH, None, None, Some(token)).await.json::<Value>().await.unwrap();
    assert_eq!(status, initial);

    let mut stale = put.clone();
    stale["computer_revision"] = json!(1);
    assert_eq!(s.raw(Method::PUT, PATH, Some(stale), Some("stale"), None).await.status(), StatusCode::CONFLICT);
    assert_eq!(s.raw(Method::GET, PATH, None, None, None).await.json::<Value>().await.unwrap(), initial);
    let done = json!({"required":false,"preferences":null});
    for _ in 0..2 {
        let response = s.raw(Method::PUT, PATH, Some(put.clone()), Some("finish"), Some(token)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.json::<Value>().await.unwrap(), done);
    }
    let mut late = put;
    late["output_style"] = json!("detailed");
    late["computer_enabled"] = json!(false);
    assert_eq!(s.raw(Method::PUT, PATH, Some(late), Some("late"), None).await.json::<Value>().await.unwrap(), done);
    let db = &s.server.as_ref().unwrap().app.db;
    db.call(|c| {
        assert_eq!(grove::settings::effective(c, "output.style", None, None)?, "simple");
        assert_eq!(grove::settings::effective(c, grove::computer::ENABLED, None, None)?, true);
        Ok(())
    }).await.unwrap();
    assert_eq!(s.raw(Method::GET, PATH, None, None, Some(token)).await.json::<Value>().await.unwrap(), done);
}
