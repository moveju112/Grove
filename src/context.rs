//! 컨텍스트 사용량과 압축(CTX-001~007, 011).
//!
//! - 사용량: 모델 프로필의 `context_window` 대비 마지막 모델 응답의 실측 input token(measured)과
//!   현재 이력의 문자 수 기반 추정(estimated)을 따로 보여 준다.
//! - 압축 경계: 마지막 사용자 메시지 직전. 사용자 메시지 앞에서 자르므로 tool call/result 짝이 갈라지지 않고,
//!   시스템 지침은 매 턴 새로 만들어 압축과 무관하게 유지된다.
//! - 원자성: 요약이 성공했을 때만 압축 note를 한 transaction으로 기록한다. 실패·취소는 아무것도 바꾸지 않는다(실패는 note로 알린다).
//! - 자동 압축: 턴의 첫 모델 호출 전에 `context.auto_compact_percent`를 넘으면 먼저 압축한다(0이면 끔).

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::provider::{self, ChatMsg, ModelRequest};
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::watch;

const SUMMARY_SYSTEM: &str = "You compress a conversation between a user and a coding assistant so work can continue with less context. \
Write a faithful, dense summary in the conversation's language: goals and constraints, decisions made, files and commands touched, \
current state, open questions and the next intended steps. Keep exact identifiers, paths and error text. Do not invent facts.";

/// 프로필에 max_tokens가 없을 때 응답용으로 남겨 둘 token.
const DEFAULT_OUTPUT_RESERVE: u64 = 4096;

pub struct Compaction {
    pub upto_seq: i64,
    pub summary: String,
}

/// `upto` 이하에서 가장 최근 압축(없으면 None).
pub fn latest_compaction(c: &Connection, session_id: &str, upto: Option<i64>) -> ApiResult<Option<Compaction>> {
    let row: Option<String> = c
        .query_row(
            "SELECT content FROM messages WHERE session_id = ?1 AND rewound_at IS NULL AND role = 'note' AND json_extract(content, '$.type') = 'compaction' AND seq <= ?2 \
             ORDER BY seq DESC LIMIT 1",
            params![session_id, upto.unwrap_or(i64::MAX)],
            |r| r.get(0),
        )
        .optional()?;
    Ok(row.and_then(|s| serde_json::from_str::<Value>(&s).ok()).map(|v| Compaction {
        upto_seq: v["upto_seq"].as_i64().unwrap_or(0),
        summary: v["summary"].as_str().unwrap_or("").to_string(),
    }))
}

pub fn summary_block(summary: &str) -> String {
    format!("[Summary of the earlier conversation (compacted)]\n{summary}")
}

/// 문자 수 기반 대략 추정(약 4자당 1 token). 실측과 구분해서만 쓴다.
fn estimate_tokens(msgs: &[ChatMsg], system: &str) -> u64 {
    let mut chars = system.chars().count();
    for m in msgs {
        chars += match m {
            ChatMsg::User { text, images } => text.chars().count() + images.len()*4096*4,
            ChatMsg::Assistant { text, tool_calls, native } => text.chars().count()
                + native.as_ref().map_or(0, |n| n.blocks.iter().map(|b| b.to_string().chars().count()).sum::<usize>())
                + tool_calls.iter().map(|t| t.arguments.to_string().len() + t.name.len()).sum::<usize>(),
            ChatMsg::Tool { content, .. } => content.chars().count(),
        };
    }
    (chars as u64).div_ceil(4)
}

