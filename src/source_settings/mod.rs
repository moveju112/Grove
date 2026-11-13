//! 원본 설정의 읽기 전용 projection(SETTINGS-010, RESOURCE-019).
//!
//! 인증·사용자/프로젝트 접근 권한·source root 결정은 호출자의 책임이다.
//! root는 서버가 정한 디렉터리이며 클라이언트의 파일 경로를 전달하면 안 된다.
//! 원본이나 이 projection을 Grove 설정에 적용하지 않는다.

use crate::project_fs::ProjectFs;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io;
use std::path::Path;

mod routes;
pub use routes::list;

/// 실제 읽기는 기존 capability 기반 파일 경계와 크기 제한을 재사용한다.
pub const MAX_SOURCE_BYTES: u64 = 256 * 1024;

/// 허용된 원본만 식별한다. 임의 파일명·상대 경로는 받지 않는다.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceId {
    ClaudeUser,
    ClaudeProject,
    ClaudeProjectLocal,
    CodexUser,
    CodexProject,
}

impl SourceId {
    /// User의 root는 서버가 결정한 각 CLI 설정 디렉터리다.
    /// Project의 root는 접근 권한을 확인한 프로젝트 디렉터리다.
    pub fn relative_path(self) -> &'static str {
        match self {
            Self::ClaudeUser => "settings.json",
            Self::ClaudeProject => ".claude/settings.json",
            Self::ClaudeProjectLocal => ".claude/settings.local.json",
            Self::CodexUser => "config.toml",
            Self::CodexProject => ".codex/config.toml",
        }
    }

    fn is_toml(self) -> bool {
        matches!(self, Self::CodexUser | Self::CodexProject)
    }
}

/// 문서화된 안전 필드만 포함한다. 문자열·명령·환경 변수·미지 필드는 없다.
/// None은 원본에 없거나 잘못된 타입/범위여서 생략된 값이며 기본값이 아니다.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub always_thinking_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_compact_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_memory_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cleanup_period_days: Option<u32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadErrorCode {
    PermissionDenied,
    NotRegularFile,
    TooLarge,
    InvalidJson,
    InvalidShape,
    Io,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceFormat {
    Toml,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SourceState {
    Present {
        projection: SafeSettings,
        /// 허용 필드의 잘못된 값이 생략됐는지만 알리고 원래 키·값은 반환하지 않는다.
        ignored_invalid_fields: bool,
    },
    Missing,
    ReadError {
        code: ReadErrorCode,
    },
    UnsupportedFormat {
        format: SourceFormat,
    },
}

/// source는 논리적인 출처만 나타내며 개인 경로나 적용 상태를 포함하지 않는다.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SourceSettings {
    pub source: SourceId,
    #[serde(flatten)]
    pub state: SourceState,
}

/// 서버에서 인가한 root와 식별자로 원본 하나를 읽기 전용으로 확인한다.
/// 동기 I/O이므로 async route에서는 blocking 경계에서 호출한다.
pub fn read_source(root: &Path, source: SourceId) -> SourceSettings {
    let state = read_state(root, source).unwrap_or_else(|error| match error.kind() {
        io::ErrorKind::NotFound => SourceState::Missing,
        io::ErrorKind::PermissionDenied => read_error(ReadErrorCode::PermissionDenied),
        io::ErrorKind::IsADirectory | io::ErrorKind::InvalidInput => {
            read_error(ReadErrorCode::NotRegularFile)
        }
        io::ErrorKind::FileTooLarge => read_error(ReadErrorCode::TooLarge),
        _ => read_error(ReadErrorCode::Io),
    });
    SourceSettings { source, state }
}

fn read_error(code: ReadErrorCode) -> SourceState {
    SourceState::ReadError { code }
}

fn read_state(root: &Path, source: SourceId) -> io::Result<SourceState> {
    let root = crate::util::canonical(root)?;
    let fs = ProjectFs::open(&root)?;
    let path = root.join(source.relative_path());
    if source.is_toml() {
        // parser가 없는 형식은 내용을 열지 않고 경계 안 일반 파일의 존재만 확인한다.
        if !fs.metadata(&path)?.is_file() {
            return Ok(read_error(ReadErrorCode::NotRegularFile));
        }
        return Ok(SourceState::UnsupportedFormat {
            format: SourceFormat::Toml,
        });
    }
    let bytes = fs.read(&path, MAX_SOURCE_BYTES)?;
    // serde 오류 문구에는 입력 조각이 포함될 수 있어 응답·로그에 전달하지 않는다.
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return Ok(read_error(ReadErrorCode::InvalidJson)),
    };
    let Some(object) = value.as_object() else {
        return Ok(read_error(ReadErrorCode::InvalidShape));
    };
    let mut invalid = false;
    let mut boolean = |key: &str| {
        object.get(key).and_then(|value| {
            let result = value.as_bool();
            invalid |= result.is_none();
            result
        })
    };
    let always_thinking_enabled = boolean("alwaysThinkingEnabled");
    let auto_compact_enabled = boolean("autoCompactEnabled");
    let auto_memory_enabled = boolean("autoMemoryEnabled");
    let cleanup_period_days = object.get("cleanupPeriodDays").and_then(|value| {
        let result = value.as_u64().and_then(|days| u32::try_from(days).ok());
        invalid |= result.is_none();
        result
    });
    Ok(SourceState::Present {
        projection: SafeSettings {
            always_thinking_enabled,
            auto_compact_enabled,
            auto_memory_enabled,
            cleanup_period_days,
        },
        ignored_invalid_fields: invalid,
    })
}
