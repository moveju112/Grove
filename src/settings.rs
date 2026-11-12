//! 범위별 설정(SETTINGS-001/002/017/018/020/023, CONFIG-001~008, DB-020).
//!
//! - registry 한 곳에 메뉴·이름·검색어·자료형·기본값·허용 범위·적용 시점을 정의한다.
//! - 우선순위: 대화(session) > 프로젝트(project) > 서버(server) > 기본값. 기기 설정은 클라이언트가 소유한다.
//! - 저장은 범위·대상·key별 revision 검사. 실패하면 기존 값이 그대로 남는다.

use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::idem;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
mod reset;
pub use reset::{apply as reset_apply, preview as reset_preview};
use std::io::Read;

#[derive(Debug, Clone, Serialize)]
pub struct SettingDef {
    pub key: &'static str,
    pub menu: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub keywords: &'static str,
    /// bool | int | string | text | enum
    pub kind: &'static str,
    pub options: &'static [&'static str],
    pub min: Option<i64>,
    pub max: Option<i64>,
    pub default: Value,
    pub scopes: &'static [&'static str],
    /// immediate | next_turn | restart
    pub applies: &'static str,
    pub advanced: bool,
}

pub fn registry() -> Vec<SettingDef> {
    vec![
        SettingDef {
            key: "model.default_profile",
            menu: "model",
            label: "기본 모델 프로필",
            description: "새 입력창의 초기 모델입니다. 프로젝트 설정이 서버 설정보다 우선하며 기존 탭의 명시적 선택·보류 요청은 바꾸지 않습니다. 비우면 기기 선택 또는 첫 활성 모델을 씁니다",
            keywords: "model default provider 기본 모델",
            kind: "string",
            options: &[],
            min: None,
            max: None,
            default: Value::Null,
            scopes: &["server", "project"],
            applies: "next_turn",
            advanced: false,
        },
        SettingDef {
            key: "instructions.mode",
            menu: "agents",
            label: "프로젝트 지침 파일",
            description: "프로젝트 root의 지침 파일을 모델 입력에 넣는 방식",
            keywords: "AGENTS.md CLAUDE.md instruction 지침",
            kind: "enum",
            options: &["agents_md", "claude_md", "both", "off"],
            min: None,
            max: None,
            default: json!("both"),
            scopes: &["server", "project"],
            applies: "next_turn",
            advanced: false,
        },
        SettingDef {
            key: "output.language",
            menu: "agents",
            label: "응답 언어",
            description: "비우면 모델 기본값. 예: 한국어",
            keywords: "language 언어 korean",
            kind: "string",
            options: &[],
            min: None,
            max: None,
            default: json!(""),
            scopes: &["server", "project", "session"],
            applies: "next_turn",
            advanced: false,
        },
        SettingDef {
            key: "output.style",
            menu: "agents",
            label: "출력 스타일",
            description: "모델 기본·간결하게·자세하게 중 선택합니다. 간결한 답변도 중요한 실패·위험·필요한 행동은 생략하지 않습니다.",
            keywords: "output style concise detailed 출력 스타일 간결 자세히",
            kind: "enum",
            options: &["default", "concise", "detailed"],
            min: None,
            max: None,
            default: json!("default"),
            scopes: &["server", "project", "session"],
            applies: "next_turn",
            advanced: false,
        },
        SettingDef {
            key: "context.auto_clear_minutes",
            menu: "agents",
            label: "idle 뒤 모델 context 초기화(분)",
            description: "새 사용자 요청 접수 시 마지막 대화·요청 종료 뒤 이 시간 이상 idle이면 이전 context를 요약 없이 제외합니다. 화면 이력·파일은 지우지 않습니다. 0이면 시간 제한 없이 유지(기본). 프로필별 값이 우선하며 실행·승인·추가 메시지 대기 중에는 초기화하지 않습니다.",
            keywords: "auto clear idle context 자동 초기화 유휴",
            kind: "int",
            options: &[],
            min: Some(0),
            max: Some(525_600),
            default: json!(0),
            scopes: &["server", "project", "session"],
            applies: "next_turn",
            advanced: true,
        },
        SettingDef {
            key: "sessions.allow_unrelated",
            menu: "agents",
            label: "모델의 관련 없는 대화 조회 허용",
            description: "기본 끔: recall 도구는 현재 대화와 실제 상속한 원본의 분기 시점까지만 조회합니다. 켜면 같은 프로젝트의 다른 대화를, scope=all이면 모든 프로젝트의 대화를 조회할 수 있습니다. 사용자 직접 검색과는 별도이며 변경 즉시 실행 직전에 적용합니다. 이미 전달한 결과·사본은 회수하지 않습니다.",
            keywords: "session access recall privacy unrelated 대화 접근 조회 회상 개인정보",
            kind: "bool",
            options: &[],
            min: None,
            max: None,
            default: json!(false),
            scopes: &["server","project","session"],
            applies: "immediate",
            advanced: true,
        },
        SettingDef {
            key: "user.profile",
            menu: "agents",
            label: "사용자 프로필",
            description: "모든 프로젝트의 다음 모델 요청에 전달할 배경 정보입니다(최대 4000자). 비밀정보는 넣지 마세요. 지워도 이전 요청 기록은 지우지 않습니다.",
            keywords: "user profile background experience 사용자 프로필 배경 경험",
            kind: "text",
            options: &[],
            min: None,
            max: Some(4000),
            default: json!(""),
            scopes: &["server"],
            applies: "next_turn",
            advanced: false,
        },
        SettingDef {
            key: "tools.default_enabled",
            menu: "agents",
            label: "도구 기본 사용",
            description: "새 요청에서 도구 사용을 기본으로 켤지",
            keywords: "tools 도구 기본",
            kind: "bool",
            options: &[],
            min: None,
            max: None,
            default: json!(false),
            scopes: &["server", "project", "session"],
            applies: "next_turn",
            advanced: false,
        },
        SettingDef {
            key: "context.summary_profile",
            menu: "agents",
            label: "압축 요약 모델",
            description: "대화 압축에 쓸 모델 프로필 ID. 비우면 요청에 쓰는 모델을 그대로 쓴다",
            keywords: "compact summary 요약 압축 모델",
            kind: "string",
            options: &[],
            min: None,
            max: None,
            default: json!(""),
            scopes: &["server", "project"],
            applies: "immediate",
            advanced: true,
        },
        SettingDef {
            key: "session.auto_title",
            menu: "agents",
            label: "대화 제목 자동 생성",
            description: "첫 요청이 끝나면 모델로 짧은 제목을 만든다(모델 비용 발생). 끄면 첫 줄을 제목으로 쓴다",
            keywords: "title 제목 자동 생성 naming",
            kind: "bool",
            options: &[],
            min: None,
            max: None,
            default: json!(false),
            scopes: &["server", "project"],
            applies: "next_turn",
            advanced: false,
        },
        SettingDef {
            key: "session.title_profile",
            menu: "agents",
            label: "제목 생성 모델",
            description: "제목 생성에 쓸 모델 프로필 ID. 비우면 그 대화의 마지막 요청 모델을 쓴다",
            keywords: "title 제목 모델",
            kind: "string",
            options: &[],
            min: None,
            max: None,
            default: json!(""),
            scopes: &["server", "project"],
            applies: "immediate",
            advanced: true,
        },
        SettingDef {
            key: "agents.delegation",
            menu: "agents",
            label: "자식 에이전트 위임",
            description: "모델이 자식 에이전트를 시작·후속 지시할 때: off=금지, ask=매번 승인, auto=자동(한도 안에서)",
            keywords: "agent delegation spawn subagent 위임 서브에이전트",
            kind: "enum",
            options: &["off", "ask", "auto"],
            min: None,
            max: None,
            default: json!("ask"),
            scopes: &["server", "project", "session"],
            applies: "immediate",
            advanced: false,
        },
        SettingDef {
            key: "tools.mode",
            menu: "agents",
            label: "도구 실행 모드",
            description: "ask=변경 도구는 승인 후 실행, read_only=읽기 도구만 허용(어느 범위에서든 read_only면 적용)",
            keywords: "read-only 읽기 전용 도구 정책 policy",
            kind: "enum",
            options: &["ask", "read_only"],
            min: None,
            max: None,
            default: json!("ask"),
            scopes: &["server", "project", "session"],
            applies: "immediate",
            advanced: false,
        },
        SettingDef {
            key: "tools.deny",
            menu: "agents",
            label: "금지 도구",
            description: "쉼표로 구분한 도구 이름. 어느 범위에 있든 금지가 우선한다",
            keywords: "deny 금지 도구 정책 policy",
            kind: "tool_list",
            options: &[],
            min: None,
            max: None,
            default: json!(""),
            scopes: &["server", "project", "session"],
            applies: "immediate",
            advanced: true,
        },
        SettingDef {
            key: "tools.allow",
            menu: "agents",
            label: "승인 없이 실행할 도구",
            description: "쉼표로 구분한 도구 이름. 금지·읽기 전용이 아닐 때만 승인을 건너뛴다(대화 범위에서는 넓힐 수 없음)",
            keywords: "allow 허용 자동 승인 도구 정책 policy",
            kind: "tool_list",
            options: &[],
            min: None,
            max: None,
            default: json!(""),
            scopes: &["server", "project"],
            applies: "immediate",
            advanced: true,
        },
        SettingDef {
            key: "runs.max_active",
            menu: "server",
            label: "동시 모델 호출 수",
            description: "서버 전체에서 동시에 진행하는 모델 호출 수. 넘치면 소유자별로 번갈아 다음 기회를 준다(승인 대기는 차지하지 않음)",
            keywords: "fair queue concurrency 동시 실행 한도 공정",
            kind: "int",
            options: &[],
            min: Some(1),
            max: Some(64),
            default: json!(4),
            scopes: &["server"],
            applies: "immediate",
            advanced: true,
        },
        SettingDef {
            key: "runs.provider_max_active",
            menu: "server",
            label: "공급자별 동시 모델 호출 수",
            description: "같은 HTTP origin(또는 설치 CLI 종류)의 추론 호출 한도. 대화·요약·제목이 공유하며 대기 중 다른 실행 슬롯을 잡지 않는다",
            keywords: "provider concurrency 공급자 한도 동시 실행",
            kind: "int",
            options: &[],
            min: Some(1),
            max: Some(64),
            default: json!(4),
            scopes: &["server"],
            applies: "next_turn",
            advanced: true,
        },
        SettingDef {
            key: "runs.account_max_active",
            menu: "server",
            label: "계정별 동시 모델 호출 수",
            description: "같은 공급자·자격 증명의 프로필들이 공유하는 추론 호출 한도. CLI는 설치 로그인 하나로 묶는다. 메타데이터 조회·상태·취소는 이 큐 밖이다",
            keywords: "account concurrency 계정 한도 동시 실행",
            kind: "int",
            options: &[],
            min: Some(1),
            max: Some(64),
            default: json!(4),
            scopes: &["server"],
            applies: "next_turn",
            advanced: true,
        },
        SettingDef {
            key: "runs.budget.max_tokens",
            menu: "server",
            label: "요청당 token 예산",
            description: "요청 하나(도구 단계 포함)가 쓸 수 있는 입력+출력 token 합계. 넘으면 남은 도구를 실행하지 않고 멈춘다. 0이면 제한 없음(기본)",
            keywords: "budget token limit 예산 한도 비용",
            kind: "int",
            options: &[],
            min: Some(0),
            max: Some(100_000_000),
            default: json!(0),
            scopes: &["server", "project", "session"],
            applies: "next_turn",
            advanced: true,
        },
        SettingDef {
            key: "runs.budget.max_minutes",
            menu: "server",
            label: "요청당 시간 예산(분)",
            description: "요청 하나가 시작부터 끝날 때까지 쓸 수 있는 시간(승인·답변 대기 포함). 넘으면 진행 중 모델 응답을 버리고 멈춘다. 0이면 제한 없음(기본, 정상 진행을 시간으로 끊지 않음)",
            keywords: "budget time limit timeout 예산 시간 한도",
            kind: "int",
            options: &[],
            min: Some(0),
            max: Some(10_080),
            default: json!(0),
            scopes: &["server", "project", "session"],
            applies: "next_turn",
            advanced: true,
        },
        SettingDef {
            key: "runs.budget.max_cost_cents",
            menu: "server",
            label: "요청당 비용 예산(1/100 통화 단위)",
            description: "요청 하나의 추정 비용 한도(모델 프로필 가격표 기준, 예: 150 = 1.50 USD). 넘으면 남은 도구를 실행하지 않고 멈춘다. 가격표가 없는 프로필로는 요청을 받지 않는다. 0이면 제한 없음(기본)",
            keywords: "budget cost price limit 비용 예산 한도 금액",
            kind: "int",
            options: &[],
            min: Some(0),
            max: Some(100_000_000),
            default: json!(0),
            scopes: &["server", "project", "session"],
            applies: "next_turn",
            advanced: true,
        },
        SettingDef {
            key: "runs.max_queued_per_owner",
            menu: "server",
            label: "소유자별 대기 한도",
            description: "한 기기·예약 등 소유자가 동시에 쌓아 둘 수 있는 실행 중·대기 턴 수. 넘치면 접수를 거부한다(다시 시도 가능)",
            keywords: "fair queue limit 대기 한도",
            kind: "int",
            options: &[],
            min: Some(1),
            max: Some(1000),
            default: json!(16),
            scopes: &["server"],
            applies: "immediate",
            advanced: true,
        },
        SettingDef {
            key: "runs.max_queued_total",
            menu: "server",
            label: "전체 대기 한도",
            description: "서버 전체의 실행 중·대기 턴 수 상한. 넘치면 접수를 거부한다(다시 시도 가능)",
            keywords: "fair queue limit 전체 한도",
            kind: "int",
            options: &[],
            min: Some(1),
            max: Some(10_000),
            default: json!(64),
            scopes: &["server"],
            applies: "immediate",
            advanced: true,
        },
        SettingDef {
            key: "exec.shell",
            menu: "agents",
            label: "명령 실행 셸",
            description: "모델 셸 도구·백그라운드 작업·새 터미널에 쓸 셸. 기본은 Linux bash(터미널은 로그인 셸), Windows PowerShell",
            keywords: "shell bash zsh pwsh powershell cmd 셸 터미널",
            kind: "enum",
            options: crate::tools::shell::SHELL_CHOICES,
            min: None,
            max: None,
            default: json!("default"),
            scopes: &["server", "project"],
            applies: "next_turn",
            advanced: false,
        },
        SettingDef {
            key: "exec.max_memory_mb",
            menu: "agents",
            label: "명령 메모리 한도(MB)",
            description: "모델 셸 도구·백그라운드 작업의 메모리 한도. 0이면 제한 없음. Linux는 프로세스마다 주소 공간, Windows는 작업 트리 합계 기준",
            keywords: "memory ram limit 메모리 한도 셸 작업",
            kind: "int",
            options: &[],
            min: Some(0),
            max: Some(1_048_576),
            default: json!(0),
            scopes: &["server", "project"],
            applies: "next_turn",
            advanced: true,
        },
        SettingDef {
            key: "exec.max_cpu_seconds",
            menu: "agents",
            label: "명령 CPU 시간 한도(초)",
            description: "모델 셸 도구·백그라운드 작업이 쓸 수 있는 CPU 시간. 0이면 제한 없음. 경과 시간 제한(timeout)과 별개. Linux는 프로세스마다, Windows는 작업 트리 합계 기준",
            keywords: "cpu limit 한도 셸 작업 시간",
            kind: "int",
            options: &[],
            min: Some(0),
            max: Some(86_400),
            default: json!(0),
            scopes: &["server", "project"],
            applies: "next_turn",
            advanced: true,
        },
        SettingDef {
            key: "storage.trash_retention_days",
            menu: "server",
            label: "파일 휴지통 보존 기간(일)",
            description: "화면에서 지운 파일을 휴지통에 남겨 두는 기간. 0이면 자동으로 지우지 않고 직접 영구 삭제할 때까지 보관",
            keywords: "trash retention 휴지통 보존 삭제 정리",
            kind: "int",
            options: &[],
            min: Some(0),
            max: Some(3650),
            default: json!(0),
            scopes: &["server"],
            applies: "immediate",
            advanced: true,
        },
        SettingDef {
            key: "storage.task_log_retention_days",
            menu: "server",
            label: "백그라운드 작업 로그 보존 기간(일)",
            description: "끝난 백그라운드 작업의 출력 로그를 남겨 두는 기간. 0이면 작업 기록이 남아 있는 동안 보관",
            keywords: "log retention 로그 보존 작업 정리",
            kind: "int",
            options: &[],
            min: Some(0),
            max: Some(3650),
            default: json!(0),
            scopes: &["server"],
            applies: "immediate",
            advanced: true,
        },
        SettingDef {
            key: "approval.ttl_secs",
            menu: "server",
            label: "승인 대기 시간(초)",
            description: "승인 요청이 만료되기까지의 시간",
            keywords: "approval expire 승인 만료",
            kind: "int",
            options: &[],
            min: Some(30),
            max: Some(86_400),
            default: json!(1800),
            scopes: &["server"],
            applies: "immediate",
            advanced: true,
        },
        SettingDef {
            key: "context.auto_compact_percent",
            menu: "agents",
            label: "자동 압축 기준(%)",
            description: "context 사용률이 이 값을 넘으면 다음 턴 전에 압축을 제안한다. 0이면 끔",
            keywords: "compact 압축 context",
            kind: "int",
            options: &[],
            min: Some(0),
            max: Some(95),
            default: json!(0),
            scopes: &["server", "project"],
            applies: "next_turn",
            advanced: true,
        },
        SettingDef {
            key: "context.input_reserve_tokens",
            menu: "agents",
            label: "입력 여유분(token)",
            description: "응답 최대 출력 외에 도구 결과·다음 입력을 위해 비워 둘 token. 여유가 모자라면 자동 압축이 켜져 있을 때 다음 턴 전에 압축한다",
            keywords: "buffer reserve 여유 context token",
            kind: "int",
            options: &[],
            min: Some(0),
            max: Some(200_000),
            default: json!(2000),
            scopes: &["server", "project"],
            applies: "next_turn",
            advanced: true,
        },
    ]
}

