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

pub const FULL_ACCESS: &str = "tools.full_access";
const MODEL_FAVORITES: &str = "model.favorites";
const MODEL_FAVORITES_LIMIT: usize = 24;
pub const DEFAULT_MODEL_CONCURRENCY: u64 = 10;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ModelFavorite {
    pub profile_id: String,
    pub model: String,
    pub effort: String,
    pub fast: bool,
}

fn model_favorites(value: &Value) -> ApiResult<Vec<ModelFavorite>> {
    let rows: Vec<ModelFavorite> = serde_json::from_value(value.clone())
        .map_err(|_| ApiError::invalid("즐겨찾기 형식이 잘못됐습니다"))?;
    if rows.len() > MODEL_FAVORITES_LIMIT {
        return Err(ApiError::invalid("즐겨찾기는 24개까지 저장할 수 있습니다"));
    }
    let mut seen = std::collections::HashSet::new();
    for row in &rows {
        if row.profile_id.is_empty() || row.profile_id.len() > 200 || !seen.insert(row) {
            return Err(ApiError::invalid("비어 있거나 중복된 즐겨찾기입니다"));
        }
        crate::runner::parse_model(Some(&row.model))?;
        if row.effort.is_empty() { return Err(ApiError::invalid("추론 옵션을 선택하세요")); }
        crate::provider::parse_effort(Some(&row.effort)).map_err(ApiError::invalid)?;
    }
    Ok(rows)
}

