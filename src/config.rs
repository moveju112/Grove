//! 실행 설정과 OS별 경로(ARCH-009).

use std::net::SocketAddr;
use std::path::PathBuf;

pub const DEFAULT_LISTEN: &str = "127.0.0.1:7740";

#[derive(Debug, Clone)]
pub struct Config {
    pub data_dir: PathBuf,
    pub listen: SocketAddr,
    /// 동일 origin 외에 허용할 origin(예: 개발용 Vite 서버).
    pub allowed_origins: Vec<String>,
    /// Host 헤더 허용 목록. 비어 있고 loopback 바인딩이면 loopback 이름만 허용한다.
    pub allowed_hosts: Vec<String>,
    /// 앞단 TLS 종료(reverse proxy) 여부. true면 쿠키에 Secure를 붙인다.
    pub tls_terminated: bool,
    /// 정적 웹앱 경로(없으면 웹 제공 안 함).
    pub web_dir: Option<PathBuf>,
    /// 실험용 모델 도구 루프 허용(서버 opt-in).
    pub enable_tool_loop: bool,
    /// 승인 요청 만료(초).
    pub approval_ttl_secs: i64,
    /// 예약 실행 점검 주기(ms). 기본 15초.
    pub scheduler_tick_ms: u64,
    /// 원격 감시에서 loopback IP의 평문 HTTP를 허용한다(시험 전용, 기본 false). 그 밖의 대상은 항상 HTTPS만 쓴다.
    pub remote_watch_insecure_loopback: bool,
}

