//! 파일 도구: 경로 경계, read/list, 새 파일 write, 정확 일치 edit.

use super::{MAX_OUTPUT, Planned, ToolError, ToolResult};
use crate::util::sha256_hex;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use crate::project_fs::ProjectFs;

/// 대형 파일 편집 상한.
pub const MAX_EDIT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_LINE_CHARS: usize = 2000;
/// read 한 번에 돌려주는 최대 줄 수. 더 큰 limit은 거부하지 않고 이 값으로 줄인다.
const MAX_READ_LINES: u64 = 5000;

pub(crate) fn project_scope(root: &Path) -> ToolResult<ProjectFs> {
    ProjectFs::open(root).map_err(|e| ToolError::new("project_unavailable", e.to_string()))
}

pub(crate) fn read_project(root: &Path, path: &Path, max: u64) -> ToolResult<Vec<u8>> {
    project_scope(root)?.read(path, max).map_err(|e| ToolError::new("read_failed", e.to_string()))
}

/// 프로젝트 root 안의 경로로 해석한다. 존재하는 경로는 canonicalize로 symlink 탈출까지 막는다.
/// 존재하지 않는 경로(새 파일)는 가장 가까운 존재하는 조상을 canonicalize해 검사한다.
pub fn resolve(root: &Path, rel: &str) -> ToolResult<PathBuf> {
    let root = crate::util::canonical(root).map_err(|_| ToolError::new("project_unavailable", "프로젝트 경로에 접근할 수 없습니다"))?;
    if rel.contains('\0') {
        return Err(ToolError::new("invalid_path", "경로에 NUL 문자가 있습니다"));
    }
    let p = Path::new(rel);
    let joined = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
    // 존재하는 가장 긴 접두 경로를 canonicalize하고 나머지를 붙인다.
    let mut existing = joined.clone();
    let mut tail: Vec<std::ffi::OsString> = vec![];
    loop {
        if existing.exists() || existing.symlink_metadata().is_ok() {
            break;
        }
        match (existing.file_name().map(|f| f.to_os_string()), existing.parent()) {
            (Some(f), Some(parent)) => {
                tail.push(f);
                existing = parent.to_path_buf();
            }
            _ => return Err(ToolError::new("invalid_path", "존재하지 않는 경로를 지나는 '..'은 사용할 수 없습니다")),
        }
    }
    let mut canon = crate::util::canonical(&existing).map_err(|e| ToolError::new("invalid_path", format!("경로 해석 실패: {e}")))?;
    for t in tail.iter().rev() {
        let c = Path::new(t);
        if matches!(c.components().next(), Some(Component::ParentDir | Component::CurDir)) {
            return Err(ToolError::new("outside_project", "프로젝트 밖 경로는 사용할 수 없습니다"));
        }
        canon.push(t);
    }
    if !canon.starts_with(&root) {
        return Err(ToolError::new("outside_project", "프로젝트 밖 경로는 사용할 수 없습니다"));
    }
    Ok(canon)
}

pub fn rel_display(root: &Path, p: &Path) -> String {
    let root = crate::util::canonical(root).unwrap_or_else(|_| root.to_path_buf());
    let r = p.strip_prefix(&root).unwrap_or(p);
    let s = r.to_string_lossy().replace('\\', "/");
    if s.is_empty() { ".".into() } else { s }
}

pub fn plan_read(args: &Value, root: &Path, name: &str) -> ToolResult<Planned> {
    // 배치 읽기(TOOL-010): 각 항목의 경로를 계획 단계에서 경계 검사하고, 실행 직전에 다시 검사한다.
    if name == "read" && let Some(files) = args["files"].as_array() {
        if !args["path"].is_null() {
            return Err(ToolError::new("invalid_arguments", "path와 files를 함께 쓸 수 없습니다"));
        }
        if files.is_empty() {
            return Err(ToolError::new("invalid_arguments", "files가 비어 있습니다"));
        }
        let mut out = vec![];
        for f in files {
            let rel = f["path"].as_str().ok_or_else(|| ToolError::new("invalid_arguments", "files의 각 항목에는 path가 필요합니다"))?;
            let p = resolve(root, rel)?;
            out.push(json!({ "path": rel_display(root, &p), "offset": f["offset"], "limit": f["limit"] }));
        }
        return Ok(Planned { target: json!({ "files": out, "tool": name }), precondition: None });
    }
    if name == "read" && args["path"].is_null() {
        return Err(ToolError::new("invalid_arguments", "필수 인자 path가 없습니다(여러 파일은 files)"));
    }
    let rel = args["path"].as_str().unwrap_or(".");
    let p = resolve(root, rel)?;
    Ok(Planned { target: json!({ "path": rel_display(root, &p), "tool": name }), precondition: None })
}

