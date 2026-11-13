//! catalog·인증된 API·세션 저장·로컬 모델 fixture 회귀 시험.
//! 실제 사용자 설정·스킬·외부 모델을 읽거나 실행하지 않는다.

mod common;

use grove::skills::{
    AllowedRoot, MAX_BODY_BYTES, MAX_SKILLS, MetadataSupport, SkillCatalog, SkillPriority,
    SkillSelections, SkillSource,
};
use std::fs;
use std::path::Path;

fn global(id: &str, path: &Path) -> AllowedRoot {
    AllowedRoot::open(SkillSource::Global { root_id: id.into() }, path).unwrap()
}

fn project(id: &str, project: &str, path: &Path) -> AllowedRoot {
    AllowedRoot::open(SkillSource::Project { root_id: id.into(), project_id: project.into() }, path).unwrap()
}

fn skill(root: &Path, name: &str, text: impl AsRef<[u8]>) {
    fs::create_dir_all(root.join(name)).unwrap();
    fs::write(root.join(name).join("SKILL.md"), text).unwrap();
}

#[test]
fn discovery_is_stable_read_only_and_does_not_interpret_metadata() {
    let root = tempfile::tempdir().unwrap();
    let raw = "---\nname: not-the-directory\naliases: [invented]\nunknown: true\n---\n<script>data</script>";
    skill(root.path(), "review", raw);
    skill(root.path(), "nested/ignored", "not discovered recursively");
    fs::write(root.path().join("README.md"), "not a skill").unwrap();
    let first = SkillCatalog::discover(vec![global("global", root.path())]).unwrap();
    let next = SkillCatalog::discover(vec![global("global", root.path())]).unwrap();
    assert_eq!(first.listing(), next.listing());
    assert_eq!(first.listing().entries.len(), 1);
    let entry = &first.listing().entries[0];
    assert_eq!(entry.name, "review");
    assert_eq!(entry.metadata, MetadataSupport::OpaqueFrontMatter);
    assert_eq!(entry.revision, grove::util::sha256_hex(raw.as_bytes()));
    assert_eq!(first.read(&entry.selection()).unwrap().text, raw);
    assert_eq!(fs::read_to_string(root.path().join("review/SKILL.md")).unwrap(), raw);
    let serialized = serde_json::to_string(first.listing()).unwrap();
    assert!(!serialized.contains(root.path().to_str().unwrap()));
    assert!(!serialized.contains("invented"));
    assert!(!serialized.contains("<script>"));
}

#[test]
fn project_priority_and_same_tier_conflicts_never_auto_select() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let c = tempfile::tempdir().unwrap();
    for root in [&a, &b, &c] {
        skill(root.path(), "review", "safe fixture");
    }
    let catalog = SkillCatalog::discover(vec![
        global("global-a", a.path()), global("global-b", b.path()), project("project", "p", c.path()),
    ]).unwrap();
    for entry in &catalog.listing().entries {
        assert_eq!(entry.conflicts.len(), 2);
        assert_eq!(entry.priority, if matches!(entry.source, SkillSource::Project { .. }) {
            SkillPriority::Preferred
        } else { SkillPriority::Shadowed });
    }
    let reversed = SkillCatalog::discover(vec![
        project("project", "p", c.path()), global("global-b", b.path()), global("global-a", a.path()),
    ]).unwrap();
    assert_eq!(catalog.listing(), reversed.listing());
    let conflicted = SkillCatalog::discover(vec![global("a", a.path()), global("b", b.path())]).unwrap();
    assert!(conflicted.listing().entries.iter().all(|e| e.priority == SkillPriority::Conflict));
    let mut selected = SkillSelections::default();
    assert!(selected.bindings().is_empty());
    // 명시적 ID로는 충돌 후보 중 하나를 선택할 수 있다. 같은 이름을 조용히 교체하지 않는다.
    let first = conflicted.listing().entries[0].selection();
    let second = conflicted.listing().entries[1].selection();
    selected.select(&conflicted, &first).unwrap();
    selected.select(&conflicted, &first).unwrap();
    assert_eq!(selected.select(&conflicted, &second).unwrap_err().code, "selection_conflict");
    assert_eq!(selected.bindings(), &[first.clone()]);
    assert!(selected.deselect(&first));
    assert!(!selected.deselect(&first));
    selected.select(&conflicted, &second).unwrap();
}

