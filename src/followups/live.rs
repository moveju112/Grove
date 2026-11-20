//! CLI(Codex·Claude Code) 호출 도중의 합치기. DB 접수 → wire 전송 → native ACK → 메시지 commit.
//! sending 상태는 재실행하지 않으며, 종료·재시작 시 결과 불명으로 남긴다.
use super::*;
use crate::provider::ChatMsg;
use std::sync::Arc;
use tokio::sync::{Mutex, watch};

#[derive(Clone)]
pub struct LiveSteers {
    app: App,
    turn_id: String,
    epoch: String,
    changed: Arc<Mutex<watch::Receiver<i64>>>,
}

impl std::fmt::Debug for LiveSteers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveSteers").field("turn_id", &self.turn_id).finish_non_exhaustive()
    }
}

pub struct Delivery {
    pub id: String,
    /// Codex app-server 입력(text·localImage).
    pub input: Vec<Value>,
    /// Claude Code stream-json user content(text·base64 image).
    pub content: Vec<Value>,
    prepared: crate::attachments::Prepared,
    // localImage는 ACK와 호출 종료까지 원문을 유지해야 한다.
    _scratch: tempfile::TempDir,
}

impl LiveSteers {
    pub fn new(app: &App, turn_id: &str) -> Self {
        Self {
            app: app.clone(), turn_id: turn_id.into(), epoch: app.epoch.clone(),
            changed: Arc::new(Mutex::new(app.seq_tx.subscribe())),
        }
    }

    /// read-only 후보 조회다. stream 알림이 먼저 와서 future가 drop돼도 접수 상태를 바꾸지 않는다.
    pub async fn next(&self) -> ApiResult<String> {
        let mut changed = self.changed.lock().await;
        loop {
            let (tid, epoch) = (self.turn_id.clone(), self.epoch.clone());
            let next = self.app.db.call(move |c| {
                Ok(c.query_row(
                    "SELECT f.id FROM followups f JOIN turns t ON t.session_id=f.session_id \
                     WHERE t.id=?1 AND t.owner_epoch=?2 AND t.status='running' \
                     AND f.kind='steer' AND f.delivery_state='pending' ORDER BY f.rowid LIMIT 1",
                    params![tid, epoch], |r| r.get::<_, String>(0),
                ).optional()?)
            }).await?;
            if let Some(id) = next { return Ok(id); }
            changed.changed().await.map_err(|_| ApiError::conflict("steer_stream_closed", "추가 메시지 연결이 종료되었습니다"))?;
        }
    }