fn target_path(planned: &Planned, root: &Path) -> ToolResult<PathBuf> {
    // 승인 이후 symlink 교체 등으로 대상이 바뀌었는지 다시 해석해 경계를 재검사한다.
    resolve(root, planned.target["path"].as_str().unwrap_or("."))
}

fn is_binary(sample: &[u8]) -> bool {
    sample.contains(&0) || std::str::from_utf8(sample).is_err() && String::from_utf8_lossy(sample).matches('\u{FFFD}').count() > sample.len() / 20 + 1
}

/// 같은 파일의 범위를 합친다: 겹치거나 맞닿으면 하나로(끝이 없는 범위는 파일 끝까지).
fn merge_windows(mut w: Vec<(u64, Option<u64>)>) -> Vec<(u64, Option<u64>)> {
    w.sort_by_key(|x| x.0);
    let mut out: Vec<(u64, Option<u64>)> = vec![];
    for (s, e) in w {
        match out.last_mut() {
            Some((_, le)) if le.is_none_or(|le| s <= le + 1) => {
                *le = match (*le, e) {
                    (None, _) | (_, None) => None,
                    (Some(a), Some(b)) => Some(a.max(b)),
                };
            }
            _ => out.push((s, e)),
        }
    }
    out
}

fn read_batch(files: &[Value], root: &Path) -> ToolResult<Value> {
    // 파일별로 묶고(처음 나온 순서 유지) 범위를 합친다. 끝 줄 = offset + limit - 1.
    let mut order: Vec<String> = vec![];
    let mut windows: std::collections::HashMap<String, Vec<(u64, Option<u64>)>> = Default::default();
    for f in files {
        let p = f["path"].as_str().unwrap_or("").to_string();
        let s = f["offset"].as_u64().unwrap_or(1).max(1);
        let e = f["limit"].as_u64().map(|l| s + l.min(MAX_READ_LINES) - 1);
        if !windows.contains_key(&p) {
            order.push(p.clone());
        }
        windows.entry(p).or_default().push((s, e));
    }
    let mut results = vec![];
    let mut budget = MAX_OUTPUT;
    for p in order {
        for (s, e) in merge_windows(windows.remove(&p).unwrap_or_default()) {
            let sub_args = json!({ "offset": s, "limit": e.map(|e| e - s + 1) });
            let sub = Planned { target: json!({ "path": p, "tool": "read" }), precondition: None };
            // 파일별 오류는 그 항목에만 담는다(배치 전체를 실패시키지 않음).
            let mut r = match read(&sub_args, &sub, root) {
                Ok(v) => v,
                Err(err) => json!({ "path": p, "error": err.to_json()["error"] }),
            };
            // 배치 전체 출력도 한도 안에서(넘치면 남은 항목은 내용 없이 알린다).
            let n = r["content"].as_str().map(str::len).unwrap_or(0);
            if n > budget {
                r = json!({ "path": p, "start_line": s, "skipped": "batch_output_limit" });
            } else {
                budget -= n;
            }
            results.push(r);
        }
    }
    Ok(json!({ "files": results }))
}

