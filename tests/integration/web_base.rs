use crate::common;

use common::{TestServer, config};
use reqwest::{Method, StatusCode};

#[test]
fn deployment_base_is_a_safe_path() {
    for (input, expected) in [("", "/"), ("/", "/"), (" grove ", "/grove/"), ("/a//b/", "/a/b/")] {
        assert_eq!(grove::web::normalize_base(input).unwrap(), expected);
    }
    for input in ["//host", "https://host", "/api", "/api/v1", "/a/../b", "/a/./b", "/%2e", "/a?b", "/a#b", "/a\\b", "/a\nb"] {
        assert!(grove::web::normalize_base(input).is_err(), "{input:?}");
    }
}

#[tokio::test]
async fn static_mount_preserves_api_and_asset_boundaries() {
    for base in ["/", "/grove/"] {
        let dir = tempfile::tempdir().unwrap();
        let web = dir.path().join("web");
        std::fs::create_dir_all(web.join("assets")).unwrap();
        std::fs::write(web.join("index.html"), "<!doctype html><title>fixture</title>").unwrap();
        std::fs::write(web.join("assets/app.js"), "/* fixture */").unwrap();
        let mut cfg = config(&dir.path().join("data"));
        cfg.web_dir = Some(web);
        cfg.web_base = base.into();
        let server = TestServer::start_with(dir, cfg).await;
        for path in [base.to_string(), format!("{base}nested/path")] {
            let response = server.raw(Method::GET, &path, None, None, None).await;
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert!(response.text().await.unwrap().contains("<title>fixture</title>"));
        }
        for path in ["/api".to_string(), "/api/not-found".into(), "/api/v1/not-found".into(), format!("{base}api/not-found"), format!("{base}assets/missing.js")] {
            let response = server.raw(Method::GET, &path, None, None, None).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            assert!(!response.text().await.unwrap().contains("<title>fixture</title>"));
        }
        let (status, _) = server.get("/api/v1/auth/whoami").await;
        assert_eq!(status, StatusCode::OK);
        if base != "/" {
            assert_eq!(server.raw(Method::GET, "/", None, None, None).await.status(), StatusCode::NOT_FOUND);
        }
    }
}