#[test]
fn root_and_project_identity_are_not_ambiguous() {
    let root = tempfile::tempdir().unwrap();
    assert!(SkillCatalog::discover(vec![global("same", root.path()), global("same", root.path())]).is_err());
    assert!(SkillCatalog::discover(vec![project("a", "p1", root.path()), project("b", "p2", root.path())]).is_err());
    assert!(AllowedRoot::open(SkillSource::Global { root_id: "../client-path".into() }, root.path()).is_err());
    assert!(AllowedRoot::open(SkillSource::Global { root_id: "missing".into() }, &root.path().join("absent")).is_err());
}

#[test]
fn identifiers_sources_and_revisions_are_bound_to_the_allowlist() {
    let root = tempfile::tempdir().unwrap();
    skill(root.path(), "review", "safe");
    let catalog = SkillCatalog::discover(vec![global("a", root.path())]).unwrap();
    let selection = catalog.listing().entries[0].selection();
    let mut forged = selection.clone();
    forged.id = "../review/SKILL.md".into();
    assert_eq!(catalog.read(&forged).unwrap_err().code, "skill_not_found");
    forged = selection.clone();
    forged.source = SkillSource::Global { root_id: "unapproved".into() };
    assert_eq!(catalog.read(&forged).unwrap_err().code, "skill_changed");
    forged = selection.clone();
    forged.revision = "wrong".into();
    assert_eq!(catalog.read(&forged).unwrap_err().code, "skill_changed");
    let other_catalog = SkillCatalog::discover(vec![global("b", root.path())]).unwrap();
    assert_eq!(other_catalog.read(&selection).unwrap_err().code, "skill_not_found");
}

#[test]
fn live_changes_deletions_and_rediscovery_cannot_silently_refresh_selection() {
    let root = tempfile::tempdir().unwrap();
    skill(root.path(), "one", "original");
    skill(root.path(), "two", "unchanged");
    let catalog = SkillCatalog::discover(vec![global("a", root.path())]).unwrap();
    let one = catalog.listing().entries.iter().find(|e| e.name == "one").unwrap().selection();
    let two = catalog.listing().entries.iter().find(|e| e.name == "two").unwrap().selection();
    let mut selections = SkillSelections::default();
    selections.select(&catalog, &one).unwrap();
    selections.select(&catalog, &two).unwrap();
    assert_eq!(selections.validate(&catalog).unwrap().len(), 2);
    skill(root.path(), "one", "changed");
    assert_eq!(catalog.read(&one).unwrap_err().code, "skill_changed");
    assert_eq!(selections.validate(&catalog).unwrap_err().code, "skill_changed");
    let fresh = SkillCatalog::discover(vec![global("a", root.path())]).unwrap();
    let updated = fresh.listing().entries.iter().find(|e| e.name == "one").unwrap().selection();
    assert_eq!(one.id, updated.id);
    assert_ne!(one.revision, updated.revision);
    assert_eq!(selections.select(&fresh, &updated).unwrap_err().code, "skill_changed");
    assert!(selections.deselect(&one));
    selections.select(&fresh, &updated).unwrap();
    fs::remove_file(root.path().join("one/SKILL.md")).unwrap();
    assert_eq!(selections.validate(&fresh).unwrap_err().code, "skill_not_found");
    assert!(selections.deselect(&updated));
    assert_eq!(selections.validate(&fresh).unwrap().len(), 1);
}

#[test]
fn bounded_plain_utf8_and_partial_discovery_errors() {
    let root = tempfile::tempdir().unwrap();
    skill(root.path(), "valid", "visible");
    skill(root.path(), "limit", vec![b'a'; MAX_BODY_BYTES as usize]);
    skill(root.path(), "large", vec![b'a'; MAX_BODY_BYTES as usize + 1]);
    skill(root.path(), "invalid", [0xff, 0xfe]);
    skill(root.path(), "binary", [b'a', 0, b'b']);
    fs::create_dir_all(root.path().join("directory/SKILL.md")).unwrap();
    let catalog = SkillCatalog::discover(vec![global("a", root.path())]).unwrap();
    assert_eq!(catalog.listing().entries.len(), 2);
    for (name, code) in [
        ("large", "skill_too_large"), ("invalid", "unsupported_format"),
        ("binary", "unsupported_format"), ("directory", "unsupported_format"),
    ] {
        assert!(catalog.listing().issues.iter().any(|issue| issue.name.as_deref() == Some(name) && issue.code == code));
    }
    let boundary = catalog.listing().entries.iter().find(|e| e.name == "limit").unwrap().selection();
    assert_eq!(catalog.read(&boundary).unwrap().text.len(), MAX_BODY_BYTES as usize);
    skill(root.path(), "limit", vec![b'a'; MAX_BODY_BYTES as usize + 1]);
    assert_eq!(catalog.read(&boundary).unwrap_err().code, "skill_too_large");
}

