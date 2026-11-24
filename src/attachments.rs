//! 첨부 원문 저장·소유권·참조와 제한된 정리(DB-013·014·019).
use crate::{
    App,
    auth::Principal,
    error::{ApiError, ApiResult},
    events, files, idem,
    util::valid_sha256 as valid_sha,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs::DirEntry,
    io::Read,
    path::{Path as FsPath, PathBuf},
    time::{Duration, SystemTime},
};

pub const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_UPLOAD_BODY_BYTES: usize = MAX_FILE_BYTES.div_ceil(3) * 4 + 4096;
pub const MAX_ATTACHMENTS: usize = 8;
pub(crate) const MAX_MESSAGE_BYTES: i64 = 128 * 1024 * 1024;
// 디코딩 중 원문·픽셀 버퍼가 함께 살아 있으므로 큰 이미지의 동시 처리 수를 제한한다.
static CONTENT_READERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(6);
static IMAGE_WORKERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
const UNATTACHED_TTL: Duration = Duration::from_secs(24 * 3600);


pub(crate) fn blob_path(data: &FsPath, sha: &str) -> PathBuf {
    data.join("attachments/blobs")
        .join(&sha[..2.min(sha.len())])
        .join(sha)
}

const COLS: &str = "a.id,a.project_id,a.name,a.mime,a.size,a.sha256,a.stored,a.created_at,((SELECT COUNT(*) FROM attachment_refs r WHERE r.attachment_id=a.id)+(SELECT COUNT(*) FROM followup_attachment_refs f WHERE f.attachment_id=a.id)),a.image";
fn row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":r.get::<_,String>(0)?,"project_id":r.get::<_,String>(1)?,"name":r.get::<_,String>(2)?,"mime":r.get::<_,String>(3)?,"size":r.get::<_,i64>(4)?,"sha256":r.get::<_,String>(5)?,"stored":r.get::<_,bool>(6)?,"created_at":r.get::<_,String>(7)?,"ref_count":r.get::<_,i64>(8)?,"image":r.get::<_,Option<String>>(9)?.and_then(|s|serde_json::from_str::<Value>(&s).ok())}),
    )
}
fn get(c: &Connection, id: &str) -> ApiResult<Value> {
    c.query_row(
        &format!("SELECT {COLS} FROM attachments a WHERE a.id=?1"),
        [id],
        row,
    )
    .optional()?
    .ok_or_else(|| ApiError::not_found("첨부파일이 없습니다"))
}
fn authorized(c: &Connection, id: &str, owner: &str) -> ApiResult<Value> {
    let v = get(c, id)?;
    let uploader: String =
        c.query_row("SELECT owner_id FROM attachments WHERE id=?1", [id], |r| {
            r.get(0)
        })?;
    // 전송 전 임시 업로드는 업로더만 볼 수 있다. 메시지에 연결된 원문은 같은 서버의 기기들이 열람한다.
    if uploader != owner && v["ref_count"] == 0 {
        return Err(ApiError::not_found("첨부파일이 없습니다"));
    }
    Ok(v)
}
// atomic_write가 만든 정확한 임시 이름만 정리한다. 임의 파일명은 건드리지 않는다.
fn staging_sha(name: &str) -> Option<&str> {
    let sha = crate::tools::fs::atomic_staging_target(name)?;
    valid_sha(sha).then_some(sha)
}