#[derive(Debug, Clone, Serialize)]
pub struct SettingDef {
    pub key: &'static str,
    pub menu: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub keywords: &'static str,
    /// bool | int | string | enum | tool_list | model
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

static REGISTRY: std::sync::LazyLock<Vec<SettingDef>> = std::sync::LazyLock::new(registry);

pub fn registry() -> Vec<SettingDef> {
    let mut defs = vec![
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
            key: MODEL_FAVORITES,
            menu: "composer", label: "모델 즐겨찾기", description: "같은 서버에 연결된 기기가 공유하는 모델 조합입니다.",
            keywords: "", kind: "model_favorites", options: &[], min: None, max: None,
            default: json!([]), scopes: &["server"], applies: "immediate", advanced: false,
        },
        SettingDef {
            key: "output.style",
            menu: "workflow",
            label: "출력 스타일",
            description: "디폴트는 스타일 지시를 추가하지 않습니다. 디테일은 근거·원리·예외까지, 심플은 핵심 설명까지, 미니멀은 결론·원인·결정적 사실을, 익스트림 미니멀은 보통 한두 문장으로 답합니다. 중요한 실패·위험·확인하지 못한 내용은 유지합니다.",
            keywords: "output response answer style default detailed simple minimal extreme concise 답변 출력 스타일 디폴트 디테일 심플 미니멀 익스트림 간결 자세히",
            kind: "enum",
            options: &["default", "detailed", "simple", "minimal", "extreme-minimal"],
            min: None,
            max: None,
            default: json!("default"),
            scopes: &["server", "project", "session"],
            applies: "next_turn",
            advanced: false,
        },
        SettingDef {
            key: "context.auto_clear_minutes",
            menu: "workflow",
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
            menu: "workflow",
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
            key: "context.summary_profile",
            menu: "workflow",
            label: "압축 요약 모델",
            description: "Context Compressor 전용 모델이에요. 역할을 켜고 모델을 선택하면 이 모델만 사용해요. 선택하지 않거나 역할을 끄면 기존 대화 모델로 압축해요",
            keywords: "compact summary 요약 압축 모델",
            kind: "model",
            options: &[],
            min: None,
            max: None,
            default: json!(""),
            scopes: &["server"],
            applies: "immediate",
            advanced: false,
        },
        SettingDef {
            key: "session.auto_title",
            menu: "workflow",
            label: "대화 제목 자동 생성",
            description: "매 요청이 끝나면 최근 대화의 목표에 맞춰 짧은 제목을 만들어요. 전용 모델을 선택해야 하며 모델 비용이 발생해요. 직접 바꾼 제목은 유지해요",
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
            menu: "workflow",
            label: "제목 생성 모델",
            description: "Title Generator 전용 모델이에요. 선택하지 않으면 자동 제목을 만들지 않아요. 대화·메모리 모델을 대신 사용하지 않아요.",
            keywords: "title 제목 모델",
            kind: "model",
            options: &[],
            min: None,
            max: None,
            default: json!(""),
            scopes: &["server"],
            applies: "immediate",
            advanced: false,
        },
        SettingDef {
            key: "agents.orchestration",
            menu: "agents",
            label: "오케스트레이션",
            description: "Solo에서는 기본 보조 역할만 호출하고, 켜면 작업자·검토자에게도 위임합니다. 제목·압축·메모리 정리는 별도로 동작해요. 상위 범위의 Solo 제한과 위임 권한은 유지합니다",
            keywords: "agent orchestration solo delegation 역할 위임",
            kind: "enum",
            options: &["solo", "delegated"],
            min: None,
            max: None,
            default: json!("solo"),
            scopes: &["server", "project", "session"],
            applies: "immediate",
            advanced: false,
        },
        SettingDef {
            key: "agents.allowed_roles",
            menu: "workflow",
            label: "위임 허용 역할",
            description: "실제 에이전트 ID를 쉼표로 구분합니다(예: worker,reviewer). *=전체, 빈 문자열=모두 금지. 서버·프로젝트·대화 및 부모 대화의 허용 목록을 교집합으로 적용합니다. 기본 역할 ID는 에이전트 정의에서 확인합니다",
            keywords: "agent role allow policy 역할 위임 허용",
            kind: "string",
            options: &[],
            min: None,
            max: Some(4096),
            default: json!("*"),
            scopes: &["server", "project", "session"],
            applies: "immediate",
            advanced: false,
        },
        SettingDef {
            key: "agents.delegation",
            menu: "workflow",
            label: "자식 에이전트 위임",
            description: "모델이 허용된 자식 에이전트를 시작·후속 지시할 때: off=금지, ask=매번 승인, auto=자동(한도 안에서). 상위 범위의 off는 하위에서 해제할 수 없습니다",
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
            menu: "workflow",
            label: "도구 실행 모드",
            description: "기본값인 bypass는 일반 도구를 승인 없이 실행해요. ask 모드에서는 사전 허용하지 않은 도구에 승인을 요청해요. 금지한 도구와 에이전트 위임의 별도 정책은 유지돼요. 외부 CLI는 이 설정과 별개로 실행돼요.",
            keywords: "bypass 자동 승인 도구 정책 policy",
            kind: "enum",
            options: &["ask", "bypass"],
            min: None,
            max: None,
            default: json!("bypass"),
            scopes: &["server", "project", "session"],
            applies: "immediate",
            advanced: false,
        },
        SettingDef {
            key: FULL_ACCESS,
            menu: "workflow",
            label: "일반 도구 전체 권한",
            description: "기본으로 켜져 있어요. ask 모드에서 끄면 파일 수정·셸 실행에 개별 사전 허용이나 승인이 필요해요. 켜면 셸에 서버 계정의 환경변수를 전달해 SSH·배포 작업에 쓸 수 있어요. Grove 내부 환경변수는 전달하지 않아요. 금지한 도구와 에이전트 위임의 별도 정책은 유지돼요.",
            keywords: "full access permission 권한 자동 승인 파일 셸 실행 SSH 배포 Release",
            kind: "bool",
            options: &[],
            min: None,
            max: None,
            default: json!(true),
            scopes: &["server", "project"],
            applies: "immediate",
            advanced: false,
        },
        SettingDef {
            key: "tools.deny",
            menu: "workflow",
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
            menu: "workflow",
            label: "승인 없이 실행할 도구",
            description: "도구 이름을 쉼표로 구분해 입력해요. 항상 승인한 도구도 여기에 저장돼요. 이름을 지우면 영구 승인이 해제돼요. 금지한 도구와 위임의 별도 정책은 유지되고, 대화 범위에서는 이 목록을 넓힐 수 없어요.",
            keywords: "allow always 영구 항상 허용 자동 승인 도구 정책 policy",
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
            default: json!(DEFAULT_MODEL_CONCURRENCY),
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
            default: json!(DEFAULT_MODEL_CONCURRENCY),
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
            default: json!(DEFAULT_MODEL_CONCURRENCY),
            scopes: &["server"],
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
            key: "exec.shell",
            menu: "workflow",
            label: "명령 실행 셸",
            description: "모델 셸 도구·백그라운드 작업·새 터미널에 쓸 셸. 기본은 Linux bash(터미널은 로그인 셸), Windows PowerShell",
            keywords: "shell bash zsh pwsh powershell cmd 셸 터미널",
            kind: "enum",
            options: crate::tools::shell::SHELL_CHOICES,
            min: None,
            max: None,
            default: json!("default"),
            scopes: &["server", "project", "session"],
            applies: "next_turn",
            advanced: false,
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
            key: "storage.history_compress_after_days",
            menu: "server",
            label: "대화 기록 자동 압축(일)",
            description: "마지막 대화 활동이나 열람 후 이 기간이 지나면 원문을 자동 압축해요. 기본은 7일이에요. 대화를 열면 필요한 부분만 원문 그대로 복원하며, 다시 사용하지 않으면 같은 기간 후 재압축해요. 제목·미리보기·검색은 그대로 사용할 수 있어요.",
            keywords: "history compression archive 저장 공간 대화 기록 압축 보관 기간",
            kind: "int",
            options: &[],
            min: Some(1),
            max: Some(3650),
            default: json!(7),
            scopes: &["server"],
            applies: "immediate",
            advanced: false,
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
            menu: "workflow",
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
            menu: "workflow",
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
        SettingDef {
            key: "context.compaction_checks",
            menu: "workflow",
            label: "압축 후보 추가 검사",
            description: "최소 대상 생략·원문보다 긴 요약 거부·연속 실패 정지를 쓴다. 끄면 이전 압축 방식으로 돌아가며 원문·기존 요약·되감기 보호는 그대로다",
            keywords: "compact 압축 policy 정책 rollback",
            kind: "bool",
            options: &[],
            min: None,
            max: None,
            default: json!(true),
            scopes: &["server", "project"],
            applies: "next_turn",
            advanced: true,
        },
        SettingDef {
            key: "context.compact_min_tokens",
            menu: "workflow",
            label: "자동 압축 최소 대상(token)",
            description: "요약할 이전 대화가 이보다 작으면 자동 압축을 건너뛰고 원문을 그대로 보낸다. 수동 압축에는 적용하지 않는다",
            keywords: "compact 압축 minimum 최소",
            kind: "int",
            options: &[],
            min: Some(0),
            max: Some(200_000),
            default: json!(500),
            scopes: &["server", "project"],
            applies: "next_turn",
            advanced: true,
        },
        SettingDef {
            key: "context.auto_compact_max_failures",
            menu: "workflow",
            label: "자동 압축 연속 실패 한도",
            description: "마지막 압축 이후 자동 압축이 이 횟수만큼 실패하면 같은 대화의 자동 압축을 멈춘다. 압축이 한 번 성공하면 다시 센다",
            keywords: "compact 압축 retry 실패",
            kind: "int",
            options: &[],
            min: Some(1),
            max: Some(10),
            default: json!(2),
            scopes: &["server", "project"],
            applies: "next_turn",
            advanced: true,
        },
    ];
    defs.extend([
        SettingDef {
            key: "memory.enabled", menu: "workflow", label: "메모리 자동 정리",
            description: "완료된 대화에서 재사용할 사실·결정·미완료 작업을 Maintainer로 정리해 회상 검색에 남겨요. 전용 모델이 필요하며 모델 비용이 발생해요. Claude/Codex 자체 메모리 파일은 바꾸지 않아요.",
            keywords: "memory recap maintainer 메모리 기억 정리", kind: "bool", options: &[],
            min: None, max: None, default: json!(false), scopes: &["server", "project"], applies: "immediate", advanced: false,
        },
        SettingDef {
            key: "memory.profile", menu: "workflow", label: "메모리 정리 모델",
            description: "Maintainer 전용 모델이에요. 선택하지 않으면 메모리를 정리하지 않아요. 제목·대화 모델을 대신 사용하지 않아요.",
            keywords: "memory recap maintainer 메모리 모델", kind: "model", options: &[],
            min: None, max: None, default: json!(""), scopes: &["server"], applies: "immediate", advanced: false,
        },
        SettingDef {
            key: "memory.interval_minutes", menu: "workflow", label: "메모리 정리 간격(분)",
            description: "새로 완료된 대화가 있을 때만 이 간격으로 정리해요. 서버 재시작 뒤에도 처리 위치를 이어가요.",
            keywords: "memory maintainer interval 메모리 주기 간격", kind: "int", options: &[],
            min: Some(1), max: Some(1440), default: json!(10), scopes: &["server", "project"], applies: "immediate", advanced: true,
        },
    ]);
    for &(id, key, label) in crate::definitions::ROLE_PROFILES {
        defs.push(SettingDef {
            key, menu: if crate::definitions::execution("agent", id) == "helper" { "workflow" } else { "agents" }, label,
            description: "이 역할의 전용 모델이에요. 비우면 부모 대화의 모델을 사용해요. 선택한 모델을 사용할 수 없으면 다른 모델로 전환하지 않아요.",
            keywords: "agent role model 에이전트 역할 모델", kind: "model", options: &[],
            min: None, max: None, default: json!(""), scopes: &["server"], applies: "next_turn", advanced: false,
        });
    }
    defs
}

pub fn def(key: &str) -> Option<SettingDef> {
    REGISTRY.iter().find(|d| d.key == key).cloned()
}

pub fn validate(d: &SettingDef, v: &Value) -> ApiResult<()> {
    if d.key == MODEL_FAVORITES { return model_favorites(v).map(|_| ()); }
    let ok = match d.kind {
        "model" => crate::models::ModelSelection::parse(v).is_ok(),
        "bool" => v.is_boolean(),
        "int" => v.as_i64().is_some_and(|n| d.min.is_none_or(|m| n >= m) && d.max.is_none_or(|m| n <= m)),
        "string" => v.is_null() || v.as_str().is_some_and(|s| s.chars().count() <= d.max.unwrap_or(200) as usize),
        // 기존 concise 저장값과 이전 클라이언트는 simple의 호환 별칭으로 받는다.
        "enum" => v.as_str().is_some_and(|s| d.options.contains(&s) || (d.key == "output.style" && s == "concise")),
        // 알려진 도구 이름만(오타로 정책이 조용히 무시되지 않게)
        "tool_list" => v.is_null() || v.as_str().is_some_and(|s| s.len() <= 500 && tool_names(s).all(|n| crate::tools::spec(n).is_some())),
        _ => false,
    };
    if !ok {
        return Err(ApiError::invalid(format!("{}에 허용되지 않는 값입니다", d.label)));
    }
    if d.key == crate::agent_policy::ROLES && !v.is_null() && !crate::agent_policy::valid_roles(v) {
        return Err(ApiError::invalid("위임 허용 역할 목록의 형태가 잘못됐습니다"));
    }
    if let Some(choice) = v.as_str()
        && let Some(reason) = exec_option_reason(d.key, choice)
    {
        return Err(ApiError::invalid(reason));
    }
    Ok(())
}

fn exec_option_reason(key: &str, value: &str) -> Option<String> {
    match key {
        "exec.shell" => {
            if !cfg!(windows) && matches!(value, "powershell" | "cmd") {
                return Some("이 셸은 Windows에서만 지원합니다".into());
            }
            let program = crate::tools::shell::program_of(value);
            let path = crate::deps::find_in_path(program);
            let executable = path.is_some_and(|path| {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    path.metadata().is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
                }
                #[cfg(not(unix))]
                {
                    let _ = path;
                    true
                }
            });
            (!executable).then(|| format!("{program} 실행 파일이 서버 PATH에 없거나 실행할 수 없습니다"))
        }
        _ => None,
    }
}

