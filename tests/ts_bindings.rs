//! Rust 계약 → TypeScript 타입 생성과 drift 검사(NET-002).
//! `GROVE_UPDATE_BINDINGS=1 cargo test --test ts_bindings`로 갱신하고, 평소에는 커밋된 파일과 다르면 실패한다.

use ts_rs::TS;

fn decl<T: TS>() -> String {
    // JSON 숫자는 2^53 안의 정수만 쓰므로 number로 표현한다.
    format!("export {}", T::decl().replace("bigint", "number"))
}

fn generate() -> String {
    let mut out = String::from("// 이 파일은 tests/ts_bindings.rs가 Rust 계약에서 생성한다. 직접 수정하지 않는다.\n\n");
    let decls = [
        decl::<grove::events::EventRecord>(),
        decl::<grove::auth::DeviceInfo>(),
        decl::<grove::projects::Project>(),
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
        decl::<grove::runner::Turn>(),
        decl::<grove::approvals::ToolCallRow>(),
        decl::<grove::changes::FileChange>(),
    ];
    for d in decls {
        out.push_str(&d);
        out.push_str("\n\n");
    }
    out
}

#[test]
fn typescript_bindings_are_current() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("web/app/api/generated.ts");
    let want = generate();
    if std::env::var("GROVE_UPDATE_BINDINGS").is_ok_and(|v| v == "1") {
        std::fs::write(&path, &want).unwrap();
        return;
    }
    let have = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(have == want, "web/app/api/generated.ts가 Rust 계약과 다릅니다. GROVE_UPDATE_BINDINGS=1 cargo test --test ts_bindings 로 갱신하세요");
}