fn name_valid(name: &str) -> bool {
    !name.trim().is_empty()
        && name.len() <= 255
        && !name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
        && !matches!(name, "." | "..")
}
pub(crate) fn sniff(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else if bytes.get(4..8) == Some(b"ftyp") {
        match bytes.get(8..12) {
            Some(b"qt  ") => "video/quicktime",
            Some(b"M4A ") => "audio/mp4",
            Some(b"isom" | b"iso2" | b"iso5" | b"iso6" | b"mp41" | b"mp42" | b"avc1" | b"M4V " | b"dash") => "video/mp4",
            _ => "application/octet-stream",
        }
    } else if bytes.starts_with(b"\x1a\x45\xdf\xa3")
        && bytes[..bytes.len().min(4096)].windows(7).any(|w| w == b"\x42\x82\x84webm") {
        "video/webm"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE") {
        "audio/wav"
    } else if bytes.starts_with(b"OggS") && bytes.get(..bytes.len().min(128)).is_some_and(|header|
        header.windows(8).any(|w| w == b"OpusHead") || header.windows(7).any(|w| w == b"\x01vorbis")) {
        "audio/ogg"
    } else if bytes.starts_with(b"ID3") || bytes.get(..2).is_some_and(|b| b[0] == 0xff && b[1] & 0xe6 == 0xe2) {
        "audio/mpeg"
    } else if std::str::from_utf8(bytes).is_ok()
        && !bytes
            .iter()
            .any(|b| *b < 32 && !matches!(b, b'\t' | b'\n' | b'\r'))
    {
        "text/plain"
    } else {
        "application/octet-stream"
    }
}
fn read_verified(data: &FsPath, v: &Value) -> ApiResult<Vec<u8>> {
    let sha = v["sha256"]
        .as_str()
        .filter(|s| valid_sha(s))
        .ok_or_else(|| ApiError::gone("첨부파일 hash가 잘못되었습니다"))?;
    let p = blob_path(data, sha);
    let m = p.symlink_metadata().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ApiError::gone("첨부 원문이 없습니다")
        } else {
            files::io_err(e, "첨부 확인")
        }
    })?;
    if !m.is_file()
        || m.file_type().is_symlink()
        || m.len() > MAX_FILE_BYTES as u64
        || m.len() != v["size"].as_u64().unwrap_or(u64::MAX)
    {
        return Err(ApiError::gone("첨부 원문이 손상되었습니다"));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(p)
        .map_err(|e| files::io_err(e, "첨부 읽기"))?
        .take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| files::io_err(e, "첨부 읽기"))?;
    if crate::util::sha256_hex(&bytes) != sha {
        return Err(ApiError::gone("첨부 원문 hash가 다릅니다"));
    }
    Ok(bytes)
}

/// 원문은 보존하고, 메모리·해상도를 제한한 첫 프레임만 모델에 보낸다.
fn decode_image(bytes: &[u8]) -> ApiResult<image::DynamicImage> {
    use image::ImageDecoder;
    let invalid = || ApiError::invalid("이미지를 읽을 수 없습니다(최대 8192×8192, 1600만 픽셀)");
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| invalid())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|_| invalid())?;
    let (w, h) = decoder.dimensions();
    if u64::from(w) * u64::from(h) > 16_000_000 {
        return Err(invalid());
    }
    let orientation = decoder.orientation().map_err(|_| invalid())?;
    let mut img = image::DynamicImage::from_decoder(decoder).map_err(|_| invalid())?;
    img.apply_orientation(orientation);
    Ok(img)
}

fn model_thumbnail(bytes: &[u8]) -> ApiResult<(Value, image::DynamicImage)> {
    let img = decode_image(bytes)?;
    let (w, h) = (img.width(), img.height());
    let thumbnail = img.thumbnail(w.min(1024), h.min(1024));
    let meta = json!({"width":w,"height":h,"model_width":thumbnail.width(),"model_height":thumbnail.height(),"model_mime":"image/jpeg","frame":0});
    Ok((meta, thumbnail))
}

pub(crate) fn model_image(bytes: &[u8]) -> ApiResult<(Value, Vec<u8>)> {
    let (meta, thumbnail) = model_thumbnail(bytes)?;
    let mut rgb = thumbnail.to_rgba8();
    // 투명 픽셀을 흰 배경에 합성해서 JPEG의 검은 배경·숨은 RGB가 모델 입력을 바꾸지 않게 한다.
    for p in rgb.pixels_mut() {
        let a = u32::from(p[3]);
        for i in 0..3 {
            p[i] = ((u32::from(p[i]) * a + 255 * (255 - a) + 127) / 255) as u8;
        }
        p[3] = 255;
    }
    let img = image::DynamicImage::ImageRgba8(rgb).to_rgb8();
    let mut encoded = vec![];
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 80)
        .encode_image(&img)
        .map_err(|_| ApiError::invalid("이미지를 변환할 수 없습니다"))?;
    Ok((meta, encoded))
}

