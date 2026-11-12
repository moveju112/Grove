//! MCP 등록 설정. 저장·활성 상태는 연결/handshake 상태와 다르다.
//! 자격증명은 기존 vault의 secret ID로만 지정하고 원문 환경변수·헤더는 받지 않는다.

use crate::App;
use crate::auth::Owner;
use crate::error::{ApiError, ApiResult};
use crate::{events, idem};
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

mod client;

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "transport", rename_all = "snake_case", deny_unknown_fields)]
pub enum ServerConfig {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env_secrets: BTreeMap<String, String>,
    },
    Http {
        endpoint: String,
        #[serde(default)]
        header_secrets: BTreeMap<String, String>,
    },
    Sse {
        endpoint: String,
        #[serde(default)]
        header_secrets: BTreeMap<String, String>,
    },
}

impl ServerConfig {
    fn normalize(&mut self) -> ApiResult<()> {
        let refs = match self {
            Self::Stdio { command, args, env_secrets } => {
                *command = command.trim().to_string();
                if command.is_empty() || command.len() > 4096 || command.chars().any(char::is_control) {
                    return Err(ApiError::invalid("MCP 실행 파일은 1~4096바이트이며 제어 문자를 포함할 수 없습니다"));
                }
                if args.len() > 128 || args.iter().any(|a| a.len() > 8192 || a.contains('\0')) {
                    return Err(ApiError::invalid("MCP 인자는 128개 이하, 각각 8192바이트 이하이며 NUL을 포함할 수 없습니다"));
                }
                for name in env_secrets.keys() {
                    if name.is_empty() || name.len() > 128
                        || !name.bytes().enumerate().all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
                    {
                        return Err(ApiError::invalid("MCP 환경변수 이름이 올바르지 않습니다"));
                    }
                }
                env_secrets
            }
            Self::Http { endpoint, header_secrets } | Self::Sse { endpoint, header_secrets } => {
                let url = reqwest::Url::parse(endpoint.trim()).map_err(|_| ApiError::invalid("MCP endpoint URL이 올바르지 않습니다"))?;
                if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.username().is_empty()
                    || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || endpoint.len() > 4096
                {
                    return Err(ApiError::invalid("MCP endpoint는 자격증명·query·fragment 없는 HTTP(S) URL이어야 합니다. 인증은 secret 헤더 참조를 사용하세요"));
                }
                *endpoint = url.to_string();
                let mut normalized = BTreeMap::new();
                for (name, id) in header_secrets.iter() {
                    let header = axum::http::HeaderName::from_bytes(name.as_bytes())
                        .map_err(|_| ApiError::invalid("MCP 헤더 이름이 올바르지 않습니다"))?;
                    let name = header.as_str();
                    if matches!(name, "host" | "content-length" | "content-type" | "accept" | "connection" | "transfer-encoding"
                        | "upgrade" | "cookie" | "set-cookie" | "mcp-session-id" | "mcp-protocol-version")
                        || normalized.insert(name.to_string(), id.clone()).is_some()
                    {
                        return Err(ApiError::invalid("MCP 예약 헤더 또는 대소문자가 겹치는 헤더를 지정할 수 없습니다"));
                    }
                }
                *header_secrets = normalized;
                header_secrets
            }
        };
        if refs.len() > 32 {
            return Err(ApiError::invalid("MCP secret 참조는 32개 이하여야 합니다"));
        }
        for id in refs.values() {
            if id.is_empty() || id.len() > 128 {
                return Err(ApiError::invalid("MCP secret 참조 ID가 올바르지 않습니다"));
            }
        }
        if serde_json::to_vec(self)?.len() > 65536 {
            return Err(ApiError::invalid("MCP 설정은 64KiB 이하여야 합니다"));
        }
        Ok(())
    }
}

#[derive(Serialize)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub config: ServerConfig,
    pub enabled: bool,
    pub timeout_secs: i64,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    pub connection_state: &'static str,
    pub last_check: Option<Value>,
}

