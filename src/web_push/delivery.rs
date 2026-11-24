use super::*;
use std::time::Duration;
use tokio::task::JoinHandle;

struct Job {
    endpoint: String,
    event: String,
    payload: String,
    public: Vec<u8>,
    auth: String,
    scope: String,
    server: String,
    vibrate: bool,
    attempts: i64,
}
enum Outcome {
    Sent,
    Gone,
    Failed(&'static str, Option<i64>),
}
pub fn spawn(app: App) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut shutdown = app.shutdown_rx.clone();
        let mut changes = app.seq_tx.subscribe();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .build();
        let Ok(client) = client else {
            return;
        };
        loop {
            if *shutdown.borrow() {
                break;
            }
            tokio::select! {
                _=shutdown.changed()=>break,
                result=deliver(&app,&client)=>{ if result.is_err() {tracing::warn!("Web Push delivery unavailable");} }
            }
            tokio::select! {
                _=shutdown.changed()=>break,
                _=changes.changed()=>{},
                _=tokio::time::sleep(Duration::from_secs(15))=>{}
            }
        }
    })
}
async fn deliver(app: &App, client: &reqwest::Client) -> ApiResult<()> {
    let now = app.now();
    let seconds = app.clock.now().unix_timestamp();
    let retention = crate::util::fmt_time(app.clock.now() - time::Duration::days(1));
    let jobs=app.db.call(move|c| {
        let tx = c.transaction()?;
        let c = &tx;
        // A browser login and its root device must both still be valid.
        let mut invalid=Vec::new();
        {
            let mut st=c.prepare("SELECT endpoint,token_id FROM web_push_subscriptions")?;
            for row in st.query_map([],|r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))? {
                let (endpoint,token)=row?;
                if auth::verify_row(c,&token,None,&now).is_err() { invalid.push(endpoint); }
            }
        }
        for endpoint in invalid {c.execute("DELETE FROM web_push_subscriptions WHERE endpoint=?1",[endpoint])?;}
        // 폐기된 실제 Push 시험의 기존 기록은 원래 보존 기간(1일)이 지나면 정리한다.
        c.execute("DELETE FROM web_push_tests WHERE created_at<?1",[retention])?;
        c.execute("DELETE FROM web_push_outbox WHERE created_at<?1 OR attempts>=6",[seconds-3600])?;
        let jobs = {
        let mut st=c.prepare("SELECT o.endpoint,o.event_key,grove_decrypt(o.payload),s.p256dh,grove_decrypt(s.auth),s.scope,s.server,s.vibrate,o.attempts FROM web_push_outbox o
            JOIN web_push_subscriptions s ON s.endpoint=o.endpoint WHERE next_attempt<=?1 ORDER BY created_at,event_key LIMIT 8")?;
        st.query_map([seconds],|r|Ok(Job {endpoint:r.get(0)?,event:r.get(1)?,payload:r.get(2)?,public:r.get(3)?,auth:r.get(4)?,scope:r.get(5)?,server:r.get(6)?,vibrate:r.get(7)?,attempts:r.get(8)?}))?.collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.commit()?;
        Ok(jobs)
    }).await?;
    if jobs.is_empty() {
        return Ok(());
    }
    let key = app.db.call(|c| key(c)).await?;
    for job in jobs {
        let endpoint = job.endpoint.clone();
        let now = app.now();
        let event = job.event.clone();
        let active=app.db.call(move|c| {
            let token:Option<String>=c.query_row("SELECT token_id FROM web_push_subscriptions WHERE endpoint=?1 AND EXISTS(SELECT 1 FROM web_push_outbox WHERE endpoint=?1 AND event_key=?2)",params![endpoint,event],|r|r.get(0)).optional()?;
            Ok(token.is_some_and(|t|auth::verify_row(c,&t,None,&now).is_ok()))
        }).await?;
        if !active {
            continue;
        }
        let result = send(client, &key, &job, app.clock.now().unix_timestamp()).await;
        let seconds = app.clock.now().unix_timestamp();
        app.db.call(move |c| record_outcome(c, &job, result, seconds)).await?;
    }
    Ok(())
}
fn record_outcome(c: &mut Connection, job: &Job, result: Outcome, seconds: i64) -> ApiResult<()> {
    let tx = c.transaction()?;
    match result {
        Outcome::Gone => {
            tx.execute("DELETE FROM web_push_subscriptions WHERE endpoint=?1", [&job.endpoint])?;
        }
        Outcome::Sent => {
            tx.execute("DELETE FROM web_push_outbox WHERE endpoint=?1 AND event_key=?2", params![job.endpoint, job.event])?;
            tx.execute("UPDATE web_push_subscriptions SET last_error=NULL WHERE endpoint=?1", [&job.endpoint])?;
        }
        Outcome::Failed(error, retry) => {
            tx.execute("UPDATE web_push_subscriptions SET last_error=?2 WHERE endpoint=?1", params![job.endpoint, error])?;
            if let Some(delay) = retry.filter(|_| job.attempts < 5) {
                tx.execute("UPDATE web_push_outbox SET attempts=attempts+1,next_attempt=?3 WHERE endpoint=?1 AND event_key=?2",
                    params![job.endpoint, job.event, seconds + delay])?;
            } else {
                tx.execute("DELETE FROM web_push_outbox WHERE endpoint=?1 AND event_key=?2", params![job.endpoint, job.event])?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}
async fn send(client: &reqwest::Client, key: &[u8], job: &Job, now: i64) -> Outcome {
    let Ok(url) = endpoint(&job.endpoint) else {
        return Outcome::Gone;
    };
    let Ok(authorization) =
        crypto::authorization(key, &url.origin().ascii_serialization(), &job.scope, now)
    else {
        return Outcome::Failed("push_key_unavailable", None);
    };
    let Ok(mut payload) = serde_json::from_str::<Value>(&job.payload) else {
        return Outcome::Failed("push_payload_invalid", None);
    };
    payload["server"] = json!(job.server);
    payload["scope"] = json!(job.scope);
    payload["vibrate"] = json!(job.vibrate);
    let Ok(secret) = crypto::decode(&job.auth) else {
        return Outcome::Gone;
    };
    let Ok(body) = crypto::encrypt(&job.public, &secret, payload.to_string().as_bytes()) else {
        return Outcome::Failed("push_encryption_failed", None);
    };
    let delay = (15 * 2i64.pow(job.attempts.min(6) as u32)).min(900);
    transport(client, url, &authorization, body, delay).await
}
async fn transport(
    client: &reqwest::Client,
    url: reqwest::Url,
    authorization: &str,
    body: Vec<u8>,
    delay: i64,
) -> Outcome {
    let response = match client
        .post(url)
        .header("Authorization", authorization)
        .header("TTL", "3600")
        .header("Urgency", "high")
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .body(body)
        .send()
        .await
    {
        Ok(value) => value,
        Err(_) => return Outcome::Failed("push_network_unavailable", Some(delay)),
    };
    match response.status().as_u16() {
        200..=299 => Outcome::Sent,
        404 | 410 => Outcome::Gone,
        429 | 500..=599 => Outcome::Failed(
            "push_service_unavailable",
            Some(
                response
                    .headers()
                    .get("retry-after")
                    .and_then(|h| h.to_str().ok())
                    .and_then(|s| s.parse::<i64>().ok())
                    .filter(|v| *v > 0)
                    .unwrap_or(delay)
                    .min(3600),
            ),
        ),
        _ => Outcome::Failed("push_service_denied", None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::Bytes,
        http::{HeaderMap, StatusCode},
        routing::post,
    };
    #[test]
    fn outcomes_keep_retryable_deliveries_and_record_the_last_error() {
        for (outcome, attempts, error, pending, subscribed) in [
            (Outcome::Sent, 0, None, false, true),
            (Outcome::Failed("push_network_unavailable", Some(15)), 0, Some("push_network_unavailable"), true, true),
            (Outcome::Failed("push_network_unavailable", Some(15)), 5, Some("push_network_unavailable"), false, true),
            (Outcome::Failed("push_service_denied", None), 0, Some("push_service_denied"), false, true),
            (Outcome::Gone, 0, None, false, false),
        ] {
            let mut c = Connection::open_in_memory().unwrap();
            c.execute_batch("PRAGMA foreign_keys=ON;
                CREATE TABLE web_push_subscriptions(endpoint TEXT PRIMARY KEY,last_error TEXT);
                CREATE TABLE web_push_outbox(endpoint TEXT REFERENCES web_push_subscriptions(endpoint) ON DELETE CASCADE,event_key TEXT,attempts INTEGER,next_attempt INTEGER);
                INSERT INTO web_push_subscriptions VALUES('fixture',NULL);
                INSERT INTO web_push_outbox VALUES('fixture','turn:t',0,0);").unwrap();
            let job = Job { endpoint: "fixture".into(), event: "turn:t".into(), payload: "{}".into(),
                public: vec![], auth: String::new(), scope: String::new(), server: String::new(), vibrate: true, attempts };
            record_outcome(&mut c, &job, outcome, 100).unwrap();
            let last: Option<Option<String>> = c.query_row("SELECT last_error FROM web_push_subscriptions", [], |r| r.get(0)).optional().unwrap();
            assert_eq!(last, subscribed.then(|| error.map(str::to_string)));
            assert_eq!(c.query_row("SELECT count(*) FROM web_push_outbox", [], |r| r.get::<_, i64>(0)).unwrap(), i64::from(pending));
        }
    }
    #[tokio::test]
    async fn transport_posts_encrypted_content_and_classifies_expiry_retry_and_denial_without_following_redirects()
     {
        let app = Router::new().route(
            "/push/{code}",
            post(
                |axum::extract::Path(code): axum::extract::Path<u16>,
                 headers: HeaderMap,
                 body: Bytes| async move {
                    assert_eq!(headers["content-encoding"], "aes128gcm");
                    assert_eq!(headers["ttl"], "3600");
                    assert_eq!(headers["urgency"], "high");
                    assert_eq!(
                        headers["authorization"],
                        "vapid t=isolated-test-token, k=isolated-test-key"
                    );
                    assert_eq!(body.as_ref(), b"isolated encrypted record");
                    (
                        StatusCode::from_u16(code).unwrap(),
                        [
                            ("retry-after", "99999"),
                            ("location", "http://127.0.0.1:1/never-follow"),
                        ],
                    )
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        for code in [201, 410, 404, 429, 503, 403, 302] {
            let result = transport(
                &client,
                reqwest::Url::parse(&format!("{base}/push/{code}")).unwrap(),
                "vapid t=isolated-test-token, k=isolated-test-key",
                b"isolated encrypted record".to_vec(),
                15,
            )
            .await;
            match code {
                201 => assert!(matches!(result, Outcome::Sent)),
                404 | 410 => assert!(matches!(result, Outcome::Gone)),
                429 | 503 => assert!(matches!(
                    result,
                    Outcome::Failed("push_service_unavailable", Some(3600))
                )),
                _ => assert!(matches!(
                    result,
                    Outcome::Failed("push_service_denied", None)
                )),
            }
        }
        server.abort();
        let _ = server.await;
    }
}
