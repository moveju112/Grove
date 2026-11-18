//! 공급자별 프롬프트 캐시 힌트. 응답·도구 결과를 로컬에서 재사용하지 않는다.
//!
//! 지원이 확인된 공식 endpoint에만 전용 필드를 보낸다. Gemini·DeepSeek 등의
//! 암묵적 캐시는 안정된 지침·도구 prefix와 기존 usage 집계로 이용한다.

use super::{ModelRequest, Profile, ToolDef};
use serde_json::{Value, json};

/// registry·호출자가 도구를 다른 순서로 주어도 동일한 prefix를 만든다.
pub(super) fn tools(req: &ModelRequest) -> Vec<&ToolDef> {
    let mut tools: Vec<_> = req.tools.iter().collect();
    tools.sort_by(|a, b| a.name.cmp(&b.name));
    tools
}

fn endpoint(profile: &Profile, host: &str) -> bool {
    reqwest::Url::parse(&profile.base_url).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some(host)
            && url.port_or_known_default() == Some(443)
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
    })
}

pub(super) fn openai(profile: &Profile, req: &ModelRequest, body: &mut Value) {
    let router = endpoint(profile, "openrouter.ai");
    if !endpoint(profile, "api.openai.com") && !router {
        return;
    }
    // 현재 질문·출력 한도·추론 강도·자격은 키에 넣지 않는다. 같은 지침과 도구를
    // 공유하는 요청이 재시작 뒤에도 같은 opaque key를 사용한다(원문 노출 없음).
    let prefix = json!({
        "namespace":"grove-prompt-cache-v1", "model":profile.model,
        "system":req.system, "tools":body.get("tools"),
    });
    body["prompt_cache_key"] = json!(crate::util::sha256_hex(prefix.to_string().as_bytes()));

    if router && profile.model.starts_with("anthropic/claude-") {
        // OpenRouter의 Claude 경로도 같은 5분 자동 캐시를 지원한다.
        body["cache_control"] = ephemeral();
        mark_system(body, "cache_control", ephemeral());
    } else if router
        && (profile.model.starts_with("google/gemini-2.5-")
            || profile.model.starts_with("google/gemini-3"))
    {
        // OpenRouter가 Gemini 2.5·3의 명시적 캐시 객체를 관리한다. Gemini 4는 제외한다.
        mark_system(body, "cache_control", ephemeral());
    } else if (!router || profile.model.starts_with("openai/"))
        && openai_breakpoints(&profile.model)
    {
        // GPT-5.6 이후는 시스템 경계를 명시하고 대화의 자동 캐시도 유지한다.
        // 구형 모델에는 미지원 옵션·경계를 보내지 않는다. TTL은 공급자 기본값이다.
        body["prompt_cache_options"] = json!({"mode":"implicit"});
        mark_system(body, "prompt_cache_breakpoint", json!({"mode":"explicit"}));
    }
}

fn openai_breakpoints(model: &str) -> bool {
    let model = model.strip_prefix("openai/").unwrap_or(model);
    let Some(version) = model
        .strip_prefix("gpt-")
        .and_then(|name| name.split('-').next())
    else {
        return false;
    };
    let mut parts = version.split('.');
    let Some(major) = parts.next().and_then(|part| part.parse::<u32>().ok()) else {
        return false;
    };
    let minor = match parts.next() {
        Some(part) => match part.parse::<u32>() {
            Ok(value) => value,
            Err(_) => return false,
        },
        None => 0,
    };
    parts.next().is_none() && (major >= 6 || (major == 5 && minor >= 6))
}

pub(super) fn anthropic(profile: &Profile, body: &mut Value) {
    if !endpoint(profile, "api.anthropic.com") {
        return;
    }
    // 서명된 native 블록은 수정하지 않는다. 기존 명시적 경계를 포함해 최대 4개다.
    let controls: Vec<_> = body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .filter_map(|block| block.get("cache_control"))
        .collect();
    let existing = controls.len();
    // 기존 1시간 경계 뒤에 5분/1시간 순서가 뒤집히거나 자동 TTL이 충돌하지 않게 둔다.
    if existing >= 4
        || controls
            .iter()
            .any(|control| control.get("ttl").is_some_and(|ttl| ttl != "5m"))
    {
        return;
    }
    // 자동 경계가 마지막 cacheable 블록을 따라가므로 긴 도구 루프도 재사용한다.
    body["cache_control"] = ephemeral();
    let mut remaining = 3 - existing;
    if remaining > 0 && mark_system(body, "cache_control", ephemeral()) {
        remaining -= 1;
    }
    if remaining > 0 {
        if let Some(tool) = body
            .get_mut("tools")
            .and_then(Value::as_array_mut)
            .and_then(|tools| tools.last_mut())
        {
            tool["cache_control"] = ephemeral();
        }
    }
}

fn ephemeral() -> Value {
    json!({"type":"ephemeral"})
}

fn mark_system(body: &mut Value, field: &str, control: Value) -> bool {
    // Messages API와 OpenAI 호환 API의 system 표현만 바꾼다. 메시지 순서·본문은 보존한다.
    if let Some(text) = body["system"].as_str().filter(|text| !text.is_empty()) {
        body["system"] = json!([{"type":"text","text":text, (field):control}]);
        return true;
    }
    if let Some(message) = body
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .and_then(|messages| messages.first_mut())
    {
        if message["role"] == "system" {
            if let Some(text) = message["content"].as_str().filter(|text| !text.is_empty()) {
                message["content"] = json!([{"type":"text","text":text, (field):control}]);
                return true;
            }
        }
    }
    false
}
