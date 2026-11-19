//! 발급 암호는 서버 OS 계정이 설정하고, 데몬은 검증값만 읽는다.
use super::{PASSWORD_ITERATIONS, random_secret};
use crate::error::{ApiError, ApiResult};
use axum::http::StatusCode;
use ring::pbkdf2;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const FILE: &str = "pairing-issuance-v1.json";
pub const MIN_LENGTH: usize = 10;
const FAILURE_DELAY: Duration = Duration::from_secs(2);

#[derive(Serialize, Deserialize)]
struct Verifier {
    salt: String,
    hash: [u8; 32],
}

pub fn set_password(data_dir: &Path, password: &str) -> io::Result<()> {
    if !valid_length(password) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("발급 비밀번호는 {MIN_LENGTH}자 이상, 256바이트 이하여야 합니다")));
    }
    let salt = random_secret(32);
    let mut hash = [0; 32];
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, PASSWORD_ITERATIONS, salt.as_bytes(), password.as_bytes(), &mut hash);
    std::fs::create_dir_all(data_dir)?;
    let file = tempfile::NamedTempFile::new_in(data_dir)?;
    serde_json::to_writer(file.as_file(), &Verifier { salt, hash })?;
    file.as_file().sync_all()?;
    file.persist(data_dir.join(FILE))?;
    Ok(())
}

fn valid_length(password: &str) -> bool {
    password.len() <= 256 && password.chars().count() >= MIN_LENGTH
}

pub(crate) struct Gate {
    verifier: Option<Arc<Verifier>>,
    next_attempt: Arc<Mutex<Option<Instant>>>,
}

impl Gate {
    pub(crate) fn load(data_dir: &Path) -> Self {
        let read = || -> io::Result<Verifier> {
            let mut bytes = Vec::new();
            File::open(data_dir.join(FILE))?.take(1025).read_to_end(&mut bytes)?;
            let verifier: Verifier = serde_json::from_slice(&bytes)?;
            if bytes.len() > 1024 || verifier.salt.len() != 43 {
                return Err(io::ErrorKind::InvalidData.into());
            }
            Ok(verifier)
        };
        let verifier = match read() {
            Ok(verifier) => Some(Arc::new(verifier)),
            Err(e) => {
                if e.kind() != io::ErrorKind::NotFound {
                    tracing::warn!("페어링 발급 비밀번호 설정을 읽을 수 없어 링크 발급을 차단합니다");
                }
                None
            }
        };
        Self { verifier, next_attempt: Arc::new(Mutex::new(None)) }
    }

    pub(crate) async fn verify(&self, candidate: String, link_password: String) -> ApiResult<String> {
        let verifier = self.verifier.clone().ok_or_else(|| ApiError::new(
            StatusCode::FORBIDDEN, "pairing_issuance_unconfigured",
            "서버에서 `grove pairing set-password`로 발급 비밀번호를 설정한 뒤 데몬을 재시작하세요.",
        ))?;
        if candidate.is_empty() {
            return Err(ApiError::invalid("서버 발급 비밀번호를 입력하세요"));
        }
        let limited = || ApiError::new(StatusCode::TOO_MANY_REQUESTS, "pairing_issuance_throttled", "잠시 후 발급 비밀번호를 다시 확인하세요.");
        let mut next = self.next_attempt.clone().try_lock_owned().map_err(|_| limited())?;
        if next.is_some_and(|deadline| Instant::now() < deadline) {
            return Err(limited());
        }
        // 연결이 끊겨도 검증과 실패 제한은 끝까지 처리한다.
        tokio::task::spawn_blocking(move || {
            if !valid_length(&candidate) || pbkdf2::verify(pbkdf2::PBKDF2_HMAC_SHA256, PASSWORD_ITERATIONS,
                verifier.salt.as_bytes(), candidate.as_bytes(), &verifier.hash).is_err()
            {
                *next = Some(Instant::now() + FAILURE_DELAY);
                return Err(ApiError::new(StatusCode::FORBIDDEN, "pairing_issuance_password", "서버 발급 비밀번호가 틀렸습니다."));
            }
            *next = None;
            if crate::util::ct_eq(candidate.as_bytes(), link_password.as_bytes()) {
                return Err(ApiError::invalid("링크 비밀번호는 서버 발급 비밀번호와 달라야 합니다"));
            }
            Ok(link_password)
        }).await.map_err(|_| ApiError::internal("pairing issuance password task"))?
    }
}
