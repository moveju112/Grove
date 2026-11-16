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
pub const DEFAULT_MODEL_CONCURRENCY: u64 = 10;

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
            key: crate::computer::ENABLED, menu: "agents", label: "서버 PC 제어",
            description: "데몬 OS에 맞춰 Windows 또는 Linux X11의 활성 창을 제어합니다. 각 요청은 이번만 승인해야 합니다. 로그인된 사용자 화면이 필요하며 휴대전화·다른 PC·Windows 서비스 Session 0·잠금 화면·Wayland는 제어하지 않습니다. 화면은 선택한 모델 제공자에게 전달되고 대화에 보관됩니다.",
            keywords: "computer use desktop screen capture 컴퓨터 화면 마우스 키보드",
            kind: "bool", options: &[], min: None, max: None, default: json!(false),
            scopes: &["server"], applies: "next_turn", advanced: false,
        },
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
            key: "agents.orchestration",
            menu: "agents",
            label: "에이전트 실행 방식",
            description: "solo=자식 시작·후속 지시 금지, delegated=허용 역할 안에서 기존 위임 승인 정책 적용. 상위 범위의 solo는 하위에서 해제할 수 없습니다. 기존 작업 조회·대기·취소는 유지합니다",
            keywords: "agent orchestration solo delegation 역할 위임",
            kind: "enum",
            options: &["solo", "delegated"],
            min: None,
            max: None,
            default: json!("delegated"),
            scopes: &["server", "project", "session"],
            applies: "immediate",
            advanced: false,
        },
        SettingDef {
            key: "agents.allowed_roles",
            menu: "agents",
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
            menu: "agents",
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
            menu: "agents",
            label: "도구 실행 모드",
            description: "Grove 도구에 적용합니다. 일반 파일 수정·셸 실행은 기본으로 자동 허용합니다. ask=사전 허용하지 않은 도구는 승인 후 실행, read_only=읽기 도구만 허용합니다. 일반 도구 전체 권한을 끄면 파일 수정·셸도 승인 후 실행합니다. 외부 CLI는 이 승인 모드와 별개로 sandbox 없이 실행합니다.",
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
            key: FULL_ACCESS,
            menu: "agents",
            label: "일반 도구 전체 권한",
            description: "기본으로 사용합니다. 파일 수정·셸 실행을 매번 승인하지 않고 허용합니다. 끄면 일반 도구도 개별 사전 허용이나 승인이 필요합니다. 셸은 서버 계정 권한으로 프로젝트 밖 파일·네트워크·SSH agent·환경변수의 자격증명에 접근할 수 있습니다. Grove 내부 환경변수는 전달하지 않습니다. 금지 도구·읽기 전용·PC 제어·에이전트 위임 정책은 유지합니다.",
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
            scopes: &["server", "project", "session"],
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
            scopes: &["server", "project", "session"],
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
            scopes: &["server", "project", "session"],
            applies: "next_turn",
            advanced: true,
        },
        SettingDef {
            key: "exec.isolation",
            menu: "agents",
            label: "프로세스 격리 수준",
            description: "항상 소유 프로세스 트리를 격리·정리합니다. Unix는 process group, Windows는 Job Object를 사용합니다. 파일·네트워크 접근을 막는 보안 sandbox는 아닙니다",
            keywords: "exec isolation process group job sandbox 프로세스 격리",
            kind: "enum",
            options: &["process_tree"],
            min: None,
            max: None,
            default: json!("process_tree"),
            scopes: &["server", "project", "session"],
            applies: "next_turn",
            advanced: false,
        },
        SettingDef {
            key: "exec.default_cwd",
            menu: "agents",
            label: "기본 작업 위치",
            description: "cwd를 생략한 새 모델 셸·대화 작업의 실행 root(worktree 포함) 안 상대 디렉터리입니다. '/'로 구분하고 '..'·절대 경로는 사용할 수 없습니다. 명시한 cwd가 우선하며 기본값 '.'은 실행 root입니다. 프로젝트 script는 확인한 root에서 실행합니다. 터미널·외부 CLI에는 적용하지 않습니다",
            keywords: "exec cwd directory working default 기본 작업 위치 디렉터리",
            kind: "string",
            options: &[],
            min: None,
            max: Some(4096),
            default: json!("."),
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
        SettingDef {
            key: "context.compaction_checks",
            menu: "agents",
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
            menu: "agents",
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
            menu: "agents",
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
    if d.key == crate::agent_policy::ROLES && !v.is_null() && !crate::agent_policy::valid_roles(v) {
        return Err(ApiError::invalid("위임 허용 역할 목록의 형태가 잘못됐습니다"));
    }
    if let Some(choice) = v.as_str()
        && let Some(reason) = exec_option_reason(d.key, choice)
    {
        return Err(ApiError::invalid(reason));
    }
    if d.key == "exec.default_cwd" && !v.is_null() {
        validate_default_cwd(v.as_str().unwrap())?;
    }
    if matches!(d.key, "exec.max_memory_mb" | "exec.max_cpu_seconds")
        && v.as_u64().is_some_and(|n| n > 0)
        && !cfg!(any(target_os = "linux", windows))
    {
        return Err(ApiError::invalid("이 서버 OS에서는 메모리·CPU 자원 한도를 지원하지 않습니다"));
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
        "exec.isolation" => match value {
            "none" => Some("프로세스 소유권·트리 정리는 해제할 수 없습니다".into()),
            "sandbox" => Some("파일·네트워크 sandbox는 아직 구현되지 않았습니다".into()),
            "process_tree" if !cfg!(any(unix, windows)) => Some("이 서버 OS에서는 프로세스 트리 격리를 지원하지 않습니다".into()),
            _ => None,
        },
        _ => None,
    }
}

fn validate_default_cwd(value: &str) -> ApiResult<()> {
    use std::path::{Component, Path};
    if value.is_empty()
        || value.contains(['\0', '\\', ':'])
        || Path::new(value).components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(ApiError::invalid("기본 작업 위치는 프로젝트 안 상대 경로여야 합니다('/' 구분, '..'·절대 경로 금지)"));
    }
    Ok(())
}