pub fn read(args: &Value, planned: &Planned, root: &Path) -> ToolResult<Value> {
    if let Some(files) = planned.target["files"].as_array() {
        return read_batch(files, root);
    }
    let p = target_path(planned, root)?;
    let f = project_scope(root)?.open_file(&p).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => ToolError::new("not_found", "파일이 없습니다"),
        std::io::ErrorKind::IsADirectory => ToolError::new("is_directory", "디렉터리입니다. list를 사용하세요"),
        std::io::ErrorKind::InvalidInput => ToolError::new("special_file", "일반 파일이 아닙니다"),
        std::io::ErrorKind::PermissionDenied => ToolError::new("permission_denied", "읽기 권한이 없습니다"),
        _ => ToolError::new("read_failed", e.to_string()),
    })?;
    let meta = f.metadata().map_err(|e| ToolError::new("read_failed", e.to_string()))?;
    if meta.is_dir() {
        return Err(ToolError::new("is_directory", "디렉터리입니다. list를 사용하세요"));
    }
    if !meta.is_file() {
        return Err(ToolError::new("special_file", "일반 파일이 아닙니다"));
    }
    let mut head = vec![0u8; 8192.min(meta.len() as usize)];
    let mut fr = BufReader::new(f);
    fr.read_exact(&mut head).map_err(|e| ToolError::new("read_failed", e.to_string()))?;
    if is_binary(&head) {
        let n = head.len().min(512);
        return Ok(json!({
            "path": planned.target["path"], "binary": true, "size": meta.len(),
            "hex": crate::util::hex(&head[..n]), "truncated": meta.len() as usize > n,
        }));
    }
    // 전체 적재 없이 줄 단위로 읽는다(TOOL-011).
    fr.seek(SeekFrom::Start(0)).map_err(|e| ToolError::new("read_failed", e.to_string()))?;
    let offset = args["offset"].as_u64().unwrap_or(1).max(1) as usize;
    let asked = args["limit"].as_u64().unwrap_or(2000);
    let limit = asked.min(MAX_READ_LINES) as usize;
    let mut out = String::new();
    let mut line_no = 0usize;
    let mut last = offset.saturating_sub(1);
    let mut truncated = false;
    let mut invalid_utf8 = false;
    let mut total_lines = None;
    let mut reader = fr;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf).map_err(|e| ToolError::new("read_failed", e.to_string()))?;
        if n == 0 {
            total_lines = Some(line_no);
            break;
        }
        line_no += 1;
        if line_no < offset {
            continue;
        }
        if line_no >= offset + limit {
            break;
        }
        let s = match std::str::from_utf8(&buf) {
            Ok(s) => s.to_string(),
            Err(_) => {
                invalid_utf8 = true;
                String::from_utf8_lossy(&buf).to_string()
            }
        };
        let s = s.trim_end_matches(['\n', '\r']);
        let s: String = if s.chars().count() > MAX_LINE_CHARS { s.chars().take(MAX_LINE_CHARS).collect::<String>() + "…" } else { s.to_string() };
        if out.len() + s.len() + 1 > MAX_OUTPUT {
            truncated = true;
            break;
        }
        out.push_str(&s);
        out.push('\n');
        last = line_no;
    }
    // 더 읽을 줄이 남았으면 다음 시작 줄을 알려 준다(상한으로 줄였거나 출력 크기에서 잘린 경우 포함).
    let more = truncated || total_lines.is_none_or(|t| last < t);
    Ok(json!({
        "path": planned.target["path"],
        "start_line": offset, "end_line": last,
        "total_lines": total_lines,
        "content": out,
        "truncated": truncated,
        "limit_clamped": (asked > MAX_READ_LINES).then_some(MAX_READ_LINES),
        "next_offset": more.then_some(last + 1),
        "invalid_utf8": invalid_utf8,
        "sha256": file_sha(&p).ok(),
    }))
}

pub fn file_sha(p: &Path) -> std::io::Result<String> {
    reader_sha(std::fs::File::open(p)?)
}

pub(crate) fn reader_sha(mut f: impl Read) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(crate::util::hex(&h.finalize()))
}

pub fn list(args: &Value, planned: &Planned, root: &Path) -> ToolResult<Value> {
    let p = target_path(planned, root)?;
    let scope = project_scope(root)?;
    let meta = scope.metadata(&p).map_err(|e| ToolError::new("not_found", e.to_string()))?;
    if !meta.is_dir() {
        return Err(ToolError::new("not_directory", "디렉터리가 아닙니다"));
    }
    let hidden = args["hidden"].as_bool().unwrap_or(false);
    let meta = args["meta"].as_bool().unwrap_or(false);
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    let limit = args["limit"].as_u64().unwrap_or(200) as usize;
    let mut entries: Vec<_> = scope.dir.read_dir(scope.relative(&p).map_err(|e| ToolError::new("invalid_path", e.to_string()))?)
        .map_err(|e| ToolError::new("read_failed", e.to_string()))?
        .filter_map(Result::ok)
        .filter(|e| hidden || !e.file_name().to_string_lossy().starts_with('.'))
        .collect();
    entries.sort_by_key(|e| e.file_name());
    let total = entries.len();
    let items: Vec<Value> = entries
        .iter()
        .skip(offset)
        .take(limit)
        .map(|e| {
            let ft = e.file_type().ok();
            let kind = match ft {
                Some(t) if t.is_dir() => "dir",
                Some(t) if t.is_symlink() => "symlink",
                Some(t) if t.is_file() => "file",
                _ => "other",
            };
            let mut v = json!({ "name": e.file_name().to_string_lossy(), "type": kind });
            if meta {
                if let Ok(m) = e.metadata() {
                    v["size"] = json!(m.len());
                    v["mtime"] = json!(m.modified().ok().map(|t| crate::util::fmt_time(t.into_std().into())));
                    #[cfg(unix)]
                    {
                        use cap_std::fs::PermissionsExt;
                        v["mode"] = json!(format!("{:o}", m.permissions().mode() & 0o7777));
                    }
                }
            }
            v
        })
        .collect();
    let next = (offset + items.len() < total).then_some(offset + items.len());
    Ok(json!({ "path": planned.target["path"], "entries": items, "total": total, "next_offset": next }))
}