    pub async fn claim(&self, id: &str) -> ApiResult<Option<Delivery>> {
        let (tid, epoch, id, data) = (self.turn_id.clone(), self.epoch.clone(), id.to_string(), self.app.cfg.data_dir.clone());
        let result = self.app.db.call(move |c| {
            let tx = c.transaction()?;
            let now = crate::util::fmt_time(time::OffsetDateTime::now_utc());
            let f = tx.query_row(
                &format!("SELECT {COLS} FROM followups WHERE id=?1 AND kind='steer' AND delivery_state='pending' \
                    AND session_id=(SELECT session_id FROM turns WHERE id=?2 AND owner_epoch=?3 AND status='running')"),
                params![id, tid, epoch], row,
            ).optional()?;
            let Some(f) = f else { return Ok(None); };
            let owner = owner_of(&tx, &f.id)?;
            // followup 참조는 ACK까지 유지한다. wire 전송 전에 참조를 메시지로 옮기지 않는다.
            let ids = f.attachments.iter().map(|v| v["id"].as_str().map(str::to_string)
                .ok_or_else(|| ApiError::gone("추가 메시지 첨부 ID가 잘못되었습니다"))).collect::<ApiResult<Vec<_>>>()?;
            let session = crate::sessions::get_active(&tx, &f.session_id)?;
            let prepared = crate::attachments::prepare(&tx, &data, owner.strip_prefix("token:").unwrap_or(&owner),
                &session.project_id, &f.text, &ids)?;
            let turn = crate::runner::get_turn(&tx, &tid)?;
            crate::models::get_enabled_profile(&tx, turn.profile_id.as_deref().ok_or_else(|| ApiError::invalid("모델 프로필이 없습니다"))?)?
                .check_capabilities(false, None, prepared.model_input["images"].as_array().is_some_and(|v| !v.is_empty()))?;
            let mut messages = crate::runner::to_chat(&[("user".into(), json!({"text":f.text}), Some(prepared.model_input.clone()))]);
            crate::attachments::hydrate(&tx, &data, &session.project_id, &mut messages)?;
            let Some(ChatMsg::User { text, images }) = messages.pop() else { return Err(ApiError::internal("추가 메시지 입력 변환 실패")); };
            let scratch = tempfile::Builder::new().prefix("grove-steer-").tempdir()
                .map_err(|_| ApiError::internal("추가 메시지 임시 디렉터리 생성 실패"))?;
            let mut input = vec![json!({"type":"text","text":text})];
            let mut content = input.clone();
            use base64::Engine;
            for (i, image) in images.into_iter().enumerate() {
                content.push(json!({"type":"image","source":{"type":"base64","media_type":&image.mime,"data":&image.data}}));
                let bytes = base64::engine::general_purpose::STANDARD.decode(image.data)
                    .map_err(|_| ApiError::internal("추가 이미지 입력 형식 오류"))?;
                let path = scratch.path().join(format!("image-{i}.jpg"));
                std::fs::write(&path, bytes).map_err(|_| ApiError::internal("추가 이미지 임시 파일 생성 실패"))?;
                input.push(json!({"type":"localImage","path":path}));
            }
            tx.execute("UPDATE followups SET delivery_state='sending',delivery_turn_id=?2 WHERE id=?1", params![id, tid])?;
            emit(&tx, &now, &f.session_id)?;
            tx.commit()?;
            Ok(Some(Delivery { id, input, content, prepared, _scratch: scratch }))
        }).await?;
        self.app.notify_events().await;
        Ok(result)
    }

    pub async fn acknowledge(&self, delivery: Delivery, accepted: bool) -> ApiResult<tempfile::TempDir> {
        let Delivery { id, prepared, _scratch, .. } = delivery;
        let (tid, epoch) = (self.turn_id.clone(), self.epoch.clone());
        self.app.db.call(move |c| {
            let tx = c.transaction()?;
            let now = crate::util::fmt_time(time::OffsetDateTime::now_utc());
            let f = tx.query_row(
                &format!("SELECT {COLS} FROM followups WHERE id=?1 AND delivery_state='sending' AND delivery_turn_id=?2 \
                    AND EXISTS(SELECT 1 FROM turns WHERE id=?2 AND owner_epoch=?3 AND status='running')"),
                params![id, tid, epoch], row,
            ).optional()?.ok_or_else(|| ApiError::conflict("steer_delivery_changed", "합치기 전달 상태가 바뀌었습니다"))?;
            if accepted {
                append_steer(&tx, &now, &tid, &f, &prepared)?;
            } else {
                tx.execute("UPDATE followups SET delivery_state='rejected',last_error=?2 WHERE id=?1",
                    params![f.id, json!({"code":"steer_rejected","message":"Codex가 실행 중 합치기를 거절했습니다. 대화를 확인한 뒤 새 메시지로 보내세요."}).to_string()])?;
            }
            emit(&tx, &now, &f.session_id)?;
            tx.commit()?;
            Ok(())
        }).await?;
        self.app.notify_events().await;
        Ok(_scratch)
    }
}

pub(crate) fn on_turn_finished(c: &Connection, now: &str, turn_id: &str) -> ApiResult<()> {
    let count = c.execute(
        "UPDATE followups SET delivery_state='unknown',last_error=?2 WHERE delivery_turn_id=?1 AND delivery_state='sending'",
        params![turn_id, json!({"code":"steer_delivery_unknown","message":"합치기 전달 여부를 확인할 수 없어 자동으로 다시 보내지 않습니다. 대화를 확인한 뒤 삭제하거나 새 메시지로 보내세요."}).to_string()],
    )?;
    if count > 0 {
        let session: String = c.query_row("SELECT session_id FROM turns WHERE id=?1", [turn_id], |r| r.get(0))?;
        emit(c, now, &session)?;
    }
    Ok(())
}
