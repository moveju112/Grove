//! 소유자가 확인한 모델 capability. 미확인(null)을 미지원(false)이나 모델명 추측으로 바꾸지 않는다.
use crate::{error::{ApiError, ApiResult}, models::ModelProfile};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct ModelCapabilities {
    #[ts(type = "number | null")]
    pub context_tokens: Option<u64>,
    pub max_output_tokens: Option<u32>,
    pub images: Option<bool>,
    pub tools: Option<bool>,
    /// Grove 도구 루프와 별개로 CLI 자체 편집·실행 도구를 사용하는지.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub native_tools: Option<bool>,
    pub effort: Option<bool>,
    pub temperature: Option<bool>,
    pub pdf: bool,
    pub fast: bool,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Overrides {
    max_output_tokens: Option<u32>,
    images: Option<bool>,
    tools: Option<bool>,
    effort: Option<bool>,
    temperature: Option<bool>,
    pdf: Option<bool>,
    fast: Option<bool>,
}

pub fn resolve(protocol: &str, options: &Value) -> ModelCapabilities {
    let cli = crate::provider::cli::is_cli(protocol);
    let codex_api = protocol == crate::provider::codex_oauth::PROTOCOL;
    let overrides: Overrides = options.get("capabilities").cloned().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    ModelCapabilities {
        context_tokens: options["context_window"].as_u64(),
        max_output_tokens: if cli || codex_api { None } else { overrides.max_output_tokens },
        images: overrides.images.or((cli || codex_api).then_some(true)),
        tools: if cli { Some(false) } else { overrides.tools.or(codex_api.then_some(true)) },
        native_tools: Some(cli),
        effort: overrides.effort.or((cli || codex_api).then_some(true)),
        temperature: if cli || codex_api { Some(false) } else { overrides.temperature },
        // Codex 속도 선택은 실제 모델 목록의 serviceTiers로 제한한다.
        pdf: false,
        fast: is_codex(protocol) && overrides.fast != Some(false),
    }
}

pub(crate) fn is_codex(protocol: &str) -> bool {
    matches!(protocol, "codex_cli" | crate::provider::codex_oauth::PROTOCOL)
}

pub fn validate_options(protocol: &str, options: &Value) -> ApiResult<()> {
    let cli = crate::provider::cli::is_cli(protocol);
    let overrides: Overrides = match options.get("capabilities") {
        Some(value) => serde_json::from_value(value.clone()).map_err(|_| ApiError::invalid(
            "capabilities에는 max_output_tokens(양의 u32)와 images·tools·effort·temperature·pdf·fast(boolean 또는 null)만 허용됩니다",
        ))?,
        None => Overrides::default(),
    };
    if overrides.max_output_tokens == Some(0) {
        return Err(ApiError::invalid("capabilities.max_output_tokens는 양의 정수여야 합니다"));
    }
    if overrides.pdf == Some(true) || (overrides.fast == Some(true) && !is_codex(protocol)) {
        return Err(ApiError::unsupported("native PDF 또는 이 어댑터의 Fast 모드는 지원하지 않습니다"));
    }
    if cli && (overrides.tools == Some(true)
        || overrides.temperature == Some(true) || overrides.max_output_tokens.is_some()
        || options.get("max_tokens").is_some() || options.get("temperature").is_some()) {
        return Err(ApiError::unsupported("CLI 어댑터의 Grove 도구 루프·출력 token 상한·temperature 옵션은 지원하지 않습니다"));
    }
    if protocol == crate::provider::codex_oauth::PROTOCOL && (overrides.temperature == Some(true)
        || overrides.max_output_tokens.is_some() || options.get("max_tokens").is_some()) {
        return Err(ApiError::unsupported("Codex API 연결은 출력 token 상한과 temperature를 지정할 수 없습니다"));
    }
    let caps = resolve(protocol, options);
    if caps.temperature == Some(false) && options.get("temperature").is_some() {
        return Err(ApiError::unsupported("temperature 미지원 모델에서 temperature 옵션을 제거하세요"));
    }
    if let (Some(limit), Some(requested)) = (caps.max_output_tokens, options["max_tokens"].as_u64()) {
        if requested > u64::from(limit) {
            return Err(ApiError::invalid("max_tokens가 확인된 모델 출력 상한을 초과합니다"));
        }
    }
    Ok(())
}

impl ModelProfile {
    pub(crate) fn turn_tools(&self, requested: Option<bool>) -> bool {
        requested.unwrap_or(self.capabilities.tools != Some(false))
    }

    pub fn check_capabilities(&self, tools: bool, effort: Option<&str>, images: bool) -> ApiResult<()> {
        self.check_model_capabilities(&self.model, tools, effort, images)
    }

    pub(crate) fn check_model_capabilities(&self, model: &str, tools: bool, effort: Option<&str>, images: bool) -> ApiResult<()> {
        let native_anthropic = self.protocol == "anthropic" && crate::provider::anthropic_uses_native_effort(model);
        if effort.is_some_and(|e| matches!(e, "xhigh" | "max" | "ultra")
            && !is_codex(&self.protocol)
            && !((self.protocol == "claude_code" || native_anthropic) && crate::provider::CLAUDE_EFFORTS.contains(&e))) {
            return Err(ApiError::unsupported("선택한 모델은 이 추론 옵션을 지원하지 않습니다"));
        }
        for (unsupported, label) in [
            (tools && self.capabilities.tools == Some(false), "Grove 도구 루프"),
            (effort.is_some() && self.capabilities.effort == Some(false), "추론 강도"),
            (images && self.capabilities.images == Some(false), "이미지 입력"),
        ] {
            if unsupported { return Err(ApiError::unsupported(format!("선택한 모델 프로필은 {label}을 지원하지 않습니다"))); }
        }
        // Anthropic은 thinking budget보다 충분히 큰 max_tokens를 요구한다.
        if self.protocol == "anthropic" && !native_anthropic {
            if let (Some(effort), Some(limit)) = (effort, self.capabilities.max_output_tokens) {
                if crate::provider::effort_budget(effort) + 4096 > limit {
                    return Err(ApiError::unsupported("선택한 추론 강도는 확인된 모델 출력 상한을 초과합니다. auto 또는 더 낮은 강도를 선택하세요"));
                }
            }
        }
        Ok(())
    }

    pub fn generation_options(&self) -> (Option<u32>, Option<f64>) {
        if crate::provider::cli::is_cli(&self.protocol) { return (None, None); }
        let max_tokens = self.options["max_tokens"].as_u64().and_then(|n| u32::try_from(n).ok())
            .or_else(|| self.capabilities.max_output_tokens.map(|limit| limit.min(8192)));
        let temperature = if self.capabilities.temperature == Some(false) { None } else { self.options["temperature"].as_f64() };
        (max_tokens, temperature)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unknown_is_not_false_and_transport_limits_cannot_be_overridden() {
        let unknown = resolve("openai", &json!({}));
        assert!(unknown.images.is_none() && unknown.tools.is_none() && unknown.effort.is_none());
        assert!(!unknown.pdf && !unknown.fast);
        assert_eq!(resolve("codex_cli", &json!({})).tools, Some(false));
        assert_eq!(resolve("codex_cli", &json!({})).native_tools, Some(true));
        assert_eq!(resolve("claude_code", &json!({})).native_tools, Some(true));
        assert_eq!(unknown.native_tools, Some(false));
        for capabilities in [json!({"pdf":true}), json!({"fast":true}), json!({"max_output_tokens":0}), json!({"images":"yes"}), json!({"extra":true})] {
            assert!(validate_options("openai", &json!({"capabilities":capabilities})).is_err());
        }
        // 두 CLI는 이미지 입력을 실제 전송하므로 허용한다. Grove 도구 루프·생성 상한은 별개다.
        assert!(validate_options("codex_cli", &json!({"capabilities":{"images":true}})).is_ok());
        assert!(validate_options("claude_code", &json!({"capabilities":{"images":true}})).is_ok());
        assert_eq!(resolve("codex_cli", &json!({"capabilities":{"images":true}})).images, Some(true));
        for capabilities in [json!({"tools":true}), json!({"temperature":true}), json!({"max_output_tokens":100})] {
            assert!(validate_options("codex_cli", &json!({"capabilities":capabilities})).is_err());
        }
    }
}
