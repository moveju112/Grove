//! 시작 안내와 안전한 오류 계약(PC-003). 비밀값·원본 내부 오류는 출력하지 않는다.

use crate::config::Config;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy)]
pub(crate) enum FailureKind {
    Configuration,
    PortInUse,
    DataPermission,
    DatabaseBusy,
    SchemaMismatch,
    AlreadyRunning,
    Storage,
    Runtime,
    Listen,
}

impl FailureKind {
    fn details(self) -> (&'static str, i32, &'static str, &'static str) {
        match self {
            Self::Configuration => ("configuration", 2, "서버 설정을 읽을 수 없습니다", "GROVE_DATA_DIR·GROVE_LISTEN·GROVE_WEB_BASE와 명령행 옵션을 확인하세요"),
            Self::PortInUse => ("port_in_use", 10, "접속 주소의 포트가 이미 사용 중입니다", "기존 서버는 grove doctor로 확인하세요. 다른 서버를 실행하려면 --listen에 비어 있는 포트를 지정하세요"),
            Self::DataPermission => ("data_permission", 11, "데이터 경로에 읽기·쓰기 권한이 없습니다", "관련 경로와 상위 디렉터리의 소유자·접근 권한을 확인하고 같은 사용자로 다시 실행하세요. 원본 데이터는 삭제하지 마세요"),
            Self::DatabaseBusy => ("database_busy", 12, "데이터베이스가 다른 프로세스에 의해 잠겨 있습니다", "같은 DB를 사용하는 작업이 끝난 뒤 다시 실행하세요. DB·WAL·잠금 파일은 삭제하지 마세요"),
            Self::SchemaMismatch => ("schema_mismatch", 13, "DB schema가 이 실행 파일이 지원하는 버전보다 새롭습니다", "이 DB를 마지막으로 사용한 버전 이상의 grove로 실행하세요. schema를 낮추거나 원본을 덮어쓰지 마세요"),
            Self::AlreadyRunning => ("already_running", 14, "같은 데이터 디렉터리로 이미 서버가 실행 중입니다", "grove doctor --data-dir로 기존 서버를 확인하세요. 재시작은 기존 서버를 정상 종료한 뒤 같은 데이터 경로로 실행하세요"),
            Self::Storage => ("storage", 15, "데이터 경로 또는 DB를 준비할 수 없습니다", "경로·권한·남은 공간을 확인하세요. 원본 DB·WAL·첨부·키 파일을 보존하고 grove doctor --offline --data-dir로 읽기 전용 검사하세요"),
            Self::Runtime => ("runtime", 16, "서버 실행 환경을 준비할 수 없습니다", "로그 경로의 권한과 시스템 자원을 확인한 뒤 같은 명령으로 다시 실행하세요"),
            Self::Listen => ("listen", 17, "지정한 접속 주소에서 서버를 열 수 없습니다", "--listen의 IP가 이 장치의 주소인지, 포트를 사용할 권한이 있는지 확인하세요"),
        }
    }
}

#[derive(Debug)]
pub(crate) struct StartupError {
    kind: FailureKind,
    path: Option<PathBuf>,
}

impl StartupError {
    pub(crate) fn new(kind: FailureKind, path: Option<&Path>) -> Self {
        Self { kind, path: path.map(Path::to_path_buf) }
    }

    pub(crate) fn io(error: &std::io::Error, path: &Path) -> Self {
        let kind = if error.kind() == std::io::ErrorKind::PermissionDenied {
            FailureKind::DataPermission
        } else {
            FailureKind::Storage
        };
        Self::new(kind, Some(path))
    }

    pub(crate) fn database(cfg: &Config, message: &str) -> Self {
        // Db::open의 기존 경량 오류는 문자열만 보존한다. 알려진 원인만 분류하고 원문은 버린다.
        let kind = if message.starts_with("데이터베이스 schema ") && message.contains("보다 새롭습니다") {
            FailureKind::SchemaMismatch
        } else if message.contains("database is locked") || message.contains("database table is locked") || message.contains("데이터베이스가 잠겨 있습니다") {
            FailureKind::DatabaseBusy
        } else if message.contains("readonly database") || message.contains("Permission denied") || message.contains("Access is denied") || message.contains("데이터베이스 쓰기 권한") {
            FailureKind::DataPermission
        } else {
            FailureKind::Storage
        };
        Self::new(kind, Some(&cfg.db_path()))
    }

