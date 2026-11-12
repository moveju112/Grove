//! 예약 실행(AUTO-001~007, 011).
//!
//! 정책(RULEBOOK §자동화):
//! - 시각은 UTC로 저장하고, 매일 실행은 예약에 저장된 고정 UTC offset으로 계산한다. DST가 있는 지역은
//!   offset을 사용자가 바꿔야 한다(서버가 지역 규칙을 추측하지 않음).
//! - 놓친 실행: 예정 시각에서 `missed_grace_minutes`를 넘기면 실행하지 않고 `missed`로 한 번 기록한 뒤
//!   다음 예정 시각으로 넘어간다(따라잡기 연쇄 실행 없음). 서버 시계가 앞으로 뛰어도 같다.
//! - 서버 시계가 뒤로 가서 다음 예정 시각이 한 주기 이상 멀어지면 현재 시각 기준으로 다시 계산한다.
//! - 같은 예약의 이전 실행이 아직 끝나지 않았으면 새 실행은 `skipped_overlap`으로 기록하고 건너뛴다.
//! - 같은 예정 시각은 `UNIQUE(schedule_id, planned_at)`로 한 번만 실행한다.
//! - 재시작: 이전 프로세스의 실행 턴은 `interrupted`가 되고(자동 재실행 없음) 실행 로그도 그렇게 닫힌다.
//! - 승인이 필요한 도구 호출은 `on_approval`에 따라 대기(wait)하거나 실패(fail)한다. 자동 승인하지 않는다.
//! - 실행 종료는 영속 알림으로만 알린다. 알림이 모델을 다시 부르지 않는다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::{events, idem, notifications};
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime, Time, UtcOffset};
use tokio::task::JoinHandle;

#[derive(Debug, Clone, Serialize)]
pub struct Schedule {
    pub id: String,
    pub project_id: String,
    pub owner_id: String,
    pub name: String,
    pub prompt: String,
    pub profile_id: String,
    pub agent_id: Option<String>,
    pub tools_enabled: bool,
    pub allowed_tools: Option<Vec<String>>,
    pub max_total_tokens: Option<i64>,
    pub kind: String,
    pub at: Option<String>,
    pub interval_minutes: Option<i64>,
    pub daily_time: Option<String>,
    pub tz_offset_minutes: i64,
    pub session_mode: String,
    pub session_id: Option<String>,
    pub on_approval: String,
    pub missed_grace_minutes: i64,
    pub status: String,
    pub next_run_at: Option<String>,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    /// 반복 예약의 자동 실행 최대 횟수(AUTO-009). 수동 실행·놓침·건너뜀은 세지 않는다.
    pub max_runs: Option<i64>,
    /// 이 시각 이후로는 자동 실행하지 않는다.
    pub end_at: Option<String>,
    /// 연속 실패가 이 횟수에 이르면 자동으로 일시 정지한다(없으면 끔).
    pub pause_after_failures: Option<i64>,
    pub consecutive_failures: i64,
    pub last_failed_at: Option<String>,
    /// 일시 정지 이유: 사용자(`user`) 또는 연속 실패(`failures`).
    pub paused_reason: Option<String>,
    /// 지금까지 시작한 자동 실행 수.
    pub runs_used: i64,
    /// 연속 실패 뒤 자동 실행을 미루는 시각(지났으면 의미 없음).
    pub backoff_until: Option<String>,
}

const COLS: &str = "id, project_id, owner_id, name, prompt, profile_id, agent_id, tools_enabled, allowed_tools, max_total_tokens, kind, at, interval_minutes, \
                    daily_time, tz_offset_minutes, session_mode, session_id, on_approval, missed_grace_minutes, status, next_run_at, revision, created_at, updated_at, \
                    max_runs, end_at, pause_after_failures, consecutive_failures, last_failed_at, paused_reason, \
                    (SELECT COUNT(*) FROM schedule_runs r WHERE r.schedule_id = schedules.id AND r.manual = 0 AND r.status NOT IN ('missed','skipped_overlap'))";

/// 연속 실패 n회 뒤 자동 실행을 미루는 시간: 60초×2^(n-1), 최대 24시간(upstream routine 안전장치와 같은 형태).
pub fn backoff(failures: i64) -> Option<Duration> {
    (failures >= 1).then(|| Duration::seconds(60 * 2i64.pow((failures - 1).min(20) as u32)).min(Duration::hours(24)))
}

