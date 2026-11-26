//! 도구 registry(TOOL-001). 모든 도구는 입력 schema·권한(부작용)·취소·출력 한도 metadata를 가진다.
//! 계획(plan) 단계에서 인자를 검증하고 실행 대상(target)과 사전 조건(precondition)을 고정한다.
//! 승인은 이 target에 결합되며(SEC-008), 실행 직전에 precondition을 다시 검사한다.

pub mod fs;
pub mod image_read;
pub mod patch;
pub mod search;
pub mod shell;
pub mod web_fetch;

use serde::Serialize;
use serde_json::{Value, json};
use std::path::Path;
use tokio::sync::watch;

pub const MAX_OUTPUT: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    /// 프로젝트 내부 읽기 전용
    Read,
    /// 파일 변경
    Write,
    /// 임의 프로세스 실행
    Execute,
    /// 자식 에이전트 위임(비용 발생). 승인 여부는 동작과 위임 정책으로 정한다(AGENT-014).
    Delegate,
    /// 대화 데이터를 조회하거나 이 대화의 상태(Goal 등)만 바꾼다. 파일·프로세스 부작용은 없다.
    Conversation,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub effect: Effect,
    pub cancellable: bool,
    pub max_output_bytes: usize,
    pub schema: Value,
}

#[derive(Debug, Clone)]
pub struct Planned {
    /// 승인 화면과 실행이 공유하는 정확한 대상(경로·명령·cwd 등)
    pub target: Value,
    /// 실행 직전에 다시 확인할 조건(파일 hash 등)
    pub precondition: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
}

impl ToolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn to_json(&self) -> Value {
        json!({ "error": { "code": self.code, "message": self.message } })
    }
}

pub type ToolResult<T> = Result<T, ToolError>;

