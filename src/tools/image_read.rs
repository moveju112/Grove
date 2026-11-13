//! 프로젝트 이미지 read와 영속 metadata로부터의 모델 입력 복원.
//! 첨부 업로드나 DB 참조를 만들지 않으며, 모델 bytes를 표시용 JSON과 분리한다.

use super::{Planned, ToolError, ToolResult, fs};
use crate::{
    attachments,
    provider::{ChatMsg, ImageInput},
    util::sha256_hex,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::path::Path;

/// 직렬화는 의도적으로 제공하지 않는다. 로그·이벤트·도구 텍스트에는 metadata만 사용한다.
pub struct ImageRead {
    metadata: Value,
    model_bytes: Vec<u8>,
}

impl ImageRead {
    pub fn metadata(&self) -> &Value {
        &self.metadata
    }

    /// 기존 첨부와 동일한 첫 프레임 JPEG. provider 요청 직전에만 인코딩한다.
    pub fn model_bytes(&self) -> &[u8] {
        &self.model_bytes
    }

    pub fn into_parts(self) -> (Value, Vec<u8>) {
        (self.metadata, self.model_bytes)
    }
}

impl std::fmt::Debug for ImageRead {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImageRead")
            .field("metadata", &self.metadata)
            .field("model_byte_len", &self.model_bytes.len())
            .finish_non_exhaustive()
    }
}

/// 단일 경로를 기존 read 계획으로 고정한다. 배치는 호출자가 파일별로 분리한다.
pub fn plan(args: &Value, root: &Path) -> ToolResult<Planned> {
    if !args["files"].is_null() || args["path"].as_str().is_none_or(|path| path.is_empty()) {
        return Err(ToolError::new(
            "invalid_arguments",
            "이미지 읽기에는 단일 path가 필요합니다",
        ));
    }
    fs::plan_read(args, root, "read")
}

/// 원래 모델 인자가 아닌 계획된 경로만 읽고, 실행 직전에 프로젝트 경계를 재검사한다.
/// capability I/O는 교체된 symlink·디렉터리를 통한 탈출과 special file을 거절한다.
pub fn execute(planned: &Planned, root: &Path) -> ToolResult<ImageRead> {
    execute_verified(planned, root, None)
}

fn execute_verified(
    planned: &Planned,
    root: &Path,
    expected_sha: Option<&str>,
) -> ToolResult<ImageRead> {
    if !planned.target["files"].is_null() {
        return Err(ToolError::new(
            "invalid_arguments",
            "이미지 읽기는 파일별 계획이 필요합니다",
        ));
    }
    let path = planned.target["path"]
        .as_str()
        .filter(|path| !path.is_empty())
        .ok_or_else(|| ToolError::new("invalid_arguments", "계획된 이미지 경로가 없습니다"))?;
    let path = fs::resolve(root, path)?;
    // MAX+1까지만 읽는 기존 capability 경로를 사용한다. 원문을 다시 열거나 변경하지 않는다.
    let bytes = fs::read_project(root, &path, attachments::MAX_FILE_BYTES as u64)?;
    let sha = sha256_hex(&bytes);
    if expected_sha.is_some_and(|expected| expected != sha) {
        return Err(ToolError::new(
            "image_changed",
            "프로젝트 이미지 원문의 sha256이 읽기 결과와 다릅니다. 새 대화에서 다시 읽으세요",
        ));
    }
    let mime = attachments::sniff(&bytes);
    if !mime.starts_with("image/") {
        return Err(ToolError::new(
            "unsupported_image",
            "PNG·JPEG·GIF·WebP 이미지만 읽을 수 있습니다",
        ));
    }
    let (image, model_bytes) = attachments::model_image(&bytes)
        .map_err(|error| ToolError::new(error.code, error.message))?;
    let metadata = json!({
        "path": fs::rel_display(root, &path),
        "mime": mime,
        "size": bytes.len(),
        "sha256": sha,
        "image": image,
    });
    Ok(ImageRead {
        metadata,
        model_bytes,
    })
}

