//! 개인 문맥을 제외한 단발 실행 `grove exec`(ONCE).
//!
//! - 별도 agent loop를 만들지 않는다. 작업 전용 데이터 디렉터리로 같은 서버 코어를 loopback에 띄우고 공용 HTTP API로
//!   프로필·프로젝트·대화·턴을 만든 뒤 결과를 기다린다. 기존 개인 DB·대화·기억·설정은 열지 않는다.
//! - 대화형 승인 창은 없다. 사전 허용(`--allow-tool`) 밖의 변경 도구나 질문이 나오면 턴을 취소하고 needs_approval/needs_input으로 끝낸다.
//! - stdout에는 버전 있는 JSON 하나만 쓰고 진단은 stderr로 보낸다. 실행 receipt(`result.json`)는 출력보다 먼저 저장한다.
//! - 파일·네트워크 격리(sandbox)가 아니다. 허용한 셸은 프로젝트 밖과 네트워크에 접근할 수 있다.

use crate::config::Config;
use crate::util::SystemClock;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const SCHEMA: &str = "grove.exec.v1";

/// 종료 코드(호환 계약, ONCE-008). 숫자를 바꾸지 않는다.
pub mod code {
    pub const SUCCESS: i32 = 0;
    pub const FAILED: i32 = 1;
    pub const INPUT: i32 = 2;
    pub const CONFIG: i32 = 3;
    pub const NEEDS_USER: i32 = 4;
    pub const TIMEOUT: i32 = 5;
    pub const CANCELLED: i32 = 6;
    pub const UNKNOWN: i32 = 7;
}

pub const HELP: &str = "grove exec — 개인 문맥 없이 명시한 모델로 한 작업을 실행

사용법:
  grove exec --base-url URL --model 이름 (--prompt 텍스트 | --stdin) [옵션]
  grove exec show <run 디렉터리>        저장된 결과를 다시 출력(다시 실행하지 않음)

옵션:
  --project 경로            작업 폴더(기본: 현재 폴더, 상대 경로는 현재 폴더 기준)
  --protocol openai|anthropic|gemini   (기본 openai)
  --api-key-env 변수        API 키를 읽을 환경변수 이름(키 원문은 인자로 받지 않음)
  --tools                   Grove 도구 사용(읽기 도구는 바로, 변경 도구는 --allow-tool에 있어야 실행)
  --allow-tool 이름         승인 없이 실행할 변경 도구(여러 번 지정)
  --read-only               읽기 도구만 허용
  --effort low|medium|high  추론 강도(기본: 보내지 않음)
  --max-tokens N            요청 token 예산   --max-minutes N   요청 시간 예산
  --with-project-instructions   프로젝트 AGENTS.md·CLAUDE.md를 넣음(기본 제외)
  --run-dir 경로            작업 데이터·receipt 저장 위치(없거나 빈 폴더, 기본 <데이터 경로>/exec-runs/<run ID>)

기본 제외: 기존 대화·장기 기억·사용자 배경·프로젝트 지침 파일·봇·예약·자식 에이전트 자동 시작.
격리 아님: 파일·네트워크 sandbox가 없습니다. 허용한 셸은 프로젝트 밖과 네트워크에 접근할 수 있습니다.
같은 명령을 다시 실행하면 새 요청입니다. CI 재시도가 변경 도구를 중복 실행할 수 있습니다.
종료 코드: 0 성공, 1 실행 실패, 2 입력 오류, 3 인증·설정 오류, 4 승인·입력 필요, 5 시간 초과, 6 취소, 7 결과 불명";

#[derive(Default, Debug)]
struct Opts {
    base_url: Option<String>,
    model: Option<String>,
    protocol: Option<String>,
    api_key_env: Option<String>,
    prompt: Option<String>,
    stdin: bool,
    project: Option<PathBuf>,
    tools: bool,
    allow: Vec<String>,
    read_only: bool,
    effort: Option<String>,
    max_tokens: Option<i64>,
    max_minutes: Option<i64>,
    instructions: bool,
    run_dir: Option<PathBuf>,
}

