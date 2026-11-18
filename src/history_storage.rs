//! 대화 원문의 무손실 저장 압축. 모델 context 요약과는 독립이다.
//! 메시지별 gzip·길이·SHA-256을 검증하며, 읽기는 message_history view를 거친다.
//! 화면에서 연 페이지만 원문으로 복원하고 마지막 접근 후 유휴 기간이 지나면 다시 압축한다.

use crate::error::ApiResult;
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use rusqlite::{Connection, functions::FunctionFlags, params, types::ValueRef};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use time::{Duration, OffsetDateTime};

const MAGIC: &[u8] = b"GROVE-HISTORY-1\0";
const HEADER: usize = MAGIC.len() + 8 + 32;
const MAX_PAYLOAD: usize = 32 * 1024 * 1024;
const BATCH_BYTES: usize = 8 * 1024 * 1024;
const BATCH_ROWS: i64 = 100;

fn invalid() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, "저장된 대화 기록의 압축 무결성을 확인할 수 없습니다")
}

fn unpack(stored: &[u8]) -> std::io::Result<String> {
    if stored.len() < HEADER || !stored.starts_with(MAGIC) {
        return Err(invalid());
    }
    let length = u64::from_le_bytes(stored[MAGIC.len()..MAGIC.len() + 8].try_into().map_err(|_| invalid())?);
    if length > MAX_PAYLOAD as u64 {
        return Err(invalid());
    }
    let mut plain = Vec::new();
    GzDecoder::new(&stored[HEADER..]).take(length + 1).read_to_end(&mut plain)?;
    if plain.len() as u64 != length || Sha256::digest(&plain).as_slice() != &stored[MAGIC.len() + 8..HEADER] {
        return Err(invalid());
    }
    String::from_utf8(plain).map_err(|_| invalid())
}

fn pack(plain: &str) -> std::io::Result<Option<Vec<u8>>> {
    if plain.len() < 256 || plain.len() > MAX_PAYLOAD {
        return Ok(None);
    }
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(plain.as_bytes())?;
    let mut stored = MAGIC.to_vec();
    stored.extend_from_slice(&(plain.len() as u64).to_le_bytes());
    stored.extend_from_slice(&Sha256::digest(plain.as_bytes()));
    stored.extend(encoder.finish()?);
    if stored.len() + 64 >= plain.len() {
        return Ok(None);
    }
    // 같은 transaction에서 원문을 교체하기 전에 실제 복원 결과를 검증한다.
    if unpack(&stored)? != plain {
        return Err(invalid());
    }
    Ok(Some(stored))
}

pub(crate) fn register(c: &Connection) -> rusqlite::Result<()> {
    c.create_scalar_function(
        "grove_history_text", 1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| match ctx.get_raw(0) {
            ValueRef::Null => Ok(None),
            ValueRef::Text(value) => String::from_utf8(value.to_vec()).map(Some)
                .map_err(|_| rusqlite::Error::UserFunctionError(invalid().into())),
            ValueRef::Blob(value) => unpack(value).map(Some)
                .map_err(|_| rusqlite::Error::UserFunctionError(invalid().into())),
            _ => Err(rusqlite::Error::UserFunctionError(invalid().into())),
        },
    )
}

/// 세 글자 미만은 기존 부분 일치 검색을 유지한다. 색인은 후보만 고르고 원문으로 최종 확인한다.
pub(crate) fn search_match(needle: &str) -> Option<String> {
    let chars: Vec<char> = needle.chars().collect();
    if chars.len() < 3 || needle.contains('\0') {
        return None;
    }
    // 위치 정보를 저장하지 않는 작은 trigram 색인. 후보 축소에는 일부 trigram만으로 충분하다.
    let terms: std::collections::BTreeSet<String> = chars.windows(3).take(32)
        .map(|window| format!("\"{}\"", window.iter().collect::<String>().replace('"', "\"\""))).collect();
    Some(terms.into_iter().collect::<Vec<_>>().join(" AND "))
}

