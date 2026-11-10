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

pub fn default_data_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Grove"))
    }
    #[cfg(not(windows))]
    {
        if let Some(x) = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
            return Some(PathBuf::from(x).join("grove"));
        }
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share/grove"))
    }
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
        }
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
