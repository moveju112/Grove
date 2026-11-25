use axum::{Json, Router, http::{StatusCode, header}, routing::any};
use serde_json::json;
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_doctor_and_pair_do_not_follow_redirects_to_other_api_operations() {
    for code in [301, 302, 303, 307, 308] {
        let reached = Arc::new(AtomicUsize::new(0));
        let count = reached.clone();
        let app = Router::new()
            .route("/redirect-target", any(move || {
                let count = count.clone();
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    Json(json!({ "token": "not-a-real-token", "status": "ready", "kind": "owner", "version": "fixture" }))
                }
            }))
            .fallback(any(move || async move {
                (StatusCode::from_u16(code).unwrap(), [(header::LOCATION, "/redirect-target")])
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let listen = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("owner-token"), format!("grv_{}.{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4())).unwrap();
        let mut pair_succeeded = false;
        for command in ["pair", "doctor"] {
            let (directory, listen) = (directory.path().to_path_buf(), listen.clone());
            let output = tokio::task::spawn_blocking(move || {
                std::process::Command::new(env!("CARGO_BIN_EXE_grove"))
                    .arg(command).arg("--data-dir").arg(directory).args(["--listen", &listen]).output().unwrap()
            }).await.unwrap();
            if command == "pair" { pair_succeeded = output.status.success(); }
        }
        server.abort();
        assert_eq!(reached.load(Ordering::SeqCst), 0, "HTTP {code}: 승인한 로컬 API 경로 밖으로 요청을 재전송하면 안 된다");
        assert!(!pair_succeeded, "redirect 응답은 기기 발급 성공이 아니다");
    }
}
