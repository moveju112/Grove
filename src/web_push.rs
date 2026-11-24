//! Authenticated browser subscriptions and durable, private completion notifications.
mod crypto;
mod delivery;
use crate::{
    App,
    auth::{self, Principal},
    error::{ApiError, ApiResult},
};
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
pub use delivery::spawn;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Serialize, ts_rs::TS)]
pub struct PushSubscription {
    pub endpoint: String,
    pub revision: i64,
    pub last_error: Option<String>,
}
#[derive(Serialize, ts_rs::TS)]
pub struct PushConfig {
    pub public_key: String,
    pub subscriptions: Vec<PushSubscription>,
}
fn bad() -> ApiError {
    ApiError::invalid("Push 구독 정보가 올바르지 않습니다")
}
fn crypto_error() -> ApiError {
    ApiError::internal("Web Push cryptography unavailable")
}
fn endpoint(value: &str) -> ApiResult<reqwest::Url> {
    if value.len() > 4096 || value.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(bad());
    }
    let url = reqwest::Url::parse(value).map_err(|_| bad())?;
    let host = url.host_str().ok_or_else(bad)?;
    let allowed = matches!(
        host,
        "fcm.googleapis.com" | "android.googleapis.com" | "updates.push.services.mozilla.com"
    ) || host.ends_with(".push.apple.com")
        || host.ends_with(".notify.windows.com");
    if !allowed
        || url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.path() == "/"
    {
        return Err(bad());
    }
    Ok(url)
}
fn key(c: &Connection) -> ApiResult<Vec<u8>> {
    let existing: Option<String> = c
        .query_row(
            "SELECT grove_decrypt(pkcs8) FROM web_push_key WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(value) = existing {
        return crypto::decode(&value).map_err(|_| crypto_error());
    }
    let key = crypto::key().map_err(|_| crypto_error())?;
    c.execute(
        "INSERT INTO web_push_key VALUES (1,grove_encrypt(?1))",
        [crypto::encode(&key)],
    )?;
    Ok(key)
}
pub async fn configuration(State(app): State<App>, p: Principal) -> ApiResult<Json<PushConfig>> {
    app.db
        .call(move |c| {
            let public_key = crypto::public(&key(c)?).map_err(|_| crypto_error())?;
            let mut st = c.prepare(
                "SELECT endpoint,revision,last_error FROM web_push_subscriptions WHERE root_id=?1",
            )?;
            let subscriptions = st
                .query_map(params![p.root_id], |r| {
                    Ok(PushSubscription {
                        endpoint: r.get(0)?,
                        revision: r.get(1)?,
                        last_error: r.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(Json(PushConfig {
                public_key,
                subscriptions,
            }))
        })
        .await
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Keys {
    p256dh: String,
    auth: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Subscribe {
    endpoint: String,
    keys: Keys,
    scope: String,
    server: String,
    vibrate: bool,
    expected_revision: i64,
}
pub async fn subscribe(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Json(input): Json<Subscribe>,
) -> ApiResult<Response> {
    endpoint(&input.endpoint)?;
    let public = crypto::decode(&input.keys.p256dh).map_err(|_| bad())?;
    let secret = crypto::decode(&input.keys.auth).map_err(|_| bad())?;
    if public.len() != 65 || secret.len() != 16 || crypto::validate_public(&public).is_err() {
        return Err(bad());
    }
    let scope = reqwest::Url::parse(&input.scope).map_err(|_| bad())?;
    if input.scope.len() > 2048
        || !(scope.scheme() == "https"
            || (scope.scheme() == "http"
                && matches!(scope.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
        || !scope.username().is_empty()
        || scope.password().is_some()
        || scope.query().is_some()
        || scope.fragment().is_some()
        || !scope.path().ends_with('/')
        || input.server.len() != 64
        || !input.server.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(bad());
    }
    let hash = crate::idem::body_hash("web_push.subscribe", &serde_json::to_value(&input)?);
    let principal = p.clone();
    crate::idem::run(&app,&p,&headers,&hash,move|tx,now| {
        auth::check_principal(tx,&principal,now)?;
        let prior:Option<(String,i64)>=tx.query_row("SELECT root_id,revision FROM web_push_subscriptions WHERE endpoint=?1",[&input.endpoint],|r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        if prior.as_ref().is_some_and(|v|v.0!=principal.root_id) {return Err(ApiError::conflict("push_subscription_in_use","다른 기기의 구독입니다"));}
        let revision=prior.as_ref().map_or(0,|v|v.1);
        if revision!=input.expected_revision {return Err(ApiError::revision_conflict(json!({"revision":revision})));}
        let count:i64=tx.query_row("SELECT count(*) FROM web_push_subscriptions WHERE root_id=?1",[&principal.root_id],|r|r.get(0))?;
        if prior.is_none() && count>=32 {return Err(ApiError::conflict("push_subscription_limit","기기당 구독 한도를 초과했습니다"));}
        // Rebinding after login must never deliver a previous login's queued work.
        tx.execute("DELETE FROM web_push_outbox WHERE endpoint=?1 AND EXISTS(SELECT 1 FROM web_push_subscriptions s WHERE s.endpoint=?1 AND s.token_id!=?2)",params![input.endpoint,principal.token_id])?;
        tx.execute("INSERT INTO web_push_subscriptions(endpoint,root_id,token_id,p256dh,auth,scope,server,vibrate) VALUES (?1,?2,?3,?4,grove_encrypt(?5),?6,?7,?8)
            ON CONFLICT(endpoint) DO UPDATE SET token_id=excluded.token_id,p256dh=excluded.p256dh,auth=excluded.auth,scope=excluded.scope,server=excluded.server,vibrate=excluded.vibrate,revision=revision+1,last_error=NULL",
            params![input.endpoint,principal.root_id,principal.token_id,public,input.keys.auth,input.scope,input.server,input.vibrate])?;
        Ok((StatusCode::OK,json!({"revision":revision+1})))
    }).await
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Unsubscribe {
    endpoint: String,
}
pub async fn unsubscribe(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Query(input): Query<Unsubscribe>,
) -> ApiResult<Response> {
    endpoint(&input.endpoint)?;
    let hash = crate::idem::body_hash("web_push.unsubscribe", &json!({"endpoint":input.endpoint}));
    let root = p.root_id.clone();
    crate::idem::run(&app, &p, &headers, &hash, move |tx, _| {
        tx.execute(
            "DELETE FROM web_push_subscriptions WHERE endpoint=?1 AND root_id=?2",
            params![input.endpoint, root],
        )?;
        Ok((StatusCode::OK, json!({"enabled":false})))
    })
    .await
}
pub(crate) fn enqueue(
    c: &Connection,
    now: &str,
    kind: &str,
    project: Option<&str>,
    session: Option<&str>,
    payload: &Value,
) -> ApiResult<()> {
    if kind != "turn.updated" {
        return Ok(());
    }
    let Some(turn) = payload.get("id").and_then(Value::as_str) else {
        return Ok(());
    };
    let Some(status) = payload.get("status").and_then(Value::as_str) else {
        return Ok(());
    };
    if !matches!(status, "completed" | "failed" | "interrupted") {
        return Ok(());
    }
    let seconds = crate::util::parse_time(now)
        .map(|v| v.unix_timestamp())
        .unwrap_or(0);
    let mut data = json!({"projectId":project,"sessionId":session,"tag":format!("turn:{turn}"),"failed":status!="completed"});
    if status == "completed" && let Some(preview) = payload["completion_preview"].as_str() {
        data["body"] = json!(preview);
    }
    c.execute("INSERT OR IGNORE INTO web_push_outbox(endpoint,event_key,payload,created_at,next_attempt)
        SELECT endpoint,?1,grove_encrypt(?2),?3,?3 FROM web_push_subscriptions s
        WHERE NOT EXISTS(SELECT 1 FROM agent_runs WHERE child_session_id=?4)
        AND NOT EXISTS(SELECT 1 FROM web_push_receipts r WHERE r.endpoint=s.endpoint AND r.turn_id=?5)",params![format!("turn:{turn}"),data.to_string(),seconds,session,turn])?;
    c.execute("INSERT OR IGNORE INTO web_push_receipts(endpoint,turn_id)
        SELECT endpoint,?1 FROM web_push_subscriptions WHERE NOT EXISTS(SELECT 1 FROM agent_runs WHERE child_session_id=?2)",params![turn,session])?;
    Ok(())
}