pub fn specs() -> Vec<ToolSpec> {
    vec![
        crate::continuations::spec(),
        crate::tool_outputs::spec(),
        crate::deferred_tools::spec(),
        ToolSpec {
            name: "read",
            description: "프로젝트 파일을 읽는다. 줄 범위(offset 1부터, limit)를 지정할 수 있고 큰 파일은 범위로 나눠 읽는다. 여러 파일·범위는 files로 한 번에 읽으며 같은 파일의 겹치는 범위는 합친다. binary는 제한된 hex로 보여준다.",
            effect: Effect::Read,
            cancellable: false,
            max_output_bytes: MAX_OUTPUT,
            schema: json!({ "type": "object", "properties": {
                "path": { "type": "string", "description": "프로젝트 root 기준 경로" },
                // 다른 목록 도구(offset 0부터)와 섞어 쓰는 모델이 0을 보내도 거부하지 않는다: 0과 1은 첫 줄.
                "offset": { "type": "integer", "minimum": 0, "description": "시작 줄(1부터, 0은 1과 같음)" },
                // 큰 값은 거부하지 않고 5000줄로 줄인다(응답의 limit_clamped·next_offset으로 이어 읽기를 알린다).
                "limit": { "type": "integer", "minimum": 1, "description": "읽을 줄 수(최대 5000, 넘으면 5000)" },
                // 배치(TOOL-010): path 대신 쓴다. 둘 다 주면 거부한다.
                "files": { "type": "array", "maxItems": 10, "description": "여러 파일·범위를 한 번에 읽는다",
                           "items": { "type": "object", "properties": { "path": { "type": "string" }, "offset": { "type": "integer", "minimum": 0 }, "limit": { "type": "integer", "minimum": 1 } } } }
            }, "additionalProperties": false }),
        },
        ToolSpec {
            name: "list",
            description: "디렉터리의 바로 아래 항목을 나열한다.",
            effect: Effect::Read,
            cancellable: false,
            max_output_bytes: MAX_OUTPUT,
            schema: json!({ "type": "object", "properties": {
                "path": { "type": "string" }, "hidden": { "type": "boolean" }, "meta": { "type": "boolean" },
                "offset": { "type": "integer", "minimum": 0 }, "limit": { "type": "integer", "minimum": 1, "maximum": 1000 }
            }, "additionalProperties": false }),
        },
        ToolSpec {
            name: "glob",
            description: "glob 패턴으로 파일 경로를 찾는다(여러 패턴은 합집합). 기본 정렬은 수정 시각 최신순.",
            effect: Effect::Read,
            cancellable: true,
            max_output_bytes: MAX_OUTPUT,
            schema: json!({ "type": "object", "properties": {
                "pattern": { "anyOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" }, "maxItems": 10 }] },
                "path": { "type": "string" }, "sort": { "enum": ["mtime", "natural"] },
                "offset": { "type": "integer", "minimum": 0 }, "limit": { "type": "integer", "minimum": 0 },
                "include_noise": { "type": "boolean" }
            }, "required": ["pattern"], "additionalProperties": false }),
        },
        ToolSpec {
            name: "find",
            description: "경로 조각(공백으로 구분한 조각을 모두 포함)으로 파일·디렉터리 경로를 찾는다.",
            effect: Effect::Read,
            cancellable: true,
            max_output_bytes: MAX_OUTPUT,
            schema: json!({ "type": "object", "properties": {
                "query": { "type": "string", "minLength": 1 }, "path": { "type": "string" },
                "limit": { "type": "integer", "minimum": 0 }, "include_noise": { "type": "boolean" }
            }, "required": ["query"], "additionalProperties": false }),
        },
        ToolSpec {
            name: "grep",
            description: "정규식으로 파일 내용을 검색한다. mode는 content(기본)·files·count.",
            effect: Effect::Read,
            cancellable: true,
            max_output_bytes: MAX_OUTPUT,
            schema: json!({ "type": "object", "properties": {
                "pattern": { "anyOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" }, "maxItems": 10 }] },
                "path": { "anyOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" }, "maxItems": 10 }] },
                "glob": { "type": "string" }, "mode": { "enum": ["content", "files", "count"] },
                "context": { "type": "integer", "minimum": 0, "maximum": 50 },
                "offset": { "type": "integer", "minimum": 0 }, "limit": { "type": "integer", "minimum": 0 },
                "include_noise": { "type": "boolean" }, "ignore_case": { "type": "boolean" }
            }, "required": ["pattern"], "additionalProperties": false }),
        },
        ToolSpec {
            name: "write",
            description: "새 파일을 만든다. 이미 있는 파일은 덮어쓰지 않는다(수정은 edit 사용). 도구 정책에서 사전 허용하지 않으면 사용자 승인이 필요하다.",
            effect: Effect::Write,
            cancellable: false,
            max_output_bytes: 4096,
            schema: json!({ "type": "object", "properties": {
                "path": { "type": "string" }, "content": { "type": "string" }
            }, "required": ["path", "content"], "additionalProperties": false }),
        },
        ToolSpec {
            name: "edit",
            description: "파일의 정확한 원문(old_string)을 new_string으로 바꾼다. replace_all이 아니면 원문이 정확히 한 번 나와야 한다. 도구 정책에서 사전 허용하지 않으면 사용자 승인이 필요하다.",
            effect: Effect::Write,
            cancellable: false,
            max_output_bytes: 4096,
            schema: json!({ "type": "object", "properties": {
                "path": { "type": "string" }, "old_string": { "type": "string", "minLength": 1 },
                "new_string": { "type": "string" }, "replace_all": { "type": "boolean" }
            }, "required": ["path", "old_string", "new_string"], "additionalProperties": false }),
        },
        ToolSpec {
            name: "apply_patch",
            description: "여러 파일을 한 번에 추가·수정·삭제·이동한다. patch는 '*** Begin Patch'로 시작해 '*** End Patch'로 끝나며 \
                '*** Add File: 경로'(+줄), '*** Update File: 경로'(선택 '*** Move to: 경로', '@@ 위치 줄', ' '문맥/'-'삭제/'+'추가 줄), '*** Delete File: 경로'를 쓴다. \
                도구 정책에서 사전 허용하지 않으면 사용자 승인이 필요하다. 하나라도 실패하면 이미 바꾼 파일을 되돌린다.",
            effect: Effect::Write,
            cancellable: false,
            max_output_bytes: 16 * 1024,
            schema: json!({ "type": "object", "properties": {
                "patch": { "type": "string", "minLength": 1 }
            }, "required": ["patch"], "additionalProperties": false }),
        },
        ToolSpec {
            name: "shell",
            description: "프로젝트 디렉터리에서 셸 명령을 실행한다(Linux: bash, Windows: PowerShell). 도구 정책에서 사전 허용하지 않으면 사용자 승인이 필요하다. \
                기본 1분 안에 끝나지 않으면 종료하지 않고 백그라운드로 넘긴다. background=true는 즉시 전환하고 hold_ms는 전환 전 대기 시간을 바꾼다. \
                백그라운드 작업은 task_id를 돌려주고, 끝나면 결과가 대화에 기록된다.",
            effect: Effect::Execute,
            cancellable: true,
            max_output_bytes: shell::MAX_CAPTURE * 2,
            schema: json!({ "type": "object", "properties": {
                "command": { "type": "string", "minLength": 1 },
                "cwd": { "type": "string", "description": "프로젝트 root 기준 작업 디렉터리" },
                "timeout_ms": { "type": "integer", "minimum": 0, "maximum": shell::MAX_EXPLICIT_TIMEOUT_MS, "description": "명시한 경우에만 프로세스를 강제 종료할 시한. 생략하거나 0이면 자동 종료하지 않음" },
                "background": { "type": "boolean" },
                "follow_up": { "type": "string", "minLength": 1, "description": "사용자가 요청한 완료 후 확인·보고 지시. background=true와 함께 쓰면 현재 턴을 종료할 수 있고, 작업 종료 뒤 같은 대화에서 새 AI 턴이 한 번 보고한다" },
                "hold_ms": { "type": "integer", "minimum": 0, "maximum": shell::MAX_HOLD_MS, "description": "결과를 기다릴 시간. 넘으면 백그라운드로 전환" }
            }, "required": ["command"], "additionalProperties": false }),
        },
        ToolSpec {
            name: "agent",
            description: "자식 에이전트에게 일을 맡기고 결과를 받는다. action: spawn(agent_id·brief로 새 자식 작업 시작), \
                send(run_id·brief로 끝난 자식 작업에 후속 지시), status/wait(run_id 상태 확인·완료 대기), list(이 대화의 자식 작업 목록), cancel(run_id). \
                spawn·send는 즉시 running을 돌려준다. 자식 작업이 completed가 되기 전에는 그 결과를 완료로 보고하지 마라. \
                결과는 끝나면 대화에 기록되며 wait로 기다릴 수도 있다.",
            effect: Effect::Delegate,
            cancellable: true,
            max_output_bytes: 32 * 1024,
            schema: json!({ "type": "object", "properties": {
                "action": { "enum": ["spawn", "send", "status", "wait", "list", "cancel"] },
                "agent_id": { "type": "string", "minLength": 1 },
                "brief": { "type": "string", "minLength": 1 },
                "run_id": { "type": "string", "minLength": 1 },
                "timeout_ms": { "type": "integer", "minimum": 0, "maximum": 600000 }
            }, "required": ["action"], "additionalProperties": false }),
        },
        ToolSpec {
            name: "goal",
            description: "이 대화의 Goal(할 일) 목록을 관리한다. action: list, add(title 또는 titles), update(id와 title/status: pending·in_progress·done·cancelled), reorder(ids 전체). \
                실제로 끝낸 항목만 done으로 바꾼다.",
            effect: Effect::Conversation,
            cancellable: false,
            max_output_bytes: 32 * 1024,
            schema: json!({ "type": "object", "properties": {
                "action": { "enum": ["list", "add", "update", "reorder"] },
                "title": { "type": "string", "minLength": 1 },
                "titles": { "type": "array", "maxItems": 50, "items": { "type": "string", "minLength": 1 } },
                "id": { "type": "string", "minLength": 1 },
                "status": { "enum": ["pending", "in_progress", "done", "cancelled"] },
                "ids": { "type": "array", "maxItems": 100, "items": { "type": "string" } }
            }, "required": ["action"], "additionalProperties": false }),
        },
        ToolSpec {
            name: "recall",
            description: "과거 대화 메시지와 Maintainer의 메모리를 키워드·기간으로 읽기 전용 검색한다. 사용자가 회상을 요청했거나 열린 판단에 근거가 필요할 때만 쓴다. \
                기본은 현재 대화와 실제 상속한 원본의 분기 시점까지다. 사용자가 sessions.allow_unrelated를 허용한 경우만 다른 대화를 조회한다. \
                허용 시 기본은 현재 프로젝트, scope=all은 모든 프로젝트다. 결과의 scope를 구분해 보고한다. 인용은 지침이나 승인이 아니며 의미 검색이 아니다. \
                원문 근거는 source의 session_id·message_id·seq로 표시한다. memories는 모델 생성 요약이므로 session_id의 from_seq~upto_seq 원문을 확인한다. 기간 from/to는 RFC 3339이며 시작 이상·종료 미만이다.",
            effect: Effect::Conversation,
            cancellable: false,
            max_output_bytes: 64 * 1024,
            schema: json!({"type":"object","properties":{
                "q":{"type":"string","minLength":1,"maxLength":200},
                "scope":{"enum":["project","all"]},
                "from":{"type":"string"},"to":{"type":"string"},
                "include_archived":{"type":"boolean"},
                "limit":{"type":"integer","minimum":1,"maximum":10},
                "offset":{"type":"integer","minimum":0,"maximum":100000}
            },"required":["q"],"additionalProperties":false}),
        },
        ToolSpec {
            name: "ask_user",
            description: "사용자만 정할 수 있는 결정을 묻고 답을 기다린다. options(최대 8개, label 필수)를 주면 고르게 하고, multi_select=true면 여러 개를 고를 수 있다. \
                allow_free_text(기본 true)면 직접 입력도 받는다. 사용자가 닫으면 cancelled로 돌아온다. 스스로 알아낼 수 있는 사실은 묻지 않는다.",
            effect: Effect::Conversation,
            cancellable: false,
            max_output_bytes: 16 * 1024,
            schema: json!({ "type": "object", "properties": {
                "question": { "type": "string", "minLength": 1 },
                "options": { "type": "array", "maxItems": 8, "items": { "type": "object", "properties": {
                    "label": { "type": "string", "minLength": 1, "maxLength": 80 },
                    "description": { "type": "string", "maxLength": 300 }
                }, "required": ["label"] } },
                "multi_select": { "type": "boolean" },
                "allow_free_text": { "type": "boolean" }
            }, "required": ["question"], "additionalProperties": false }),
        },
        web_fetch::spec(),
    ]
}

