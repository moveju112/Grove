//! 새 데몬의 웹 초기 설정. 기기별 표시 설정은 저장하지 않는다.

use crate::{App, auth::Principal, error::{ApiError, ApiResult}, settings::{self, PutSetting}};
use axum::{Json, extract::State, http::{HeaderMap, StatusCode}, response::Response};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const OUTPUT_STYLE: &str = "output.style";
const COMPUTER: &str = crate::computer::ENABLED;

#[derive(Serialize, ts_rs::TS)]
pub struct SetupPreferences {
    pub output_style: String,
    pub output_style_revision: i64,
    pub output_style_options: Vec<String>,
    pub computer_enabled: bool,
    pub computer_revision: i64,
}

#[derive(Serialize, ts_rs::TS)]
pub struct SetupStatus {
    pub required: bool,
    /// 미완료 데몬의 등록 기기에 보내는 설정.
    pub preferences: Option<SetupPreferences>,
}

fn required(c: &Connection) -> ApiResult<bool> {
    Ok(c.query_row("SELECT NOT completed FROM daemon_setup WHERE id=1", [], |r| r.get(0))?)
}

fn setting(c: &Connection, key: &str) -> ApiResult<(settings::SettingDef, Value)> {
    let def = settings::def(key).ok_or_else(|| ApiError::internal(format!("unknown setup setting {key}")))?;
    let item = settings::resolve_key(c, &def, None, None)?;
    Ok((def, item))
}

fn revision(item: &Value) -> ApiResult<i64> {
    item["layers"]["server"]["revision"].as_i64().ok_or_else(|| ApiError::internal("missing setup setting revision"))
}

pub async fn show(State(app): State<App>, _p: Principal) -> ApiResult<Json<SetupStatus>> {
    let status = app.db.call(move |c| {
        let required = required(c)?;
        let preferences = if required {
            let (style, output) = setting(c, OUTPUT_STYLE)?;
            let (_, computer) = setting(c, COMPUTER)?;
            Some(SetupPreferences {
                output_style: output["effective"].as_str().ok_or_else(|| ApiError::internal("invalid output style"))?.into(),
                output_style_revision: revision(&output)?,
                output_style_options: style.options.iter().map(|v| v.to_string()).collect(),
                computer_enabled: computer["effective"].as_bool().ok_or_else(|| ApiError::internal("invalid computer setting"))?,
                computer_revision: revision(&computer)?,
            })
        } else { None };
        Ok(SetupStatus { required, preferences })
    }).await?;
    Ok(Json(status))
}

#[derive(Deserialize, Serialize)]
pub struct FinishSetup {
    output_style: String,
    output_style_revision: i64,
    computer_enabled: bool,
    computer_revision: i64,
}

pub async fn complete(
    State(app): State<App>, p: Principal, headers: HeaderMap, Json(body): Json<FinishSetup>,
) -> ApiResult<Response> {
    let hash = crate::idem::body_hash("daemon.setup.complete", &json!(body));
    let actor = p.clone();
    crate::idem::run(&app, &p, &headers, &hash, move |tx, now| {
        // 먼저 완료한 탭의 설정을 뒤늦은 요청으로 덮어쓰지 않는다.
        if required(tx)? {
            for (key, value, expected_revision) in [
                (OUTPUT_STYLE, json!(body.output_style), body.output_style_revision),
                (COMPUTER, json!(body.computer_enabled), body.computer_revision),
            ] {
                let (def, item) = setting(tx, key)?;
                settings::validate(&def, &value)?;
                if revision(&item)? != expected_revision { return Err(ApiError::revision_conflict(item)); }
                if item["effective"] != value {
                    let old_value = item["layers"]["server"]["value"].clone();
                    settings::record_change(tx, now, &actor, ("server", "-", key), (None, None),
                        &PutSetting { value, expected_revision }, old_value)?;
                }
            }
            tx.execute("UPDATE daemon_setup SET completed=1 WHERE id=1", [])?;
            crate::events::append(tx, now, "daemon_setup.completed", None, None, &json!({}))?;
        }
        Ok((StatusCode::OK, json!(SetupStatus { required: false, preferences: None })))
    }).await
}