pub fn def(key: &str) -> Option<SettingDef> {
    registry().into_iter().find(|d| d.key == key)
}

pub fn validate(d: &SettingDef, v: &Value) -> ApiResult<()> {
    let ok = match d.kind {
        "bool" => v.is_boolean(),
        "int" => v.as_i64().is_some_and(|n| d.min.is_none_or(|m| n >= m) && d.max.is_none_or(|m| n <= m)),
        "string" | "text" => v.is_null() || v.as_str().is_some_and(|s| s.chars().count() <= d.max.unwrap_or(200) as usize),
        "enum" => v.as_str().is_some_and(|s| d.options.contains(&s)),
        // 알려진 도구 이름만(오타로 정책이 조용히 무시되지 않게)
        "tool_list" => v.is_null() || v.as_str().is_some_and(|s| s.len() <= 500 && tool_names(s).all(|n| crate::tools::spec(n).is_some())),
        _ => false,
    };
    if !ok {
        return Err(ApiError::invalid(format!("{}에 허용되지 않는 값입니다", d.label)));
    }
    Ok(())
}

fn row(c: &Connection, scope: &str, id: &str, key: &str) -> ApiResult<Option<(Value, i64)>> {
    Ok(c.query_row(
        "SELECT value, revision FROM settings WHERE scope = ?1 AND scope_id = ?2 AND key = ?3",
        params![scope, id, key],
        |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?)),
    )
    .optional()?
    .map(|(v, rev)| (v.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null), rev)))
}

