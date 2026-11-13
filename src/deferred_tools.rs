//! CTX-013: registry 조회와 모델에 보낼 schema 선택만 담당한다. 실제 도구를 실행하지 않는다.
//! 선택은 턴의 마지막 성공한 load_tool 호출로 교체한다. 별도 상태·복구 작업을 만들지 않는다.

use crate::approvals::{PolicyDecision, ToolCallRow};
use crate::error::{ApiError, ApiResult};
use crate::provider::ToolDef;
use crate::tools::{self, Effect, Planned, ToolError, ToolResult, ToolSpec};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub const NAME: &str = "load_tool";
pub const MAX_SELECTED: usize = 8;
pub const MAX_CATALOG: usize = 64;
const EAGER: &[&str] = &["edit", "read"];
const DESCRIPTION_CHARS: usize = 96;

pub fn snapshot() -> Value {
    json!({"version":1,"selection":"last_succeeded_call","max_selected":MAX_SELECTED})
}

pub fn spec() -> ToolSpec {
    ToolSpec {
        name: NAME,
        description: "내장 도구의 정확한 schema를 읽기 전용으로 로딩한다. names는 한 번에 1~8개다. 성공하면 이번 턴의 다음 실제 모델 요청부터 선택한 schema를 쓴다(이전 선택을 교체). 로딩은 도구 실행이나 승인이 아니며 실제 호출은 기존 검증·정책·승인을 거친다.",
        effect: Effect::Conversation,
        cancellable: false,
        max_output_bytes: tools::MAX_OUTPUT,
        schema: json!({"type":"object","properties":{
            "names":{"type":"array","minItems":1,"maxItems":MAX_SELECTED,"items":{"type":"string","minLength":1,"maxLength":64}}
        },"required":["names"],"additionalProperties":false}),
    }
}

fn names(args: &Value) -> ToolResult<Vec<String>> {
    tools::validate_args(&spec(), args)?;
    let input = args["names"].as_array().expect("validated array");
    if input.is_empty() || input.len() > MAX_SELECTED {
        return Err(ToolError::new("invalid_arguments", "names는 1~8개여야 합니다"));
    }
    let mut names = BTreeSet::new();
    for name in input {
        let name = name.as_str().expect("validated string").trim();
        if name.len() > 64 {
            return Err(ToolError::new("invalid_arguments", "도구 이름은 64 bytes 이하여야 합니다"));
        }
        if name == NAME || tools::spec(name).is_none() {
            return Err(ToolError::new("unsupported_tool", format!("로딩할 수 없는 도구입니다: {name}")));
        }
        names.insert(name.to_string());
    }
    Ok(names.into_iter().collect())
}

pub fn plan(args: &Value) -> ToolResult<Planned> {
    Ok(Planned { target: json!({"names":names(args)?}), precondition: None })
}

fn api_error(e: ToolError) -> ApiError {
    ApiError::new(axum::http::StatusCode::BAD_REQUEST, e.code, e.message)
}

/// 현재 정책과 로컬 MCP 연결 확인 기록만 본다. 원격 조회·동적 등록은 하지 않는다.
fn available(c: &Connection, session_id: &str, def: &Value) -> ApiResult<Vec<ToolSpec>> {
    let session = crate::sessions::get(c, session_id)?;
    let mcp_ready: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM mcp_servers m JOIN mcp_checks k ON k.server_id=m.id WHERE m.enabled=1 AND k.status='ready')",
        [], |r| r.get(0),
    )?;
    let allowed = def["limits"]["allowed_tools"].as_array();
    let mut specs = vec![];
    for spec in tools::specs() {
        if !mcp_ready && matches!(spec.name, "mcp_tools" | "mcp_call") {
            continue;
        }
        if allowed.is_some_and(|a| !a.iter().any(|n| n.as_str() == Some(spec.name))) {
            continue;
        }
        if !matches!(crate::approvals::tool_policy(c, &session.project_id, session_id, &spec)?, PolicyDecision::Deny(..)) {
            specs.push(spec);
        }
    }
    specs.sort_by_key(|s| s.name);
    if specs.len() > MAX_CATALOG {
        return Err(ApiError::invalid("지연 도구 목록 한도(64개)를 초과했습니다"));
    }
    Ok(specs)
}

