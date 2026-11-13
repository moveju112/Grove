//! 역할 정책은 정의 ID에 묶고, 범위 및 부모 자식 경계를 지날 때 교집합으로 좁힌다.

use crate::error::{ApiError, ApiResult};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub const ROLES: &str = "agents.allowed_roles";
pub const ORCHESTRATION: &str = "agents.orchestration";

fn role_ids(value: &str) -> BTreeSet<&str> {
    value.split(',').map(str::trim).filter(|id| !id.is_empty()).collect()
}

/// 기존 문자열 편집기를 사용한다. '*'는 전체, 빈 문자열은 어떤 역할도 허용하지 않는다.
pub fn valid_roles(value: &Value) -> bool {
    let Some(value) = value.as_str().filter(|value| value.len() <= 4096) else { return false };
    let value = value.trim();
    if value.is_empty() || value == "*" {
        return true;
    }
    let ids = role_ids(value);
    ids.len() == value.split(',').count() && ids.iter().all(|id| crate::definitions::valid_id(id))
}

/// DB에 저장하기 직전에 실제 정의 존재를 검사한다(표시 이름·임의 role alias는 받지 않는다).
pub fn validate_roles(c: &Connection, value: &Value) -> ApiResult<()> {
    if !valid_roles(value) {
        return Err(ApiError::invalid("허용 역할은 실제 에이전트 ID를 쉼표로 구분하거나 '*' 또는 빈 문자열이어야 합니다"));
    }
    let value = value.as_str().unwrap().trim();
    if value != "*" {
        for id in role_ids(value) {
            match crate::definitions::resolve(c, "agent", id) {
                Ok(_) => {}
                Err(error) if error.code == "not_found" => return Err(ApiError::invalid(format!("존재하지 않는 에이전트 ID입니다: {id}"))),
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}

/// 설정 API의 적용값과 실행 경계가 같은 축소 규칙을 공유한다. ask/auto의 기존 우선순위는 유지한다.
pub fn inherit(key: &str, current: &Value, next: &Value) -> Value {
    match key {
        ROLES => {
            let a = current.as_str().unwrap_or("").trim();
            let b = next.as_str().unwrap_or("").trim();
            let ids = match (a, b) {
                ("*", "*") => return json!("*"),
                ("*", _) => role_ids(b),
                (_, "*") => role_ids(a),
                _ => role_ids(a).intersection(&role_ids(b)).copied().collect(),
            };
            json!(ids.into_iter().collect::<Vec<_>>().join(","))
        }
        ORCHESTRATION if current == "solo" || next == "solo" => json!("solo"),
        "agents.delegation" if current == "off" || next == "off" => json!("off"),
        _ => next.clone(),
    }
}

/// 자식 대화의 auto는 부모 대화에서 필요한 승인을 생략할 권한이 아니다.
pub fn inherit_parent(key: &str, current: &Value, parent: &Value) -> Value {
    if key == "agents.delegation" && current != "off" && parent != "off" && (current == "ask" || parent == "ask") {
        json!("ask")
    } else {
        inherit(key, parent, current)
    }
}

pub fn is_policy(key: &str) -> bool {
    matches!(key, ROLES | ORCHESTRATION | "agents.delegation")
}

pub fn denied_value(key: &str) -> Value {
    match key {
        ROLES => json!(""),
        ORCHESTRATION => json!("solo"),
        _ => json!("off"),
    }
}

pub struct Policy {
    enabled: bool,
    roles: Value,
    pub needs_approval: bool,
}

impl Policy {
    /// 자식 대화의 override로 부모 대화의 금지를 벗어나지 못한다. 정책 철회도 다음 실행에 즉시 반영한다.
    pub fn for_session(c: &Connection, session_id: &str) -> ApiResult<Self> {
        let session = crate::sessions::get(c, session_id)?;
        let mode = crate::settings::effective(c, "agents.delegation", Some(&session.project_id), Some(session_id))?;
        let orchestration = crate::settings::effective(c, ORCHESTRATION, Some(&session.project_id), Some(session_id))?;
        Ok(Self {
            enabled: mode != "off" && orchestration != "solo",
            needs_approval: mode != "auto",
            roles: crate::settings::effective(c, ROLES, Some(&session.project_id), Some(session_id))?,
        })
    }

    pub fn allows(&self, id: &str) -> bool {
        self.enabled && (self.roles == "*" || role_ids(self.roles.as_str().unwrap_or("")).contains(id))
    }

    pub fn allows_defined(&self, c: &Connection, id: &str) -> ApiResult<bool> {
        if !self.allows(id) {
            return Ok(false);
        }
        match crate::definitions::resolve(c, "agent", id) {
            Ok(definition) => Ok(definition.def.enabled),
            Err(error) if error.code == "not_found" => Ok(false),
            Err(error) => Err(error),
        }
    }
}