/// 한 key의 범위별 값과 실제 적용값. 값이 null인 행은 "override 없음(revision만 유지)"이다.
pub fn resolve_key(c: &Connection, d: &SettingDef, project: Option<&str>, session: Option<&str>) -> ApiResult<Value> {
    let mut layers = serde_json::Map::new();
    for (scope, id) in [("server", Some("-")), ("project", project), ("session", session)] {
        if !d.scopes.contains(&scope) {
            continue;
        }
        let Some(id) = id else { continue };
        let r = row(c, scope, id, d.key)?;
        let (v, rev) = r.unwrap_or((Value::Null, 0));
        layers.insert(scope.to_string(), json!({ "scope_id": id, "value": v, "revision": rev }));
    }
    Ok(resolve_layers(d,layers))
}

fn resolve_layers(d: &SettingDef, layers: serde_json::Map<String,Value>) -> Value {
    let mut effective = d.default.clone();
    let mut source = "default";
    for scope in ["server","project","session"] {
        if let Some(layer) = layers.get(scope) && !layer["value"].is_null() {
            effective = layer["value"].clone();
            source = scope;
        }
    }
    json!({ "key": d.key, "default": d.default, "layers": layers, "effective": effective, "source": source })
}

pub fn tool_names(s: &str) -> impl Iterator<Item = &str> {
    s.split(',').map(str::trim).filter(|n| !n.is_empty())
}

