//! 동일 origin 정적 웹앱 제공(WEB-012)과 health·종료 중 접수 차단.

use crate::App;
use crate::error::ApiError;
use axum::Json;
use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

pub async fn health(State(app): State<App>) -> Json<serde_json::Value> {
    let db_ok = app.db.call(|c| Ok(c.query_row("SELECT 1", [], |r| r.get::<_, i64>(0))?)).await.is_ok();
    Json(json!({
        "status": if app.is_shutting_down() { "stopping" } else if db_ok { "ready" } else { "degraded" },
        "version": crate::VERSION,
        "protocol": crate::PROTOCOL_VERSION,
        "capabilities": crate::CAPABILITIES,
        "db": db_ok,
        "schema": app.db.schema_version(),
        // 진단용(UI-031): 실행 중인 빌드 대상
        "target": format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS),
    }))
}

/// 종료가 시작되면 새 상태 변경 요청을 받지 않는다(ARCH-012). 조회는 허용한다.
pub async fn reject_when_shutting_down(State(app): State<App>, req: Request, next: Next) -> Response {
    if app.is_shutting_down() && req.method() != Method::GET {
        return ApiError::new(axum::http::StatusCode::SERVICE_UNAVAILABLE, "shutting_down", "서버가 종료 중입니다")
            .retryable()
            .into_response();
    }
    next.run(req).await
}

pub const PROTOCOL_HEADER: &str = "x-grove-protocol";
/// 요청에 필요한 기능 목록(쉼표 구분). 없으면 기능 검사를 하지 않는다(CLI·도구 호환).
pub const REQUIRE_HEADER: &str = "x-grove-require";

/// 클라이언트·서버 protocol 호환(DEC-014, WEB-022).
/// - 모든 API 응답에 서버 protocol을 붙여 오래 열린 탭이 불일치를 알게 한다.
/// - 클라이언트가 다른 protocol을 밝히고 보낸 변경 요청은 실행하지 않는다(헤더가 없으면 CLI·도구로 보고 허용).
pub async fn protocol_guard(req: Request, next: Next) -> Response {
    let sent = req.headers().get(PROTOCOL_HEADER).and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u32>().ok());
    if let Some(p) = sent
        && p != crate::PROTOCOL_VERSION
        && req.method() != Method::GET
    {
        let mut r = ApiError::conflict("protocol_mismatch", "화면 버전이 서버와 맞지 않아 요청을 실행하지 않았습니다. 새로고침하세요")
            .with_details(json!({ "client_protocol": p, "server_protocol": crate::PROTOCOL_VERSION }))
            .into_response();
        r.headers_mut().insert(PROTOCOL_HEADER, HeaderValue::from(crate::PROTOCOL_VERSION));
        return r;
    }
    // 기능 협상(NET-001): 클라이언트가 밝힌 기능 중 이 서버에 없는 것이 있으면 실행하지 않는다.
    let missing: Vec<String> = req
        .headers()
        .get(REQUIRE_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').map(str::trim).filter(|c| !c.is_empty() && !crate::CAPABILITIES.contains(c)).map(String::from).collect())
        .unwrap_or_default();
    if !missing.is_empty() {
        let mut r = ApiError::conflict("capability_missing", "이 서버는 요청한 기능을 지원하지 않습니다. 서버를 업데이트하세요")
            .with_details(json!({ "missing": missing, "server_capabilities": crate::CAPABILITIES }))
            .into_response();
        r.headers_mut().insert(PROTOCOL_HEADER, HeaderValue::from(crate::PROTOCOL_VERSION));
        return r;
    }
    let mut r = next.run(req).await;
    r.headers_mut().insert(PROTOCOL_HEADER, HeaderValue::from(crate::PROTOCOL_VERSION));
    r
}

/// index.html의 인라인 스크립트만 hash로 허용하는 CSP. `unsafe-inline` 스크립트는 허용하지 않는다.
pub fn csp_for(index_html: &str) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let re = regex::Regex::new(r"(?s)<script(?P<attrs>[^>]*)>(?P<body>.*?)</script>").expect("regex");
    let mut hashes = vec![];
    for c in re.captures_iter(index_html) {
        if c["attrs"].contains("src=") {
            continue;
        }
        let digest = Sha256::digest(c["body"].as_bytes());
        hashes.push(format!("'sha256-{}'", base64::engine::general_purpose::STANDARD.encode(digest)));
    }
    format!(
        "default-src 'self'; script-src 'self' {}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
         connect-src 'self'; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        hashes.join(" ")
    )
}

/// 웹 산출물이 실행 중에 교체되어도 맞는 CSP를 쓰도록 index.html의 mtime·크기가 바뀌면 다시 계산한다.
struct CspCache {
    path: std::path::PathBuf,
    cur: std::sync::Mutex<Option<((std::time::SystemTime, u64), HeaderValue)>>,
}

impl CspCache {
    fn get(&self) -> Option<HeaderValue> {
        let meta = std::fs::metadata(&self.path).ok();
        let stamp = meta.as_ref().map(|m| (m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len()));
        let mut g = self.cur.lock().expect("csp cache");
        if let (Some(s), Some((cs, v))) = (stamp, g.as_ref()) {
            if s == *cs {
                return Some(v.clone());
            }
        }
        let html = std::fs::read_to_string(&self.path).unwrap_or_default();
        let v = HeaderValue::from_str(&csp_for(&html)).ok()?;
        if let Some(s) = stamp {
            *g = Some((s, v.clone()));
        }
        Some(v)
    }
}

pub fn static_routes(app: &App) -> Router<App> {
    let Some(dir) = app.cfg.web_dir.clone() else {
        return Router::new();
    };
    let index = dir.join("index.html");
    let csp_cache = std::sync::Arc::new(CspCache { path: index.clone(), cur: std::sync::Mutex::new(None) });
    // 해시된 자산은 장기 cache, 나머지(index, sw, manifest)는 매번 재검증
    let assets = Router::new()
        .nest_service("/assets", ServeDir::new(dir.join("assets")))
        .layer(SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable")));
    let rest = Router::new()
        .fallback_service(ServeDir::new(&dir).fallback(ServeFile::new(index)))
        .layer(SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-cache")));
    Router::new()
        .merge(assets)
        .merge(rest)
        .layer(SetResponseHeaderLayer::if_not_present(header::CONTENT_SECURITY_POLICY, move |_: &axum::http::Response<_>| csp_cache.get()))
        .layer(SetResponseHeaderLayer::if_not_present(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::if_not_present(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")))
}
