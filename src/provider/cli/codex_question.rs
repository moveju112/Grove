//! Route Codex user-input requests through the existing revisioned question API.
use crate::{
    App, approvals,
    error::{ApiError, ApiResult},
};
use futures_util::{
    StreamExt,
    future::{AbortHandle, Abortable, BoxFuture},
    stream::FuturesUnordered,
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[derive(Clone)]
pub(crate) struct Handle {
    app: App,
    turn: String,
}

#[derive(Clone)]
struct Pending {
    app: App,
    calls: Vec<(String, String)>,
    events: tokio::sync::watch::Receiver<i64>,
}

type Answer = (String, Value, ApiResult<Map<String, Value>>);

#[derive(Default)]
pub(super) struct Queue {
    pending: HashMap<String, (Pending, AbortHandle)>,
    answers: FuturesUnordered<BoxFuture<'static, Option<Answer>>>,
    pub(super) count: Arc<AtomicUsize>,
}

impl Queue {
    pub(super) async fn open(
        &mut self,
        handle: &Handle,
        id: &Value,
        body: &Value,
    ) -> ApiResult<()> {
        let key = id.to_string();
        if self.pending.contains_key(&key) {
            return Ok(());
        }
        if self.pending.len() >= 8 {
            return Err(ApiError::invalid(
                "동시에 열 수 있는 Codex 질문 수를 넘었습니다",
            ));
        }
        let pending = handle.open(id, body).await?;
        let (abort, registration) = AbortHandle::new_pair();
        self.pending.insert(key.clone(), (pending.clone(), abort));
        self.count.store(self.pending.len(), Ordering::Release);
        let id = id.clone();
        self.answers.push(Box::pin(async move {
            Abortable::new(pending.answers(), registration)
                .await
                .ok()
                .map(|answer| (key, id, answer))
        }));
        Ok(())
    }

    pub(super) async fn next(&mut self) -> (Value, ApiResult<Map<String, Value>>, Vec<String>) {
        while let Some(answer) = self.answers.next().await {
            if let Some((key, id, answer)) = answer {
                let Some((pending, _)) = self.pending.remove(&key) else {
                    continue;
                };
                self.count.store(self.pending.len(), Ordering::Release);
                return (
                    id,
                    answer,
                    pending.calls.into_iter().map(|(_, call)| call).collect(),
                );
            }
        }
        std::future::pending().await
    }

    pub(super) async fn resolve(&mut self, id: &Value) -> ApiResult<()> {
        if let Some((pending, abort)) = self.pending.remove(&id.to_string()) {
            abort.abort();
            self.count.store(self.pending.len(), Ordering::Release);
            pending.cancel().await?;
        }
        Ok(())
    }
}

impl std::fmt::Debug for Handle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CodexQuestions(<turn-scoped>)")
    }
}