fn parse(args: &[String]) -> Result<Opts, String> {
    let mut o = Opts::default();
    let mut it = args.iter();
    let val = |it: &mut std::slice::Iter<String>, n: &str| it.next().cloned().ok_or(format!("{n} 값이 필요합니다"));
    let num = |s: String, n: &str| s.parse::<i64>().ok().filter(|v| *v > 0).ok_or(format!("{n}는 양의 정수여야 합니다"));
    while let Some(a) = it.next() {
        match a.as_str() {
            "--base-url" => o.base_url = Some(val(&mut it, a)?),
            "--model" => o.model = Some(val(&mut it, a)?),
            "--protocol" => o.protocol = Some(val(&mut it, a)?),
            "--api-key-env" => o.api_key_env = Some(val(&mut it, a)?),
            "--prompt" => o.prompt = Some(val(&mut it, a)?),
            "--stdin" => o.stdin = true,
            "--project" => o.project = Some(PathBuf::from(val(&mut it, a)?)),
            "--tools" => o.tools = true,
            "--allow-tool" => o.allow.push(val(&mut it, a)?),
            "--read-only" => o.read_only = true,
            "--effort" => o.effort = Some(val(&mut it, a)?),
            "--max-tokens" => o.max_tokens = Some(num(val(&mut it, a)?, a)?),
            "--max-minutes" => o.max_minutes = Some(num(val(&mut it, a)?, a)?),
            "--with-project-instructions" => o.instructions = true,
            "--run-dir" => o.run_dir = Some(PathBuf::from(val(&mut it, a)?)),
            "--api-key" => return Err("API 키는 인자로 받지 않습니다. --api-key-env로 환경변수 이름을 주세요".into()),
            other => return Err(format!("알 수 없는 exec 옵션: {other}")),
        }
    }
    if o.prompt.is_some() && o.stdin {
        return Err("--prompt와 --stdin 중 하나만 쓰세요".into());
    }
    if o.prompt.is_none() && !o.stdin {
        return Err("--prompt 또는 --stdin이 필요합니다".into());
    }
    if o.base_url.is_none() || o.model.is_none() {
        return Err("--base-url과 --model을 명시해야 합니다(다른 모델을 자동으로 고르지 않습니다)".into());
    }
    if !matches!(o.protocol.as_deref().unwrap_or("openai"), "openai" | "anthropic" | "gemini") {
        return Err("--protocol은 openai·anthropic·gemini 중 하나입니다".into());
    }
    if !o.allow.is_empty() && !o.tools {
        return Err("--allow-tool은 --tools와 함께 씁니다".into());
    }
    if o.read_only && !o.allow.is_empty() {
        return Err("--read-only와 --allow-tool은 함께 쓸 수 없습니다".into());
    }
    Ok(o)
}

/// 결과 JSON. stdout에 쓰는 것과 receipt가 같다.
fn outcome(run_id: &str, run_dir: &Path, status: &str, exit: i32, extra: Value) -> Value {
    let mut v = json!({
        "schema": SCHEMA, "run_id": run_id, "run_dir": run_dir, "status": status, "exit_code": exit,
        "isolation": "none",
        "excluded_context": ["sessions", "memories", "user_profile", "bots", "schedules"],
    });
    if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
        for (k, x) in e {
            o.insert(k.clone(), x.clone());
        }
    }
    v
}

/// stdout에 JSON 하나를 쓴다. 읽는 쪽이 pipe를 닫아도 실행 결과는 이미 receipt에 있으므로 쓰기 실패만 무시한다.
fn emit(v: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", serde_json::to_string_pretty(v).unwrap_or_default());
    let _ = out.flush();
}

