//! 백업 staging 소유권과 덮어쓰기 금지(DB-016·017).
use grove::backup;

#[test]
fn snapshot_preserves_an_unrelated_partial_and_existing_destination() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("grove.db");
    let db = grove::store::Db::open(&source).unwrap();
    let dest = dir.path().join("snapshot.db");
    let unrelated = dest.with_extension("partial");
    std::fs::write(&unrelated, "unrelated-data").unwrap();
    backup::snapshot_to(&source, &dest).unwrap();
    backup::verify(&dest).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert_eq!(std::fs::read_to_string(&unrelated).unwrap(), "unrelated-data");
    assert!(std::fs::read_dir(dir.path()).unwrap().all(|entry| !entry.unwrap().file_name().to_string_lossy().starts_with(".grove-snapshot-")));
    let before = std::fs::read(&dest).unwrap();
    assert!(backup::snapshot_to(&source, &dest).is_err());
    assert_eq!(std::fs::read(&dest).unwrap(), before);
    assert_eq!(std::fs::read_to_string(&unrelated).unwrap(), "unrelated-data");
    drop(db);
}

#[test]
fn a_failed_snapshot_keeps_the_source_and_other_files_without_leaking_staging() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("damaged.db");
    std::fs::write(&source, "not a database").unwrap();
    let dest = dir.path().join("snapshot.db");
    let unrelated = dest.with_extension("partial");
    std::fs::write(&unrelated, "other-work").unwrap();
    assert!(backup::snapshot_to(&source, &dest).is_err());
    assert_eq!(std::fs::read_to_string(&source).unwrap(), "not a database");
    assert_eq!(std::fs::read_to_string(&unrelated).unwrap(), "other-work");
    assert!(!dest.exists());
    assert!(std::fs::read_dir(dir.path()).unwrap().all(|entry| !entry.unwrap().file_name().to_string_lossy().starts_with(".grove-snapshot-")));
}

#[cfg(unix)]
#[test]
fn snapshot_does_not_replace_a_dangling_destination_symlink() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("grove.db");
    let _db = grove::store::Db::open(&source).unwrap();
    let dest = dir.path().join("snapshot.db");
    let target = dir.path().join("not-created.db");
    symlink(&target, &dest).unwrap();
    assert!(backup::snapshot_to(&source, &dest).is_err());
    assert_eq!(std::fs::read_link(&dest).unwrap(), target);
    assert!(!target.exists());
}