pub fn get(c: &Connection, id: &str) -> ApiResult<McpServer> {
    let row = c.query_row(
        "SELECT id,name,config,enabled,timeout_secs,revision,created_at,updated_at FROM mcp_servers WHERE id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, String>(2)?, r.get::<_, bool>(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
    ).optional()?.ok_or_else(|| ApiError::not_found("MCP 서버가 없습니다"))?;
    Ok(McpServer {
        id: row.0, name: row.1, config: serde_json::from_str(&row.2)?, enabled: row.3, timeout_secs: row.4,
        revision: row.5, created_at: row.6, updated_at: row.7,
        connection_state: if row.3 { "disconnected" } else { "disabled" },
        last_check: check_summary(c, id)?,
    })
}

pub async fn list(State(app): State<App>, Owner(_p): Owner) -> ApiResult<Json<Vec<McpServer>>> {
    Ok(Json(app.db.call(|c| {
        let mut st = c.prepare("SELECT id FROM mcp_servers ORDER BY name,id")?;
        let ids = st.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        ids.iter().map(|id| get(c, id)).collect()
    }).await?))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SaveServer {
    pub name: String,
    pub config: ServerConfig,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_timeout")]
    pub timeout_secs: i64,
}

fn default_timeout() -> i64 { 60 }

impl SaveServer {
    fn normalize(&mut self) -> ApiResult<()> {
        self.name = self.name.trim().to_ascii_lowercase();
        if self.name.is_empty() || self.name.len() > 64
            || !self.name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
            || matches!(self.name.as_str(), "__proto__" | "constructor" | "prototype")
        {
            return Err(ApiError::invalid("MCP 이름은 영문·숫자·._-로 된 1~64자여야 하며 예약 이름은 사용할 수 없습니다"));
        }
        if !(1..=300).contains(&self.timeout_secs) {
            return Err(ApiError::invalid("MCP timeout은 1~300초여야 합니다"));
        }
        self.config.normalize()
    }

    fn validate(&self, c: &Connection, except: Option<&str>) -> ApiResult<()> {
        let taken: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM mcp_servers WHERE name=?1 AND (?2 IS NULL OR id<>?2))",
            params![self.name, except], |r| r.get(0),
        )?;
        if taken { return Err(ApiError::conflict("mcp_name_taken", "같은 이름의 MCP 서버가 있습니다")); }
        let refs = match &self.config {
            ServerConfig::Stdio { env_secrets, .. } => env_secrets,
            ServerConfig::Http { header_secrets, .. } | ServerConfig::Sse { header_secrets, .. } => header_secrets,
        };
        for id in refs.values() {
            let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM secrets WHERE id=?1)", [id], |r| r.get(0))?;
            if !exists { return Err(ApiError::invalid("MCP가 참조하는 secret이 없습니다")); }
        }
        Ok(())
    }
}

fn emit(c: &Connection, now: &str, id: &str) -> ApiResult<Value> {
    let v = serde_json::to_value(get(c, id)?)?;
    // 설정 인자·endpoint는 전역 이벤트·감사 로그에 복제하지 않는다.
    events::append(c, now, "mcp.changed", None, None, &json!({ "id": id }))?;
    Ok(v)
}

pub async fn create(State(app): State<App>, Owner(p): Owner, headers: HeaderMap, Json(mut b): Json<SaveServer>) -> ApiResult<Response> {
    b.normalize()?;
    let h = idem::body_hash("mcp.create", &serde_json::to_value(&b)?);
    let actor = p.clone();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let n: i64 = tx.query_row("SELECT COUNT(*) FROM mcp_servers", [], |r| r.get(0))?;
        if n >= 100 { return Err(ApiError::conflict("limit", "MCP 서버는 100개까지 등록할 수 있습니다")); }
        b.validate(tx, None)?;
        let id = crate::util::new_id();
        tx.execute(
            "INSERT INTO mcp_servers(id,name,config,enabled,timeout_secs,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)",
            params![id,b.name,serde_json::to_string(&b.config)?,b.enabled,b.timeout_secs,now],
        )?;
        crate::audit::record(tx, now, &actor, "mcp.created", &id, json!({}))?;
        Ok((StatusCode::CREATED, emit(tx, now, &id)?))
    }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateServer {
    pub expected_revision: i64,
    pub server: SaveServer,
}