pub fn run(args: &[String]) -> i32 {
    if args.first().map(String::as_str) == Some("show") {
        return show(args.get(1).map(PathBuf::from));
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{HELP}");
        return code::SUCCESS;
    }
    let o = match parse(args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("오류: {e}\n\n{HELP}");
            return code::INPUT;
        }
    };
    let prompt = match &o.prompt {
        Some(p) => p.clone(),
        None => {
            let mut s = String::new();
            if let Err(e) = std::io::stdin().read_to_string(&mut s) {
                eprintln!("오류: stdin을 읽지 못했습니다: {e}");
                return code::INPUT;
            }
            s
        }
    };
    if prompt.trim().is_empty() {
        eprintln!("오류: 빈 요청입니다");
        return code::INPUT;
    }
    let cwd = match std::env::current_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("오류: 현재 폴더를 알 수 없습니다: {e}");
            return code::INPUT;
        }
    };
    let project = cwd.join(o.project.clone().unwrap_or_else(|| PathBuf::from(".")));
    let project = match project.canonicalize() {
        Ok(p) if p.is_dir() => p,
        _ => {
            eprintln!("오류: 작업 폴더가 없습니다: {}", project.display());
            return code::INPUT;
        }
    };
    let api_key = match &o.api_key_env {
        Some(name) => match std::env::var(name) {
            Ok(v) if !v.trim().is_empty() => Some(v),
            _ => {
                eprintln!("오류: 환경변수 {name}에 API 키가 없습니다");
                return code::CONFIG;
            }
        },
        None => None,
    };
    let run_id = crate::util::new_id();
    let run_dir = match &o.run_dir {
        Some(d) => cwd.join(d),
        None => match crate::config::default_data_dir() {
            Some(d) => d.join("exec-runs").join(&run_id),
            None => {
                eprintln!("오류: 작업 데이터 경로를 정할 수 없습니다. --run-dir를 지정하세요");
                return code::INPUT;
            }
        },
    };
    // 고유 작업 디렉터리: 이미 내용이 있으면 쓰지 않는다(다른 실행의 증거를 덮어쓰지 않음).
    if run_dir.exists() && std::fs::read_dir(&run_dir).map(|mut d| d.next().is_some()).unwrap_or(true) {
        eprintln!("오류: run 디렉터리가 비어 있지 않습니다: {}", run_dir.display());
        return code::INPUT;
    }
    if let Err(e) = std::fs::create_dir_all(&run_dir) {
        eprintln!("오류: run 디렉터리를 만들 수 없습니다: {e}");
        return code::INPUT;
    }
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("오류: {e}");
            return code::FAILED;
        }
    };
    let (status, exit, mut extra) = rt.block_on(execute(&o, &prompt, &project, &run_dir, api_key));
    // 명시적으로 넣은 문맥은 출처와 범위를 함께 남긴다(ONCE-003).
    extra["included_context"] = if o.instructions {
        json!([{ "kind": "project_instructions", "files": ["AGENTS.md", "CLAUDE.md"], "root": project }])
    } else {
        json!([])
    };
    let result = outcome(&run_id, &run_dir, status, exit, extra);
    if let Err(e) = std::fs::write(run_dir.join("result.json"), serde_json::to_vec_pretty(&result).unwrap_or_default()) {
        eprintln!("경고: 결과 receipt를 저장하지 못했습니다: {e}");
    }
    emit(&result);
    exit
}

