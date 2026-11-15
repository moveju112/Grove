//! 영속 원문을 바꾸지 않는 보수적 중복 제거. 완료된 읽기 결과만 비교한다.
use crate::error::ApiResult;
use crate::{provider, tool_outputs, util};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};

const MIN_BYTES: usize = 4096;
const MAX_CANDIDATES: usize = 256;
const KEEP_USER_TURNS: usize = 2;

struct Candidate {
    id: String,
    provider_id: String,
    name: String,
    args_hash: String,
    output_hash: String,
    bytes: usize,
    user: usize,
}

impl Candidate {
    fn key(&self) -> (String, String, String, usize) {
        (self.name.clone(), self.args_hash.clone(), self.output_hash.clone(), self.bytes)
    }
}

#[derive(Default)]
pub(super) struct Duplicates {
    users: usize,
    pending: HashMap<String, (String, String)>,
    candidates: VecDeque<Candidate>,
}

fn hash(value: &Value) -> String {
    util::sha256_hex(value.to_string().as_bytes())
}

// 배치 안의 부분 실패나 잘린 결과도 성공으로 간주해 생략하지 않는다.
fn has_issue(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields.iter().any(|(key, value)| {
            (key == "error" && !value.is_null())
                || (matches!(key.as_str(), "is_error" | "truncated" | "invalid_utf8") && value.as_bool() == Some(true))
                || has_issue(value)
        }),
        Value::Array(items) => items.iter().any(has_issue),
        _ => false,
    }
}

impl Duplicates {
    pub(super) fn observe(&mut self, role: &str, content: &Value) {
        match role {
            "user" => {
                self.users += 1;
                self.pending.clear();
            }
            "assistant" => {
                self.pending.clear();
                for call in content["tool_calls"].as_array().into_iter().flatten() {
                    let (Some(id), Some(name), Some(args)) =
                        (call["id"].as_str(), call["name"].as_str(), call.get("arguments")) else { continue };
                    if matches!(name, "read" | "list" | "glob" | "find" | "grep") {
                        self.pending.insert(id.into(), (name.into(), hash(args)));
                    }
                }
            }
            "tool" if content["status"] == "succeeded" && content["is_error"] == false => {
                let (Some(id), Some(provider_id), Some(name)) =
                    (content["call_id"].as_str(), content["provider_call_id"].as_str(), content["name"].as_str())
                    else { return };
                let Some((expected_name, args_hash)) = self.pending.remove(provider_id) else { return };
                if name != expected_name { return; }
                let output = &content["output"];
                let (bytes, output_hash) = if output["kind"] == "tool_output_reference" && output["call_id"] == id {
                    let (Some(bytes), Some(digest)) = (output["total_bytes"].as_u64(), output["sha256"].as_str())
                        else { return };
                    let Ok(bytes) = usize::try_from(bytes) else { return };
                    (bytes, digest.to_string())
                } else {
                    let text = provider::tool_content_string(output);
                    (text.len(), util::sha256_hex(text.as_bytes()))
                };
                if bytes < MIN_BYTES { return; }
                if self.candidates.len() == MAX_CANDIDATES { self.candidates.pop_front(); }
                self.candidates.push_back(Candidate {
                    id: id.into(), provider_id: provider_id.into(), name: name.into(),
                    args_hash, output_hash, bytes, user: self.users,
                });
            }
            _ => {}
        }
    }

