use super::*;

#[cfg(unix)]
#[test]
fn parent_replacement_cannot_redirect_reads_writes_or_removals() {
    use std::os::unix::fs::symlink;
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("project");
    let outside = fixture.path().join("outside");
    std::fs::create_dir_all(root.join("folder")).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("file"), "outside").unwrap();
    let scope = ProjectFs::open(&root).unwrap();
    std::fs::rename(root.join("folder"), root.join("old-folder")).unwrap();
    symlink(&outside, root.join("folder")).unwrap();
    let path = root.join("folder/file");
    assert!(scope.read(&path, 100).is_err());
    assert!(scope.atomic_write(&path, b"overwrite").is_err());
    assert!(scope.write_new(&root.join("folder/new"), b"new").is_err());
    assert!(scope.create_dir_all(&root.join("folder/deep/new")).is_err());
    assert!(scope.remove_file(&path).is_err());
    assert!(scope.rename_noreplace(&path, &scope, &root.join("stolen")).is_err());
    scope.copy_recursive(&root.join("folder"), &root.join("copied")).unwrap();
    assert_eq!(std::fs::read_link(root.join("copied")).unwrap(), outside);
    assert!(scope.read(&root.join("copied/file"), 100).is_err());
    assert_eq!(std::fs::read(outside.join("file")).unwrap(), b"outside");
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn leaf_symlink_cannot_redirect_read_or_save_and_removal_only_unlinks_the_link() {
    use std::os::unix::fs::symlink;
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let outside = fixture.path().join("outside");
    std::fs::write(&outside, "outside").unwrap();
    let scope = ProjectFs::open(&root).unwrap();
    let link = root.join("link");
    symlink(&outside, &link).unwrap();
    assert!(scope.read(&link, 100).is_err());
    assert!(scope.atomic_write(&link, b"overwrite").is_err());
    scope.remove_file(&link).unwrap();
    assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
    assert!(link.symlink_metadata().is_err());
}

#[test]
fn new_files_never_replace_existing_entries_and_publish_cleans_its_staging() {
    let root = tempfile::tempdir().unwrap();
    let scope = ProjectFs::open(root.path()).unwrap();
    let path = root.path().join("file");
    scope.write_new(&path, b"original").unwrap();
    assert_eq!(scope.write_new(&path, b"replacement").unwrap_err().kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(std::fs::read(&path).unwrap(), b"original");
    scope.atomic_write(&path, b"updated").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"updated");
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn similar_prefixes_and_lexical_parent_components_do_not_grant_access() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let scope = ProjectFs::open(&root).unwrap();
    assert!(scope.relative(&fixture.path().join("project-sibling/file")).is_err());
    assert!(scope.relative(&root.join("../outside")).is_err());
    assert!(scope.relative(Path::new("../outside")).is_err());
    assert!(scope.relative(&root.join("folder/file")).is_ok());
}

#[cfg(unix)]
#[test]
fn recursive_copy_preserves_external_symlinks_without_reading_their_targets() {
    use std::os::unix::fs::symlink;
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("project");
    std::fs::create_dir_all(root.join("source")).unwrap();
    let outside = fixture.path().join("outside");
    std::fs::write(&outside, "outside").unwrap();
    symlink(&outside, root.join("source/link")).unwrap();
    let scope = ProjectFs::open(&root).unwrap();
    scope.copy_recursive(&root.join("source"), &root.join("copy")).unwrap();
    assert_eq!(std::fs::read_link(root.join("copy/link")).unwrap(), outside);
    assert!(scope.read(&root.join("copy/link"), 100).is_err());
    assert_eq!(std::fs::read(outside).unwrap(), b"outside");
}