/// DB에는 ID·hash만 보관한다. 실제 provider 요청 직전에 검증한 원문에서만 이미지를 만든다.
pub fn hydrate(
    c: &Connection,
    data: &FsPath,
    project: &str,
    msgs: &mut [crate::provider::ChatMsg],
) -> ApiResult<()> {
    let mut cache = std::collections::HashMap::<String, String>::new();
    let mut count = 0usize;
    let mut total = 0usize;
    for msg in msgs {
        let crate::provider::ChatMsg::User { images, .. } = msg else {
            continue;
        };
        for image in images {
            count += 1;
            if count > 32 {
                return Err(ApiError::invalid(
                    "이미지 문맥은 32개까지 지원합니다. 새 대화를 시작하세요",
                ));
            }
            let v = get(c, &image.id)?;
            if v["project_id"] != project
                || v["sha256"] != image.sha256
                || v["ref_count"].as_i64().unwrap_or(0) == 0
            {
                return Err(ApiError::gone("이미지 참조가 올바르지 않습니다"));
            }
            let encoded = if let Some(b) = cache.get(&image.sha256) {
                b.clone()
            } else {
                let (meta, bytes) = model_image(&read_verified(data, &v)?)?;
                if meta["model_width"] != image.width
                    || meta["model_height"] != image.height
                    || image.mime != "image/jpeg"
                {
                    return Err(ApiError::gone("이미지 입력 metadata가 다릅니다"));
                }
                let b = STANDARD.encode(bytes);
                cache.insert(image.sha256.clone(), b.clone());
                b
            };
            total = total.saturating_add(encoded.len());
            if total > 8 * 1024 * 1024 {
                return Err(ApiError::invalid(
                    "이미지 모델 입력이 8MiB를 넘습니다. 새 대화를 시작하세요",
                ));
            }
            image.data = encoded;
        }
    }
    Ok(())
}

/// 실제 이력에 포함된 메시지의 참조만 사용한다. 호스트 경로는 DB나 HTTP 응답에 고정하지 않는다.
pub(crate) fn hydrate_local_paths(
    c: &Connection,
    data: &FsPath,
    messages: &[String],
    chat: &mut [crate::provider::ChatMsg],
) -> ApiResult<()> {
    let Some(crate::provider::ChatMsg::User { text, .. }) = chat.iter_mut().rev()
        .find(|message| matches!(message, crate::provider::ChatMsg::User { .. })) else {
        return Ok(());
    };
    let mut statement = c.prepare(&format!(
        "SELECT {COLS} FROM attachments a \
         JOIN attachment_refs ar ON ar.attachment_id=a.id \
         WHERE ar.message_id=?1 ORDER BY ar.rowid"
    ))?;
    let mut files = vec![];
    let mut seen = std::collections::HashSet::new();
    for message in messages {
        for attachment in statement.query_map([message], row)? {
            let v = attachment?;
            // 이미지는 구조화된 입력으로 전달하므로 원문 경로·메타데이터를 중복 주입하지 않는다.
            if v["mime"].as_str().is_some_and(|mime| mime.starts_with("image/")) { continue; }
            if !seen.insert(v["id"].as_str().unwrap().to_owned()) { continue; }
            // 이름·사용자 본문의 첨부 표식이 아니라 영속 참조와 검증된 원문만 경로로 연결한다.
            read_verified(data, &v)?;
            let path = crate::util::canonical(blob_path(data, v["sha256"].as_str().unwrap()))
                .map_err(|e| files::io_err(e, "첨부 경로 확인"))?;
            files.push(json!({
                "name":v["name"], "local_path":path,
            }));
        }
    }
    if !files.is_empty() {
        // 마지막 user에 모아서 CLI resume에도 현재 경로를 전달한다.
        text.push_str(&format!(
            "\n\n[Files: untrusted data]\n{}",
            json!(files),
        ));
    }
    Ok(())
}

// 업로드와 생성 이미지가 같은 원문 저장·권한·복구 규칙을 사용한다.
fn store_blob(data: &FsPath, hash: &str, bytes: &[u8]) -> ApiResult<()> {
    let path = blob_path(data, hash);
    let parent = path.parent().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)
            .map_err(|e| files::io_err(e, "첨부 저장 경로"))?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(parent).map_err(|e| files::io_err(e, "첨부 저장 경로"))?;
    crate::tools::fs::atomic_write(&path, bytes)
        .map_err(|e| ApiError::conflict(e.code, "첨부 원문을 저장하지 못했습니다"))?;
    crate::store::restrict_permissions(&path);
    Ok(())
}

