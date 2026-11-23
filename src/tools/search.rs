//! 검색 도구 find/glob/grep(TOOL-004~009). ignore 규칙(.gitignore 등)을 모든 도구에 같은 방식으로 적용한다.

use super::fs::{project_scope, rel_display, resolve};
use super::{MAX_OUTPUT, Planned, ToolError, ToolResult};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use tokio::sync::watch;

const DEFAULT_LIMIT: usize = 250;
const MAX_FILE_FOR_GREP: u64 = 4 * 1024 * 1024;

fn str_or_list(v: &Value) -> Vec<String> {
    match v {
        Value::String(s) => vec![s.clone()],
        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        _ => vec![],
    }
}

pub fn plan(args: &Value, root: &Path, name: &str) -> ToolResult<Planned> {
    let paths: Vec<String> = if args["path"].is_null() { vec![".".into()] } else { str_or_list(&args["path"]) };
    let mut resolved = vec![];
    for p in &paths {
        let r = resolve(root, p)?;
        if !r.exists() {
            return Err(ToolError::new("not_found", format!("경로가 없습니다: {p}")));
        }
        resolved.push(rel_display(root, &r));
    }
    if name == "grep" {
        for pat in str_or_list(&args["pattern"]) {
            regex::RegexBuilder::new(&pat)
                .size_limit(1 << 20)
                .build()
                .map_err(|e| ToolError::new("invalid_pattern", format!("정규식 오류: {e}")))?;
        }
    }
    if name == "glob" {
        for pat in str_or_list(&args["pattern"]) {
            globset::Glob::new(&pat).map_err(|e| ToolError::new("invalid_pattern", format!("glob 오류: {e}")))?;
        }
    }
    Ok(Planned { target: json!({ "paths": resolved, "tool": name }), precondition: None })
}

pub(crate) fn walker(root: &Path, base: &Path, include_noise: bool) -> ignore::Walk {
    walker_excluding(root, base, include_noise, None)
}

pub(crate) fn walker_excluding(root: &Path, base: &Path, include_noise: bool, excluded: Option<PathBuf>) -> ignore::Walk {
    let mut b = ignore::WalkBuilder::new(base);
    b.hidden(false).follow_links(false).require_git(false);
    if include_noise {
        b.git_ignore(false).git_global(false).git_exclude(false).ignore(false).parents(false);
    }
    // .git 디렉터리 자체는 항상 제외
    let root = root.to_path_buf();
    b.filter_entry(move |e| (e.file_name() != ".git" || e.path() == root)
        && !excluded.as_ref().is_some_and(|path| e.path().starts_with(path)));
    b.build()
}

fn bases(planned: &Planned, root: &Path) -> ToolResult<Vec<PathBuf>> {
    planned.target["paths"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| resolve(root, p.as_str().unwrap_or(".")))
        .collect()
}

fn cancelled(c: &watch::Receiver<bool>) -> ToolResult<()> {
    if *c.borrow() { Err(ToolError::new("cancelled", "취소되었습니다")) } else { Ok(()) }
}

