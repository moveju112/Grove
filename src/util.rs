//! ID·시간·해시 공용 도우미. ID는 서버만 생성한다(ARCH-005).

use sha2::{Digest, Sha256};
use std::sync::Arc;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex(&h.finalize())
}

pub fn hex(bytes: &[u8]) -> String {
    const T: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(T[(b >> 4) as usize] as char);
        s.push(T[(b & 15) as usize] as char);
    }
    s
}

pub fn random_secret(bytes: usize) -> String {
    use base64::Engine;
    use rand::RngCore;
    let mut buf = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// 상수 시간 비교(토큰 hash 비교용).
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 시험에서 시간을 고정할 수 있게 하는 시계.
pub trait Clock: Send + Sync {
    fn now(&self) -> OffsetDateTime;
}

pub struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }
}

pub type SharedClock = Arc<dyn Clock>;

pub fn fmt_time(t: OffsetDateTime) -> String {
    t.format(&Rfc3339).unwrap_or_default()
}

pub fn parse_time(s: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(s, &Rfc3339).ok()
}

/// `std::fs::canonicalize` + Windows verbatim 접두어 제거.
/// Windows는 `\\?\C:\x` 형식을 돌려주는데, 이 형식은 cmd.exe 작업 위치·일부 도구·화면 표시에서 문제가 된다.
/// 경로 경계 검사도 이 함수만 쓰므로 비교하는 양쪽 형식이 같다.
pub fn canonical(p: impl AsRef<std::path::Path>) -> std::io::Result<std::path::PathBuf> {
    let c = std::fs::canonicalize(p)?;
    Ok(match c.to_str().and_then(simplify_verbatim) {
        Some(s) => std::path::PathBuf::from(s),
        None => c,
    })
}

/// verbatim 경로를 일반 경로로 바꿀 수 있으면 바꾼다(플랫폼 무관 문자열 처리).
/// 260자 초과·예약 장치 이름·끝 점/공백처럼 verbatim이 꼭 필요한 경우는 None(그대로 둔다).
pub fn simplify_verbatim(s: &str) -> Option<String> {
    let (plain, rest) = if let Some(r) = s.strip_prefix(r"\\?\UNC\") {
        (format!(r"\\{r}"), r)
    } else if let Some(r) = s.strip_prefix(r"\\?\") {
        let b = r.as_bytes();
        if b.len() < 2 || !b[0].is_ascii_alphabetic() || b[1] != b':' || (b.len() > 2 && b[2] != b'\\') {
            return None;
        }
        (r.to_string(), &r[2..])
    } else {
        return None;
    };
    if plain.len() >= 260 {
        return None;
    }
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7",
        "LPT8", "LPT9",
    ];
    for part in rest.split('\\').filter(|p| !p.is_empty()) {
        let stem = part.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
        if RESERVED.contains(&stem.as_str()) || part.ends_with('.') || part.ends_with(' ') || part == ".." || part.contains('/') {
            return None;
        }
    }
    Some(plain)
}

#[cfg(test)]
mod tests {
    use super::simplify_verbatim as s;

    #[test]
    fn verbatim_paths_are_simplified_only_when_safe() {
        assert_eq!(s(r"\\?\C:\work\proj").as_deref(), Some(r"C:\work\proj"));
        assert_eq!(s(r"\\?\Z:\").as_deref(), Some(r"Z:\"));
        assert_eq!(s(r"\\?\UNC\server\share\x").as_deref(), Some(r"\\server\share\x"));
        assert_eq!(s("/home/u/p"), None, "unix 경로는 그대로");
        assert_eq!(s(r"C:\plain"), None);
        assert_eq!(s(r"\\?\C:\a\con.txt"), None, "예약 이름");
        assert_eq!(s(r"\\?\C:\a\trailing."), None);
        assert_eq!(s(r"\\?\C:\a\space "), None);
        assert_eq!(s(r"\\?\Volume{1234}\x"), None, "volume GUID");
        let long = format!(r"\\?\C:\{}", "a".repeat(300));
        assert_eq!(s(&long), None, "MAX_PATH 초과");
    }
}

/// PATCH의 "필드 없음"(None)과 "null로 지우기"(Some(None))를 구분한다. serde 기본은 null도 None으로 풀어 지우기가 무시된다.
/// `#[serde(default, deserialize_with = "crate::util::double_option")]`와 함께 쓴다.
pub fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    <Option<T> as serde::Deserialize>::deserialize(d).map(Some)
}

#[cfg(test)]
mod double_option_tests {
    #[derive(serde::Deserialize)]
    struct P {
        #[serde(default, deserialize_with = "super::double_option")]
        v: Option<Option<String>>,
    }

    #[test]
    fn distinguishes_missing_null_and_value() {
        let p: P = serde_json::from_str("{}").unwrap();
        assert_eq!(p.v, None);
        let p: P = serde_json::from_str(r#"{"v":null}"#).unwrap();
        assert_eq!(p.v, Some(None));
        let p: P = serde_json::from_str(r#"{"v":"x"}"#).unwrap();
        assert_eq!(p.v, Some(Some("x".into())));
    }
}