pub async fn update(State(app): State<App>, Owner(p): Owner, headers: HeaderMap, Path(id): Path<String>, Json(mut b): Json<UpdateServer>) -> ApiResult<Response> {
    b.server.normalize()?;
    let h = idem::body_hash("mcp.update", &json!({ "id": id, "rev": b.expected_revision, "server": b.server }));
    let actor = p.clone();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let current = get(tx, &id)?;
        if current.revision != b.expected_revision {
            return Err(ApiError::revision_conflict(serde_json::to_value(current)?));
        }
        ensure_not_checking(tx, &id)?;
        b.server.validate(tx, Some(&id))?;
        tx.execute("DELETE FROM mcp_checks WHERE server_id=?1", [&id])?;
        tx.execute(
            "UPDATE mcp_servers SET name=?2,config=?3,enabled=?4,timeout_secs=?5,revision=revision+1,updated_at=?6 WHERE id=?1",
            params![id,b.server.name,serde_json::to_string(&b.server.config)?,b.server.enabled,b.server.timeout_secs,now],
        )?;
        crate::audit::record(tx, now, &actor, "mcp.updated", &id, json!({}))?;
        Ok((StatusCode::OK, emit(tx, now, &id)?))
    }).await
}

#[derive(Deserialize)]
pub struct DeleteServer { pub expected_revision: i64 }

pub async fn remove(State(app): State<App>, Owner(p): Owner, headers: HeaderMap, Path(id): Path<String>, Query(q): Query<DeleteServer>) -> ApiResult<Response> {
    let h = idem::body_hash("mcp.delete", &json!({ "id": id, "rev": q.expected_revision }));
    let actor = p.clone();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let current = get(tx, &id)?;
        if current.revision != q.expected_revision { return Err(ApiError::revision_conflict(serde_json::to_value(current)?)); }
        ensure_not_checking(tx, &id)?;
        tx.execute("DELETE FROM mcp_servers WHERE id=?1", [&id])?;
        events::append(tx, now, "mcp.changed", None, None, &json!({ "id": id, "deleted": true }))?;
        crate::audit::record(tx, now, &actor, "mcp.deleted", &id, json!({}))?;
        Ok((StatusCode::OK, json!({ "id": id, "deleted": true })))
    }).await
}

/// vault 목록과 삭제 보호. 비활성 설정도 참조를 유지한다.
pub fn secret_users(c: &Connection, secret_id: &str) -> ApiResult<Vec<String>> {
    let mut st = c.prepare(
        "SELECT DISTINCT 'MCP: '||m.name FROM mcp_servers m, json_each(m.config, '$.env_secrets') e WHERE e.value=?1
         UNION SELECT DISTINCT 'MCP: '||m.name FROM mcp_servers m, json_each(m.config, '$.header_secrets') h WHERE h.value=?1 ORDER BY 1",
    )?;
    Ok(st.query_map([secret_id], |r| r.get(0))?.collect::<Result<Vec<_>, _>>()?)
}

fn check_summary(c: &Connection, id: &str) -> ApiResult<Option<Value>> {
    let row: Option<(String, String, String, Option<String>, String)> = c.query_row(
        "SELECT id,status,started_at,finished_at,detail FROM mcp_checks WHERE server_id=?1", [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    ).optional()?;
    row.map(|(id,status,started,finished,detail)| {
        let detail: Value = serde_json::from_str(&detail)?;
        Ok(json!({ "id": id, "status": status, "started_at": started, "finished_at": finished,
            "protocol_version": detail.get("protocol_version"), "tool_count": detail.get("tool_count"), "error": detail.get("error") }))
    }).transpose()
}

fn ensure_not_checking(c: &Connection, id: &str) -> ApiResult<()> {
    let busy: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM mcp_checks WHERE server_id=?1 AND status='checking')", [id], |r| r.get(0))?;
    if busy { Err(ApiError::busy("MCP 연결 확인 중입니다. 확인이 끝난 뒤 설정을 바꾸세요")) } else { Ok(()) }
}

