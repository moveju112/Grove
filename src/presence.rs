//! 기기별 마지막 사용자 입력 시각. 다른 기기를 쓰는 동안 이 기기의 Push 알림을 생략하는 데만 쓰며 저장하지 않는다.
use crate::{App, auth::Principal, error::ApiResult};
use axum::{extract::State, http::StatusCode};
use std::{collections::HashMap, sync::Mutex};

/// 이 시간 안에 입력이 있었던 기기를 사용 중으로 본다.
pub const ACTIVE_SECONDS: i64 = 15 * 60;

#[derive(Default)]
pub struct Presence(Mutex<HashMap<String, i64>>);

impl Presence {
    pub fn touch(&self, device: &str, now: i64) {
        let mut seen = self.0.lock().expect("presence");
        seen.retain(|_, at| now - *at < ACTIVE_SECONDS);
        seen.insert(device.to_owned(), now);
    }

    /// 같은 기기의 입력은 그 기기의 알림을 막지 않는다.
    pub fn active_elsewhere(&self, device: &str, now: i64) -> bool {
        self.0.lock().expect("presence").iter().any(|(id, at)| id != device && now - *at < ACTIVE_SECONDS)
    }
}

/// 등록 기기 단위로 기록한다. 같은 기기의 여러 브라우저 로그인은 한 기기로 본다.
pub async fn post(State(app): State<App>, p: Principal) -> ApiResult<StatusCode> {
    app.presence.touch(&p.root_id, app.clock.now().unix_timestamp());
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn other_devices_count_as_active_for_fifteen_minutes_only() {
        let presence = Presence::default();
        assert!(!presence.active_elsewhere("phone", 1_000));
        presence.touch("pc", 1_000);
        assert!(!presence.active_elsewhere("pc", 1_000), "자기 입력으로 자기 알림을 막지 않는다");
        assert!(presence.active_elsewhere("phone", 1_000));
        assert!(presence.active_elsewhere("phone", 1_000 + ACTIVE_SECONDS - 1));
        assert!(!presence.active_elsewhere("phone", 1_000 + ACTIVE_SECONDS));
        presence.touch("tablet", 1_000 + ACTIVE_SECONDS);
        assert_eq!(presence.0.lock().unwrap().len(), 1, "지난 기록은 정리한다");
    }
}
