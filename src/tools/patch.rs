//! apply_patch(TOOL-021~023). 여러 파일의 추가·수정·삭제·이동을 한 번의 승인으로 적용한다.
//!
//! 형식:
//! ```text
//! *** Begin Patch
//! *** Add File: path
//! +line
//! *** Update File: path
//! *** Move to: new/path          (선택)
//! @@ 선택적 위치 표시 줄
//!  문맥
//! -지울 줄
//! +넣을 줄
//! *** Delete File: path
//! *** End Patch
//! ```
//! - 계획 단계에서 모든 파일의 결과를 계산하고 파일별 sha256 조건을 고정한다.
//! - 실행 단계는 모든 조건을 먼저 확인한 뒤 쓴다. 쓰다가 실패하면 이미 바꾼 파일을 되돌리고
//!   실제 반영·되돌림 결과를 정확히 반환한다(TOOL-022).
//! - 원본의 CRLF와 끝 개행 유무를 보존한다. 경로는 프로젝트 경계 안에서만 해석한다(symlink는 대상 파일을 고친다).

use super::fs::{MAX_EDIT_BYTES, atomic_write, rel_display, resolve, unified_diff};
use super::{Planned, ToolError, ToolResult};
use crate::util::sha256_hex;
use serde_json::{Value, json};
use std::path::Path;

pub const MAX_PATCH_BYTES: usize = 4 * 1024 * 1024;
const MAX_FILES: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    Add { path: String, lines: Vec<String> },
    Delete { path: String },
    Update { path: String, move_to: Option<String>, chunks: Vec<Chunk> },
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Chunk {
    pub anchor: Option<String>,
    /// (' ' | '-' | '+', 내용)
    pub lines: Vec<(char, String)>,
    pub end_of_file: bool,
}

fn perr(m: impl Into<String>) -> ToolError {
    ToolError::new("invalid_patch", m)
}

pub fn parse(text: &str) -> ToolResult<Vec<Op>> {
    let text = text.replace("\r\n", "\n");
    let mut lines = text.lines().peekable();
    // 앞뒤 공백 줄 허용
    while lines.peek().is_some_and(|l| l.trim().is_empty()) {
        lines.next();
    }
    if lines.next().map(str::trim) != Some("*** Begin Patch") {
        return Err(perr("패치는 '*** Begin Patch'로 시작해야 합니다"));
    }
    let mut ops = vec![];
    let mut ended = false;
    while let Some(line) = lines.next() {
        if line.trim() == "*** End Patch" {
            ended = true;
            break;
        }
        if let Some(p) = line.strip_prefix("*** Add File: ") {
            let mut body = vec![];
            while let Some(l) = lines.peek() {
                if l.starts_with("*** ") {
                    break;
                }
                let l = lines.next().unwrap_or_default();
                match l.strip_prefix('+') {
                    Some(c) => body.push(c.to_string()),
                    None => return Err(perr(format!("Add File 본문 줄은 '+'로 시작해야 합니다: {l}"))),
                }
            }
            ops.push(Op::Add { path: p.trim().to_string(), lines: body });
        } else if let Some(p) = line.strip_prefix("*** Delete File: ") {
            ops.push(Op::Delete { path: p.trim().to_string() });
        } else if let Some(p) = line.strip_prefix("*** Update File: ") {
            let mut move_to = None;
            if let Some(m) = lines.peek().and_then(|l| l.strip_prefix("*** Move to: ")) {
                move_to = Some(m.trim().to_string());
                lines.next();
            }
            let mut chunks: Vec<Chunk> = vec![];
            while let Some(l) = lines.peek() {
                if l.starts_with("*** ") && *l != "*** End of File" {
                    break;
                }
                let l = lines.next().unwrap_or_default();
                if l == "*** End of File" {
                    match chunks.last_mut() {
                        Some(c) => c.end_of_file = true,
                        None => return Err(perr("'*** End of File' 앞에 hunk가 없습니다")),
                    }
                    continue;
                }
                if let Some(a) = l.strip_prefix("@@") {
                    let a = a.trim();
                    chunks.push(Chunk { anchor: (!a.is_empty()).then(|| a.to_string()), ..Default::default() });
                    continue;
                }
                if chunks.is_empty() {
                    chunks.push(Chunk::default());
                }
                let c = chunks.last_mut().expect("chunk");
                match l.chars().next() {
                    Some(k @ (' ' | '-' | '+')) => c.lines.push((k, l[1..].to_string())),
                    // 빈 줄은 빈 문맥 줄로 본다(편집기가 앞 공백을 지운 경우).
                    None => c.lines.push((' ', String::new())),
                    _ => return Err(perr(format!("hunk 줄은 ' ', '-', '+'로 시작해야 합니다: {l}"))),
                }
            }
            if chunks.iter().all(|c| c.lines.iter().all(|(k, _)| *k == ' ')) && move_to.is_none() {
                return Err(perr(format!("{p}: 바꿀 내용이 없습니다")));
            }
            ops.push(Op::Update { path: p.trim().to_string(), move_to, chunks });
        } else if line.trim().is_empty() {
            continue;
        } else {
            return Err(perr(format!("알 수 없는 줄: {line}")));
        }
    }
    if !ended {
        return Err(perr("패치는 '*** End Patch'로 끝나야 합니다"));
    }
    if ops.is_empty() {
        return Err(perr("바꿀 파일이 없습니다"));
    }
    if ops.len() > MAX_FILES {
        return Err(perr(format!("한 패치에 {MAX_FILES}개 파일까지 바꿀 수 있습니다")));
    }
    Ok(ops)
}

