//! 사전 등록 OAuth client 전용. 자동 등록·자동 갱신·교환 재시도는 하지 않는다.
//! MCP 2025-06-18 authorization, RFC 7636/8414/8707/9207/9700의 제한된 계약.
use super::{McpServer, ServerConfig, get};
use crate::{App, auth::{Owner, Principal}, error::{ApiError, ApiResult}, idem};
use axum::{Json, extract::{Path, State}, http::{HeaderMap, StatusCode}, response::{Html, IntoResponse, Response}};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub(super) const ACCESS: &str = "mcp-oauth:access";

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret_id: Option<String>,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
}

fn url(s: &str) -> ApiResult<reqwest::Url> {
    let u = reqwest::Url::parse(s).map_err(|_| ApiError::invalid("OAuth URL이 올바르지 않습니다"))?;
    // 평문 HTTP는 실제 IP loopback fixture에만 허용한다. DNS localhost 우회는 없다.
    let loopback = matches!(u.host_str(), Some("127.0.0.1" | "[::1]"));
    if !(u.scheme() == "https" || (u.scheme() == "http" && loopback))
        || u.host_str().is_none() || !u.username().is_empty() || u.password().is_some()
        || u.query().is_some() || u.fragment().is_some() || s.len() > 4096
    {
        return Err(ApiError::invalid("OAuth는 query·fragment·자격증명 없는 HTTPS URL만 지원합니다(loopback fixture 제외)"));
    }
    Ok(u)
}

impl Config {
    pub(super) fn normalize(&mut self, endpoint: &str) -> ApiResult<()> {
        let issuer = url(&self.issuer)?;
        for endpoint in [&self.authorization_endpoint, &self.token_endpoint] {
            if url(endpoint)?.origin() != issuer.origin() {
                return Err(ApiError::invalid("OAuth endpoint는 고정 issuer와 같은 origin이어야 합니다"));
            }
        }
        url(endpoint)?;
        url(&self.redirect_uri)?;
        if self.client_id.is_empty() || self.client_id.len() > 256 || self.client_id.chars().any(char::is_control)
            || self.client_secret_id.as_ref().is_some_and(|s| s.is_empty() || s.len() > 128)
            || self.scopes.len() > 32 || self.scopes.iter().any(|s| s.is_empty() || s.len() > 128
                || !s.bytes().all(|b| b == 0x21 || (0x23..=0x5b).contains(&b) || (0x5d..=0x7e).contains(&b)))
        {
            return Err(ApiError::invalid("OAuth client ID·secret 참조·scope가 올바르지 않습니다"));
        }
        self.scopes.sort();
        self.scopes.dedup();
        Ok(())
    }
}

pub(super) fn config(config: &ServerConfig) -> Option<&Config> {
    match config { ServerConfig::Http { oauth, .. } => oauth.as_ref(), _ => None }
}

fn configured(server: &McpServer) -> ApiResult<Config> {
    config(&server.config).cloned().ok_or_else(|| ApiError::invalid("이 HTTP MCP에 사전 등록 OAuth 설정이 없습니다"))
}

fn binding(server: &McpServer) -> String {
    idem::body_hash("mcp.oauth.config", &serde_json::to_value(&server.config).expect("serializable config"))
}

pub(super) fn identity(c: &Connection, server: &McpServer) -> ApiResult<Value> {
    if config(&server.config).is_none() { return Ok(Value::Null); }
    let id: Option<String> = c.query_row("SELECT identity FROM mcp_oauth_credentials WHERE server_id=?1 AND usable=1",
        [&server.id], |r| r.get(0)).optional()?;
    id.map(Value::String).ok_or_else(|| ApiError::conflict("mcp_auth_required", "OAuth 연결 또는 명시적 갱신이 필요합니다"))
}

