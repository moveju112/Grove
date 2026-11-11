//! OpenAI 호환 Chat Completions streaming(MODEL-001/003). OpenRouter·DeepSeek·xAI·Groq·Mistral 등 호환 endpoint 공용.

use super::sse::read_events;
use super::*;
use std::collections::BTreeMap;

pub fn build_body(profile: &Profile, req: &ModelRequest) -> Value {
    let mut msgs = vec![];
    if !req.system.is_empty() {
        msgs.push(json!({ "role": "system", "content": req.system }));
    }
    for m in &req.messages {
        match m {
            ChatMsg::User { text, images } => {
                let content=if images.is_empty() {json!(text)} else {
                    let mut parts=vec![json!({"type":"text","text":text})];
                    parts.extend(images.iter().map(|i|json!({"type":"image_url","image_url":{"url":format!("data:{};base64,{}",i.mime,i.data)}})));
                    json!(parts)
                };
                msgs.push(json!({"role":"user","content":content}));
            },
            ChatMsg::Assistant { text, tool_calls, .. } => {
                let mut v = json!({ "role": "assistant", "content": if text.is_empty() && !tool_calls.is_empty() { Value::Null } else { json!(text) } });
                if !tool_calls.is_empty() {
                    v["tool_calls"] = tool_calls
                        .iter()
                        .map(|c| json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": c.arguments.to_string() } }))
                        .collect();
                }
                msgs.push(v);
            }
            ChatMsg::Tool { call_id, content, .. } => {
                msgs.push(json!({ "role": "tool", "tool_call_id": call_id, "content": content }))
            }
        }
    }
    let mut body = json!({
        "model": profile.model,
        "messages": msgs,
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    if !req.tools.is_empty() {
        body["tools"] = req
            .tools
            .iter()
            .map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.schema } }))
            .collect();
    }
    if let Some(m) = req.max_tokens {
        body["max_tokens"] = json!(m);
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(e) = &req.effort {
        body["reasoning_effort"] = json!(e);
    }
    body
}

#[derive(Default)]
struct PartialCall {
    id: String,
    name: String,
    args: String,
}

/// delta 누적기. index별로 호출을 모으고 최종 순서는 index 순서로 보존한다(ADAPTER-004).
#[derive(Default)]
pub struct Accumulator {
    out: ModelOutput,
    calls: BTreeMap<u64, PartialCall>,
    finished: bool,
}