/// 원본 줄바꿈 형식.
struct Text {
    lines: Vec<String>,
    crlf: bool,
    trailing_newline: bool,
}

fn split(s: &str) -> Text {
    let crlf = s.contains("\r\n");
    let trailing_newline = s.ends_with('\n');
    let body = s.strip_suffix('\n').unwrap_or(s);
    let lines = if s.is_empty() { vec![] } else { body.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect() };
    Text { lines, crlf, trailing_newline }
}

fn join(t: &Text) -> String {
    let nl = if t.crlf { "\r\n" } else { "\n" };
    let mut s = t.lines.join(nl);
    if t.trailing_newline && !t.lines.is_empty() {
        s.push_str(nl);
    }
    s
}

fn find(hay: &[String], needle: &[String], from: usize, eof: bool, loose: bool) -> Option<usize> {
    if needle.is_empty() {
        return Some(if eof { hay.len() } else { from });
    }
    let eq = |a: &str, b: &str| if loose { a.trim_end() == b.trim_end() } else { a == b };
    let last = hay.len().checked_sub(needle.len())?;
    let range: Box<dyn Iterator<Item = usize>> = if eof { Box::new(std::iter::once(last)) } else { Box::new(from..=last) };
    range.filter(|i| *i >= from).find(|&i| needle.iter().enumerate().all(|(j, n)| eq(&hay[i + j], n)))
}

/// 수정 hunk를 순서대로 적용한다. 정확 일치를 먼저, 그다음 줄 끝 공백만 무시한 일치를 시도한다.
pub fn apply_chunks(path: &str, original: &str, chunks: &[Chunk]) -> ToolResult<String> {
    let mut t = split(original);
    let mut cursor = 0usize;
    for (n, c) in chunks.iter().enumerate() {
        if let Some(a) = &c.anchor {
            match t.lines[cursor..].iter().position(|l| l.trim() == a.trim()) {
                Some(p) => cursor += p + 1,
                None => return Err(ToolError::new("patch_mismatch", format!("{path}: hunk {}의 위치 표시 '{a}'를 찾지 못했습니다", n + 1))),
            }
        }
        let old: Vec<String> = c.lines.iter().filter(|(k, _)| *k != '+').map(|(_, s)| s.clone()).collect();
        let new: Vec<String> = c.lines.iter().filter(|(k, _)| *k != '-').map(|(_, s)| s.clone()).collect();
        let at = find(&t.lines, &old, cursor, c.end_of_file, false)
            .or_else(|| find(&t.lines, &old, cursor, c.end_of_file, true))
            .ok_or_else(|| ToolError::new("patch_mismatch", format!("{path}: hunk {}의 원문이 현재 파일과 맞지 않습니다", n + 1)))?;
        t.lines.splice(at..at + old.len(), new.iter().cloned());
        cursor = at + new.len();
    }
    Ok(join(&t))
}

