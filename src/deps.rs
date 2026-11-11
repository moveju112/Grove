//! 외부 도구 의존성(ARCH-018).
//! - 서버 시작·상태 확인 때 미리 검사하지 않는다. 기능을 실제로 실행하다 실패했을 때만 그 프로그램을 찾아본다.
//! - 없으면 무엇에 필요한지와 OS별 설치 방법을 알리고, 자동으로 설치하지 않는다(설치는 사용자가 명시적으로 한다).
//! - 오류 코드는 `dependency_missing`, details에 `program`·`purpose`·`install`을 담는다.

use crate::error::ApiError;
use axum::http::StatusCode;
use serde_json::{Value, json};
use std::path::PathBuf;

struct Dep {
    program: &'static str,
    purpose: &'static str,
    linux: &'static str,
    windows: &'static str,
}

const DEPS: &[Dep] = &[
    Dep { program: "git", purpose: "Git 변경·커밋·worktree", linux: "배포판 패키지로 설치하세요(예: sudo apt install git)", windows: "https://git-scm.com/download/win 에서 설치하거나 winget install Git.Git" },
    Dep { program: "bash", purpose: "셸 명령·백그라운드 작업·터미널", linux: "배포판 패키지로 설치하세요(예: sudo apt install bash) 또는 설정에서 셸을 sh로 바꾸세요", windows: "Git for Windows(Git Bash)를 설치하거나 설정에서 셸을 pwsh·cmd로 바꾸세요" },
    Dep { program: "sh", purpose: "셸 명령·백그라운드 작업·터미널", linux: "배포판의 기본 셸(dash 등)을 설치하세요", windows: "Git for Windows를 설치하거나 설정에서 셸을 pwsh·cmd로 바꾸세요" },
    Dep { program: "zsh", purpose: "셸 명령·백그라운드 작업·터미널", linux: "배포판 패키지로 설치하세요(예: sudo apt install zsh) 또는 설정에서 셸을 바꾸세요", windows: "설정에서 셸을 pwsh·cmd로 바꾸세요" },
    Dep { program: "pwsh", purpose: "셸 명령·백그라운드 작업·터미널", linux: "PowerShell 설치 안내(https://aka.ms/install-powershell)를 따르거나 설정에서 셸을 바꾸세요", windows: "winget install Microsoft.PowerShell 또는 설정에서 셸을 powershell·cmd로 바꾸세요" },
    Dep { program: "powershell", purpose: "셸 명령·백그라운드 작업·터미널", linux: "Linux에는 없습니다. 설정에서 셸을 bash·sh·pwsh로 바꾸세요", windows: "Windows 기본 구성 요소입니다. 시스템 PATH를 확인하세요" },
    Dep { program: "cmd", purpose: "셸 명령·백그라운드 작업·터미널", linux: "Linux에는 없습니다. 설정에서 셸을 bash·sh로 바꾸세요", windows: "Windows 기본 구성 요소입니다. 시스템 PATH를 확인하세요" },
    Dep { program: "claude", purpose: "Claude Code CLI 모델 프로필", linux: "Claude Code를 설치하고 로그인하세요(npm install -g @anthropic-ai/claude-code)", windows: "Claude Code를 설치하고 로그인하세요(npm install -g @anthropic-ai/claude-code)" },
    Dep { program: "codex", purpose: "Codex CLI 모델 프로필", linux: "Codex CLI를 설치하고 로그인하세요(npm install -g @openai/codex)", windows: "Codex CLI를 설치하고 로그인하세요(npm install -g @openai/codex)" },
];

fn file_name(program: &str) -> &str {
    std::path::Path::new(program).file_stem().and_then(|s| s.to_str()).unwrap_or(program)
}

/// 이 서버 OS의 설치 안내. 모르는 프로그램이면 일반 안내.
pub fn install_hint(program: &str) -> String {
    let name = file_name(program);
    match DEPS.iter().find(|d| d.program == name) {
        Some(d) if cfg!(windows) => d.windows.to_string(),
        Some(d) => d.linux.to_string(),
        None => format!("{name}을(를) 설치하고 서버 프로세스의 PATH에서 찾을 수 있게 하세요"),
    }
}

fn purpose(program: &str) -> &'static str {
    let name = file_name(program);
    DEPS.iter().find(|d| d.program == name).map(|d| d.purpose).unwrap_or("이 기능")
}

/// 사용자에게 보일 한 줄 안내: 무엇이 없고, 무엇에 필요하고, 어떻게 설치하는지.
pub fn message(program: &str) -> String {
    format!("{program} 실행 파일을 찾을 수 없습니다. {}에 필요합니다. 설치: {}", purpose(program), install_hint(program))
}

pub fn details(program: &str) -> Value {
    json!({ "program": program, "purpose": purpose(program), "install": install_hint(program), "auto_install": false })
}

pub fn missing(program: &str) -> ApiError {
    ApiError::new(StatusCode::FAILED_DEPENDENCY, "dependency_missing", message(program)).with_details(details(program))
}

/// 실행 실패가 "프로그램 없음" 때문인지. spawn 오류 종류가 NotFound이거나, 종류를 알 수 없으면 PATH에서 찾아본다.
/// 실패했을 때만 호출한다(사전 검사 없음).
pub fn is_missing(program: &str, err: Option<&std::io::Error>) -> bool {
    match err {
        Some(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Some(_) => false,
        None => find_in_path(program).is_none(),
    }
}

/// PATH에서 실행 파일을 찾는다(Windows는 PATHEXT 확장자 포함). 경로가 주어지면 그 파일만 본다.
pub fn find_in_path(program: &str) -> Option<PathBuf> {
    let p = std::path::Path::new(program);
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".into()).split(';').filter(|e| !e.is_empty()).map(|e| e.to_ascii_lowercase()).collect()
    } else {
        vec![]
    };
    let candidates = |base: PathBuf| -> Vec<PathBuf> {
        let mut v = vec![base.clone()];
        for e in &exts {
            v.push(base.with_extension(e.trim_start_matches('.')));
        }
        v
    };
    let ok = |c: &PathBuf| c.is_file();
    if p.components().count() > 1 || p.is_absolute() {
        return candidates(p.to_path_buf()).into_iter().find(ok);
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).flat_map(|d| candidates(d.join(program))).find(ok)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_program_explains_purpose_and_install_without_auto_install() {
        let e = missing("git");
        assert_eq!(e.code, "dependency_missing");
        assert_eq!(e.status, StatusCode::FAILED_DEPENDENCY);
        let d = details("git");
        assert_eq!(d["auto_install"], false);
        assert!(d["purpose"].as_str().unwrap().contains("Git"));
        assert!(!d["install"].as_str().unwrap().is_empty());
        // 경로가 붙은 이름·확장자도 같은 안내
        assert_eq!(details("/usr/bin/git")["purpose"], d["purpose"]);
        assert!(message("grove-no-such-tool").contains("PATH"));
    }

    #[test]
    fn path_lookup_only_reports_absent_programs() {
        assert!(find_in_path("grove-definitely-missing-tool").is_none());
        assert!(is_missing("grove-definitely-missing-tool", None));
        let nf = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert!(is_missing("x", Some(&nf)));
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert!(!is_missing("x", Some(&denied)), "권한 문제는 설치 안내 대상이 아니다");
        #[cfg(unix)]
        assert!(find_in_path("sh").is_some());
    }
}