impl Config {
    pub fn from_env(data_dir: Option<PathBuf>, listen: Option<SocketAddr>) -> Result<Self, String> {
        let data_dir = match data_dir.or_else(|| std::env::var_os("GROVE_DATA_DIR").map(PathBuf::from)) {
            Some(d) => d,
            None => default_data_dir().ok_or("데이터 디렉터리를 결정할 수 없습니다. GROVE_DATA_DIR를 지정하세요")?,
        };
        let listen = match listen {
            Some(l) => l,
            None => std::env::var("GROVE_LISTEN")
                .unwrap_or_else(|_| DEFAULT_LISTEN.into())
                .parse()
                .map_err(|e| format!("GROVE_LISTEN 형식 오류: {e}"))?,
        };
        let list = |k: &str| -> Vec<String> {
            std::env::var(k).unwrap_or_default().split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect()
        };
        let web_dir = std::env::var_os("GROVE_WEB_DIR").map(PathBuf::from).or_else(default_web_dir);
        Ok(Self {
            data_dir,
            listen,
            allowed_origins: list("GROVE_ALLOWED_ORIGINS"),
            allowed_hosts: list("GROVE_ALLOWED_HOSTS"),
            tls_terminated: std::env::var("GROVE_TLS_TERMINATED").is_ok_and(|v| v == "1"),
            web_dir,
            enable_tool_loop: std::env::var("GROVE_ENABLE_TOOL_LOOP").is_ok_and(|v| v == "1"),
            approval_ttl_secs: std::env::var("GROVE_APPROVAL_TTL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(30 * 60),
            scheduler_tick_ms: std::env::var("GROVE_SCHEDULER_TICK_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(15_000).clamp(100, 600_000),
            remote_watch_insecure_loopback: std::env::var("GROVE_REMOTE_WATCH_INSECURE_LOOPBACK").is_ok_and(|v| v == "1"),
        })
    }

    pub fn host_allowed(&self, host: &str) -> bool {
        if self.allowed_hosts.iter().any(|h| h == host || h == "*") {
            return true;
        }
        if !self.listen.ip().is_loopback() {
            // 외부 바인딩: 목록이 없으면 Host를 제한하지 않는다(토큰 인증이 경계).
            return self.allowed_hosts.is_empty();
        }
        let name = host_name(host);
        matches!(name, "localhost" | "127.0.0.1" | "[::1]" | "::1")
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("grove.db")
    }
}

fn host_name(host: &str) -> &str {
    if host.starts_with('[') {
        return host.split_once(']').map(|(a, _)| &host[..a.len() + 1]).unwrap_or(host);
    }
    host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host)
}

/// 사용자별 데이터 경로(ARCH-009). 설정은 DB 안에 두므로 별도 설정 파일 경로가 없고,
/// 다시 만들 수 있는 캐시를 두지 않으므로 캐시 경로도 쓰지 않는다(모든 파일이 사용자 데이터라 백업 대상).
pub fn default_data_dir() -> Option<PathBuf> {
    data_dir_for(cfg!(windows), |k| std::env::var_os(k))
}

/// OS 규칙: Windows `%LOCALAPPDATA%\Grove`, 그 밖은 `$XDG_DATA_HOME/grove`(비었거나 상대 경로면 무시) 또는 `~/.local/share/grove`.
fn data_dir_for(windows: bool, env: impl Fn(&str) -> Option<std::ffi::OsString>) -> Option<PathBuf> {
    let abs = |k: &str| env(k).map(PathBuf::from).filter(|p| p.is_absolute());
    if windows {
        return abs("LOCALAPPDATA").map(|p| p.join("Grove"));
    }
    // XDG Base Directory 명세: 상대 경로 값은 무효로 보고 무시한다.
    if let Some(x) = abs("XDG_DATA_HOME") {
        return Some(x.join("grove"));
    }
    abs("HOME").map(|h| h.join(".local/share/grove"))
}

/// 실행 파일 옆 `web/` 또는 `../share/grove/web`.
fn default_web_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    [dir.join("web"), dir.join("../share/grove/web")].into_iter().find(|p| p.join("index.html").is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cfg(listen: &str, hosts: &[&str]) -> Config {
        Config {
            data_dir: PathBuf::from("/tmp/x"),
            listen: listen.parse().unwrap(),
            allowed_origins: vec![],
            allowed_hosts: hosts.iter().map(|s| s.to_string()).collect(),
            tls_terminated: false,
            web_dir: None,
            enable_tool_loop: false,
            approval_ttl_secs: 60,
            scheduler_tick_ms: 15_000,
            remote_watch_insecure_loopback: false,
        }
    }
    /// OS별 데이터 경로 규칙(ARCH-009). 절대 경로 판정은 실행 OS 기준이라 Unix 형식 값으로 확인한다.
    #[test]
    fn data_dir_follows_os_rules() {
        let env = |pairs: &'static [(&'static str, &'static str)]| move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| std::ffi::OsString::from(v));
        let all: &[(&str, &str)] = &[("XDG_DATA_HOME", "/xdg"), ("HOME", "/home/u"), ("LOCALAPPDATA", "/local")];
        assert_eq!(data_dir_for(false, env(all)), Some(PathBuf::from("/xdg/grove")));
        assert_eq!(data_dir_for(true, env(all)), Some(PathBuf::from("/local/Grove")), "Windows는 XDG를 보지 않는다");
        // 비었거나 상대 경로인 XDG 값은 무시하고 HOME 기본값을 쓴다.
        assert_eq!(data_dir_for(false, env(&[("XDG_DATA_HOME", ""), ("HOME", "/home/u")])), Some(PathBuf::from("/home/u/.local/share/grove")));
        assert_eq!(data_dir_for(false, env(&[("XDG_DATA_HOME", "rel"), ("HOME", "/home/u")])), Some(PathBuf::from("/home/u/.local/share/grove")));
        // 정할 수 없으면 추측하지 않는다(현재 폴더 등에 만들지 않음).
        assert_eq!(data_dir_for(false, env(&[("HOME", "")])), None);
        assert_eq!(data_dir_for(true, env(&[("HOME", "/home/u")])), None);
    }

    #[test]
    fn loopback_hosts_only() {
        let c = cfg("127.0.0.1:7740", &[]);
        assert!(c.host_allowed("127.0.0.1:7740"));
        assert!(c.host_allowed("localhost:7740"));
        assert!(c.host_allowed("[::1]:7740"));
        assert!(!c.host_allowed("evil.example:7740"));
        assert!(!c.host_allowed("localhost.evil.example"));
    }
    #[test]
    fn explicit_hosts() {
        let c = cfg("0.0.0.0:7740", &["grove.lan:7740"]);
        assert!(c.host_allowed("grove.lan:7740"));
        assert!(!c.host_allowed("other:7740"));
        let open = cfg("0.0.0.0:7740", &[]);
        assert!(open.host_allowed("anything:1"));
    }
}
