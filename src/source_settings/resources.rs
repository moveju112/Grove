//! 원본 리소스의 메타데이터만 반환한다. 본문·명령·선택·적용은 응답에 없다.

use super::{MAX_SOURCE_BYTES, ReadErrorCode, SourceId};
use crate::project_fs::ProjectFs;
use crate::skills::{MAX_BODY_BYTES, MAX_SCANNED_ENTRIES, MAX_SKILLS};
use serde::Serialize;
use serde_json::Value;
use std::io;
use std::path::{Component, Path};

#[derive(Debug, Serialize)]
pub struct SourceResource {
    pub source: SourceId,
    pub relative_path: &'static str,
    #[serde(flatten)]
    pub content: ResourceContent,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResourceContent {
    Skills { result: ResourceState<SkillMetadata> },
    Hooks { result: ResourceState<HookMetadata> },
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ResourceState<T> {
    Present { entries: Vec<T>, ignored_invalid_entries: bool },
    Missing,
    ReadError { code: ReadErrorCode },
    UnsupportedFormat { format: &'static str },
}

#[derive(Debug, Serialize)]
pub struct SkillMetadata {
    pub name: String,
    pub description: Option<String>,
    pub relative_path: String,
}

#[derive(Debug, Serialize)]
pub struct HookMetadata {
    pub event: String,
    pub matcher: Option<String>,
    pub has_command: bool,
}

/// root는 기존 조회 API와 동일하게 서버가 결정한다. local 설정에는 별도 스킬 root가 없다.
pub fn read_resources(root: Option<&Path>, source: SourceId) -> Vec<SourceResource> {
    let skill_paths: &[&'static str] = match source {
        SourceId::ClaudeUser => &["skills"],
        SourceId::ClaudeProject => &[".claude/skills"],
        SourceId::ClaudeProjectLocal => &[],
        SourceId::CodexUser => &["skills"],
        SourceId::CodexProject => &[".agents/skills", ".codex/skills"],
    };
    let mut resources: Vec<_> = skill_paths.iter().map(|&path| skills(root, source, path)).collect();
    let path = match source {
        SourceId::CodexUser => "hooks.json",
        SourceId::CodexProject => ".codex/hooks.json",
        _ => source.relative_path(),
    };
    resources.push(SourceResource {
        source,
        relative_path: path,
        content: ResourceContent::Hooks { result: result(with_root(root, |root| read_hooks(root, path))) },
    });
    if matches!(source, SourceId::CodexUser | SourceId::CodexProject) {
        // inline TOML을 JSON으로 추측하거나 일부 문법만 해석하지 않는다.
        resources.push(SourceResource {
            source,
            relative_path: source.relative_path(),
            content: ResourceContent::Hooks {
                result: result(with_root(root, |root| {
                    let root = crate::util::canonical(root)?;
                    let fs = ProjectFs::open(&root)?;
                    let path = Path::new(source.relative_path());
                    no_symlinks(&fs, path)?;
                    if !fs.metadata(&root.join(path))?.is_file() {
                        return Err(io::ErrorKind::InvalidInput.into());
                    }
                    Ok(ResourceState::UnsupportedFormat { format: "toml" })
                })),
            },
        });
    }
    resources
}

/// Codex의 현재 사용자 스킬 위치. HOME/USERPROFILE은 서버에서만 결정한다.
pub fn read_codex_user_agents(home: Option<&Path>) -> SourceResource {
    skills(home, SourceId::CodexUser, ".agents/skills")
}

fn skills(root: Option<&Path>, source: SourceId, path: &'static str) -> SourceResource {
    SourceResource {
        source,
        relative_path: path,
        content: ResourceContent::Skills { result: result(with_root(root, |root| read_skills(root, path))) },
    }
}

fn with_root<T>(root: Option<&Path>, read: impl FnOnce(&Path) -> io::Result<T>) -> io::Result<T> {
    read(root.ok_or_else(|| io::Error::from(io::ErrorKind::Other))?)
}

fn result<T>(value: io::Result<ResourceState<T>>) -> ResourceState<T> {
    value.unwrap_or_else(|error| match error.kind() {
        io::ErrorKind::NotFound => ResourceState::Missing,
        io::ErrorKind::PermissionDenied => ResourceState::ReadError { code: ReadErrorCode::PermissionDenied },
        io::ErrorKind::InvalidInput | io::ErrorKind::IsADirectory | io::ErrorKind::NotADirectory =>
            ResourceState::ReadError { code: ReadErrorCode::NotRegularFile },
        io::ErrorKind::FileTooLarge => ResourceState::ReadError { code: ReadErrorCode::TooLarge },
        _ => ResourceState::ReadError { code: ReadErrorCode::Io },
    })
}

// catalog는 내부 symlink/alias를 허용한다. 이 화면은 더 좁은 경계를 요구하므로
// 같은 ProjectFs capability에서 모든 경로 요소를 검사하고 bounded read한다.
// 열린 capability는 검사 중 교체가 있어도 root 밖 I/O를 허용하지 않는다.
fn no_symlinks(fs: &ProjectFs, path: &Path) -> io::Result<()> {
    let mut relative = std::path::PathBuf::new();
    for component in path.components() {
        let Component::Normal(name) = component else {
            return Err(io::ErrorKind::PermissionDenied.into());
        };
        relative.push(name);
        if fs.dir.symlink_metadata(&relative)?.file_type().is_symlink() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    Ok(())
}

fn read_skills(root: &Path, path: &str) -> io::Result<ResourceState<SkillMetadata>> {
    let root = crate::util::canonical(root)?;
    let fs = ProjectFs::open(&root)?;
    no_symlinks(&fs, Path::new(path))?;
    let mut entries = Vec::new();
    let mut invalid = false;
    for (index, entry) in fs.dir.read_dir(path)?.enumerate() {
        if index >= MAX_SCANNED_ENTRIES {
            return Err(io::ErrorKind::FileTooLarge.into());
        }
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str().filter(|name| {
            !name.is_empty() && name.len() <= 128
                && !name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\'))
        }) else {
            invalid = true;
            continue;
        };
        let directory = Path::new(path).join(name);
        if fs.dir.symlink_metadata(&directory)?.file_type().is_symlink() {
            invalid = true;
            continue;
        }
        if !fs.dir.metadata(&directory)?.is_dir() {
            continue;
        }
        let file = directory.join("SKILL.md");
        let loaded = || {
            no_symlinks(&fs, &file).ok()?;
            let bytes = fs.read(&root.join(&file), MAX_BODY_BYTES).ok()?;
            // 검증 후에도 symlink가 남아 있으면 결과를 공개하지 않는다.
            no_symlinks(&fs, &file).ok()?;
            let text = std::str::from_utf8(&bytes).ok()?;
            let (name, description) = metadata(text)?;
            Some(SkillMetadata {
                name: safe_text(&name),
                description: Some(safe_text(&description)),
                relative_path: safe_text(&file.to_string_lossy()),
            })
        };
        // 파일 부재·읽기 실패·미지원 metadata는 원문/경로 없이 부분 실패로 알린다.
        match loaded() {
            Some(item) => entries.push(item),
            None => invalid = true,
        }
        if entries.len() > MAX_SKILLS {
            return Err(io::ErrorKind::FileTooLarge.into());
        }
    }
    no_symlinks(&fs, Path::new(path))?;
    entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(ResourceState::Present { entries, ignored_invalid_entries: invalid })
}

/// dependency 없는 제한된 frontmatter: 일반/인용 scalar와 |/> 블록.
/// 미지원 YAML은 본문이나 추측한 값을 설명으로 쓰지 않고 해당 항목을 생략한다.
fn metadata(text: &str) -> Option<(String, String)> {
    let text = text.replace("\r\n", "\n");
    let (front, _) = crate::definitions::split_front_matter(&text);
    let mut name = None;
    let mut description = None;
    let mut lines = front.lines().peekable();
    while let Some(line) = lines.next() {
        let target = if let Some(value) = line.strip_prefix("name:") {
            Some((&mut name, value))
        } else {
            line.strip_prefix("description:").map(|value| (&mut description, value))
        };
        let Some((target, value)) = target else { continue };
        if target.is_some() { return None; }
        let value = value.trim();
        let parsed = if matches!(value, "|" | ">" | "|-" | ">-") {
            let mut block = Vec::new();
            while lines.peek().is_some_and(|line| line.starts_with(' ') || line.is_empty()) {
                block.push(lines.next()?.trim());
            }
            block.join(if value.starts_with('>') { " " } else { "\n" })
        } else if value.starts_with('"') {
            serde_json::from_str::<String>(value).ok()?
        } else if value.starts_with('\'') {
            value.strip_prefix('\'')?.strip_suffix('\'')?.replace("''", "'")
        } else {
            if value.is_empty() || value.contains(": ") || value.contains(" #")
                || value.starts_with(['[', '{', '&', '*', '!', '|', '>'])
                || matches!(value, "null" | "~" | "true" | "false")
            { return None; }
            value.to_owned()
        };
        if parsed.trim().is_empty() || parsed.len() > 2048 || parsed.contains('\0') { return None; }
        *target = Some(parsed);
    }
    Some((name?, description?))
}

fn safe_text(text: &str) -> String {
    // 명령은 아예 반환하지 않는다. 메타데이터의 자격증명 징후도 전체 가림한다.
    // 환경변수 가림 정책을 재사용하고 긴 opaque 토큰/URL 자격증명을 추가 차단한다.
    let lower = text.to_ascii_lowercase();
    if crate::tools::shell::is_sensitive_env(text)
        || ["sk-", "ghp_", "gho_", "github_pat_", "grv_", "gva_", "bearer ", "://"]
            .iter().any(|marker| lower.contains(marker))
        || text.split(|c: char| !c.is_ascii_alphanumeric() && !"_+/=-".contains(c))
            .any(|word| word.len() >= 40)
    {
        "[redacted]".into()
    } else {
        text.to_owned()
    }
}

fn read_hooks(root: &Path, path: &str) -> io::Result<ResourceState<HookMetadata>> {
    let root = crate::util::canonical(root)?;
    let fs = ProjectFs::open(&root)?;
    no_symlinks(&fs, Path::new(path))?;
    let bytes = fs.read(&root.join(path), MAX_SOURCE_BYTES)?;
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return Ok(ResourceState::ReadError { code: ReadErrorCode::InvalidJson }),
    };
    let Some(object) = value.as_object() else {
        return Ok(ResourceState::ReadError { code: ReadErrorCode::InvalidShape });
    };
    let mut entries = Vec::new();
    let mut invalid = false;
    if let Some(hooks) = object.get("hooks") {
        let Some(hooks) = hooks.as_object() else {
            return Ok(ResourceState::ReadError { code: ReadErrorCode::InvalidShape });
        };
        for (event, groups) in hooks {
            let Some(groups) = groups.as_array() else { invalid = true; continue };
            for group in groups {
                let Some(group) = group.as_object() else { invalid = true; continue };
                let matcher = match group.get("matcher") {
                    None => None,
                    Some(Value::String(value)) if value.len() <= 256 => Some(safe_text(value)),
                    _ => { invalid = true; continue; }
                };
                let Some(handlers) = group.get("hooks").and_then(Value::as_array) else {
                    invalid = true; continue;
                };
                for handler in handlers {
                    let Some(handler) = handler.as_object() else { invalid = true; continue };
                    if !matches!(handler.get("type").and_then(Value::as_str),
                        Some("command" | "http" | "prompt" | "agent" | "mcp_tool"))
                        || event.is_empty() || event.len() > 128
                    { invalid = true; continue; }
                    let command = handler.get("command");
                    if command.is_some_and(|value| !value.is_string()) {
                        invalid = true; continue;
                    }
                    if entries.len() == MAX_SKILLS {
                        return Err(io::ErrorKind::FileTooLarge.into());
                    }
                    entries.push(HookMetadata {
                        event: safe_text(event),
                        matcher: matcher.clone(),
                        has_command: command.and_then(Value::as_str).is_some_and(|value| !value.is_empty())
                            || handler.get("commandWindows").and_then(Value::as_str).is_some_and(|value| !value.is_empty()),
                    });
                }
            }
        }
    }
    no_symlinks(&fs, Path::new(path))?;
    Ok(ResourceState::Present { entries, ignored_invalid_entries: invalid })
}
