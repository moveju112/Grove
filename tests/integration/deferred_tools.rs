//! CTX-013: 실제 HTTP 모델 요청·승인·복구 경계를 지나는 로컬 fixture 인수.
use crate::common;

use common::{TestServer, fixture::{self, Fixture, Step}};
use grove::{deferred_tools as deferred, tools};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

async fn setup() -> (TestServer, Fixture, String, String, Value) {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("deferred").await;
    let sid = s.create_session(project["id"].as_str().unwrap()).await["id"].as_str().unwrap().to_string();
    (s, f, profile, sid, project)
}

async fn start(s: &TestServer, sid: &str, profile: &str, enabled: bool) -> String {
    let (status, response) = s.post(&format!("/api/v1/sessions/{sid}/turns"),
        json!({"profile_id":profile,"text":"local schema loading request","tools":enabled})).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{response}");
    response["turn"]["id"].as_str().unwrap().into()
}

async fn setting(s: &TestServer, scope: &str, id: &str, key: &str, value: Value) {
    let (status, response) = s.send(Method::PUT, &format!("/api/v1/settings/{scope}/{id}/{key}"),
        json!({"expected_revision":0,"value":value})).await;
    assert_eq!(status, StatusCode::OK, "{response}");
}

fn tool_names(request: &Value) -> Vec<&str> {
    request["tools"].as_array().unwrap().iter().map(|t| t["function"]["name"].as_str().unwrap()).collect()
}

fn load(id: &str, names: Value) -> Step {
    fixture::tool_calls(&[(id, deferred::NAME, json!({"names":names}))])
}

fn call<'a>(turn: &'a Value, id: &str) -> &'a Value {
    turn["tool_calls"].as_array().unwrap().iter().find(|c| c["provider_call_id"] == id).unwrap()
}