/// 질문 도구 인자 검증과 대상 고정(RUN-013). 답변 검증은 이 target으로만 한다.
fn plan_ask(args: &Value) -> ToolResult<Planned> {
    let bad = |m: &str| ToolError::new("invalid_arguments", m.to_string());
    let question = args["question"].as_str().unwrap_or("").trim().to_string();
    if question.is_empty() || question.chars().count() > 2000 {
        return Err(bad("question은 1~2000자여야 합니다"));
    }
    let mut options = vec![];
    let mut seen = std::collections::HashSet::new();
    for o in args["options"].as_array().into_iter().flatten() {
        let label = o["label"].as_str().unwrap_or("").trim().to_string();
        if label.is_empty() || label.chars().count() > 80 {
            return Err(bad("각 option에는 1~80자 label이 필요합니다"));
        }
        if !seen.insert(label.clone()) {
            return Err(bad("option label이 중복됩니다"));
        }
        let description: String = o["description"].as_str().unwrap_or("").chars().take(300).collect();
        options.push(json!({ "label": label, "description": description }));
    }
    let multi = args["multi_select"].as_bool().unwrap_or(false);
    let free = args["allow_free_text"].as_bool().unwrap_or(true);
    if options.is_empty() && !free {
        return Err(bad("options가 없으면 allow_free_text가 true여야 합니다"));
    }
    if multi && options.len() < 2 {
        return Err(bad("multi_select에는 option이 2개 이상 필요합니다"));
    }
    Ok(Planned { target: json!({ "question": question, "options": options, "multi_select": multi, "allow_free_text": free }), precondition: None })
}