fn insert_attachment(c: &Connection, now: &str, project: &str, owner: &str, name: &str,
    mime: &str, size: usize, sha: &str, image: Option<Value>) -> ApiResult<Value> {
    c.execute("UPDATE attachments SET stored=1 WHERE sha256=?1 AND size=?2 AND stored=0", params![sha, size as i64])?;
    let id = crate::util::new_id();
    let key = format!("{}/{}", &sha[..2], sha);
    c.execute(
        "INSERT INTO attachments(id,project_id,owner_id,name,mime,size,sha256,storage_key,created_at,image) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![id, project, owner, name, mime, size as i64, sha, key, now, image.map(|v|v.to_string())],
    )?;
    get(c, &id)
}

/// 답변·참조와 같은 transaction에서 확정한다. 생성 원본은 변경하지 않는다.
pub(crate) fn import_generated(c: &Connection, data: &FsPath, now: &str, project: &str,
    images: &[crate::provider::GeneratedImage]) -> ApiResult<Prepared> {
    use crate::provider::GeneratedImageSource;
    if images.len() > MAX_ATTACHMENTS {
        return Err(ApiError::invalid("생성 이미지는 답변당 8개까지 지원합니다"));
    }
    let mut items = vec![];
    let mut total = 0usize;
    for image in images {
        let bytes = match &image.source {
            GeneratedImageSource::Base64(encoded) => {
                let encoded = if let Some(url) = encoded.strip_prefix("data:") {
                    let (mime, data) = url.split_once(";base64,")
                        .filter(|(mime, _)| matches!(*mime, "image/png" | "image/jpeg" | "image/gif" | "image/webp"))
                        .ok_or_else(|| ApiError::invalid("생성 이미지 형식이 올바르지 않습니다"))?;
                    let _ = mime;
                    data
                } else { encoded };
                if encoded.len() > MAX_FILE_BYTES.div_ceil(3) * 4 {
                    return Err(ApiError::invalid("생성 이미지 크기가 첨부 한도를 넘었습니다"));
                }
                STANDARD.decode(encoded).map_err(|_| ApiError::invalid("생성 이미지를 읽을 수 없습니다"))?
            }
            GeneratedImageSource::File { root, path } => crate::project_fs::ProjectFs::open(root)
                .and_then(|fs| fs.read(path, MAX_FILE_BYTES as u64))
                .map_err(|_| ApiError::gone("생성 이미지 원문을 읽을 수 없습니다"))?,
        };
        total = total.saturating_add(bytes.len());
        if bytes.len() > MAX_FILE_BYTES || total > MAX_MESSAGE_BYTES as usize {
            return Err(ApiError::invalid("생성 이미지 크기가 첨부 한도를 넘었습니다"));
        }
        let mime = sniff(&bytes);
        let ext = match mime {
            "image/png" => "png", "image/jpeg" => "jpg", "image/gif" => "gif", "image/webp" => "webp",
            _ => return Err(ApiError::invalid("생성 결과가 지원하는 이미지 형식이 아닙니다")),
        };
        let meta = model_thumbnail(&bytes)?.0;
        let sha = crate::util::sha256_hex(&bytes);
        if items.iter().any(|v: &Value| v["sha256"] == sha) { continue; }
        store_blob(data, &sha, &bytes)?;
        let name = format!("generated-{}.{}", items.len() + 1, ext);
        let mut v = insert_attachment(c, now, project, "generated", &name, mime, bytes.len(), &sha, Some(meta))?;
        v["ref_count"] = json!(1);
        items.push(v);
    }
    Ok(Prepared { items, model_input: Value::Null })
}

/// 모델 답변 끝의 명시적인 결과 파일 목록. 일반 Markdown 경로는 자동으로 첨부하지 않는다.
pub(crate) fn media_manifest(text: &str) -> Option<(&str, &str)> {
    let body = text.trim_end().strip_suffix("```")?;
    let (reply, paths) = if let Some(paths) = body.strip_prefix("```grove-media\n") {
        ("", paths)
    } else {
        body.rsplit_once("\n```grove-media\n")?
    };
    let paths = paths.strip_suffix('\n')?;
    if paths.trim().is_empty() || paths.lines().any(|line| line.contains("```")) { return None; }
    Some((reply.trim_end(), paths))
}