#[test]
fn registry_validation_normalization_and_selection_are_bounded_and_deterministic() {
    let root = tempfile::tempdir().unwrap();
    let (spec, planned) = tools::plan(deferred::NAME, &json!({"names":["write"," list ","write"]}), root.path()).unwrap();
    assert_eq!(spec.effect, tools::Effect::Conversation);
    assert!(!tools::needs_approval(spec.effect));
    assert_eq!(planned.target, json!({"names":["list","write"]}));
    assert!(planned.precondition.is_none());
    for args in [
        json!({}), json!({"names":[]}), json!({"names":null}), json!({"names":[1]}),
        json!({"names":["write"],"command":"no"}), json!({"names":vec!["write";9]}),
        json!({"names":["unknown"]}), json!({"names":["load_tool"]}), json!({"names":[" "]}),
        json!({"names":["x".repeat(65)]}),
    ] {
        assert!(tools::plan(deferred::NAME, &args, root.path()).is_err(), "{args}");
    }
    let canonical = deferred::plan(&json!({"names":["list","write"]})).unwrap();
    assert_eq!(canonical.target, planned.target);
    let a = deferred::definitions(tools::specs(), &["write".into(), "list".into()]);
    let b = deferred::definitions(tools::specs().into_iter().rev().collect(), &["list".into(), "write".into()]);
    let values = |defs: &[grove::provider::ToolDef]| defs.iter()
        .map(|d| json!({"name":d.name,"description":d.description,"schema":d.schema})).collect::<Vec<_>>();
    assert_eq!(values(&a), values(&b));
    assert!(a.len() <= deferred::MAX_SELECTED + 3);
    for d in a {
        assert_eq!(d.schema, tools::spec(&d.name).unwrap().schema);
    }
    let initial = grove::runner::tool_defs();
    assert_eq!(initial.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["edit","load_tool","read"]);
    assert!(initial.len() < tools::specs().len());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn loading_reaches_the_next_real_request_then_exact_approval_and_restart_never_reexecute() {
    let (mut s, f, profile, sid, project) = setup().await;
    let path = std::path::Path::new(project["root_path"].as_str().unwrap()).join("approved.txt");
    f.push(load("load-one", json!(["write","list","write"])));
    f.push(fixture::tool_calls(&[("actual-write","write",json!({"path":"approved.txt","content":"approved once"}))]));
    f.push(load("load-two", json!(["list","write"])));
    f.push(fixture::text("approved execution complete"));
    let tid = start(&s, &sid, &profile, true).await;
    let waiting = s.wait_status(&tid, "awaiting_approval").await;
    assert_eq!(call(&waiting,"load-one")["status"], "succeeded");
    assert_eq!(call(&waiting,"load-one")["result"]["selected"], json!(["list","write"]));
    assert_eq!(call(&waiting,"load-one")["result"]["executed"], false);
    assert!(!path.exists(), "schema 조회로 파일을 만들거나 승인을 우회하면 안 된다");
    let write = call(&waiting,"actual-write");
    assert_eq!(write["target"]["path"], "approved.txt");
    assert_eq!(write["needs_approval"], true);
    let decision_path = format!("/api/v1/tool-calls/{}/decision", write["id"].as_str().unwrap());
    let body = json!({"decision":"approve","expected_revision":write["revision"]});
    let first = s.raw(Method::POST, &decision_path, Some(body.clone()), Some("deferred-decision-once"), None).await;
    assert!(first.status().is_success());
    // 응답을 읽지 못한 클라이언트의 재전송과 같은 idempotency key를 쓴다.
    drop(first);
    let done = s.wait_status(&tid,"completed").await;
    assert_eq!(call(&done,"actual-write")["status"], "succeeded");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "approved once");
    std::fs::write(&path, "do not replay").unwrap();
    let replay = s.raw(Method::POST, &decision_path, Some(body), Some("deferred-decision-once"), None).await;
    assert!(replay.status().is_success());
    let requests = f.requests();
    assert_eq!(requests.len(), 4);
    assert_eq!(tool_names(&requests[0]), ["edit","load_tool","read"]);
    assert_eq!(tool_names(&requests[1]), ["edit","list","load_tool","read","write"]);
    assert_eq!(requests[1]["tools"], requests[3]["tools"], "동일 선택은 동일 순서·schema여야 한다");
    for (index, id) in [(1,"load-one"), (2,"actual-write"), (3,"load-two")] {
        let messages = requests[index]["messages"].as_array().unwrap();
        assert_eq!(messages.iter().filter(|m| m["role"] == "tool" && m["tool_call_id"] == id).count(), 1);
        assert!(messages.iter().any(|m| m["role"] == "assistant"
            && m["tool_calls"].as_array().is_some_and(|calls| calls.iter().any(|c| c["id"] == id))));
    }
    for name in ["list","write"] {
        let definition = requests[1]["tools"].as_array().unwrap().iter().find(|t| t["function"]["name"] == name).unwrap();
        assert_eq!(definition["function"]["parameters"], tools::spec(name).unwrap().schema);
    }
    s.restart().await;
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "do not replay");
    assert_eq!(f.requests().len(), 4);
    let (_, restored) = s.get(&format!("/api/v1/turns/{tid}")).await;
    assert_eq!(restored["tool_calls"].as_array().unwrap().len(), 3);
    f.push(fixture::text("fresh selection"));
    let next = start(&s, &sid, &profile, true).await;
    s.wait_status(&next, "completed").await;
    assert_eq!(tool_names(&f.requests()[4]), ["edit","load_tool","read"], "선택은 턴을 넘어 새로 실행되지 않는다");
}

#[tokio::test]
async fn failed_loading_preserves_the_last_success_and_replacement_does_not_accumulate() {
    let (s,f,profile,sid,_) = setup().await;
    f.push(load("good", json!(["list","write"])));
    f.push(load("bad", json!(["missing-tool"])));
    f.push(load("replacement", json!(["shell"])));
    f.push(fixture::text("done"));
    let tid = start(&s,&sid,&profile,true).await;
    let done = s.wait_status(&tid,"completed").await;
    assert_eq!(call(&done,"bad")["result"]["error"]["code"], "unsupported_tool");
    let requests = f.requests();
    assert_eq!(requests[1]["tools"],requests[2]["tools"]);
    assert_eq!(tool_names(&requests[3]), ["edit","load_tool","read","shell"]);
    assert!(done["tool_calls"].as_array().unwrap().iter().all(|c| c["name"] == "load_tool"));
}

#[tokio::test]
async fn parallel_load_calls_choose_by_model_call_order_and_do_not_leak_to_another_session() {
    let (s,f,profile,sid,project) = setup().await;
    f.push(fixture::tool_calls(&[
        ("first","load_tool",json!({"names":["write"]})),
        ("second","load_tool",json!({"names":["shell","list"]})),
    ]));
    f.push(fixture::text("parallel selection"));
    let tid = start(&s,&sid,&profile,true).await;
    let done = s.wait_status(&tid,"completed").await;
    assert!(done["tool_calls"].as_array().unwrap().iter().all(|c| c["status"] == "succeeded"));
    assert_eq!(tool_names(&f.requests()[1]),["edit","list","load_tool","read","shell"]);
    let other = s.create_session(project["id"].as_str().unwrap()).await;
    f.push(fixture::text("isolated"));
    let tid = start(&s,other["id"].as_str().unwrap(),&profile,true).await;
    s.wait_status(&tid,"completed").await;
    assert_eq!(tool_names(&f.requests()[2]),["edit","load_tool","read"]);
}

