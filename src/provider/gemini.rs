//! Gemini API(v1beta streamGenerateContent, alt=sse) 어댑터(MODEL-004).
//! Gemini는 호출 ID가 없으므로 서버가 `gemini_<step>_<n>` 형식으로 부여하고 결과는 이름으로 대응시킨다.

use super::sse::read_events;
use super::*;

pub fn build_body(req: &ModelRequest) -> Value {
    let mut contents: Vec<Value> = vec![];
    let push = |contents: &mut Vec<Value>, role: &str, part: Value| {
        if let Some(last) = contents.last_mut() {
            if last["role"] == role {
                last["parts"].as_array_mut().expect("parts").push(part);
                return;
            }
        }
        contents.push(json!({ "role": role, "parts": [part] }));
    };
    for m in &req.messages {
        match m {
            ChatMsg::User { text, images } => {
                push(&mut contents, "user", json!({ "text": text }));
                for i in images {push(&mut contents,"user",json!({"inlineData":{"mimeType":i.mime,"data":i.data}}));}
            },
            ChatMsg::Assistant { text, tool_calls } => {
                if !text.is_empty() {
                    push(&mut contents, "model", json!({ "text": text }));
                }
                for c in tool_calls {
                    let args = if c.arguments.get("__invalid_json").is_some() { json!({}) } else { c.arguments.clone() };
                    push(&mut contents, "model", json!({ "functionCall": { "name": c.name, "args": args } }));
                }
            }
            ChatMsg::Tool { name, content, is_error, .. } => {
                let key = if *is_error { "error" } else { "output" };
                push(&mut contents, "user", json!({ "functionResponse": { "name": name, "response": { key: content } } }));
            }
        }
    }
    let mut body = json!({ "contents": contents });
    if !req.system.is_empty() {
        body["systemInstruction"] = json!({ "parts": [{ "text": req.system }] });
    }
    if !req.tools.is_empty() {
        body["tools"] = json!([{ "functionDeclarations": req.tools.iter().map(|t| json!({ "name": t.name, "description": t.description, "parameters": t.schema })).collect::<Vec<_>>() }]);
    }
    let mut gc = json!({});
    if let Some(m) = req.max_tokens {
        gc["maxOutputTokens"] = json!(m);
    }
    if let Some(t) = req.temperature {
        gc["temperature"] = json!(t);
    }
    if let Some(e) = &req.effort {
        gc["thinkingConfig"] = json!({ "thinkingBudget": super::effort_budget(e) });
    }
    if gc.as_object().is_some_and(|o| !o.is_empty()) {
        body["generationConfig"] = gc;
    }
    body
}

#[derive(Default)]
pub struct Accumulator {
    out: ModelOutput,
    finished: bool,
}

impl Accumulator {
    pub fn apply(&mut self, v: &Value) -> Result<(), ProviderError> {
        if let Some(e) = v.get("error") {
            return Err(ProviderError::new("provider_error", e["message"].as_str().unwrap_or("stream error").to_string()));
        }
        if let Some(u) = v.get("usageMetadata") {
            // 생각 token은 출력으로 과금되므로 output에 포함하고 reasoning에 따로 남긴다.
            self.out.usage = Usage {
                input_tokens: u["promptTokenCount"].as_u64().unwrap_or(0),
                output_tokens: u["candidatesTokenCount"].as_u64().unwrap_or(0) + u["thoughtsTokenCount"].as_u64().unwrap_or(0),
                cache_read_tokens: u["cachedContentTokenCount"].as_u64().unwrap_or(0),
                cache_write_tokens: None,
                reasoning_tokens: u["thoughtsTokenCount"].as_u64(),
            };
        }
        if let Some(fb) = v["promptFeedback"]["blockReason"].as_str() {
            return Err(ProviderError::new("blocked", format!("요청이 차단되었습니다: {fb}")));
        }
        let Some(c) = v["candidates"].get(0) else { return Ok(()) };
        if let Some(parts) = c["content"]["parts"].as_array() {
            for p in parts {
                if p["thought"].as_bool() == Some(true) {
                    self.out.reasoning.push_str(p["text"].as_str().unwrap_or(""));
                } else if let Some(t) = p["text"].as_str() {
                    self.out.text.push_str(t);
                } else if let Some(fc) = p.get("functionCall") {
                    let n = self.out.tool_calls.len();
                    let args = fc["args"].clone();
                    self.out.tool_calls.push(ToolCall {
                        id: fc["id"].as_str().map(String::from).unwrap_or_else(|| format!("gemini_{n}")),
                        name: fc["name"].as_str().unwrap_or("").to_string(),
                        arguments: if args.is_object() { args } else { json!({}) },
                    });
                }
            }
        }
        if let Some(fr) = c["finishReason"].as_str() {
            self.out.finish_reason = fr.to_string();
            self.finished = true;
            if matches!(fr, "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII") {
                return Err(ProviderError::new("blocked", format!("응답이 차단되었습니다: {fr}")));
            }
        }
        Ok(())
    }
    pub fn snapshot(&self) -> ModelOutput {
        self.out.clone()
    }
    pub fn finish(self) -> Result<ModelOutput, ProviderError> {
        if !self.finished {
            return Err(ProviderError { code: "stream_incomplete", message: "응답 stream이 완료 전에 끊겼습니다".into(), status: None, retryable: true, retry_after_secs: None });
        }
        Ok(self.out)
    }
}