fn show(dir: Option<PathBuf>) -> i32 {
    let Some(dir) = dir else {
        eprintln!("오류: run 디렉터리가 필요합니다");
        return code::INPUT;
    };
    match std::fs::read(dir.join("result.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
        Some(v) if v["schema"] == SCHEMA => {
            emit(&v);
            v["exit_code"].as_i64().map(|c| c as i32).unwrap_or(code::UNKNOWN)
        }
        _ => {
            // receipt가 없으면 실행이 끝까지 기록되지 않은 것이다. 다시 실행하지 않고 결과 불명으로 알린다.
            eprintln!("결과 receipt가 없습니다. 실행 중 중단됐을 수 있으며 결과는 불명입니다. 작업 데이터는 {}에 보존됩니다", dir.display());
            code::UNKNOWN
        }
    }
}

struct Api {
    client: reqwest::Client,
    base: String,
    token: String,
}

impl Api {
    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, (u16, Value)> {
        let mut r = self.client.request(method.clone(), format!("{}/api/v1{path}", self.base)).bearer_auth(&self.token);
        if method != reqwest::Method::GET {
            r = r.header("Idempotency-Key", crate::util::new_id());
        }
        if let Some(b) = body {
            r = r.json(&b);
        }
        let resp = r.send().await.map_err(|e| (0, json!({ "error": { "code": "internal", "message": e.to_string() } })))?;
        let st = resp.status();
        let v = resp.json::<Value>().await.unwrap_or(Value::Null);
        if st.is_success() { Ok(v) } else { Err((st.as_u16(), v)) }
    }

    async fn setting(&self, scope: &str, key: &str, value: Value) -> Result<(), (u16, Value)> {
        self.call(reqwest::Method::PUT, &format!("/settings/{scope}/{key}"), Some(json!({ "expected_revision": 0, "value": value }))).await.map(|_| ())
    }
}

fn api_error(e: (u16, Value)) -> Value {
    let err = &e.1["error"];
    json!({ "code": err["code"].as_str().unwrap_or("internal"), "message": err["message"].as_str().unwrap_or(""), "http_status": e.0 })
}

async fn execute(o: &Opts, prompt: &str, project: &Path, run_dir: &Path, api_key: Option<String>) -> (&'static str, i32, Value) {
    let cfg = Config {
        data_dir: run_dir.join("data"),
        listen: "127.0.0.1:0".parse().expect("loopback"),
        allowed_origins: vec![],
        allowed_hosts: vec![],
        tls_terminated: false,
        web_dir: None,
        enable_tool_loop: o.tools,
        approval_ttl_secs: 30 * 60,
        scheduler_tick_ms: 600_000,
        remote_watch_insecure_loopback: false,
    };
    let server = match crate::server::start(cfg, Arc::new(SystemClock)).await {
        Ok(s) => s,
        Err(e) => return ("failed", code::FAILED, json!({ "error": { "code": "start_failed", "message": e.to_string() } })),
    };
    let api = Api { client: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().expect("client"), base: format!("http://{}", server.addr), token: server.owner_token.clone() };
    let r = drive(&api, o, prompt, project, api_key).await;
    server.stop().await;
    r
}

async fn drive(api: &Api, o: &Opts, prompt: &str, project: &Path, api_key: Option<String>) -> (&'static str, i32, Value) {
    use reqwest::Method;
    let config_err = |e: (u16, Value)| ("config_error", code::CONFIG, json!({ "error": api_error(e) }));
    // 기본 제외: 프로젝트 지침 파일. 필요하면 명시적으로 넣는다(ONCE-003).
    let mode = if o.instructions { "both" } else { "off" };
    if let Err(e) = api.setting("server/-", "instructions.mode", json!(mode)).await {
        return config_err(e);
    }
    if o.read_only {
        if let Err(e) = api.setting("server/-", "tools.mode", json!("read_only")).await {
            return config_err(e);
        }
    }
    if !o.allow.is_empty() {
        if let Err(e) = api.setting("server/-", "tools.allow", json!(o.allow.join(","))).await {
            return ("input_error", code::INPUT, json!({ "error": api_error(e) }));
        }
    }
    let secret_id = match api_key {
        Some(k) => match api.call(Method::POST, "/secrets", Some(json!({ "label": "exec", "value": k }))).await {
            Ok(v) => v["id"].clone(),
            Err(e) => return config_err(e),
        },
        None => Value::Null,
    };
    let protocol = o.protocol.clone().unwrap_or_else(|| "openai".into());
    let mut profile = json!({ "name": "exec", "protocol": protocol, "base_url": o.base_url, "model": o.model, "options": {} });
    if !secret_id.is_null() {
        profile["secret_id"] = secret_id;
    }
    let profile = match api.call(Method::POST, "/model-profiles", Some(profile)).await {
        Ok(v) => v,
        Err(e) => return config_err(e),
    };
    let project = match api.call(Method::POST, "/projects", Some(json!({ "root_path": project }))).await {
        Ok(v) => v,
        Err(e) => return ("input_error", code::INPUT, json!({ "error": api_error(e) })),
    };
    let session = match api.call(Method::POST, &format!("/projects/{}/sessions", project["id"].as_str().unwrap_or("")), Some(json!({ "title": "exec" }))).await {
        Ok(v) => v,
        Err(e) => return ("failed", code::FAILED, json!({ "error": api_error(e) })),
    };
    let sid = session["id"].as_str().unwrap_or("").to_string();
    for (key, v) in [("runs.budget.max_tokens", o.max_tokens), ("runs.budget.max_minutes", o.max_minutes)] {
        if let Some(v) = v {
            if let Err(e) = api.setting(&format!("session/{sid}"), key, json!(v)).await {
                return ("input_error", code::INPUT, json!({ "error": api_error(e) }));
            }
        }
    }
    let body = json!({ "text": prompt, "profile_id": profile["id"], "tools": o.tools, "effort": o.effort.clone().unwrap_or_else(|| "auto".into()) });
    let turn = match api.call(Method::POST, &format!("/sessions/{sid}/turns"), Some(body)).await {
        // 접수 전 진단(ONCE-004): 비지원 capability·잘못된 effort 등은 모델을 부르지 않고 끝낸다.
        Err(e) if matches!(e.0, 400 | 422) || e.1["error"]["code"] == "unsupported" => return config_err(e),
        Err(e) => return ("failed", code::FAILED, json!({ "error": api_error(e) })),
        Ok(v) => v,
    };
    let tid = turn["turn"]["id"].as_str().unwrap_or("").to_string();
    let mut cancelled = false;
    let mut needs: Option<&'static str> = None;
    let t = loop {
        let t = match api.call(Method::GET, &format!("/turns/{tid}"), None).await {
            Ok(t) => t,
            Err(e) => return ("unknown", code::UNKNOWN, json!({ "turn_id": tid, "error": api_error(e) })),
        };
        match t["status"].as_str().unwrap_or("") {
            "completed" | "failed" | "cancelled" | "interrupted" => break t,
            "awaiting_approval" if needs.is_none() => {
                // 비대화 실행: 승인·답변 창이 없으므로 확정된 비성공으로 끝낸다(ONCE-006).
                let asking = t["tool_calls"].as_array().is_some_and(|a| a.iter().any(|c| c["status"] == "awaiting_input"));
                needs = Some(if asking { "needs_input" } else { "needs_approval" });
                let _ = api.call(Method::POST, &format!("/turns/{tid}/cancel"), Some(json!({}))).await;
            }
            _ => {}
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            _ = shutdown_signal(), if !cancelled => {
                cancelled = true;
                eprintln!("종료 신호를 받아 요청을 취소합니다");
                let _ = api.call(Method::POST, &format!("/turns/{tid}/cancel"), Some(json!({}))).await;
            }
        }
    };
    let msgs = api.call(Method::GET, &format!("/sessions/{sid}/messages?limit=200"), None).await.unwrap_or(Value::Null);
    let text = msgs["items"].as_array().into_iter().flatten()
        .filter(|m| m["role"] == "assistant" && m["turn_id"] == tid.as_str())
        .filter_map(|m| m["content"]["text"].as_str())
        .filter(|s| !s.is_empty())
        .last()
        .map(str::to_string);
    let calls: Vec<Value> = t["tool_calls"].as_array().into_iter().flatten()
        .map(|c| json!({ "name": c["name"], "status": c["status"], "approval_scope": c["approval_scope"] }))
        .collect();
    let unknown = calls.iter().any(|c| c["status"] == "unknown");
    let extra = json!({ "turn_id": tid, "text": text, "usage": t["usage"], "tool_calls": calls, "error": t["error"] });
    let status = t["status"].as_str().unwrap_or("");
    let err_code = t["error"]["code"].as_str().unwrap_or("");
    match (needs, status) {
        _ if unknown => ("unknown", code::UNKNOWN, extra),
        (Some(n), _) => (n, code::NEEDS_USER, extra),
        (None, "completed") => ("succeeded", code::SUCCESS, extra),
        (None, _) if err_code == "time_budget_exceeded" => ("timeout", code::TIMEOUT, extra),
        (None, "cancelled") | (None, "interrupted") if cancelled => ("cancelled", code::CANCELLED, extra),
        (None, "interrupted") => ("unknown", code::UNKNOWN, extra),
        (None, "cancelled") => ("cancelled", code::CANCELLED, extra),
        _ => ("failed", code::FAILED, extra),
    }
}

/// Ctrl+C(모든 OS)와 SIGTERM(Unix)을 공용 취소 경로로 보낸다(ONCE-010).
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::parse;

    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn options_require_explicit_model_and_prompt_and_refuse_key_arguments() {
        assert!(parse(&args(&["--model", "m", "--prompt", "x"])).is_err(), "base-url 없음");
        assert!(parse(&args(&["--base-url", "http://x", "--prompt", "x"])).is_err(), "model 없음");
        assert!(parse(&args(&["--base-url", "http://x", "--model", "m"])).is_err(), "prompt 없음");
        assert!(parse(&args(&["--base-url", "http://x", "--model", "m", "--prompt", "x", "--stdin"])).is_err());
        assert!(parse(&args(&["--base-url", "http://x", "--model", "m", "--prompt", "x", "--api-key", "sk"])).is_err(), "키 원문 인자 거부");
        assert!(parse(&args(&["--base-url", "http://x", "--model", "m", "--prompt", "x", "--allow-tool", "write"])).is_err(), "--tools 없이 허용 목록");
        assert!(parse(&args(&["--base-url", "http://x", "--model", "m", "--prompt", "x", "--tools", "--read-only", "--allow-tool", "write"])).is_err());
        assert!(parse(&args(&["--base-url", "http://x", "--model", "m", "--prompt", "x", "--protocol", "cohere"])).is_err());
        assert!(parse(&args(&["--base-url", "http://x", "--model", "m", "--prompt", "x", "--max-tokens", "0"])).is_err());
        let o = parse(&args(&["--base-url", "http://x", "--model", "m", "--stdin", "--tools", "--allow-tool", "write", "--max-minutes", "3"])).unwrap();
        assert!(o.stdin && o.tools && o.allow == ["write"] && o.max_minutes == Some(3) && !o.instructions);
    }
}
