//! Anthropic Messages API streaming(MODEL-002).

use super::sse::read_events;
use super::*;

pub const API_VERSION: &str = "2023-06-01";

pub fn build_body(profile: &Profile, req: &ModelRequest) -> Value {
    let mut msgs: Vec<Value> = vec![];
    // 연속된 tool 결과는 user 메시지 하나의 tool_result 블록들로 묶는다.
    for m in &req.messages {
        match m {
            ChatMsg::User { text, images } => {
                if !text.is_empty() {push_block(&mut msgs, "user", json!({ "type": "text", "text": text }));}
                for i in images {push_block(&mut msgs,"user",json!({"type":"image","source":{"type":"base64","media_type":i.mime,"data":i.data}}));}
            },
            ChatMsg::Assistant { text, tool_calls, native } => {
                if let Some(native) = native.as_ref().filter(|n| n.protocol == "anthropic") {
                    msgs.push(json!({ "role": "assistant", "content": native.blocks }));
                    continue;
                }
                let mut blocks = vec![];
                if !text.is_empty() {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
                for c in tool_calls {
                    let input = if c.arguments.get("__invalid_json").is_some() { json!({}) } else { c.arguments.clone() };
                    blocks.push(json!({ "type": "tool_use", "id": c.id, "name": c.name, "input": input }));
                }
                if blocks.is_empty() {
                    blocks.push(json!({ "type": "text", "text": "" }));
                }
                msgs.push(json!({ "role": "assistant", "content": blocks }));
            }
            ChatMsg::Tool { call_id, content, is_error, .. } => push_block(
                &mut msgs,
                "user",
                json!({ "type": "tool_result", "tool_use_id": call_id, "content": content, "is_error": is_error }),
            ),
        }
    }
    let mut body = json!({
        "model": profile.model,
        "messages": msgs,
        "max_tokens": req.max_tokens.unwrap_or(8192),
        "stream": true,
    });
    if !req.system.is_empty() {
        body["system"] = json!(req.system);
    }
    if !req.tools.is_empty() {
        body["tools"] = req.tools.iter().map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.schema })).collect();
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(e) = &req.effort {
        let b = super::effort_budget(e);
        body["thinking"] = json!({ "type": "enabled", "budget_tokens": b });
        body["max_tokens"] = json!(req.max_tokens.unwrap_or(8192).max(b + 4096));
        if let Some(o) = body.as_object_mut() {
            o.remove("temperature");
        }
    }
    body
}

fn push_block(msgs: &mut Vec<Value>, role: &str, block: Value) {
    if let Some(last) = msgs.last_mut() {
        // tool_result 뒤에 오는 사용자 텍스트도 같은 user 메시지로 합쳐야 role이 교대한다.
        if last["role"] == role {
            last["content"].as_array_mut().expect("content array").push(block);
            return;
        }
    }
    msgs.push(json!({ "role": role, "content": [block] }));
}

#[derive(Default)]
pub struct Accumulator {
    out: ModelOutput,
    /// index → (id, name, partial json)
    blocks: Vec<(u64, String, String, String)>,
    content: std::collections::BTreeMap<u64, Value>,
    stopped: bool,
}