/// agent 도구 인자 검증과 대상 고정.
fn plan_agent(args: &Value) -> ToolResult<Planned> {
    let action = args["action"].as_str().unwrap_or("");
    let need = |k: &str| -> ToolResult<String> {
        args[k].as_str().map(str::to_string).ok_or_else(|| ToolError::new("invalid_arguments", format!("{action}에는 {k}가 필요합니다")))
    };
    let target = match action {
        "spawn" => {
            let brief = need("brief")?;
            if brief.chars().count() > 20_000 {
                return Err(ToolError::new("invalid_arguments", "brief가 너무 깁니다"));
            }
            json!({ "action": action, "agent_id": need("agent_id")?, "brief": brief })
        }
        "send" => json!({ "action": action, "run_id": need("run_id")?, "brief": need("brief")? }),
        "status" | "cancel" => json!({ "action": action, "run_id": need("run_id")? }),
        "wait" => json!({ "action": action, "run_id": need("run_id")?, "timeout_ms": args["timeout_ms"].as_u64().unwrap_or(60_000) }),
        "list" => json!({ "action": action }),
        _ => return Err(ToolError::new("invalid_arguments", "알 수 없는 action")),
    };
    Ok(Planned { target, precondition: None })
}

pub fn spec(name: &str) -> Option<ToolSpec> {
    specs().into_iter().find(|s| s.name == name)
}