fn from_row(r: &Row) -> rusqlite::Result<Schedule> {
    let tools: Option<String> = r.get(8)?;
    Ok(Schedule {
        id: r.get(0)?,
        project_id: r.get(1)?,
        owner_id: r.get(2)?,
        name: r.get(3)?,
        prompt: r.get(4)?,
        profile_id: r.get(5)?,
        agent_id: r.get(6)?,
        tools_enabled: r.get(7)?,
        allowed_tools: tools.and_then(|s| serde_json::from_str(&s).ok()),
        max_total_tokens: r.get(9)?,
        kind: r.get(10)?,
        at: r.get(11)?,
        interval_minutes: r.get(12)?,
        daily_time: r.get(13)?,
        tz_offset_minutes: r.get(14)?,
        session_mode: r.get(15)?,
        session_id: r.get(16)?,
        on_approval: r.get(17)?,
        missed_grace_minutes: r.get(18)?,
        status: r.get(19)?,
        next_run_at: r.get(20)?,
        revision: r.get(21)?,
        created_at: r.get(22)?,
        updated_at: r.get(23)?,
        max_runs: r.get(24)?,
        end_at: r.get(25)?,
        pause_after_failures: r.get(26)?,
        consecutive_failures: r.get(27)?,
        last_failed_at: r.get::<_, Option<String>>(28)?,
        paused_reason: r.get(29)?,
        runs_used: r.get(30)?,
        backoff_until: None,
    })
    .map(|mut s| {
        s.backoff_until = s.last_failed_at.as_deref().and_then(crate::util::parse_time).zip(backoff(s.consecutive_failures)).map(|(t, d)| crate::util::fmt_time(t + d));
        s
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct Run {
    pub id: String,
    pub schedule_id: String,
    pub planned_at: String,
    pub manual: bool,
    pub status: String,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub detail: Option<String>,
    pub created_at: String,
    pub ended_at: Option<String>,
}

const RCOLS: &str = "id, schedule_id, planned_at, manual, status, session_id, turn_id, detail, created_at, ended_at";

fn run_row(r: &Row) -> rusqlite::Result<Run> {
    Ok(Run {
        id: r.get(0)?,
        schedule_id: r.get(1)?,
        planned_at: r.get(2)?,
        manual: r.get(3)?,
        status: r.get(4)?,
        session_id: r.get(5)?,
        turn_id: r.get(6)?,
        detail: r.get(7)?,
        created_at: r.get(8)?,
        ended_at: r.get(9)?,
    })
}

// ---- 예정 시각 계산(순수 함수) ----

#[derive(Debug, Clone, PartialEq)]
pub enum Timing {
    Once(OffsetDateTime),
    Interval { minutes: i64, anchor: OffsetDateTime },
    Daily { at: Time, offset: UtcOffset },
}

fn secs(t: OffsetDateTime) -> OffsetDateTime {
    t.replace_nanosecond(0).unwrap_or(t)
}

/// `after`보다 뒤인 첫 예정 시각(초 단위). 한 번 실행이 지났으면 None.
pub fn next_after(t: &Timing, after: OffsetDateTime) -> Option<OffsetDateTime> {
    match t {
        Timing::Once(at) => (*at > after).then_some(*at),
        Timing::Interval { minutes, anchor } => {
            if *anchor > after {
                return Some(*anchor);
            }
            let period = Duration::minutes(*minutes);
            let k = (after - *anchor).whole_seconds() / period.whole_seconds() + 1;
            Some(*anchor + period * k as i32)
        }
        Timing::Daily { at, offset } => {
            let local = after.to_offset(*offset);
            let mut c = local.date().with_time(*at).assume_offset(*offset);
            if c <= after {
                c += Duration::days(1);
            }
            Some(c.to_offset(UtcOffset::UTC))
        }
    }
}

/// 한 주기 길이(시계 역행 감지용).
fn period(t: &Timing) -> Option<Duration> {
    match t {
        Timing::Once(_) => None,
        Timing::Interval { minutes, .. } => Some(Duration::minutes(*minutes)),
        Timing::Daily { .. } => Some(Duration::days(1)),
    }
}

fn parse_daily(s: &str) -> Option<Time> {
    let (h, m) = s.split_once(':')?;
    let (h, m): (u8, u8) = (h.parse().ok()?, m.parse().ok()?);
    Time::from_hms(h, m, 0).ok()
}

fn timing_of(s: &Schedule) -> ApiResult<Timing> {
    let bad = || ApiError::invalid("예약 시각 형식이 잘못되었습니다");
    Ok(match s.kind.as_str() {
        "once" => Timing::Once(secs(crate::util::parse_time(s.at.as_deref().ok_or_else(bad)?).ok_or_else(bad)?)),
        "interval" => {
            let anchor = s.at.as_deref().unwrap_or(&s.created_at);
            Timing::Interval { minutes: s.interval_minutes.ok_or_else(bad)?, anchor: secs(crate::util::parse_time(anchor).ok_or_else(bad)?) }
        }
        "daily" => Timing::Daily {
            at: parse_daily(s.daily_time.as_deref().ok_or_else(bad)?).ok_or_else(bad)?,
            offset: UtcOffset::from_whole_seconds((s.tz_offset_minutes * 60) as i32).map_err(|_| bad())?,
        },
        _ => return Err(bad()),
    })
}

/// 예정 시각이 됐을 때 할 일.
#[derive(Debug, PartialEq)]
pub enum Decision {
    /// 아직 아님
    Wait,
    /// 시계 역행: 다음 예정 시각만 다시 계산
    Reschedule,
    Missed,
    SkipOverlap,
    Fire,
}

pub fn decide(t: &Timing, next: OffsetDateTime, now: OffsetDateTime, grace: Duration, running: bool) -> Decision {
    if next > now {
        return match period(t) {
            Some(p) if next - now > p + Duration::minutes(1) => Decision::Reschedule,
            _ => Decision::Wait,
        };
    }
    if now - next > grace {
        Decision::Missed
    } else if running {
        Decision::SkipOverlap
    } else {
        Decision::Fire
    }
}

// ---- 저장 ----

pub fn get(c: &Connection, id: &str) -> ApiResult<Schedule> {
    c.query_row(&format!("SELECT {COLS} FROM schedules WHERE id = ?1 AND status != 'deleted'"), params![id], from_row)
        .optional()?
        .ok_or_else(|| ApiError::not_found("예약이 없습니다"))
}

fn emit(c: &Connection, now: &str, s: &Schedule) -> ApiResult<()> {
    events::append(c, now, "schedule.changed", Some(&s.project_id), None, &serde_json::to_value(s)?)?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SpecBody {
    pub name: String,
    pub prompt: String,
    pub profile_id: String,
    pub agent_id: Option<String>,
    #[serde(default)]
    pub tools: bool,
    pub allowed_tools: Option<Vec<String>>,
    pub max_total_tokens: Option<i64>,
    pub kind: String,
    pub at: Option<String>,
    pub interval_minutes: Option<i64>,
    pub daily_time: Option<String>,
    #[serde(default)]
    pub tz_offset_minutes: i64,
    #[serde(default = "default_mode")]
    pub session_mode: String,
    pub session_id: Option<String>,
    #[serde(default = "default_on_approval")]
    pub on_approval: String,
    #[serde(default = "default_grace")]
    pub missed_grace_minutes: i64,
    #[serde(default)]
    pub max_runs: Option<i64>,
    #[serde(default)]
    pub end_at: Option<String>,
    /// 생략하면 5회. null이면 연속 실패로 멈추지 않는다.
    #[serde(default = "default_pause_after_failures")]
    pub pause_after_failures: Option<i64>,
}

fn default_pause_after_failures() -> Option<i64> {
    Some(5)
}

fn default_mode() -> String {
    "new".into()
}
fn default_on_approval() -> String {
    "wait".into()
}
fn default_grace() -> i64 {
    10
}

/// 입력 검증. 통과하면 저장용 Schedule(일부 필드는 호출자가 채움)을 만든다.
fn validate(c: &Connection, project_id: &str, b: &SpecBody, now: OffsetDateTime) -> ApiResult<()> {
    let name = b.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::invalid("이름은 1~100자여야 합니다"));
    }
    if b.prompt.trim().is_empty() || b.prompt.len() > 32_000 {
        return Err(ApiError::invalid("지시 내용은 비어 있지 않고 32KB 이하여야 합니다"));
    }
    crate::projects::active_root(c, project_id)?;
    crate::models::get_profile(c, &b.profile_id)?;
    if let Some(a) = &b.agent_id {
        crate::definitions::resolve(c, "agent", a)?;
    }
    if let Some(list) = &b.allowed_tools {
        if !b.tools {
            return Err(ApiError::invalid("허용 도구를 정하려면 도구 사용을 켜야 합니다"));
        }
        if let Some(bad) = list.iter().find(|n| crate::tools::spec(n).is_none() && n.as_str() != "agent") {
            return Err(ApiError::invalid(format!("알 수 없는 도구: {bad}")));
        }
    }
    if b.max_total_tokens.is_some_and(|m| m < 1) {
        return Err(ApiError::invalid("token 한도는 1 이상이어야 합니다"));
    }
    match b.kind.as_str() {
        "once" => {
            let at = b.at.as_deref().and_then(crate::util::parse_time).ok_or_else(|| ApiError::invalid("한 번 실행은 at(RFC 3339)이 필요합니다"))?;
            if at <= now {
                return Err(ApiError::invalid("한 번 실행 시각은 미래여야 합니다"));
            }
        }
        "interval" => {
            if !b.interval_minutes.is_some_and(|m| (1..=525_600).contains(&m)) {
                return Err(ApiError::invalid("반복 간격은 1분~1년이어야 합니다"));
            }
            if b.at.as_deref().is_some_and(|a| crate::util::parse_time(a).is_none()) {
                return Err(ApiError::invalid("시작 시각 형식이 잘못되었습니다"));
            }
        }
        "daily" => {
            if b.daily_time.as_deref().and_then(parse_daily).is_none() {
                return Err(ApiError::invalid("매일 실행 시각은 HH:MM이어야 합니다"));
            }
        }
        _ => return Err(ApiError::invalid("kind는 once·interval·daily 중 하나여야 합니다")),
    }
    if !(-14 * 60..=14 * 60).contains(&b.tz_offset_minutes) {
        return Err(ApiError::invalid("시간대 offset은 ±14시간 이내여야 합니다"));
    }
    match b.session_mode.as_str() {
        "new" => {}
        "same" => {
            let sid = b.session_id.as_deref().ok_or_else(|| ApiError::invalid("같은 대화 모드는 session_id가 필요합니다"))?;
            let s = crate::sessions::get_active(c, sid)?;
            if s.project_id != project_id {
                return Err(ApiError::invalid("대화가 이 프로젝트에 속하지 않습니다"));
            }
        }
        _ => return Err(ApiError::invalid("session_mode는 new·same 중 하나여야 합니다")),
    }
    if !matches!(b.on_approval.as_str(), "wait" | "fail") {
        return Err(ApiError::invalid("on_approval은 wait·fail 중 하나여야 합니다"));
    }
    if !(0..=1440).contains(&b.missed_grace_minutes) {
        return Err(ApiError::invalid("놓친 실행 허용 시간은 0~1440분이어야 합니다"));
    }
    if b.kind == "once" && (b.max_runs.is_some() || b.end_at.is_some()) {
        return Err(ApiError::invalid("최대 횟수·종료 시각은 반복 예약에만 정할 수 있습니다"));
    }
    if b.max_runs.is_some_and(|m| !(1..=100_000).contains(&m)) {
        return Err(ApiError::invalid("최대 실행 횟수는 1~100000이어야 합니다"));
    }
    if let Some(end) = &b.end_at {
        let end = crate::util::parse_time(end).ok_or_else(|| ApiError::invalid("종료 시각 형식이 잘못되었습니다"))?;
        if end <= now {
            return Err(ApiError::invalid("종료 시각은 미래여야 합니다"));
        }
    }
    if b.pause_after_failures.is_some_and(|k| !(1..=100).contains(&k)) {
        return Err(ApiError::invalid("연속 실패 정지 횟수는 1~100이어야 합니다"));
    }
    Ok(())
}

/// 실행 결과를 연속 실패 수에 반영한다(AUTO-009). 실패·시작 실패만 세고, 서버 재시작 중단과 사용자 취소는 세지 않는다.
/// 한도에 이르면 활성 예약을 `failures` 이유로 일시 정지하고 알린다.
fn record_outcome(c: &Connection, now: &str, id: &str, status: &str) -> ApiResult<()> {
    // 실행 중에 삭제한 예약은 기록만 남기고 상태를 바꾸지 않는다(턴 종료 transaction을 실패시키지 않는다).
    let current: Option<String> = c.query_row("SELECT status FROM schedules WHERE id = ?1", params![id], |r| r.get(0)).optional()?;
    if current.is_none_or(|s| s == "deleted") {
        return Ok(());
    }
    match status {
        "completed" => {
            c.execute("UPDATE schedules SET consecutive_failures = 0, last_failed_at = NULL WHERE id = ?1", params![id])?;
        }
        "failed" | "start_failed" => {
            c.execute("UPDATE schedules SET consecutive_failures = consecutive_failures + 1, last_failed_at = ?2 WHERE id = ?1", params![id, now])?;
            let s = get(c, id)?;
            if s.status == "active" && s.pause_after_failures.is_some_and(|k| s.consecutive_failures >= k) {
                c.execute(
                    "UPDATE schedules SET status = 'paused', paused_reason = 'failures', revision = revision + 1, updated_at = ?2 WHERE id = ?1",
                    params![id, now],
                )?;
                notifications::push(
                    c,
                    now,
                    "schedule.paused",
                    &format!("예약 '{}' 자동 일시 정지", s.name),
                    &format!("연속 {}회 실패해 멈췄습니다. 실행 기록에서 원인을 확인한 뒤 재개하세요", s.consecutive_failures),
                    Some(&s.project_id),
                    None,
                    Some(&s.id),
                )?;
            }
        }
        _ => return Ok(()),
    }
    emit(c, now, &get(c, id)?)
}

/// 저장된 필드로 다음 예정 시각을 다시 계산해 기록한다.
fn reschedule(c: &Connection, now: &str, id: &str, from: OffsetDateTime) -> ApiResult<Schedule> {
    let s = get(c, id)?;
    // 최대 횟수를 다 썼거나 다음 시각이 종료 시각 뒤면 더 실행하지 않는다.
    let end = s.end_at.as_deref().and_then(crate::util::parse_time);
    let next = next_after(&timing_of(&s)?, from)
        .filter(|n| end.is_none_or(|e| *n <= e))
        .filter(|_| s.max_runs.is_none_or(|m| s.runs_used < m))
        .map(crate::util::fmt_time);
    let status = if next.is_none() && s.status == "active" { "done" } else { s.status.as_str() };
    c.execute(
        "UPDATE schedules SET next_run_at = ?2, status = ?3, revision = revision + 1, updated_at = ?4 WHERE id = ?1",
        params![id, next, status, now],
    )?;
    let s = get(c, id)?;
    emit(c, now, &s)?;
    Ok(s)
}

fn write_spec(c: &Connection, now: &str, id: &str, b: &SpecBody) -> ApiResult<()> {
    let tools = b.allowed_tools.as_ref().map(serde_json::to_string).transpose()?;
    let at = b.at.as_deref().and_then(crate::util::parse_time).map(|t| crate::util::fmt_time(secs(t)));
    let session_id = if b.session_mode == "same" { b.session_id.clone() } else { None };
    c.execute(
        "UPDATE schedules SET name = ?2, prompt = ?3, profile_id = ?4, agent_id = ?5, tools_enabled = ?6, allowed_tools = ?7, max_total_tokens = ?8, \
         kind = ?9, at = ?10, interval_minutes = ?11, daily_time = ?12, tz_offset_minutes = ?13, session_mode = ?14, session_id = ?15, \
         on_approval = ?16, missed_grace_minutes = ?17, updated_at = ?18, max_runs = ?19, end_at = ?20, pause_after_failures = ?21 WHERE id = ?1",
        params![
            id,
            b.name.trim(),
            b.prompt,
            b.profile_id,
            b.agent_id,
            b.tools,
            tools,
            b.max_total_tokens,
            b.kind,
            at,
            b.interval_minutes.filter(|_| b.kind == "interval"),
            b.daily_time.as_ref().filter(|_| b.kind == "daily"),
            b.tz_offset_minutes,
            b.session_mode,
            session_id,
            b.on_approval,
            b.missed_grace_minutes,
            now,
            b.max_runs,
            b.end_at.as_deref().and_then(crate::util::parse_time).map(|t| crate::util::fmt_time(secs(t))),
            b.pause_after_failures
        ],
    )?;
    Ok(())
}

// ---- 실행 ----

fn has_running(c: &Connection, id: &str) -> ApiResult<bool> {
    Ok(c.query_row("SELECT 1 FROM schedule_runs WHERE schedule_id = ?1 AND status = 'running' LIMIT 1", params![id], |_| Ok(())).optional()?.is_some())
}

fn insert_run(c: &Connection, now: &str, s: &Schedule, planned: &str, manual: bool, status: &str, detail: Option<&str>) -> ApiResult<Option<String>> {
    let id = crate::util::new_id();
    let ended = (status != "running").then_some(now);
    let n = c.execute(
        "INSERT INTO schedule_runs (id, schedule_id, planned_at, manual, status, detail, created_at, ended_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
         ON CONFLICT (schedule_id, planned_at) DO NOTHING",
        params![id, s.id, planned, manual, status, detail, now, ended],
    )?;
    Ok((n > 0).then_some(id))
}

/// 실행 시작: 실행 로그 → (새 대화) → 턴 접수. 턴 접수가 실패하면 대화 생성까지 되돌리고 start_failed로 남긴다.
fn fire(c: &Connection, now: &str, epoch: &str, s: &Schedule, planned: &str, manual: bool) -> ApiResult<Option<Run>> {
    let Some(run_id) = insert_run(c, now, s, planned, manual, "running", None)? else {
        return Ok(None);
    };
    c.execute_batch("SAVEPOINT schedule_fire")?;
    let started = (|| -> ApiResult<(String, String)> {
        let sid = match s.session_mode.as_str() {
            "same" => s.session_id.clone().ok_or_else(|| ApiError::invalid("대화가 지정되지 않았습니다"))?,
            _ => {
                let sid = crate::util::new_id();
                let title: String = format!("{} · {}", s.name, &planned[..planned.len().min(16)]).chars().take(120).collect();
                c.execute("INSERT INTO sessions (id, project_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)", params![sid, s.project_id, title, now])?;
                let cs = crate::sessions::get(c, &sid)?;
                events::append(c, now, "session.created", Some(&s.project_id), Some(&sid), &serde_json::to_value(&cs)?)?;
                sid
            }
        };
        let src = json!({
            "kind": "schedule", "schedule_id": s.id, "run_id": run_id, "name": s.name,
            "limits": { "allowed_tools": s.allowed_tools, "max_total_tokens": s.max_total_tokens, "on_approval": s.on_approval },
        });
        let (t, _) = crate::runner::enqueue_turn(c, now, epoch, &format!("schedule:{}", s.id), &sid, &s.prompt, &s.profile_id, s.agent_id.as_deref(), s.tools_enabled, Some(&src))?;
        Ok((sid, t.id))
    })();
    match started {
        Ok((sid, tid)) => {
            c.execute_batch("RELEASE schedule_fire")?;
            c.execute("UPDATE schedule_runs SET session_id = ?2, turn_id = ?3 WHERE id = ?1", params![run_id, sid, tid])?;
        }
        Err(e) => {
            c.execute_batch("ROLLBACK TO schedule_fire; RELEASE schedule_fire")?;
            c.execute("UPDATE schedule_runs SET status = 'start_failed', detail = ?2, ended_at = ?3 WHERE id = ?1", params![run_id, e.message, now])?;
            notifications::push(c, now, "schedule.run", &format!("예약 '{}' 시작 실패", s.name), &e.message, Some(&s.project_id), s.session_id.as_deref(), Some(&run_id))?;
            record_outcome(c, now, &s.id, "start_failed")?;
        }
    }
    Ok(Some(c.query_row(&format!("SELECT {RCOLS} FROM schedule_runs WHERE id = ?1"), params![run_id], run_row)?))
}

/// 예정 시각이 된 예약을 처리한다. 반환: 새 턴을 접수했는지.
pub fn process_due(c: &Connection, now_t: OffsetDateTime, epoch: &str) -> ApiResult<bool> {
    let now = crate::util::fmt_time(now_t);
    let list: Vec<Schedule> = {
        let mut st = c.prepare(&format!("SELECT {COLS} FROM schedules WHERE status = 'active' AND next_run_at IS NOT NULL"))?;
        st.query_map([], from_row)?.collect::<Result<_, _>>()?
    };
    let mut fired = false;
    for s in list {
        let (Ok(t), Some(next)) = (timing_of(&s), s.next_run_at.as_deref().and_then(crate::util::parse_time)) else {
            continue;
        };
        let d = decide(&t, next, now_t, Duration::minutes(s.missed_grace_minutes), has_running(c, &s.id)?);
        let planned = crate::util::fmt_time(next);
        match d {
            Decision::Wait => continue,
            Decision::Reschedule => {
                reschedule(c, &now, &s.id, now_t)?;
                continue;
            }
            Decision::Missed => {
                if let Some(run) = insert_run(c, &now, &s, &planned, false, "missed", Some("예정 시각에 서버가 실행하지 못했습니다(따라잡기 실행 없음)"))? {
                    notifications::push(c, &now, "schedule.run", &format!("예약 '{}' 실행을 놓쳤습니다", s.name), &format!("예정 시각 {planned}"), Some(&s.project_id), None, Some(&run))?;
                }
            }
            Decision::SkipOverlap => {
                insert_run(c, &now, &s, &planned, false, "skipped_overlap", Some("이전 실행이 아직 끝나지 않아 건너뛰었습니다"))?;
            }
            Decision::Fire => {
                // 연속 실패 뒤 대기 시간 안이면 자동 실행을 건너뛰고 이유를 남긴다(수동 실행은 막지 않는다).
                if let Some(until) = s.backoff_until.as_deref().and_then(crate::util::parse_time).filter(|u| *u > now_t) {
                    insert_run(c, &now, &s, &planned, false, "missed", Some(&format!(
                        "연속 {}회 실패 뒤 대기 중이라 건너뛰었습니다(자동 실행 재개 {})", s.consecutive_failures, crate::util::fmt_time(until)
                    )))?;
                } else if let Some(r) = fire(c, &now, epoch, &s, &planned, false)? {
                    fired |= r.status == "running";
                }
            }
        }
        reschedule(c, &now, &s.id, now_t.max(next))?;
    }
    Ok(fired)
}

pub async fn tick(app: &App) {
    let now = app.clock.now();
    let epoch = app.epoch.clone();
    let r = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let fired = process_due(&tx, now, &epoch)?;
            tx.commit()?;
            Ok(fired)
        })
        .await;
    match r {
        Ok(fired) => {
            app.notify_events().await;
            if fired {
                crate::runner::kick_queued(app).await;
            }
        }
        Err(e) => tracing::warn!("예약 처리 실패: {}", e.message),
    }
}