/// 호출마다 제한된 메시지만 처리한다. 진행 중 작업과 최근에 열어 본 대화는 제외한다.
pub(crate) fn compress_idle(c: &mut Connection, now: OffsetDateTime) -> ApiResult<usize> {
    let days = crate::settings::effective(c, "storage.history_compress_after_days", None, None)?
        .as_i64().unwrap_or(7);
    let cutoff = crate::util::fmt_time(now - Duration::days(days));
    let stamp = crate::util::fmt_time(now);
    let tx = c.transaction()?;
    let candidates: Vec<(String, i64)> = {
        let mut st = tx.prepare(
            "SELECT m.id, length(CAST(m.content AS BLOB)) + COALESCE(length(CAST(m.model_input AS BLOB)),0) \
             FROM messages m JOIN sessions s ON s.id=m.session_id \
             WHERE m.history_checked_at IS NULL AND julianday(s.updated_at)<=julianday(?1) \
               AND (s.history_accessed_at IS NULL OR julianday(s.history_accessed_at)<=julianday(?1)) \
               AND NOT EXISTS(SELECT 1 FROM turns t WHERE t.session_id=s.id AND t.status IN ('queued','running','awaiting_approval')) \
               AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.session_id=s.id AND t.status='running') \
               AND NOT EXISTS(SELECT 1 FROM tool_calls t WHERE t.session_id=s.id AND t.status IN ('approved','running','pending_approval','awaiting_input')) \
             ORDER BY m.rowid LIMIT ?2",
        )?;
        st.query_map(params![cutoff, BATCH_ROWS], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?
    };
    let mut bytes = 0usize;
    let mut compressed = 0;
    for (id, size) in candidates {
        if bytes > 0 && bytes.saturating_add(size as usize) > BATCH_BYTES {
            break;
        }
        // 거대한 단일 메시지도 한 번에 둘 이상의 payload를 메모리에 적재하지 않는다.
        let mut changed = false;
        for column in ["content", "model_input"] {
            let plain: Option<String> = tx.query_row(
                &format!("SELECT CASE WHEN typeof({column})='text' AND length(CAST({column} AS BLOB))<=?2 THEN {column} END FROM messages WHERE id=?1"),
                params![id, MAX_PAYLOAD as i64], |r| r.get(0),
            )?;
            if let Some(plain) = plain {
                let packed = pack(&plain).map_err(|_| crate::error::ApiError::internal("history compression integrity"))?;
                if let Some(packed) = packed {
                    tx.execute(&format!("UPDATE messages SET {column}=?2 WHERE id=?1"), params![id, packed])?;
                    changed = true;
                }
            }
        }
        tx.execute("UPDATE messages SET history_checked_at=?2 WHERE id=?1", params![id, stamp])?;
        bytes = bytes.saturating_add(size as usize);
        compressed += usize::from(changed);
    }
    tx.commit()?;
    Ok(compressed)
}

/// 읽은 페이지만 복원한다. 실패하면 원래 압축본과 접근 시각을 모두 보존한다.
pub(crate) fn restore_page(c: &mut Connection, now: &str, session: &str, messages: &[crate::sessions::Message]) -> ApiResult<()> {
    let tx = c.transaction()?;
    for message in messages {
        tx.execute(
            "UPDATE messages SET content=grove_history_text(content), model_input=grove_history_text(model_input), history_checked_at=NULL \
             WHERE id=?1 AND session_id=?2 AND (typeof(content)='blob' OR typeof(model_input)='blob')",
            params![message.id, session],
        )?;
    }
    tx.execute("UPDATE sessions SET history_accessed_at=?2 WHERE id=?1", params![session, now])?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lossless_unicode_and_integrity_checks() {
        let plain = serde_json::json!({ "text": "정확한 원문\n\"코드\"\u{0000}".repeat(1000), "usage": { "input": 14 } }).to_string();
        let packed = pack(&plain).unwrap().unwrap();
        assert!(packed.len() < plain.len());
        assert_eq!(unpack(&packed).unwrap(), plain);
        for index in [0, MAGIC.len(), HEADER - 1, HEADER, packed.len() - 1] {
            let mut broken = packed.clone();
            broken[index] ^= 1;
            assert!(unpack(&broken).is_err(), "손상 위치 {index}");
        }
        assert!(unpack(&packed[..HEADER - 1]).is_err());
        assert!(pack("짧은 원문").unwrap().is_none());
    }

    #[test]
    fn decompression_rejects_oversized_headers_and_invalid_utf8() {
        let mut packed = pack(&"a".repeat(1024)).unwrap().unwrap();
        packed[MAGIC.len()..MAGIC.len() + 8].copy_from_slice(&((MAX_PAYLOAD as u64) + 1).to_le_bytes());
        assert!(unpack(&packed).is_err());
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(&[255]).unwrap();
        let mut packed = MAGIC.to_vec();
        packed.extend_from_slice(&1u64.to_le_bytes());
        packed.extend_from_slice(&Sha256::digest([255]));
        packed.extend(encoder.finish().unwrap());
        assert!(unpack(&packed).is_err());
    }
}
