//! 확인한 계층과 revision을 고정하고 선택한 범위의 override만 원자적으로 지운다.
use crate::{App, auth::Principal, error::{ApiError, ApiResult}, idem};
use axum::{Json, extract::{Query, State}, http::{HeaderMap, StatusCode}, response::Response};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub scope: String,
    pub scope_id: String,
    pub keys: Vec<String>,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
}

impl Target {
    fn normalize_keys(&mut self) -> ApiResult<()> {
        if self.keys.is_empty() || self.keys.len() > 64 {
            return Err(ApiError::invalid("복원할 설정은 1~64개여야 합니다"));
        }
        self.keys.sort();
        self.keys.dedup();
        Ok(())
    }

    fn context(&mut self,c: &Connection) -> ApiResult<()> {
        match self.scope.as_str() {
            "server" if self.scope_id == "-" => {},
            "project" => {
                if self.project_id.as_ref().is_some_and(|id|id != &self.scope_id) {
                    return Err(ApiError::invalid("복원 범위와 프로젝트가 다릅니다"));
                }
                self.project_id = Some(self.scope_id.clone());
            },
            "session" => {
                if self.session_id.as_ref().is_some_and(|id|id != &self.scope_id) {
                    return Err(ApiError::invalid("복원 범위와 대화가 다릅니다"));
                }
                self.session_id = Some(self.scope_id.clone());
            },
            _ => return Err(ApiError::invalid("복원 범위는 server/- 또는 정확한 프로젝트·대화 ID여야 합니다")),
        }
        if let Some(session) = &self.session_id {
            let project = crate::sessions::get(c,session)?.project_id;
            if self.project_id.as_ref().is_some_and(|id|id != &project) {
                return Err(ApiError::invalid("대화와 프로젝트의 복원 대상이 다릅니다"));
            }
            self.project_id = Some(project);
        }
        if let Some(project) = &self.project_id { crate::projects::get(c,project)?; }
        Ok(())
    }
}

fn plan(c: &Connection,mut target: Target,owner: &str) -> ApiResult<Value> {
    target.normalize_keys()?;
    target.context(c)?;
    let mut items = Vec::with_capacity(target.keys.len());
    for key in &target.keys {
        let d = super::def(key).ok_or_else(||ApiError::not_found("알 수 없는 설정입니다"))?;
        if !d.scopes.contains(&target.scope.as_str()) {
            return Err(ApiError::invalid(format!("{}은(는) 이 범위에서 바꿀 수 없습니다",d.label)));
        }
        let before = super::resolve_key(c,&d,target.project_id.as_deref(),target.session_id.as_deref())?;
        let changed = !before["layers"][&target.scope]["value"].is_null();
        let mut layers = before["layers"].as_object().unwrap().clone();
        let layer = layers.get_mut(&target.scope).unwrap();
        layer["value"] = Value::Null;
        if changed { layer["revision"] = json!(layer["revision"].as_i64().unwrap()+1); }
        let after = super::resolve_layers(&d,layers);
        items.push(json!({"key":key,"label":d.label,"before":before,"after":after,"changed":changed,"applies":d.applies}));
    }
    let mut result = json!({"target":target,"owner":owner,"items":items});
    result["fingerprint"] = json!(idem::body_hash("settings.reset.preview",&result));
    Ok(result)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewQuery {
    scope: String,
    scope_id: String,
    keys: String,
    project_id: Option<String>,
    session_id: Option<String>,
}

pub async fn preview(State(app): State<App>,p: Principal,Query(query): Query<PreviewQuery>) -> ApiResult<Json<Value>> {
    let target = Target {
        scope:query.scope,scope_id:query.scope_id,keys:query.keys.split(',').map(str::to_string).collect(),
        project_id:query.project_id,session_id:query.session_id,
    };
    let owner = p.root_id.clone();
    let result = app.db.call(move |c|plan(c,target,&owner)).await?;
    crate::auth::revalidate(&app,&p).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Apply {
    target: Target,
    expected_fingerprint: String,
    expected_owner: String,
}

pub async fn apply(State(app): State<App>,p: Principal,headers: HeaderMap,Json(mut body): Json<Apply>) -> ApiResult<Response> {
    if body.expected_owner != p.root_id {
        return Err(ApiError::new(StatusCode::FORBIDDEN,"actor_changed","다른 인증으로 확인한 설정입니다. 원래 인증으로 결과를 확인하세요"));
    }
    body.target.normalize_keys()?;
    let hash = idem::body_hash("settings.reset",&json!({
        "scope":body.target.scope,"scope_id":body.target.scope_id,"keys":body.target.keys,
        "fingerprint":body.expected_fingerprint,"owner":body.expected_owner,
    }));
    let actor = p.clone();
    idem::run(&app,&p,&headers,&hash,move |tx,now| {
        let current = plan(tx,body.target,&actor.root_id)?;
        if current["fingerprint"] != body.expected_fingerprint {
            return Err(ApiError::conflict("reset_conflict","확인 후 설정이 바뀌었습니다. 모두 변경하지 않았습니다. 다시 비교하세요"));
        }
        let target: Target = serde_json::from_value(current["target"].clone())?;
        let mut changed = Vec::new();
        for item in current["items"].as_array().unwrap() {
            if item["changed"] != true { continue; }
            let key = item["key"].as_str().unwrap();
            tx.execute("UPDATE settings SET value=NULL,revision=revision+1,updated_at=?4 WHERE scope=?1 AND scope_id=?2 AND key=?3",
                params![target.scope,target.scope_id,key,now])?;
            let project = if target.scope == "server" { None } else { target.project_id.as_deref() };
            let session = if target.scope == "session" { target.session_id.as_deref() } else { None };
            crate::events::append(tx,now,"setting.changed",project,session,
                &json!({"scope":target.scope,"scope_id":target.scope_id,"key":key}))?;
            changed.push(key.to_string());
        }
        // 프로필·지침 등의 원문은 감사 이력에 중복 기록하지 않는다.
        if !changed.is_empty() {
            crate::audit::record(tx,now,&actor,"settings.reset",&format!("{}:{}",target.scope,target.scope_id),json!({"keys":changed}))?;
        }
        Ok((StatusCode::OK,json!({"target":target,"changed":changed})))
    }).await
}