pub fn spawn(app: App) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut rx = app.shutdown_rx.clone();
        let every = std::time::Duration::from_millis(app.cfg.scheduler_tick_ms);
        loop {
            tokio::select! {
                _ = tokio::time::sleep(every) => {}
                _ = rx.changed() => break,
            }
            tick(&app).await;
        }
    })
}

/// 예약 실행 턴 종료 hook(`runner::finish_turn`에서 같은 transaction으로 호출).
pub fn on_turn_finished(c: &Connection, now: &str, turn_id: &str, to: &str) -> ApiResult<()> {
    let Some((run_id, sched_id, session_id)) = c
        .query_row("SELECT id, schedule_id, session_id FROM schedule_runs WHERE turn_id = ?1 AND status = 'running'", params![turn_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?))
        })
        .optional()?
    else {
        return Ok(());
    };
    let status = match to {
        "completed" | "failed" | "cancelled" | "interrupted" => to,
        _ => "failed",
    };
    let err: Option<String> = c.query_row("SELECT error FROM turns WHERE id = ?1", params![turn_id], |r| r.get(0))?;
    let err_msg = err.and_then(|e| serde_json::from_str::<Value>(&e).ok()).and_then(|e| e["message"].as_str().map(String::from));
    c.execute("UPDATE schedule_runs SET status = ?2, detail = ?3, ended_at = ?4 WHERE id = ?1", params![run_id, status, err_msg, now])?;
    let (name, project_id): (String, String) = c.query_row("SELECT name, project_id FROM schedules WHERE id = ?1", params![sched_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let body = if status == "completed" {
        let text: Option<String> = c
            .query_row("SELECT content FROM messages WHERE turn_id = ?1 AND role = 'assistant' ORDER BY seq DESC LIMIT 1", params![turn_id], |r| r.get(0))
            .optional()?;
        text.and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["text"].as_str().map(|s| s.chars().take(300).collect())).unwrap_or_default()
    } else {
        err_msg.unwrap_or_default()
    };
    let label = match status {
        "completed" => "완료",
        "failed" => "실패",
        "cancelled" => "취소",
        _ => "중단",
    };
    notifications::push(c, now, "schedule.run", &format!("예약 '{name}' {label}"), &body, Some(&project_id), session_id.as_deref(), Some(&run_id))?;
    events::append(c, now, "schedule.run", Some(&project_id), session_id.as_deref(), &json!({ "schedule_id": sched_id, "run_id": run_id, "status": status }))?;
    record_outcome(c, now, &sched_id, status)
}

