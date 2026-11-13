//! src/lib.rs의 pub mod source_settings 등록 후 기존 통합 target으로 실행한다.
//! 개인 설정·외부 서비스 없이 소유한 임시 디렉터리만 사용한다.

use grove::source_settings::{
    MAX_SOURCE_BYTES, ReadErrorCode, SourceFormat, SourceId, SourceSettings, SourceState, read_source,
};
use serde_json::{Value, json};
use std::path::Path;
use tempfile::TempDir;

fn write(root: &Path, source: SourceId, bytes: &[u8]) {
    let path = root.join(source.relative_path());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

fn response(root: &Path, source: SourceId) -> Value {
    serde_json::to_value(read_source(root, source)).unwrap()
}

fn assert_error(result: SourceSettings, code: ReadErrorCode) {
    assert_eq!(result.state, SourceState::ReadError { code });
}

#[test]
fn returns_only_safe_fields_and_does_not_write_or_execute() {
    let root = TempDir::new().unwrap();
    // 모두 합성한 비밀 없는 값이다. 제외 필드는 실행하거나 응답하면 안 된다.
    let fixture = json!({
        "alwaysThinkingEnabled": true,
        "autoCompactEnabled": false,
        "autoMemoryEnabled": true,
        "cleanupPeriodDays": 30,
        "env": {"SYNTHETIC_KEY": "fixture-only-marker"},
        "apiKeyHelper": "touch must-not-exist",
        "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "touch must-not-exist"}]}]},
        "permissions": {"allow": ["Bash(touch must-not-exist)"]},
        "model": "fixture-only-marker",
        "unknown": {"alwaysThinkingEnabled": false},
        "skills": {"body": "fixture-only-marker"}
    });
    let bytes = serde_json::to_vec(&fixture).unwrap();
    write(root.path(), SourceId::ClaudeUser, &bytes);
    assert_eq!(response(root.path(), SourceId::ClaudeUser), json!({
        "source": "claude_user", "status": "present",
        "projection": {
            "alwaysThinkingEnabled": true,
            "autoCompactEnabled": false,
            "autoMemoryEnabled": true,
            "cleanupPeriodDays": 30
        },
        "ignored_invalid_fields": false
    }));
    assert_eq!(std::fs::read(root.path().join("settings.json")).unwrap(), bytes);
    assert!(!root.path().join("must-not-exist").exists());
}

#[test]
fn each_source_is_independent_and_no_precedence_or_defaults_are_invented() {
    let root = TempDir::new().unwrap();
    for (source, value) in [
        (SourceId::ClaudeUser, true),
        (SourceId::ClaudeProject, false),
        (SourceId::ClaudeProjectLocal, true),
    ] {
        write(root.path(), source, &serde_json::to_vec(&json!({"autoMemoryEnabled": value})).unwrap());
        let result = response(root.path(), source);
        assert_eq!(result["projection"], json!({"autoMemoryEnabled": value}));
        assert_eq!(result["status"], "present");
        assert_eq!(result.as_object().unwrap().len(), 4);
    }
    write(root.path(), SourceId::ClaudeUser, b"{}");
    assert_eq!(response(root.path(), SourceId::ClaudeUser)["projection"], json!({}));
}

#[test]
fn distinguishes_missing_files_and_missing_roots_without_creating_them() {
    let root = TempDir::new().unwrap();
    for source in [
        SourceId::ClaudeUser, SourceId::ClaudeProject, SourceId::ClaudeProjectLocal,
        SourceId::CodexUser, SourceId::CodexProject,
    ] {
        assert_eq!(read_source(root.path(), source).state, SourceState::Missing);
    }
    let missing = root.path().join("absent-root");
    assert_eq!(read_source(&missing, SourceId::ClaudeUser).state, SourceState::Missing);
    assert!(!missing.exists());
}

#[test]
fn reports_codex_toml_as_unsupported_without_guessing_json_or_parsing_strings() {
    let root = TempDir::new().unwrap();
    for source in [SourceId::CodexUser, SourceId::CodexProject] {
        for bytes in [b"model = 'fixture-only-marker'".as_slice(), b"{\"autoMemoryEnabled\":true}", b"\xff"] {
            write(root.path(), source, bytes);
            assert_eq!(read_source(root.path(), source).state, SourceState::UnsupportedFormat {
                format: SourceFormat::Toml,
            });
            assert_eq!(response(root.path(), source).as_object().unwrap().len(), 3);
        }
    }
}

#[test]
fn malformed_json_and_non_object_json_have_sanitized_errors() {
    let root = TempDir::new().unwrap();
    for bytes in [b"{\"fixture-only-marker\":".as_slice(), b"\xff", b"{/*comment*/}", b"{\"x\":1,}"] {
        write(root.path(), SourceId::ClaudeUser, bytes);
        assert_error(read_source(root.path(), SourceId::ClaudeUser), ReadErrorCode::InvalidJson);
        assert_eq!(response(root.path(), SourceId::ClaudeUser), json!({
            "source": "claude_user", "status": "read_error", "code": "invalid_json"
        }));
    }
    for bytes in [b"[]".as_slice(), b"null", b"true", b"\"fixture-only-marker\""] {
        write(root.path(), SourceId::ClaudeUser, bytes);
        assert_error(read_source(root.path(), SourceId::ClaudeUser), ReadErrorCode::InvalidShape);
    }
}

#[test]
fn drops_invalid_safe_values_instead_of_echoing_or_coercing_them() {
    let root = TempDir::new().unwrap();
    for days in [json!(-1), json!(1.5), json!("fixture-only-marker"), json!(4_294_967_296u64), Value::Null] {
        write(root.path(), SourceId::ClaudeUser, &serde_json::to_vec(&json!({
            "alwaysThinkingEnabled": "fixture-only-marker",
            "autoCompactEnabled": {"command": "fixture-only-marker"},
            "autoMemoryEnabled": false,
            "cleanupPeriodDays": days
        })).unwrap());
        assert_eq!(response(root.path(), SourceId::ClaudeUser), json!({
            "source": "claude_user", "status": "present",
            "projection": {"autoMemoryEnabled": false}, "ignored_invalid_fields": true
        }));
    }
    for days in [0u32, u32::MAX] {
        write(root.path(), SourceId::ClaudeUser, &serde_json::to_vec(&json!({"cleanupPeriodDays": days})).unwrap());
        assert_eq!(response(root.path(), SourceId::ClaudeUser)["projection"], json!({"cleanupPeriodDays": days}));
    }
}

#[test]
fn enforces_byte_limit_and_rejects_directories() {
    let root = TempDir::new().unwrap();
    let mut bytes = vec![b' '; MAX_SOURCE_BYTES as usize];
    bytes[..2].copy_from_slice(b"{}");
    write(root.path(), SourceId::ClaudeUser, &bytes);
    assert_eq!(response(root.path(), SourceId::ClaudeUser)["status"], "present");
    bytes.push(b' ');
    write(root.path(), SourceId::ClaudeUser, &bytes);
    assert_error(read_source(root.path(), SourceId::ClaudeUser), ReadErrorCode::TooLarge);
    std::fs::create_dir_all(root.path().join(".claude/settings.json")).unwrap();
    assert_error(read_source(root.path(), SourceId::ClaudeProject), ReadErrorCode::NotRegularFile);
    std::fs::create_dir_all(root.path().join("config.toml")).unwrap();
    assert_error(read_source(root.path(), SourceId::CodexUser), ReadErrorCode::NotRegularFile);
}

#[test]
fn only_fixed_source_identifiers_can_be_deserialized() {
    for input in ["../settings.json", "/etc/passwd", "settings.json", "claude_user/../../other"] {
        assert!(serde_json::from_value::<SourceId>(json!(input)).is_err());
    }
    assert_eq!(serde_json::from_value::<SourceId>(json!("claude_project_local")).unwrap(), SourceId::ClaudeProjectLocal);
}

#[cfg(unix)]
#[test]
fn does_not_follow_file_or_parent_symlinks_outside_the_source_root() {
    use std::os::unix::fs::symlink;
    let root = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    write(outside.path(), SourceId::ClaudeUser, br#"{"autoMemoryEnabled":true}"#);
    symlink(outside.path().join("settings.json"), root.path().join("settings.json")).unwrap();
    assert!(matches!(read_source(root.path(), SourceId::ClaudeUser).state, SourceState::ReadError { .. }));
    symlink(outside.path(), root.path().join(".claude")).unwrap();
    assert!(matches!(read_source(root.path(), SourceId::ClaudeProject).state, SourceState::ReadError { .. }));
    write(outside.path(), SourceId::CodexUser, b"fixture-only-marker");
    symlink(outside.path().join("config.toml"), root.path().join("config.toml")).unwrap();
    assert!(matches!(read_source(root.path(), SourceId::CodexUser).state, SourceState::ReadError { .. }));
}

#[cfg(unix)]
#[test]
fn unreadable_file_is_not_reported_as_missing() {
    use std::os::unix::fs::PermissionsExt;
    // root는 파일 권한을 우회하므로 이 분기의 검증 대상이 아니다.
    if unsafe { libc::geteuid() } == 0 { return; }
    let root = TempDir::new().unwrap();
    write(root.path(), SourceId::ClaudeUser, b"{}");
    let path = root.path().join("settings.json");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    let result = read_source(root.path(), SourceId::ClaudeUser);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_error(result, ReadErrorCode::PermissionDenied);
}
