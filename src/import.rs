//! 기존 Paseo 대화 기록 가져오기(MIG-001~015, FLOW-08).
//!
//! 원본: `<paseodog>/sessions/*.json`(형식 version 2). 조사 결과는 `migration/import-survey.md`.
//! - 원본은 읽기만 한다(MIG-011). 서버와 같은 데이터 디렉터리 잠금을 잡으므로 서버 실행 중에는 거부한다.
//! - 대화 하나 = transaction 하나. `import_map`을 같은 transaction에 기록해 중단 후 재실행해도 중복이 없다(MIG-012).
//! - 도구 호출은 원본에 표시용 텍스트만 있어 모델 입력용 tool/result 짝을 복원할 수 없다. 표시 전용 note로 넣고
//!   모델 입력에는 user/assistant 텍스트만 들어간다(MIG-008, 014). 원본의 압축 요약도 없어 압축 지점만 표시한다.
//! - 실행 중이던 도구·턴은 결과 불명(interrupted)으로 옮기고 다시 실행하지 않는다(MIG-015). 도구 호출 행·턴은 만들지 않는다.
//! - 계정·API 키·설정은 가져오지 않는다(MIG-009, 010). 보고서에 재로그인 필요로 표시한다.

use crate::config::Config;
use crate::util::{fmt_time, new_id, parse_time, sha256_hex};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const SOURCE: &str = "paseo";

/// 원본 항목 하나를 Grove 메시지 (role, content)로. None이면 건너뛴다(알 수 없는 종류는 보고서에 센다).
fn map_item(it: &Value) -> Option<(&'static str, Value)> {
    let s = |k: &str| it[k].as_str().unwrap_or("").to_string();
    Some(match it["type"].as_str()? {
        "user_message" => ("user", json!({ "text": s("text") })),
        "assistant_message" => {
            let mut c = json!({ "text": s("text") });
            if let Some(p) = it["phase"].as_str() {
                c["imported_phase"] = json!(p);
            }
            ("assistant", c)
        }
        "tool_call" => {
            let status = match it["status"].as_str().unwrap_or("") {
                "running" => "interrupted",
                "canceled" => "cancelled",
                other => other,
            };
            let status = status.to_string();
            (
                "note",
                json!({
                    "type": "imported_tool", "name": s("name"), "status": status,
                    "text": it["detail"]["text"].as_str().unwrap_or(""), "error": it["error"].clone(),
                }),
            )
        }
        "notification" => ("note", json!({ "type": "imported_notice", "level": s("level"), "text": s("message") })),
        "error" => ("note", json!({ "type": "imported_notice", "level": "error", "text": s("message") })),
        "compaction" => ("note", json!({ "type": "imported_compaction", "trigger": s("trigger"), "pre_tokens": it["preTokens"].clone() })),
        _ => return None,
    })
}

/// 원본과 DB에 들어간 내용을 같은 방식으로 정규화해 hash한다(MIG-007, 013). 키 순서는 serde_json이 정렬한다.
fn content_hash(rows: &[(String, Value)]) -> String {
    let mut h = String::new();
    for (role, c) in rows {
        h.push_str(role);
        h.push('\u{1f}');
        h.push_str(&c.to_string());
        h.push('\u{1e}');
    }
    sha256_hex(h.as_bytes())
}

fn ms_to_time(v: &Value) -> Option<String> {
    let ms = v.as_i64()?;
    time::OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000).ok().map(fmt_time)
}

#[derive(Default, Debug)]
struct Plan {
    source_id: String,
    cwd: String,
    title: String,
    created_at: String,
    updated_at: String,
    rows: Vec<(String, Value, String)>,
    unknown_items: usize,
    interrupted: usize,
    truncated: bool,
    active_turn: bool,
    unsupported: Vec<String>,
}

fn plan_file(path: &Path) -> Result<Plan, String> {
    let raw = std::fs::read(path).map_err(|e| format!("읽기 실패: {e}"))?;
    let v: Value = serde_json::from_slice(&raw).map_err(|e| format!("JSON 형식 오류: {e}"))?;
    if v["version"] != 2 {
        return Err(format!("지원하지 않는 형식 version {}", v["version"]));
    }
    let source_id = v["id"].as_str().ok_or("id 없음")?.to_string();
    let created_at = ms_to_time(&v["createdAt"]).ok_or("createdAt 없음")?;
    let updated_at = ms_to_time(&v["updatedAt"]).unwrap_or_else(|| created_at.clone());
    let mut p = Plan {
        source_id,
        cwd: v["cwd"].as_str().unwrap_or("").to_string(),
        created_at: created_at.clone(),
        updated_at,
        truncated: v["historyTruncated"] == true,
        active_turn: !v["active"].is_null(),
        ..Default::default()
    };
    for e in v["items"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let it = &e["item"];
        match map_item(it) {
            Some((role, c)) => {
                if c["status"] == "interrupted" {
                    p.interrupted += 1;
                }
                let at = e["timestamp"].as_str().and_then(parse_time).map(fmt_time).unwrap_or_else(|| created_at.clone());
                p.rows.push((role.to_string(), c, at));
            }
            None => p.unknown_items += 1,
        }
    }
    // 이 버전이 옮기지 않는 원본 정보(보고서에 표시)
    for k in ["receipts", "usage", "backgroundTasks", "effortSettings", "quotaResume", "nativeRoute", "nativeSessionId", "promptHash"] {
        if v.get(k).is_some_and(|x| !x.is_null() && x != &json!({}) && x != &json!([])) {
            p.unsupported.push(k.to_string());
        }
    }
    p.title = p
        .rows
        .iter()
        .find(|r| r.0 == "user")
        .and_then(|r| r.1["text"].as_str())
        .map(|t| t.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().chars().take(60).collect::<String>())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "가져온 대화".into());
    Ok(p)
}