/// 동일한 첨부 저장·참조 경로를 사용하되 지정한 프로젝트 실행 루트 안에서만 읽는다.
pub(crate) fn import_project_media(c: &Connection, data: &FsPath, now: &str, project: &str,
    root: &FsPath, paths: &str, prepared: &mut Prepared) -> ApiResult<usize> {
    let paths = paths.lines().map(str::trim).filter(|line| !line.is_empty());
    let Ok(fs) = crate::project_fs::ProjectFs::open(root) else { return Ok(paths.count()); };
    let mut total: u64 = prepared.items.iter().filter_map(|item| item["size"].as_u64()).sum();
    let mut skipped = 0;
    for (i, path) in paths.enumerate() {
        let relative = FsPath::new(path);
        let name = relative.file_name().and_then(|name| name.to_str()).filter(|name| name_valid(name));
        if i >= MAX_ATTACHMENTS || prepared.items.len() >= MAX_ATTACHMENTS || path.len() > 1024
            || path.contains(['\\', ':']) || path.chars().any(char::is_control)
            || relative.components().any(|part| !matches!(part, std::path::Component::Normal(_))) {
            skipped += 1;
            continue;
        }
        let Some(name) = name else { skipped += 1; continue; };
        let Ok(bytes) = fs.read(&root.join(relative), MAX_FILE_BYTES as u64) else { skipped += 1; continue; };
        let mime = sniff(&bytes);
        let image = if mime.starts_with("image/") {
            let Ok((meta, _)) = model_thumbnail(&bytes) else { skipped += 1; continue; };
            Some(meta)
        } else if mime.starts_with("video/") || mime.starts_with("audio/") {
            None
        } else {
            skipped += 1;
            continue;
        };
        let sha = crate::util::sha256_hex(&bytes);
        if prepared.items.iter().any(|item| item["sha256"] == sha) { continue; }
        if total + bytes.len() as u64 > MAX_MESSAGE_BYTES as u64 { skipped += 1; continue; }
        total += bytes.len() as u64;
        store_blob(data, &sha, &bytes)?;
        let mut item = insert_attachment(c, now, project, "generated", name, mime, bytes.len(), &sha, image)?;
        item["ref_count"] = json!(1);
        prepared.items.push(item);
    }
    Ok(skipped)
}

#[derive(Deserialize)]
pub struct Upload {
    pub name: String,
    pub data_base64: String,
}
pub async fn upload(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path(pid): Path<String>,
    Json(b): Json<Upload>,
) -> ApiResult<Response> {
    if !name_valid(&b.name) {
        return Err(ApiError::invalid(
            "파일명은 경로·제어 문자 없이 255바이트 이하여야 합니다",
        ));
    }
    if b.data_base64.len() > MAX_FILE_BYTES.div_ceil(3) * 4 {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file_too_large",
            "첨부파일은 32MiB 이하여야 합니다",
        ));
    }
    let bytes = STANDARD
        .decode(&b.data_base64)
        .map_err(|_| ApiError::invalid("base64 파일 내용이 올바르지 않습니다"))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file_too_large",
            "첨부파일은 32MiB 이하여야 합니다",
        ));
    }
    let sha = crate::util::sha256_hex(&bytes);
    let mime = sniff(&bytes);
    let h = idem::body_hash(
        "attachment.upload",
        &json!({"project":pid,"name":b.name,"sha256":sha}),
    );
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? {
        return Ok(r);
    }
    let project = pid.clone();
    app.db
        .call(move |c| crate::projects::active_root(c, &project))
        .await?;
    let data = app.cfg.data_dir.clone();
    let hash = sha.clone();
    let size = bytes.len();
    // 같은 내용은 같은 저장 경로로 수렴한다. DB 실패 후 남은 고아 파일은 유예 후 정리한다.
    let (image, bytes) = if mime.starts_with("image/") {
        let permit = IMAGE_WORKERS.acquire().await.map_err(|_| ApiError::internal("image worker"))?;
        tokio::task::spawn_blocking(move || -> ApiResult<_> {
            let _permit = permit;
            Ok((Some(model_thumbnail(&bytes)?.0), bytes))
        }).await.map_err(|_| ApiError::internal("image worker"))??
    } else { (None, bytes) };
    let _guard = app.storage.mutations.lock().await;
    if let Some(r) = idem::replay(&app, &p, &headers, &h).await? {
        return Ok(r);
    }
    tokio::task::spawn_blocking(move || store_blob(&data, &hash, &bytes))
        .await.map_err(|_| ApiError::internal("attachment upload worker"))??;
    let owner = p.root_id.clone();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        crate::projects::active_root(tx, &pid)?;
        // 미전송 원문과 파일명은 업로더에게만 응답하고 공용 이벤트에는 싣지 않는다.
        let v = insert_attachment(tx, now, &pid, &owner, &b.name, mime, size, &sha, image)?;
        Ok((StatusCode::CREATED, v))
    })
    .await
}

