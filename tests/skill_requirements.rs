//! 격리된 로컬 파일·HTTP 모델 fixture만 사용한다.
mod common;

use common::{TestServer, fixture::{self, Fixture}};
use grove::skills::{
    AllowedRoot, SkillCatalog, SkillSelections, SkillSource,
    requirements::{Capabilities, MAX_ITEMS, MAX_MANIFEST_BYTES, Report, Status},
};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::{Path, PathBuf}};

fn skill(root: &Path, name: &str, requirements: Option<Value>) {
    fs::create_dir_all(root.join(name)).unwrap();
    fs::write(root.join(name).join("SKILL.md"), format!("BODY_{name}")).unwrap();
    if let Some(value) = requirements {
        fs::write(root.join(name).join("requirements.grove.json"), value.to_string()).unwrap();
    }
}
fn catalog(root: &Path) -> SkillCatalog {
    SkillCatalog::discover(vec![AllowedRoot::open(SkillSource::Global { root_id: "fixture".into() }, root).unwrap()]).unwrap()
}
fn caps() -> Capabilities {
    Capabilities { platform: std::env::consts::OS.into(), tools: BTreeMap::from([("read".into(), Report::default())]) }
}
fn entry(c: &SkillCatalog, name: &str) -> grove::skills::SkillSelection {
    c.listing().entries.iter().find(|e| e.name == name).unwrap().selection()
}

#[test]
fn only_optional_version_one_json_arrays_are_interpreted() {
    let root = tempfile::tempdir().unwrap();
    skill(root.path(), "legacy", None);
    fs::write(root.path().join("legacy/SKILL.md"), "---\ntools: [invented]\n---\nopaque").unwrap();
    fs::write(root.path().join("legacy/requirements.yaml"), "tools: [invented]").unwrap();
    let legacy = catalog(root.path());
    let item = &legacy.listing().entries[0];
    assert_eq!(item.revision, grove::util::sha256_hex(b"---\ntools: [invented]\n---\nopaque"));
    assert_eq!(item.requirements, Report::default());
    for (i, (value, code)) in [
        (json!({"version":2}), "skill_requirements_version"),
        (json!({"version":1,"unknown":[]}), "skill_requirements_invalid"),
        (json!({"version":1,"tools":"read"}), "skill_requirements_invalid"),
        (json!({"version":1,"tools":["read","read"]}), "skill_requirements_invalid"),
        (json!({"version":1,"platforms":[1]}), "skill_requirements_invalid"),
        (json!({"version":1,"skills":["../escape"]}), "skill_requirements_invalid"),
        (json!({"version":1,"skills":vec!["same"; MAX_ITEMS + 1]}), "skill_requirements_invalid"),
        (json!({"tools":[]}), "skill_requirements_invalid"),
    ].into_iter().enumerate() {
        let name = format!("bad{i}");
        skill(root.path(), &name, Some(value));
        let c = catalog(root.path());
        assert_eq!(c.requirements_report(&entry(&c, &name), &[], &caps()).problems[0].code, code);
    }
    for bytes in [b"{".as_slice(), b"\xff", b"{\"version\":1,\"version\":1}", b"version: 1"] {
        fs::write(root.path().join("legacy/requirements.grove.json"), bytes).unwrap();
        let c = catalog(root.path());
        assert_eq!(c.requirements_report(&entry(&c, "legacy"), &[], &caps()).problems[0].code, "skill_requirements_invalid");
    }
}