/// 같은 집합은 요청 순서·중복과 무관하게 이름순, registry 원문 schema로 변환한다.
pub fn definitions(mut available: Vec<ToolSpec>, selected: &[String]) -> Vec<ToolDef> {
    available.sort_by_key(|s| s.name);
    let catalog = available.iter().filter(|s| s.name != NAME).take(MAX_CATALOG)
        .map(|s| format!("{}: {}", s.name, s.description.chars().take(DESCRIPTION_CHARS).collect::<String>()))
        .collect::<Vec<_>>().join("\n");
    let loader = available.iter().any(|s| s.name == NAME);
    available.into_iter().filter(|s| {
        if loader { s.name == NAME || EAGER.contains(&s.name) || selected.iter().take(MAX_SELECTED).any(|n| n == s.name) }
        else { true }
    }).take(MAX_SELECTED + 1 + EAGER.len()).map(|s| ToolDef {
        name: s.name.into(),
        description: if s.name == NAME {
            format!("{}\n현재 이용 가능한 도구 목록(설명은 요약이며 schema는 names로 로딩):\n{catalog}", s.description)
        } else { s.description.into() },
        schema: s.schema,
    }).collect()
}

/// 성공 receipt만 선택 근거로 쓴다. 실패·취소·unknown 호출은 이전 선택을 바꾸지 않는다.
pub fn model_tools(c: &Connection, turn_id: &str, session_id: &str, def: &Value) -> ApiResult<Vec<ToolDef>> {
    let available = available(c, session_id, def)?;
    if def["deferred_tools"]["version"] != 1 {
        // 업그레이드 전에 접수된 턴의 모델 입력 계약은 바꾸지 않는다.
        return Ok(available.into_iter().filter(|s| s.name != NAME).map(|s| ToolDef {
            name: s.name.into(), description: s.description.into(), schema: s.schema,
        }).collect());
    }
    let target: Option<String> = c.query_row(
        "SELECT target FROM tool_calls WHERE turn_id=?1 AND session_id=?2 AND name=?3 AND status='succeeded' ORDER BY rowid DESC LIMIT 1",
        params![turn_id, session_id, NAME], |r| r.get(0),
    ).optional()?;
    let selected = target.map(|raw| {
        let value = serde_json::from_str(&raw).map_err(|_| ApiError::invalid("저장된 도구 선택이 올바르지 않습니다"))?;
        names(&value).map_err(api_error)
    }).transpose()?.unwrap_or_default();
    Ok(definitions(available, &selected))
}

pub fn execute_tool(c: &Connection, call: &ToolCallRow) -> ApiResult<Value> {
    let selected = names(&call.target).map_err(api_error)?;
    let def = if let Some(turn_id) = &call.turn_id {
        let turn = crate::runner::get_turn(c, turn_id)?;
        if !turn.tools_enabled {
            return Err(ApiError::invalid("도구가 꺼진 턴에서는 schema를 로딩할 수 없습니다"));
        }
        let (_, profile) = crate::model_fallback::runtime(c, &turn.definition, turn.profile_id.as_deref().unwrap_or(""))?;
        if crate::provider::cli::is_cli(&profile.protocol) {
            return Err(ApiError::invalid("CLI 백엔드에는 Grove 도구 schema를 로딩하지 않습니다"));
        }
        turn.definition
    } else { json!({}) };
    let available = available(c, &call.session_id, &def)?;
    let mut schemas = vec![];
    for name in &selected {
        let spec = tools::spec(name).expect("validated registry name");
        if let PolicyDecision::Deny(code, message) = crate::approvals::tool_policy(c, &call.project_id, &call.session_id, &spec)? {
            return Err(api_error(ToolError::new(code, message)));
        }
        let spec = available.iter().find(|s| s.name == name)
            .ok_or_else(|| api_error(ToolError::new("unsupported_tool", format!("현재 로딩할 수 없는 도구입니다: {name}"))))?;
        schemas.push(json!({"name":spec.name,"description":spec.description,"schema":spec.schema}));
    }
    let result = json!({"tools":schemas,"selected":selected,
        "applies_to":if call.turn_id.is_some() { "next_model_request" } else { "schema_only" },
        "selection":"replace","executed":false});
    if result.to_string().len() > tools::MAX_OUTPUT {
        return Err(api_error(ToolError::new("output_limit", "schema 조회량이 출력 한도를 초과했습니다")));
    }
    Ok(result)
}
