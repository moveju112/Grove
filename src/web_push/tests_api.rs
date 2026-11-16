use super::*;
use axum::extract::Path;

#[derive(Serialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum PushTestState {
    Queued,
    Sent,
    Failed,
}

#[derive(Serialize, ts_rs::TS)]
pub struct PushTest {
    pub id: String,
    pub state: PushTestState,
    pub error: Option<String>,
    pub created_at: String,
    pub scheduled_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TestRequest {
    endpoint: String,
    delay_seconds: i64,
}

pub async fn create(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Json(input): Json<TestRequest>,
) -> ApiResult<Response> {
    endpoint(&input.endpoint)?;
    if !matches!(input.delay_seconds, 0 | 10) {
        return Err(ApiError::invalid("시험 지연은 0초 또는 10초여야 합니다"));
    }
    let hash = crate::idem::body_hash(
        "web_push.test",
        &json!({"request": input, "token_id": p.token_id}),
    );
    let scheduled = app.clock.now() + time::Duration::seconds(input.delay_seconds);
    let principal = p.clone();
    crate::idem::run(&app, &p, &headers, &hash, move |tx, now| {
        auth::check_principal(tx, &principal, now)?;
        let owned: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM web_push_subscriptions WHERE endpoint=?1 AND root_id=?2 AND token_id=?3)",
            params![input.endpoint, principal.root_id, principal.token_id], |r| r.get(0),
        )?;
        if !owned {
            return Err(ApiError::not_found("이 로그인에 등록된 Push 구독이 없습니다. 완료 알림을 껐다 켜주세요"));
        }
        let recent: i64 = tx.query_row(
            "SELECT count(*) FROM web_push_tests WHERE endpoint=?1 AND created_at>=?2",
            params![input.endpoint, crate::util::fmt_time(scheduled - time::Duration::seconds(input.delay_seconds + 60))],
            |r| r.get(0),
        )?;
        if recent >= 6 {
            return Err(ApiError::conflict("push_test_rate_limit", "Push 시험은 1분에 6번까지 보낼 수 있습니다"));
        }
        let id = crate::util::new_id();
        let payload = json!({"test":true, "testId":id, "tag":format!("test:{id}")});
        let scheduled_at = crate::util::fmt_time(scheduled);
        tx.execute(
            "INSERT INTO web_push_tests(id,root_id,token_id,endpoint,state,created_at,scheduled_at) VALUES(?1,?2,?3,?4,'queued',?5,?6)",
            params![id, principal.root_id, principal.token_id, input.endpoint, now, scheduled_at],
        )?;
        tx.execute(
            "INSERT INTO web_push_outbox(endpoint,event_key,payload,created_at,next_attempt) VALUES(?1,?2,?3,?4,?5)",
            params![input.endpoint, format!("test:{id}"), payload.to_string(),
                scheduled.unix_timestamp() - input.delay_seconds, scheduled.unix_timestamp()],
        )?;
        Ok((StatusCode::ACCEPTED, serde_json::to_value(PushTest {
            id, state: PushTestState::Queued, error: None, created_at: now.to_string(), scheduled_at,
        })?))
    }).await
}

pub async fn show(
    State(app): State<App>,
    p: Principal,
    Path(id): Path<String>,
) -> ApiResult<Json<PushTest>> {
    app.db.call(move |c| {
        let row = c.query_row(
            "SELECT id,state,error,created_at,scheduled_at FROM web_push_tests WHERE id=?1 AND root_id=?2 AND token_id=?3",
            params![id, p.root_id, p.token_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        ).optional()?.ok_or_else(|| ApiError::not_found("Push 시험 기록을 찾을 수 없습니다"))?;
        let state = match row.1.as_str() {
            "queued" => PushTestState::Queued,
            "sent" => PushTestState::Sent,
            _ => PushTestState::Failed,
        };
        Ok(Json(PushTest { id: row.0, state, error: row.2, created_at: row.3, scheduled_at: row.4 }))
    }).await
}
