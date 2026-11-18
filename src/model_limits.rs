//! 실제 추론 호출의 공급자·계정 자원. 비밀은 큐·로그·화면에 보관하지 않는다.
use crate::{App, error::{ApiError, ApiResult}, fair::{AcquireError, Permit}, provider::Profile};
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

#[derive(Clone)]
pub struct Resources {
    pub provider: String,
    pub account: String,
    pub provider_limit: usize,
    pub account_limit: usize,
}

pub fn limits(c: &Connection, profile: &Profile) -> ApiResult<(usize, Resources)> {
    let read = |key: &str| -> ApiResult<usize> {
        Ok(crate::settings::effective(c, key, None, None)?.as_u64().unwrap_or(crate::settings::DEFAULT_MODEL_CONCURRENCY).max(1) as usize)
    };
    let provider = if crate::provider::cli::is_cli(&profile.protocol) {
        format!("cli:{}", profile.protocol)
    } else {
        let base_url = if profile.protocol == crate::provider::codex_oauth::PROTOCOL {
            crate::provider::codex_oauth::BASE
        } else {
            &profile.base_url
        };
        reqwest::Url::parse(base_url).map_err(|_| ApiError::invalid("모델 endpoint가 올바르지 않습니다"))?.origin().ascii_serialization()
    };
    // 임의의 추가 헤더를 바꿔 같은 API key의 한도를 우회하지 않는다.
    // API key가 없는 헤더 인증/익명 endpoint는 계정을 추측하지 않고 origin 하나로 보수적으로 묶는다.
    let identity = if crate::provider::cli::is_cli(&profile.protocol) {
        serde_json::to_vec(&provider)?
    } else { serde_json::to_vec(&(&provider, &profile.api_key))? };
    let account = format!("{:x}", Sha256::digest(identity));
    Ok((read("runs.max_active")?, Resources {
        provider, account, provider_limit: read("runs.provider_max_active")?, account_limit: read("runs.account_max_active")?,
    }))
}

/// 요약·제목도 주 대화와 같은 자원을 원자적으로 얻는다. 보조 호출을 새 소유자로 쪼개 공정성을 우회하지 않는다.
pub async fn auxiliary(
    app: &App, session: &str, profile: &Profile, cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> ApiResult<Permit> {
    let (session, profile) = (session.to_string(), profile.clone());
    let (owner, max, resources) = app.db.call(move |c| {
        let owner: Option<String> = c.query_row(
            "SELECT owner_key FROM turns WHERE session_id=?1 ORDER BY created_at DESC LIMIT 1", [session], |row| row.get(0),
        ).optional()?;
        let (max, resources) = limits(c, &profile)?;
        Ok((owner.unwrap_or_else(|| "system:auxiliary".into()), max, resources))
    }).await?;
    app.fair.acquire_scoped(&owner, &format!("aux:{}", crate::util::new_id()), max, Some(resources), cancel).await
        .map_err(|AcquireError::Cancelled| ApiError::conflict("cancelled", "모델 호출 대기가 취소됐습니다"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_oauth_limits_use_the_fixed_endpoint_for_blank_profiles() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::store::Db::open(&dir.path().join("grove.db")).unwrap();
        db.call_sync(|c| {
            let mut profile = Profile {
                protocol: crate::provider::codex_oauth::PROTOCOL.into(),
                base_url: String::new(),
                model: "default".into(),
                api_key: None,
                timeout: std::time::Duration::from_secs(5),
                extra_headers: vec![],
                sensitive_headers: vec![],
            };
            let (_, default) = limits(c, &profile)?;
            assert_eq!(default.provider, "https://chatgpt.com");
            profile.model = "another-model".into();
            assert_eq!(limits(c, &profile)?.1.account, default.account);
            profile.protocol = "openai".into();
            assert_eq!(limits(c, &profile).err().unwrap().code, "invalid_request");
            Ok(())
        }).unwrap();
    }
}