/// 마지막 모델 응답의 실측 input token(압축 이후 응답만).
fn measured_tokens(c: &Connection, session_id: &str) -> ApiResult<Option<(u64, i64)>> {
    let after = latest_compaction(c, session_id, None)?.map(|_| {
        c.query_row(
            "SELECT MAX(seq) FROM messages WHERE session_id = ?1 AND rewound_at IS NULL AND role = 'note' AND json_extract(content, '$.type') = 'compaction'",
            params![session_id],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
    });
    let row: Option<(String, i64)> = c
        .query_row(
            "SELECT content, seq FROM messages WHERE session_id = ?1 AND rewound_at IS NULL AND role = 'assistant' AND seq > ?2 ORDER BY seq DESC LIMIT 1",
            params![session_id, after.unwrap_or(0)],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    // provider가 사용량을 주지 않으면 어댑터가 0으로 채운다. 실제 요청의 input은 0일 수 없으므로 0은 "실측 없음"이다.
    Ok(row.and_then(|(s, seq)| {
        serde_json::from_str::<Value>(&s).ok().and_then(|v| v["usage"]["input_tokens"].as_u64()).filter(|t| *t > 0).map(|t| (t, seq))
    }))
}

/// 사용량 계산(CTX-001/002). percent는 실측이 있으면 실측, 없으면 추정 기준이다.
pub fn usage(c: &Connection, session_id: &str, profile_id: Option<&str>) -> ApiResult<Value> {
    let profile = profile_id.map(|id| crate::models::get_profile(c, id)).transpose()?;
    let limit = profile.as_ref().and_then(|p| p.capabilities.context_tokens);
    // 여유분(CTX-003): 응답 최대 출력 + 도구 결과·다음 사용자 입력 예비분
    let s = crate::sessions::get(c, session_id)?;
    let input_reserve = crate::settings::effective(c, "context.input_reserve_tokens", Some(&s.project_id), Some(session_id))?.as_u64().unwrap_or(0);
    let reserve = profile.as_ref().and_then(|p| p.generation_options().0).map(u64::from).unwrap_or(DEFAULT_OUTPUT_RESERVE) + input_reserve;
    let estimated = crate::history::estimated_tokens(c, session_id)?;
    let measured = measured_tokens(c, session_id)?;
    // 실측은 그 응답을 만든 요청의 입력이다. 그 응답 자체와 이후 메시지는 다음 요청에 더해지므로 추정으로 더한다
    // (content 전체 길이 기준이라 실제보다 약간 크게 잡힌다: 여유분을 과대평가하지 않는 쪽).
    let basis = match measured {
        Some((t, seq)) => {
            let chars: i64 = c.query_row(
                "SELECT COALESCE(SUM(length(content)), 0) FROM messages WHERE session_id = ?1 AND rewound_at IS NULL AND seq >= ?2 AND role IN ('user','assistant','tool')",
                params![session_id, seq],
                |r| r.get(0),
            )?;
            // provider가 cache 등을 빼고 보고하면 실측이 실제보다 작을 수 있으므로 전체 이력 추정보다 작게 잡지 않는다.
            (t + (chars.max(0) as u64).div_ceil(4)).max(estimated)
        }
        None => estimated,
    };
    let percent = limit.filter(|l| *l > 0).map(|l| ((basis as f64 / l as f64) * 1000.0).round() / 10.0);
    let compaction = latest_compaction(c, session_id, None)?.map(|cp| json!({ "upto_seq": cp.upto_seq }));
    Ok(json!({
        "context_window": limit, "estimated_tokens": estimated,
        "measured_input_tokens": measured.map(|m| m.0), "measured_at_seq": measured.map(|m| m.1),
        "basis": if measured.is_some() { "measured" } else { "estimated" },
        "percent": percent, "compaction": compaction,
        // percent·여유 계산에 쓴 값(실측이면 실측 입력 + 이후 메시지 추정)
        "tokens": basis,
        "reserve_tokens": reserve,
        // 출력·다음 입력 여유를 뺀 뒤 남는 양(음수면 다음 요청 전에 압축이 필요)
        "available_tokens": limit.map(|l| l as i64 - basis as i64 - reserve as i64),
    }))
}

fn boundary(c: &Connection, session_id: &str) -> ApiResult<Option<i64>> {
    let last_user: Option<i64> = c.query_row(
        "SELECT MAX(seq) FROM messages WHERE session_id = ?1 AND rewound_at IS NULL AND role = 'user'",
        params![session_id],
        |r| r.get(0),
    )?;
    let Some(lu) = last_user else { return Ok(None) };
    let b = lu - 1;
    let prev = latest_compaction(c, session_id, None)?.map(|cp| cp.upto_seq).unwrap_or(0);
    // 이전 압축 이후로 요약할 메시지가 2개 미만이면 압축하지 않는다.
    let n: i64 = c.query_row(
        "SELECT COUNT(*) FROM messages WHERE session_id = ?1 AND rewound_at IS NULL AND seq > ?2 AND seq <= ?3 AND role IN ('user','assistant','tool')",
        params![session_id, prev, b],
        |r| r.get(0),
    )?;
    Ok((n >= 2).then_some(b))
}

#[derive(Deserialize)]
pub struct InputPage {
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

/// 모델이 다음 요청에서 실제로 보게 될 입력(SESSION-011). runner와 같은 순차 변환기로 계산해
/// 압축 요약 치환·분기 상속·표시 전용 기록 제외가 화면과 일치한다. 큰 내용은 앞부분만 보여 준다.
pub async fn get_model_input(State(app): State<App>, _p: Principal, Path(id): Path<String>, Query(q): Query<InputPage>) -> ApiResult<Json<Value>> {
    let v = app
        .db
        .call(move |c| {
            crate::sessions::get(c, &id)?;
            let offset = q.offset.unwrap_or(0);
            let limit = q.limit.unwrap_or(50).clamp(1, 200);
            crate::history::preview(c, &id, offset, limit)
        })
        .await?;
    Ok(Json(v))
}

/// 압축 실행. 성공하면 기록한 note를, 압축할 것이 없으면 None을 돌려준다.
pub async fn compact(app: &App, session_id: &str, profile_id: &str, auto: bool, cancel: &mut watch::Receiver<bool>) -> ApiResult<Option<Value>> {
    let (sid, pid) = (session_id.to_string(), profile_id.to_string());
    let data = app.cfg.data_dir.clone();
    let prepared = app
        .db
        .call(move |c| {
            let s = crate::sessions::get_active(c, &sid)?;
            let Some(b) = boundary(c, &sid)? else { return Ok(None) };
            // 요약 모델: 설정 > 요청 프로필
            let chosen = crate::settings::effective(c, "context.summary_profile", Some(&s.project_id), Some(&sid))?;
            let use_profile = chosen.as_str().filter(|x| !x.is_empty()).map(str::to_string).unwrap_or(pid);
            let (mp, rp) = crate::models::runtime_profile(c, &use_profile)?;
            let mut msgs = crate::history::model_chat(c, &sid, Some(b))?;
            mp.check_capabilities(false, None, msgs.iter().any(|m| matches!(m, ChatMsg::User { images, .. } if !images.is_empty())))?;
            let max_tokens = mp.capabilities.max_output_tokens.unwrap_or(4096).min(4096);
            let before = estimate_tokens(&msgs, "");
            crate::attachments::hydrate(c, &data, &s.project_id, &mut msgs)?;
            msgs.push(ChatMsg::User {
                text: "Summarize the conversation above following the system instructions. Output only the summary.".into(),
                images: vec![],
            });
            // to_chat는 연속 user를 합치므로 마지막에 붙인 지시가 앞 user와 합쳐질 수 있다(의도대로 동작).
            let timeline: i64 = c.query_row("SELECT timeline_revision FROM sessions WHERE id = ?1", params![sid], |r| r.get(0))?;
            Ok(Some((b, use_profile, rp, msgs, before, timeline, max_tokens)))
        })
        .await?;
    let Some((b, used_profile, rp, msgs, before, timeline, max_tokens)) = prepared else { return Ok(None) };
    let req = ModelRequest { system: SUMMARY_SYSTEM.into(), messages: msgs, tools: vec![], max_tokens: Some(max_tokens), temperature: None, effort: None, cli: None };
    let permit = crate::model_limits::auxiliary(app, session_id, &rp, cancel).await?;
    let out = provider::stream(&rp, &req, cancel, &mut |_| {}).await;
    drop(permit);
    let (sid, now) = (session_id.to_string(), app.now());
    let result = match out {
        Ok(o) if !o.text.trim().is_empty() => {
            let summary = o.text.trim().to_string();
            let after = (summary.chars().count() as u64).div_ceil(4);
            app.db
                .call(move |c| {
                    let tx = c.transaction()?;
                    let current: i64 = tx.query_row("SELECT timeline_revision FROM sessions WHERE id = ?1", params![sid], |r| r.get(0))?;
                    if current != timeline {
                        return Err(ApiError::conflict("timeline_changed", "요약 중 대화가 되감겨 이전 요약을 적용하지 않았습니다"));
                    }
                    // 그 사이 다른 압축이 같은 범위를 이미 덮었으면 기록하지 않는다.
                    if latest_compaction(&tx, &sid, None)?.is_some_and(|cp| cp.upto_seq >= b) {
                        return Ok(None);
                    }
                    let content = json!({
                        "type": "compaction", "upto_seq": b, "summary": summary, "auto": auto, "profile_id": used_profile,
                        "usage": o.usage, "estimated_before": before, "estimated_after": after,
                    });
                    let m = crate::sessions::append_message(&tx, &now, &sid, "note", &content, None, None)?;
                    tx.commit()?;
                    Ok(Some(serde_json::to_value(m)?))
                })
                .await
        }
        Ok(_) => Err(ApiError::new(StatusCode::BAD_GATEWAY, "empty_summary", "요약 모델이 빈 응답을 돌려줘 압축하지 않았습니다")),
        Err(e) if e.code == "cancelled" => Err(ApiError::new(StatusCode::CONFLICT, "cancelled", "압축이 취소되어 아무것도 바꾸지 않았습니다")),
        Err(e) => Err(ApiError::new(StatusCode::BAD_GATEWAY, "summary_failed", format!("요약 실패(아무것도 바꾸지 않음): {}", e.message))),
    };
    app.notify_events().await;
    result
}

/// 턴 시작 시 자동 압축. 실패는 턴을 막지 않고 note로 남긴다.
pub async fn maybe_auto_compact(app: &App, session_id: &str, profile_id: &str, cancel: &mut watch::Receiver<bool>) {
    let (sid, pid) = (session_id.to_string(), profile_id.to_string());
    let need = app
        .db
        .call(move |c| {
            let s = crate::sessions::get(c, &sid)?;
            let th = crate::settings::effective(c, "context.auto_compact_percent", Some(&s.project_id), Some(&sid))?.as_f64().unwrap_or(0.0);
            if th <= 0.0 {
                return Ok(false);
            }
            let u = usage(c, &sid, Some(&pid))?;
            // 비율 기준을 넘었거나, 비율은 낮아도 출력·다음 입력 여유가 모자라면 압축한다.
            Ok(u["percent"].as_f64().is_some_and(|p| p >= th) || u["available_tokens"].as_i64().is_some_and(|a| a < 0))
        })
        .await
        .unwrap_or(false);
    if !need {
        return;
    }
    if let Err(e) = compact(app, session_id, profile_id, true, cancel).await {
        if e.code == "cancelled" {
            return;
        }
        let (sid, now) = (session_id.to_string(), app.now());
        let _ = app
            .db
            .call(move |c| {
                crate::sessions::append_message(c, &now, &sid, "note", &json!({ "type": "compaction_failed", "auto": true, "error": { "code": e.code, "message": e.message } }), None, None)?;
                Ok(())
            })
            .await;
        app.notify_events().await;
    }
}

// ---------------- API ----------------

#[derive(Deserialize)]
pub struct UsageQuery {
    pub profile_id: Option<String>,
}

pub async fn get_usage(State(app): State<App>, _p: Principal, Path(id): Path<String>, Query(q): Query<UsageQuery>) -> ApiResult<Json<Value>> {
    Ok(Json(app.db.call(move |c| usage(c, &id, q.profile_id.as_deref())).await?))
}

#[derive(Deserialize)]
pub struct CompactBody {
    pub profile_id: String,
}

/// 수동 압축. 실행 중 턴이 있으면 거부한다(턴과 동시에 이력을 바꾸지 않음).
pub async fn post_compact(State(app): State<App>, _p: Principal, Path(id): Path<String>, Json(b): Json<CompactBody>) -> ApiResult<(StatusCode, Json<Value>)> {
    let i = id.clone();
    let s = app.db.call(move |c| crate::sessions::get_active(c, &i)).await?;
    if s.active_turn.is_some() {
        return Err(ApiError::busy("실행 중인 요청이 끝난 뒤 압축하세요"));
    }
    let mut shutdown = app.shutdown_rx.clone();
    match compact(&app, &id, &b.profile_id, false, &mut shutdown).await? {
        Some(m) => Ok((StatusCode::CREATED, Json(json!({ "compacted": true, "message": m })))),
        None => Ok((StatusCode::OK, Json(json!({ "compacted": false, "reason": "압축할 이전 대화가 충분하지 않습니다" })))),
    }
}