#[tokio::test]
async fn policy_unavailable_mcp_and_invalid_arguments_are_explicit_errors_not_execution() {
    for (key,value,names,code) in [
        ("tools.deny","write",json!(["write"]),"policy_denied"),
        ("tools.deny","shell",json!(["shell"]),"policy_denied"),
        ("tools.deny","load_tool",json!(["write"]),"policy_denied"),
        ("tools.mode","ask",json!(["mcp_call"]),"unsupported_tool"),
        ("tools.mode","ask",json!(["unknown"]),"unsupported_tool"),
        ("tools.mode","ask",json!(vec!["write";9]),"invalid_arguments"),
        ("tools.mode","ask",json!([]),"invalid_arguments"),
    ] {
        let (s,f,profile,sid,project) = setup().await;
        setting(&s,"project",project["id"].as_str().unwrap(),key,json!(value)).await;
        f.push(load("rejected",names));
        f.push(fixture::text("rejected safely"));
        let tid = start(&s,&sid,&profile,true).await;
        let done = s.wait_status(&tid,"completed").await;
        assert_eq!(call(&done,"rejected")["status"],"failed","{done}");
        assert_eq!(call(&done,"rejected")["result"]["error"]["code"],code,"{done}");
        assert_eq!(std::fs::read_dir(project["root_path"].as_str().unwrap()).unwrap().count(),0);
        let first = &f.requests()[0];
        let descriptions = first["tools"].to_string();
        assert!(!descriptions.contains("mcp_call:"));
        if key == "tools.deny" {
            assert!(!tool_names(first).contains(&value));
            assert!(!descriptions.contains(&format!("{value}:")));
        }
    }
}

#[tokio::test]
async fn tools_off_never_advertises_or_loads_schemas_and_provider_capabilities_remain_enforced() {
    let (s,f,profile,sid,_) = setup().await;
    f.push(load("disabled",json!(["shell"])));
    f.push(fixture::text("disabled"));
    let tid = start(&s,&sid,&profile,false).await;
    let done = s.wait_status(&tid,"completed").await;
    assert!(done["definition"].get("deferred_tools").is_none());
    assert_ne!(call(&done,"disabled")["status"],"succeeded");
    assert!(f.requests().iter().all(|r| r.get("tools").is_none()));
    let (_,profiles) = s.get("/api/v1/model-profiles").await;
    let p = profiles.as_array().unwrap().iter().find(|p| p["id"] == profile).unwrap();
    let (status,response) = s.send(Method::PUT,&format!("/api/v1/model-profiles/{profile}"),
        json!({"expected_revision":p["revision"],"options":{"capabilities":{"tools":false}}})).await;
    assert_eq!(status,StatusCode::OK,"{response}");
    let (status,response) = s.post(&format!("/api/v1/sessions/{sid}/turns"),
        json!({"profile_id":profile,"text":"must reject tools","tools":true})).await;
    assert_eq!(status,StatusCode::UNPROCESSABLE_ENTITY,"{response}");
    assert_eq!(f.requests().len(),2);
}

#[tokio::test]
async fn selected_schemas_and_catalog_count_against_context_before_the_next_request() {
    let (s,f,profile,sid,_) = setup().await;
    let (release,gate) = tokio::sync::watch::channel(false);
    let Step::Frames(frames,_) = load("load-before-limit",json!(["shell","write"])) else { unreachable!() };
    f.push(Step::Gated(frames,gate));
    let tid = start(&s,&sid,&profile,true).await;
    s.wait_turn(&tid, |_| !f.requests().is_empty()).await;
    let (_,profiles) = s.get("/api/v1/model-profiles").await;
    let p = profiles.as_array().unwrap().iter().find(|p| p["id"] == profile).unwrap();
    let (status,response) = s.send(Method::PUT,&format!("/api/v1/model-profiles/{profile}"),
        json!({"expected_revision":p["revision"],"options":{"context_window":1,"max_tokens":1}})).await;
    assert_eq!(status,StatusCode::OK,"{response}");
    release.send_replace(true);
    let done = s.wait_status(&tid,"failed").await;
    assert_eq!(call(&done,"load-before-limit")["status"],"succeeded");
    assert_eq!(done["error"]["code"],"invalid_request");
    assert!(done["error"]["message"].as_str().unwrap().contains("입력 용량과 출력 여유"));
    assert_eq!(f.requests().len(),1,"선택한 schema를 용량 검사 없이 보내면 안 된다");
}