/// 모든 범위(server→project→session)의 값. 가장 구체적인 값 하나가 아니라 합쳐야 하는 정책(deny 우선)에 쓴다.
pub fn all_layers(c: &Connection, key: &str, project: Option<&str>, session: Option<&str>) -> ApiResult<Vec<Value>> {
    let d = def(key).ok_or_else(|| ApiError::internal(format!("unknown setting {key}")))?;
    let mut out = vec![];
    for (scope, id) in [("server", Some("-")), ("project", project), ("session", session)] {
        if let (true, Some(id)) = (d.scopes.contains(&scope), id)
            && let Some((v, _)) = row(c, scope, id, key)?
            && !v.is_null()
        {
            out.push(v);
        }
    }
    Ok(out)
}

/// 서버 내부용: 적용값만.
pub fn effective(c: &Connection, key: &str, project: Option<&str>, session: Option<&str>) -> ApiResult<Value> {
    let d = def(key).ok_or_else(|| ApiError::internal(format!("unknown setting {key}")))?;
    Ok(resolve_key(c, &d, project, session)?["effective"].clone())
}

pub async fn get_registry(_p: Principal) -> Json<Vec<SettingDef>> {
    Json(registry())
}

#[derive(Deserialize)]
pub struct EffQuery {
    pub project_id: Option<String>,
    pub session_id: Option<String>,
}

