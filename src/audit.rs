//! 감사 기록(SEC-023). 승인·설정·기기 연결·비밀정보 변경을 누가(토큰) 언제 했는지 남긴다.
//!
//! - 변경과 같은 transaction에서 기록한다(변경만 되고 기록이 빠지는 일 없음).
//! - 비밀 값·토큰 원문·hash는 넣지 않는다. `detail`은 호출하는 쪽이 고른 식별 정보뿐이며,
//!   저장 전에 `scrub`이 비밀처럼 보이는 key를 한 번 더 지운다.
//! - 이벤트와 달리 정리(prune)하지 않는다. 조회는 소유자만.

use crate::App;
use crate::auth::{Owner, Principal};
use crate::error::ApiResult;
use axum::Json;
use axum::extract::{Query, State};
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};

fn scrub(v: &mut Value) {
    match v {
        Value::Object(m) => {
            for (k, x) in m.iter_mut() {
                let k = k.to_ascii_lowercase();
                if ["token", "secret", "password", "value", "hash", "key"].iter().any(|s| k == *s || k.ends_with(&format!("_{s}"))) {
                    *x = json!("[redacted]");
                } else {
                    scrub(x);
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(scrub),
        _ => {}
    }
}

pub fn record(c: &Connection, now: &str, p: &Principal, action: &str, target: &str, detail: Value) -> ApiResult<()> {
    let mut d = detail;
    scrub(&mut d);
    c.execute(
        "INSERT INTO audit_log (at, actor_token_id, actor_kind, action, target, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![now, p.token_id, p.kind, action, target, d.to_string()],
    )?;
    Ok(())
}

#[derive(Deserialize)]
pub struct AuditQuery {
    pub before: Option<i64>,
    pub limit: Option<i64>,
}

pub async fn list(State(app): State<App>, Owner(_p): Owner, Query(q): Query<AuditQuery>) -> ApiResult<Json<Value>> {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let v = app
        .db
        .call(move |c| {
            let mut st = c.prepare(
                "SELECT a.seq, a.at, a.actor_token_id, a.actor_kind, t.name, a.action, a.target, a.detail FROM audit_log a \
                 LEFT JOIN tokens t ON t.id = a.actor_token_id WHERE (?1 IS NULL OR a.seq < ?1) ORDER BY a.seq DESC LIMIT ?2",
            )?;
            let mut rows = st
                .query_map(params![q.before, limit + 1], |r| {
                    Ok(json!({
                        "seq": r.get::<_, i64>(0)?, "at": r.get::<_, String>(1)?,
                        "actor": { "token_id": r.get::<_, String>(2)?, "kind": r.get::<_, String>(3)?, "name": r.get::<_, Option<String>>(4)? },
                        "action": r.get::<_, String>(5)?, "target": r.get::<_, String>(6)?,
                        "detail": serde_json::from_str::<Value>(&r.get::<_, String>(7)?).unwrap_or(Value::Null),
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let next = if rows.len() as i64 > limit {
                rows.truncate(limit as usize);
                rows.last().and_then(|x| x["seq"].as_i64())
            } else {
                None
            };
            Ok(json!({ "items": rows, "next_cursor": next }))
        })
        .await?;
    Ok(Json(v))
}

#[cfg(test)]
mod tests {
    #[test]
    fn scrub_removes_secret_like_keys() {
        let mut v = serde_json::json!({ "id": "x", "label": "l", "token": "t", "api_key": "k", "nested": [{ "secret_hash": "h", "name": "n" }] });
        super::scrub(&mut v);
        assert_eq!(v["token"], "[redacted]");
        assert_eq!(v["api_key"], "[redacted]");
        assert_eq!(v["nested"][0]["secret_hash"], "[redacted]");
        assert_eq!(v["nested"][0]["name"], "n");
        assert_eq!(v["label"], "l");
    }
}
