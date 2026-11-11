//! 공개 헤더 값과 vault 참조를 구분한다. 이전 자격 헤더·이벤트·receipt는 원문을 잃지 않고 암호화 참조로 옮긴다.
use crate::error::{ApiError, ApiResult};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;

/// p는 model_profiles의 alias. JSON 문자열에 json_extract를 적용하지 않는다.
pub const SECRET_USAGE: &str = "(p.secret_id=?1 OR EXISTS(
    SELECT 1 FROM json_each(CASE WHEN json_valid(p.options) THEN p.options ELSE '{}' END,'$.headers') h
    WHERE CASE WHEN h.type='object' THEN json_extract(h.value,'$.secret_id') END=?1
))";

pub fn reference(value: &Value) -> Option<&str> {
    let object = value.as_object()?;
    if object.len() != 1 { return None; }
    object.get("secret_id")?.as_str().filter(|id| !id.is_empty())
}

pub fn validate(value: &Value) -> ApiResult<()> {
    let headers = value.as_object().ok_or_else(|| ApiError::invalid("headers는 객체여야 합니다"))?;
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if matches!(lower.as_str(), "authorization" | "x-api-key" | "x-goog-api-key" | "host")
            || reqwest::header::HeaderName::from_bytes(name.as_bytes()).is_err() {
            return Err(ApiError::invalid(format!("허용되지 않은 header: {name}")));
        }
        if let Some(text) = value.as_str() {
            if crate::provider::is_credential_header(name) && !text.trim().is_empty() {
                return Err(ApiError::unsupported(format!("{name} 자격 헤더는 /secrets에 저장한 뒤 {{\"secret_id\":\"...\"}} 참조로 지정하세요")));
            }
            if reqwest::header::HeaderValue::from_str(text).is_err() {
                return Err(ApiError::invalid(format!("{name} header 값이 올바르지 않습니다")));
            }
        } else if reference(value).is_none() {
            return Err(ApiError::invalid(format!("{name} header는 공개 문자열 또는 secret_id 참조여야 합니다")));
        }
    }
    Ok(())
}

pub fn validate_references(c: &Connection, options: &Value) -> ApiResult<()> {
    for (_, value) in options["headers"].as_object().into_iter().flat_map(|headers| headers.iter()) {
        if let Some(id) = reference(value) {
            let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM secrets WHERE id=?1)", [id], |row| row.get(0))?;
            if !exists { return Err(ApiError::not_found("header가 참조한 비밀이 없습니다")); }
        }
    }
    Ok(())
}

pub fn load(c: &Connection, options: &Value) -> ApiResult<(Vec<(String, String)>, Vec<String>)> {
    let mut headers = Vec::new();
    let mut sensitive = Vec::new();
    for (name, value) in options["headers"].as_object().into_iter().flat_map(|headers| headers.iter()) {
        let text = if let Some(id) = reference(value) {
            sensitive.push(name.to_ascii_lowercase());
            crate::models::decrypt_secret(c, id)?
        } else if let Some(text) = value.as_str() {
            text.to_string()
        } else { return Err(ApiError::invalid("저장된 header 형식이 올바르지 않습니다")); };
        if reqwest::header::HeaderValue::from_str(&text).is_err() {
            return Err(ApiError::invalid(format!("{name} header 값이 올바르지 않습니다")));
        }
        headers.push((name.clone(), text));
    }
    Ok((headers, sensitive))
}

/// 한번 완료한 backfill은 반복 스캔하지 않는다. 표와 cursor는 코드 상수이며 행 단위로 읽는다.
pub fn migrate(c: &mut Connection) -> ApiResult<usize> {
    let tx = c.transaction()?;
    let done: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM credential_backfills WHERE name='model-headers-v1')", [], |row| row.get(0))?;
    if done { return Ok(0); }
    let now = crate::util::fmt_time(time::OffsetDateTime::now_utc());
    // 대형 이력에서도 평문/행 전체를 쌓지 않는다. 최근 256개 값의 hash→참조만 잠시 보관한다.
    let mut cache: VecDeque<([u8; 32], String)> = VecDeque::new();
    let mut changed = 0;
    for (table, id_column, column, path, extra) in [
        ("model_profiles", "rowid", "options", "$.headers", ""),
        ("events", "seq", "payload", "$.options.headers", "AND kind='profile.changed'"),
        ("idempotency", "rowid", "response", "$.options.headers",
            "AND json_extract(CASE WHEN json_valid(response) THEN response ELSE '{}' END,'$.protocol') IN ('openai','anthropic','gemini','claude_code','codex_cli')"),
    ] {
        let sql = format!(
            "SELECT {id_column},{column} FROM {table} WHERE {id_column}>?1 {extra} \
             AND json_type(CASE WHEN json_valid({column}) THEN {column} ELSE '{{}}' END,'{path}')='object' \
             ORDER BY {id_column} LIMIT 1"
        );
        let mut statement = tx.prepare(&sql)?;
        let mut after = 0i64;
        loop {
            let row: Option<(i64, String)> = statement.query_row([after], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
            let Some((id, text)) = row else { break };
            after = id;
            let mut body: Value = serde_json::from_str(&text).map_err(|_| ApiError::internal("이전 프로필 JSON을 읽을 수 없습니다"))?;
            let options = if table == "model_profiles" { &mut body } else { &mut body["options"] };
            let headers = options["headers"].as_object_mut().expect("SQL filters header objects");
            let mut protected = false;
            for (name, value) in headers {
                let Some(plain) = value.as_str() else { continue };
                if !crate::provider::is_credential_header(name) || plain.trim().is_empty() { continue; }
                let hash: [u8; 32] = Sha256::digest(plain.as_bytes()).into();
                let secret = if let Some(index) = cache.iter().position(|(old, _)| old == &hash) {
                    let item = cache.remove(index).expect("cache index");
                    let id = item.1.clone();
                    cache.push_back(item);
                    id
                } else {
                    let secret = crate::util::new_id();
                    tx.execute("INSERT INTO secrets(id,label,value,created_at,updated_at) VALUES(?1,?2,grove_encrypt(?3),?4,?4)",
                        params![secret, "이전 모델 자격 헤더", plain, now])?;
                    if cache.len() == 256 { cache.pop_front(); }
                    cache.push_back((hash, secret.clone()));
                    secret
                };
                *value = json!({"secret_id":secret});
                protected = true;
            }
            if protected {
                let revision = if table == "model_profiles" { ",revision=revision+1" } else { "" };
                tx.execute(&format!("UPDATE {table} SET {column}=?1{revision} WHERE {id_column}=?2"), params![body.to_string(), id])?;
                changed += 1;
            }
        }
    }
    tx.execute("INSERT INTO credential_backfills(name,completed_at) VALUES('model-headers-v1',?1)", [now])?;
    tx.commit()?;
    Ok(changed)
}