    pub(crate) fn api(cfg: &Config, error: crate::error::ApiError) -> Self {
        let kind = match error.code {
            "busy" => FailureKind::DatabaseBusy,
            "storage_permission" => FailureKind::DataPermission,
            _ => FailureKind::Storage,
        };
        Self::new(kind, Some(&cfg.data_dir))
    }

    pub(crate) fn exit_code(&self) -> i32 {
        self.kind.details().1
    }

    pub(crate) fn report(&self, cfg: Option<&Config>) -> Value {
        let (code, exit_code, cause, action) = self.kind.details();
        let mut report = json!({
            "status": "failed", "ready": false,
            "error": { "code": code, "exit_code": exit_code, "cause": cause, "action": action, "path": self.path },
        });
        if let Some(cfg) = cfg {
            report["data_dir"] = json!(cfg.data_dir);
            report["db_path"] = json!(cfg.db_path());
            report["owner_token_file"] = json!(cfg.data_dir.join("owner-token"));
            report["listen"] = json!(cfg.listen.to_string());
            report["doctor_args"] = match self.kind {
                FailureKind::PortInUse | FailureKind::AlreadyRunning | FailureKind::Listen => {
                    json!(["doctor", "--data-dir", cfg.data_dir.to_string_lossy(), "--listen", cfg.listen.to_string()])
                }
                _ => json!(["doctor", "--offline", "--data-dir", cfg.data_dir.to_string_lossy()]),
            };
        }
        report
    }
}

impl std::fmt::Display for StartupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (code, exit_code, cause, action) = self.kind.details();
        write!(f, "{cause} [{code}, 종료 코드 {exit_code}]\n조치: {action}")?;
        if let Some(path) = &self.path {
            write!(f, "\n관련 경로: {}", path.display())?;
        }
        Ok(())
    }
}

pub(crate) fn ready_report(cfg: &Config, first_start: bool) -> Value {
    let mut local = cfg.listen;
    if local.ip().is_unspecified() {
        local.set_ip(if local.is_ipv4() { std::net::Ipv4Addr::LOCALHOST.into() } else { std::net::Ipv6Addr::LOCALHOST.into() });
    }
    json!({
        "status": "ready", "ready": true, "mode": if first_start { "first_start" } else { "restart" },
        "data_dir": cfg.data_dir, "db_path": cfg.db_path(),
        "owner_token_file": cfg.data_dir.join("owner-token"), "listen": cfg.listen.to_string(),
        "url": format!("http://{local}{}", cfg.web_base),
        "health_url": format!("http://{local}/api/v1/health"),
        "restart_args": ["serve", "--data-dir", cfg.data_dir.to_string_lossy(), "--listen", &cfg.listen.to_string()],
        "doctor_args": ["doctor", "--data-dir", cfg.data_dir.to_string_lossy(), "--listen", &cfg.listen.to_string()],
        "restart_action": "Ctrl-C 또는 서비스 관리 명령으로 정상 종료한 뒤 같은 환경 설정·데이터 경로로 다시 실행하세요",
    })
}

pub(crate) fn print_ready(cfg: &Config, first_start: bool, json_output: bool) {
    let report = ready_report(cfg, first_start);
    if json_output {
        println!("{report}");
    } else {
        println!("서버 준비 완료 ({})", if first_start { "첫 시작" } else { "재시작" });
        println!("데이터 위치: {}\nDB: {}", cfg.data_dir.display(), cfg.db_path().display());
        println!("접속 주소: {}\n준비 확인: {}", report["url"].as_str().unwrap_or(""), report["health_url"].as_str().unwrap_or(""));
        println!("첫 기기 등록: 서버 터미널에서 grove pairing set-password로 발급 비밀번호를 설정한 뒤 재시작하고 grove pairing create를 실행하세요");
        println!("재시작: Ctrl-C 또는 서비스 관리 명령으로 정상 종료한 뒤 같은 환경 설정·데이터 경로로 grove serve를 다시 실행하세요");
        println!("상세 진단: grove doctor --data-dir {:?} --listen {}", cfg.data_dir, cfg.listen);
    }
}