fn read_text(p: &Path, rel: &str) -> ToolResult<(Vec<u8>, String)> {
    let meta = std::fs::metadata(p).map_err(|_| ToolError::new("not_found", format!("{rel}: 파일이 없습니다")))?;
    if !meta.is_file() {
        return Err(ToolError::new("special_file", format!("{rel}: 일반 파일이 아닙니다")));
    }
    if meta.len() > MAX_EDIT_BYTES {
        return Err(ToolError::new("too_large", format!("{rel}: 편집하기에 너무 큰 파일입니다")));
    }
    let b = std::fs::read(p).map_err(|e| ToolError::new("read_failed", format!("{rel}: {e}")))?;
    let s = String::from_utf8(b.clone()).map_err(|_| ToolError::new("binary_file", format!("{rel}: UTF-8 텍스트만 편집할 수 있습니다")))?;
    Ok((b, s))
}

/// 계획: 모든 결과를 계산해 target(파일별 diff)과 precondition(파일별 sha)을 고정한다.
pub fn plan(args: &Value, root: &Path) -> ToolResult<Planned> {
    let text = args["patch"].as_str().unwrap_or("");
    if text.len() > MAX_PATCH_BYTES {
        return Err(ToolError::new("too_large", "패치가 너무 큽니다"));
    }
    let ops = parse(text)?;
    let mut files = vec![];
    let mut writes = vec![];
    let mut seen = std::collections::HashSet::new();
    for op in &ops {
        match op {
            Op::Add { path, lines } => {
                let p = resolve(root, path)?;
                let rel = rel_display(root, &p);
                if p.symlink_metadata().is_ok() {
                    return Err(ToolError::new("already_exists", format!("{rel}: 이미 있는 파일입니다. Update File을 쓰세요")));
                }
                let mut content = lines.join("\n");
                if !lines.is_empty() {
                    content.push('\n');
                }
                files.push(json!({ "op": "add", "path": rel, "diff": unified_diff("", &content, 3) }));
                writes.push(json!({ "op": "add", "path": rel, "before": null, "after": content, "after_sha256": sha256_hex(content.as_bytes()) }));
                if !seen.insert(rel.clone()) {
                    return Err(perr(format!("{rel}: 한 패치에서 같은 파일을 두 번 바꿀 수 없습니다")));
                }
            }
            Op::Delete { path } => {
                let p = resolve(root, path)?;
                let rel = rel_display(root, &p);
                let (b, s) = read_text(&p, &rel)?;
                files.push(json!({ "op": "delete", "path": rel, "diff": unified_diff(&s, "", 3) }));
                writes.push(json!({ "op": "delete", "path": rel, "before_sha256": sha256_hex(&b) }));
                if !seen.insert(rel.clone()) {
                    return Err(perr(format!("{rel}: 한 패치에서 같은 파일을 두 번 바꿀 수 없습니다")));
                }
            }
            Op::Update { path, move_to, chunks } => {
                let p = resolve(root, path)?;
                let rel = rel_display(root, &p);
                let (b, s) = read_text(&p, &rel)?;
                let after = apply_chunks(&rel, &s, chunks)?;
                let dest = match move_to {
                    Some(m) => {
                        let d = resolve(root, m)?;
                        let drel = rel_display(root, &d);
                        if d.symlink_metadata().is_ok() {
                            return Err(ToolError::new("already_exists", format!("{drel}: 이동할 대상이 이미 있습니다")));
                        }
                        if !seen.insert(drel.clone()) {
                            return Err(perr(format!("{drel}: 한 패치에서 같은 파일을 두 번 바꿀 수 없습니다")));
                        }
                        Some(drel)
                    }
                    None => None,
                };
                if !seen.insert(rel.clone()) {
                    return Err(perr(format!("{rel}: 한 패치에서 같은 파일을 두 번 바꿀 수 없습니다")));
                }
                files.push(json!({ "op": "update", "path": rel, "move_to": dest, "diff": unified_diff(&s, &after, 3) }));
                writes.push(json!({ "op": "update", "path": rel, "move_to": dest, "before_sha256": sha256_hex(&b), "after": after, "after_sha256": sha256_hex(after.as_bytes()) }));
            }
        }
    }
    Ok(Planned { target: json!({ "files": files }), precondition: Some(json!({ "writes": writes })) })
}