pub fn needs_approval(effect: Effect) -> bool {
    !matches!(effect, Effect::Read | Effect::Conversation)
}

/// 인자 schema 검증(필수·형식·추가 속성). 완전한 JSON Schema 구현이 아니라 registry에서 쓰는 부분만 지원한다.
pub fn validate_args(spec: &ToolSpec, args: &Value) -> ToolResult<()> {
    if args.get("__invalid_json").is_some() {
        return Err(ToolError::new("invalid_arguments", "도구 인자가 올바른 JSON 객체가 아닙니다"));
    }
    let obj = args.as_object().ok_or_else(|| ToolError::new("invalid_arguments", "도구 인자는 객체여야 합니다"))?;
    let props = spec.schema["properties"].as_object().cloned().unwrap_or_default();
    for r in spec.schema["required"].as_array().into_iter().flatten() {
        let k = r.as_str().unwrap_or("");
        // 필수 인자의 null도 "없음"이다(모델이 무엇을 고칠지 알 수 있게 정확히 알린다).
        if obj.get(k).is_none_or(Value::is_null) {
            return Err(ToolError::new("invalid_arguments", format!("필수 인자 {k}가 없습니다")));
        }
    }
    for (k, v) in obj {
        let Some(p) = props.get(k) else {
            return Err(ToolError::new("invalid_arguments", format!("알 수 없는 인자 {k}")));
        };
        // 선택 인자의 명시적 null은 생략과 같다(OpenAI 호환 모델이 흔히 보낸다). 실행부는 값만 읽으므로 기본값이 적용된다.
        if v.is_null() {
            continue;
        }
        if !type_ok(p, v) {
            return Err(ToolError::new("invalid_arguments", format!("인자 {k}의 형식이 올바르지 않습니다")));
        }
    }
    Ok(())
}

fn type_ok(p: &Value, v: &Value) -> bool {
    if let Some(any) = p["anyOf"].as_array() {
        return any.iter().any(|a| type_ok(a, v));
    }
    if let Some(e) = p["enum"].as_array() {
        return e.contains(v);
    }
    let ok = match p["type"].as_str() {
        Some("string") => v.as_str().is_some_and(|s| p["minLength"].as_u64().is_none_or(|m| s.chars().count() as u64 >= m)),
        Some("integer") => v.as_i64().is_some_and(|n| {
            p["minimum"].as_i64().is_none_or(|m| n >= m) && p["maximum"].as_i64().is_none_or(|m| n <= m)
        }),
        Some("boolean") => v.is_boolean(),
        Some("array") => v.as_array().is_some_and(|a| {
            p["maxItems"].as_u64().is_none_or(|m| a.len() as u64 <= m) && a.iter().all(|i| type_ok(&p["items"], i))
        }),
        Some("object") => v.is_object(),
        _ => true,
    };
    ok
}

