//! 원본 설정 projection과 인증된 조회 API.
//! 개인 설정·외부 서비스 없이 소유한 임시 디렉터리만 사용한다.

mod common;

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

#[tokio::test]
async fn http_project_projection_is_scoped_safe_read_only_and_available_to_owner_browser() {
    use common::TestServer;
    use reqwest::{Method, StatusCode};
    let server = TestServer::start().await;
    let project = server.create_project("source-projection").await;
    let other = server.create_project("source-other").await;
    let root = Path::new(project["root_path"].as_str().unwrap());
    let bytes = br#"{"autoMemoryEnabled":true,"env":{"FIXTURE":"source-private-marker"},"hooks":{"Stop":"source-private-marker"}}"#;
    write(root, SourceId::ClaudeProject, bytes);
    write(root, SourceId::CodexProject, b"source-private-marker");
    write(Path::new(other["root_path"].as_str().unwrap()), SourceId::ClaudeProject, br#"{"cleanupPeriodDays":999}"#);
    let path = format!("/api/v1/source-settings?project_id={}", project["id"].as_str().unwrap());
    let expected = json!({"items": [
        {"source":"claude_project","status":"present","projection":{"autoMemoryEnabled":true},"ignored_invalid_fields":false},
        {"source":"claude_project_local","status":"missing"},
        {"source":"codex_project","status":"unsupported_format","format":"toml"}
    ]});
    for _ in 0..2 {
        let (status, value) = server.get(&path).await;
        assert_eq!(status, StatusCode::OK, "{value}");
        assert_eq!(value["items"], expected["items"]);
        assert!(value["resources"].is_array());
        assert!(!value.to_string().contains(root.to_str().unwrap()));
        assert!(!value.to_string().contains("source-private-marker"));
    }
    let (status, browser) = server.post("/api/v1/auth/browser-login", json!({"token": server.token})).await;
    assert_eq!(status, StatusCode::OK);
    let response = server.raw(Method::GET, &path, None, None, Some(browser["access_token"].as_str().unwrap())).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.json::<Value>().await.unwrap()["items"], expected["items"]);
    assert_eq!(std::fs::read(root.join(SourceId::ClaudeProject.relative_path())).unwrap(), bytes);
    let (status, value) = server.get("/api/v1/source-settings?project_id=unregistered").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{value}");
    assert_eq!(value["error"]["code"], "not_found");
    let id = project["id"].as_str().unwrap().to_string();
    server.server.as_ref().unwrap().app.db.call(move |c| {
        c.execute("UPDATE projects SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ?1", [id])?;
        Ok(())
    }).await.unwrap();
    assert_eq!(server.get(&path).await.0, StatusCode::CONFLICT);
}

#[tokio::test]
async fn http_denies_anonymous_devices_and_device_browsers_for_every_project_and_user_sources() {
    use common::TestServer;
    use reqwest::{Method, StatusCode};
    let server = TestServer::start().await;
    let a = server.create_project("sources-a").await;
    let b = server.create_project("sources-b").await;
    let (status, device) = server.post("/api/v1/devices", json!({"name":"source-reader"})).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, browser) = server.post("/api/v1/auth/browser-login", json!({"token":device["token"]})).await;
    assert_eq!(status, StatusCode::OK);
    for path in [
        "/api/v1/source-settings".to_string(),
        format!("/api/v1/source-settings?project_id={}", a["id"].as_str().unwrap()),
        format!("/api/v1/source-settings?project_id={}", b["id"].as_str().unwrap()),
        "/api/v1/source-settings?project_id=unknown".to_string(),
    ] {
        let response = server.raw(Method::GET, &path, None, None, Some("")).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        for token in [device["token"].as_str().unwrap(), browser["access_token"].as_str().unwrap()] {
            let response = server.raw(Method::GET, &path, None, None, Some(token)).await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            assert_eq!(response.json::<Value>().await.unwrap()["error"]["code"], "forbidden");
        }
    }
}

