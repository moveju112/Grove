//! 사용량·비용 집계(USAGE-001, 003~005, 008/009).
//!
//! - token: input(전체 입력, cache 포함)·output·cache read·cache write·reasoning(output의 일부).
//!   provider가 알려 주지 않은 값은 0으로 꾸미지 않고 "보고 안 됨"으로 센다.
//! - 비용: 모델 프로필의 `pricing`(통화·버전·백만 token 단가)으로 계산한 **추정치**다. 가격이 없으면 금액 대신
//!   "가격 미설정 token"으로 보고한다. 계정 quota와는 다른 값이다.
//! - 기간: `from`·`to`(RFC3339)와 클라이언트 시간대 offset(분)으로 일·주(월요일 시작)·월 경계를 나눈다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use axum::Json;
use axum::extract::{Query, State};
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use time::{Duration, OffsetDateTime, UtcOffset};

#[derive(Default, Clone)]
struct Acc {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    reasoning: u64,
    /// cache write·reasoning을 보고하지 않은 응답 수(0과 구분)
    cache_write_unreported: u64,
    reasoning_unreported: u64,
    responses: u64,
    /// 통화별 추정 비용
    cost: BTreeMap<String, f64>,
    /// 가격이 없어 비용을 계산하지 못한 token(입력+출력)
    unpriced_tokens: u64,
}

impl Acc {
    fn add(&mut self, u: &Value, pricing: Option<&Value>) {
        let g = |k: &str| u[k].as_u64();
        let (inp, out, cr) = (g("input_tokens").unwrap_or(0), g("output_tokens").unwrap_or(0), g("cache_read_tokens").unwrap_or(0));
        let cw = g("cache_write_tokens");
        self.input += inp;
        self.output += out;
        self.cache_read += cr;
        match cw {
            Some(v) => self.cache_write += v,
            None => self.cache_write_unreported += 1,
        }
        match g("reasoning_tokens") {
            Some(v) => self.reasoning += v,
            None => self.reasoning_unreported += 1,
        }
        self.responses += 1;
        match pricing {
            Some(p) => {
                let price = |k: &str, fallback: f64| p[k].as_f64().unwrap_or(fallback);
                let pin = price("input_per_mtok", 0.0);
                let fresh = inp.saturating_sub(cr).saturating_sub(cw.unwrap_or(0));
                let amount = (fresh as f64 * pin
                    + cr as f64 * price("cache_read_per_mtok", pin)
                    + cw.unwrap_or(0) as f64 * price("cache_write_per_mtok", pin)
                    + out as f64 * price("output_per_mtok", 0.0))
                    / 1_000_000.0;
                *self.cost.entry(p["currency"].as_str().unwrap_or("USD").to_string()).or_default() += amount;
            }
            None => self.unpriced_tokens += inp + out,
        }
    }
    fn merge(&mut self, o: &Acc) {
        self.input += o.input;
        self.output += o.output;
        self.cache_read += o.cache_read;
        self.cache_write += o.cache_write;
        self.reasoning += o.reasoning;
        self.cache_write_unreported += o.cache_write_unreported;
        self.reasoning_unreported += o.reasoning_unreported;
        self.responses += o.responses;
        self.unpriced_tokens += o.unpriced_tokens;
        for (k, v) in &o.cost {
            *self.cost.entry(k.clone()).or_default() += v;
        }
    }
    fn to_json(&self) -> Value {
        json!({
            "input_tokens": self.input, "output_tokens": self.output, "cache_read_tokens": self.cache_read,
            "cache_write_tokens": self.cache_write, "reasoning_tokens": self.reasoning,
            "cache_write_unreported_responses": self.cache_write_unreported, "reasoning_unreported_responses": self.reasoning_unreported,
            "responses": self.responses,
            "estimated_cost": self.cost.iter().map(|(c, a)| json!({ "currency": c, "amount": (a * 1_000_000.0).round() / 1_000_000.0 })).collect::<Vec<_>>(),
            "unpriced_tokens": self.unpriced_tokens,
        })
    }
}

/// 한 사용량(턴 누적 등)의 추정 비용(가격표 통화 단위). 사용량 보고와 같은 계산을 쓴다(비용 예산, RUN-012).
pub fn estimate_cost(usage: &Value, pricing: &Value) -> f64 {
    let mut a = Acc::default();
    a.add(usage, Some(pricing));
    a.cost.values().sum()
}

#[derive(Deserialize)]
pub struct UsageQuery {
    pub from: String,
    pub to: String,
    /// provider | model | profile | agent | workflow | session | project | day | week | month
    pub group_by: String,
    /// 클라이언트 시간대(UTC 기준 분). 예: 한국 540
    pub tz_offset_minutes: Option<i32>,
    pub project_id: Option<String>,
}

