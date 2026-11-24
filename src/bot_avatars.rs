//! 봇 사용자 아바타(BOT-003). 기본형은 색+이니셜(`bots.avatar_color`)이고, 사용자 이미지는 선택이다.
//!
//! - 받는 형식은 내용으로 판별한 PNG·JPEG·GIF·WebP뿐이다(요청 Content-Type·확장자를 믿지 않음). SVG·HTML 등 능동 콘텐츠는 거절한다.
//! - 2MiB·4096×4096·할당 64MiB 안에서 실제로 디코딩하고, 첫 프레임만 256px 안의 PNG로 다시 인코딩해 저장한다.
//!   원본 바이트·메타데이터(EXIF 위치 등)·다중 형식(polyglot) 내용은 저장하지 않는다.
//! - 응답은 `image/png` + `nosniff` + sandbox CSP로 내보낸다. 파일 경로 참조는 받지 않는다(서버 파일 접근 경로가 없음).

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::{events, idem};
use axum::Json;
use axum::extract::{Path, State};
use base64::{Engine, engine::general_purpose::STANDARD};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::json;

pub const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_SIDE: u32 = 4096;
const SIZE: u32 = 256;

/// 검사·디코딩 뒤 정사각 크기 안으로 줄인 PNG(바이트, 원본 형식, 결과 폭·높이).
pub fn normalize(bytes: &[u8]) -> ApiResult<(Vec<u8>, &'static str, u32, u32)> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "아바타 이미지는 2MiB 이하여야 합니다"));
    }
    let mime = crate::attachments::sniff(bytes);
    let format = match mime {
        "image/png" => image::ImageFormat::Png,
        "image/jpeg" => image::ImageFormat::Jpeg,
        "image/gif" => image::ImageFormat::Gif,
        "image/webp" => image::ImageFormat::WebP,
        _ => return Err(ApiError::unsupported("PNG·JPEG·GIF·WebP 이미지만 쓸 수 있습니다(SVG 등 능동 콘텐츠는 받지 않습니다)")),
    };
    let invalid = || ApiError::invalid(format!("이미지를 읽을 수 없습니다(최대 {MAX_SIDE}×{MAX_SIDE})"));
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().map_err(|_| invalid())?;
    let img = if img.width() > SIZE || img.height() > SIZE { img.thumbnail(SIZE, SIZE) } else { img };
    let mut out = std::io::Cursor::new(vec![]);
    img.to_rgba8().write_to(&mut out, image::ImageFormat::Png).map_err(|_| invalid())?;
    Ok((out.into_inner(), mime, img.width(), img.height()))
}

fn bot_exists(c: &rusqlite::Connection, id: &str) -> ApiResult<crate::bots::Bot> {
    let b = crate::bots::get(c, id)?;
    if b.deleted_at.is_some() {
        return Err(ApiError::conflict("deleted", "삭제한 봇입니다"));
    }
    Ok(b)
}

#[derive(Deserialize)]
pub struct AvatarBody {
    /// 이미지 원문(base64). 첨부 업로드와 같은 형식.
    pub data_base64: String,
}

/// 아바타 설정. 같은 Idempotency-Key·같은 이미지는 같은 결과다.
pub async fn put(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<AvatarBody>) -> ApiResult<Response> {
    if b.data_base64.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "아바타 이미지는 2MiB 이하여야 합니다"));
    }
    let body = STANDARD.decode(b.data_base64.trim()).map_err(|_| ApiError::invalid("base64 이미지 내용이 올바르지 않습니다"))?;
    let (png, mime, w, h) = tokio::task::spawn_blocking(move || normalize(&body)).await.map_err(|e| ApiError::internal(e.to_string()))??;
    let sha = crate::util::sha256_hex(&png);
    let hash = idem::body_hash("bot.avatar.put", &json!({ "id": id, "sha": sha }));
    idem::run(&app, &p, &headers, &hash, move |tx, now| {
        bot_exists(tx, &id)?;
        tx.execute(
            "INSERT INTO bot_avatars (bot_id, png, sha256, source_mime, width, height, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(bot_id) DO UPDATE SET png = excluded.png, sha256 = excluded.sha256, source_mime = excluded.source_mime, \
             width = excluded.width, height = excluded.height, updated_at = excluded.updated_at",
            params![id, png, sha, mime, w, h, now],
        )?;
        let v = json!({ "bot_id": id, "avatar_sha256": sha, "width": w, "height": h, "source_mime": mime });
        let b = crate::bots::get(tx, &id)?;
        events::append(tx, now, "bot.changed", Some(&b.project_id), b.home_session_id.as_deref(), &serde_json::to_value(&b)?)?;
        Ok((StatusCode::OK, v))
    })
    .await
}