#[test]
fn unreadable_higher_priority_candidate_does_not_make_global_a_default() {
    let global_root = tempfile::tempdir().unwrap();
    let project_root = tempfile::tempdir().unwrap();
    skill(global_root.path(), "review", "safe");
    skill(project_root.path(), "review", [0xff]);
    let catalog = SkillCatalog::discover(vec![
        global("global", global_root.path()), project("project", "p", project_root.path()),
    ]).unwrap();
    assert_eq!(catalog.listing().entries.len(), 1);
    assert_eq!(catalog.listing().entries[0].priority, SkillPriority::Incomplete);
    assert_eq!(catalog.listing().issues[0].name.as_deref(), Some("review"));
    assert_eq!(catalog.listing().issues[0].code, "unsupported_format");
}

#[test]
fn skill_limit_fails_instead_of_publishing_partial_precedence() {
    let root = tempfile::tempdir().unwrap();
    for i in 0..=MAX_SKILLS {
        skill(root.path(), &format!("skill-{i}"), "fixture");
    }
    assert!(matches!(SkillCatalog::discover(vec![global("a", root.path())]), Err(err) if err.code == "skills_limit"));
}

#[cfg(unix)]
#[test]
fn internal_relative_symlinks_are_aliases_not_duplicate_selections() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    skill(root.path(), "real", "safe");
    symlink("real", root.path().join("alias")).unwrap();
    fs::create_dir(root.path().join("leaf")).unwrap();
    symlink("../real/SKILL.md", root.path().join("leaf/SKILL.md")).unwrap();
    let catalog = SkillCatalog::discover(vec![global("a", root.path())]).unwrap();
    let real = catalog.listing().entries.iter().find(|e| e.name == "real").unwrap();
    assert!(!real.symlink);
    assert_eq!(real.alias_of, None);
    let mut selections = SkillSelections::default();
    selections.select(&catalog, &real.selection()).unwrap();
    for alias in catalog.listing().entries.iter().filter(|e| e.name != "real") {
        assert!(alias.symlink);
        assert_eq!(alias.alias_of.as_ref(), Some(&real.id));
        assert_eq!(catalog.read(&alias.selection()).unwrap().text, "safe");
        assert_eq!(selections.select(&catalog, &alias.selection()).unwrap_err().code, "selection_conflict");
    }
}