pub async fn show(
    State(app): State<App>,
    p: Principal,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        app.db.call(move |c| authorized(c, &id, &p.root_id)).await?,
    ))
}
#[derive(Deserialize)]
pub struct ContentQuery {
    preview: Option<String>,
}
pub async fn content(
    State(app): State<App>,
    p: Principal,
    Path(id): Path<String>,
    Query(query): Query<ContentQuery>,
) -> ApiResult<Response> {
    let data = app.cfg.data_dir.clone();
    let v = app.db.call(move |c| authorized(c, &id, &p.root_id)).await?;
    let thumbnail = query.preview.as_deref() == Some("image") && v["mime"].as_str().is_some_and(|m| m.starts_with("image/"));
    let permit = if thumbnail { Some(IMAGE_WORKERS.acquire().await.map_err(|_| ApiError::internal("image worker"))?) } else { None };
    let reader = CONTENT_READERS.acquire().await.map_err(|_| ApiError::internal("attachment reader"))?;
    let (bytes, mime) = tokio::task::spawn_blocking(move || -> ApiResult<_> {
        let _reader = reader;
        let _permit = permit;
        let mut bytes = read_verified(&data, &v)?;
        let mut mime = v["mime"].as_str().unwrap_or("application/octet-stream");
        if thumbnail {
            let img = decode_image(&bytes)?;
            let thumb = img.thumbnail(img.width().min(160), img.height().min(160));
            bytes = Vec::new();
            thumb.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
                .map_err(|_| ApiError::internal("thumbnail encoding"))?;
            mime = "image/png";
        } else if query.preview.as_deref() == Some("text") && mime == "text/plain" {
            let text = std::str::from_utf8(&bytes).map_err(|_| ApiError::gone("첨부 텍스트 인코딩이 다릅니다"))?;
            if let Some((end, _)) = text.char_indices().nth(8192) { bytes = bytes[..end].to_vec(); }
        }
        Ok((bytes, mime.to_owned()))
    }).await.map_err(|_| ApiError::internal("attachment read worker"))??;
    let mut resp = bytes.into_response();
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, mime.parse().unwrap());
    h.insert(header::CONTENT_DISPOSITION, "attachment".parse().unwrap());
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        "sandbox; default-src 'none'".parse().unwrap(),
    );
    h.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    h.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    Ok(resp)
}

/// 참조된 원문은 메시지와 함께 보존한다. 이 API는 업로더의 미전송 첨부만 삭제한다.
pub async fn remove(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let h = idem::body_hash("attachment.remove", &json!({"id":id}));
    let owner = p.root_id.clone();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let v = authorized(tx, &id, &owner)?;
        if v["ref_count"].as_i64().unwrap_or(0) > 0 {
            return Err(ApiError::conflict(
                "attachment_referenced",
                "메시지에 연결된 첨부는 지울 수 없습니다",
            ));
        }
        tx.execute("DELETE FROM attachments WHERE id=?1", [&id])?;
        events::append(
            tx,
            now,
            "attachment.updated",
            v["project_id"].as_str(),
            None,
            &json!({"id":id,"deleted":true}),
        )?;
        Ok((StatusCode::OK, json!({"id":id,"deleted":true})))
    })
    .await
}