fn ensure_project(tx: &Connection, cwd: &str, now: &str) -> rusqlite::Result<(String, bool)> {
    // 원본 경로를 그대로 쓴다(없는 경로도 프로젝트로 두고 화면에서 재연결, PROJ). 있으면 정규화한다.
    let root = crate::util::canonical(cwd).map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| cwd.to_string());
    if let Some(id) = tx.query_row("SELECT id FROM projects WHERE root_path = ?1", params![root], |r| r.get(0)).optional()? {
        return Ok((id, false));
    }
    let id = new_id();
    let name = Path::new(&root).file_name().map(|n| n.to_string_lossy().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| root.clone());
    tx.execute("INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)", params![id, name, root, now])?;
    Ok((id, true))
}

fn import_one(conn: &mut Connection, p: &Plan, source_hash: &str, now: &str) -> Result<Value, String> {
    let e = |x: rusqlite::Error| x.to_string();
    let tx = conn.transaction().map_err(e)?;
    let (project_id, _) = ensure_project(&tx, &p.cwd, now).map_err(e)?;
    let sid = new_id();
    tx.execute(
        "INSERT INTO sessions (id, project_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![sid, project_id, p.title, p.created_at, p.updated_at],
    )
    .map_err(e)?;
    // 맨 앞: 가져온 대화라는 안내(표시 전용 note, 모델 입력 제외)
    let notice = json!({
        "type": "import_notice", "source": SOURCE, "source_id": p.source_id,
        "resume": "text_only", "truncated": p.truncated, "interrupted": p.interrupted + usize::from(p.active_turn),
        "unsupported": p.unsupported,
    });
    let mut all = vec![("note".to_string(), notice, p.created_at.clone())];
    all.extend(p.rows.iter().cloned());
    {
        let mut st = tx
            .prepare("INSERT INTO messages (id, session_id, seq, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
            .map_err(e)?;
        for (i, (role, c, at)) in all.iter().enumerate() {
            st.execute(params![new_id(), sid, i as i64 + 1, role, c.to_string(), at]).map_err(e)?;
        }
    }
    tx.execute("UPDATE sessions SET last_message_seq = ?2 WHERE id = ?1", params![sid, all.len() as i64]).map_err(e)?;
    // 되읽어 원본과 비교(MIG-013). 다르면 transaction을 버린다.
    let back: Vec<(String, Value)> = {
        let mut st = tx.prepare("SELECT role, content FROM messages WHERE session_id = ?1 AND seq > 1 ORDER BY seq").map_err(e)?;
        st.query_map(params![sid], |r| Ok((r.get::<_, String>(0)?, serde_json::from_str(&r.get::<_, String>(1)?).unwrap_or(Value::Null))))
            .map_err(e)?
            .collect::<Result<_, _>>()
            .map_err(e)?
    };
    let back_hash = content_hash(&back);
    if back.len() != p.rows.len() || back_hash != source_hash {
        return Err(format!("검증 실패: 원본 {}개/{} ↔ 저장 {}개/{}", p.rows.len(), &source_hash[..12], back.len(), &back_hash[..12]));
    }
    let report = json!({ "items": p.rows.len(), "interrupted": p.interrupted, "active_turn": p.active_turn, "truncated": p.truncated, "unknown_items": p.unknown_items, "unsupported": p.unsupported });
    tx.execute(
        "INSERT INTO import_map (source, source_id, session_id, source_hash, item_count, imported_at, report) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![SOURCE, p.source_id, sid, source_hash, p.rows.len() as i64, now, report.to_string()],
    )
    .map_err(e)?;
    crate::events::append(&tx, now, "session.imported", Some(&project_id), Some(&sid), &json!({ "source": SOURCE, "source_id": p.source_id }))
        .map_err(|x| x.message)?;
    tx.commit().map_err(e)?;
    Ok(json!({ "session_id": sid, "project_id": project_id }))
}

/// 가져오기 실행. dry_run이면 DB를 바꾸지 않고 보고서만 만든다(MIG-004).
pub fn run(conn: &mut Connection, sessions_dir: &Path, dry_run: bool, now: &str) -> Result<Value, String> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(sessions_dir)
        .map_err(|e| format!("{}: {e}", sessions_dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    let mut counts: BTreeMap<&str, i64> = BTreeMap::new();
    let mut by_role: BTreeMap<String, i64> = BTreeMap::new();
    let (mut missing_cwd, mut new_projects) = (std::collections::BTreeSet::new(), std::collections::BTreeSet::new());
    let mut problems = vec![];
    let mut changed = vec![];
    let mut unsupported: BTreeMap<String, i64> = BTreeMap::new();
    for f in &files {
        let p = match plan_file(f) {
            Ok(p) => p,
            Err(m) => {
                *counts.entry("failed").or_default() += 1;
                problems.push(json!({ "file": f.file_name().map(|n| n.to_string_lossy().to_string()), "error": m }));
                continue;
            }
        };
        let rows: Vec<(String, Value)> = p.rows.iter().map(|r| (r.0.clone(), r.1.clone())).collect();
        let h = content_hash(&rows);
        let prev: Option<String> = conn
            .query_row("SELECT source_hash FROM import_map WHERE source = ?1 AND source_id = ?2", params![SOURCE, p.source_id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        match prev {
            Some(ph) if ph == h => {
                *counts.entry("already_imported").or_default() += 1;
                continue;
            }
            Some(_) => {
                // 가져온 뒤 원본이 바뀌었다: 덮어쓰지 않고 보고한다(새 대화 내용이 원본과 섞이지 않게).
                *counts.entry("changed_since_import").or_default() += 1;
                changed.push(p.source_id.clone());
                continue;
            }
            None => {}
        }
        if !Path::new(&p.cwd).is_dir() {
            missing_cwd.insert(p.cwd.clone());
        }
        let exists: bool = conn
            .query_row("SELECT 1 FROM projects WHERE root_path = ?1", params![crate::util::canonical(&p.cwd).map(|x| x.to_string_lossy().to_string()).unwrap_or(p.cwd.clone())], |_| Ok(()))
            .optional()
            .map_err(|e| e.to_string())?
            .is_some();
        if !exists {
            new_projects.insert(p.cwd.clone());
        }
        for r in &p.rows {
            let k = if r.0 == "note" { format!("note:{}", r.1["type"].as_str().unwrap_or("")) } else { r.0.clone() };
            *by_role.entry(k).or_default() += 1;
        }
        for u in &p.unsupported {
            *unsupported.entry(u.clone()).or_default() += 1;
        }
        *counts.entry("interrupted_items").or_default() += (p.interrupted + usize::from(p.active_turn)) as i64;
        *counts.entry("truncated_history").or_default() += i64::from(p.truncated);
        *counts.entry("unknown_items").or_default() += p.unknown_items as i64;
        if dry_run {
            *counts.entry("importable").or_default() += 1;
            continue;
        }
        match import_one(conn, &p, &h, now) {
            Ok(_) => *counts.entry("imported").or_default() += 1,
            Err(m) => {
                *counts.entry("failed").or_default() += 1;
                problems.push(json!({ "source_id": p.source_id, "error": m }));
            }
        }
    }
    Ok(json!({
        "source": SOURCE, "dir": sessions_dir.display().to_string(), "dry_run": dry_run, "files": files.len(),
        "counts": counts, "messages_by_kind": by_role,
        "new_projects": new_projects.len(), "missing_project_paths": missing_cwd.len(),
        "changed_since_import": changed, "problems": problems,
        "not_imported": {
            "per_session": unsupported,
            "always": ["계정·API 키·OAuth(재로그인 필요)", "Paseo/Mixdog 설정", "턴 영수증·사용량", "도구 인자·결과 원문(표시 텍스트만 있음)", "압축 요약문(원본에 없음)"],
        },
        "resume": "가져온 대화는 열람할 수 있고, 후속 요청에는 user/assistant 텍스트만 모델 입력으로 쓴다(도구 결과·압축 요약 없음)",
    }))
}

/// `grove import paseo <원본 sessions 디렉터리> [--data-dir] [--dry-run]`
pub fn cli(source_dir: Option<PathBuf>, data_dir: Option<PathBuf>, dry_run: bool) -> Result<(), String> {
    let dir = source_dir.ok_or("원본 sessions 디렉터리가 필요합니다(예: ~/.local/share/paseodog/sessions)")?;
    let cfg = Config::from_env(data_dir, None)?;
    // 서버와 같은 잠금: 실행 중인 서버와 동시에 쓰지 않는다.
    let _lock = crate::server::acquire_lock(&cfg)?;
    let db = crate::store::Db::open(&cfg.db_path()).map_err(|e| e.to_string())?;
    let now = fmt_time(time::OffsetDateTime::now_utc());
    let report = db.call_sync(move |c| Ok(run(c, &dir, dry_run, &now))).map_err(|e| e.message)??;
    println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
    if report["counts"]["failed"].as_i64().unwrap_or(0) > 0 {
        return Err("일부 대화를 가져오지 못했습니다(problems 참고). 성공한 대화는 그대로이며 다시 실행하면 나머지만 시도합니다".into());
    }
    Ok(())
}