#[tokio::test]
#[cfg(unix)]
async fn loss_after_approved_execution_and_restart_never_replay_the_loaded_tool() {
    let (mut s,f,profile,sid,project) = setup().await;
    f.push(load("load-shell",json!(["shell"])));
    f.push(fixture::tool_calls(&[("effect","shell",json!({"command":"printf once >> effects.txt"}))]));
    f.push(fixture::truncated());
    let tid = start(&s,&sid,&profile,true).await;
    let waiting = s.wait_status(&tid,"awaiting_approval").await;
    let effect = call(&waiting,"effect");
    let (status,_) = s.post(&format!("/api/v1/tool-calls/{}/decision",effect["id"].as_str().unwrap()),
        json!({"decision":"approve","expected_revision":effect["revision"]})).await;
    assert!(status.is_success());
    let failed = s.wait_status(&tid,"failed").await;
    assert_eq!(failed["error"]["code"],"stream_incomplete");
    let path = std::path::Path::new(project["root_path"].as_str().unwrap()).join("effects.txt");
    assert_eq!(std::fs::read_to_string(&path).unwrap(),"once");
    s.restart().await;
    assert_eq!(std::fs::read_to_string(path).unwrap(),"once");
    assert_eq!(f.requests().len(),3);
}

#[tokio::test]
async fn cancellation_after_loading_leaves_approval_unexecuted_across_restart() {
    let (mut s,f,profile,sid,project) = setup().await;
    f.push(load("load-write",json!(["write"])));
    f.push(fixture::tool_calls(&[("not-approved","write",json!({"path":"cancelled.txt","content":"no"}))]));
    let tid = start(&s,&sid,&profile,true).await;
    s.wait_status(&tid,"awaiting_approval").await;
    s.post(&format!("/api/v1/turns/{tid}/cancel"),json!({})).await;
    let cancelled = s.wait_status(&tid,"cancelled").await;
    assert_eq!(call(&cancelled,"load-write")["status"],"succeeded");
    assert_eq!(call(&cancelled,"not-approved")["status"],"cancelled");
    s.restart().await;
    assert!(!std::path::Path::new(project["root_path"].as_str().unwrap()).join("cancelled.txt").exists());
    assert_eq!(f.requests().len(),2);
}

#[tokio::test]
async fn fallback_candidate_without_tool_capability_is_not_given_the_loader() {
    let (s,f,profile,sid,_) = setup().await;
    let other = Fixture::start().await;
    let (status,backup) = s.post("/api/v1/model-profiles",json!({
        "name":"no tools","protocol":"openai","base_url":other.base,"model":"fixture",
        "options":{"capabilities":{"tools":false}}
    })).await;
    assert_eq!(status,StatusCode::CREATED,"{backup}");
    let (_,profiles) = s.get("/api/v1/model-profiles").await;
    let primary = profiles.as_array().unwrap().iter().find(|p| p["id"] == profile).unwrap();
    let (status,response) = s.send(Method::PUT,&format!("/api/v1/model-profiles/{profile}"),
        json!({"expected_revision":primary["revision"],"options":{"fallback":{
            "enabled":true,"destination_change_confirmed":true,
            "candidates":[{"profile_id":backup["id"],"revision":backup["revision"]}]
        }}})).await;
    assert_eq!(status,StatusCode::OK,"{response}");
    for _ in 0..=grove::provider::MAX_RETRIES {
        f.push(Step::Error(503,"local fixture unavailable".into()));
    }
    let tid = start(&s,&sid,&profile,true).await;
    s.wait_status(&tid,"failed").await;
    assert_eq!(f.requests().len(),grove::provider::MAX_RETRIES as usize + 1);
    assert!(other.requests().is_empty());
}

