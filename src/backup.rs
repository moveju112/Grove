//! 일관된 snapshot과 새 디렉터리 복원(DB-016, DB-017, STORE-008).
//! - snapshot은 SQLite online backup API로 실행 중에도 일관된 시점을 복사한다.
//! - 복원은 항상 비어 있는 새 데이터 디렉터리로만 수행하고 원본을 덮어쓰지 않는다.

use crate::config::Config;
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};

/// 생성에 성공한 고유 staging만 정리한다. 예전 고정 `*.partial`은 소유권을 알 수 없어 건드리지 않는다.
struct SnapshotStage(PathBuf);

impl SnapshotStage {
    fn create(parent: &Path) -> Result<Self, String> {
        let dir = parent.join(format!(".grove-snapshot-{}", uuid::Uuid::new_v4()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&dir).map_err(|e| format!("백업 staging 생성 실패: {e}"))?;
        Ok(Self(dir))
    }
}

impl Drop for SnapshotStage {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            tracing::warn!(%error, "백업 staging 정리 실패");
        }
    }
}

pub fn snapshot_to(db_path: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        return Err(format!("{}: 이미 존재합니다. 덮어쓰지 않습니다", dest.display()));
    }
    let src = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("원본 열기 실패: {e}"))?;
    let parent = dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let stage = SnapshotStage::create(parent)?;
    let tmp = stage.0.join("snapshot.db");
    {
        let mut dst = Connection::open(&tmp).map_err(|e| format!("대상 생성 실패: {e}"))?;
        let backup = rusqlite::backup::Backup::new(&src, &mut dst).map_err(|e| e.to_string())?;
        backup
            .run_to_completion(256, std::time::Duration::from_millis(5), None)
            .map_err(|e| format!("backup 실패: {e}"))?;
    }
    verify(&tmp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).map_err(|e| format!("백업 권한 설정 실패: {e}"))?;
    }
    crate::storage::rename_noreplace(&tmp, dest).map_err(|e| format!("백업 게시 실패(기존 대상은 보존): {e}"))?;
    Ok(())
}

/// 무결성·외래키 검사. 문제가 있으면 오류 목록을 반환한다.
pub fn verify(path: &Path) -> Result<(), String> {
    inspect(path).map(|_| ()).map_err(|error| error.message)
}

/// 서버를 시작하거나 migration·복구 쓰기를 하지 않고 확인한다(DB-015).
pub fn inspect(path: &Path) -> crate::error::ApiResult<i64> {
    use crate::error::ApiError;
    use axum::http::StatusCode;
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let ic: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if ic != "ok" {
        return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "storage_corrupt", "integrity_check 실패: 원본을 보존하고 별도 복원본을 검증하세요"));
    }
    let mut st = c.prepare("PRAGMA foreign_key_check")?;
    let mut n = 0;
    for row in st.query_map([], |_| Ok(()))? { row?; n += 1; }
    if n > 0 {
        return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "storage_corrupt", format!("foreign_key_check: 위반 {n}건")));
    }
    Ok(c.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

pub fn restore_into(snapshot: &Path, new_dir: &Path) -> Result<PathBuf, String> {
    if new_dir.exists() && std::fs::read_dir(new_dir).map_err(|e| e.to_string())?.next().is_some() {
        return Err(format!("{}: 비어 있지 않은 디렉터리에는 복원하지 않습니다", new_dir.display()));
    }
    verify(snapshot)?;
    std::fs::create_dir_all(new_dir).map_err(|e| e.to_string())?;
    let target = new_dir.join("grove.db");
    std::fs::copy(snapshot, &target).map_err(|e| e.to_string())?;
    crate::store::restrict_permissions(&target);
    // schema migration을 적용하고 다시 검사한다.
    crate::store::Db::open(&target).map_err(|e| e.to_string())?;
    verify(&target)?;
    // 복원본은 원본과 다른 서버이므로 소유자 토큰을 새로 발급하게 둔다(owner-token 파일 없음).
    Ok(target)
}

pub fn cli_snapshot(dest: Option<PathBuf>, data_dir: Option<PathBuf>) -> Result<(), String> {
    let dest = dest.ok_or("대상 파일 경로가 필요합니다")?;
    let cfg = Config::from_env(data_dir, None)?;
    snapshot_to(&cfg.db_path(), &dest)?;
    println!("snapshot: {}", dest.display());
    // 저장된 API 키는 암호화되어 있어 키 파일 없이는 복원본에서 쓸 수 없다(SEC-019).
    let key = cfg.data_dir.join("secret.key");
    if key.exists() {
        println!("참고: API 키는 암호화되어 있습니다. 복원 후에도 쓰려면 {}도 따로 안전하게 보관하세요(없으면 키를 다시 입력).", key.display());
    }
    Ok(())
}

pub fn cli_restore(src: Option<PathBuf>, dir: Option<PathBuf>) -> Result<(), String> {
    let src = src.ok_or("snapshot 파일 경로가 필요합니다")?;
    let dir = dir.ok_or("새 데이터 디렉터리 경로가 필요합니다")?;
    let t = restore_into(&src, &dir)?;
    println!("restored: {}", t.display());
    Ok(())
}
