//! 공통 API 오류. 모든 HTTP 오류 응답은 이 형태 하나로 변환한다.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub details: Option<Value>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into(), retryable: false, details: None }
    }
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }
    pub fn unauthorized(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", msg)
    }
    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", msg)
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", msg)
    }
    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", msg)
    }
    pub fn conflict(code: &'static str, msg: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, msg)
    }
    pub fn revision_conflict(current: Value) -> Self {
        Self::conflict("revision_conflict", "자원이 다른 요청으로 변경되었습니다").with_details(json!({ "current": current }))
    }
    pub fn busy(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, "busy", msg).retryable()
    }
    pub fn unsupported(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, "unsupported", msg)
    }
    pub fn gone(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::GONE, "gone", msg)
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        let message = msg.into();
        let correlation = uuid::Uuid::new_v4().to_string();
        tracing::error!(%correlation, "internal error: {message}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", format!("내부 오류 (상관 ID {correlation})"))
            .with_details(json!({ "correlation_id": correlation }))
    }
    pub fn body(&self) -> Value {
        let mut e = json!({ "code": self.code, "message": self.message, "retryable": self.retryable });
        if let Some(d) = &self.details {
            e["details"] = d.clone();
        }
        json!({ "error": e })
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body())).into_response()
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        if let rusqlite::Error::SqliteFailure(f, _) = &e {
            if matches!(f.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) {
                return ApiError::busy("데이터베이스가 잠겨 있습니다").retryable();
            }
            if f.code == rusqlite::ErrorCode::DiskFull {
                return ApiError::new(StatusCode::INSUFFICIENT_STORAGE, "storage_full", "저장 공간이 부족합니다");
            }
        }
        ApiError::internal(format!("sqlite: {e}"))
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(e: serde_json::Error) -> Self {
        ApiError::internal(format!("json: {e}"))
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