fn endpoint(profile: &Profile) -> Result<reqwest::Url, ProviderError> {
    let mut url = reqwest::Url::parse(&format!("{}/v1beta/models/", profile.base_url.trim_end_matches('/')))
        .map_err(|_| ProviderError::new("invalid_request", "Gemini endpoint URL이 올바르지 않습니다"))?;
    url.path_segments_mut().map_err(|_| ProviderError::new("invalid_request", "Gemini endpoint에 경로를 지정할 수 없습니다"))?
        .pop_if_empty().push(&format!("{}:streamGenerateContent", profile.model));
    url.query_pairs_mut().append_pair("alt", "sse");
    Ok(url)
}

pub async fn stream(client: &reqwest::Client, profile: &Profile, req: &ModelRequest, on_delta: OnDelta<'_>) -> Result<ModelOutput, ProviderError> {
    let url = endpoint(profile)?;
    let mut rb = client.post(url).json(&build_body(req));
    if let Some(k) = &profile.api_key {
        // 키를 URL query에 넣지 않는다(로그·오류 노출 방지).
        rb = rb.header("x-goog-api-key", k);
    }
    for (k, v) in &profile.extra_headers {
        rb = rb.header(k, v);
    }
    let resp = super::send(rb).await?;
    if !resp.status().is_success() {
        return Err(http_error(resp).await);
    }
    let mut acc = Accumulator::default();
    read_events(resp, |ev| {
        let v: Value = serde_json::from_str(&ev.data).map_err(|e| ProviderError::new("bad_frame", format!("stream frame 파싱 실패: {e}")))?;
        acc.apply(&v)?;
        on_delta(&acc.snapshot());
        Ok(false)
    })
    .await?;
    acc.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_identifier_cannot_change_the_endpoint_path_query_or_fragment() {
        let profile = Profile {
            protocol: "gemini".into(), base_url: "http://127.0.0.1:7/prefix".into(),
            model: "../../other?x=y#fragment".into(), api_key: None,
            timeout: std::time::Duration::from_secs(5), extra_headers: vec![],
        };
        let url = endpoint(&profile).unwrap();
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert_eq!(url.port(), Some(7));
        assert!(url.path().starts_with("/prefix/v1beta/models/"));
        assert_eq!(url.path_segments().unwrap().count(), 4);
        assert_eq!(url.query_pairs().collect::<Vec<_>>(), vec![("alt".into(), "sse".into())]);
        assert!(url.fragment().is_none());
    }

    #[test]
    fn function_calls_and_usage() {
        let mut a = Accumulator::default();
        a.apply(&json!({ "candidates": [{ "content": { "parts": [{ "text": "보자" }] } }] })).unwrap();
        a.apply(&json!({ "candidates": [{ "content": { "parts": [{ "functionCall": { "name": "read", "args": { "path": "a" } } }] }, "finishReason": "STOP" }],
                         "usageMetadata": { "promptTokenCount": 3, "candidatesTokenCount": 4 } })).unwrap();
        let o = a.finish().unwrap();
        assert_eq!(o.text, "보자");
        assert_eq!(o.tool_calls[0].name, "read");
        assert_eq!(o.tool_calls[0].id, "gemini_0");
        assert_eq!(o.usage.output_tokens, 4);
    }

    #[test]
    fn safety_block_is_error() {
        let mut a = Accumulator::default();
        let e = a.apply(&json!({ "candidates": [{ "finishReason": "SAFETY" }] })).unwrap_err();
        assert_eq!(e.code, "blocked");
    }

    #[test]
    fn body_roles_alternate() {
        let req = ModelRequest {
            system: "s".into(),
            messages: vec![
                ChatMsg::User { text: "q".into(), images: vec![] },
                ChatMsg::Assistant { text: "".into(), tool_calls: vec![ToolCall { id: "g".into(), name: "read".into(), arguments: json!({ "p": 1 }) }] },
                ChatMsg::Tool { call_id: "g".into(), name: "read".into(), content: "r".into(), is_error: false },
            ],
            tools: vec![ToolDef { name: "read".into(), description: "d".into(), schema: json!({ "type": "object" }) }],
            max_tokens: Some(10),
            temperature: None,
            effort: None,
            cli: None,
        };
        let b = build_body(&req);
        assert_eq!(b["contents"].as_array().unwrap().len(), 3);
        assert_eq!(b["contents"][1]["role"], "model");
        assert_eq!(b["contents"][2]["parts"][0]["functionResponse"]["response"]["output"], "r");
        assert_eq!(b["generationConfig"]["maxOutputTokens"], 10);
    }
}