/// 실행: 모든 조건 확인 → 순서대로 쓰기 → 실패 시 되돌림.
pub fn execute(planned: &Planned, root: &Path) -> ToolResult<Value> {
    let writes = planned.precondition.as_ref().and_then(|p| p["writes"].as_array()).ok_or_else(|| ToolError::new("internal", "precondition 없음"))?.clone();
    // 1) 사전 확인(아무것도 쓰기 전)
    for w in &writes {
        let rel = w["path"].as_str().unwrap_or("");
        let p = resolve(root, rel)?;
        match w["op"].as_str() {
            Some("add") => {
                if p.symlink_metadata().is_ok() {
                    return Err(ToolError::new("conflict", format!("{rel}: 승인 이후 파일이 생겨 패치를 적용하지 않았습니다")));
                }
            }
            _ => {
                let b = std::fs::read(&p).map_err(|_| ToolError::new("conflict", format!("{rel}: 승인 이후 파일이 사라져 패치를 적용하지 않았습니다")))?;
                if sha256_hex(&b) != w["before_sha256"].as_str().unwrap_or("") {
                    return Err(ToolError::new("conflict", format!("{rel}: 승인 이후 파일이 바뀌어 패치를 적용하지 않았습니다")));
                }
            }
        }
        if let Some(m) = w["move_to"].as_str()
            && resolve(root, m)?.symlink_metadata().is_ok()
        {
            return Err(ToolError::new("conflict", format!("{m}: 승인 이후 이동 대상이 생겨 패치를 적용하지 않았습니다")));
        }
    }
    // 2) 적용. 되돌림용 원본을 기억한다.
    enum Undo {
        Remove(std::path::PathBuf),
        Restore(std::path::PathBuf, Vec<u8>),
    }
    let mut undo: Vec<Undo> = vec![];
    let mut applied: Vec<Value> = vec![];
    let mut failure: Option<(String, ToolError)> = None;
    for w in &writes {
        let rel = w["path"].as_str().unwrap_or("").to_string();
        let res = (|| -> ToolResult<()> {
            let p = resolve(root, &rel)?;
            match w["op"].as_str() {
                Some("add") => {
                    if let Some(parent) = p.parent() {
                        std::fs::create_dir_all(parent).map_err(|e| ToolError::new("write_failed", e.to_string()))?;
                        resolve(root, &rel)?;
                    }
                    atomic_write(&p, w["after"].as_str().unwrap_or("").as_bytes())?;
                    undo.push(Undo::Remove(p));
                }
                Some("delete") => {
                    let orig = std::fs::read(&p).map_err(|e| ToolError::new("read_failed", e.to_string()))?;
                    std::fs::remove_file(&p).map_err(|e| ToolError::new("write_failed", e.to_string()))?;
                    undo.push(Undo::Restore(p, orig));
                }
                _ => {
                    let orig = std::fs::read(&p).map_err(|e| ToolError::new("read_failed", e.to_string()))?;
                    let after = w["after"].as_str().unwrap_or("");
                    match w["move_to"].as_str() {
                        Some(m) => {
                            let d = resolve(root, m)?;
                            if let Some(parent) = d.parent() {
                                std::fs::create_dir_all(parent).map_err(|e| ToolError::new("write_failed", e.to_string()))?;
                            }
                            atomic_write(&d, after.as_bytes())?;
                            undo.push(Undo::Remove(d));
                            std::fs::remove_file(&p).map_err(|e| ToolError::new("write_failed", e.to_string()))?;
                            undo.push(Undo::Restore(p, orig));
                        }
                        None => {
                            atomic_write(&p, after.as_bytes())?;
                            undo.push(Undo::Restore(p, orig));
                        }
                    }
                }
            }
            Ok(())
        })();
        match res {
            Ok(()) => applied.push(json!({ "op": w["op"], "path": rel, "move_to": w["move_to"], "sha256": w["after_sha256"] })),
            Err(e) => {
                failure = Some((rel, e));
                break;
            }
        }
    }
    let Some((failed_path, err)) = failure else {
        return Ok(json!({ "applied": applied, "files": applied.len() }));
    };
    // 3) 되돌림(역순). 되돌리지 못한 파일은 그대로 보고한다.
    let mut not_restored = vec![];
    for u in undo.into_iter().rev() {
        let (p, r) = match u {
            Undo::Remove(p) => {
                let r = std::fs::remove_file(&p);
                (p, r.map_err(|e| e.to_string()))
            }
            Undo::Restore(p, b) => {
                let r = atomic_write(&p, &b).map_err(|e| e.message);
                (p, r)
            }
        };
        if let Err(e) = r {
            not_restored.push(json!({ "path": rel_display(root, &p), "error": e }));
        }
    }
    let msg = if not_restored.is_empty() {
        format!("{failed_path}에서 실패해 이미 바꾼 {}개 파일을 원래대로 되돌렸습니다: {}", applied.len(), err.message)
    } else {
        format!("{failed_path}에서 실패했고 일부 파일을 되돌리지 못했습니다: {}. 되돌리지 못한 파일: {}", err.message, json!(not_restored))
    };
    Err(ToolError::new(if not_restored.is_empty() { "patch_rolled_back" } else { "patch_partial" }, msg))
}

