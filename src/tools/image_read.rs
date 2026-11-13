//! 프로젝트 이미지 read의 준비·실행. registry·fs 분기·provider 연결은 호출자가 맡는다.
//! 첨부 업로드나 DB 참조를 만들지 않으며, 모델 bytes를 표시용 JSON과 분리한다.

use super::{Planned, ToolError, ToolResult, fs};
use crate::{attachments, util::sha256_hex};
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
        "sha256": sha256_hex(&bytes),
        "image": image,
    });
    Ok(ImageRead {
        metadata,
        model_bytes,
    })
}
