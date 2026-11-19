//! 대화 응답 밖에서 부르는 보조 모델(제목 생성·Maintainer·압축)의 호출 기록.
//!
//! 대화 응답과 적용된 압축 요약은 메시지에 사용량이 남는다. 보조 호출은 결과를 버리거나 실패해도
//! 모델 사용량이 생기므로 여기에 남겨 사용량 집계에 포함한다. 적용된 압축은 요약 note가 이미 집계되므로
//! 중복을 피하려고 기록하지 않는다. 응답을 받지 못한 실패는 사용량 없이 원인만 남기고 집계하지 않는다.
use crate::App;
use crate::error::ApiResult;
use crate::provider::{Profile, Usage};
use rusqlite::{Connection, params};
use serde_json::json;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Title,
    Maintainer,
    Compaction,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Title => "title",
            Kind::Maintainer => "maintainer",
            Kind::Compaction => "compaction",
        }
    }

    /// 사용량 화면의 역할 이름. 압축은 기존 압축 요약 note와 같은 이름을 쓴다.
    pub fn label(kind: &str) -> &'static str {
        match kind {
            "title" => "(제목 생성)",
            "maintainer" => "(메모리 정리)",
            _ => "(압축 요약)",
        }
    }
}

/// 한 번의 보조 모델 호출 결과. `usage`가 없으면 응답을 받지 못한 실패다.
pub struct Record<'a> {
    pub kind: Kind,
    pub session_id: &'a str,
    pub profile_id: &'a str,
    pub runtime: &'a Profile,
    pub effort: Option<&'a str>,
    pub usage: Option<&'a Usage>,
    pub provider_ms: i64,
    /// 응답을 반영했으면 None, 버렸거나 실패했으면 원인 코드.
    pub discarded: Option<&'a str>,
}

pub fn insert(c: &Connection, now: &str, r: &Record) -> ApiResult<()> {
    let status = match (r.usage, r.discarded) {
        (None, _) => "failed",
        (Some(_), Some(_)) => "discarded",
        (Some(_), None) => "applied",
    };
    c.execute(
        "INSERT INTO aux_model_calls(id,session_id,kind,profile_id,protocol,model,effort,status,error_code,usage,provider_ms,created_at) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            crate::util::new_id(), r.session_id, r.kind.as_str(), r.profile_id, r.runtime.protocol, r.runtime.model, r.effort,
            status, r.discarded, r.usage.map(|u| json!(u).to_string()), r.provider_ms, now,
        ],
    )?;
    Ok(())
}

/// 기록 실패가 보조 기능의 결과를 바꾸지 않게 한다. 대화가 삭제되는 등으로 저장하지 못하면 경고만 남긴다.
pub async fn record(app: &App, r: Record<'_>) {
    let (now, kind, sid, profile, runtime, effort, usage, ms, discarded) = (
        app.now(), r.kind, r.session_id.to_string(), r.profile_id.to_string(), r.runtime.clone(),
        r.effort.map(str::to_string), r.usage.cloned(), r.provider_ms, r.discarded.map(str::to_string),
    );
    let saved = app.db.call(move |c| insert(c, &now, &Record {
        kind, session_id: &sid, profile_id: &profile, runtime: &runtime, effort: effort.as_deref(),
        usage: usage.as_ref(), provider_ms: ms, discarded: discarded.as_deref(),
    })).await;
    if let Err(e) = saved {
        tracing::warn!(code = e.code, kind = kind.as_str(), "보조 모델 호출 기록 실패");
    }
}
