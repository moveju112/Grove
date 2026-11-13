//! 통합 담당이 src/lib.rs에 pub mod skills를 등록한 뒤 실행할 계약 회귀 시험.
//! 실제 사용자 설정·스킬·API·외부 모델을 읽거나 실행하지 않는다.

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
