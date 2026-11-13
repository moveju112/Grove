//! AGENT-022: 기존 resolver와 실행 정책의 읽기 전용 개요.
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::{App, agents, definitions, models, settings};
use axum::Json;
use axum::extract::{Query, State, rejection::QueryRejection};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OverviewQuery {
    project_id: Option<String>,
    session_id: Option<String>,
}

/// 기존 definitions/settings와 같은 인증 경계. 파일·모델·도구 실행은 하지 않는다.
pub async fn show(
    State(app): State<App>,
    _principal: Principal,
    query: Result<Query<OverviewQuery>, QueryRejection>,
) -> ApiResult<Json<Value>> {
    let Query(query) =
        query.map_err(|_| ApiError::invalid("에이전트 개요 조회 인자가 올바르지 않습니다"))?;
    Ok(Json(
        app.db
            .call(move |c| {
                let tx = c.transaction()?;
                let result = overview(&tx, query)?;
                tx.commit()?;
                Ok(result)
            })
            .await?,
    ))
}

struct Redactor {
    secrets: Vec<String>,
    sensitive: Regex,
    pem: Regex,
}

impl Redactor {
    fn new(c: &Connection) -> ApiResult<Self> {
        // 원문에 복사된 vault 값도 응답하지 않는다. 복호화 실패 시 원문을 보내지 않는다.
        let mut st = c.prepare("SELECT id FROM secrets")?;
        let ids = st
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut secrets = ids
            .iter()
            .map(|id| {
                models::decrypt_secret(c, id).map_err(|_| {
                    ApiError::conflict(
                        "redaction_unavailable",
                        "민감정보 가림을 확인할 수 없어 개요를 표시하지 않습니다",
                    )
                })
            })
            .collect::<ApiResult<Vec<_>>>()?;
        secrets.retain(|s| !s.is_empty());
        secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        Ok(Self {
            secrets,
            sensitive: Regex::new(r#"(?i)(authorization|bearer\s|api[_ -]?key|password|passwd|(?:token|secret)\s*[:=]|sk-[a-z0-9]|://|~[/\\]|[a-z]:[/\\]|\\\\|(?:^|[\s"'`(=:])/[a-z0-9_.-])"#).unwrap(),
            pem: Regex::new(r"(?s)-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----").unwrap(),
        })
    }

    fn text(&self, raw: &str) -> String {
        let mut text = raw.to_string();
        for secret in &self.secrets {
            text = text.replace(secret, "[redacted]");
        }
        text = self.pem.replace_all(&text, "[redacted]").into_owned();
        text.split_inclusive('\n')
            .map(|line| {
                if self.sensitive.is_match(line) {
                    if line.ends_with('\n') {
                        "[redacted: 민감정보·경로 포함 행]\n"
                    } else {
                        "[redacted: 민감정보·경로 포함 행]"
                    }
                } else {
                    line
                }
            })
            .collect()
    }
}

fn profile(c: &Connection, id: Option<&str>, redact: &Redactor) -> ApiResult<Value> {
    let Some(id) = id.filter(|s| !s.is_empty()) else {
        return Ok(json!({"status":"unset"}));
    };
    match models::get_profile(c, id) {
        Ok(p) => Ok(json!({
            "status": if p.enabled { "configured" } else { "disabled" },
            "name": redact.text(&p.name), "model": redact.text(&p.model),
        })),
        Err(e) if e.code == "not_found" => Ok(json!({"status":"missing"})),
        Err(e) => Err(e),
    }
}

fn setting(
    c: &Connection,
    key: &str,
    project: Option<&str>,
    session: Option<&str>,
) -> ApiResult<Value> {
    let def = settings::def(key).ok_or_else(|| ApiError::internal("개요 설정 정의가 없습니다"))?;
    settings::resolve_key(c, &def, project, session)
}

fn overview(c: &Connection, q: OverviewQuery) -> ApiResult<Value> {
    if q.project_id.as_deref() == Some("") || q.session_id.as_deref() == Some("") {
        return Err(ApiError::invalid("빈 조회 대상은 허용하지 않습니다"));
    }
    let session = q
        .session_id
        .as_deref()
        .map(|id| crate::sessions::get(c, id))
        .transpose()?;
    let project = if let Some(s) = &session {
        if q.project_id.as_ref().is_some_and(|p| p != &s.project_id) {
            return Err(ApiError::invalid("대화와 프로젝트 조회 대상이 다릅니다"));
        }
        Some(s.project_id.clone())
    } else {
        if let Some(p) = &q.project_id {
            crate::projects::get(c, p)?;
        }
        q.project_id.clone()
    };
    let pid = project.as_deref();
    let sid = q.session_id.as_deref();
    let redact = Redactor::new(c)?;
    let delegation = setting(c, "agents.delegation", pid, sid)?;
    let mode = delegation["effective"]
        .as_str()
        .filter(|s| matches!(*s, "off" | "ask" | "auto"));
    let default = setting(c, "model.default_profile", pid, sid)?;
    let mut next = if default["effective"].is_null() || default["effective"].is_string() {
        profile(c, default["effective"].as_str(), &redact)?
    } else {
        json!({"status":"unknown"})
    };
    next["source"] = default["source"].clone();
    let turn_id: Option<String> = if let Some(sid) = sid {
        c.query_row("SELECT id FROM turns WHERE session_id=?1 AND status IN ('queued','running','awaiting_approval') ORDER BY created_at DESC LIMIT 1", [sid], |r| r.get(0)).optional()?
    } else {
        None
    };
    let turn = turn_id
        .as_deref()
        .map(|id| crate::runner::get_turn(c, id))
        .transpose()?;
    let parent = if let Some(t) = &turn {
        json!({ "status":"active", "profile": profile(c, t.profile_id.as_deref(), &redact)?, "tools_enabled":t.tools_enabled })
    } else {
        json!({"status": if sid.is_some() { "no_active_turn" } else { "no_session" }})
    };
    let candidates = sid.map(|s| agents::available_for(c, s)).transpose()?;
    let policy = if let (Some(p), Some(s)) = (pid, sid) {
        let spec = crate::tools::spec("agent")
            .ok_or_else(|| ApiError::internal("에이전트 도구 정의가 없습니다"))?;
        Some(crate::approvals::tool_policy(c, p, s, &spec)?)
    } else {
        None
    };
    let approval = if let (Some(p), Some(s), Some(_)) = (pid, sid, mode) {
        match (
            agents::approval_policy(c, p, s, &json!({"action":"spawn"}))?,
            &policy,
        ) {
            (None, _) | (_, Some(crate::approvals::PolicyDecision::Deny(..))) => "blocked",
            (Some(false), _) | (Some(true), Some(crate::approvals::PolicyDecision::Allow)) => {
                "auto"
            }
            (Some(true), _) => "ask",
        }
    } else {
        "unknown"
    };
    let roles: Vec<Value> = definitions::list_all(c, "agent")?.into_iter().map(|d| {
        let availability = if !d.enabled { "disabled" }
            else if mode.is_none() { "unknown" }
            else if mode == Some("off") { "delegation_off" }
            else if matches!(policy, Some(crate::approvals::PolicyDecision::Deny(..))) { "policy_denied" }
            else if turn.as_ref().is_some_and(|t| !t.tools_enabled) { "tools_disabled" }
            else if let Some(available) = &candidates {
                if available.as_array().is_some_and(|a| a.iter().any(|a| a["id"] == d.id)) { "available" } else { "depth_limit" }
            } else { "needs_session" };
        json!({
            "id":d.id, "name":redact.text(&d.name), "description":redact.text(&d.description),
            "body":redact.text(&d.body), "builtin":d.builtin, "modified_fields":d.modified_fields,
            "enabled":d.enabled, "revision":d.revision, "availability":availability,
        })
    }).collect();
    Ok(json!({
        "project_id":project, "session_id":q.session_id, "roles":roles,
        "delegation":{"mode":mode, "source":delegation["source"], "approval":approval},
        "parent":parent, "next_request_default":next,
        "limits":{"max_depth":agents::MAX_DEPTH, "max_per_parent":agents::MAX_PER_PARENT, "max_running":agents::MAX_RUNNING},
    }))
}