// ---- API ----

#[derive(Deserialize)]
pub struct ListQuery {
    pub project_id: Option<String>,
}

pub async fn list(State(app): State<App>, _p: Principal, Query(q): Query<ListQuery>) -> ApiResult<Json<Vec<Schedule>>> {
    Ok(Json(
        app.db
            .call(move |c| {
                let mut st = c.prepare(&format!("SELECT {COLS} FROM schedules WHERE status != 'deleted' AND (?1 IS NULL OR project_id = ?1) ORDER BY created_at"))?;
                let v = st.query_map(params![q.project_id], from_row)?.collect::<Result<Vec<_>, _>>()?;
                Ok(v)
            })
            .await?,
    ))
}

pub async fn show(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Schedule>> {
    Ok(Json(app.db.call(move |c| get(c, &id)).await?))
}

pub async fn create(State(app): State<App>, p: Principal, headers: HeaderMap, Path(project_id): Path<String>, Json(b): Json<SpecBody>) -> ApiResult<Response> {
    let h = idem::body_hash("schedule.create", &json!({ "p": project_id, "b": b }));
    let now_t = app.clock.now();
    let owner = p.root_id.clone();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        validate(tx, &project_id, &b, now_t)?;
        let id = crate::util::new_id();
        tx.execute(
            "INSERT INTO schedules (id, project_id, owner_id, name, prompt, profile_id, tools_enabled, kind, session_mode, on_approval, missed_grace_minutes, status, created_at, updated_at) \
             VALUES (?1, ?2, ?3, '', '', ?4, 0, ?5, ?6, ?7, ?8, 'active', ?9, ?9)",
            params![id, project_id, owner, b.profile_id, b.kind, b.session_mode, b.on_approval, b.missed_grace_minutes, crate::util::fmt_time(secs(now_t))],
        )?;
        write_spec(tx, now, &id, &b)?;
        let s = reschedule(tx, now, &id, now_t)?;
        Ok((StatusCode::CREATED, serde_json::to_value(s)?))
    })
    .await
}

