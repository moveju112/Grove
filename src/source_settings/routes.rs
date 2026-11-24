//! 등록 기기가 조회하며 경로는 서버 환경과 등록된 프로젝트에서 결정한다.

use super::{
    ReadErrorCode, SourceId, SourceResource, SourceSettings, SourceState,
    read_codex_user_agents, read_resources, read_source, user_root,
};
use crate::App;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use axum::Json;
use axum::extract::{Query, State, rejection::QueryRejection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceQuery {
    project_id: Option<String>,
}

#[derive(Serialize)]
pub struct SourceList {
    items: Vec<SourceSettings>,
    resources: Vec<SourceResource>,
}

/// 클라이언트는 프로젝트 식별자만 지정한다. source 목록·파일명·root는 고정한다.
pub async fn list(
    State(app): State<App>,
    _p: Principal,
    query: Result<Query<SourceQuery>, QueryRejection>,
) -> ApiResult<Json<SourceList>> {
    let Query(query) = query.map_err(|_| ApiError::invalid("원본 설정 조회 인자가 올바르지 않습니다"))?;
    let project_root = if let Some(id) = query.project_id {
        if id.is_empty() {
            return Err(ApiError::invalid("프로젝트 식별자가 필요합니다"));
        }
        // Grove는 단일 사용자 모델이다. 등록 기기는 모든 프로젝트를 관리할 수 있다.
        Some(app.db.call(move |c| crate::projects::active_root(c, &id)).await?)
    } else {
        None
    };
    let user_sources = project_root.is_none();
    let result = tokio::task::spawn_blocking(move || {
        let mut resources = Vec::new();
        let items = if let Some(root) = project_root {
            [
                SourceId::ClaudeProject,
                SourceId::ClaudeProjectLocal,
                SourceId::CodexProject,
            ]
            .into_iter()
            .map(|source| {
                resources.extend(read_resources(Some(&root), source));
                read_source(&root, source)
            })
            .collect()
        } else {
            [SourceId::ClaudeUser, SourceId::CodexUser]
                .into_iter()
                .map(|source| {
                    let root = user_root(source, |key| std::env::var_os(key));
                    resources.extend(read_resources(root.as_deref(), source));
                    match root {
                        Some(root) => read_source(&root, source),
                        None => SourceSettings {
                            source,
                            state: SourceState::ReadError { code: ReadErrorCode::Io },
                        },
                    }
                })
                .collect()
        };
        if user_sources {
            // 사용자 스킬의 현재 Codex 위치도 서버 HOME에서만 결정한다.
            let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(PathBuf::from).filter(|path| path.is_absolute());
            resources.push(read_codex_user_agents(home.as_deref()));
        }
        SourceList { items, resources }
    })
    .await
    .map_err(|_| ApiError::internal("원본 설정 조회 작업을 완료하지 못했습니다"))?;
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn user_roots(env: impl Fn(&str) -> Option<OsString>) -> [Option<PathBuf>; 2] {
        [SourceId::ClaudeUser, SourceId::CodexUser].map(|source| user_root(source, &env))
    }

    #[test]
    fn roots_use_server_environment_without_guessing_relative_or_missing_paths() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let claude = dir.path().join("claude");
        let codex = dir.path().join("codex");
        let home_key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let defaults = user_roots(|key| (key == home_key).then(|| home.clone().into_os_string()));
        assert_eq!(defaults, [Some(home.join(".claude")), Some(home.join(".codex"))]);
        let overrides = user_roots(|key| match key {
            "CLAUDE_CONFIG_DIR" => Some(claude.clone().into_os_string()),
            "CODEX_HOME" => Some(codex.clone().into_os_string()),
            _ => None,
        });
        assert_eq!(overrides, [Some(claude), Some(codex)]);
        for value in ["", "relative"] {
            let invalid = user_roots(|_| Some(OsString::from(value)));
            assert_eq!(invalid, [None, None]);
        }
        assert_eq!(user_roots(|_| None), [None, None]);
    }
}