#[tokio::test]
async fn eligible_fallback_loads_schemas_on_its_actual_next_request() {
    let (s,f,profile,sid,_) = setup().await;
    let other = Fixture::start().await;
    let backup = s.fixture_profile(&other.base).await;
    let (_,profiles) = s.get("/api/v1/model-profiles").await;
    let primary = profiles.as_array().unwrap().iter().find(|p| p["id"] == profile).unwrap();
    let candidate = profiles.as_array().unwrap().iter().find(|p| p["id"] == backup).unwrap();
    let (status,response) = s.send(Method::PUT,&format!("/api/v1/model-profiles/{profile}"),
        json!({"expected_revision":primary["revision"],"options":{"fallback":{
            "enabled":true,"destination_change_confirmed":true,
            "candidates":[{"profile_id":backup,"revision":candidate["revision"]}]
        }}})).await;
    assert_eq!(status,StatusCode::OK,"{response}");
    for _ in 0..=grove::provider::MAX_RETRIES {
        f.push(Step::Error(503,"local fixture unavailable".into()));
    }
    other.push(load("fallback-load",json!(["list"])));
    other.push(fixture::text("fallback loaded"));
    let tid = start(&s,&sid,&profile,true).await;
    let done = s.wait_status(&tid,"completed").await;
    assert_eq!(done["profile_id"],backup);
    assert_eq!(tool_names(&other.requests()[0]),["edit","load_tool","read"]);
    assert_eq!(tool_names(&other.requests()[1]),["edit","list","load_tool","read"]);
    assert_eq!(call(&done,"fallback-load")["status"],"succeeded");
}