pub(super) fn prepare(c: &Connection, server: &McpServer, now: &str, secrets: &mut BTreeMap<String, String>) -> ApiResult<()> {
    let Some(cfg) = config(&server.config) else { return Ok(()) };
    identity(c, server)?;
    let (access, refresh, expires): (String, Option<String>, String) = c.query_row(
        "SELECT grove_decrypt(access_token),CASE WHEN refresh_token IS NOT NULL THEN grove_decrypt(refresh_token) END,expires_at FROM mcp_oauth_credentials WHERE server_id=?1",
        [&server.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    if !unexpired(&expires, now) { return Err(ApiError::conflict("mcp_auth_expired", "OAuth 자격이 만료됐습니다. 명시적으로 갱신하세요")); }
    secrets.insert(ACCESS.into(), access);
    // 원격 MCP가 토큰 원문을 돌려줘도 기존 scrub 경계에서 가린다.
    if let Some(refresh) = refresh { secrets.insert("mcp-oauth:refresh".into(), refresh); }
    if let Some(id) = &cfg.client_secret_id { secrets.insert("mcp-oauth:client".into(), crate::models::decrypt_secret(c, id)?); }
    Ok(())
}

pub(super) fn invalidate(c: &Connection, id: &str) -> ApiResult<()> {
    c.execute("DELETE FROM mcp_oauth_credentials WHERE server_id=?1", [id])?;
    cancel_pending(c, id)
}

pub(super) fn cancel_pending(c: &Connection, id: &str) -> ApiResult<()> {
    c.execute("UPDATE mcp_oauth_attempts SET status='cancelled',verifier=NULL,state_hash=NULL WHERE server_id=?1 AND status='pending'", [id])?;
    Ok(())
}

fn expire(c: &Connection, now: &str) -> ApiResult<()> {
    c.execute("UPDATE mcp_oauth_attempts SET status='expired',verifier=NULL,state_hash=NULL WHERE status='pending' AND julianday(expires_at)<=julianday(?1)", [now])?;
    Ok(())
}

fn unexpired(expires: &str, now: &str) -> bool {
    crate::util::parse_time(expires).zip(crate::util::parse_time(now)).is_some_and(|(expires, now)| expires > now)
}

fn snapshot(c: &Connection, id: &str, revision: i64) -> ApiResult<McpServer> {
    let server = get(c, id)?;
    if server.revision != revision { return Err(ApiError::revision_conflict(serde_json::to_value(server)?)); }
    configured(&server)?;
    Ok(server)
}

fn changed(c: &Connection, id: &str, now: &str) -> ApiResult<()> {
    c.execute("UPDATE mcp_servers SET revision=revision+1,updated_at=?2 WHERE id=?1", params![id,now])?;
    c.execute("DELETE FROM mcp_checks WHERE server_id=?1", [id])?;
    crate::events::append(c, now, "mcp.changed", None, None, &json!({"id":id}))?;
    Ok(())
}

fn view(c: &Connection, id: &str, p: &Principal, now: &str) -> ApiResult<Value> {
    let server = get(c, id)?;
    configured(&server)?;
    expire(c, now)?;
    let attempt: Option<(String, String, String, String)> = c.query_row(
        "SELECT id,status,kind,expires_at FROM mcp_oauth_attempts WHERE server_id=?1 AND owner_id=?2 AND principal_id=?3 ORDER BY rowid DESC LIMIT 1",
        params![id,p.root_id,p.token_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let credential: Option<(String, bool, bool)> = c.query_row(
        "SELECT expires_at,usable,refresh_token IS NOT NULL FROM mcp_oauth_credentials WHERE server_id=?1",
        [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    Ok(json!({"revision":server.revision,
        "attempt":attempt.map(|(id,status,kind,expires)|json!({"id":id,"status":status,"kind":kind,"expires_at":expires})),
        "credential":credential.map(|(expires,usable,refresh)|json!({"expires_at":expires,"usable":usable && unexpired(&expires,now),"refresh_available":refresh && usable})),
        "note":"OAuth 완료는 MCP 연결 확인·도구 실행 성공이 아닙니다. unknown은 재교환하지 말고 새 연결을 시작하세요."}))
}

pub async fn status(State(app): State<App>, Owner(p): Owner, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let now = app.now();
    Ok(Json(app.db.call(move |c| view(c, &id, &p, &now)).await?))
}

fn client() -> ApiResult<reqwest::Client> {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15)).build()
        .map_err(|_| ApiError::internal("OAuth HTTP client를 준비하지 못했습니다"))
}

async fn document(response: reqwest::Response) -> Result<Value, ()> {
    if !response.status().is_success() { return Err(()); }
    body(response).await
}

async fn body(mut response: reqwest::Response) -> Result<Value, ()> {
    if response.headers().get("content-type").and_then(|v|v.to_str().ok())
        .is_none_or(|v| v.split(';').next().unwrap_or("").trim() != "application/json") { return Err(()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if bytes.len() + chunk.len() > 65536 { return Err(()); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ())
}

// 명시한 metadata와 endpoint가 정확히 일치해야 한다. 발견한 임의 URL로 자격을 전송하지 않는다.
async fn discover(server: &McpServer, cfg: &Config) -> ApiResult<()> {
    let work = async {
        let http = client().map_err(|_| ())?;
        let ServerConfig::Http { endpoint, .. } = &server.config else { return Err(()) };
        let mut resource = url(endpoint).map_err(|_| ())?;
        resource.set_path(&format!("/.well-known/oauth-protected-resource{}", resource.path().trim_end_matches('/')));
        let rm = document(http.get(resource).send().await.map_err(|_| ())?).await?;
        if rm["resource"] != *endpoint || !rm["authorization_servers"].as_array().is_some_and(|a|a.contains(&json!(cfg.issuer))) { return Err(()); }
        let mut issuer = url(&cfg.issuer).map_err(|_| ())?;
        issuer.set_path(&format!("/.well-known/oauth-authorization-server{}", issuer.path().trim_end_matches('/')));
        let am = document(http.get(issuer).send().await.map_err(|_| ())?).await?;
        let contains = |key: &str, v: &str| am[key].as_array().is_some_and(|a|a.contains(&json!(v)));
        let method = if cfg.client_secret_id.is_some() { "client_secret_post" } else { "none" };
        if am["issuer"] != cfg.issuer || am["authorization_endpoint"] != cfg.authorization_endpoint
            || am["token_endpoint"] != cfg.token_endpoint || !contains("code_challenge_methods_supported","S256")
            || !contains("response_types_supported","code") || !contains("token_endpoint_auth_methods_supported",method)
            || am["authorization_response_iss_parameter_supported"] != true { return Err(()); }
        Ok(())
    };
    tokio::time::timeout(std::time::Duration::from_secs(15), work).await
        .unwrap_or(Err(())).map_err(|_| ApiError::conflict("mcp_oauth_metadata", "고정 resource·issuer metadata 또는 지원 PKCE/iss/client 인증 계약을 확인하지 못했습니다"))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub expected_revision: i64,
    pub confirmed: bool,
}

fn confirmation(b: &Request) -> ApiResult<()> {
    if !b.confirmed { return Err(ApiError::invalid("OAuth 자격 전송을 명시적으로 확인하세요")); }
    Ok(())
}

fn redirect(app: &App, headers: &HeaderMap, cfg: &Config, id: &str) -> ApiResult<()> {
    let host = headers.get("host").and_then(|v|v.to_str().ok()).unwrap_or("");
    let expected = format!("{}://{host}", if app.cfg.tls_terminated { "https" } else { "http" });
    let origin = headers.get("origin").and_then(|v|v.to_str().ok()).unwrap_or(&expected);
    let target = url(&cfg.redirect_uri)?;
    if target.origin().ascii_serialization() != origin || target.path() != format!("/api/mcp-oauth/callback/{id}") {
        return Err(ApiError::invalid("등록 redirect는 현재 앱 origin의 이 서버 전용 /api/mcp-oauth/callback/{id}여야 합니다"));
    }
    Ok(())
}

pub async fn connect(State(app): State<App>, Owner(p): Owner, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<Request>) -> ApiResult<Response> {
    confirmation(&b)?;
    let hash = idem::body_hash("mcp.oauth.connect", &json!({"id":id,"request":b}));
    if let Some(r) = idem::replay(&app, &p, &headers, &hash).await? { return Ok(r); }
    let sid = id.clone();
    let server = app.db.call(move |c| snapshot(c,&sid,b.expected_revision)).await?;
    let cfg = configured(&server)?;
    redirect(&app,&headers,&cfg,&id)?;
    discover(&server,&cfg).await?;
    let actor = p.clone();
    idem::run_redacted(&app,&p,&headers,&hash,&["authorization_url"],move |tx,now| {
        expire(tx,now)?;
        let current = snapshot(tx,&id,server.revision)?;
        super::ensure_not_checking(tx,&id)?;
        let busy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM mcp_oauth_attempts WHERE server_id=?1 AND status IN ('pending','exchanging'))", [&id], |r|r.get(0))?;
        if busy { return Err(ApiError::busy("OAuth 연결 요청이 진행 중입니다. 상태를 확인하거나 취소하세요")); }
        let state = crate::util::random_secret(32);
        let verifier = crate::util::random_secret(32);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let attempt = crate::util::new_id();
        let expires = crate::util::fmt_time(crate::util::parse_time(now).expect("clock") + time::Duration::minutes(10));
        tx.execute("INSERT INTO mcp_oauth_attempts(id,server_id,owner_id,principal_id,revision,config_hash,state_hash,verifier,status,kind,expires_at)
            VALUES(?1,?2,?3,?4,?5,?6,?7,grove_encrypt(?8),'pending','connect',?9)",
            params![attempt,id,actor.root_id,actor.token_id,current.revision,binding(&current),crate::util::sha256_hex(state.as_bytes()),verifier,expires])?;
        let mut authorization = url(&cfg.authorization_endpoint)?;
        let ServerConfig::Http { endpoint, .. } = &current.config else { unreachable!() };
        authorization.query_pairs_mut().extend_pairs([
            ("response_type","code"),("client_id",&cfg.client_id),("redirect_uri",&cfg.redirect_uri),
            ("scope",&cfg.scopes.join(" ")),("resource",endpoint),("state",&state),
            ("code_challenge",&challenge),("code_challenge_method","S256"),
        ]);
        Ok((StatusCode::CREATED,json!({"attempt_id":attempt,"authorization_url":authorization.as_str(),"expires_at":expires})))
    }).await
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Complete {
    pub expected_revision: i64,
    pub attempt_id: String,
    pub state: String,
    pub code: Option<String>,
    pub error: Option<String>,
    pub iss: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Cancel {
    pub expected_revision: i64,
    pub attempt_id: String,
}

pub async fn cancel(State(app): State<App>, Owner(p): Owner, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<Cancel>) -> ApiResult<Response> {
    let hash = idem::body_hash("mcp.oauth.cancel",&json!({"id":id,"request":b}));
    let actor = p.clone();
    idem::run(&app,&p,&headers,&hash,move |tx,now| {
        snapshot(tx,&id,b.expected_revision)?;
        expire(tx,now)?;
        let n = tx.execute("UPDATE mcp_oauth_attempts SET status=CASE WHEN status='exchanging' THEN 'unknown' ELSE 'cancelled' END,verifier=NULL,state_hash=NULL
            WHERE id=?1 AND server_id=?2 AND owner_id=?3 AND principal_id=?4 AND status IN ('pending','exchanging')",
            params![b.attempt_id,id,actor.root_id,actor.token_id])?;
        if n != 1 { return Err(ApiError::conflict("mcp_oauth_state","취소 가능한 본인 OAuth 요청이 없습니다")); }
        Ok((StatusCode::OK,view(tx,&id,&actor,now)?))
    }).await
}

struct Exchange {
    id: String,
    server: McpServer,
    cfg: Config,
    form: Vec<(String,String)>,
    previous_refresh: Option<String>,
}

pub async fn complete(State(app): State<App>, Owner(p): Owner, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<Complete>) -> ApiResult<Response> {
    if b.state.len() > 256 || b.code.as_ref().is_some_and(|s|s.is_empty() || s.len()>8192)
        || b.code.is_some() == b.error.is_some() || b.iss.len()>4096 || b.error.as_ref().is_some_and(|s|s.len()>256) {
        return Err(ApiError::invalid("OAuth callback 형식이 올바르지 않습니다"));
    }
    let hash = idem::body_hash("mcp.oauth.complete",&json!({"id":id,"request":b}));
    let exchange = std::sync::Arc::new(std::sync::Mutex::new(None));
    let slot = exchange.clone();
    let actor = p.clone();
    let key = idem::key_from(&headers)?;
    let receipt_key = key.clone();
    let rh = hash.clone();
    let receipt = idem::run(&app,&p,&headers,&hash,move |tx,now| {
        expire(tx,now)?;
        let server = snapshot(tx,&id,b.expected_revision)?;
        let cfg = configured(&server)?;
        let verifier: Option<String> = tx.query_row("SELECT grove_decrypt(verifier) FROM mcp_oauth_attempts WHERE id=?1 AND server_id=?2
            AND owner_id=?3 AND principal_id=?4 AND revision=?5 AND config_hash=?6 AND state_hash=?7 AND status='pending' AND julianday(expires_at)>julianday(?8)",
            params![b.attempt_id,id,actor.root_id,actor.token_id,server.revision,binding(&server),crate::util::sha256_hex(b.state.as_bytes()),now],
            |r|r.get(0)).optional()?;
        let verifier = verifier.ok_or_else(|| ApiError::conflict("mcp_oauth_state","OAuth state·소유자·revision·기한이 일치하지 않거나 이미 소비됐습니다"))?;
        if b.iss != cfg.issuer { return Err(ApiError::conflict("mcp_oauth_issuer","OAuth 응답 issuer가 일치하지 않습니다")); }
        if b.error.is_some() {
            tx.execute("UPDATE mcp_oauth_attempts SET status='failed',verifier=NULL,state_hash=NULL WHERE id=?1",[&b.attempt_id])?;
            return Ok((StatusCode::OK,json!({"status":"failed","attempt_id":b.attempt_id})));
        }
        super::ensure_not_checking(tx,&id)?;
        let form = vec![("grant_type".into(),"authorization_code".into()),("code".into(),b.code.expect("validated code")),
            ("redirect_uri".into(),cfg.redirect_uri.clone()),("code_verifier".into(),verifier)];
        claim(tx,now,&actor,&b.attempt_id,&id,&receipt_key,&rh)?;
        let server = get(tx,&id)?;
        *slot.lock().expect("exchange slot") = Some(Exchange { id:b.attempt_id.clone(),server,cfg,form,previous_refresh:None });
        Ok(unknown(&b.attempt_id))
    }).await?;
    if receipt.headers().contains_key("idempotent-replayed") { return Ok(receipt); }
    let work = exchange.lock().expect("exchange slot").take();
    match work { Some(work) => run(app,p,key,hash,work).await, None => Ok(receipt) }
}

fn unknown(id: &str) -> (StatusCode,Value) {
    (StatusCode::CONFLICT,json!({"error":{"code":"result_unknown","message":"OAuth 교환 결과가 아직 확정되지 않았습니다. 자동 재시도하지 않습니다","retryable":false},"attempt_id":id}))
}

fn claim(c: &Connection, now: &str, p: &Principal, attempt: &str, id: &str, key: &str, hash: &str) -> ApiResult<()> {
    crate::auth::check_principal(c,p,now)?;
    c.execute("UPDATE mcp_oauth_credentials SET usable=0 WHERE server_id=?1",[id])?;
    changed(c,id,now)?;
    c.execute("UPDATE mcp_oauth_attempts SET status='exchanging',verifier=NULL,state_hash=NULL,
        revision=(SELECT revision FROM mcp_servers WHERE id=?2),receipt_key=?3,receipt_hash=?4 WHERE id=?1",
        params![attempt,id,key,hash])?;
    Ok(())
}

pub async fn refresh(State(app): State<App>, Owner(p): Owner, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<Request>) -> ApiResult<Response> {
    confirmation(&b)?;
    let hash = idem::body_hash("mcp.oauth.refresh",&json!({"id":id,"request":b}));
    let slot = std::sync::Arc::new(std::sync::Mutex::new(None));
    let exchange = slot.clone();
    let actor = p.clone();
    let key = idem::key_from(&headers)?;
    let receipt_key = key.clone();
    let rh = hash.clone();
    let receipt = idem::run(&app,&p,&headers,&hash,move |tx,now| {
        expire(tx,now)?;
        let server = snapshot(tx,&id,b.expected_revision)?;
        let cfg = configured(&server)?;
        super::ensure_not_checking(tx,&id)?;
        let busy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM mcp_oauth_attempts WHERE server_id=?1 AND status IN ('pending','exchanging'))",[&id],|r|r.get(0))?;
        if busy { return Err(ApiError::busy("OAuth 요청이 진행 중입니다")); }
        let token: Option<String> = tx.query_row("SELECT grove_decrypt(refresh_token) FROM mcp_oauth_credentials WHERE server_id=?1 AND usable=1 AND refresh_token IS NOT NULL",
            [&id],|r|r.get(0)).optional()?;
        let token = token.ok_or_else(|| ApiError::conflict("mcp_oauth_reconnect","갱신 가능한 자격이 없습니다. 명시적으로 새 연결을 시작하세요"))?;
        let attempt = crate::util::new_id();
        tx.execute("INSERT INTO mcp_oauth_attempts(id,server_id,owner_id,principal_id,revision,config_hash,status,kind,expires_at)
            VALUES(?1,?2,?3,?4,?5,?6,'pending','refresh',?7)",params![attempt,id,actor.root_id,actor.token_id,server.revision,binding(&server),now])?;
        claim(tx,now,&actor,&attempt,&id,&receipt_key,&rh)?;
        *exchange.lock().expect("exchange slot") = Some(Exchange { id:attempt.clone(),server:get(tx,&id)?,cfg,
            form:vec![("grant_type".into(),"refresh_token".into()),("refresh_token".into(),token.clone())],previous_refresh:Some(token) });
        Ok(unknown(&attempt))
    }).await?;
    if receipt.headers().contains_key("idempotent-replayed") { return Ok(receipt); }
    let work = slot.lock().expect("exchange slot").take().expect("claimed exchange");
    run(app,p,key,hash,work).await
}

struct Tokens { access: String, refresh: Option<String>, seconds: i64 }
enum Outcome { Success(Tokens), Failed, Unknown }

async fn request_tokens(work: &Exchange, client_secret: Option<String>) -> Outcome {
    let operation = async {
        let mut form = work.form.clone();
        form.push(("client_id".into(),work.cfg.client_id.clone()));
        if let Some(secret) = client_secret { form.push(("client_secret".into(),secret)); }
        let ServerConfig::Http { endpoint, .. } = &work.server.config else { unreachable!() };
        form.push(("resource".into(),endpoint.clone()));
        let response = client().map_err(|_| ())?.post(&work.cfg.token_endpoint).form(&form).send().await.map_err(|_| ())?;
        let status = response.status();
        let value = body(response).await?;
        if status == StatusCode::BAD_REQUEST && value["error"].as_str().is_some() { return Ok(Outcome::Failed); }
        if !status.is_success() { return Err(()); }
        fn valid_token(v: &Value) -> Option<&str> {
            v.as_str().filter(|s| !s.is_empty() && s.len()<=8192 && s.bytes().all(|b| b.is_ascii_graphic()))
        }
        let access = valid_token(&value["access_token"]).ok_or(())?.to_string();
        let refresh = if value.get("refresh_token").is_some() { Some(valid_token(&value["refresh_token"]).ok_or(())?.to_string()) }
            else { work.previous_refresh.clone() };
        let seconds = value["expires_in"].as_i64().filter(|s| (1..=31536000).contains(s)).ok_or(())?;
        if !value["token_type"].as_str().is_some_and(|s|s.eq_ignore_ascii_case("Bearer")) { return Err(()); }
        if let Some(scope) = value.get("scope") {
            let scopes = scope.as_str().ok_or(())?;
            if scopes.split(' ').any(|s|!work.cfg.scopes.iter().any(|v|v==s)) { return Err(()); }
        }
        Ok(Outcome::Success(Tokens { access,refresh,seconds }))
    };
    tokio::time::timeout(std::time::Duration::from_secs(15),operation).await.unwrap_or(Err(())).unwrap_or(Outcome::Unknown)
}

async fn run(app: App, p: Principal, key: String, hash: String, work: Exchange) -> ApiResult<Response> {
    // HTTP 대기 폐기는 토큰 교환을 재시작하지 않는다. 접수 후 별도 task 하나만 소유한다.
    let handle = tokio::spawn(async move {
        let secret_id = work.cfg.client_secret_id.clone();
        let secret = app.db.call(move |c| secret_id.map(|id|crate::models::decrypt_secret(c,&id)).transpose()).await;
        let outcome = match secret {
            Ok(secret) => {
                let mut shutdown = app.shutdown_rx.clone();
                tokio::select! { biased;
                    _=shutdown.wait_for(|v|*v) => Outcome::Unknown,
                    result=request_tokens(&work,secret) => result,
                }
            }
            Err(_) => Outcome::Unknown,
        };
        let now = app.now();
        let value = app.db.call(move |c| {
            let tx = c.transaction()?;
            let live: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM mcp_oauth_attempts a JOIN mcp_servers s ON s.id=a.server_id
                WHERE a.id=?1 AND a.status='exchanging' AND a.revision=s.revision AND a.config_hash=?2)",
                params![work.id,binding(&work.server)],|r|r.get(0))?;
            let authorized = crate::auth::check_principal(&tx,&p,&now).is_ok();
            let status = match outcome {
                Outcome::Success(tokens) if live && authorized => {
                    let expires = crate::util::fmt_time(crate::util::parse_time(&now).expect("clock")+time::Duration::seconds(tokens.seconds));
                    tx.execute("INSERT INTO mcp_oauth_credentials(server_id,identity,access_token,refresh_token,expires_at,usable)
                        VALUES(?1,?2,grove_encrypt(?3),CASE WHEN ?4 IS NOT NULL THEN grove_encrypt(?4) END,?5,1)
                        ON CONFLICT(server_id) DO UPDATE SET identity=excluded.identity,access_token=excluded.access_token,
                        refresh_token=excluded.refresh_token,expires_at=excluded.expires_at,usable=1",
                        params![work.server.id,crate::util::new_id(),tokens.access,tokens.refresh,expires])?;
                    changed(&tx,&work.server.id,&now)?;
                    "completed"
                }
                Outcome::Failed if live && authorized => "failed",
                _ => "unknown",
            };
            tx.execute("UPDATE mcp_oauth_attempts SET status=?2,verifier=NULL,state_hash=NULL WHERE id=?1",params![work.id,status])?;
            let value = json!({"attempt_id":work.id,"status":status});
            idem::complete(&tx,&p.root_id,&key,&hash,StatusCode::OK,&value)?;
            tx.commit()?;
            Ok(value)
        }).await?;
        app.notify_events().await;
        Ok::<_,ApiError>(value)
    });
    let value = handle.await.map_err(|_| ApiError::conflict("result_unknown","OAuth 교환이 중단됐습니다. 자동 재시도하지 않습니다"))??;
    Ok(Json(value).into_response())
}

pub async fn recover_on_start(app: &App) -> ApiResult<()> {
    let now = app.now();
    app.db.call(move |c| {
        let tx = c.transaction()?;
        // 재시작 때 대기 state도 폐기한다. 접수된 교환 receipt는 unknown을 그대로 유지한다.
        tx.execute("UPDATE mcp_oauth_attempts SET status=CASE WHEN status='exchanging' THEN 'unknown' ELSE 'interrupted' END,
            verifier=NULL,state_hash=NULL WHERE status IN ('pending','exchanging')",[])?;
        expire(&tx,&now)?;
        tx.commit()?;
        Ok(())
    }).await
}

/// 교차 사이트 반환 문서는 인증/자격 작업을 하지 않는다. 원래 창이 Owner API로 완료한다.
/// /api/ 아래의 독립 문서이므로 기존 SW의 navigation shell 대체 대상이 아니다.
/// code/state는 서버 HTML에 보간하지 않고 브라우저에서 읽은 뒤 주소 표시줄에서 즉시 지운다.
pub async fn callback() -> Response {
    const SCRIPT: &str = r#"const q=new URLSearchParams(location.search);history.replaceState(null,"",location.pathname);if(window.opener){window.opener.postMessage({type:"grove-mcp-oauth",state:q.get("state"),code:q.get("code"),error:q.get("error"),iss:q.get("iss")},location.origin);}document.getElementById("status").textContent="원래 MCP 설정 창에서 완료 상태를 확인하세요. 이 창은 닫아도 됩니다.";"#;
    let policy = format!("default-src 'none'; script-src 'sha256-{}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        base64::engine::general_purpose::STANDARD.encode(Sha256::digest(SCRIPT.as_bytes())));
    ([(axum::http::header::CONTENT_SECURITY_POLICY,policy),
        (axum::http::header::CACHE_CONTROL,"no-store".into()),
        (axum::http::header::REFERRER_POLICY,"no-referrer".into()),
        (axum::http::header::X_CONTENT_TYPE_OPTIONS,"nosniff".into())],
        Html(format!("<!doctype html><html lang=\"ko\"><meta charset=\"utf-8\"><title>MCP OAuth 반환</title><p id=\"status\">MCP 설정 창으로 돌아가세요.</p><script>{SCRIPT}</script></html>"))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expiration_compares_instants_including_fractional_seconds_and_offsets() {
        assert!(!unexpired("2026-01-01T00:00:00.1Z", "2026-01-01T00:00:00.11Z"));
        assert!(!unexpired("2026-01-01T00:00:00Z", "2026-01-01T00:00:00.1Z"));
        assert!(!unexpired("2026-01-01T09:00:00+09:00", "2026-01-01T00:00:00Z"));
        assert!(unexpired("2026-01-01T00:00:00.12Z", "2026-01-01T00:00:00.11Z"));
        let c = Connection::open_in_memory().unwrap();
        let expired: bool = c.query_row("SELECT julianday(?1)<=julianday(?2)",
            ["2026-01-01T00:00:00.1Z","2026-01-01T00:00:00.11Z"], |r|r.get(0)).unwrap();
        assert!(expired);
    }
}
