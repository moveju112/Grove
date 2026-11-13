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
    extract::{Path, State},
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

pub const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_ATTACHMENTS: usize = 8;
const MAX_MESSAGE_BYTES: i64 = 8 * 1024 * 1024;
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
pub(crate) fn model_image(bytes: &[u8]) -> ApiResult<(Value, Vec<u8>)> {
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
    let (w, h) = (img.width(), img.height());
    let mut rgb = img.thumbnail(w.min(1024), h.min(1024)).to_rgba8();
    // 투명 픽셀을 흰 배경에 합성해서 JPEG의 검은 배경·숨은 RGB가 모델 입력을 바꾸지 않게 한다.
    for p in rgb.pixels_mut() {
        let a = u32::from(p[3]);
        for i in 0..3 {
            p[i] = ((u32::from(p[i]) * a + 255 * (255 - a) + 127) / 255) as u8;
        }
        p[3] = 255;
    }
    let img = image::DynamicImage::ImageRgba8(rgb).to_rgb8();
    let meta = json!({"width":w,"height":h,"model_width":img.width(),"model_height":img.height(),"model_mime":"image/jpeg","frame":0});
    let mut encoded = vec![];
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 80)
        .encode_image(&img)
        .map_err(|_| invalid())?;
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
            "첨부파일은 4MiB 이하여야 합니다",
        ));
    }
    let bytes = STANDARD
        .decode(&b.data_base64)
        .map_err(|_| ApiError::invalid("base64 파일 내용이 올바르지 않습니다"))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file_too_large",
            "첨부파일은 4MiB 이하여야 합니다",
        ));
    }
    let sha = crate::util::sha256_hex(&bytes);
    let mime = sniff(&bytes);
    let h = idem::body_hash(
        "attachment.upload",
        &json!({"project":pid,"name":b.name,"sha256":sha}),
    );
    let _guard = app.storage.mutations.lock().await;
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
    let image = tokio::task::spawn_blocking(move || -> ApiResult<Option<Value>> {
        let image = if mime.starts_with("image/") {
            Some(model_image(&bytes)?.0)
        } else {
            None
        };
        let path = blob_path(&data, &hash);
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
        crate::tools::fs::atomic_write(&path, &bytes)
            .map_err(|e| ApiError::conflict(e.code, "첨부 원문을 저장하지 못했습니다"))?;
        crate::store::restrict_permissions(&path);
        Ok(image)
    })
    .await
    .map_err(|_| ApiError::internal("attachment upload worker"))??;
    let owner = p.root_id.clone();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        crate::projects::active_root(tx, &pid)?;
        // 같은 hash의 원문을 재업로드하면 누락 처리된 기존 metadata도 복구한다.
        tx.execute("UPDATE attachments SET stored=1 WHERE sha256=?1 AND size=?2 AND stored=0", params![sha, size as i64])?;
        let id = crate::util::new_id();
        let key = format!("{}/{}", &sha[..2], sha);
        tx.execute(
            "INSERT INTO attachments(id,project_id,owner_id,name,mime,size,sha256,storage_key,created_at,image) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![id, pid, owner, b.name, mime, size as i64, sha, key, now, image.map(|v|v.to_string())],
        )?;
        // 미전송 원문과 파일명은 업로더에게만 응답하고 공용 이벤트에는 싣지 않는다.
        let v = get(tx, &id)?;
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
pub async fn content(
    State(app): State<App>,
    p: Principal,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let data = app.cfg.data_dir.clone();
    let (v, bytes) = app
        .db
        .call(move |c| {
            let v = authorized(c, &id, &p.root_id)?;
            let b = read_verified(&data, &v)?;
            Ok((v, b))
        })
        .await?;
    let mut resp = bytes.into_response();
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        v["mime"]
            .as_str()
            .unwrap_or("application/octet-stream")
            .parse()
            .unwrap(),
    );
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
                "메시지의 첨부파일 합계는 8MiB 이하여야 합니다",
            ));
        }
        let bytes = read_verified(data, &v)?;
        model.push_str(&format!(
            "\n\n[Attached file: {}; id={}; bytes={}; sha256={}]\n",
            v["name"].as_str().unwrap_or(""),
            id,
            v["size"],
            v["sha256"].as_str().unwrap_or("")
        ));
        if v["mime"].as_str().is_some_and(|m| m.starts_with("image/")) {
            let (meta, _) = model_image(&bytes)?;
            v["image"] = meta.clone();
            images.push(json!({"id":id,"sha256":v["sha256"],"width":meta["model_width"],"height":meta["model_height"],"mime":"image/jpeg"}));
            model.push_str("[Image supplied separately; first frame, normalized orientation, maximum 1024 pixels per side]");
        } else if v["mime"] == "text/plain" {
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| ApiError::gone("첨부 텍스트 인코딩이 다릅니다"))?;
            model.extend(text.chars().take(8192));
            let extra = text.chars().count().saturating_sub(8192);
            if extra > 0 {
                model.push_str(&format!(
                    "\n[Excerpt only: {extra} more characters in the original attachment]"
                ));
            }
        } else {
            model.push_str("[Binary attachment: contents are not included in this text input]");
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