/// 인자 검증 + 대상 고정. 실행은 하지 않는다.
pub fn plan(name: &str, args: &Value, root: &Path) -> ToolResult<(ToolSpec, Planned)> {
    let spec = spec(name).ok_or_else(|| ToolError::new("unsupported_tool", format!("지원하지 않는 도구입니다: {name}")))?;
    validate_args(&spec, args)?;
    let planned = match name {
        "read" | "list" => fs::plan_read(args, root, name)?,
        "glob" | "find" | "grep" => search::plan(args, root, name)?,
        "write" => fs::plan_write(args, root)?,
        "edit" => fs::plan_edit(args, root)?,
        "apply_patch" => patch::plan(args, root)?,
        "shell" => shell::plan(args, root)?,
        "agent" => plan_agent(args)?,
        "load_tool" => crate::deferred_tools::plan(args)?,
        "continue_later" => crate::continuations::plan(args)?,
        "goal" | "recall" | "tool_output_read" => Planned { target: args.clone(), precondition: None },
        "ask_user" => plan_ask(args)?,
        "web_fetch" => web_fetch::plan(args)?,
        _ => unreachable!(),
    };
    Ok((spec, planned))
}

/// 실행. 승인된 target과 precondition만 사용한다(모델 인자를 다시 해석하지 않는다).
pub async fn execute(name: &str, args: &Value, planned: &Planned, root: &Path, cancel: watch::Receiver<bool>) -> ToolResult<Value> {
    let (name, args, planned, root) = (name.to_string(), args.clone(), planned.clone(), root.to_path_buf());
    match name.as_str() {
        "shell" => shell::execute(&planned, &root, cancel).await,
        "web_fetch" => web_fetch::execute(&args, &planned, cancel).await,
        _ => tokio::task::spawn_blocking(move || match name.as_str() {
            "read" => image_read::read(&args, &planned, &root),
            "list" => fs::list(&args, &planned, &root),
            "glob" => search::glob(&args, &planned, &root, &cancel),
            "find" => search::find(&args, &planned, &root, &cancel),
            "grep" => search::grep(&args, &planned, &root, &cancel),
            "write" => fs::write_new(&args, &planned, &root),
            "edit" => fs::edit(&args, &planned, &root),
            "apply_patch" => patch::execute(&planned, &root),
            _ => Err(ToolError::new("unsupported_tool", "지원하지 않는 도구입니다")),
        })
        .await
        .map_err(|e| ToolError::new("internal", format!("도구 실행 실패: {e}")))?,
    }
}

/// 결과 불명(unknown) 검토용 읽기 전용 관찰(RUN-018 보조). 현재 대상 상태를 다시 읽는다.
pub fn observe(name: &str, planned: &Planned, root: &Path) -> Value {
    match name {
        "write" | "edit" => fs::observe(planned, root),
        "apply_patch" => patch::observe(planned, root),
        "shell" => json!({ "note": "셸 명령의 결과는 자동으로 관찰할 수 없습니다. 관련 출력·파일을 직접 확인하세요", "target": planned.target }),
        "agent" => json!({ "note": "자식 에이전트 작업 목록에서 실제 시작 여부를 확인하세요", "target": planned.target }),
        "web_fetch" => json!({ "note": "외부 웹 요청은 자동으로 다시 보내지 않습니다. 필요하면 새 요청으로 승인받으세요", "target": planned.target }),
        _ => json!({ "note": "실제 결과는 관련 기록·파일·외부 서비스에서 확인하세요. 지원하지 않는 과거 도구를 자동으로 다시 실행하지 않습니다" }),
    }
}