pub fn plan_write(args: &Value, root: &Path) -> ToolResult<Planned> {
    let rel = args["path"].as_str().unwrap_or("");
    let p = resolve(root, rel)?;
    if p.symlink_metadata().is_ok() {
        return Err(ToolError::new("already_exists", "이미 있는 경로입니다. 수정은 edit를 사용하세요"));
    }
    let content = args["content"].as_str().unwrap_or("");
    if content.len() as u64 > MAX_EDIT_BYTES {
        return Err(ToolError::new("too_large", "내용이 너무 큽니다"));
    }
    let parent = p.parent().ok_or_else(|| ToolError::new("invalid_path", "부모 디렉터리가 없습니다"))?;
    Ok(Planned {
        target: json!({ "path": rel_display(root, &p), "bytes": content.len(), "content_sha256": sha256_hex(content.as_bytes()),
                        "creates_dirs": !parent.exists(), "preview": preview(content) }),
        precondition: Some(json!({ "must_not_exist": true })),
    })
}

fn preview(s: &str) -> String {
    if s.chars().count() > 4000 { s.chars().take(4000).collect::<String>() + "\n…(생략)" } else { s.to_string() }
}

/// 새 파일만 만든다(create_new). 승인 이후 누군가 파일을 만들었으면 덮어쓰지 않고 실패한다.
pub fn write_new(args: &Value, planned: &Planned, root: &Path) -> ToolResult<Value> {
    let p = target_path(planned, root)?;
    let scope = project_scope(root)?;
    let content = args["content"].as_str().unwrap_or("");
    if sha256_hex(content.as_bytes()) != planned.target["content_sha256"].as_str().unwrap_or("") {
        return Err(ToolError::new("target_mismatch", "승인된 내용과 실행 내용이 다릅니다"));
    }
    if let Some(parent) = p.parent() {
        scope.create_dir_all(parent).map_err(write_error)?;
    }
    scope.write_new(&p, content.as_bytes()).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => ToolError::new("already_exists", "실행 시점에 파일이 이미 있어 덮어쓰지 않았습니다"),
        _ => write_error(e),
    })?;
    Ok(json!({ "path": planned.target["path"], "created": true, "bytes": content.len(), "sha256": sha256_hex(content.as_bytes()) }))
}

pub fn plan_edit(args: &Value, root: &Path) -> ToolResult<Planned> {
    let rel = args["path"].as_str().unwrap_or("");
    let p = resolve(root, rel)?;
    let meta = project_scope(root)?.metadata(&p).map_err(|_| ToolError::new("not_found", "파일이 없습니다"))?;
    if !meta.is_file() {
        return Err(ToolError::new("special_file", "일반 파일이 아닙니다"));
    }
    if meta.len() > MAX_EDIT_BYTES {
        return Err(ToolError::new("too_large", "편집하기에 너무 큰 파일입니다"));
    }
    let bytes = read_project(root, &p, MAX_EDIT_BYTES)?;
    let text = String::from_utf8(bytes.clone()).map_err(|_| ToolError::new("binary_file", "UTF-8 텍스트 파일만 편집할 수 있습니다"))?;
    let old = args["old_string"].as_str().unwrap_or("");
    let new = args["new_string"].as_str().unwrap_or("");
    if old == new {
        return Err(ToolError::new("no_change", "old_string과 new_string이 같습니다"));
    }
    let count = text.matches(old).count();
    let all = args["replace_all"].as_bool().unwrap_or(false);
    if count == 0 {
        return Err(ToolError::new("not_found", "old_string을 파일에서 찾지 못했습니다"));
    }
    if count > 1 && !all {
        return Err(ToolError::new("not_unique", format!("old_string이 {count}번 나옵니다. 더 긴 원문을 주거나 replace_all을 쓰세요")));
    }
    let after = if all { text.replace(old, new) } else { text.replacen(old, new, 1) };
    Ok(Planned {
        target: json!({ "path": rel_display(root, &p), "replacements": if all { count } else { 1 }, "diff": unified_diff(&text, &after, 3) }),
        precondition: Some(json!({ "sha256": sha256_hex(&bytes), "after_sha256": sha256_hex(after.as_bytes()) })),
    })
}