/// 아바타를 지우고 기본형으로 돌아간다.
pub async fn remove(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Response> {
    let hash = idem::body_hash("bot.avatar.delete", &json!({ "id": id }));
    idem::run(&app, &p, &headers, &hash, move |tx, now| {
        bot_exists(tx, &id)?;
        tx.execute("DELETE FROM bot_avatars WHERE bot_id = ?1", params![id])?;
        let b = crate::bots::get(tx, &id)?;
        events::append(tx, now, "bot.changed", Some(&b.project_id), b.home_session_id.as_deref(), &serde_json::to_value(&b)?)?;
        Ok((StatusCode::OK, json!({ "bot_id": id, "avatar_sha256": null })))
    })
    .await
}

pub async fn get(State(app): State<App>, _p: Principal, Path(id): Path<String>, headers: HeaderMap) -> ApiResult<Response> {
    let row: Option<(Vec<u8>, String)> = app
        .db
        .call(move |c| {
            crate::bots::get(c, &id)?;
            Ok(c.query_row("SELECT png, sha256 FROM bot_avatars WHERE bot_id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?)
        })
        .await?;
    let (png, sha) = row.ok_or_else(|| ApiError::not_found("사용자 아바타가 없습니다(기본형 사용)"))?;
    png_response(&headers, png, &sha)
}

pub(crate) fn png_response(headers: &HeaderMap, png: Vec<u8>, sha: &str) -> ApiResult<Response> {
    let etag = format!("\"{sha}\"");
    let mut res = if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        (StatusCode::OK, png).into_response()
    };
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; sandbox"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-cache"));
    h.insert(header::ETAG, HeaderValue::from_str(&etag).map_err(|e| ApiError::internal(e.to_string()))?);
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(img: image::DynamicImage, f: image::ImageFormat) -> Vec<u8> {
        let mut c = std::io::Cursor::new(vec![]);
        img.write_to(&mut c, f).unwrap();
        c.into_inner()
    }

    #[test]
    fn accepts_raster_images_reencodes_to_bounded_png_and_rejects_active_or_broken_content() {
        let big = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(1000, 500, image::Rgb([10, 200, 30])));
        let (png, mime, w, h) = normalize(&encode(big, image::ImageFormat::Jpeg)).unwrap();
        assert_eq!((mime, w, h), ("image/jpeg", 256, 128));
        assert_eq!(crate::attachments::sniff(&png), "image/png");
        let small = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(16, 16, image::Rgba([1, 2, 3, 255])));
        assert_eq!(normalize(&encode(small, image::ImageFormat::WebP)).unwrap().2, 16, "작은 이미지는 키우지 않는다");
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>"#;
        assert_eq!(normalize(svg).unwrap_err().code, "unsupported");
        assert_eq!(normalize(b"<html><script>x</script>").unwrap_err().code, "unsupported");
        // PNG 서명만 있고 내용이 깨진 파일
        let mut broken = b"\x89PNG\r\n\x1a\n".to_vec();
        broken.extend([0u8; 64]);
        assert_eq!(normalize(&broken).unwrap_err().code, "invalid_request");
        assert_eq!(normalize(&vec![0u8; MAX_BYTES + 1]).unwrap_err().code, "too_large");
    }
}
