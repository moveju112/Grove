use crate::common;

use common::TestServer;
use reqwest::{Method, StatusCode};
use serde_json::json;

#[tokio::test]
async fn folders_are_persistent_navigation_groups_and_never_move_or_delete_project_files() {
    let mut server = TestServer::start().await;
    let project = server.create_project("grouped-project").await;
    let project_id = project["id"].as_str().unwrap();
    let root = std::path::PathBuf::from(project["root_path"].as_str().unwrap());
    std::fs::write(root.join("keep.txt"), "original").unwrap();
    let session = server.create_session(project_id).await;
    let (status, folder) = server.post("/api/v1/project-folders", json!({ "name": "  My   projects " })).await;
    assert_eq!(status, StatusCode::CREATED, "{folder}");
    assert_eq!(folder["name"], "My projects");
    let folder_id = folder["id"].as_str().unwrap();
    let path = format!("/api/v1/projects/{project_id}");
    let (status, moved) = server.send(Method::PATCH, &path,
        json!({ "expected_revision": project["revision"], "folder_id": folder_id })).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved["folder_id"], folder_id);
    assert_eq!(moved["root_path"], project["root_path"]);
    assert_eq!(moved["updated_at"], project["updated_at"]);
    let (_, folders) = server.get("/api/v1/project-folders").await;
    assert_eq!(folders[0]["project_count"], 1);
    server.restart().await;
    assert_eq!(server.get(&path).await.1["folder_id"], folder_id);
    let folder_path = format!("/api/v1/project-folders/{folder_id}");
    let (status, renamed) = server.send(Method::PATCH, &folder_path,
        json!({ "expected_revision": folder["revision"], "name": "Renamed" })).await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    let (status, _) = server.send(Method::DELETE, &format!("{folder_path}?expected_revision={}", folder["revision"]), json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, deleted) = server.send(Method::DELETE, &format!("{folder_path}?expected_revision={}", renamed["revision"]), json!({})).await;
    assert_eq!(status, StatusCode::OK, "{deleted}");
    assert_eq!(deleted["affected_project_count"], 1);
    let (_, restored) = server.get(&path).await;
    assert!(restored.get("folder_id").is_none());
    assert_eq!(restored["root_path"], project["root_path"]);
    assert_eq!(std::fs::read_to_string(root.join("keep.txt")).unwrap(), "original");
    assert_eq!(server.get(&format!("/api/v1/sessions/{}", session["id"].as_str().unwrap())).await.0, StatusCode::OK);
    assert_eq!(server.get("/api/v1/project-folders").await.1, json!([]));
}

#[tokio::test]
async fn folder_mutations_validate_names_revisions_membership_and_idempotency() {
    let server = TestServer::start().await;
    let body = json!({ "name": "Work" });
    let first = server.raw(Method::POST, "/api/v1/project-folders", Some(body.clone()), Some("folder-once"), None).await;
    assert_eq!(first.status(), StatusCode::CREATED);
    let first: serde_json::Value = first.json().await.unwrap();
    let replay = server.raw(Method::POST, "/api/v1/project-folders", Some(body), Some("folder-once"), None).await;
    assert_eq!(replay.status(), StatusCode::CREATED);
    assert_eq!(replay.json::<serde_json::Value>().await.unwrap()["id"], first["id"]);
    assert_eq!(server.post("/api/v1/project-folders", json!({ "name": " WORK " })).await.0, StatusCode::CONFLICT);
    assert_eq!(server.post("/api/v1/project-folders", json!({ "name": " " })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(server.post("/api/v1/project-folders", json!({ "name": "x".repeat(81) })).await.0, StatusCode::BAD_REQUEST);
    let other = server.post("/api/v1/project-folders", json!({ "name": "Other" })).await.1;
    assert_eq!(server.send(Method::PATCH, &format!("/api/v1/project-folders/{}", other["id"].as_str().unwrap()),
        json!({ "expected_revision": other["revision"], "name": "work" })).await.0, StatusCode::CONFLICT);
    let project = server.create_project("membership").await;
    let path = format!("/api/v1/projects/{}", project["id"].as_str().unwrap());
    assert_eq!(server.send(Method::PATCH, &path, json!({ "expected_revision": project["revision"], "folder_id": "missing" })).await.0, StatusCode::NOT_FOUND);
    assert_eq!(server.get(&path).await.1["revision"], project["revision"]);
    let moved = server.send(Method::PATCH, &path,
        json!({ "expected_revision": project["revision"], "folder_id": first["id"] })).await.1;
    assert_eq!(server.send(Method::PATCH, &path, json!({ "expected_revision": project["revision"], "folder_id": null })).await.0, StatusCode::CONFLICT);
    let cleared = server.send(Method::PATCH, &path, json!({ "expected_revision": moved["revision"], "folder_id": null })).await.1;
    assert!(cleared.get("folder_id").is_none());
    assert_eq!(server.raw(Method::GET, "/api/v1/project-folders", None, None, Some("")).await.status(), StatusCode::UNAUTHORIZED);
}