#[tokio::test]
async fn signed_native_loading_uses_the_next_request_and_does_not_leak_signatures_to_another_model() {
    let (s,f,_,sid,_) = setup().await;
    let (status,profile) = s.post("/api/v1/model-profiles",json!({
        "name":"native loader","protocol":"anthropic","base_url":f.base.trim_end_matches("/v1"),"model":"native-one"
    })).await;
    assert_eq!(status,StatusCode::CREATED,"{profile}");
    let native = |values: Vec<Value>| Step::Frames(values.iter().map(Value::to_string).collect(),0);
    f.push(native(vec![
        json!({"type":"message_start","message":{"usage":{"input_tokens":1}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"local plan","signature":"loader-native-signature"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"native-load","name":"load_tool","input":{"names":["write"]}}}),
        json!({"type":"content_block_stop","index":1}),
        json!({"type":"message_delta","delta":{"stop_reason":"tool_use"}}),
        json!({"type":"message_stop"}),
    ]));
    let text = || native(vec![
        json!({"type":"message_start","message":{"usage":{"input_tokens":1}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"native schema complete"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
        json!({"type":"message_stop"}),
    ]);
    f.push(text());
    let tid = start(&s,&sid,profile["id"].as_str().unwrap(),true).await;
    let done = s.wait_status(&tid,"completed").await;
    assert_eq!(call(&done,"native-load")["status"],"succeeded");
    let requests = f.requests();
    assert_eq!(requests[0]["tools"].as_array().unwrap().len(),3);
    let second = &requests[1];
    assert!(second["tools"].as_array().unwrap().iter().any(|t| t["name"] == "write"
        && t["input_schema"] == tools::spec("write").unwrap().schema));
    assert_eq!(second["messages"][1]["content"][0]["signature"],"loader-native-signature");
    assert_eq!(second["messages"][1]["content"][1]["id"],"native-load");
    assert_eq!(second["messages"][2]["content"][0]["tool_use_id"],"native-load");
    let (status,other) = s.post("/api/v1/model-profiles",json!({
        "name":"other native model","protocol":"anthropic","base_url":f.base.trim_end_matches("/v1"),"model":"native-two"
    })).await;
    assert_eq!(status,StatusCode::CREATED,"{other}");
    f.push(text());
    let tid = start(&s,&sid,other["id"].as_str().unwrap(),true).await;
    s.wait_status(&tid,"completed").await;
    let requests = f.requests();
    assert!(!requests[2].to_string().contains("loader-native-signature"));
    assert_eq!(requests[2]["messages"][1]["content"][0]["id"],"native-load");
    assert_eq!(requests[2]["messages"][2]["content"][0]["tool_use_id"],"native-load");
}

#[tokio::test]
async fn cli_capability_and_tools_off_block_loading_while_legacy_turns_keep_their_list() {
    let (s,_,_,sid,_) = setup().await;
    let (status,profile) = s.post("/api/v1/model-profiles",json!({
        "name":"CLI never launched","protocol":"codex_cli","base_url":"","model":"fixture"
    })).await;
    assert_eq!(status,StatusCode::CREATED,"{profile}");
    let app = s.server.as_ref().unwrap().app.clone();
    let (now,epoch) = (app.now(),app.epoch.clone());
    app.db.call(move |c| {
        let tx = c.transaction()?;
        let error = grove::runner::enqueue_turn(&tx,&now,&epoch,"owner",&sid,"reject Grove tools",
            profile["id"].as_str().unwrap(),None,true,None).err().unwrap();
        assert_eq!(error.code,"unsupported");
        let (turn,_) = grove::runner::enqueue_turn(&tx,&now,&epoch,"owner",&sid,"no CLI process",
            profile["id"].as_str().unwrap(),None,false,None)?;
        let session = grove::sessions::get(&tx,&sid)?;
        let root = grove::sessions::exec_root(&tx,&sid)?;
        let call = grove::approvals::create_call(&tx,&now,1800,&sid,&session.project_id,&root,
            Some(&turn.id),Some("cli-load"),"load_tool",&json!({"names":["write"]}))?;
        let error = deferred::execute_tool(&tx,&call).unwrap_err();
        assert!(error.message.contains("도구가 꺼진 턴"));
        let legacy = deferred::model_tools(&tx,&turn.id,&sid,&json!({}))?;
        assert!(!legacy.iter().any(|t| t.name == deferred::NAME));
        assert!(legacy.iter().any(|t| t.name == "shell"));
        // transaction을 commit하지 않으므로 runner·CLI를 시작하지 않는다.
        Ok(())
    }).await.unwrap();
}

#[test]
fn native_provider_conversion_uses_the_selected_registry_schema_and_preserves_call_identity() {
    use grove::provider::{self, ChatMsg, ModelRequest, Profile, ToolCall};
    let profile = Profile {
        protocol:"anthropic".into(),base_url:"http://127.0.0.1".into(),model:"fixture".into(),
        api_key:None,timeout:std::time::Duration::from_secs(1),extra_headers:vec![],sensitive_headers:vec![],
    };
    let request = ModelRequest {
        system:"local".into(),tools:deferred::definitions(tools::specs(),&["write".into()]),
        messages:vec![
            ChatMsg::User {text:"load".into(),images:vec![]},
            ChatMsg::Assistant {text:"".into(),native:None,tool_calls:vec![ToolCall {
                id:"load-identity".into(),name:"load_tool".into(),arguments:json!({"names":["write"]}),
            }]},
            ChatMsg::Tool {call_id:"load-identity".into(),name:"load_tool".into(),content:"schemas".into(),is_error:false},
        ],
        max_tokens:Some(128),temperature:None,effort:None,cli:None, service_tier: None,
    };
    let anthropic = provider::anthropic::build_body(&profile,&request);
    let write = anthropic["tools"].as_array().unwrap().iter().find(|t| t["name"] == "write").unwrap();
    assert_eq!(write["input_schema"],tools::spec("write").unwrap().schema);
    assert_eq!(anthropic["messages"][1]["content"][0]["id"],"load-identity");
    assert_eq!(anthropic["messages"][2]["content"][0]["tool_use_id"],"load-identity");
    let mut native_request = request.clone();
    native_request.messages[1] = ChatMsg::Assistant {
        text:"".into(),
        tool_calls:vec![ToolCall {id:"load-identity".into(),name:"load_tool".into(),arguments:json!({"names":["write"]})}],
        native:Some(provider::NativeContent {
            protocol:"gemini".into(),base_url:profile.base_url.clone(),model:profile.model.clone(),
            blocks:vec![json!({"functionCall":{"id":"load-identity","name":"load_tool","args":{"names":["write"]}},
                "thoughtSignature":"fixture-load-signature"})],
        }),
    };
    let gemini = provider::gemini::build_body(&native_request);
    let declarations = gemini["tools"][0]["functionDeclarations"].as_array().unwrap();
    let write = declarations.iter().find(|t| t["name"] == "write").unwrap();
    assert_eq!(write["parameters"],tools::spec("write").unwrap().schema);
    assert_eq!(gemini["contents"][1]["parts"][0]["functionCall"]["id"],"load-identity");
    assert_eq!(gemini["contents"][1]["parts"][0]["thoughtSignature"],"fixture-load-signature");
    assert_eq!(gemini["contents"][2]["parts"][0]["functionResponse"]["id"],"load-identity");
}
