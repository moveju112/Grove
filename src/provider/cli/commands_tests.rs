use super::*;
use crate::provider::{ChatMsg, ModelRequest, Profile, cli::CliContext};

fn skills(root: &Path, name: &str) -> Value {
    json!({"data":[{"cwd":root,"errors":[],"skills":[
        {"name":name,"description":"Review source","path":root.join("SKILL.md"),"scope":"repo","enabled":true}
    ]}]})
}

#[test]
fn native_catalog_binds_ids_to_cli_root_name_and_path_without_exposing_paths() {
    let root = Path::new("/fixture");
    let a = decode("codex_cli", root, &skills(root, "review")).unwrap();
    assert_eq!(a.commands[0].info.name, "review");
    assert!(parse_id(Some(&a.commands[0].info.id)).unwrap().is_some());
    let b = decode("codex_cli", Path::new("/other"), &skills(Path::new("/other"), "review")).unwrap();
    assert_ne!(a.commands[0].info.id, b.commands[0].info.id);
    let c = decode("claude_code", root, &json!({"commands":[{"name":"review","description":"Review","argumentHint":"file"}]})).unwrap();
    assert_ne!(a.commands[0].info.id, c.commands[0].info.id);
    assert!(!serde_json::to_string(&a.commands[0].info).unwrap().contains("/fixture"));
    assert!(decode("codex_cli", Path::new("/other"), &skills(root, "review")).is_err());
}

#[test]
fn disabled_and_duplicate_names_never_silently_choose_a_different_skill() {
    let root = Path::new("/fixture");
    let mut data = skills(root, "review");
    let mut user = data["data"][0]["skills"][0].clone();
    user["scope"] = json!("user");
    user["path"] = json!("/user/review/SKILL.md");
    data["data"][0]["skills"].as_array_mut().unwrap().push(user);
    let catalog = decode("codex_cli", root, &data).unwrap();
    assert_eq!(catalog.commands.iter().map(|c| c.info.name.as_str()).collect::<Vec<_>>(), ["repo:review", "user:review"]);
    data["data"][0]["skills"][0]["enabled"] = json!(false);
    assert_eq!(decode("codex_cli", root, &data).unwrap().commands.len(), 1);
    data["data"][0]["errors"] = json!([{"message":"private path omitted"}]);
    assert!(decode("codex_cli", root, &data).unwrap().has_errors);
}

#[test]
fn dispatch_requires_the_selected_name_and_preserves_arguments_and_namespaces() {
    let command = decode("claude_code", Path::new("/fixture"), &json!({"commands":[
        {"name":"plugin:Review","description":"Review","argumentHint":"path"}
    ]})).unwrap().commands.remove(0);
    assert_eq!(invocation("/plugin:Review 경로 --flag", &command).unwrap(), "경로 --flag");
    assert_eq!(invocation("/cli:plugin:review\nargs", &command).unwrap(), "args");
    assert_eq!(invocation("/cli:cli:plugin:Review", &command).unwrap(), "");
    assert!(invocation("/different args", &command).is_err());
    assert!(invocation("//plugin:Review", &command).is_err());
    assert!(parse_id(Some("../../private")).is_err());
    assert!(decode("claude_code", Path::new("/fixture"), &json!({"commands":[{"name":"../../path","description":"x"}]})).is_err());
}

#[cfg(unix)]
fn executable(root: &Path, name: &str, script: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let file = root.join(name);
    std::fs::write(&file, script).unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
    file
}

#[cfg(unix)]
#[tokio::test]
async fn metadata_process_uses_native_project_sources_without_a_user_turn() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("native-commands.json"), r#"[{"name":"review","description":"Review","argumentHint":"file"}]"#).unwrap();
    let claude = executable(root.path(), "claude", include_str!("../../../tests/fixtures/native_claude.py"));
    let catalog = list_with("claude_code", root.path(), Some(&claude)).await.unwrap();
    assert_eq!(catalog.commands[0].info.name, "review");
    assert!(!root.path().join("claude-wire.jsonl").exists(), "metadata 조회는 모델 요청을 만들지 않는다");
    let codex = executable(root.path(), "codex", include_str!("../../../tests/fixtures/codex_app_server.py"));
    std::fs::write(root.path().join("native-skills.json"), skills(root.path(), "review")["data"][0]["skills"].to_string()).unwrap();
    let catalog = list_with("codex_cli", root.path(), Some(&codex)).await.unwrap();
    assert_eq!(catalog.commands[0].info.name, "review");
    let wire = std::fs::read_to_string(root.path().join("wire.jsonl")).unwrap();
    assert!(wire.contains("skills/list") && !wire.contains("thread/start") && !wire.contains("turn/start"));
}

#[cfg(unix)]
#[tokio::test]
async fn claude_dispatch_starts_with_the_native_command_and_keeps_history_out_of_arguments() {
    for resume in [None, Some("previous-thread".to_string())] {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("native-commands.json"), r#"[{"name":"review","description":"Review","argumentHint":"file"}]"#).unwrap();
        let cli = executable(root.path(), "claude", include_str!("../../../tests/fixtures/native_claude.py"));
        let command = list_with("claude_code", root.path(), Some(&cli)).await.unwrap().commands.remove(0);
        let profile = Profile { protocol:"claude_code".into(), model:"default".into(), base_url:String::new(), api_key:None,
            timeout:Duration::from_secs(5), extra_headers:vec![], sensitive_headers:vec![] };
        let mut req = ModelRequest { system:"system context".into(), messages:vec![
            ChatMsg::User { text:"old user".into(), images:vec![] },
            ChatMsg::Assistant { text:"old answer".into(), tool_calls:vec![], native:None },
            ChatMsg::User { text:"/review file.rs".into(), images:vec![] },
        ], tools:vec![], max_tokens:None, temperature:None, effort:None,
            cli:Some(CliContext { cwd:root.path().into(), resume:resume.clone(), native_command:Some(command.info.id), ..Default::default() }) };
        let out = super::super::stream_with(&profile, &req, &mut |_| {}, Some(&cli)).await.unwrap();
        assert_eq!(out.text, "native fixture");
        let wire: Value = serde_json::from_str(std::fs::read_to_string(root.path().join("claude-wire.jsonl")).unwrap().lines().next().unwrap()).unwrap();
        assert_eq!(wire["text"], "/review file.rs");
        assert_eq!(wire["context"].as_str().unwrap().contains("old user"), resume.is_none());
        req.cli.as_mut().unwrap().native_command = None;
        req.messages = vec![ChatMsg::User { text:"/review is literal text".into(), images:vec![] }];
        super::super::stream_with(&profile, &req, &mut |_| {}, Some(&cli)).await.unwrap();
        let last: Value = serde_json::from_str(std::fs::read_to_string(root.path().join("claude-wire.jsonl")).unwrap().lines().last().unwrap()).unwrap();
        assert!(last["text"].as_str().unwrap().starts_with("<user_message>"));
    }
}