fn parse(s: &str, what: &str) -> ApiResult<OffsetDateTime> {
    crate::util::parse_time(s).ok_or_else(|| ApiError::invalid(format!("{what}는 RFC3339 시각이어야 합니다")))
}

fn bucket(t: OffsetDateTime, by: &str, off: UtcOffset) -> String {
    let local = t.to_offset(off);
    let d = local.date();
    match by {
        "day" => d.to_string(),
        "week" => (d - Duration::days(d.weekday().number_days_from_monday() as i64)).to_string(),
        _ => format!("{:04}-{:02}", d.year(), d.month() as u8),
    }
}

/// 집계 본체(시험에서 직접 호출).
pub fn aggregate(c: &Connection, q: &UsageQuery) -> ApiResult<Value> {
    let (from, to) = (parse(&q.from, "from")?, parse(&q.to, "to")?);
    if to <= from || to - from > Duration::days(400) {
        return Err(ApiError::invalid("기간은 to > from 이고 400일 이하여야 합니다"));
    }
    let by = q.group_by.as_str();
    if !["provider", "model", "profile", "agent", "workflow", "session", "project", "day", "week", "month"].contains(&by) {
        return Err(ApiError::invalid("group_by가 올바르지 않습니다"));
    }
    let off_min = q.tz_offset_minutes.unwrap_or(0);
    if !(-14 * 60..=14 * 60).contains(&off_min) {
        return Err(ApiError::invalid("tz_offset_minutes는 -840~840입니다"));
    }
    let off = UtcOffset::from_whole_seconds(off_min * 60).map_err(|_| ApiError::invalid("시간대 offset이 올바르지 않습니다"))?;
    // 프로필별 protocol·가격(현재 가격표 기준 추정)
    let mut profiles: BTreeMap<String, (String, String, Option<Value>)> = BTreeMap::new();
    {
        let mut st = c.prepare("SELECT id, name, protocol, options FROM model_profiles")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))?;
        for row in rows {
            let (id, name, proto, opts) = row?;
            let o: Value = serde_json::from_str(&opts).unwrap_or(Value::Null);
            profiles.insert(id, (name, proto, o.get("pricing").cloned()));
        }
    }
    // 모델 응답(assistant)과 압축 요약(note)
    let sql = "SELECT m.created_at, m.content, COALESCE(t.profile_id, json_extract(m.content, '$.profile_id')), \
               CASE WHEN m.role = 'note' THEN '(압축 요약)' ELSE t.agent_id END, t.workflow_id, m.session_id, s.project_id, s.title, p.name \
               FROM messages m JOIN sessions s ON s.id = m.session_id JOIN projects p ON p.id = s.project_id LEFT JOIN turns t ON t.id = m.turn_id \
               WHERE m.created_at >= ?1 AND m.created_at < ?2 AND (?3 IS NULL OR s.project_id = ?3) \
               AND (m.role = 'assistant' OR (m.role = 'note' AND json_extract(m.content, '$.type') = 'compaction'))";
    let mut st = c.prepare(sql)?;
    let rows = st.query_map(params![crate::util::fmt_time(from), crate::util::fmt_time(to), q.project_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
        ))
    })?;
    let mut groups: BTreeMap<String, (String, Acc)> = BTreeMap::new();
    let mut total = Acc::default();
    let mut versions = std::collections::BTreeSet::new();
    for row in rows {
        let (at, content, prof, agent, wf, sid, pid, title, pname) = row?;
        let content: Value = serde_json::from_str(&content).unwrap_or(Value::Null);
        let usage = &content["usage"];
        let p = prof.as_ref().and_then(|id| profiles.get(id));
        let pricing = p.and_then(|x| x.2.as_ref());
        if let Some(v) = pricing.and_then(|p| p["version"].as_str()) {
            versions.insert(v.to_string());
        }
        let none = "(없음)".to_string();
        let (key, label) = match by {
            "provider" => {
                let k = p.map(|x| x.1.clone()).unwrap_or_else(|| "(삭제된 프로필)".into());
                (k.clone(), k)
            }
            "model" => {
                let k = content["model"].as_str().map(str::to_string).unwrap_or(none.clone());
                (k.clone(), k)
            }
            "profile" => (prof.clone().unwrap_or(none.clone()), p.map(|x| x.0.clone()).unwrap_or_else(|| "(삭제된 프로필)".into())),
            "agent" => {
                let k = agent.unwrap_or(none.clone());
                (k.clone(), k)
            }
            "workflow" => {
                let k = wf.unwrap_or(none.clone());
                (k.clone(), k)
            }
            "session" => (sid, title),
            "project" => (pid, pname),
            _ => {
                let t = crate::util::parse_time(&at).unwrap_or(from);
                let b = bucket(t, by, off);
                (b.clone(), b)
            }
        };
        let mut one = Acc::default();
        one.add(usage, pricing);
        total.merge(&one);
        groups.entry(key).or_insert_with(|| (label, Acc::default())).1.merge(&one);
    }
    let mut out: Vec<Value> = groups
        .into_iter()
        .map(|(k, (label, a))| {
            let mut v = a.to_json();
            v["key"] = json!(k);
            v["label"] = json!(label);
            v
        })
        .collect();
    // 기간 묶음은 시간순, 나머지는 사용량 큰 순
    if !matches!(by, "day" | "week" | "month") {
        out.sort_by_key(|v| std::cmp::Reverse(v["input_tokens"].as_u64().unwrap_or(0) + v["output_tokens"].as_u64().unwrap_or(0)));
    }
    Ok(json!({
        "from": q.from, "to": q.to, "group_by": by, "tz_offset_minutes": off_min,
        "rows": out, "total": total.to_json(),
        "pricing_versions": versions, "cost_is_estimate": true,
    }))
}