fn checked_cwd(root: &std::path::Path, value: &str) -> ApiResult<std::path::PathBuf> {
    let path = crate::tools::fs::resolve(root, value).map_err(|e| ApiError::invalid(e.message))?;
    if !path.is_dir() {
        return Err(ApiError::invalid("cwd 디렉터리가 없습니다"));
    }
    Ok(path)
}

/// 새 실행을 계획할 때만 호출한다. 명시적 cwd가 없으면 실행 root(worktree 포함)에서 실행한다.
/// 실행 root는 호출자가 넘기고 기존 프로젝트 경계 검사를 재사용한다.
pub fn execution_cwd(root: &std::path::Path, explicit: Option<&str>) -> ApiResult<std::path::PathBuf> {
    checked_cwd(root, explicit.unwrap_or("."))
}

fn row(c: &Connection, scope: &str, id: &str, key: &str) -> ApiResult<Option<(Value, i64)>> {
    Ok(c.prepare_cached(
        "SELECT value, revision FROM settings WHERE scope = ?1 AND scope_id = ?2 AND key = ?3",
    )?.query_row(
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
    let mut ancestors = Vec::new();
    if crate::agent_policy::is_policy(d.key) && let Some(session) = session {
        let mut sid = session.to_string();
        for depth in 0..=crate::agents::MAX_DEPTH {
            let Some(run) = crate::agents::run_by_child(c, &sid)? else { break };
            if depth == crate::agents::MAX_DEPTH {
                ancestors.push(String::from("parent:limit"));
                layers.insert("parent:limit".into(), json!({"scope_id": sid, "value": crate::agent_policy::denied_value(d.key), "revision": 0}));
                break;
            }
            sid = run.parent_session_id;
            let (value, revision) = row(c, "session", &sid, d.key)?.unwrap_or((Value::Null, 0));
            // 자식은 같은 프로젝트에 속한다. 부모의 원래 계층을 남겨 변경된 server/project 값을 상속한다.
            let key = format!("parent:{sid}");
            ancestors.push(key.clone());
            layers.insert(key, json!({"scope_id": sid, "value": value, "revision": revision}));
        }
    }
    Ok(resolve_layers(d, layers, &ancestors))
}

fn resolve_local_layers(d: &SettingDef, layers: &serde_json::Map<String,Value>, session: Option<&Value>) -> (Value, &'static str) {
    let mut effective = d.default.clone();
    let mut source = "default";
    for (scope, layer) in [("server", layers.get("server")), ("project", layers.get("project")), ("session", session)] {
        if let Some(layer) = layer && !layer["value"].is_null() {
            // 기본값은 명시한 상위 범위의 제한이 아니다.
            let upper = if source == "default" { &layer["value"] } else { &effective };
            let next = crate::agent_policy::inherit(d.key, upper, &layer["value"]);
            if next != effective || layer["value"] == next {
                source = scope;
            }
            effective = next;
        }
    }
    (effective, source)
}

fn resolve_layers(d: &SettingDef, layers: serde_json::Map<String,Value>, ancestors: &[String]) -> Value {
    // 루트 대화부터 적용해야 부모의 실제 제한을 모든 자식이 상속한다.
    let mut sessions = ancestors.iter().rev().map(|key| layers.get(key)).chain(std::iter::once(layers.get("session")));
    let (mut effective, mut source) = resolve_local_layers(d, &layers, sessions.next().flatten());
    for session in sessions {
        let (child, child_source) = resolve_local_layers(d, &layers, session);
        if d.key == crate::agent_policy::ORCHESTRATION && child_source == "default" { continue; }
        let next = crate::agent_policy::inherit_parent(d.key, &child, &effective);
        if next == child { source = child_source; }
        effective = next;
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

pub fn full_access(c: &Connection, project: &str, session: &str) -> ApiResult<bool> {
    Ok(effective(c, FULL_ACCESS, Some(project), Some(session))?.as_bool().unwrap_or(false))
}

pub async fn get_registry(_p: Principal) -> Json<Vec<Value>> {
    Json(REGISTRY.iter().filter(|d| d.key != MODEL_FAVORITES).map(|d| {
        let mut value = json!(d);
        if d.key == "exec.shell" {
            value["options"] = json!(d.options.iter().filter(|choice| exec_option_reason(d.key, choice).is_none()).collect::<Vec<_>>());
        }
        value
    }).collect())
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
                let items: Vec<Value> = REGISTRY
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
        if key == crate::agent_policy::ROLES && !b.value.is_null() {
            crate::agent_policy::validate_roles(tx, &b.value)?;
        }
        if d.kind == "model" && !b.value.is_null() {
            if let Some(selection) = crate::models::ModelSelection::parse(&b.value)? {
                selection.runtime(tx)?;
            }
        } else if key == MODEL_FAVORITES && !b.value.is_null() {
            let previous = model_favorites(&old_value).unwrap_or_default();
            for favorite in model_favorites(&b.value)?.into_iter().filter(|favorite| !previous.contains(favorite)) {
                let selection = crate::models::ModelSelection {
                    profile_id: favorite.profile_id, model: Some(favorite.model),
                    effort: crate::provider::parse_effort(Some(&favorite.effort)).map_err(ApiError::invalid)?,
                };
                let (profile, _) = selection.runtime(tx)?;
                if favorite.fast && !profile.capabilities.fast {
                    return Err(ApiError::invalid("이 모델 연결은 Fast를 지원하지 않습니다"));
                }
            }
        } else if key == "model.default_profile" && let Some(profile) = b.value.as_str().filter(|s| !s.is_empty()) {
            crate::models::get_enabled_profile(tx, profile)?;
        }
        record_change(tx, now, &actor, (&scope, &scope_id, &key), (project.as_deref(), session.as_deref()), &b, old_value)?;
        let v = resolve_key(tx, &d, project.as_deref(), session.as_deref())?;
        Ok((StatusCode::OK, json!({ "item": v, "applies": d.applies })))
    })
    .await
}

/// 이미 검증한 변경을 같은 transaction의 설정·이벤트·감사 기록에 저장한다.
pub(crate) fn record_change(
    tx: &rusqlite::Transaction<'_>, now: &str, actor: &Principal,
    (scope, scope_id, key): (&str, &str, &str), (project, session): (Option<&str>, Option<&str>),
    change: &PutSetting, old_value: Value,
) -> ApiResult<()> {
    let revision = change.expected_revision + 1;
    tx.execute(
        "INSERT INTO settings (scope, scope_id, key, value, revision, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(scope, scope_id, key) DO UPDATE SET value = ?4, revision = ?5, updated_at = ?6",
        params![scope, scope_id, key, (!change.value.is_null()).then(|| change.value.to_string()), revision, now],
    )?;
    events::append(tx, now, "setting.changed", project, session, &json!({ "scope": scope, "scope_id": scope_id, "key": key }))?;
    crate::audit::record(tx, now, actor, "setting.changed", &format!("{scope}:{scope_id}:{key}"),
        json!({"old":old_value,"new":change.value,"revision":revision}))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation() {
        let d = def("approval.ttl_secs").unwrap();
        assert!(validate(&d, &json!(60)).is_ok());
        assert!(validate(&d, &json!(5)).is_err());
        assert!(validate(&d, &json!("60")).is_err());
        let e = def("output.style").unwrap();
        assert!(validate(&e, &json!("concise")).is_ok());
        assert!(validate(&e, &json!("all")).is_err());
    }
}