pub async fn get_effective(State(app): State<App>, _p: Principal, Query(q): Query<EffQuery>) -> ApiResult<Json<Value>> {
    Ok(Json(
        app.db
            .call(move |c| {
                // 대화 범위는 그 대화의 프로젝트를 상속한다.
                let project = match (&q.session_id, &q.project_id) {
                    (Some(s), _) => Some(crate::sessions::get(c, s)?.project_id),
                    (None, Some(p)) => {
                        crate::projects::get(c, p)?;
                        Some(p.clone())
                    }
                    _ => None,
                };
                let items: Vec<Value> = registry()
                    .iter()
                    .map(|d| resolve_key(c, d, project.as_deref(), q.session_id.as_deref()))
                    .collect::<ApiResult<_>>()?;
                Ok(json!({ "project_id": project, "session_id": q.session_id, "items": items }))
            })
            .await?,
    ))
}

#[derive(Deserialize)]
pub struct PutSetting {
    pub expected_revision: i64,
    /// null이면 이 범위의 override를 지운다(상위 범위 값 적용).
    pub value: Value,
}

pub async fn put(
    State(app): State<App>,
    p: Principal,
    headers: HeaderMap,
    Path((scope, scope_id, key)): Path<(String, String, String)>,
    Json(b): Json<PutSetting>,
) -> ApiResult<Response> {
    let d = def(&key).ok_or_else(|| ApiError::not_found("알 수 없는 설정입니다"))?;
    if !d.scopes.contains(&scope.as_str()) {
        return Err(ApiError::invalid(format!("{}은(는) {scope} 범위에서 바꿀 수 없습니다", d.label)));
    }
    if scope == "server" && scope_id != "-" {
        return Err(ApiError::invalid("서버 범위의 scope_id는 '-'입니다"));
    }
    if !b.value.is_null() {
        validate(&d, &b.value)?;
    }
    let h = idem::body_hash("setting.put", &json!({ "s": scope, "i": scope_id, "k": key, "r": b.expected_revision, "v": b.value }));
    let actor = p.clone();
    idem::run(&app, &p, &headers, &h, move |tx, now| {
        let (project, session) = match scope.as_str() {
            "project" => (Some(crate::projects::get(tx, &scope_id)?.id), None),
            "session" => {
                let s = crate::sessions::get(tx, &scope_id)?;
                (Some(s.project_id), Some(scope_id.clone()))
            }
            _ => (None, None),
        };
        let prev = row(tx, &scope, &scope_id, &key)?;
        let cur = prev.as_ref().map(|r| r.1).unwrap_or(0);
        let old_value = prev.map(|r| r.0).unwrap_or(Value::Null);
        if cur != b.expected_revision {
            return Err(ApiError::revision_conflict(resolve_key(tx, &d, project.as_deref(), session.as_deref())?));
        }
        if matches!(key.as_str(), "model.default_profile" | "context.summary_profile")
            && let Some(profile) = b.value.as_str().filter(|value| !value.is_empty())
        {
            crate::models::get_enabled_profile(tx, profile)?;
        }
        tx.execute(
            "INSERT INTO settings (scope, scope_id, key, value, revision, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(scope, scope_id, key) DO UPDATE SET value = ?4, revision = ?5, updated_at = ?6",
            params![scope, scope_id, key, (!b.value.is_null()).then(|| b.value.to_string()), cur + 1, now],
        )?;
        let v = resolve_key(tx, &d, project.as_deref(), session.as_deref())?;
        events::append(tx, now, "setting.changed", project.as_deref(), session.as_deref(), &json!({ "scope": scope, "scope_id": scope_id, "key": key }))?;
        // 프로필 원문은 감사 로그에 중복 저장하지 않는다.
        let audit = if key == "user.profile" {
            json!({"old_present":old_value.as_str().is_some_and(|s| !s.trim().is_empty()),
                "new_present":b.value.as_str().is_some_and(|s| !s.trim().is_empty()),"revision":cur + 1})
        } else {
            json!({"old":old_value,"new":b.value,"revision":cur + 1})
        };
        crate::audit::record(
            tx,
            now,
            &actor,
            "setting.changed",
            &format!("{scope}:{scope_id}:{key}"),
            audit,
        )?;
        Ok((StatusCode::OK, json!({ "item": v, "applies": d.applies })))
    })
    .await
}