fn checked_cwd(root: &std::path::Path, value: &str) -> ApiResult<std::path::PathBuf> {
    let path = crate::tools::fs::resolve(root, value).map_err(|e| ApiError::invalid(e.message))?;
    if !path.is_dir() {
        return Err(ApiError::invalid("cwd 디렉터리가 없습니다"));
    }
    Ok(path)
}

/// 새 실행을 계획할 때만 호출한다. 명시적 cwd가 우선하며 승인된 target에는 다시 적용하지 않는다.
/// 실행 root(worktree 포함)를 호출자가 넘기고 기존 프로젝트 경계 검사를 재사용한다.
pub fn execution_cwd(
    c: &Connection,
    root: &std::path::Path,
    project: Option<&str>,
    session: Option<&str>,
    explicit: Option<&str>,
) -> ApiResult<std::path::PathBuf> {
    if let Some(value) = explicit {
        return checked_cwd(root, value);
    }
    let value = effective(c, "exec.default_cwd", project, session)?;
    let value = value.as_str().ok_or_else(|| ApiError::invalid("기본 작업 위치가 문자열이 아닙니다"))?;
    validate_default_cwd(value)?;
    checked_cwd(root, value)
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
    if crate::agent_policy::is_policy(d.key) && let Some(session) = session {
        let mut sid = session.to_string();
        for depth in 0..=crate::agents::MAX_DEPTH {
            let Some(run) = crate::agents::run_by_child(c, &sid)? else { break };
            if depth == crate::agents::MAX_DEPTH {
                layers.insert("parent:limit".into(), json!({"scope_id": sid, "value": crate::agent_policy::denied_value(d.key), "revision": 0}));
                break;
            }
            sid = run.parent_session_id;
            let (value, revision) = row(c, "session", &sid, d.key)?.unwrap_or((Value::Null, 0));
            // 자식은 같은 프로젝트에 속한다. 부모의 원래 계층을 남겨 변경된 server/project 값을 상속한다.
            layers.insert(format!("parent:{sid}"), json!({"scope_id": sid, "value": value, "revision": revision}));
        }
    }
    Ok(resolve_layers(d, layers))
}