/// 정확 일치 교체. 실행 직전 파일 hash가 승인 당시와 다르면 쓰지 않는다(동시 편집 충돌).
pub fn edit(args: &Value, planned: &Planned, root: &Path) -> ToolResult<Value> {
    let p = target_path(planned, root)?;
    let pre = planned.precondition.as_ref().ok_or_else(|| ToolError::new("internal", "precondition 없음"))?;
    let scope = project_scope(root)?;
    let bytes = scope.read(&p, MAX_EDIT_BYTES).map_err(|e| ToolError::new("read_failed", e.to_string()))?;
    if sha256_hex(&bytes) != pre["sha256"].as_str().unwrap_or("") {
        return Err(ToolError::new("conflict", "승인 이후 파일이 변경되어 편집하지 않았습니다"));
    }
    let text = String::from_utf8(bytes).map_err(|_| ToolError::new("binary_file", "UTF-8 텍스트가 아닙니다"))?;
    let old = args["old_string"].as_str().unwrap_or("");
    let new = args["new_string"].as_str().unwrap_or("");
    let after = if args["replace_all"].as_bool().unwrap_or(false) { text.replace(old, new) } else { text.replacen(old, new, 1) };
    if sha256_hex(after.as_bytes()) != pre["after_sha256"].as_str().unwrap_or("") {
        return Err(ToolError::new("target_mismatch", "승인된 변경과 실행 결과가 다릅니다"));
    }
    scope.atomic_write(&p, after.as_bytes()).map_err(write_error)?;
    Ok(json!({ "path": planned.target["path"], "replacements": planned.target["replacements"], "before_sha256": pre["sha256"], "sha256": sha256_hex(after.as_bytes()) }))
}

/// atomic_write의 UUID staging 이름에서 원래 파일명을 얻는다. 삭제 권한·경로는 호출자가 확인한다.
pub(crate) fn atomic_staging_target(name: &str) -> Option<&str> {
    let (target, id) = name.strip_prefix('.')?.strip_suffix(".tmp")?.rsplit_once(".grove-")?;
    (!target.is_empty() && uuid::Uuid::parse_str(id).is_ok()).then_some(target)
}

/// 같은 디렉터리의 임시 파일에 쓰고 fsync 후 rename한다. 권한은 원본을 유지한다.
pub fn atomic_write(p: &Path, data: &[u8]) -> ToolResult<()> {
    use std::io::Write;
    let dir = p.parent().ok_or_else(|| ToolError::new("invalid_path", "부모 디렉터리 없음"))?;
    let perms = std::fs::metadata(p).ok().map(|m| m.permissions());
    let tmp = dir.join(format!(".{}.grove-{}.tmp", p.file_name().unwrap_or_default().to_string_lossy(), crate::util::new_id()));
    let res = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        if let Some(perm) = perms {
            std::fs::set_permissions(&tmp, perm)?;
        }
        std::fs::rename(&tmp, p)
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        return Err(write_error(e));
    }
    Ok(())
}

/// 쓰기 실패를 원인별 코드로 구분한다(STORE-007). 모델과 화면이 공간 부족·읽기 전용·사용 중을 일반 실패와 다르게 다룬다.
pub(crate) fn write_error(e: std::io::Error) -> ToolError {
    use std::io::ErrorKind as K;
    if crate::files::is_busy(&e) {
        return ToolError::new("file_busy", "다른 프로그램이 파일을 사용 중이라 쓰지 못했습니다. 닫은 뒤 다시 시도하세요");
    }
    match e.kind() {
        K::PermissionDenied => ToolError::new("permission_denied", "쓰기 권한이 없습니다"),
        K::ReadOnlyFilesystem => ToolError::new("read_only_filesystem", "읽기 전용 파일시스템이라 쓸 수 없습니다"),
        K::StorageFull | K::QuotaExceeded => ToolError::new("storage_full", "저장 공간이 부족해 쓰지 못했습니다"),
        _ => ToolError::new("write_failed", e.to_string()),
    }
}

