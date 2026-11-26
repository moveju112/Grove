use super::{ChatMsg, ModelRequest, NativeContent, Profile, ToolDef, anthropic, gemini, openai};
use serde_json::{Value, json};
use std::time::Duration;

fn profile(protocol: &str, base_url: &str, model: &str) -> Profile {
    Profile {
        protocol: protocol.into(),
        base_url: base_url.into(),
        model: model.into(),
        api_key: None,
        timeout: Duration::from_secs(5),
        extra_headers: vec![],
        sensitive_headers: vec![],
    }
}

fn request() -> ModelRequest {
    ModelRequest {
        system: "Shared policy\nProject root: /synthetic/project".into(),
        messages: vec![ChatMsg::User {
            text: "first question".into(),
            images: vec![],
        }],
        tools: ["write", "read"]
            .into_iter()
            .map(|name| ToolDef {
                name: name.into(),
                description: format!("{name} a file"),
                schema: json!({"type":"object","properties":{"path":{"type":"string"}}}),
            })
            .collect(),
        max_tokens: Some(1024),
        temperature: None,
        effort: None,
        cli: None,
        service_tier: None,
    }
}

#[test]
fn openai_key_is_stable_across_turns_credentials_tool_order_and_generation_options() {
    let mut p = profile("openai", "https://api.openai.com/v1", "gpt-4.1");
    let mut req = request();
    let before = openai::build_body(&p, &req);
    let key = before["prompt_cache_key"].as_str().unwrap();
    assert!(crate::util::valid_sha256(key));
    assert!(!key.contains("synthetic") && !key.contains("question"));
    req.messages.push(ChatMsg::Assistant {
        text: "answer".into(),
        tool_calls: vec![],
        native: None,
    });
    req.messages.push(ChatMsg::User {
        text: "next question".into(),
        images: vec![],
    });
    req.max_tokens = Some(2048);
    req.temperature = Some(0.5);
    req.effort = Some("high".into());
    req.tools.reverse();
    p.extra_headers
        .push(("x-synthetic-scope".into(), "synthetic-header".into()));
    let next = openai::build_body(&p, &req);
    assert_eq!(next["prompt_cache_key"], key);
    assert_eq!(next["tools"], before["tools"]);
    assert_eq!(next["messages"][3]["content"], "next question");
    assert_eq!(next["max_tokens"], 2048);
    assert_eq!(next["reasoning_effort"], "high");
    assert!(next.get("cache_control").is_none());
    assert!(next.get("prompt_cache_retention").is_none());
    assert!(next.get("prompt_cache_options").is_none());
}

#[test]
fn openai_key_changes_with_model_instructions_and_exact_tool_definition() {
    let p = profile("openai", "https://api.openai.com/v1", "gpt-4.1");
    let req = request();
    let before = openai::build_body(&p, &req)["prompt_cache_key"].clone();
    let mut changed = p.clone();
    changed.model = "gpt-5".into();
    assert_ne!(
        openai::build_body(&changed, &req)["prompt_cache_key"],
        before
    );
    let mut changed = req.clone();
    changed.system.push_str("\nChanged policy");
    assert_ne!(openai::build_body(&p, &changed)["prompt_cache_key"], before);
    let mut changed = req.clone();
    changed.tools[0].description.push_str(" differently");
    assert_ne!(openai::build_body(&p, &changed)["prompt_cache_key"], before);
    let mut changed = req.clone();
    changed.tools[0].schema["required"] = json!(["path"]);
    assert_ne!(openai::build_body(&p, &changed)["prompt_cache_key"], before);
    let mut changed = req.clone();
    changed.tools.clear();
    assert_ne!(openai::build_body(&p, &changed)["prompt_cache_key"], before);
}

#[test]
fn modern_openai_models_use_system_breakpoints_without_disabling_history_caching() {
    for (base, model) in [
        ("https://api.openai.com/v1", "gpt-5.6"),
        ("https://api.openai.com/v1", "gpt-5.6-sol-2026-08-25"),
        ("https://api.openai.com/v1", "gpt-6.1-sol"),
        ("https://openrouter.ai/api/v1", "openai/gpt-6.1-sol"),
    ] {
        let p = profile("openai", base, model);
        let mut req = request();
        let body = openai::build_body(&p, &req);
        assert_eq!(body["prompt_cache_options"], json!({"mode":"implicit"}));
        assert_eq!(
            body["messages"][0]["content"][0],
            json!({
                "type":"text","text":req.system,"prompt_cache_breakpoint":{"mode":"explicit"}
            })
        );
        assert_eq!(body["messages"][1]["content"], "first question");
        assert!(body.get("cache_control").is_none());
        req.system.clear();
        let body = openai::build_body(&p, &req);
        assert_eq!(body["messages"][0]["content"], "first question");
    }
    for model in [
        "gpt-4.1",
        "gpt-5.5",
        "o3",
        "custom-gpt-6",
        "gpt-6.invalid",
        "gpt-6.1.2",
    ] {
        let p = profile("openai", "https://api.openai.com/v1", model);
        let body = openai::build_body(&p, &request());
        assert!(body.get("prompt_cache_options").is_none(), "{model}");
        assert!(body["messages"][0]["content"].is_string(), "{model}");
    }
}