fn resolve_local_layers(d: &SettingDef, layers: &serde_json::Map<String,Value>) -> (Value, &'static str) {
    let mut effective = d.default.clone();
    let mut source = "default";
    for scope in ["server","project","session"] {
        if let Some(layer) = layers.get(scope) && !layer["value"].is_null() {
            let next = crate::agent_policy::inherit(d.key, &effective, &layer["value"]);
            if next != effective || layer["value"] == next {
                source = scope;
            }
            effective = next;
        }
    }
    (effective, source)
}

fn resolve_layers(d: &SettingDef, layers: serde_json::Map<String,Value>) -> Value {
    let (mut effective, mut source) = resolve_local_layers(d, &layers);
    if crate::agent_policy::is_policy(d.key) {
        for (_, parent) in layers.iter().filter(|(key, _)| key.starts_with("parent:")) {
            let mut parent_layers = layers.clone();
            parent_layers.insert("session".into(), parent.clone());
            let (inherited, inherited_source) = resolve_local_layers(d, &parent_layers);
            let next = crate::agent_policy::inherit_parent(d.key, &effective, &inherited);
            if next != effective { source = inherited_source; }
            effective = next;
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

pub fn full_access(c: &Connection, project: &str, session: &str) -> ApiResult<bool> {
    Ok(effective(c, FULL_ACCESS, Some(project), Some(session))?.as_bool().unwrap_or(false))
}

pub async fn get_registry(_p: Principal) -> Json<Vec<Value>> {
    Json(registry().iter().map(|d| {
        let mut value = json!(d);
        if matches!(d.key, "exec.shell" | "exec.isolation") {
            let choices = if d.key == "exec.isolation" { &["process_tree", "none", "sandbox"][..] } else { d.options };
            let mut available = vec![];
            let mut unavailable = vec![];
            for &choice in choices {
                if let Some(reason) = exec_option_reason(d.key, choice) {
                    unavailable.push(json!({ "value": choice, "reason": reason }));
                } else {
                    available.push(choice);
                }
            }
            value["options"] = json!(available);
            value["unavailable_options"] = json!(unavailable);
        }
        if matches!(d.key, "exec.max_memory_mb" | "exec.max_cpu_seconds")
            && !cfg!(any(target_os = "linux", windows))
        {
            value["disabled_reason"] = json!("이 서버 OS에서는 메모리·CPU 자원 한도를 지원하지 않습니다");
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
    if key == crate::computer::ENABLED && !p.is_owner {
        return Err(ApiError::forbidden("서버 PC 제어는 소유자만 설정할 수 있습니다"));
    }
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
        if matches!(key.as_str(), "model.default_profile" | "context.summary_profile")
            && let Some(profile) = b.value.as_str().filter(|value| !value.is_empty())
        {
            crate::models::get_enabled_profile(tx, profile)?;
        }
        if key == "exec.default_cwd" && let Some(value) = b.value.as_str() {
            let root = if let Some(session) = &session {
                Some(crate::sessions::exec_root(tx, session)?)
            } else if let Some(project) = &project {
                Some(std::path::PathBuf::from(crate::projects::get(tx, project)?.root_path))
            } else {
                // 전역 상대 경로는 프로젝트마다 다르므로 새 실행 계획 시 실제 root에서 다시 검사한다.
                None
            };
            if let Some(root) = root { checked_cwd(&root, value)?; }
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