pub async fn get_usage(State(app): State<App>, _p: Principal, Query(q): Query<UsageQuery>) -> ApiResult<Json<Value>> {
    Ok(Json(app.db.call(move |c| aggregate(c, &q)).await?))
}

/// 실행 용량(FAIR-011). 서버 전체는 실행·대기 합계와 한도만, 요청별 상세(대화·대기 이유·순서)는
/// 요청한 기기 소유자의 것만 보여 준다. 다른 소유자의 대화·프로젝트·계정 정보는 내보내지 않는다.
pub async fn capacity(State(app): State<App>, p: Principal) -> ApiResult<Json<Value>> {
    let owner = format!("token:{}", p.root_id);
    let (limits, mine) = app
        .db
        .call(move |c| {
            let lim = |k: &str| -> ApiResult<Value> { crate::settings::effective(c, k, None, None) };
            let limits = json!({
                "max_active": lim("runs.max_active")?,
                "max_queued_per_owner": lim("runs.max_queued_per_owner")?,
                "max_queued_total": lim("runs.max_queued_total")?,
            });
            let mut st = c.prepare(
                "SELECT t.id, t.status, t.session_id, s.title, s.project_id, t.created_at FROM turns t JOIN sessions s ON s.id = t.session_id \
                 WHERE t.owner_key = ?1 AND t.status IN ('queued','running','awaiting_approval') ORDER BY t.created_at, t.id",
            )?;
            let rows = st
                .query_map(params![owner], |r| {
                    Ok(json!({ "turn_id": r.get::<_, String>(0)?, "status": r.get::<_, String>(1)?, "session_id": r.get::<_, String>(2)?,
                               "session_title": r.get::<_, String>(3)?, "project_id": r.get::<_, String>(4)?, "created_at": r.get::<_, String>(5)? }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok((limits, rows))
        })
        .await?;
    let (running, waiting) = app.fair.counts();
    let requests: Vec<Value> = mine
        .into_iter()
        .map(|mut r| {
            if let Some(q) = r["turn_id"].as_str().and_then(|id| app.fair.waiting(id)) {
                r["queue"] = json!(q);
            }
            r
        })
        .collect();
    let count = |f: &dyn Fn(&Value) -> bool| requests.iter().filter(|r| f(r)).count();
    let mine = json!({
        "waiting": count(&|r| r.get("queue").is_some()),
        "running": count(&|r| r["status"] == "running" && r.get("queue").is_none()),
        "awaiting_user": count(&|r| r["status"] == "awaiting_approval"),
    });
    Ok(Json(json!({ "limits": limits, "server": { "running": running, "waiting": waiting }, "mine": mine, "requests": requests })))
}

// ---------------- 턴 시간 분해(USAGE-008/009) ----------------

fn merge_len(mut iv: Vec<(OffsetDateTime, OffsetDateTime)>) -> Duration {
    iv.retain(|(a, b)| b > a);
    iv.sort_by_key(|x| x.0);
    let mut total = Duration::ZERO;
    let mut cur: Option<(OffsetDateTime, OffsetDateTime)> = None;
    for (a, b) in iv {
        match cur {
            Some((s, e)) if a <= e => cur = Some((s, e.max(b))),
            Some((s, e)) => {
                total += e - s;
                cur = Some((a, b));
            }
            None => cur = Some((a, b)),
        }
    }
    if let Some((s, e)) = cur {
        total += e - s;
    }
    total
}

/// 턴 경과 시간을 승인 대기·도구 실행·공급자 호출·기타로 나눈다. 기기 시계와 무관하다.
/// 겹치는 도구 실행은 합집합으로 센다. 끝나지 않은 턴은 `now`까지 센다.
pub fn turn_timing(c: &Connection, turn_id: &str, now: OffsetDateTime) -> ApiResult<Value> {
    let (created, finished, status, provider_ms, provider_started_at): (String, Option<String>, String, Option<i64>, Option<String>) =
        c.query_row("SELECT created_at, finished_at, status, provider_ms, provider_started_at FROM turns WHERE id = ?1", params![turn_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
    let start = crate::util::parse_time(&created).unwrap_or(now);
    let end = finished.as_deref().and_then(crate::util::parse_time).unwrap_or(now).max(start);
    let mut approvals = vec![];
    let mut tools = vec![];
    let mut st = c.prepare("SELECT needs_approval, created_at, decided_at, started_at, finished_at FROM tool_calls WHERE turn_id = ?1")?;
    let rows = st.query_map(params![turn_id], |r| {
        Ok((r.get::<_, bool>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?))
    })?;
    let clip = |t: OffsetDateTime| t.clamp(start, end);
    for row in rows {
        let (needs, cr, dec, sta, fin) = row?;
        let t = |s: &Option<String>| s.as_deref().and_then(crate::util::parse_time);
        if needs {
            let a = crate::util::parse_time(&cr).unwrap_or(start);
            approvals.push((clip(a), clip(t(&dec).or(t(&fin)).unwrap_or(end))));
        }
        if let Some(s) = t(&sta) {
            tools.push((clip(s), clip(t(&fin).unwrap_or(end))));
        }
    }
    let ms = |d: Duration| d.whole_milliseconds().max(0) as i64;
    let total = ms(end - start);
    let approval = ms(merge_len(approvals)).min(total);
    let tool = ms(merge_len(tools)).min(total - approval);
    // 나머지는 정수 ms에서 계산해 세 값의 합이 항상 total과 같게 한다.
    let other = total - approval - tool;
    // 종료 시 남은 시작 marker는 프로세스 중단으로 이 구간을 확정하지 못했다는 뜻이다.
    let provider = provider_ms.filter(|_| finished.is_none() || provider_started_at.is_none()).map(|elapsed| {
        let inflight = provider_started_at.as_deref().and_then(crate::util::parse_time)
            .map(|started| ms(end - started)).unwrap_or(0);
        elapsed.saturating_add(inflight).min(other)
    });
    Ok(json!({
        "total_ms": total, "approval_wait_ms": approval, "tool_ms": tool, "model_and_other_ms": other,
        "provider_ms": provider, "other_ms": provider.map(|p| other - p),
        "running": finished.is_none(), "status": status,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn cost_uses_pricing_and_reports_unpriced_and_unreported() {
        let mut a = Acc::default();
        let pricing = json!({ "currency": "USD", "version": "2026-01", "input_per_mtok": 3.0, "output_per_mtok": 15.0, "cache_read_per_mtok": 0.3 });
        a.add(&json!({ "input_tokens": 1_000_000, "output_tokens": 100_000, "cache_read_tokens": 500_000, "cache_write_tokens": 0 }), Some(&pricing));
        // 500k 신규 × 3 + 500k cache × 0.3 + 100k × 15 = 1.5 + 0.15 + 1.5
        let j = a.to_json();
        assert_eq!(j["estimated_cost"][0]["amount"], 3.15);
        assert_eq!(j["reasoning_unreported_responses"], 1);
        assert_eq!(j["cache_write_unreported_responses"], 0);
        a.add(&json!({ "input_tokens": 10, "output_tokens": 5, "cache_read_tokens": 0 }), None);
        assert_eq!(a.to_json()["unpriced_tokens"], 15);
    }

    #[test]
    fn week_and_month_buckets_use_client_offset() {
        let seoul = UtcOffset::from_hms(9, 0, 0).unwrap();
        // UTC 일요일 16:00 = 서울 월요일 01:00 → 다음 주
        let t = datetime!(2026-11-08 16:00 UTC);
        assert_eq!(bucket(t, "week", UtcOffset::UTC), "2026-11-02");
        assert_eq!(bucket(t, "week", seoul), "2026-11-09");
        assert_eq!(bucket(datetime!(2026-10-31 20:00 UTC), "month", seoul), "2026-11");
        assert_eq!(bucket(datetime!(2026-10-31 20:00 UTC), "day", UtcOffset::UTC), "2026-10-31");
    }

    #[test]
    fn overlapping_intervals_are_unioned() {
        let a = datetime!(2026-01-01 0:00 UTC);
        let d = merge_len(vec![(a, a + Duration::seconds(10)), (a + Duration::seconds(5), a + Duration::seconds(12)), (a + Duration::seconds(20), a + Duration::seconds(21))]);
        assert_eq!(d, Duration::seconds(13));
    }
}