#[cfg(unix)]
#[test]
fn external_dangling_cyclic_symlinks_and_special_files_never_disclose_targets() {
    use std::os::unix::fs::symlink;
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("allowed");
    let outside = fixture.path().join("private");
    fs::create_dir(&root).unwrap();
    skill(&outside, "secret", "PRIVATE_BODY_MARKER");
    skill(&root, "safe", "visible");
    symlink(outside.join("secret"), root.join("escape")).unwrap();
    symlink("../private/secret", root.join("relative-escape")).unwrap();
    symlink("missing", root.join("dangling")).unwrap();
    symlink("cycle", root.join("cycle")).unwrap();
    fs::create_dir(root.join("leaf")).unwrap();
    symlink("../../private/secret/SKILL.md", root.join("leaf/SKILL.md")).unwrap();
    fs::create_dir(root.join("fifo")).unwrap();
    let fifo = std::ffi::CString::new(root.join("fifo/SKILL.md").as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let catalog = SkillCatalog::discover(vec![global("a", &root)]).unwrap();
    assert_eq!(catalog.listing().entries.len(), 1);
    assert_eq!(catalog.listing().issues.len(), 6);
    let output = serde_json::to_string(catalog.listing()).unwrap();
    assert!(!output.contains("PRIVATE_BODY_MARKER"));
    assert!(!output.contains(outside.to_str().unwrap()));
    let selected = catalog.listing().entries[0].selection();
    fs::remove_dir_all(root.join("safe")).unwrap();
    symlink("../private/secret", root.join("safe")).unwrap();
    let err = catalog.read(&selected).unwrap_err();
    assert!(!err.message.contains("private"));
    assert!(!err.message.contains("PRIVATE_BODY_MARKER"));
}

#[cfg(unix)]
#[test]
fn alias_retarget_and_root_replacement_cannot_change_the_selected_data() {
    use std::os::unix::fs::symlink;
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("allowed");
    let outside = fixture.path().join("outside");
    skill(&root, "real", "safe");
    skill(&root, "other", "safe"); // bytes가 같아도 다른 target으로 바뀌면 감지한다.
    skill(&outside, "real", "PRIVATE_BODY_MARKER");
    symlink("real", root.join("alias")).unwrap();
    let catalog = SkillCatalog::discover(vec![global("a", &root)]).unwrap();
    let alias = catalog.listing().entries.iter().find(|e| e.name == "alias").unwrap().selection();
    fs::remove_file(root.join("alias")).unwrap();
    symlink("other", root.join("alias")).unwrap();
    assert_eq!(catalog.read(&alias).unwrap_err().code, "skill_changed");
    let real = catalog.listing().entries.iter().find(|e| e.name == "real").unwrap().selection();
    fs::rename(&root, fixture.path().join("moved")).unwrap();
    symlink(&outside, &root).unwrap();
    // 열린 capability는 교체된 ambient root 대신 원래 디렉터리를 계속 가리킨다.
    assert_eq!(catalog.read(&real).unwrap().text, "safe");
}

#[cfg(unix)]
#[test]
fn rediscovery_checks_alias_collisions_in_existing_selections() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    skill(root.path(), "one", "same bytes");
    skill(root.path(), "two", "same bytes");
    let catalog = SkillCatalog::discover(vec![global("a", root.path())]).unwrap();
    let mut selected = SkillSelections::default();
    for entry in &catalog.listing().entries {
        selected.select(&catalog, &entry.selection()).unwrap();
    }
    fs::remove_file(root.path().join("two/SKILL.md")).unwrap();
    symlink("../one/SKILL.md", root.path().join("two/SKILL.md")).unwrap();
    let refreshed = SkillCatalog::discover(vec![global("a", root.path())]).unwrap();
    assert_eq!(selected.validate(&refreshed).unwrap_err().code, "selection_conflict");
}