/// 결과 불명 검토용: 현재 파일 상태를 승인 당시 기대값과 비교한다.
pub fn observe(planned: &Planned, root: &Path) -> Value {
    let p = match target_path(planned, root) {
        Ok(p) => p,
        Err(e) => return json!({ "error": e.message }),
    };
    let current = project_scope(root).ok().and_then(|s| s.open_file(&p).ok()).and_then(|f| reader_sha(f).ok());
    let pre = planned.precondition.clone().unwrap_or(Value::Null);
    let expected_after = pre["after_sha256"].as_str().map(String::from).or_else(|| planned.target["content_sha256"].as_str().map(String::from));
    let state = match (&current, &expected_after) {
        (None, _) => "missing",
        (Some(c), Some(a)) if c == a => "matches_expected_result",
        (Some(c), _) if pre["sha256"].as_str() == Some(c.as_str()) => "unchanged_from_before",
        _ => "different",
    };
    json!({ "path": planned.target["path"], "exists": current.is_some(), "current_sha256": current, "expected_sha256": expected_after, "state": state })
}

/// 간단한 줄 단위 unified diff(LCS). 승인 화면 표시용.
pub fn unified_diff(a: &str, b: &str, ctx: usize) -> String {
    let al: Vec<&str> = a.lines().collect();
    let bl: Vec<&str> = b.lines().collect();
    // 공통 접두·접미를 잘라 LCS 크기를 줄인다.
    let mut pre = 0;
    while pre < al.len() && pre < bl.len() && al[pre] == bl[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < al.len() - pre && suf < bl.len() - pre && al[al.len() - 1 - suf] == bl[bl.len() - 1 - suf] {
        suf += 1;
    }
    let am = &al[pre..al.len() - suf];
    let bm = &bl[pre..bl.len() - suf];
    let mut out = String::new();
    let start = pre.saturating_sub(ctx);
    out.push_str(&format!("@@ -{},{} +{},{} @@\n", start + 1, al.len() - suf + ctx.min(suf) - start, start + 1, bl.len() - suf + ctx.min(suf) - start));
    for l in &al[start..pre] {
        out.push_str(&format!(" {l}\n"));
    }
    if am.len() * bm.len() > 4_000_000 {
        for l in am {
            out.push_str(&format!("-{l}\n"));
        }
        for l in bm {
            out.push_str(&format!("+{l}\n"));
        }
    } else {
        let n = am.len();
        let m = bm.len();
        let mut dp = vec![vec![0u32; m + 1]; n + 1];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                dp[i][j] = if am[i] == bm[j] { dp[i + 1][j + 1] + 1 } else { dp[i + 1][j].max(dp[i][j + 1]) };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n || j < m {
            if i < n && j < m && am[i] == bm[j] {
                out.push_str(&format!(" {}\n", am[i]));
                i += 1;
                j += 1;
            } else if j < m && (i == n || dp[i][j + 1] >= dp[i + 1][j]) {
                out.push_str(&format!("+{}\n", bm[j]));
                j += 1;
            } else {
                out.push_str(&format!("-{}\n", am[i]));
                i += 1;
            }
        }
    }
    for l in &al[al.len() - suf..(al.len() - suf + ctx).min(al.len())] {
        out.push_str(&format!(" {l}\n"));
    }
    if out.len() > 32 * 1024 {
        out.truncate(32 * 1024);
        out.push_str("\n…(diff 생략)\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_errors_keep_their_cause() {
        use std::io::{Error, ErrorKind};
        assert_eq!(write_error(Error::from(ErrorKind::StorageFull)).code, "storage_full");
        assert_eq!(write_error(Error::from(ErrorKind::ReadOnlyFilesystem)).code, "read_only_filesystem");
        assert_eq!(write_error(Error::from(ErrorKind::PermissionDenied)).code, "permission_denied");
        assert_eq!(write_error(Error::from(ErrorKind::ResourceBusy)).code, "file_busy");
        assert_eq!(write_error(Error::other("x")).code, "write_failed");
    }

    /// 쓰기 실패 시 임시 파일을 남기지 않고 원본을 그대로 둔다(권한 없는 폴더로 실제 실패를 만든다).
    #[cfg(unix)]
    #[test]
    fn failed_atomic_write_keeps_original_and_leaves_no_staging() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.txt");
        std::fs::write(&p, "before").unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let denied = std::fs::OpenOptions::new().write(true).create_new(true).open(dir.path().join("probe")).is_err();
        let r = atomic_write(&p, b"after");
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        if !denied { return; } // root는 권한 검사를 우회하므로 이 환경에선 확인할 수 없다.
        assert_eq!(r.unwrap_err().code, "permission_denied");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "before");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn resolve_blocks_escape() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("root");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(d.path().join("secret"), "x").unwrap();
        assert!(resolve(&root, "sub/new.txt").is_ok());
        assert_eq!(resolve(&root, "../secret").unwrap_err().code, "outside_project");
        assert_eq!(resolve(&root, "sub/../../secret").unwrap_err().code, "outside_project");
        assert_eq!(resolve(&root, "/etc/passwd").unwrap_err().code, "outside_project");
        assert_eq!(resolve(&root, "nope/../../x").unwrap_err().code, "invalid_path");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(d.path(), root.join("link")).unwrap();
            assert_eq!(resolve(&root, "link/secret").unwrap_err().code, "outside_project");
            assert_eq!(resolve(&root, "link/newfile").unwrap_err().code, "outside_project");
        }
    }

    /// TOOL-010: 배치 읽기, 같은 파일 범위 병합, 파일별 오류 격리, 경계 검사.
    #[test]
    fn batch_read_merges_overlaps_and_isolates_errors() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::write(r.join("a.txt"), (1..=10).map(|i| format!("a{i}\n")).collect::<String>()).unwrap();
        std::fs::write(r.join("b.txt"), "b1\nb2\n").unwrap();
        let args = json!({ "files": [
            { "path": "a.txt", "offset": 2, "limit": 3 },   // 2..4
            { "path": "b.txt" },
            { "path": "a.txt", "offset": 4, "limit": 3 },   // 4..6 → 2..6으로 병합
            { "path": "a.txt", "offset": 9, "limit": 1 },   // 따로
            { "path": "none.txt" },
        ]});
        let (_, p) = crate::tools::plan("read", &args, r).unwrap();
        let v = read(&args, &p, r).unwrap();
        let f = v["files"].as_array().unwrap();
        assert_eq!(f.len(), 4, "{v}");
        assert_eq!((f[0]["path"].as_str(), f[0]["content"].as_str()), (Some("a.txt"), Some("a2\na3\na4\na5\na6\n")));
        assert_eq!(f[1]["content"], "a9\n");
        assert_eq!(f[2]["content"], "b1\nb2\n", "파일은 처음 나온 순서");
        assert_eq!(f[3]["error"]["code"], "not_found", "없는 파일은 그 항목만 오류");
        // path와 files 동시 사용·빈 files·경계 탈출은 계획 단계에서 거부
        assert!(crate::tools::plan("read", &json!({ "path": "a.txt", "files": [{ "path": "b.txt" }] }), r).is_err());
        assert!(crate::tools::plan("read", &json!({ "files": [] }), r).is_err());
        assert_eq!(crate::tools::plan("read", &json!({ "files": [{ "path": "../x" }] }), r).unwrap_err().code, "outside_project");
        assert_eq!(merge_windows(vec![(5, None), (1, Some(3)), (4, Some(4))]), vec![(1, None)], "맞닿은 범위와 끝없는 범위");
    }

    fn run_read(args: Value, root: &Path) -> ToolResult<Value> {
        let p = plan_read(&args, root, "read")?;
        read(&args, &p, root)
    }

    #[test]
    fn read_ranges_binary_and_errors() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::write(r.join("t.txt"), "1\n2\n3\n4\n5\n").unwrap();
        let v = run_read(json!({ "path": "t.txt", "offset": 2, "limit": 2 }), r).unwrap();
        assert_eq!(v["content"], "2\n3\n");
        // 실제 모델이 보낸 offset 0(다른 도구의 0-based 습관)은 첫 줄부터로 받아들인다.
        // schema 검증(tools::plan)을 거치는 실제 경로로 확인한다.
        let a0 = json!({ "path": "t.txt", "offset": 0, "limit": 2 });
        let (_, p0) = crate::tools::plan("read", &a0, r).expect("offset 0은 schema에서 거부되지 않는다");
        let v0 = read(&a0, &p0, r).unwrap();
        assert_eq!(v0["content"], "1\n2\n");
        assert_eq!(v0["next_offset"], 3, "더 읽을 줄이 남았다");
        // 큰 limit(실제 모델이 보낸 1000000)은 상한으로 줄여 실행하고 그 사실을 알린다.
        let big = json!({ "path": "t.txt", "limit": 1_000_000 });
        let (_, pb) = crate::tools::plan("read", &big, r).expect("큰 limit은 거부하지 않는다");
        let vb = read(&big, &pb, r).unwrap();
        assert_eq!(vb["content"], "1\n2\n3\n4\n5\n");
        assert_eq!(vb["limit_clamped"], 5000);
        assert!(vb["next_offset"].is_null(), "파일 끝까지 읽었다");
        // 선택 인자의 null은 생략과 같고, 필수 인자의 null은 "없음"으로 알린다.
        let nulls = json!({ "path": "t.txt", "offset": null, "limit": null });
        let (_, pn) = crate::tools::plan("read", &nulls, r).expect("선택 인자 null 허용");
        assert_eq!(read(&nulls, &pn, r).unwrap()["content"], "1\n2\n3\n4\n5\n");
        let e = crate::tools::plan("read", &json!({ "path": null, "limit": null }), r).unwrap_err();
        assert!(e.message.starts_with("필수 인자 path가 없습니다"), "{}", e.message);
        assert_eq!((v["start_line"].as_u64(), v["end_line"].as_u64()), (Some(2), Some(3)));
        let mut bin = vec![0u8, 1, 2, 255];
        bin.extend(std::iter::repeat_n(7u8, 1000));
        std::fs::write(r.join("b.bin"), &bin).unwrap();
        let v = run_read(json!({ "path": "b.bin" }), r).unwrap();
        assert_eq!(v["binary"], true);
        assert!(v["hex"].as_str().unwrap().starts_with("000102ff"));
        assert_eq!(v["truncated"], true);
        std::fs::write(r.join("latin.txt"), b"caf\xe9\nok\n").unwrap();
        let v = run_read(json!({ "path": "latin.txt" }), r).unwrap();
        assert_eq!(v["invalid_utf8"], true);
        std::fs::create_dir(r.join("dir")).unwrap();
        assert_eq!(run_read(json!({ "path": "dir" }), r).unwrap_err().code, "is_directory");
        assert_eq!(run_read(json!({ "path": "nope.txt" }), r).unwrap_err().code, "not_found");
    }

    #[test]
    fn list_hidden_meta_and_pages() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        for n in ["a", "b", "c", ".h"] {
            std::fs::write(r.join(n), "x").unwrap();
        }
        let args = json!({ "limit": 2 });
        let p = plan_read(&args, r, "list").unwrap();
        let v = list(&args, &p, r).unwrap();
        assert_eq!(v["entries"].as_array().unwrap().len(), 2);
        assert_eq!(v["total"], 3);
        assert_eq!(v["next_offset"], 2);
        let args = json!({ "hidden": true, "meta": true, "offset": 0 });
        let v = list(&args, &p, r).unwrap();
        assert_eq!(v["total"], 4);
        assert_eq!(v["entries"][0]["name"], ".h");
        assert_eq!(v["entries"][0]["size"], 1);
        assert!(v["entries"][0]["mode"].is_string());
    }

    #[test]
    fn edit_requires_unique_match_and_preserves_permissions() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::write(r.join("e.txt"), "x x\n").unwrap();
        let e = plan_edit(&json!({ "path": "e.txt", "old_string": "x", "new_string": "y" }), r).unwrap_err();
        assert_eq!(e.code, "not_unique");
        let args = json!({ "path": "e.txt", "old_string": "x", "new_string": "y", "replace_all": true });
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(r.join("e.txt"), std::fs::Permissions::from_mode(0o640)).unwrap();
        }
        let p = plan_edit(&args, r).unwrap();
        edit(&args, &p, r).unwrap();
        assert_eq!(std::fs::read_to_string(r.join("e.txt")).unwrap(), "y y\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(r.join("e.txt")).unwrap().permissions().mode() & 0o777, 0o640);
        }
        // 같은 계획을 다시 실행하면 hash가 달라 충돌
        assert_eq!(edit(&args, &p, r).unwrap_err().code, "conflict");
        assert!(std::fs::read_dir(r).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains(".grove-")), "임시 파일이 남지 않는다");
    }

    #[test]
    fn diff_shows_changes() {
        let d = unified_diff("a\nb\nc\n", "a\nB\nc\n", 1);
        assert!(d.contains("-b\n") && d.contains("+B\n"), "{d}");
    }
}