/// 참조 연결 전 검증 결과. 원문은 파일로 유지하고 모델 입력에는 명시된 크기의 발췌만 넣는다.
#[derive(Default)]
pub struct Prepared {
    pub items: Vec<Value>,
    pub model_input: Value,
}
pub fn prepare(
    c: &Connection,
    data: &FsPath,
    owner: &str,
    project: &str,
    text: &str,
    ids: &[String],
) -> ApiResult<Prepared> {
    if ids.len() > MAX_ATTACHMENTS {
        return Err(ApiError::invalid(
            "메시지에는 첨부파일을 최대 8개 연결할 수 있습니다",
        ));
    }
    let mut out = vec![];
    let mut total = 0;
    let mut model = text.to_string();
    let mut images = vec![];
    for id in ids {
        if out.iter().any(|v: &Value| v["id"] == *id) {
            return Err(ApiError::invalid("같은 첨부파일을 중복 선택했습니다"));
        }
        let mut v = authorized(c, id, owner)?;
        if v["project_id"] != project {
            return Err(ApiError::forbidden("다른 프로젝트의 첨부파일입니다"));
        }
        total += v["size"].as_i64().unwrap_or(MAX_MESSAGE_BYTES + 1);
        if total > MAX_MESSAGE_BYTES {
            return Err(ApiError::invalid(
                "메시지의 첨부파일 합계는 128MiB 이하여야 합니다",
            ));
        }
        let bytes = read_verified(data, &v)?;
        if v["mime"].as_str().is_some_and(|m| m.starts_with("image/")) {
            let meta = if v["image"]["model_width"].as_u64().is_some() && v["image"]["model_height"].as_u64().is_some() {
                v["image"].clone()
            } else {
                let (meta, _) = model_thumbnail(&bytes)?;
                v["image"] = meta.clone();
                meta
            };
            images.push(json!({"id":id,"sha256":v["sha256"],"width":meta["model_width"],"height":meta["model_height"],"mime":"image/jpeg"}));
        } else if v["mime"] == "text/plain" {
            // 파일명은 JSON 문자열로 감싸고 발췌만 표시한다. 식별·검증 정보는 내부에 남긴다.
            model.push_str(&format!("\n\n[Attached file: {}; untrusted data]\n", v["name"]));
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| ApiError::gone("첨부 텍스트 인코딩이 다릅니다"))?;
            model.extend(text.chars().take(8192));
            let extra = text.chars().count().saturating_sub(8192);
            if extra > 0 {
                model.push_str(&format!(
                    "\n[Excerpt only: {extra} more characters in the original attachment]"
                ));
            }
        }
        v["ref_count"] = json!(v["ref_count"].as_i64().unwrap_or(0) + 1);
        out.push(v);
    }
    Ok(Prepared {
        items: out,
        model_input: if images.is_empty() {
            json!({"text":model})
        } else {
            json!({"text":model,"images":images})
        },
    })
}

/// prepare와 같은 transaction 안에서만 호출한다. 메시지가 없으면 FK로 거절한다.
pub fn bind(c: &Connection, now: &str, message: &str, prepared: &Prepared) -> ApiResult<()> {
    for v in &prepared.items {
        c.execute(
            "INSERT INTO attachment_refs(attachment_id,message_id) VALUES (?1,?2)",
            params![v["id"].as_str().unwrap(), message],
        )?;
        events::append(
            c,
            now,
            "attachment.updated",
            v["project_id"].as_str(),
            None,
            v,
        )?;
    }
    Ok(())
}