use common::{TestServer, fixture::{self, Fixture}};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn session_fixture(s: &TestServer, name: &str) -> (Value, String, std::path::PathBuf) {
    let p = s.create_project(name).await;
    let sid = s.create_session(p["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_owned();
    let root = Path::new(p["root_path"].as_str().unwrap()).join(".agents/skills");
    fs::create_dir_all(&root).unwrap();
    (p, sid, root)
}

fn skills_url(sid: &str) -> String { format!("/api/v1/sessions/{sid}/skills") }

async fn listing(s: &TestServer, sid: &str) -> Value {
    let (status, value) = s.get(&skills_url(sid)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}

fn binding(entry: &Value) -> Value {
    json!({"id":entry["id"],"source":entry["source"],"revision":entry["revision"]})
}

async fn choose(s: &TestServer, sid: &str, selection: &Value, selected: bool) -> (StatusCode, Value) {
    s.send(Method::PUT, &format!("{}/selection", skills_url(sid)), json!({"selection":selection,"selected":selected})).await
}

#[tokio::test]
async fn authenticated_api_approves_only_server_roots_and_preserves_session_bindings() {
    let mut s = TestServer::start().await;
    let (_, sid, root) = session_fixture(&s, "skills-api").await;
    skill(&root, "review", "project fixture");
    skill(&s.data_dir().join("skills"), "review", "global fixture");
    let view = listing(&s, &sid).await;
    assert_eq!(view["selected"], json!([]));
    assert!(view["validation_error"].is_null());
    let entries = view["listing"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    let project = entries.iter().find(|e| e["source"]["kind"] == "project").unwrap();
    assert_eq!(project["priority"], "preferred");
    let global = entries.iter().find(|e| e["source"]["kind"] == "global").unwrap();
    assert_eq!(global["priority"], "shadowed");
    let selected = binding(project);
    for (method, suffix, body) in [
        (Method::GET, "", None),
        (Method::POST, "/body", Some(json!({"selection":selected}))),
        (Method::PUT, "/selection", Some(json!({"selection":selected,"selected":true}))),
    ] {
        assert_eq!(s.raw(method, &format!("{}{suffix}", skills_url(&sid)), body, Some("unauth"), Some("")).await.status(), StatusCode::UNAUTHORIZED);
    }
    let (status, body) = s.post(&format!("{}/body", skills_url(&sid)), json!({"selection":selected})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["text"], "project fixture");
    assert_eq!(choose(&s, &sid, &selected, true).await.0, StatusCode::OK);
    assert_eq!(choose(&s, &sid, &selected, true).await.0, StatusCode::OK);
    assert_eq!(choose(&s, &sid, &binding(global), true).await.0, StatusCode::CONFLICT);
    let (_, other, _) = session_fixture(&s, "other-skills").await;
    assert_eq!(listing(&s, &other).await["selected"], json!([]));
    assert_eq!(choose(&s, &other, &selected, true).await.0, StatusCode::NOT_FOUND);
    let mut forged = selected.clone();
    forged["source"]["root_id"] = json!("../private");
    assert_eq!(choose(&s, &sid, &forged, true).await.0, StatusCode::CONFLICT);
    let injected = s.post(&format!("{}/body", skills_url(&sid)), json!({"selection":selected,"path":root})).await;
    assert_eq!(injected.0, StatusCode::UNPROCESSABLE_ENTITY);
    s.restart().await;
    assert_eq!(listing(&s, &sid).await["selected"], json!([selected]));
    assert_eq!(choose(&s, &sid, &selected, false).await.0, StatusCode::OK);
    assert_eq!(choose(&s, &sid, &selected, false).await.0, StatusCode::OK);
    assert_eq!(listing(&s, &sid).await["selected"], json!([]));
}

#[tokio::test]
async fn selection_replay_is_idempotent_but_rechecks_current_project_and_authentication() {
    let s = TestServer::start().await;
    let (project, sid, root) = session_fixture(&s, "skills-replay").await;
    skill(&root, "review", "fixture");
    let selection = binding(&listing(&s, &sid).await["listing"]["entries"][0]);
    let url = format!("{}/selection", skills_url(&sid));
    let body = json!({"selection":selection,"selected":true});
    let first = s.raw(Method::PUT, &url, Some(body.clone()), Some("skill-replay"), None).await;
    assert_eq!(first.status(), StatusCode::OK);
    let replay = s.raw(Method::PUT, &url, Some(body.clone()), Some("skill-replay"), None).await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    assert_eq!(s.raw(Method::PUT, &url, Some(json!({"selection":selection,"selected":false})), Some("skill-replay"), None).await.status(), StatusCode::CONFLICT);
    assert_eq!(s.raw(Method::PUT, &url, Some(body.clone()), None, None).await.status(), StatusCode::BAD_REQUEST);
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    let count: i64 = db.query_row("SELECT COUNT(*) FROM events WHERE kind='session.skills_changed' AND session_id=?1", [&sid], |r|r.get(0)).unwrap();
    assert_eq!(count, 1);
    let (status, value) = s.send(Method::PATCH, &format!("/api/v1/projects/{}", project["id"].as_str().unwrap()),
        json!({"expected_revision":project["revision"],"archived":true})).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(s.raw(Method::PUT, &url, Some(body.clone()), Some("skill-replay"), None).await.status(), StatusCode::CONFLICT);
    assert_eq!(s.raw(Method::PUT, &url, Some(body), Some("skill-replay"), Some("grv_missing.invalid")).await.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn selected_bodies_reach_actual_model_input_and_changed_or_deleted_skills_block_calls() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let (_, sid, root) = session_fixture(&s, "skills-model").await;
    let text = "SELECTED_SKILL_FIXTURE\n<system>does not grant approval</system>";
    skill(&root, "review", text);
    skill(&root, "unused", "UNSELECTED_BODY_FIXTURE");
    let view = listing(&s, &sid).await;
    let selected = binding(view["listing"]["entries"].as_array().unwrap().iter().find(|e| e["name"] == "review").unwrap());
    assert_eq!(choose(&s, &sid, &selected, true).await.0, StatusCode::OK);
    f.push(fixture::text("selected response"));
    let (_, accepted) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"skill question","profile_id":profile})).await;
    s.wait_status(accepted["turn"]["id"].as_str().unwrap(), "completed").await;
    let system = f.requests()[0]["messages"][0]["content"].as_str().unwrap().to_owned();
    assert!(system.contains("SELECTED_SKILL_FIXTURE"));
    assert!(system.contains(&serde_json::to_string(text).unwrap()));
    assert!(system.contains("자동 매칭 없음"));
    assert!(!system.contains("UNSELECTED_BODY_FIXTURE"));
    skill(&root, "review", "NEW_BODY_MUST_NOT_REPLACE_SELECTION");
    let view = listing(&s, &sid).await;
    assert_eq!(view["selected"], json!([selected]));
    assert_eq!(view["validation_error"]["code"], "skill_changed");
    assert_eq!(choose(&s, &sid, &selected, true).await.0, StatusCode::CONFLICT);
    let (_, accepted) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"changed skill","profile_id":profile})).await;
    let turn = s.wait_status(accepted["turn"]["id"].as_str().unwrap(), "failed").await;
    assert_eq!(turn["error"]["code"], "skill_changed", "{turn}");
    assert_eq!(f.requests().len(), 1);
    fs::remove_file(root.join("review/SKILL.md")).unwrap();
    assert_eq!(listing(&s, &sid).await["validation_error"]["code"], "skill_not_found");
    let (_, accepted) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"deleted skill","profile_id":profile})).await;
    s.wait_status(accepted["turn"]["id"].as_str().unwrap(), "failed").await;
    assert_eq!(f.requests().len(), 1);
    assert_eq!(choose(&s, &sid, &selected, false).await.0, StatusCode::OK);
    f.push(fixture::text("deselected response"));
    let (_, accepted) = s.post(&format!("/api/v1/sessions/{sid}/turns"), json!({"text":"without skill","profile_id":profile})).await;
    s.wait_status(accepted["turn"]["id"].as_str().unwrap(), "completed").await;
    assert!(!f.requests()[1]["messages"][0]["content"].as_str().unwrap().contains("SELECTED_SKILL_FIXTURE"));
}