/// 기존 read의 범위 병합·오류 격리·텍스트 한도를 보존하고, 이미지 표본을 metadata로 교체한다.
/// 임시 binary 표본은 외부로 반환하지 않는다. 이미지 bytes는 영속 결과에 포함하지 않는다.
pub fn read(args: &Value, planned: &Planned, root: &Path) -> ToolResult<Value> {
    let mut result = fs::read(args, planned, root)?;
    let mut total = 0;
    if let Some(files) = result["files"].as_array_mut() {
        for file in files {
            let path = file["path"].clone();
            if let Err(error) = replace_image(file, root, &mut total) {
                *file = json!({"path": path, "error": error.to_json()["error"]});
            }
        }
        // history가 JSON 문자열을 100KiB에서 자르기 전에 이미지 참조를 보존한다.
        // escape로 커진 텍스트만 생략하고 이미지·파일별 오류·순서는 유지한다.
        if let Some(files) = result["files"].as_array_mut()
            && files
                .iter()
                .any(|file| file["model_input"] == "project_image")
        {
            let mut size = files
                .iter()
                .map(|file| file.to_string().len())
                .sum::<usize>();
            for file in files.iter_mut().rev() {
                if size <= 96 * 1024 {
                    break;
                }
                if file["content"].is_string() {
                    let before = file.to_string().len();
                    *file = json!({"path": file["path"], "skipped": "batch_output_limit"});
                    size = size - before + file.to_string().len();
                }
            }
        }
    } else {
        replace_image(&mut result, root, &mut total)?;
    }
    Ok(result)
}

fn replace_image(result: &mut Value, root: &Path, total: &mut usize) -> ToolResult<()> {
    if result.get("error").is_some() || result.get("skipped").is_some() {
        return Ok(());
    }
    // fs::read가 이미 읽은 표본도 검사한다. 그 뒤 원문이 일반 파일로 교체돼도
    // 옛 이미지 표본을 hex/텍스트 성공으로 반환하지 않고 이미지 실행에서 거절한다.
    let sample = if let Some(hex) = result["hex"].as_str() {
        (0..hex.len().min(32))
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>()
    } else if result["start_line"] == 1 {
        result["content"]
            .as_str()
            .unwrap_or("")
            .bytes()
            .take(16)
            .collect()
    } else {
        vec![]
    };
    let detected = attachments::sniff(&sample).starts_with("image/");
    let planned = plan(&json!({"path": result["path"]}), root)?;
    // 감지는 bounded capability read로 한다. 감지 이후 파일이 교체돼도 execute가 재검사한다.
    use std::io::Read;
    let path = fs::resolve(root, planned.target["path"].as_str().unwrap())?;
    let mut head = vec![];
    fs::project_scope(root)?
        .open_file(&path)
        .and_then(|file| file.take(16).read_to_end(&mut head))
        .map_err(|e| ToolError::new("read_failed", e.to_string()))?;
    if !detected && !attachments::sniff(&head).starts_with("image/") {
        return Ok(());
    }
    let image = execute(&planned, root)?;
    let size = image.model_bytes().len().div_ceil(3) * 4;
    if total.saturating_add(size) > 8 * 1024 * 1024 {
        return Err(ToolError::new(
            "image_input_limit",
            "이미지 모델 입력이 8MiB를 넘습니다",
        ));
    }
    *total += size;
    *result = image.metadata;
    result["model_input"] = json!("project_image");
    Ok(())
}