#[test]
fn unknown_compatible_endpoints_and_lookalike_hosts_get_no_cache_fields() {
    for base in [
        "http://127.0.0.1:7",
        "https://local.invalid/v1",
        "https://api.deepseek.com",
        "https://api.openai.com.invalid/v1",
        "https://api.openai.com@local.invalid/v1",
        "https://api.anthropic.com.invalid",
        "https://openrouter.ai.invalid/api/v1",
        "http://api.openai.com/v1",
        "https://api.openai.com:8443/v1",
        "https://api.openai.com/v1?target=other",
        "https://api.openai.com/v1#other",
    ] {
        let p = profile("openai", base, "anthropic/claude-sonnet-4-6");
        let body = openai::build_body(&p, &request());
        assert!(body.get("prompt_cache_key").is_none(), "{base}");
        assert!(body.get("cache_control").is_none(), "{base}");
        assert!(body["messages"][0]["content"].is_string(), "{base}");
        let body = anthropic::build_body(&p, &request());
        assert!(body.get("cache_control").is_none(), "{base}");
        assert!(body["system"].is_string(), "{base}");
        assert!(
            body["tools"]
                .as_array()
                .unwrap()
                .iter()
                .all(|tool| tool.get("cache_control").is_none())
        );
    }
}

fn breakpoints(body: &Value) -> usize {
    match body {
        Value::Object(fields) => fields
            .iter()
            .map(|(name, value)| usize::from(name == "cache_control") + breakpoints(value))
            .sum(),
        Value::Array(values) => values.iter().map(breakpoints).sum(),
        _ => 0,
    }
}

#[test]
fn anthropic_caches_tools_system_and_growing_history_without_changing_signed_blocks() {
    let p = profile(
        "anthropic",
        "https://api.anthropic.com",
        "claude-sonnet-4-6",
    );
    let mut req = request();
    let blocks = vec![
        json!({"type":"thinking","thinking":"synthetic thought","signature":"synthetic-signature"}),
        json!({"type":"redacted_thinking","data":"synthetic-redacted"}),
        json!({"type":"tool_use","id":"call","name":"read","input":{"path":"sample"}}),
    ];
    req.messages.push(ChatMsg::Assistant {
        text: String::new(),
        tool_calls: vec![],
        native: Some(NativeContent {
            protocol: p.protocol.clone(),
            base_url: p.base_url.clone(),
            model: p.model.clone(),
            blocks: blocks.clone(),
        }),
    });
    req.messages.push(ChatMsg::Tool {
        call_id: "call".into(),
        name: "read".into(),
        content: "result".into(),
        is_error: false,
    });
    let body = anthropic::build_body(&p, &req);
    assert_eq!(body["cache_control"], json!({"type":"ephemeral"}));
    assert_eq!(body["system"][0]["text"], req.system);
    assert_eq!(body["system"][0]["cache_control"], body["cache_control"]);
    assert_eq!(body["tools"][1]["cache_control"], body["cache_control"]);
    assert!(body["tools"][0].get("cache_control").is_none());
    assert_eq!(breakpoints(&body), 3);
    assert_eq!(body["messages"][1]["content"], json!(blocks));
    assert_eq!(body["messages"][2]["content"][0]["tool_use_id"], "call");
    assert_eq!(body["messages"][2]["content"][0]["content"], "result");
    // 사용자·native·tool 원문은 보존하고 호출자의 요청 구조도 변경하지 않는다.
    assert!(
        matches!(&req.messages[1], ChatMsg::Assistant { native: Some(native), .. } if native.blocks == blocks)
    );
    req.tools.clear();
    req.system.clear();
    let body = anthropic::build_body(&p, &req);
    assert_eq!(breakpoints(&body), 1);
    assert!(body.get("system").is_none() && body.get("tools").is_none());
}

#[test]
fn anthropic_respects_existing_native_breakpoints_without_overwriting_them() {
    let p = profile(
        "anthropic",
        "https://api.anthropic.com",
        "claude-sonnet-4-6",
    );
    for count in 1..=4 {
        let mut req = request();
        let blocks: Vec<_> = (0..count).map(|index| json!({
            "type":"text","text":format!("part {index}"),"cache_control":{"type":"ephemeral"}
        })).collect();
        req.messages.push(ChatMsg::Assistant {
            text: String::new(),
            tool_calls: vec![],
            native: Some(NativeContent {
                protocol: p.protocol.clone(),
                base_url: p.base_url.clone(),
                model: p.model.clone(),
                blocks: blocks.clone(),
            }),
        });
        let body = anthropic::build_body(&p, &req);
        assert!(breakpoints(&body) <= 4);
        assert_eq!(body["messages"][1]["content"], json!(blocks));
    }
}