    pub(super) fn replacements(self, c: &Connection) -> ApiResult<HashMap<String, Value>> {
        let mut replacements = HashMap::new();
        if self.candidates.len() < 2 { return Ok(replacements); }
        let mut counts = HashMap::new();
        for candidate in &self.candidates { *counts.entry(candidate.key()).or_insert(0usize) += 1; }
        let mut receipt = c.prepare(
            "SELECT tc.name,tc.provider_call_id,tc.args,tc.result FROM tool_calls tc \
             JOIN turns t ON t.id=tc.turn_id WHERE tc.id=?1 AND tc.status='succeeded' AND t.status='completed'",
        )?;
        let mut newer = HashMap::new();
        for candidate in self.candidates.into_iter().rev() {
            let key = candidate.key();
            // 중복 후보가 없는 결과는 영속 본문을 다시 읽지 않는다.
            if counts[&key] < 2 { continue; }
            let stored: Option<(String, Option<String>, String, Option<String>)> = receipt.query_row(
                [&candidate.id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            ).optional()?;
            let Some((name, provider_id, args, Some(result))) = stored else { continue };
            let args: Value = serde_json::from_str(&args)?;
            let result: Value = serde_json::from_str(&result)?;
            let text = provider::tool_content_string(&result);
            if name != candidate.name || provider_id.as_deref() != Some(&candidate.provider_id)
                || hash(&args) != candidate.args_hash || text.len() != candidate.bytes
                || util::sha256_hex(text.as_bytes()) != candidate.output_hash || has_issue(&result) {
                continue;
            }
            if let Some((next_id, next_provider_id)) =
                newer.insert(key, (candidate.id.clone(), candidate.provider_id.clone())) {
                if next_id == candidate.id || candidate.user == 0
                    || candidate.user > self.users.saturating_sub(KEEP_USER_TURNS) {
                    continue;
                }
                // 다음 동일 결과 참조는 이후 중복이 더 생겨도 다시 바꾸지 않는다.
                // 자기 영속 ID로 원문을 조회하므로 참조 체인을 따라갈 필요도 없다.
                replacements.insert(candidate.id.clone(), json!({
                    "kind":"tool_output_duplicate", "call_id":candidate.id, "duplicate_of":next_id,
                    "duplicate_provider_call_id":next_provider_id,
                    "tool":candidate.name, "status":"succeeded",
                    "total_bytes":candidate.bytes, "sha256":candidate.output_hash,
                    "read":{"name":tool_outputs::NAME,"arguments":{
                        "call_id":candidate.id,"offset":0,"limit":tool_outputs::MAX_READ_BYTES
                    }},
                    "note":"같은 도구·인자·내용의 더 최근 성공 결과가 뒤에 있습니다. 과거 결과의 참조이며 현재 상태나 재실행의 증거가 아닙니다. 원문은 read로 조회할 수 있습니다."
                }));
            }
        }
        Ok(replacements)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_are_bounded_and_only_explicit_successful_large_reads_are_collected() {
        let mut duplicates = Duplicates::default();
        for index in 0..1000 {
            let id = index.to_string();
            duplicates.observe("user", &json!({"text":"next"}));
            duplicates.observe("assistant", &json!({"tool_calls":[
                {"id":id,"name":"read","arguments":{"path":"sample"}}
            ]}));
            duplicates.observe("tool", &json!({
                "call_id":id,"provider_call_id":id,"name":"read",
                "status":"succeeded","is_error":false,"output":"x".repeat(MIN_BYTES)
            }));
        }
        assert_eq!(duplicates.candidates.len(), MAX_CANDIDATES);
        assert_eq!(duplicates.candidates.front().unwrap().id, (1000 - MAX_CANDIDATES).to_string());
        assert_eq!(duplicates.users, 1000);
        for (name, status, is_error, bytes) in [
            ("shell", "succeeded", false, MIN_BYTES),
            ("read", "failed", true, MIN_BYTES),
            ("read", "unknown", true, MIN_BYTES),
            ("read", "succeeded", true, MIN_BYTES),
            ("read", "succeeded", false, MIN_BYTES - 1),
            ("load_tool", "succeeded", false, MIN_BYTES),
            ("tool_output_read", "succeeded", false, MIN_BYTES),
        ] {
            let mut excluded = Duplicates::default();
            excluded.observe("assistant", &json!({"tool_calls":[{"id":"p","name":name,"arguments":{}}]}));
            excluded.observe("tool", &json!({
                "call_id":"c","provider_call_id":"p","name":name,
                "status":status,"is_error":is_error,"output":"x".repeat(bytes)
            }));
            assert!(excluded.candidates.is_empty(), "{name}/{status}/{is_error}/{bytes}");
        }
        assert!(has_issue(&json!({"files":[{"content":"ok"},{"error":{"code":"not_found"}}]})));
        assert!(has_issue(&json!({"truncated":true})));
        assert!(has_issue(&json!({"invalid_utf8":true})));
        assert!(!has_issue(&json!({"content":"error: a literal string", "truncated":false})));
    }
}