#[test]
fn manifest_add_change_delete_and_internal_retarget_are_revision_changes() {
    let root = tempfile::tempdir().unwrap();
    skill(root.path(), "review", None);
    let c = catalog(root.path());
    let original = entry(&c, "review");
    let file = root.path().join("review/requirements.grove.json");
    fs::write(&file, r#"{"version":1}"#).unwrap();
    assert_eq!(c.read(&original).unwrap_err().code, "skill_changed");
    let c = catalog(root.path());
    let with_manifest = entry(&c, "review");
    assert_ne!(original.revision, with_manifest.revision);
    fs::write(&file, r#"{"version":1,"tools":[]}"#).unwrap();
    assert_eq!(c.read(&with_manifest).unwrap_err().code, "skill_changed");
    let c = catalog(root.path());
    let changed = entry(&c, "review");
    fs::remove_file(&file).unwrap();
    assert_eq!(c.read(&changed).unwrap_err().code, "skill_changed");
    assert_eq!(entry(&catalog(root.path()), "review"), original);
}

#[cfg(unix)]
#[test]
fn manifest_capability_is_bounded_regular_utf8_and_never_escapes_or_follows_replacement() {
    use std::os::unix::fs::symlink;
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("allowed");
    skill(&root, "review", None);
    let file = root.join("review/requirements.grove.json");
    let secret = fixture.path().join("private");
    fs::write(&secret, "PRIVATE_MANIFEST").unwrap();
    symlink(&secret, &file).unwrap();
    let c = catalog(&root);
    assert!(c.listing().entries.is_empty());
    assert!(!serde_json::to_string(c.listing()).unwrap().contains("PRIVATE_MANIFEST"));
    fs::remove_file(&file).unwrap();
    symlink("missing", &file).unwrap();
    assert!(catalog(&root).listing().entries.is_empty()); // dangling는 absent가 아니다.
    fs::remove_file(&file).unwrap();
    let fifo = std::ffi::CString::new(file.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert!(catalog(&root).listing().entries.is_empty());
    fs::remove_file(&file).unwrap();
    fs::create_dir(&file).unwrap();
    assert!(catalog(&root).listing().entries.is_empty());
    fs::remove_dir(&file).unwrap();
    fs::write(&file, vec![b' '; MAX_MANIFEST_BYTES as usize + 1]).unwrap();
    assert_eq!(catalog(&root).listing().issues[0].code, "skill_too_large");
    fs::write(&file, vec![b' '; MAX_MANIFEST_BYTES as usize]).unwrap();
    assert_eq!(catalog(&root).listing().entries[0].requirements.problems[0].code, "skill_requirements_invalid");
    fs::remove_file(&file).unwrap();
    for name in ["one.json", "two.json"] { fs::write(root.join(name), r#"{"version":1}"#).unwrap(); }
    symlink("../one.json", &file).unwrap();
    let c = catalog(&root);
    let before = entry(&c, "review");
    fs::remove_file(&file).unwrap();
    symlink("../two.json", &file).unwrap();
    assert_eq!(c.read(&before).unwrap_err().code, "skill_changed");
    assert_ne!(before.revision, entry(&catalog(&root), "review").revision);
    fs::rename(&root, fixture.path().join("moved")).unwrap();
    fs::create_dir(&root).unwrap();
    // 열린 capability는 교체된 ambient root를 읽지 않는다.
    let current = entry(&c, "review");
    assert_eq!(c.read(&current).unwrap_err().code, "skill_changed"); // 이미 관측한 retarget은 여전히 stale.
}

#[test]
fn dependencies_require_explicit_selection_and_never_auto_install_or_select() {
    let root = tempfile::tempdir().unwrap();
    skill(root.path(), "base", None);
    skill(root.path(), "review", Some(json!({"version":1,"tools":["read"],"platforms":[std::env::consts::OS],"skills":["base"]})));
    let c = catalog(root.path());
    let review = entry(&c, "review");
    let base = entry(&c, "base");
    let mut selected = SkillSelections::default();
    assert_eq!(c.requirements_report(&review, &[], &caps()).problems[0].code, "skill_dependency_unselected");
    assert!(selected.bindings().is_empty());
    selected.select(&c, &base).unwrap();
    selected.select(&c, &review).unwrap();
    c.validate_requirements(selected.bindings(), &caps(), true).unwrap();
    selected.deselect(&base);
    assert_eq!(c.validate_requirements(selected.bindings(), &caps(), true).unwrap_err().code, "skill_dependency_unselected");
    skill(root.path(), "base", Some(json!({"version":1,"skills":["review"]})));
    let cyclic = catalog(root.path());
    assert_eq!(cyclic.requirements_report(&entry(&cyclic, "review"), &[], &caps()).problems[0].code, "skill_dependency_cycle");
    skill(root.path(), "review", Some(json!({"version":1,"skills":["missing"]})));
    let missing = catalog(root.path());
    assert_eq!(missing.requirements_report(&entry(&missing, "review"), &[], &caps()).problems[0].code, "skill_dependency_missing");
}

#[test]
fn dependency_precedence_ambiguity_and_explicit_lower_source_are_preserved() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    for root in [&a, &b] { skill(root.path(), "base", None); }
    skill(a.path(), "review", Some(json!({"version":1,"skills":["base"]})));
    let open = |id: &str, path: &Path, project| AllowedRoot::open(if project {
        SkillSource::Project { root_id: id.into(), project_id: "p".into() }
    } else { SkillSource::Global { root_id: id.into() } }, path).unwrap();
    let c = SkillCatalog::discover(vec![open("a", a.path(), false), open("b", b.path(), false)]).unwrap();
    let review = entry(&c, "review");
    assert_eq!(c.requirements_report(&review, &[], &caps()).problems[0].code, "skill_dependency_ambiguous");
    let explicit = c.listing().entries.iter().find(|e| e.name == "base").unwrap().selection();
    assert_eq!(c.requirements_report(&review, &[explicit], &caps()).status, Status::Satisfied);
    let c = SkillCatalog::discover(vec![open("a", a.path(), false), open("b", b.path(), true)]).unwrap();
    let low = c.listing().entries.iter().find(|e| e.name == "base" && matches!(e.source, SkillSource::Global { .. })).unwrap().selection();
    assert_eq!(c.requirements_report(&entry(&c, "review"), &[low], &caps()).status, Status::Satisfied);
}

fn url(session: &str) -> String { format!("/api/v1/sessions/{session}/skills") }
async fn setup(s: &TestServer, name: &str) -> (Value, String, PathBuf) {
    let project = s.create_project(name).await;
    let session = s.create_session(project["id"].as_str().unwrap()).await;
    let root = PathBuf::from(project["root_path"].as_str().unwrap()).join(".agents/skills");
    fs::create_dir_all(&root).unwrap();
    (project, session["id"].as_str().unwrap().into(), root)
}
async fn listing(s: &TestServer, session: &str, query: &str) -> Value {
    let (status, body) = s.get(&format!("{}{query}", url(session))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}
fn binding(list: &Value, name: &str) -> Value {
    let e = list["listing"]["entries"].as_array().unwrap().iter().find(|e| e["name"] == name).unwrap();
    json!({"id":e["id"],"source":e["source"],"revision":e["revision"]})
}
async fn choose(s: &TestServer, session: &str, binding: &Value, selected: bool, context: Value) -> (StatusCode, Value) {
    s.send(Method::PUT, &format!("{}/selection", url(session)), json!({"selection":binding,"selected":selected,"context":context})).await
}
async fn capability_profile(s: &TestServer, profile: &str, tools: Option<bool>) {
    let (_, profiles) = s.get("/api/v1/model-profiles").await;
    let current = profiles.as_array().unwrap().iter().find(|p| p["id"] == profile).unwrap();
    let (status, body) = s.send(Method::PUT, &format!("/api/v1/model-profiles/{profile}"),
        json!({"expected_revision":current["revision"],"options":{"timeout_secs":30,"capabilities":{"tools":tools}}})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
async fn turn(s: &TestServer, session: &str, profile: &str, tools: bool, expected: &str) -> Value {
    let (status, body) = s.post(&format!("/api/v1/sessions/{session}/turns"), json!({"text":"requirements fixture","profile_id":profile,"tools":tools})).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    s.wait_status(body["turn"]["id"].as_str().unwrap(), expected).await
}

#[tokio::test]
async fn actual_invocation_uses_registered_tools_profile_and_final_policy_without_grants() {
    let s = TestServer::start().await;
    let fixture = Fixture::start().await;
    let profile = s.fixture_profile(&fixture.base).await;
    capability_profile(&s, &profile, Some(true)).await;
    let (project, session, root) = setup(&s, "capabilities").await;
    skill(&root, "review", Some(json!({"version":1,"tools":["read"]})));
    let selected = binding(&listing(&s, &session, "").await, "review");
    assert_eq!(choose(&s, &session, &selected, true, json!({})).await.0, StatusCode::OK);
    let query = format!("?profile_id={profile}&tools_enabled=false");
    assert_eq!(listing(&s, &session, &query).await["validation_error"]["code"], "skill_tools_disabled");
    assert_eq!(turn(&s, &session, &profile, false, "failed").await["error"]["code"], "skill_tools_disabled");
    assert!(fixture.requests().is_empty());
    capability_profile(&s, &profile, None).await;
    assert_eq!(turn(&s, &session, &profile, true, "failed").await["error"]["code"], "skill_model_unknown");
    capability_profile(&s, &profile, Some(true)).await;
    fixture.push(fixture::text("requirements success"));
    turn(&s, &session, &profile, true, "completed").await;
    assert!(fixture.requests()[0]["messages"][0]["content"].as_str().unwrap().contains("BODY_review"));
    let (status, body) = s.send(Method::PUT, &format!("/api/v1/settings/project/{}/tools.deny", project["id"].as_str().unwrap()),
        json!({"expected_revision":0,"value":"read"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let query = format!("?profile_id={profile}&tools_enabled=true");
    assert_eq!(listing(&s, &session, &query).await["validation_error"]["code"], "policy_denied");
    assert_eq!(turn(&s, &session, &profile, true, "failed").await["error"]["code"], "policy_denied");
    assert_eq!(fixture.requests().len(), 1);
    // 요구 검증은 기존 실행 권한이나 승인을 변경하지 않는다.
    let (_, grants) = s.get(&format!("/api/v1/sessions/{session}/tool-grants")).await;
    assert_eq!(grants["items"], json!([]), "{grants}");
}

#[tokio::test]
async fn read_only_unknown_tools_platform_and_cli_are_explicit_selection_errors() {
    let s = TestServer::start().await;
    let (_, session, root) = setup(&s, "blocked").await;
    for (name, manifest, code) in [
        ("unregistered", json!({"version":1,"tools":["not_registered"]}), "skill_tool_unregistered"),
        ("platform", json!({"version":1,"platforms":["not_a_server_os"]}), "skill_platform_unsupported"),
        ("mcp", json!({"version":1,"tools":["mcp_call"]}), "skill_tool_unavailable"),
    ] {
        skill(&root, name, Some(manifest));
        let selected = binding(&listing(&s, &session, "").await, name);
        let (status, body) = choose(&s, &session, &selected, true, json!({})).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["error"]["code"], code);
    }
    skill(&root, "write", Some(json!({"version":1,"tools":["write"]})));
    let (status, body) = s.send(Method::PUT, &format!("/api/v1/settings/session/{session}/tools.mode"),
        json!({"expected_revision":0,"value":"read_only"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let selected = binding(&listing(&s, &session, "").await, "write");
    assert_eq!(choose(&s, &session, &selected, true, json!({})).await.1["error"]["code"], "read_only");
    let (status, cli) = s.post("/api/v1/model-profiles", json!({"name":"local-cli","protocol":"codex_cli","base_url":"","model":"fixture"})).await;
    assert_eq!(status, StatusCode::CREATED, "{cli}");
    skill(&root, "read", Some(json!({"version":1,"tools":["read"]})));
    let selected = binding(&listing(&s, &session, "").await, "read");
    let (_, rejected) = choose(&s, &session, &selected, true, json!({"profile_id":cli["id"],"tools_enabled":true})).await;
    assert_eq!(rejected["error"]["code"], "skill_model_unsupported", "{rejected}");
    assert_eq!(listing(&s, &session, "").await["selected"], json!([]));
}

#[tokio::test]
async fn selections_survive_loss_restart_manifest_stale_and_dependency_removal_without_rebinding() {
    let mut s = TestServer::start().await;
    let (_, session, root) = setup(&s, "recovery").await;
    skill(&root, "base", None);
    skill(&root, "review", Some(json!({"version":1,"skills":["base"]})));
    let snapshot = listing(&s, &session, "").await;
    let review = binding(&snapshot, "review");
    let base = binding(&snapshot, "base");
    assert_eq!(choose(&s, &session, &review, true, json!({})).await.1["error"]["code"], "skill_dependency_unselected");
    assert_eq!(choose(&s, &session, &base, true, json!({})).await.0, StatusCode::OK);
    let request = json!({"selection":review,"selected":true});
    let response = s.raw(Method::PUT, &format!("{}/selection", url(&session)), Some(request.clone()), Some("lost-requirements"), None).await;
    assert_eq!(response.status(), StatusCode::OK);
    drop(response); // 응답 본문 유실 후 동일 receipt 조회.
    s.restart().await;
    let replay = s.raw(Method::PUT, &format!("{}/selection", url(&session)), Some(request), Some("lost-requirements"), None).await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    let saved = listing(&s, &session, "").await["selected"].clone();
    assert_eq!(saved, json!([base, review]));
    let (_, other, _) = setup(&s, "other-project").await;
    assert_eq!(choose(&s, &other, &review, true, json!({})).await.0, StatusCode::NOT_FOUND);
    assert_eq!(choose(&s, &session, &base, false, json!({})).await.0, StatusCode::OK);
    assert_eq!(listing(&s, &session, "").await["validation_error"]["code"], "skill_dependency_unselected");
    assert_eq!(choose(&s, &session, &base, true, json!({})).await.0, StatusCode::OK);
    fs::remove_file(root.join("review/requirements.grove.json")).unwrap();
    let stale = listing(&s, &session, "").await;
    assert_eq!(stale["selected"], json!([review, base]));
    assert_eq!(stale["validation_error"]["code"], "skill_changed");
    assert_eq!(choose(&s, &session, &review, false, json!({})).await.0, StatusCode::OK);
    let fresh = binding(&listing(&s, &session, "").await, "review");
    assert_eq!(choose(&s, &session, &fresh, true, json!({})).await.0, StatusCode::OK);
}