const INSTRUCTION_LIMIT: usize = 64 * 1024;

fn instruction_text(reader: impl Read) -> std::io::Result<String> {
    let mut bytes = Vec::with_capacity(INSTRUCTION_LIMIT + 1);
    reader.take((INSTRUCTION_LIMIT + 1) as u64).read_to_end(&mut bytes)?;
    Ok(if bytes.len() <= INSTRUCTION_LIMIT {
        String::from_utf8_lossy(&bytes).to_string()
    } else {
        format!("{}\n…(지침 파일이 {}바이트를 넘어 잘림)", String::from_utf8_lossy(&bytes[..INSTRUCTION_LIMIT]), INSTRUCTION_LIMIT)
    })
}

fn instruction_file(path: &std::path::Path) -> std::io::Result<Option<String>> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // 경로 확인 뒤 바뀐 leaf symlink를 따라가거나 FIFO의 writer를 기다리지 않는다.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() { return Ok(None); }
    instruction_text(file).map(Some)
}

/// 지침 파일 읽기(CTX-014~017). 프로젝트 root의 파일만, 크기 제한, 같은 파일(symlink) 중복 제거.
pub fn load_instructions(root: &std::path::Path, mode: &str) -> Vec<(String, String)> {
    let names: &[&str] = match mode {
        "agents_md" => &["AGENTS.md"],
        "claude_md" => &["CLAUDE.md"],
        "both" => &["AGENTS.md", "CLAUDE.md"],
        _ => &[],
    };
    let mut seen = std::collections::HashSet::new();
    let mut out = vec![];
    for n in names {
        let p = root.join(n);
        let Ok(canon) = crate::util::canonical(&p) else { continue };
        // 프로젝트 밖을 가리키는 symlink는 읽지 않는다.
        if !canon.starts_with(crate::util::canonical(root).unwrap_or_else(|_| root.to_path_buf())) || !seen.insert(canon.clone()) {
            continue;
        }
        let Ok(Some(text)) = instruction_file(&canon) else { continue };
        out.push((n.to_string(), text));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instruction_reads_are_bounded_even_when_metadata_understates_the_content() {
        struct Fixture { consumed: usize }
        impl Read for Fixture {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let remaining = INSTRUCTION_LIMIT + 1 - self.consumed;
                if remaining == 0 { return Err(std::io::Error::other("fixture: read beyond the input budget")); }
                let n = buf.len().min(remaining);
                buf[..n].fill(b'x');
                self.consumed += n;
                Ok(n)
            }
        }
        let mut reader = Fixture { consumed: 0 };
        let text = instruction_text(&mut reader).expect("길이 판정용 한 바이트 뒤는 읽지 않는다");
        assert_eq!(reader.consumed, INSTRUCTION_LIMIT + 1);
        assert!(text.starts_with(&"x".repeat(INSTRUCTION_LIMIT)));
        assert!(text.ends_with("바이트를 넘어 잘림)"));
    }

    #[test]
    fn shrinking_instructions_do_not_panic_and_exact_limit_is_not_truncated() {
        let text = instruction_text(std::io::Cursor::new(b"short")).unwrap();
        assert_eq!(text, "short");
        let text = instruction_text(std::io::Cursor::new(vec![b'x'; INSTRUCTION_LIMIT])).unwrap();
        assert_eq!(text, "x".repeat(INSTRUCTION_LIMIT));
    }

    #[cfg(unix)]
    #[test]
    fn instruction_leaf_replacement_and_fifo_do_not_read_or_block() {
        use std::os::unix::ffi::OsStrExt;
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let path = root.join("AGENTS.md");
        std::fs::write(&path, "original").unwrap();
        let prepared = std::fs::canonicalize(&path).unwrap();
        let outside = d.path().join("outside");
        std::fs::write(&outside, "outside secret fixture").unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(instruction_file(&prepared).is_err(), "경로 확인 뒤 교체된 symlink를 읽지 않는다");
        std::fs::remove_file(&path).unwrap();
        let cpath = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(cpath.as_ptr(), 0o600) }, 0);
        let (tx, rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || { tx.send(instruction_file(&prepared)).unwrap(); });
        assert!(rx.recv_timeout(std::time::Duration::from_secs(2)).expect("FIFO writer를 기다리지 않는다").unwrap().is_none());
        reader.join().unwrap();
    }

    #[test]
    fn validation() {
        let d = def("approval.ttl_secs").unwrap();
        assert!(validate(&d, &json!(60)).is_ok());
        assert!(validate(&d, &json!(5)).is_err());
        assert!(validate(&d, &json!("60")).is_err());
        let e = def("instructions.mode").unwrap();
        assert!(validate(&e, &json!("both")).is_ok());
        assert!(validate(&e, &json!("all")).is_err());
    }

    #[test]
    fn instructions_dedupe_and_boundary() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("p");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("AGENTS.md"), "규칙").unwrap();
        std::fs::write(d.path().join("outside.md"), "밖").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("AGENTS.md"), root.join("CLAUDE.md")).unwrap();
        }
        let v = load_instructions(&root, "both");
        assert_eq!(v.len(), 1, "같은 파일은 한 번만: {v:?}");
        assert!(load_instructions(&root, "off").is_empty());
        // 크기 초과는 잘라서 표시, 디렉터리 같은 읽기 불가 대상은 건너뛴다
        let big = root.join("big");
        std::fs::create_dir(&big).unwrap();
        std::fs::write(big.join("AGENTS.md"), "가".repeat(40_000)).unwrap();
        std::fs::create_dir(big.join("CLAUDE.md")).unwrap();
        let v = load_instructions(&big, "both");
        assert_eq!(v.len(), 1);
        assert!(v[0].1.ends_with("바이트를 넘어 잘림)"), "잘림 표시");
        #[cfg(unix)]
        {
            std::fs::remove_file(root.join("CLAUDE.md")).unwrap();
            std::os::unix::fs::symlink(d.path().join("outside.md"), root.join("CLAUDE.md")).unwrap();
            let v = load_instructions(&root, "claude_md");
            assert!(v.is_empty(), "프로젝트 밖 symlink는 읽지 않는다");
        }
    }

    /// CTX-014: 실행 위치 루트의 파일만 AGENTS.md → CLAUDE.md 순서로 읽고, 상위 폴더·하위 폴더 지침은 자동으로 읽지 않는다.
    #[test]
    fn instruction_files_load_from_exec_root_only_in_fixed_order() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("AGENTS.md"), "상위 폴더 지침").unwrap();
        let root = d.path().join("p");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("CLAUDE.md"), "클로드").unwrap();
        std::fs::write(root.join("AGENTS.md"), "에이전트").unwrap();
        std::fs::write(root.join("sub/AGENTS.md"), "하위 지침").unwrap();
        let v = load_instructions(&root, "both");
        assert_eq!(v, vec![("AGENTS.md".to_string(), "에이전트".to_string()), ("CLAUDE.md".to_string(), "클로드".to_string())]);
        std::fs::remove_file(root.join("AGENTS.md")).unwrap();
        assert!(load_instructions(&root, "agents_md").is_empty(), "프로젝트에 없으면 상위 폴더 파일로 대신하지 않는다");
    }
}