#[derive(Deserialize)]
pub struct UpdateBody {
    pub expected_revision: i64,
    #[serde(flatten)]
    pub spec: SpecBody,
}

pub async fn update(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<UpdateBody>) -> ApiResult<Response> {
    let h = idem::body_hash("schedule.update", &json!({ "i": id, "r": b.expected_revision, "b": b.spec }));
    let now_t = app.clock.now();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get(tx, &id)?;
        if cur.revision != b.expected_revision {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        validate(tx, &cur.project_id, &b.spec, now_t)?;
        write_spec(tx, now, &id, &b.spec)?;
        // 수정하면 끝난 한 번 실행도 새 시각으로 다시 활성화한다(일시 정지는 유지).
        if cur.status == "done" {
            tx.execute("UPDATE schedules SET status = 'active' WHERE id = ?1", params![id])?;
        }
        let s = reschedule(tx, now, &id, now_t)?;
        Ok((StatusCode::OK, serde_json::to_value(s)?))
    })
    .await
}

#[derive(Deserialize)]
pub struct RevBody {
    pub expected_revision: i64,
}

async fn set_status(app: App, p: Principal, headers: HeaderMap, id: String, rev: i64, action: &'static str) -> ApiResult<Response> {
    let h = idem::body_hash("schedule.status", &json!({ "i": id, "r": rev, "a": action }));
    let now_t = app.clock.now();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let cur = get(tx, &id)?;
        if cur.revision != rev {
            return Err(ApiError::revision_conflict(serde_json::to_value(&cur)?));
        }
        let to = match (action, cur.status.as_str()) {
            ("pause", "active") => "paused",
            ("resume", "paused") => "active",
            ("delete", _) => "deleted",
            _ => return Err(ApiError::conflict("invalid_state", format!("{} 상태에서는 할 수 없습니다", cur.status))),
        };
        // 사용자가 멈추면 이유를 남기고, 재개하면 연속 실패를 초기화해 바로 자동 실행할 수 있게 한다.
        tx.execute(
            "UPDATE schedules SET status = ?2, revision = revision + 1, updated_at = ?3, \
             paused_reason = CASE ?2 WHEN 'paused' THEN 'user' ELSE NULL END, \
             consecutive_failures = CASE ?2 WHEN 'active' THEN 0 ELSE consecutive_failures END, \
             last_failed_at = CASE ?2 WHEN 'active' THEN NULL ELSE last_failed_at END WHERE id = ?1",
            params![id, to, now],
        )?;
        let v = if to == "active" {
            // 재개: 정지 중 지난 시각은 실행하지 않고 지금 기준으로 다음 시각을 정한다.
            serde_json::to_value(reschedule(tx, now, &id, now_t)?)?
        } else if to == "deleted" {
            emit(tx, now, &Schedule { status: "deleted".into(), ..cur })?;
            json!({ "id": id, "status": "deleted" })
        } else {
            let s = get(tx, &id)?;
            emit(tx, now, &s)?;
            serde_json::to_value(s)?
        };
        Ok((StatusCode::OK, v))
    })
    .await
}