#[tokio::test]
async fn http_rejects_root_paths_filenames_and_unknown_query_fields_without_echoing_them() {
    use common::TestServer;
    use reqwest::{Method, StatusCode};
    let server = TestServer::start().await;
    for query in [
        "root=%2Fsource-private-marker",
        "path=source-private-marker",
        "filename=source-private-marker",
        "source=source-private-marker",
        "project_id=&root=source-private-marker",
        "project_id=",
        "project_id=one&project_id=source-private-marker",
    ] {
        let (status, value) = server.get(&format!("/api/v1/source-settings?{query}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {value}");
        assert_eq!(value["error"]["code"], "invalid_request");
        assert!(!value.to_string().contains("source-private-marker"));
        assert!(value.get("items").is_none());
    }
    for method in [Method::POST, Method::PUT, Method::PATCH, Method::DELETE] {
        let response = server.raw(method, "/api/v1/source-settings", Some(json!({})), Some("no-source-write"), None).await;
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
}

#[tokio::test]
async fn http_file_errors_are_sanitized_and_recover_on_the_next_read() {
    use common::TestServer;
    use reqwest::StatusCode;
    let server = TestServer::start().await;
    let project = server.create_project("sources-errors").await;
    let root = Path::new(project["root_path"].as_str().unwrap());
    let path = format!("/api/v1/source-settings?project_id={}", project["id"].as_str().unwrap());
    write(root, SourceId::ClaudeProject, b"source-private-marker not json");
    let (status, value) = server.get(&path).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["items"][0], json!({"source":"claude_project","status":"read_error","code":"invalid_json"}));
    assert!(!value.to_string().contains("source-private-marker"));
    write(root, SourceId::ClaudeProject, br#"{"cleanupPeriodDays":7}"#);
    let (status, value) = server.get(&path).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["items"][0]["projection"], json!({"cleanupPeriodDays":7}));
}

fn resource(root: &Path, source: SourceId, kind: &str, path: &str) -> Value {
    let resources = grove::source_settings::read_resources(Some(root), source);
    resources.into_iter().map(|value| serde_json::to_value(value).unwrap())
        .find(|value| value["kind"] == kind && value["relative_path"] == path).unwrap()
}

fn file(root: &Path, relative: &str, bytes: &[u8]) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

#[test]
fn source_skill_metadata_has_relative_paths_and_never_exposes_bodies_or_extra_frontmatter() {
    let root = TempDir::new().unwrap();
    for (source, path) in [
        (SourceId::ClaudeUser, "skills"),
        (SourceId::ClaudeProject, ".claude/skills"),
        (SourceId::CodexUser, "skills"),
        (SourceId::CodexProject, ".agents/skills"),
        (SourceId::CodexProject, ".codex/skills"),
    ] {
        let relative = format!("{path}/demo/SKILL.md");
        let bytes = b"---\nname: 'Demo'\ndescription: >-\n  Read source\n  metadata.\nenv: source-private-marker\nhooks: source-private-marker\n---\nsource-private-marker body\n";
        file(root.path(), &relative, bytes);
        let value = resource(root.path(), source, "skills", path);
        assert_eq!(value["result"], json!({
            "status": "present",
            "entries": [{"name":"Demo","description":"Read source metadata.","relative_path":relative}],
            "ignored_invalid_entries":false
        }));
        assert!(!value.to_string().contains("source-private-marker"));
        assert!(!value.to_string().contains(root.path().to_str().unwrap()));
        assert_eq!(std::fs::read(root.path().join(&relative)).unwrap(), bytes);
    }
    file(root.path(), ".agents/skills/demo/SKILL.md", b"---\r\nname: Demo\r\ndescription: \"Read metadata\"\r\n---\r\nprivate-body");
    let user = serde_json::to_value(grove::source_settings::read_codex_user_agents(Some(root.path()))).unwrap();
    assert_eq!(user["source"], "codex_user");
    assert_eq!(user["result"]["entries"][0]["description"], "Read metadata");
    assert!(!user.to_string().contains("private-body"));
}

#[test]
fn source_skills_report_missing_roots_invalid_metadata_unreadable_and_oversize_entries() {
    let root = TempDir::new().unwrap();
    assert_eq!(resource(root.path(), SourceId::ClaudeProject, "skills", ".claude/skills")["result"]["status"], "missing");
    for bytes in [
        b"no frontmatter source-private-marker".as_slice(),
        b"---\nname: demo\n---\nsource-private-marker",
        b"---\nname: demo\ndescription: [source-private-marker]\n---\nbody",
        b"---\nname: demo\nname: duplicate\ndescription: source-private-marker\n---\nbody",
        b"\xff",
        &vec![b'x'; grove::skills::MAX_BODY_BYTES as usize + 1],
    ] {
        file(root.path(), ".claude/skills/demo/SKILL.md", bytes);
        assert_eq!(resource(root.path(), SourceId::ClaudeProject, "skills", ".claude/skills")["result"],
            json!({"status":"present","entries":[],"ignored_invalid_entries":true}));
    }
    file(root.path(), ".claude/skills/demo/SKILL.md", b"---\nname: demo\ndescription: Valid again\n---\nbody");
    assert_eq!(resource(root.path(), SourceId::ClaudeProject, "skills", ".claude/skills")["result"]["entries"][0]["name"], "demo");
    for source in [SourceId::ClaudeUser, SourceId::CodexUser] {
        let value = serde_json::to_value(grove::source_settings::read_resources(None, source)).unwrap();
        for entry in value.as_array().unwrap() {
            assert_eq!(entry["result"], json!({"status":"read_error","code":"io"}));
        }
    }
}

#[test]
fn source_hooks_show_only_event_matcher_and_command_presence_for_claude_and_codex() {
    let root = TempDir::new().unwrap();
    for (source, path) in [
        (SourceId::ClaudeUser, "settings.json"),
        (SourceId::ClaudeProject, ".claude/settings.json"),
        (SourceId::ClaudeProjectLocal, ".claude/settings.local.json"),
        (SourceId::CodexUser, "hooks.json"),
        (SourceId::CodexProject, ".codex/hooks.json"),
    ] {
        let bytes = serde_json::to_vec(&json!({
            "env":{"FIXTURE":"source-private-marker"},
            "hooks":{
                "PreToolUse":[{"matcher":"Bash|Read","hooks":[
                    {"type":"command","command":"touch must-not-exist source-private-marker","env":{"FIXTURE":"source-private-marker"}},
                    {"type":"prompt","prompt":"source-private-marker"}]}],
                "Stop":[{"hooks":[{"type":"command","commandWindows":"source-private-marker"}]}]
            }
        })).unwrap();
        file(root.path(), path, &bytes);
        assert_eq!(resource(root.path(), source, "hooks", path)["result"], json!({
            "status":"present", "ignored_invalid_entries":false,
            "entries":[
                {"event":"PreToolUse","matcher":"Bash|Read","has_command":true},
                {"event":"PreToolUse","matcher":"Bash|Read","has_command":false},
                {"event":"Stop","matcher":null,"has_command":true}
            ]
        }));
        assert_eq!(std::fs::read(root.path().join(path)).unwrap(), bytes);
        assert!(!root.path().join("must-not-exist").exists());
    }
    file(root.path(), ".codex/config.toml", b"[[hooks.Stop]]\ncommand = 'source-private-marker'");
    assert_eq!(resource(root.path(), SourceId::CodexProject, "hooks", ".codex/config.toml")["result"],
        json!({"status":"unsupported_format","format":"toml"}));
}

#[test]
fn source_hook_errors_and_partial_invalid_entries_are_sanitized_and_bounded() {
    let root = TempDir::new().unwrap();
    for (bytes, code) in [
        (b"source-private-marker invalid".as_slice(), "invalid_json"),
        (b"[]".as_slice(), "invalid_shape"),
        (b"{\"hooks\":\"source-private-marker\"}".as_slice(), "invalid_shape"),
    ] {
        file(root.path(), "hooks.json", bytes);
        assert_eq!(resource(root.path(), SourceId::CodexUser, "hooks", "hooks.json")["result"],
            json!({"status":"read_error","code":code}));
    }
    file(root.path(), "hooks.json", &serde_json::to_vec(&json!({"hooks":{
        "Stop":[{"matcher":9},{"hooks":[{"type":"unknown"},{"type":"command","command":123},{"type":"command","command":"source-private-marker"}]}]
    }})).unwrap());
    assert_eq!(resource(root.path(), SourceId::CodexUser, "hooks", "hooks.json")["result"], json!({
        "status":"present","entries":[{"event":"Stop","matcher":null,"has_command":true}],"ignored_invalid_entries":true
    }));
    file(root.path(), "hooks.json", &vec![b' '; MAX_SOURCE_BYTES as usize + 1]);
    assert_eq!(resource(root.path(), SourceId::CodexUser, "hooks", "hooks.json")["result"],
        json!({"status":"read_error","code":"too_large"}));
    let handlers = vec![json!({"type":"command","command":"not executed"}); grove::skills::MAX_SKILLS + 1];
    file(root.path(), "hooks.json", &serde_json::to_vec(&json!({"hooks":{"Stop":[{"hooks":handlers}]}})).unwrap());
    assert_eq!(resource(root.path(), SourceId::CodexUser, "hooks", "hooks.json")["result"]["code"], "too_large");
}

#[test]
fn source_metadata_redacts_credential_markers_including_matchers_and_never_returns_commands() {
    let root = TempDir::new().unwrap();
    file(root.path(), "skills/demo/SKILL.md",
        b"---\nname: demo\ndescription: 'API_KEY=synthetic-credential-marker'\n---\nbody-private-marker");
    assert_eq!(resource(root.path(), SourceId::ClaudeUser, "skills", "skills")["result"]["entries"][0]["description"], "[redacted]");
    file(root.path(), "hooks.json", br#"{"hooks":{"Stop":[{"matcher":"Bearer synthetic-credential-marker","hooks":[{"type":"command","command":"no-credential-command-marker"}]}]}}"#);
    let value = resource(root.path(), SourceId::CodexUser, "hooks", "hooks.json");
    assert_eq!(value["result"]["entries"][0]["matcher"], "[redacted]");
    assert!(!value.to_string().contains("synthetic-credential-marker"));
    assert!(!value.to_string().contains("no-credential-command-marker"));
}

#[test]
fn source_skill_listing_enforces_entry_and_scan_limits_without_partial_results() {
    let root = TempDir::new().unwrap();
    for index in 0..=grove::skills::MAX_SKILLS {
        file(root.path(), &format!("skills/demo-{index}/SKILL.md"),
            b"---\nname: demo\ndescription: Allowed\n---\nbody");
    }
    assert_eq!(resource(root.path(), SourceId::ClaudeUser, "skills", "skills")["result"],
        json!({"status":"read_error","code":"too_large"}));
    for index in 0..=grove::skills::MAX_SCANNED_ENTRIES {
        file(root.path(), &format!(".agents/skills/not-a-skill-{index}"), b"ignored");
    }
    assert_eq!(resource(root.path(), SourceId::CodexProject, "skills", ".agents/skills")["result"],
        json!({"status":"read_error","code":"too_large"}));
}

#[cfg(unix)]
#[test]
fn source_resources_reject_internal_and_external_symlinks_at_all_levels() {
    use std::os::unix::fs::symlink;
    let root = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    file(outside.path(), "demo/SKILL.md", b"---\nname: escaped\ndescription: Must not show\n---\nbody");
    symlink(outside.path(), root.path().join("skills")).unwrap();
    assert_eq!(resource(root.path(), SourceId::ClaudeUser, "skills", "skills")["result"]["code"], "permission_denied");
    file(root.path(), ".claude/skills/internal/SKILL.md", b"---\nname: internal\ndescription: Allowed\n---\nbody");
    symlink("internal", root.path().join(".claude/skills/alias")).unwrap();
    symlink(outside.path().join("demo"), root.path().join(".claude/skills/escape")).unwrap();
    std::fs::create_dir(root.path().join(".claude/skills/leaf")).unwrap();
    symlink("../internal/SKILL.md", root.path().join(".claude/skills/leaf/SKILL.md")).unwrap();
    let value = resource(root.path(), SourceId::ClaudeProject, "skills", ".claude/skills");
    assert_eq!(value["result"]["entries"].as_array().unwrap().len(), 1);
    assert_eq!(value["result"]["entries"][0]["name"], "internal");
    assert_eq!(value["result"]["ignored_invalid_entries"], true);
    symlink(outside.path(), root.path().join(".codex")).unwrap();
    assert_eq!(resource(root.path(), SourceId::CodexProject, "hooks", ".codex/hooks.json")["result"]["code"], "permission_denied");
    file(root.path(), "internal.json", b"{}");
    symlink("internal.json", root.path().join("hooks.json")).unwrap();
    assert_eq!(resource(root.path(), SourceId::CodexUser, "hooks", "hooks.json")["result"]["code"], "permission_denied");
}

#[cfg(unix)]
#[test]
fn source_resources_permission_denial_is_not_reported_as_missing() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 { return; }
    let root = TempDir::new().unwrap();
    file(root.path(), "hooks.json", b"{}");
    file(root.path(), "skills/demo/SKILL.md", b"---\nname: demo\ndescription: Allowed\n---\nbody");
    for path in ["hooks.json", "skills/demo/SKILL.md"] {
        std::fs::set_permissions(root.path().join(path), std::fs::Permissions::from_mode(0o000)).unwrap();
    }
    let hooks = resource(root.path(), SourceId::CodexUser, "hooks", "hooks.json");
    let skills = resource(root.path(), SourceId::ClaudeUser, "skills", "skills");
    for path in ["hooks.json", "skills/demo/SKILL.md"] {
        std::fs::set_permissions(root.path().join(path), std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert_eq!(hooks["result"]["code"], "permission_denied");
    assert_eq!(skills["result"], json!({"status":"present","entries":[],"ignored_invalid_entries":true}));
}

#[tokio::test]
async fn http_source_resources_are_project_scoped_sanitized_and_recoverable() {
    use common::TestServer;
    use reqwest::StatusCode;
    let server = TestServer::start().await;
    let a = server.create_project("resources-a").await;
    let b = server.create_project("resources-b").await;
    let a_root = Path::new(a["root_path"].as_str().unwrap());
    let b_root = Path::new(b["root_path"].as_str().unwrap());
    file(a_root, ".claude/skills/demo/SKILL.md", b"---\nname: alpha\ndescription: Alpha skill\n---\nsource-private-marker");
    file(b_root, ".claude/skills/demo/SKILL.md", b"---\nname: beta\ndescription: Beta skill\n---\nsource-private-marker");
    file(a_root, ".codex/hooks.json", br#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"touch must-not-exist source-private-marker"}]}]}}"#);
    let path = format!("/api/v1/source-settings?project_id={}", a["id"].as_str().unwrap());
    let (status, first) = server.get(&path).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["resources"][0]["result"]["entries"][0]["name"], "alpha");
    assert!(!first.to_string().contains("beta"));
    assert!(!first.to_string().contains("source-private-marker"));
    assert!(!first.to_string().contains(a_root.to_str().unwrap()));
    assert_eq!(first, server.get(&path).await.1);
    assert!(!a_root.join("must-not-exist").exists());
    file(a_root, ".codex/hooks.json", b"source-private-marker malformed");
    let invalid = server.get(&path).await.1;
    assert!(invalid["resources"].as_array().unwrap().iter().any(|value|
        value["relative_path"] == ".codex/hooks.json" && value["result"]["code"] == "invalid_json"));
    assert!(!invalid.to_string().contains("source-private-marker"));
    file(a_root, ".codex/hooks.json", b"{}");
    let restored = server.get(&path).await.1;
    assert!(restored["resources"].as_array().unwrap().iter().any(|value|
        value["relative_path"] == ".codex/hooks.json" && value["result"]["status"] == "present"));
}
