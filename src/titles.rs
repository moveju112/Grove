//! 대화 제목(SESSION-002): 직접 입력은 세션 PATCH, 여기서는 모델 생성.
//!
//! - 자동 생성은 `session.auto_title`이 켜졌을 때 첫 완료 턴 뒤 한 번만(기본 꺼짐: 몰래 비용을 쓰지 않음).
//! - 수동 생성은 사용자가 요청할 때만.
//! - 실패·빈 응답·형식 오류면 기존 제목(첫 줄)을 유지한다(fallback). 생성 중 사용자가 제목을 바꿨으면 덮어쓰지 않는다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::provider::{self, ChatMsg, ModelRequest};
use axum::Json;
use axum::extract::{Path, State};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

const SYSTEM: &str = "You name conversations. Reply with a short, specific title (at most 8 words) in the same language as the conversation. \
Output only the title on one line, without quotes or trailing punctuation.";

/// 모델 출력 → 제목. 쓸 수 없으면 None.
pub fn clean(raw: &str) -> Option<String> {
    let line = raw.lines().map(str::trim).find(|l| !l.is_empty())?;
    let t = line.trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '“' | '”' | '「' | '」' | '*' | '#') || c.is_whitespace());
    let t = t.strip_prefix("Title:").or_else(|| t.strip_prefix("제목:")).unwrap_or(t).trim();
    let t: String = t.trim_end_matches(['.', '。']).chars().filter(|c| !c.is_control()).take(60).collect();
    (!t.trim().is_empty()).then(|| t.trim().to_string())
}

/// 제목을 생성해 적용한다. 반환: (적용됐는지, 제목 또는 유지 사유)
pub async fn generate(app: &App, session_id: &str, profile_id: Option<String>) -> ApiResult<Value> {
    let sid = session_id.to_string();
    let prepared = app
        .db
        .call(move |c| {
            let s = crate::sessions::get_active(c, &sid)?;
            let chosen = crate::settings::effective(c, "session.title_profile", Some(&s.project_id), Some(&sid))?;
            let last: Option<String> =
                c.query_row("SELECT profile_id FROM turns WHERE session_id = ?1 AND profile_id IS NOT NULL ORDER BY created_at DESC LIMIT 1", params![sid], |r| r.get(0)).optional()?;
            let profile = profile_id
                .or_else(|| chosen.as_str().filter(|x| !x.is_empty()).map(String::from))
                .or(last)
                .ok_or_else(|| ApiError::invalid("제목을 만들 모델 프로필이 없습니다"))?;
            let (_, rp) = crate::models::runtime_profile(c, &profile)?;
            let mut st = c.prepare(
                "SELECT role, json_extract(content, '$.text') FROM messages WHERE session_id = ?1 AND rewound_at IS NULL AND role IN ('user','assistant') \
                 AND json_extract(content, '$.text') IS NOT NULL ORDER BY seq LIMIT 4",
            )?;
            let mut text = String::new();
            for r in st.query_map(params![sid], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
                let (role, t) = r?;
                text.push_str(&format!("{role}: {}\n", t.chars().take(1500).collect::<String>()));
            }
            if text.trim().is_empty() {
                return Err(ApiError::conflict("empty", "제목을 만들 메시지가 없습니다"));
            }
            Ok((s.revision, rp, text))
        })
        .await?;
    let (rev, rp, text) = prepared;
    let req = ModelRequest {
        system: SYSTEM.into(),
        messages: vec![ChatMsg::User { text: format!("Conversation:\n{text}\nTitle:") }],
        tools: vec![],
        max_tokens: Some(64),
        temperature: None,
        effort: None,
        cli: None,
    };
    let (_tx, mut cancel) = tokio::sync::watch::channel(false);
    let out = provider::stream(&rp, &req, &mut cancel, &mut |_| {}).await;
    let title = match out {
        Ok(o) => clean(&o.text),
        Err(e) => return Ok(json!({ "applied": false, "reason": "model_error", "message": e.message })),
    };
    let Some(title) = title else {
        return Ok(json!({ "applied": false, "reason": "empty_output", "message": "모델이 쓸 수 있는 제목을 주지 않아 기존 제목을 유지합니다" }));
    };
    let (sid, now) = (session_id.to_string(), app.now());
    let t2 = title.clone();
    let applied = app
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            // 생성 중 사용자가 제목 등을 바꿨으면(revision 변경) 덮어쓰지 않는다.
            let n = tx.execute(
                "UPDATE sessions SET title = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?1 AND revision = ?4 AND archived_at IS NULL",
                params![sid, t2, now, rev],
            )?;
            if n > 0 {
                let s = crate::sessions::get(&tx, &sid)?;
                events::append(&tx, &now, "session.updated", Some(&s.project_id), Some(&sid), &serde_json::to_value(&s)?)?;
            }
            tx.commit()?;
            Ok(n > 0)
        })
        .await?;
    app.notify_events().await;
    Ok(if applied {
        json!({ "applied": true, "title": title })
    } else {
        json!({ "applied": false, "reason": "changed", "message": "생성 중 대화가 바뀌어 적용하지 않았습니다", "title": title })
    })
}

/// 턴 종료 뒤: 설정이 켜져 있고 이 대화의 첫 완료 턴이면 한 번 생성한다(봇 대화 제외).
pub async fn after_turn(app: &App, turn_id: &str) {
    let tid = turn_id.to_string();
    let due = app
        .db
        .call(move |c| {
            let t = crate::runner::get_turn(c, &tid)?;
            if t.status != "completed" {
                return Ok(None);
            }
            let s = crate::sessions::get(c, &t.session_id)?;
            if s.bot_id.is_some() || s.archived_at.is_some() || s.parent_session_id.is_some() {
                return Ok(None);
            }
            let on = crate::settings::effective(c, "session.auto_title", Some(&s.project_id), Some(&s.id))?;
            if on != json!(true) {
                return Ok(None);
            }
            let done: i64 = c.query_row("SELECT COUNT(*) FROM turns WHERE session_id = ?1 AND status = 'completed'", params![s.id], |r| r.get(0))?;
            Ok((done == 1).then_some((s.id, t.profile_id)))
        })
        .await
        .ok()
        .flatten();
    if let Some((sid, profile)) = due {
        if let Err(e) = generate(app, &sid, profile).await {
            tracing::info!("제목 자동 생성 건너뜀: {}", e.message);
        }
    }
}

#[derive(Deserialize, Default)]
pub struct GenBody {
    pub profile_id: Option<String>,
}

pub async fn post_generate(State(app): State<App>, _p: Principal, Path(id): Path<String>, body: Option<Json<GenBody>>) -> ApiResult<Json<Value>> {
    let b = body.map(|j| j.0).unwrap_or_default();
    Ok(Json(generate(&app, &id, b.profile_id).await?))
}

#[cfg(test)]
mod tests {
    use super::clean;
    #[test]
    fn cleans_quotes_prefix_and_rejects_empty() {
        assert_eq!(clean("\"배포 스크립트 점검\"\n"), Some("배포 스크립트 점검".into()));
        assert_eq!(clean("\n  Title: Fix login bug.  "), Some("Fix login bug".into()));
        assert_eq!(clean("**제목: 로그 회전**"), Some("로그 회전".into()));
        assert_eq!(clean("   \n  "), None);
        assert_eq!(clean("\"\""), None);
        assert_eq!(clean(&"가".repeat(100)).unwrap().chars().count(), 60);
    }
}