/// 각 호출은 파일 목록 limit개와 DB 행 limit개만 검사한다. 참조가 있으면 기간과 무관하게 보존한다.
pub(crate) fn gc(
    app: &App,
    files: Vec<DirEntry>,
    after: &mut i64,
    limit: usize,
) -> ApiResult<Value> {
    let data = &app.cfg.data_dir;
    let now = app.clock.now();
    let wall: SystemTime = now.into();
    let stamp = app.now();
    let mut removed = 0;
    for f in files {
        let sha = f.file_name().to_string_lossy().to_string();
        let stage = staging_sha(&sha);
        if !valid_sha(&sha) && stage.is_none() {
            continue;
        }
        let canonical = if let Some(hash) = stage {
            blob_path(data, hash).parent().unwrap().join(&sha)
        } else {
            blob_path(data, &sha)
        };
        if f.path() != canonical
            || !f
                .file_type()
                .map_err(|e| files::io_err(e, "첨부 정리 항목"))?
                .is_file()
        {
            continue;
        }
        let modified = f
            .metadata()
            .and_then(|m| m.modified())
            .map_err(|e| files::io_err(e, "첨부 수정 시각"))?;
        if wall.duration_since(modified).unwrap_or_default() < crate::storage::BLOB_GRACE {
            continue;
        }
        removed += app.db.call_sync(|c| {
            let used: bool = stage.is_none()
                && c.query_row(
                    "SELECT EXISTS(SELECT 1 FROM attachments WHERE sha256=?1)",
                    [&sha],
                    |r| r.get(0),
                )?;
            if used {
                return Ok(0);
            }
            std::fs::remove_file(f.path()).map_err(|e| files::io_err(e, "첨부 고아 파일 정리"))?;
            Ok(1)
        })?;
    }
    let rows: Vec<(i64, String)> = app.db.call_sync(|c| {
        let mut st =
            c.prepare("SELECT rowid,id FROM attachments WHERE rowid>?1 ORDER BY rowid LIMIT ?2")?;
        Ok(st
            .query_map(params![*after, limit as i64], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect::<Result<_, _>>()?)
    })?;
    let mut missing = 0;
    let mut expired = 0;
    for (_, id) in &rows {
        let (m, e) = app.db.call_sync(|c| {
            let tx = c.transaction()?;
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM attachments WHERE id=?1)",
                [id],
                |r| r.get(0),
            )?;
            if !exists {
                return Ok((0, 0));
            }
            let v = get(&tx, id)?;
            let age = crate::util::parse_time(v["created_at"].as_str().unwrap_or(""))
                .map(|t| wall.duration_since(SystemTime::from(t)).unwrap_or_default())
                .unwrap_or_default();
            if v["ref_count"] == 0 && age >= UNATTACHED_TTL {
                tx.execute("DELETE FROM attachments WHERE id=?1", [id])?;
                events::append(
                    &tx,
                    &stamp,
                    "attachment.updated",
                    v["project_id"].as_str(),
                    None,
                    &json!({"id":id,"deleted":true}),
                )?;
                tx.commit()?;
                return Ok((0, 1));
            }
            let sha = v["sha256"].as_str().unwrap_or("");
            let missing = if !valid_sha(sha) {
                true
            } else {
                match blob_path(data, sha).symlink_metadata() {
                    Ok(m) => {
                        !m.file_type().is_file()
                            || m.len() != v["size"].as_u64().unwrap_or(u64::MAX)
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
                    Err(e) => return Err(files::io_err(e, "첨부 원문 확인")),
                }
            };
            if missing && v["stored"] == true {
                tx.execute("UPDATE attachments SET stored=0 WHERE id=?1", [id])?;
                let updated = if v["ref_count"] == 0 {
                    json!({"id":id,"stored":false})
                } else {
                    get(&tx, id)?
                };
                events::append(
                    &tx,
                    &stamp,
                    "attachment.updated",
                    v["project_id"].as_str(),
                    None,
                    &updated,
                )?;
                tx.commit()?;
                return Ok((1, 0));
            }
            tx.commit()?;
            Ok((0, 0))
        })?;
        missing += m;
        expired += e;
    }
    *after = if rows.len() < limit {
        0
    } else {
        rows.last().unwrap().0
    };
    Ok(
        json!({"orphan_files_removed":removed,"missing_marked":missing,"unattached_expired":expired}),
    )
}

#[cfg(test)]
mod image_tests {
    use super::*;
    #[test]
    fn jpeg_orientation_is_applied_without_upscaling() {
        let img = image::RgbImage::from_pixel(3, 7, image::Rgb([255, 0, 0]));
        let mut jpeg = vec![];
        image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
            .encode_image(&img)
            .unwrap();
        let exif = b"Exif\0\0II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
        let mut oriented = jpeg[..2].to_vec();
        oriented.extend_from_slice(b"\xff\xe1");
        oriented.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        oriented.extend_from_slice(exif);
        oriented.extend_from_slice(&jpeg[2..]);
        let (meta, bytes) = model_image(&oriented).unwrap();
        assert_eq!(
            (meta["width"].as_u64(), meta["height"].as_u64()),
            (Some(7), Some(3))
        );
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (7, 3));
    }
    #[test]
    fn gif_uses_first_frame_and_webp_is_supported() {
        let mut gif = vec![];
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut gif);
            encoder
                .encode_frames(
                    [image::Rgba([255, 0, 0, 255]), image::Rgba([0, 255, 0, 255])]
                        .into_iter()
                        .map(|color| image::Frame::new(image::RgbaImage::from_pixel(8, 4, color))),
                )
                .unwrap();
        }
        let (_, bytes) = model_image(&gif).unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap().to_rgb8();
        let p = decoded.get_pixel(0, 0);
        assert!(p[0] > 240 && p[1] < 20, "첫 프레임을 보낸다");
        let mut webp = std::io::Cursor::new(vec![]);
        image::DynamicImage::ImageRgb8(decoded)
            .write_to(&mut webp, image::ImageFormat::WebP)
            .unwrap();
        assert_eq!(sniff(webp.get_ref()), "image/webp");
        let (meta, _) = model_image(webp.get_ref()).unwrap();
        assert_eq!(meta["model_width"], 8);
        assert_eq!(meta["model_height"], 4);
    }
}