impl Accumulator {
    pub fn apply(&mut self, chunk: &Value) -> Result<(), ProviderError> {
        if let Some(err) = chunk.get("error") {
            let msg = err["message"].as_str().unwrap_or("provider stream error").to_string();
            return Err(ProviderError::new("provider_error", msg));
        }
        if let Some(u) = chunk.get("usage").filter(|u| !u.is_null()) {
            self.out.usage = Usage {
                input_tokens: u["prompt_tokens"].as_u64().unwrap_or(0),
                output_tokens: u["completion_tokens"].as_u64().unwrap_or(0),
                cache_read_tokens: u["prompt_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0),
                cache_write_tokens: None,
                reasoning_tokens: u["completion_tokens_details"]["reasoning_tokens"].as_u64(),
            };
        }
        let Some(choice) = chunk["choices"].get(0) else { return Ok(()) };
        let d = &choice["delta"];
        if let Some(t) = d["content"].as_str() {
            self.out.text.push_str(t);
        }
        for key in ["reasoning_content", "reasoning"] {
            if let Some(t) = d[key].as_str() {
                self.out.reasoning.push_str(t);
            }
        }
        if let Some(tcs) = d["tool_calls"].as_array() {
            for (pos, tc) in tcs.iter().enumerate() {
                let idx = tc["index"].as_u64().unwrap_or(pos as u64);
                let e = self.calls.entry(idx).or_default();
                if let Some(id) = tc["id"].as_str() {
                    e.id = id.to_string();
                }
                if let Some(n) = tc["function"]["name"].as_str() {
                    e.name.push_str(n);
                }
                if let Some(a) = tc["function"]["arguments"].as_str() {
                    e.args.push_str(a);
                }
            }
        }
        if let Some(fr) = choice["finish_reason"].as_str() {
            self.out.finish_reason = fr.to_string();
            self.finished = true;
        }
        if self.out.text.len() > MAX_OUTPUT_BYTES {
            return Err(ProviderError::new("output_too_large", "응답이 너무 큽니다"));
        }
        Ok(())
    }

    pub fn snapshot(&self) -> ModelOutput {
        let mut o = self.out.clone();
        o.tool_calls = self.calls_vec();
        o
    }

    fn calls_vec(&self) -> Vec<ToolCall> {
        self.calls
            .values()
            .enumerate()
            .map(|(i, c)| ToolCall {
                id: if c.id.is_empty() { format!("call_{i}") } else { c.id.clone() },
                name: c.name.clone(),
                arguments: parse_arguments(&c.args),
            })
            .collect()
    }

    pub fn finish(self, saw_done: bool) -> Result<ModelOutput, ProviderError> {
        if !self.finished && !saw_done {
            return Err(ProviderError { code: "stream_incomplete", message: "응답 stream이 완료 전에 끊겼습니다".into(), status: None, retryable: true, retry_after_secs: None });
        }
        let mut o = self.out.clone();
        o.tool_calls = self.calls_vec();
        if o.tool_calls.iter().any(|c| c.name.is_empty()) {
            return Err(ProviderError::new("invalid_tool_call", "이름 없는 도구 호출을 받았습니다"));
        }
        Ok(o)
    }
}

pub async fn stream(client: &reqwest::Client, profile: &Profile, req: &ModelRequest, on_delta: OnDelta<'_>) -> Result<ModelOutput, ProviderError> {
    let url = format!("{}/chat/completions", profile.base_url.trim_end_matches('/'));
    let mut rb = client.post(url).json(&build_body(profile, req)).header("accept", "text/event-stream");
    if let Some(k) = &profile.api_key {
        rb = rb.bearer_auth(k);
    }
    for (k, v) in &profile.extra_headers {
        rb = rb.header(k, v);
    }
    let resp = super::send(rb).await?;
    if !resp.status().is_success() {
        return Err(http_error(resp).await);
    }
    let mut acc = Accumulator::default();
    let mut saw_done = false;
    read_events(resp, |ev| {
        if ev.data == "[DONE]" {
            saw_done = true;
            return Ok(true);
        }
        let v: Value = serde_json::from_str(&ev.data).map_err(|e| ProviderError::new("bad_frame", format!("stream frame 파싱 실패: {e}")))?;
        acc.apply(&v)?;
        on_delta(&acc.snapshot());
        Ok(false)
    })
    .await?;
    acc.finish(saw_done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulates_parallel_tool_calls_in_index_order() {
        let mut a = Accumulator::default();
        let frames = [
            json!({ "choices": [{ "delta": { "content": "생각" } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 1, "id": "b", "function": { "name": "read", "arguments": "{\"pa" } }] } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "a", "function": { "name": "list", "arguments": "{}" } }] } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 1, "function": { "arguments": "th\":\"x\"}" } }] } }] }),
            json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] }),
            json!({ "choices": [], "usage": { "prompt_tokens": 10, "completion_tokens": 5 } }),
        ];
        for f in &frames {
            a.apply(f).unwrap();
        }
        let o = a.finish(true).unwrap();
        assert_eq!(o.text, "생각");
        assert_eq!(o.tool_calls.len(), 2);
        assert_eq!(o.tool_calls[0].id, "a");
        assert_eq!(o.tool_calls[1].arguments, json!({ "path": "x" }));
        assert_eq!(o.usage.input_tokens, 10);
    }

    #[test]
    fn invalid_json_arguments_are_marked_not_dropped() {
        let mut a = Accumulator::default();
        a.apply(&json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "x", "function": { "name": "read", "arguments": "{bad" } }] }, "finish_reason": "tool_calls" }] })).unwrap();
        let o = a.finish(false).unwrap();
        assert_eq!(o.tool_calls[0].arguments["__invalid_json"], "{bad");
    }

    #[test]
    fn truncated_stream_is_error() {
        let mut a = Accumulator::default();
        a.apply(&json!({ "choices": [{ "delta": { "content": "부분" } }] })).unwrap();
        let e = a.finish(false).unwrap_err();
        assert_eq!(e.code, "stream_incomplete");
    }

    #[test]
    fn body_maps_history() {
        let p = Profile { protocol: "openai".into(), base_url: "http://x".into(), model: "m".into(), api_key: None, timeout: Duration::from_secs(1), extra_headers: vec![], sensitive_headers: vec![] };
        let req = ModelRequest {
            system: "sys".into(),
            messages: vec![
                ChatMsg::User { text: "hi".into(), images: vec![] },
                ChatMsg::Assistant { text: String::new(), native: None, tool_calls: vec![ToolCall { id: "c1".into(), name: "read".into(), arguments: json!({ "path": "a" }) }] },
                ChatMsg::Tool { call_id: "c1".into(), name: "read".into(), content: "data".into(), is_error: false },
            ],
            tools: vec![],
            max_tokens: Some(100),
            temperature: None,
            effort: None,
            cli: None,
        };
        let b = build_body(&p, &req);
        assert_eq!(b["messages"][0]["role"], "system");
        assert!(b["messages"][2]["content"].is_null());
        assert_eq!(b["messages"][2]["tool_calls"][0]["function"]["arguments"], "{\"path\":\"a\"}");
        assert_eq!(b["messages"][3]["tool_call_id"], "c1");
        assert_eq!(b["max_tokens"], 100);
    }
}