/// 결과 불명 검토: 파일마다 지금 상태가 패치 전·후 중 어느 쪽인지 알려 준다.
pub fn observe(planned: &Planned, root: &Path) -> Value {
    let writes = planned.precondition.as_ref().and_then(|p| p["writes"].as_array()).cloned().unwrap_or_default();
    let files: Vec<Value> = writes
        .iter()
        .map(|w| {
            let rel = w["path"].as_str().unwrap_or("");
            let dest = w["move_to"].as_str().unwrap_or(rel);
            let sha = |r: &str| resolve(root, r).ok().and_then(|p| std::fs::read(p).ok()).map(|b| sha256_hex(&b));
            let (cur_src, cur_dest) = (sha(rel), sha(dest));
            let state = match w["op"].as_str() {
                Some("add") => match cur_src.as_deref() {
                    None => "before",
                    Some(s) if Some(s) == w["after_sha256"].as_str() => "after",
                    Some(_) => "other",
                },
                Some("delete") => match cur_src.as_deref() {
                    None => "after",
                    Some(s) if Some(s) == w["before_sha256"].as_str() => "before",
                    Some(_) => "other",
                },
                _ => {
                    let after = w["after_sha256"].as_str();
                    if cur_dest.as_deref() == after && (dest == rel || cur_src.is_none()) {
                        "after"
                    } else if cur_src.as_deref() == w["before_sha256"].as_str() && (dest == rel || cur_dest.is_none()) {
                        "before"
                    } else {
                        "other"
                    }
                }
            };
            json!({ "op": w["op"], "path": rel, "move_to": w["move_to"], "state": state })
        })
        .collect();
    json!({ "files": files })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observe_reports_per_file_state() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::write(r.join("a.txt"), "1\n").unwrap();
        let planned = plan(&json!({ "patch": "*** Begin Patch\n*** Update File: a.txt\n-1\n+one\n*** Add File: n.txt\n+n\n*** End Patch" }), r).unwrap();
        let before = observe(&planned, r);
        assert!(before["files"].as_array().unwrap().iter().all(|f| f["state"] == "before"), "{before}");
        execute(&planned, r).unwrap();
        let after = observe(&planned, r);
        assert!(after["files"].as_array().unwrap().iter().all(|f| f["state"] == "after"), "{after}");
    }

    fn patch(root: &Path, p: &str) -> ToolResult<(Planned, Value)> {
        let planned = plan(&json!({ "patch": p }), root)?;
        let r = execute(&planned, root)?;
        Ok((planned, r))
    }

    #[test]
    fn add_update_delete_move_multi_hunk() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::write(r.join("a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n").unwrap();
        std::fs::write(r.join("gone.txt"), "x\n").unwrap();
        std::fs::write(r.join("mv.txt"), "keep\nold\n").unwrap();
        let p = "*** Begin Patch\n*** Add File: new/b.txt\n+hello\n+world\n*** Update File: a.txt\n@@\n one\n-two\n+TWO\n three\n@@\n five\n-six\n+SIX\n*** Delete File: gone.txt\n*** Update File: mv.txt\n*** Move to: moved/mv.txt\n keep\n-old\n+new\n*** End Patch\n";
        let (planned, res) = patch(r, p).unwrap();
        assert_eq!(planned.target["files"].as_array().unwrap().len(), 4);
        assert_eq!(res["files"], 4);
        assert_eq!(std::fs::read_to_string(r.join("new/b.txt")).unwrap(), "hello\nworld\n");
        assert_eq!(std::fs::read_to_string(r.join("a.txt")).unwrap(), "one\nTWO\nthree\nfour\nfive\nSIX\n");
        assert!(!r.join("gone.txt").exists());
        assert!(!r.join("mv.txt").exists());
        assert_eq!(std::fs::read_to_string(r.join("moved/mv.txt")).unwrap(), "keep\nnew\n");
    }

    #[test]
    fn preserves_crlf_and_missing_final_newline() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::write(r.join("w.txt"), "a\r\nb\r\nc").unwrap();
        patch(r, "*** Begin Patch\n*** Update File: w.txt\n a\n-b\n+B\n c\n*** End Patch").unwrap();
        assert_eq!(std::fs::read(r.join("w.txt")).unwrap(), b"a\r\nB\r\nc");
    }

    #[test]
    fn anchor_and_end_of_file() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::write(r.join("f.rs"), "fn a() {\n    x();\n}\nfn b() {\n    x();\n}\n").unwrap();
        patch(r, "*** Begin Patch\n*** Update File: f.rs\n@@ fn b() {\n-    x();\n+    y();\n*** End Patch").unwrap();
        assert_eq!(std::fs::read_to_string(r.join("f.rs")).unwrap(), "fn a() {\n    x();\n}\nfn b() {\n    y();\n}\n");
        std::fs::write(r.join("e.txt"), "z\nz\n").unwrap();
        patch(r, "*** Begin Patch\n*** Update File: e.txt\n-z\n+END\n*** End of File\n*** End Patch").unwrap();
        assert_eq!(std::fs::read_to_string(r.join("e.txt")).unwrap(), "z\nEND\n");
    }

    #[test]
    fn mismatch_and_bad_format_are_rejected_at_plan() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::write(r.join("a.txt"), "x\n").unwrap();
        let e = plan(&json!({ "patch": "*** Begin Patch\n*** Update File: a.txt\n-nope\n+y\n*** End Patch" }), r).unwrap_err();
        assert_eq!(e.code, "patch_mismatch");
        assert_eq!(plan(&json!({ "patch": "*** Update File: a.txt" }), r).unwrap_err().code, "invalid_patch");
        assert_eq!(plan(&json!({ "patch": "*** Begin Patch\n*** Add File: a.txt\n+z\n*** End Patch" }), r).unwrap_err().code, "already_exists");
        assert_eq!(plan(&json!({ "patch": "*** Begin Patch\n*** Add File: ../x\n+z\n*** End Patch" }), r).unwrap_err().code, "outside_project");
    }

    #[test]
    fn conflict_after_approval_writes_nothing() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::write(r.join("a.txt"), "1\n").unwrap();
        std::fs::write(r.join("b.txt"), "2\n").unwrap();
        let planned = plan(&json!({ "patch": "*** Begin Patch\n*** Update File: a.txt\n-1\n+one\n*** Update File: b.txt\n-2\n+two\n*** End Patch" }), r).unwrap();
        std::fs::write(r.join("b.txt"), "changed\n").unwrap();
        let e = execute(&planned, r).unwrap_err();
        assert_eq!(e.code, "conflict");
        assert_eq!(std::fs::read_to_string(r.join("a.txt")).unwrap(), "1\n", "사전 확인에서 막혀 아무것도 쓰지 않는다");
    }

    #[cfg(unix)]
    #[test]
    fn write_failure_midway_rolls_back_applied_files() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return; // root는 권한 검사를 우회한다
        }
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::write(r.join("a.txt"), "1\n").unwrap();
        std::fs::create_dir(r.join("ro")).unwrap();
        std::fs::write(r.join("ro/b.txt"), "2\n").unwrap();
        let planned = plan(&json!({ "patch": "*** Begin Patch\n*** Update File: a.txt\n-1\n+one\n*** Update File: ro/b.txt\n-2\n+two\n*** End Patch" }), r).unwrap();
        std::fs::set_permissions(r.join("ro"), std::fs::Permissions::from_mode(0o555)).unwrap();
        let e = execute(&planned, r).unwrap_err();
        std::fs::set_permissions(r.join("ro"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(e.code, "patch_rolled_back", "{}", e.message);
        assert!(e.message.contains("ro/b.txt"));
        assert_eq!(std::fs::read_to_string(r.join("a.txt")).unwrap(), "1\n", "앞서 바꾼 파일은 되돌린다");
        assert_eq!(std::fs::read_to_string(r.join("ro/b.txt")).unwrap(), "2\n");
    }
}