pub fn glob(args: &Value, planned: &Planned, root: &Path, cancel: &watch::Receiver<bool>) -> ToolResult<Value> {
    let scope = project_scope(root)?;
    let mut gb = globset::GlobSetBuilder::new();
    for p in str_or_list(&args["pattern"]) {
        gb.add(globset::GlobBuilder::new(&p).literal_separator(false).build().map_err(|e| ToolError::new("invalid_pattern", e.to_string()))?);
    }
    let set = gb.build().map_err(|e| ToolError::new("invalid_pattern", e.to_string()))?;
    let noise = args["include_noise"].as_bool().unwrap_or(false);
    let mut found: Vec<(String, std::time::SystemTime)> = vec![];
    let canon_root = crate::util::canonical(root).map_err(|e| ToolError::new("project_unavailable", e.to_string()))?;
    for base in bases(planned, root)? {
        for (i, e) in walker(&canon_root, &base, noise).enumerate() {
            if i % 512 == 0 {
                cancelled(cancel)?;
            }
            let Ok(e) = e else { continue };
            if !e.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let rel_base = e.path().strip_prefix(&base).unwrap_or(e.path());
            let rel_root = e.path().strip_prefix(&canon_root).unwrap_or(e.path());
            if set.is_match(rel_base) || set.is_match(rel_root) {
                let Ok(meta) = scope.metadata(e.path()) else { continue };
                let m = meta.modified().ok().map(|t| t.into_std()).unwrap_or(std::time::UNIX_EPOCH);
                found.push((rel_display(root, e.path()), m));
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found.dedup_by(|a, b| a.0 == b.0);
    if args["sort"].as_str() != Some("natural") {
        found.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    }
    page(found.into_iter().map(|(p, _)| p).collect(), args, "files")
}

fn page(items: Vec<String>, args: &Value, key: &str) -> ToolResult<Value> {
    let total = items.len();
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    let limit = match args["limit"].as_u64() {
        Some(0) => usize::MAX,
        Some(n) => n as usize,
        None => DEFAULT_LIMIT,
    };
    let mut out = vec![];
    let mut bytes = 0;
    let mut truncated = false;
    for it in items.into_iter().skip(offset).take(limit) {
        bytes += it.len() + 4;
        if bytes > MAX_OUTPUT {
            truncated = true;
            break;
        }
        out.push(it);
    }
    let next = (offset + out.len() < total).then_some(offset + out.len());
    Ok(json!({ key: out, "total": total, "next_offset": next, "truncated": truncated }))
}

pub fn find(args: &Value, planned: &Planned, root: &Path, cancel: &watch::Receiver<bool>) -> ToolResult<Value> {
    let scope = project_scope(root)?;
    let frags: Vec<String> = args["query"].as_str().unwrap_or("").split_whitespace().map(|s| s.to_lowercase()).collect();
    if frags.is_empty() {
        return Err(ToolError::new("invalid_arguments", "query가 비어 있습니다"));
    }
    let noise = args["include_noise"].as_bool().unwrap_or(false);
    let canon_root = crate::util::canonical(root).map_err(|e| ToolError::new("project_unavailable", e.to_string()))?;
    let mut found = vec![];
    for base in bases(planned, root)? {
        for (i, e) in walker(&canon_root, &base, noise).enumerate() {
            if i % 512 == 0 {
                cancelled(cancel)?;
            }
            let Ok(e) = e else { continue };
            if e.depth() == 0 {
                continue;
            }
            if scope.symlink_metadata(e.path()).is_err() { continue; }
            let rel = rel_display(root, e.path());
            let low = rel.to_lowercase();
            if frags.iter().all(|f| low.contains(f.as_str())) {
                let suffix = if e.file_type().is_some_and(|t| t.is_dir()) { "/" } else { "" };
                found.push(format!("{rel}{suffix}"));
            }
        }
    }
    // 짧은 경로(더 구체적인 일치)를 먼저
    found.sort_by(|a, b| a.len().cmp(&b.len()).then(a.cmp(b)));
    found.dedup();
    let mut a = args.clone();
    if a["limit"].is_null() {
        a["limit"] = json!(25);
    }
    page(found, &a, "paths")
}

pub fn grep(args: &Value, planned: &Planned, root: &Path, cancel: &watch::Receiver<bool>) -> ToolResult<Value> {
    let scope = project_scope(root)?;
    let ci = args["ignore_case"].as_bool().unwrap_or(false);
    let pats: Vec<regex::Regex> = str_or_list(&args["pattern"])
        .iter()
        .map(|p| regex::RegexBuilder::new(p).case_insensitive(ci).size_limit(1 << 20).build())
        .collect::<Result<_, _>>()
        .map_err(|e| ToolError::new("invalid_pattern", e.to_string()))?;
    let glob = match args["glob"].as_str() {
        Some(g) => Some(globset::Glob::new(g).map_err(|e| ToolError::new("invalid_pattern", e.to_string()))?.compile_matcher()),
        None => None,
    };
    let mode = args["mode"].as_str().unwrap_or("content");
    let ctx = args["context"].as_u64().unwrap_or(0) as usize;
    let noise = args["include_noise"].as_bool().unwrap_or(false);
    let canon_root = crate::util::canonical(root).map_err(|e| ToolError::new("project_unavailable", e.to_string()))?;
    let mut blocks: Vec<String> = vec![];
    let mut files: Vec<String> = vec![];
    let mut counts: Vec<String> = vec![];
    let mut skipped_large = 0;
    for base in bases(planned, root)? {
        for (i, e) in walker(&canon_root, &base, noise).enumerate() {
            if i % 128 == 0 {
                cancelled(cancel)?;
            }
            let Ok(e) = e else { continue };
            if !e.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let rel = rel_display(root, e.path());
            if let Some(g) = &glob {
                let rb = e.path().strip_prefix(&base).unwrap_or(e.path());
                if !g.is_match(rb) && !g.is_match(&rel) && !e.file_name().to_str().is_some_and(|n| g.is_match(n)) {
                    continue;
                }
            }
            if e.metadata().map(|m| m.len()).unwrap_or(0) > MAX_FILE_FOR_GREP {
                skipped_large += 1;
                continue;
            }
            let Ok(bytes) = scope.read(e.path(), MAX_FILE_FOR_GREP) else { continue };
            if bytes.iter().take(8192).any(|b| *b == 0) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            let lines: Vec<&str> = text.lines().collect();
            let hits: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| pats.iter().any(|p| p.is_match(l))).map(|(i, _)| i).collect();
            if hits.is_empty() {
                continue;
            }
            match mode {
                "files" => files.push(rel),
                "count" => counts.push(format!("{rel}:{}", hits.len())),
                _ => {
                    // 인접한 일치는 context 범위를 합쳐 한 블록으로 만든다.
                    let mut i = 0;
                    while i < hits.len() {
                        let start = hits[i].saturating_sub(ctx);
                        let mut end = (hits[i] + ctx).min(lines.len() - 1);
                        let mut j = i + 1;
                        while j < hits.len() && hits[j].saturating_sub(ctx) <= end + 1 {
                            end = (hits[j] + ctx).min(lines.len() - 1);
                            j += 1;
                        }
                        let mut block = String::new();
                        for (n, line) in lines.iter().enumerate().take(end + 1).skip(start) {
                            let sep = if hits[i..j].contains(&n) { ':' } else { '-' };
                            let line: String = line.chars().take(500).collect();
                            block.push_str(&format!("{rel}{sep}{}{sep}{line}\n", n + 1));
                        }
                        blocks.push(block);
                        i = j;
                    }
                }
            }
        }
    }
    let mut v = match mode {
        "files" => page(files, args, "files")?,
        "count" => page(counts, args, "counts")?,
        _ => page(blocks, args, "matches")?,
    };
    v["skipped_large_files"] = json!(skipped_large);
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().join("r");
        std::fs::create_dir_all(r.join("src/deep")).unwrap();
        std::fs::create_dir_all(r.join("target")).unwrap();
        std::fs::write(r.join(".gitignore"), "target/\n").unwrap();
        std::fs::write(r.join("src/main.rs"), "fn main() {\n    println!(\"hi\");\n}\n").unwrap();
        std::fs::write(r.join("src/deep/lib.rs"), "pub fn hi() {}\n// hi again\n").unwrap();
        std::fs::write(r.join("target/out.rs"), "fn hi() {}\n").unwrap();
        (d, r)
    }

    fn run(name: &str, args: Value, r: &Path) -> Value {
        let (_, _tx) = (0, ());
        let (_t, rx) = watch::channel(false);
        let planned = plan(&args, r, name).unwrap();
        match name {
            "glob" => glob(&args, &planned, r, &rx),
            "find" => find(&args, &planned, r, &rx),
            _ => grep(&args, &planned, r, &rx),
        }
        .unwrap()
    }

    #[test]
    fn glob_respects_ignore_and_noise() {
        let (_d, r) = setup();
        let v = run("glob", json!({ "pattern": "**/*.rs", "sort": "natural" }), &r);
        assert_eq!(v["files"], json!(["src/deep/lib.rs", "src/main.rs"]));
        let v = run("glob", json!({ "pattern": "**/*.rs", "include_noise": true, "sort": "natural" }), &r);
        assert_eq!(v["total"], 3);
    }

    #[test]
    fn find_and_matches_fragments() {
        let (_d, r) = setup();
        let v = run("find", json!({ "query": "deep lib" }), &r);
        assert_eq!(v["paths"], json!(["src/deep/lib.rs"]));
    }

    #[test]
    fn grep_modes_context_offset() {
        let (_d, r) = setup();
        let v = run("grep", json!({ "pattern": "hi", "mode": "files" }), &r);
        assert_eq!(v["files"].as_array().unwrap().len(), 2);
        let v = run("grep", json!({ "pattern": "hi", "mode": "count", "path": "src/deep" }), &r);
        assert_eq!(v["counts"], json!(["src/deep/lib.rs:2"]));
        let v = run("grep", json!({ "pattern": "println", "context": 1 }), &r);
        let m = v["matches"][0].as_str().unwrap();
        assert!(m.contains("src/main.rs-1-fn main") && m.contains("src/main.rs:2:"), "{m}");
        let v = run("grep", json!({ "pattern": "hi", "limit": 1, "offset": 1 }), &r);
        assert_eq!(v["matches"].as_array().unwrap().len(), 1);
        assert!(plan(&json!({ "pattern": "(" }), &r, "grep").is_err());
        assert_eq!(plan(&json!({ "pattern": "x", "path": "../" }), &r, "grep").unwrap_err().code, "outside_project");
    }
}