#[test]
fn anthropic_preserves_existing_long_ttl_without_adding_conflicting_default_breakpoints() {
    let p = profile(
        "anthropic",
        "https://api.anthropic.com",
        "claude-sonnet-4-6",
    );
    let mut req = request();
    let blocks =
        vec![json!({"type":"text","text":"saved","cache_control":{"type":"ephemeral","ttl":"1h"}})];
    req.messages.push(ChatMsg::Assistant {
        text: String::new(),
        tool_calls: vec![],
        native: Some(NativeContent {
            protocol: p.protocol.clone(),
            base_url: p.base_url.clone(),
            model: p.model.clone(),
            blocks: blocks.clone(),
        }),
    });
    let body = anthropic::build_body(&p, &req);
    assert_eq!(breakpoints(&body), 1);
    assert!(body.get("cache_control").is_none());
    assert_eq!(body["system"], req.system);
    assert_eq!(body["messages"][1]["content"], json!(blocks));
}

#[test]
fn openrouter_uses_model_specific_cache_control() {
    for model in [
        "anthropic/claude-sonnet-4-6",
        "openai/gpt-4.1",
        "google/gemini-2.5-pro",
        "google/gemini-3-pro-preview",
        "google/gemini-4-carbon",
        "other/model",
    ] {
        let p = profile("openai", "https://openrouter.ai/api/v1", model);
        let req = request();
        let body = openai::build_body(&p, &req);
        assert!(body["prompt_cache_key"].is_string());
        if model.starts_with("anthropic/") {
            assert_eq!(body["cache_control"], json!({"type":"ephemeral"}));
            assert_eq!(body["messages"][0]["content"][0]["text"], req.system);
            assert_eq!(breakpoints(&body), 2);
        } else if model.starts_with("google/gemini-2.5-") || model.starts_with("google/gemini-3") {
            assert!(body.get("cache_control").is_none());
            assert_eq!(body["messages"][0]["content"][0]["text"], req.system);
            assert_eq!(breakpoints(&body), 1);
        } else {
            assert!(body.get("cache_control").is_none());
            assert_eq!(body["messages"][0]["content"], req.system);
        }
        assert_eq!(body["messages"][1]["content"], "first question");
    }
}

#[test]
fn openrouter_without_system_does_not_mark_current_user_input_as_stable_policy() {
    let mut req = request();
    req.system.clear();
    for model in ["anthropic/claude-sonnet-4-6", "google/gemini-2.5-pro"] {
        let p = profile("openai", "https://openrouter.ai/api/v1", model);
        let body = openai::build_body(&p, &req);
        assert_eq!(body["messages"][0]["content"], "first question");
        assert_eq!(
            breakpoints(&body),
            usize::from(model.starts_with("anthropic/"))
        );
    }
}

#[test]
fn all_http_providers_keep_tool_prefix_stable_and_gemini_uses_implicit_cache() {
    let mut req = request();
    let p = profile(
        "anthropic",
        "https://api.anthropic.com",
        "claude-sonnet-4-6",
    );
    let before = [
        openai::build_body(&p, &req),
        anthropic::build_body(&p, &req),
        gemini::build_body(&req),
    ];
    req.tools.reverse();
    let after = [
        openai::build_body(&p, &req),
        anthropic::build_body(&p, &req),
        gemini::build_body(&req),
    ];
    assert_eq!(before, after);
    let gemini = &after[2];
    assert_eq!(gemini["systemInstruction"]["parts"][0]["text"], req.system);
    assert_eq!(gemini["contents"][0]["parts"][0]["text"], "first question");
    assert!(gemini.get("cachedContent").is_none());
    assert!(gemini.get("cache_control").is_none());
    assert!(gemini.get("prompt_cache_key").is_none());
}

#[test]
fn openai_compatible_cache_write_usage_distinguishes_missing_and_zero() {
    for write in [None, Some(0), Some(800)] {
        let mut usage = json!({"prompt_tokens":2000,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":1000}});
        if let Some(write) = write {
            usage["prompt_tokens_details"]["cache_write_tokens"] = json!(write);
        }
        let mut acc = openai::Accumulator::default();
        acc.apply(&json!({"choices":[],"usage":usage})).unwrap();
        acc.apply(&json!({"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}))
            .unwrap();
        let output = acc.finish(true).unwrap();
        assert_eq!(output.usage.cache_write_tokens, write);
        assert_eq!(output.usage.input_tokens, 2000);
        assert_eq!(output.usage.cache_read_tokens, 1000);
    }
}
