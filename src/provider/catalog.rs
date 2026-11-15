//! 모델 목록은 생성 요청 없이 조회한다. 다음 페이지는 같은 endpoint의 query로만 지정한다.

use super::{Profile, ProviderError, http_client, http_error, send, transport_error};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::{BTreeMap, HashSet}, time::Duration};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_MODELS: usize = 2000;
const MAX_PAGES: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct ModelServiceTier {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Default, Serialize, ts_rs::TS)]
pub struct AvailableModel {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reasoning_efforts: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub default_reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub service_tiers: Option<Vec<ModelServiceTier>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub is_default: Option<bool>,
}

fn invalid() -> ProviderError {
    ProviderError::new("catalog_invalid", "공급자의 모델 목록 응답 형식이 올바르지 않습니다")
}

fn page(protocol: &str, value: &Value) -> Result<(Vec<AvailableModel>, Option<String>), ProviderError> {
    if !value.is_object() || value.get("error").is_some() { return Err(invalid()); }
    let field = if protocol == "gemini" { "models" } else { "data" };
    // Gemini의 비어 있는 repeated 필드는 ProtoJSON에서 생략할 수 있다.
    let empty = vec![];
    let rows = if protocol == "gemini" && value.get(field).is_none() { &empty }
        else { value[field].as_array().ok_or_else(invalid)? };
    let mut models = Vec::new();
    for row in rows {
        if protocol == "gemini" && let Some(methods) = row.get("supportedGenerationMethods") {
            let methods = methods.as_array().ok_or_else(invalid)?;
            if !methods.iter().all(Value::is_string) { return Err(invalid()); }
            if !methods.iter().any(|m| m == "generateContent") { continue; }
        }
        let raw = row[if protocol == "gemini" { "name" } else { "id" }].as_str().ok_or_else(invalid)?;
        let id = if protocol == "gemini" { raw.strip_prefix("models/").unwrap_or(raw) } else { raw };
        if id.is_empty() || id.len() > 200 || id.contains(char::is_whitespace) { return Err(invalid()); }
        let label = match protocol { "anthropic" => "display_name", "gemini" => "displayName", _ => "id" };
        let name = match row.get(label) {
            None | Some(Value::Null) => id,
            Some(Value::String(name)) => name,
            _ => return Err(invalid()),
        };
        models.push(AvailableModel { id: id.into(), name: name.chars().take(200).collect(), ..Default::default() });
    }
    let next = match protocol {
        "anthropic" => match value["has_more"].as_bool() {
            Some(true) => Some(value["last_id"].as_str().filter(|s| !s.is_empty()).ok_or_else(invalid)?.to_string()),
            Some(false) => None,
            None => return Err(invalid()),
        },
        "gemini" => match value.get("nextPageToken") {
            None | Some(Value::Null) => None,
            Some(Value::String(token)) if token.is_empty() => None,
            Some(Value::String(token)) => Some(token.clone()),
            _ => return Err(invalid()),
        },
        _ => None,
    };
    Ok((models, next))
}

pub async fn list_models(profile: &Profile) -> Result<Vec<AvailableModel>, ProviderError> {
    tokio::time::timeout(Duration::from_secs(30), fetch(profile)).await
        .map_err(|_| ProviderError::new("catalog_timeout", "모델 목록 조회 시간을 초과했습니다"))?
}

async fn fetch(profile: &Profile) -> Result<Vec<AvailableModel>, ProviderError> {
    if super::cli::is_cli(&profile.protocol) {
        return super::cli::list_models(&profile.protocol).await;
    }
    let base = profile.base_url.trim_end_matches('/');
    let url = match profile.protocol.as_str() {
        "openai" => format!("{base}/models"),
        "anthropic" => format!("{base}/v1/models"),
        "gemini" => format!("{base}/v1beta/models"),
        _ => return Err(ProviderError::new("catalog_unsupported", "이 백엔드의 모델 목록 자동 조회는 지원하지 않습니다. 모델 이름을 수동 입력하세요")),
    };
    let client = http_client(Duration::from_secs(15));
    let mut cursor: Option<String> = None;
    let mut visited = HashSet::new();
    let mut models = BTreeMap::new();
    let mut total_bytes = 0;
    for _ in 0..MAX_PAGES {
        let mut request = client.get(&url);
        match profile.protocol.as_str() {
            "anthropic" => {
                request = request.header("anthropic-version", super::anthropic::API_VERSION).query(&[("limit", "1000")]);
                if let Some(cursor) = &cursor { request = request.query(&[("after_id", cursor)]); }
                if let Some(key) = &profile.api_key { request = request.header("x-api-key", key); }
            }
            "gemini" => {
                request = request.query(&[("pageSize", "1000")]);
                if let Some(cursor) = &cursor { request = request.query(&[("pageToken", cursor)]); }
                if let Some(key) = &profile.api_key { request = request.header("x-goog-api-key", key); }
            }
            _ => if let Some(key) = &profile.api_key { request = request.bearer_auth(key); },
        }
        for (name, value) in &profile.extra_headers { request = request.header(name, value); }
        let mut response = send(request).await?;
        if !response.status().is_success() { return Err(http_error(response).await); }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
            total_bytes += chunk.len();
            if total_bytes > MAX_BYTES {
                return Err(ProviderError::new("catalog_too_large", "모델 목록 응답의 크기 제한을 넘었습니다"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        let (rows, next) = page(&profile.protocol, &value)?;
        for row in rows { models.entry(row.id.clone()).or_insert(row); }
        if models.len() > MAX_MODELS { return Err(ProviderError::new("catalog_too_large", "모델 목록 개수 제한을 넘었습니다")); }
        let Some(next) = next else { return Ok(models.into_values().collect()); };
        if !visited.insert(next.clone()) {
            return Err(ProviderError::new("catalog_invalid", "모델 목록의 다음 페이지가 반복되어 조회를 중단했습니다"));
        }
        cursor = Some(next);
    }
    Err(ProviderError::new("catalog_too_large", "모델 목록 페이지 제한을 넘었습니다. 일부 목록을 완전한 결과로 표시하지 않습니다"))
}
