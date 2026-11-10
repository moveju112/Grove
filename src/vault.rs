//! 저장 비밀정보 암호화(SEC-018, SEC-019).
//!
//! - API 키는 DB에 `v1:<base64(nonce‖ciphertext)>`로 저장한다(ChaCha20-Poly1305, 값마다 새 nonce).
//! - 키는 데이터 디렉터리의 `secret.key`(32바이트, 권한 0600)다. DB 파일·snapshot만 유출되거나 백업돼도 평문은 없다.
//!   snapshot을 다른 곳에 복원해 키를 계속 쓰려면 `secret.key`를 따로 옮겨야 한다(없으면 키를 다시 입력).
//! - SQLite 함수 `grove_encrypt(x)`, `grove_decrypt(x)`(실패 시 오류), `grove_try_decrypt(x)`(실패 시 NULL)를
//!   연결마다 그 DB의 데이터 디렉터리 키로 등록한다. 키 파일은 처음 암호화할 때만 만든다.
//! - 이전 버전의 평문 값(`v1:` 접두어 없음)은 서버 시작 시 `migrate_plaintext`로 암호화한다.

use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rusqlite::Connection;
use rusqlite::functions::FunctionFlags;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const PREFIX: &str = "v1:";

pub struct Vault {
    path: PathBuf,
    key: Mutex<Option<[u8; 32]>>,
}

impl Vault {
    pub fn new(data_dir: &Path) -> Self {
        Self { path: data_dir.join("secret.key"), key: Mutex::new(None) }
    }

    fn load(&self, create: bool) -> Result<[u8; 32], String> {
        let mut g = self.key.lock().map_err(|_| "vault lock".to_string())?;
        if let Some(k) = *g {
            return Ok(k);
        }
        let k = match std::fs::read(&self.path) {
            Ok(b) => b.try_into().map_err(|_| format!("{}: 키 파일 형식 오류(32바이트여야 함)", self.path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && create => {
                let mut k = [0u8; 32];
                rand::RngCore::fill_bytes(&mut rand::rng(), &mut k);
                // 새로 만들 때만 쓴다(create_new: 다른 연결과 경쟁해도 기존 키를 덮어쓰지 않음).
                match std::fs::OpenOptions::new().write(true).create_new(true).open(&self.path) {
                    Ok(mut f) => {
                        use std::io::Write;
                        f.write_all(&k).map_err(|e| e.to_string())?;
                        f.sync_all().map_err(|e| e.to_string())?;
                        crate::store::restrict_permissions(&self.path);
                        k
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                        std::fs::read(&self.path).map_err(|e| e.to_string())?.try_into().map_err(|_| "키 파일 형식 오류".to_string())?
                    }
                    Err(e) => return Err(format!("{}: {e}", self.path.display())),
                }
            }
            Err(e) => return Err(format!("{}: 비밀정보 키를 읽을 수 없습니다({e}). 키를 다시 입력하거나 백업한 secret.key를 복원하세요", self.path.display())),
        };
        *g = Some(k);
        Ok(k)
    }

    pub fn encrypt(&self, plain: &str) -> Result<String, String> {
        let k = self.load(true)?;
        let c = ChaCha20Poly1305::new(Key::from_slice(&k));
        let mut n = [0u8; 12];
        rand::RngCore::fill_bytes(&mut rand::rng(), &mut n);
        let ct = c.encrypt(Nonce::from_slice(&n), plain.as_bytes()).map_err(|_| "암호화 실패".to_string())?;
        let mut out = n.to_vec();
        out.extend(ct);
        Ok(format!("{PREFIX}{}", B64.encode(out)))
    }

    pub fn decrypt(&self, stored: &str) -> Result<String, String> {
        let Some(b) = stored.strip_prefix(PREFIX) else {
            // 이전 버전 평문(시작 시 migrate_plaintext가 곧 암호화한다)
            return Ok(stored.to_string());
        };
        let k = self.load(false)?;
        let raw = B64.decode(b).map_err(|_| "저장된 비밀정보 형식 오류".to_string())?;
        if raw.len() < 12 {
            return Err("저장된 비밀정보 형식 오류".into());
        }
        let c = ChaCha20Poly1305::new(Key::from_slice(&k));
        let p = c.decrypt(Nonce::from_slice(&raw[..12]), &raw[12..]).map_err(|_| "비밀정보를 해독할 수 없습니다(키 파일이 바뀌었거나 값이 손상됨)".to_string())?;
        String::from_utf8(p).map_err(|_| "비밀정보 형식 오류".to_string())
    }
}

/// 연결에 암호화 함수를 등록한다.
pub fn register(conn: &Connection, data_dir: &Path) -> rusqlite::Result<()> {
    let v = Arc::new(Vault::new(data_dir));
    let flags = FunctionFlags::SQLITE_UTF8;
    let e = v.clone();
    conn.create_scalar_function("grove_encrypt", 1, flags, move |ctx| {
        let s: String = ctx.get(0)?;
        e.encrypt(&s).map_err(|m| rusqlite::Error::UserFunctionError(m.into()))
    })?;
    let d = v.clone();
    conn.create_scalar_function("grove_decrypt", 1, flags, move |ctx| {
        let s: String = ctx.get(0)?;
        d.decrypt(&s).map_err(|m| rusqlite::Error::UserFunctionError(m.into()))
    })?;
    let t = v;
    conn.create_scalar_function("grove_try_decrypt", 1, flags, move |ctx| {
        let s: String = ctx.get(0)?;
        Ok(t.decrypt(&s).ok())
    })?;
    Ok(())
}

/// 평문으로 남은 값을 암호화한다. 반환: 바꾼 개수.
pub fn migrate_plaintext(c: &Connection) -> rusqlite::Result<usize> {
    c.execute("UPDATE secrets SET value = grove_encrypt(value) WHERE value NOT LIKE 'v1:%'", [])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_failures_are_explicit() {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::new(d.path());
        // 키가 없을 때 복호화는 키를 만들지 않고 실패한다
        assert!(v.decrypt("v1:AAAAAAAAAAAAAAAAAAAAAAAAAA==").is_err());
        assert!(!d.path().join("secret.key").exists());
        let c1 = v.encrypt("sk-test-123").unwrap();
        let c2 = v.encrypt("sk-test-123").unwrap();
        assert!(c1.starts_with("v1:") && c1 != c2, "매번 새 nonce");
        assert!(!c1.contains("sk-test"));
        assert_eq!(v.decrypt(&c1).unwrap(), "sk-test-123");
        // 이전 평문은 그대로 읽힌다
        assert_eq!(v.decrypt("plain-old").unwrap(), "plain-old");
        // 다른 키(다른 데이터 디렉터리)로는 해독 불가
        let d2 = tempfile::tempdir().unwrap();
        let v2 = Vault::new(d2.path());
        v2.encrypt("x").unwrap();
        assert!(v2.decrypt(&c1).is_err());
        // 변조 거부
        let mut bad = c1.clone();
        bad.replace_range(10..11, if &c1[10..11] == "A" { "B" } else { "A" });
        assert!(v.decrypt(&bad).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.path().join("secret.key")).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }
}