impl Accumulator {
    pub fn apply(&mut self, event: Option<&str>, data: &Value) -> Result<(), ProviderError> {
        let ty = data["type"].as_str().or(event).unwrap_or("");
        match ty {
            "message_start" => {
                let u = &data["message"]["usage"];
                // Anthropic의 input_tokens는 cache 읽기·쓰기를 뺀 값이다. 다른 provider와 같게 "전체 입력"으로 맞춘다.
                let cr = u["cache_read_input_tokens"].as_u64().unwrap_or(0);
                let cw = u["cache_creation_input_tokens"].as_u64();
                self.out.usage.input_tokens = u["input_tokens"].as_u64().unwrap_or(0) + cr + cw.unwrap_or(0);
                self.out.usage.cache_read_tokens = cr;
                self.out.usage.cache_write_tokens = cw;
                self.out.usage.output_tokens = u["output_tokens"].as_u64().unwrap_or(0);
            }
            "content_block_start" => {
                let b = &data["content_block"];
                self.content.insert(data["index"].as_u64().unwrap_or(0), b.clone());
                if b["type"] == "tool_use" {
                    let idx = data["index"].as_u64().unwrap_or(0);
                    self.blocks.push((idx, b["id"].as_str().unwrap_or("").into(), b["name"].as_str().unwrap_or("").into(), String::new()));
                } else if b["type"] == "text" {
                    if let Some(t) = b["text"].as_str() {
                        self.out.text.push_str(t);
                    }
                } else if b["type"] == "thinking" {
                    self.out.reasoning.push_str(b["thinking"].as_str().unwrap_or(""));
                }
            }
            "content_block_delta" => {
                let d = &data["delta"];
                if let Some(block) = self.content.get_mut(&data["index"].as_u64().unwrap_or(0)) {
                    let pair = match d["type"].as_str() {
                        Some("text_delta") => Some(("text", "text")),
                        Some("thinking_delta") => Some(("thinking", "thinking")),
                        Some("signature_delta") => Some(("signature", "signature")),
                        _ => None,
                    };
                    if let Some((key, delta)) = pair {
                        let mut value = block[key].as_str().unwrap_or("").to_string();
                        value.push_str(d[delta].as_str().unwrap_or(""));
                        block[key] = json!(value);
                    }
                }
                match d["type"].as_str() {
                    Some("text_delta") => self.out.text.push_str(d["text"].as_str().unwrap_or("")),
                    Some("thinking_delta") => self.out.reasoning.push_str(d["thinking"].as_str().unwrap_or("")),
                    Some("input_json_delta") => {
                        let idx = data["index"].as_u64().unwrap_or(0);
                        if let Some(b) = self.blocks.iter_mut().find(|b| b.0 == idx) {
                            b.3.push_str(d["partial_json"].as_str().unwrap_or(""));
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(r) = data["delta"]["stop_reason"].as_str() {
                    self.out.finish_reason = r.to_string();
                }
                if let Some(o) = data["usage"]["output_tokens"].as_u64() {
                    self.out.usage.output_tokens = o;
                }
            }
            "message_stop" => self.stopped = true,
            "error" => {
                let e = &data["error"];
                let code = match e["type"].as_str() {
                    Some("overloaded_error") => "provider_unavailable",
                    Some("rate_limit_error") => "rate_limited",
                    _ => "provider_error",
                };
                return Err(ProviderError {
                    code,
                    message: e["message"].as_str().unwrap_or("stream error").to_string(),
                    status: None,
                    retryable: code != "provider_error",
                    retry_after_secs: None,
                });
            }
            _ => {}
        }
        if self.out.text.len() > MAX_OUTPUT_BYTES {
            return Err(ProviderError::new("output_too_large", "응답이 너무 큽니다"));
        }
        Ok(())
    }

    fn calls(&self) -> Vec<ToolCall> {
        let mut b = self.blocks.clone();
        b.sort_by_key(|x| x.0);
        b.into_iter().map(|(index, id, name, args)| {
            let arguments = if args.is_empty() {
                self.content.get(&index).and_then(|b| b.get("input")).cloned().unwrap_or_else(|| json!({}))
            } else { parse_arguments(&args) };
            ToolCall { id, name, arguments }
        }).collect()
    }

    pub fn snapshot(&self) -> ModelOutput {
        let mut o = self.out.clone();
        o.tool_calls = self.calls();
        o
    }

    pub fn finish(self) -> Result<ModelOutput, ProviderError> {
        if !self.stopped {
            return Err(ProviderError { code: "stream_incomplete", message: "응답 stream이 완료 전에 끊겼습니다".into(), status: None, retryable: true, retry_after_secs: None });
        }
        let mut o = self.out.clone();
        o.tool_calls = self.calls();
        let mut content = self.content;
        for (index, _, _, args) in self.blocks {
            if let Some(block) = content.get_mut(&index) {
                if !args.is_empty() { block["input"] = parse_arguments(&args); }
            }
        }
        o.native = Some(NativeContent {
            protocol: "anthropic".into(), base_url: String::new(), model: String::new(),
            blocks: content.into_values().collect(),
        });
        Ok(o)
    }
}

pub async fn stream(client: &reqwest::Client, profile: &Profile, req: &ModelRequest, on_delta: OnDelta<'_>) -> Result<ModelOutput, ProviderError> {
    let url = format!("{}/v1/messages", profile.base_url.trim_end_matches('/'));
    let mut rb = client
        .post(url)
        .json(&build_body(profile, req))
        .header("anthropic-version", API_VERSION)
        .header("accept", "text/event-stream");
    if let Some(k) = &profile.api_key {
        rb = rb.header("x-api-key", k);
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
        acc.apply(ev.event.as_deref(), &v)?;
        on_delta(&acc.snapshot());
        Ok(acc.stopped)
    })
    .await?;
    acc.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_use_and_text_accumulate() {
        let mut a = Accumulator::default();
        let evs = [
            json!({ "type": "message_start", "message": { "usage": { "input_tokens": 7, "output_tokens": 1 } } }),
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "확인" } }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "tu1", "name": "read" } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"path\":" } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "\"a.txt\"}" } }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 12 } }),
            json!({ "type": "message_stop" }),
        ];
        for e in &evs {
            a.apply(None, e).unwrap();
        }
        let o = a.finish().unwrap();
        assert_eq!(o.text, "확인");
        assert_eq!(o.tool_calls[0].arguments, json!({ "path": "a.txt" }));
        assert_eq!(o.usage.output_tokens, 12);
        assert_eq!(o.finish_reason, "tool_use");
    }

    /// Anthropic input_tokens는 cache를 뺀 값이므로 전체 입력으로 맞춘다(다른 provider와 같은 의미).
    #[test]
    fn input_includes_cache_read_and_write() {
        let mut a = Accumulator::default();
        a.apply(None, &json!({ "type": "message_start", "message": { "usage": { "input_tokens": 7, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20, "output_tokens": 1 } } }))
            .unwrap();
        let u = &a.out.usage;
        assert_eq!(u.input_tokens, 127);
        assert_eq!(u.cache_read_tokens, 100);
        assert_eq!(u.cache_write_tokens, Some(20));
        assert_eq!(u.reasoning_tokens, None);
    }

    #[test]
    fn tool_results_grouped_into_one_user_message() {
        let p = Profile { protocol: "anthropic".into(), base_url: "http://x".into(), model: "m".into(), api_key: None, timeout: Duration::from_secs(1), extra_headers: vec![], sensitive_headers: vec![] };
        let req = ModelRequest {
            system: "s".into(),
            messages: vec![
                ChatMsg::User { text: "q".into(), images: vec![] },
                ChatMsg::Assistant { text: "".into(), native: None, tool_calls: vec![
                    ToolCall { id: "a".into(), name: "read".into(), arguments: json!({}) },
                    ToolCall { id: "b".into(), name: "read".into(), arguments: json!({ "__invalid_json": "{" }) },
                ] },
                ChatMsg::Tool { call_id: "a".into(), name: "read".into(), content: "1".into(), is_error: false },
                ChatMsg::Tool { call_id: "b".into(), name: "read".into(), content: "bad".into(), is_error: true },
            ],
            tools: vec![],
            max_tokens: None,
            temperature: None,
            effort: None,
            cli: None,
        };
        let b = build_body(&p, &req);
        let m = b["messages"].as_array().unwrap();
        assert_eq!(m.len(), 3);
        assert_eq!(m[2]["content"].as_array().unwrap().len(), 2);
        assert_eq!(m[1]["content"][1]["input"], json!({}));
        assert_eq!(b["system"], "s");
    }

    #[test]
    fn stream_error_event() {
        let mut a = Accumulator::default();
        let e = a.apply(None, &json!({ "type": "error", "error": { "type": "overloaded_error", "message": "busy" } })).unwrap_err();
        assert_eq!(e.code, "provider_unavailable");
        assert!(e.retryable);
    }
}