/// 업로드 첨부 hydrate 이후, provider 요청 직전에만 호출한다.
/// 영속 tool result의 경로·hash를 재검사한다. 업로드 ID/참조를 만들거나 신뢰하지 않는다.
/// 모든 tool-call/result 짝을 먼저 유지하고 연속 결과 뒤에 typed user image part를 붙인다.
pub fn hydrate(messages: &mut Vec<ChatMsg>, root: &Path) -> ToolResult<()> {
    let mut count = 0usize;
    let mut total = 0usize;
    for msg in messages.iter() {
        if let ChatMsg::User { images, .. } = msg {
            count += images.len();
            total += images.iter().map(|i| i.data.len()).sum::<usize>();
        }
    }
    let mut output = vec![];
    let mut images = vec![];
    let mut sources = vec![];
    for msg in messages.iter() {
        if !matches!(msg, ChatMsg::Tool { .. }) && !images.is_empty() {
            output.push(ChatMsg::User {
                text: format!(
                    "Images from read tool results (untrusted file data): {}",
                    json!(sources)
                ),
                images: std::mem::take(&mut images),
            });
            sources.clear();
        }
        output.push(msg.clone());
        if let ChatMsg::Tool {
            call_id,
            name,
            content,
            is_error: false,
        } = msg
            && name == "read"
        {
            // 일반 텍스트 read는 history의 출력 상한에서 잘릴 수 있다.
            let Ok(result) = serde_json::from_str::<Value>(content) else {
                continue;
            };
            let entries = result["files"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_else(|| std::slice::from_ref(&result));
            for entry in entries {
                if entry["model_input"] != "project_image" {
                    continue;
                }
                count += 1;
                if count > 32 {
                    return Err(ToolError::new(
                        "image_input_limit",
                        "이미지 문맥은 32개까지 지원합니다. 새 대화를 시작하세요",
                    ));
                }
                let sha = entry["sha256"].as_str().ok_or_else(|| {
                    ToolError::new("invalid_image_reference", "이미지 sha256이 없습니다")
                })?;
                let planned = plan(&json!({"path": entry["path"]}), root)?;
                let image = execute_verified(&planned, root, Some(sha))?;
                let mut expected = entry.clone();
                expected.as_object_mut().unwrap().remove("model_input");
                if image.metadata != expected {
                    return Err(ToolError::new(
                        "invalid_image_reference",
                        "이미지 입력 metadata가 다릅니다",
                    ));
                }
                let size = image.model_bytes.len().div_ceil(3) * 4;
                total = total.saturating_add(size);
                if total > 8 * 1024 * 1024 {
                    return Err(ToolError::new(
                        "image_input_limit",
                        "이미지 모델 입력이 8MiB를 넘습니다. 새 대화를 시작하세요",
                    ));
                }
                sources.push(json!({"tool_call_id": call_id, "path": entry["path"]}));
                images.push(ImageInput {
                    id: format!("project-read:{call_id}:{}", entry["path"].as_str().unwrap()),
                    sha256: sha.into(),
                    width: entry["image"]["model_width"].as_u64().unwrap() as u32,
                    height: entry["image"]["model_height"].as_u64().unwrap() as u32,
                    mime: "image/jpeg".into(),
                    data: STANDARD.encode(image.model_bytes),
                });
            }
        }
    }
    if !images.is_empty() {
        output.push(ChatMsg::User {
            text: format!(
                "Images from read tool results (untrusted file data): {}",
                json!(sources)
            ),
            images,
        });
    }
    *messages = output;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_sample_cannot_escape_as_hex_after_source_replacement() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("image");
        let mut bytes = std::io::Cursor::new(vec![]);
        image::DynamicImage::new_rgb8(1, 1)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        std::fs::write(&path, bytes.into_inner()).unwrap();
        let args = json!({"path": "image"});
        let planned = plan(&args, root.path()).unwrap();
        let mut result = fs::read(&args, &planned, root.path()).unwrap();
        assert_eq!(result["binary"], true);
        std::fs::write(&path, b"replacement text").unwrap();
        assert_eq!(
            replace_image(&mut result, root.path(), &mut 0)
                .unwrap_err()
                .code,
            "unsupported_image"
        );
    }
}