fn questions(request: &Value, body: &Value) -> ApiResult<Vec<(String, Value)>> {
    let bad = || ApiError::invalid("Codex 질문 형식을 지원하지 않습니다");
    if !(request.is_i64()
        || request
            .as_str()
            .is_some_and(|id| !id.is_empty() && id.len() <= 128))
    {
        return Err(bad());
    }
    let items = body["questions"]
        .as_array()
        .filter(|q| (1..=12).contains(&q.len()))
        .ok_or_else(bad)?;
    let mut ids = HashSet::new();
    items
        .iter()
        .map(|q| {
            let id = q["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 128)
                .ok_or_else(bad)?;
            if q["isSecret"] == true || !ids.insert(id) {
                return Err(bad());
            }
            let options = q["options"].as_array().filter(|o| !o.is_empty());
            if options.is_some_and(|o| o.len() > 12) {
                return Err(bad());
            }
            Ok((
                id.to_owned(),
                json!({
                    "question": q["question"], "options": options,
                    "allow_free_text": options.is_none() || q["isOther"] == true,
                }),
            ))
        })
        .collect()
}

impl Handle {
    pub(crate) fn new(app: &App, turn: &str) -> Self {
        Self {
            app: app.clone(),
            turn: turn.to_owned(),
        }
    }

    async fn open(&self, request: &Value, body: &Value) -> ApiResult<Pending> {
        let items = questions(request, body)?;
        let events = self.app.seq_tx.subscribe();
        let (turn, epoch, now) = (self.turn.clone(), self.app.epoch.clone(), self.app.now());
        let request = request.to_string();
        let calls =
            self.app
                .db
                .call(move |c| {
                    let tx = c.transaction()?;
                    let t = crate::runner::get_turn(&tx, &turn)?;
                    let owner: String =
                        tx.query_row("SELECT owner_epoch FROM turns WHERE id=?1", [&turn], |r| {
                            r.get(0)
                        })?;
                    if t.status != "running"
                        || !t.error.is_null()
                        || owner != epoch
                        || t.definition["limits"].is_object()
                    {
                        return Err(ApiError::conflict("turn_ended", "실행 중인 턴이 아닙니다"));
                    }
                    crate::continuations::check_permission(&tx, &t, "ask_user")?;
                    let s = crate::sessions::get_active(&tx, &t.session_id)?;
                    let root = crate::sessions::exec_root(&tx, &s.id)?;
                    let mut calls = Vec::with_capacity(items.len());
                    for (key, args) in items {
                        let provider_id = format!(
                            "codex-question:{}",
                            crate::util::sha256_hex(json!([request, key]).to_string().as_bytes())
                        );
                        let existing: Option<String> = tx.query_row(
                    "SELECT id FROM tool_calls WHERE turn_id=?1 AND provider_call_id=?2",
                    params![turn, provider_id], |r| r.get(0),
                ).optional()?;
                        let call = match existing {
                            Some(id) => approvals::get(&tx, &id)?,
                            None => approvals::create_call(
                                &tx,
                                &now,
                                0,
                                &s.id,
                                &s.project_id,
                                &root,
                                Some(&turn),
                                Some(&provider_id),
                                "ask_user",
                                &args,
                            )?,
                        };
                        if call.args != args || call.status == "failed" {
                            return Err(ApiError::invalid("Codex 질문 형식을 지원하지 않습니다"));
                        }
                        calls.push((key, call.id));
                    }
                    tx.commit()?;
                    Ok(calls)
                })
                .await?;
        self.app.notify_events().await;
        Ok(Pending {
            app: self.app.clone(),
            calls,
            events,
        })
    }
}

impl Pending {
    async fn answers(mut self) -> ApiResult<Map<String, Value>> {
        loop {
            let calls = self.calls.clone();
            if let Some(answers) = self
                .app
                .db
                .call(move |c| {
                    let mut answers = Map::new();
                    for (key, id) in calls {
                        let call = approvals::get(c, &id)?;
                        if call.status == "awaiting_input" {
                            return Ok(None);
                        }
                        let mut values = Vec::new();
                        if call.status == "succeeded" {
                            values.extend(
                                call.result["choices"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .cloned(),
                            );
                            values.extend(call.result["text"].as_str().map(|s| json!(s)));
                        }
                        answers.insert(key, json!({"answers": values}));
                    }
                    Ok(Some(answers))
                })
                .await?
            {
                return Ok(answers);
            }
            self.events
                .changed()
                .await
                .map_err(|_| ApiError::conflict("turn_ended", "질문 연결이 종료됐습니다"))?;
        }
    }

    async fn cancel(self) -> ApiResult<()> {
        let now = self.app.now();
        self.app
            .db
            .call(move |c| {
                let tx = c.transaction()?;
                for (_, id) in self.calls {
                    approvals::finish(
                        &tx,
                        &now,
                        &id,
                        &["awaiting_input"],
                        "cancelled",
                        Some(json!({
                            "code": "question_closed", "message": "Codex에서 질문을 닫았습니다",
                        })),
                    )?;
                }
                tx.commit()?;
                Ok(())
            })
            .await?;
        self.app.notify_events().await;
        Ok(())
    }
}