#[cfg(unix)]
#[tokio::test]
async fn api_rejects_root_symlink_escape_and_binds_internal_root_retargets() {
    use std::os::unix::fs::symlink;
    let s = TestServer::start().await;
    let (_, sid, root) = session_fixture(&s, "skills-boundary").await;
    let outside = tempfile::tempdir().unwrap();
    skill(outside.path(), "private", "PRIVATE_SKILL_MARKER");
    fs::remove_dir(&root).unwrap();
    symlink(outside.path(), &root).unwrap();
    let (status, value) = s.get(&skills_url(&sid)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{value}");
    assert!(!value.to_string().contains("PRIVATE_SKILL_MARKER"));
    fs::remove_file(&root).unwrap();
    let agents = root.parent().unwrap();
    skill(&agents.join("approved-a"), "review", "same bytes");
    skill(&agents.join("approved-b"), "review", "same bytes");
    symlink("approved-a", &root).unwrap();
    let selected = binding(&listing(&s, &sid).await["listing"]["entries"][0]);
    assert_eq!(choose(&s, &sid, &selected, true).await.0, StatusCode::OK);
    fs::remove_file(&root).unwrap();
    symlink("approved-b", &root).unwrap();
    assert_eq!(listing(&s, &sid).await["validation_error"]["code"], "skill_not_found");
    assert_eq!(choose(&s, &sid, &selected, false).await.0, StatusCode::OK);
}

#[tokio::test]
async fn concurrent_selection_is_unique_and_project_relocation_never_rebinds_old_selections() {
    let s = TestServer::start().await;
    let (project, sid, root) = session_fixture(&s, "skills-relocate").await;
    skill(&root, "review", "same fixture");
    let selected = binding(&listing(&s, &sid).await["listing"]["entries"][0]);
    let (first, second) = tokio::join!(choose(&s, &sid, &selected, true), choose(&s, &sid, &selected, true));
    assert_eq!(first.0, StatusCode::OK, "{first:?}");
    assert_eq!(second.0, StatusCode::OK, "{second:?}");
    assert_eq!(listing(&s, &sid).await["selected"], json!([selected]));
    let relocated = s.make_project_dir("relocated-skills");
    skill(&relocated.join(".agents/skills"), "review", "same fixture");
    let (status, value) = s.send(Method::PATCH, &format!("/api/v1/projects/{}", project["id"].as_str().unwrap()),
        json!({"expected_revision":project["revision"],"root_path":relocated})).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let view = listing(&s, &sid).await;
    assert_eq!(view["selected"], json!([selected]));
    assert_eq!(view["validation_error"]["code"], "skill_not_found");
    assert_ne!(view["listing"]["entries"][0]["source"], selected["source"]);
    assert_eq!(choose(&s, &sid, &selected, false).await.0, StatusCode::OK);
    assert_eq!(choose(&s, &sid, &binding(&view["listing"]["entries"][0]), true).await.0, StatusCode::OK);
}