pub async fn check_result(State(app): State<App>, Owner(_p): Owner, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(app.db.call(move |c| {
        get(c, &id)?;
        let row: Option<(String, String)> = c.query_row("SELECT status,detail FROM mcp_checks WHERE server_id=?1", [&id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((status,detail)) = row else { return Ok(json!({ "status": "not_checked" })); };
        Ok(json!({ "status": status, "detail": serde_json::from_str::<Value>(&detail)? }))
    }).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckRequest {
    pub expected_revision: i64,
    pub confirmed: bool,
}

/// 프로세스·네트워크 부작용 전에 결과 불명 receipt를 접수한다. 같은 키는 절대 다시 연결하지 않는다.
pub async fn check(State(app): State<App>, Owner(p): Owner, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<CheckRequest>) -> ApiResult<Response> {
    if !b.confirmed { return Err(ApiError::invalid("MCP 프로세스 실행 또는 외부 연결을 명시적으로 확인하세요")); }
    let h = idem::body_hash("mcp.check", &json!({ "id": id, "revision": b.expected_revision }));
    let hash = h.clone();
    let key = idem::key_from(&headers)?;
    let owner = p.root_id.clone();
    let check_id = crate::util::new_id();
    let (sid,cid) = (id.clone(),check_id.clone());
    let actor = p.clone();
    let receipt = idem::run(&app, &p, &headers, &h, move |tx, now| {
        let server = get(tx, &sid)?;
        if server.revision != b.expected_revision { return Err(ApiError::revision_conflict(serde_json::to_value(server)?)); }
        ensure_not_checking(tx, &sid)?;
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM mcp_checks WHERE status='checking'", [], |r| r.get(0))?;
        if count >= 4 { return Err(ApiError::busy("MCP 연결 확인은 동시에 4개까지 실행할 수 있습니다")); }
        tx.execute(
            "INSERT INTO mcp_checks(server_id,id,status,started_at,owner_id,idem_key,request_hash) VALUES(?1,?2,'checking',?3,?4,?5,?6)
             ON CONFLICT(server_id) DO UPDATE SET id=excluded.id,status='checking',started_at=excluded.started_at,finished_at=NULL,detail='{}',
             owner_id=excluded.owner_id,idem_key=excluded.idem_key,request_hash=excluded.request_hash",
            params![sid,cid,now,owner,key,hash],
        )?;
        events::append(tx, now, "mcp.changed", None, None, &json!({ "id": sid }))?;
        crate::audit::record(tx, now, &actor, "mcp.check_started", &sid, json!({ "check_id": cid }))?;
        Ok((StatusCode::CONFLICT, json!({
            "error": { "code": "result_unknown", "message": "MCP 연결 확인 결과가 아직 확정되지 않았습니다", "retryable": true },
            "check_id": cid,
        })))
    }).await?;
    if receipt.headers().contains_key("idempotent-replayed") { return Ok(receipt); }
    let sid = id.clone();
    let loaded = app.db.call(move |c| {
        let server = get(c, &sid)?;
        let refs = match &server.config {
            ServerConfig::Stdio { env_secrets, .. } => env_secrets,
            ServerConfig::Http { header_secrets, .. } | ServerConfig::Sse { header_secrets, .. } => header_secrets,
        };
        let secrets = refs.values().map(|id| Ok((id.clone(), crate::models::decrypt_secret(c, id)?))).collect::<ApiResult<BTreeMap<_,_>>>()?;
        Ok((server,secrets,crate::procs::Limits::effective(c, None, None)?))
    }).await;
    let result = match loaded {
        Err(e) => Err(e),
        Ok((server,secrets,limits)) => {
            let mut shutdown = app.shutdown_rx.clone();
            let mut client = None;
            let probe = async {
                client = Some(client::Client::open(&server.config, &secrets, &check_id, limits).await?);
                client.as_mut().expect("opened client").inspect(&server.name).await
            };
            // open 단계와 handshake·모든 페이지 조회가 같은 hard timeout을 공유한다.
            let result = tokio::select! {
                biased;
                _ = shutdown.wait_for(|v| *v) => Err(ApiError::conflict("mcp_interrupted", "서버 종료로 MCP 연결 확인을 중단했습니다")),
                result = tokio::time::timeout(std::time::Duration::from_secs(server.timeout_secs as u64), probe) =>
                    result.unwrap_or_else(|_| Err(ApiError::new(StatusCode::GATEWAY_TIMEOUT, "mcp_timeout", "MCP 연결 확인 시간이 초과됐습니다"))),
            };
            if let Some(client) = &mut client { client.close().await; }
            result.map(|mut value| { scrub(&mut value, &secrets); value })
        }
    };
    let (status,detail) = match result {
        Ok(detail) => ("ready", detail),
        Err(e) => (if e.code == "mcp_interrupted" { "interrupted" } else { "failed" }, json!({ "error": e.body()["error"] })),
    };
    let now = app.now();
    let value = app.db.call(move |c| {
        let tx = c.transaction()?;
        let result = finish_check(&tx, &now, &id, &check_id, status, &detail)?;
        tx.commit()?;
        Ok(result)
    }).await?;
    app.notify_events().await;
    use axum::response::IntoResponse;
    Ok(Json(value).into_response())
}

fn scrub(value: &mut Value, secrets: &BTreeMap<String,String>) {
    let clean = |text: &str| {
        let mut text = text.to_string();
        for secret in secrets.values().filter(|s| !s.is_empty()) {
            text = text.replace(secret, "[redacted]");
            if let Some((scheme,token)) = secret.split_once(' ').filter(|(s,t)| (s.eq_ignore_ascii_case("bearer") || s.eq_ignore_ascii_case("basic")) && !t.is_empty()) {
                let _ = scheme;
                text = text.replace(token,"[redacted]");
            }
        }
        text
    };
    match value {
        Value::String(s) => *s = clean(s),
        Value::Array(a) => for v in a { scrub(v, secrets); },
        Value::Object(o) => {
            let old = std::mem::take(o);
            for (key,mut v) in old { scrub(&mut v,secrets); o.insert(clean(&key),v); }
        }
        _ => {}
    }
}

fn finish_check(c: &Connection, now: &str, id: &str, check_id: &str, status: &str, detail: &Value) -> ApiResult<Value> {
    let (owner,key,hash): (String,String,String) = c.query_row(
        "SELECT owner_id,idem_key,request_hash FROM mcp_checks WHERE server_id=?1 AND id=?2 AND status='checking'",
        params![id,check_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
    )?;
    c.execute("UPDATE mcp_checks SET status=?3,detail=?4,finished_at=?5 WHERE server_id=?1 AND id=?2",
        params![id,check_id,status,detail.to_string(),now])?;
    let value = json!({ "check_id": check_id, "status": status, "detail": detail });
    idem::complete(c,&owner,&key,&hash,StatusCode::OK,&value)?;
    events::append(c,now,"mcp.changed",None,None,&json!({ "id": id }))?;
    Ok(value)
}

/// 재시작은 확인을 다시 실행하지 않는다. 남은 소유 프로세스를 정리하고 receipt를 중단으로 확정한다.
pub async fn recover_on_start(app: &App) -> ApiResult<()> {
    let running: Vec<(String,String)> = app.db.call(|c| {
        let mut s = c.prepare("SELECT server_id,id FROM mcp_checks WHERE status='checking'")?;
        Ok(s.query_map([],|r| Ok((r.get(0)?,r.get(1)?)))?.collect::<Result<Vec<_>,_>>()?)
    }).await?;
    if running.is_empty() { return Ok(()); }
    let tags = running.iter().map(|(_,id)| id.clone()).collect::<Vec<_>>();
    tokio::task::spawn_blocking(move || crate::procs::reap_leftovers(&tags)).await.map_err(|_| ApiError::internal("MCP 중단 프로세스 정리에 실패했습니다"))?;
    let now = app.now();
    app.db.call(move |c| {
        let tx = c.transaction()?;
        for (server,id) in running {
            finish_check(&tx,&now,&server,&id,"interrupted",&json!({ "error": {
                "code": "mcp_interrupted", "message": "서버 재시작으로 연결 확인이 중단됐습니다. 자동 재실행하지 않습니다", "retryable": false,
            }}))?;
        }
        tx.commit()?;
        Ok(())
    }).await
}

/// secret 교체는 확인 중 금지하고, 완료된 확인 결과와 설정 revision을 무효화한다.
pub fn secret_changed(c: &Connection, now: &str, secret_id: &str) -> ApiResult<()> {
    let mut st = c.prepare(
        "SELECT DISTINCT m.id FROM mcp_servers m, json_each(m.config, '$.env_secrets') e WHERE e.value=?1
         UNION SELECT DISTINCT m.id FROM mcp_servers m, json_each(m.config, '$.header_secrets') h WHERE h.value=?1",
    )?;
    let ids = st.query_map([secret_id],|r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    for id in ids {
        ensure_not_checking(c,&id)?;
        c.execute("DELETE FROM mcp_checks WHERE server_id=?1",[&id])?;
        c.execute("UPDATE mcp_servers SET revision=revision+1,updated_at=?2 WHERE id=?1",params![id,now])?;
        events::append(c,now,"mcp.changed",None,None,&json!({ "id": id }))?;
    }
    Ok(())
}
