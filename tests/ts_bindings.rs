//! Rust 계약 → TypeScript 타입 생성과 drift 검사(NET-002).
//! `GROVE_UPDATE_BINDINGS=1 cargo test --test ts_bindings`로 갱신하고, 평소에는 커밋된 파일과 다르면 실패한다.

use ts_rs::TS;
use std::io::Write;
use std::process::{Command, Stdio};

fn decl<T: TS>() -> String {
    // JSON 숫자는 2^53 안의 정수만 쓰므로 number로 표현한다.
    format!("export {}", T::decl().replace("bigint", "number"))
}

fn generate() -> String {
    let mut out = String::from("// 이 파일은 tests/ts_bindings.rs가 Rust 계약에서 생성한다. 직접 수정하지 않는다.\n\n");
    let decls = [
        decl::<grove::events::EventRecord>(),
        decl::<grove::auth::DeviceInfo>(),
        decl::<grove::pairing::PairingInfo>(),
        decl::<grove::notifications::Notification>(),
        decl::<grove::projects::Project>(),
        decl::<grove::labels::Label>(),
        decl::<grove::sessions::Session>(),
        decl::<grove::sessions::SessionPage>(),
        decl::<grove::sessions::Message>(),
        decl::<grove::sessions::MessagePage>(),
        decl::<grove::workspace::RecentItem>(),
        decl::<grove::workspace::RecentPage>(),
        decl::<grove::workspace::Draft>(),
        decl::<grove::definitions::Definition>(),
        decl::<grove::definitions::DefinitionDetail>(),
        decl::<grove::models::SecretInfo>(),
        decl::<grove::models::ModelProfile>(),
        decl::<grove::models::AgentBackend>(),
        decl::<grove::models::AgentBackendCatalog>(),
        decl::<grove::agent_auth::LoginAttempt>(),
        decl::<grove::agent_auth::AgentAuthStatus>(),
        decl::<grove::model_capabilities::ModelCapabilities>(),
        decl::<grove::provider::AvailableModel>(),
        decl::<grove::models::ModelCatalog>(),
        decl::<grove::runner::Turn>(),
        decl::<grove::approvals::ToolCallRow>(),
        decl::<grove::changes::FileChange>(),
        decl::<grove::worktrees::Worktree>(),
        decl::<grove::remote_watches::RemoteWatch>(),
    ];
    for d in decls {
        out.push_str(&d);
        out.push_str("\n\n");
    }
    out
}

fn metadata(source: &str) -> std::process::Output {
    let mut child = Command::new("node")
        .arg("web/scripts/contract-metadata.mjs")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("계약 생성에는 웹 개발 환경의 node·typescript가 필요합니다");
    child.stdin.take().unwrap().write_all(source.as_bytes()).unwrap();
    child.wait_with_output().unwrap()
}

fn check_generated(file: &str, want: &str) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(file);
    if std::env::var("GROVE_UPDATE_BINDINGS").is_ok_and(|v| v == "1") {
        std::fs::write(&path, want).unwrap();
        return;
    }
    let have = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(have == want, "{file}가 Rust 계약과 다릅니다. GROVE_UPDATE_BINDINGS=1 python3 scripts/build.py test --rust ts_bindings 로 갱신하세요");
}

#[test]
fn typescript_bindings_are_current() {
    let want = generate();
    let output = metadata(&want);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    check_generated("web/app/api/generated.ts", &want);
    check_generated("web/app/api/generated.metadata.ts", &String::from_utf8(output.stdout).unwrap());
}

#[test]
fn unsupported_contracts_fail_instead_of_silently_skipping_validation() {
    for source in [
        "export type Broken = Map<string, number>;",
        "export type Broken = { [key: string]: number };",
        "export type Broken = Missing;",
        "export type Broken = { value: ;",
    ] {
        assert!(!metadata(source).status.success(), "{source}");
    }
}

#[test]
fn metadata_preserves_nested_optional_nullable_and_literal_types() {
    let output = metadata("export type Child = { label: string }; export type Parent = { children: Array<Child>; note?: string | null; mode: \"on\" | false | 3 };");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains(r#""children":{"optional":false,"schema":{"kind":"array","item":{"kind":"ref","name":"Child"}}}"#));
    assert!(text.contains(r#""note":{"optional":true,"schema":{"kind":"union","options":[{"kind":"string"},{"kind":"literal","value":null}]}}"#));
    assert!(text.contains(r#""value":"on""#));
    assert!(text.contains(r#""value":false"#));
    assert!(text.contains(r#""value":3"#));
}