pub async fn pause(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<RevBody>) -> ApiResult<Response> {
    set_status(app, p, headers, id, b.expected_revision, "pause").await
}

pub async fn resume(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<RevBody>) -> ApiResult<Response> {
    set_status(app, p, headers, id, b.expected_revision, "resume").await
}

pub async fn delete(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<RevBody>) -> ApiResult<Response> {
    set_status(app, p, headers, id, b.expected_revision, "delete").await
}

/// 지금 한 번 실행(예정 시각에 영향 없음). 이전 실행이 끝나지 않았으면 거부한다.
pub async fn run_now(State(app): State<App>, p: Principal, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Response> {
    let h = idem::body_hash("schedule.run", &json!({ "i": id }));
    let epoch = app.epoch.clone();
    let resp = idem::run(&app, &p, &headers, &h, move |tx, now| {
        let s = get(tx, &id)?;
        if has_running(tx, &s.id)? {
            return Err(ApiError::busy("이전 실행이 아직 끝나지 않았습니다"));
        }
        let run = fire(tx, now, &epoch, &s, now, true)?.ok_or_else(|| ApiError::busy("같은 시각에 이미 실행했습니다"))?;
        Ok((StatusCode::ACCEPTED, serde_json::to_value(run)?))
    })
    .await?;
    crate::runner::kick_queued(&app).await;
    Ok(resp)
}

pub async fn runs(State(app): State<App>, _p: Principal, Path(id): Path<String>) -> ApiResult<Json<Vec<Run>>> {
    Ok(Json(
        app.db
            .call(move |c| {
                get(c, &id)?;
                let mut st = c.prepare(&format!("SELECT {RCOLS} FROM schedule_runs WHERE schedule_id = ?1 ORDER BY created_at DESC LIMIT 100"))?;
                let v = st.query_map(params![id], run_row)?.collect::<Result<Vec<_>, _>>()?;
                Ok(v)
            })
            .await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::{datetime, offset, time};

    #[test]
    fn interval_steps_from_anchor_without_drift() {
        let t = Timing::Interval { minutes: 30, anchor: datetime!(2026-01-01 00:00 UTC) };
        assert_eq!(next_after(&t, datetime!(2025-12-31 23:00 UTC)), Some(datetime!(2026-01-01 00:00 UTC)));
        assert_eq!(next_after(&t, datetime!(2026-01-01 00:00 UTC)), Some(datetime!(2026-01-01 00:30 UTC)));
        assert_eq!(next_after(&t, datetime!(2026-01-01 01:10:07 UTC)), Some(datetime!(2026-01-01 01:30 UTC)));
    }

    #[test]
    fn daily_uses_fixed_offset_and_rolls_to_next_day() {
        let t = Timing::Daily { at: time!(09:00), offset: offset!(+9) };
        // 서울 09:00 = UTC 00:00
        assert_eq!(next_after(&t, datetime!(2026-03-01 23:59 UTC)), Some(datetime!(2026-03-02 00:00 UTC)));
        assert_eq!(next_after(&t, datetime!(2026-03-02 00:00 UTC)), Some(datetime!(2026-03-03 00:00 UTC)));
        // 음수 offset에서 날짜 경계
        let t = Timing::Daily { at: time!(20:00), offset: offset!(-5) };
        assert_eq!(next_after(&t, datetime!(2026-03-02 00:30 UTC)), Some(datetime!(2026-03-02 01:00 UTC)));
    }

    #[test]
    fn once_is_done_after_its_time() {
        let t = Timing::Once(datetime!(2026-01-01 00:00 UTC));
        assert_eq!(next_after(&t, datetime!(2026-01-01 00:00 UTC)), None);
    }

    #[test]
    fn decide_covers_missed_overlap_and_clock_jumps() {
        let t = Timing::Interval { minutes: 60, anchor: datetime!(2026-01-01 00:00 UTC) };
        let next = datetime!(2026-01-01 05:00 UTC);
        let g = Duration::minutes(10);
        assert_eq!(decide(&t, next, datetime!(2026-01-01 04:59 UTC), g, false), Decision::Wait);
        assert_eq!(decide(&t, next, datetime!(2026-01-01 05:03 UTC), g, false), Decision::Fire);
        assert_eq!(decide(&t, next, datetime!(2026-01-01 05:03 UTC), g, true), Decision::SkipOverlap);
        // 시계가 앞으로 뛰었거나 서버가 꺼져 있었음
        assert_eq!(decide(&t, next, datetime!(2026-01-01 09:00 UTC), g, false), Decision::Missed);
        // 시계가 뒤로 감: 다음 시각이 한 주기보다 멀다
        assert_eq!(decide(&t, next, datetime!(2026-01-01 02:00 UTC), g, false), Decision::Reschedule);
        // 한 번 실행은 역행 판단을 하지 않는다
        assert_eq!(decide(&Timing::Once(next), next, datetime!(2025-01-01 00:00 UTC), g, false), Decision::Wait);
    }
}
