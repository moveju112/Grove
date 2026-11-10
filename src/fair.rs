//! 공정 실행(FAIR-001~013).
//!
//! 적용 지점(FAIR-001): **모델 호출 한 번**이 슬롯 하나를 쓴다. 턴 전체가 아니라 provider 호출 직전에 얻고 끝나면 돌려준다.
//! 그래서 승인 대기·도구 실행·사용자 입력 대기는 슬롯을 차지하지 않는다(FAIR-008). 상태 조회·취소·승인 같은 제어 요청은
//! 이 큐를 거치지 않는다(FAIR-009). 모든 함수를 큐로 감싸지 않는다.
//!
//! - 접수 한도(FAIR-003): 턴 접수 transaction에서 DB의 queued/running 수로 소유자별·전체 한도를 검사한다.
//! - 슬롯 분배(FAIR-005): 빈 슬롯이 생기면 지금 실행 중인 호출이 가장 적은 소유자부터, 같으면 가장 오래전에 받은 소유자에게 준다.
//!   혼자면 남는 용량을 모두 쓴다. 실행 중인 호출은 선점하지 않는다.
//! - 반환(FAIR-007): `Permit`의 Drop에서 반환하므로 성공·오류·취소·panic 모든 경로에서 새지 않는다.
//!   대기 중 취소되면 큐에서 빠지고, 취소와 배정이 겹치면 받은 슬롯을 즉시 돌려준다.
//! - 재시작(FAIR-010): 큐는 메모리에만 있다. 재시작하면 대기·실행 중 턴은 interrupted로 남기고 자동 재접수하지 않는다(runner::recover).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::sync::{oneshot, watch};

struct Waiter {
    turn_id: String,
    owner: String,
    tx: oneshot::Sender<()>,
}

#[derive(Default)]
struct Inner {
    max_active: usize,
    active: usize,
    active_by_owner: HashMap<String, usize>,
    /// 소유자별 마지막으로 슬롯을 받은 순번(작을수록 오래전)
    last_served: HashMap<String, u64>,
    tick: u64,
    waiters: VecDeque<Waiter>,
}

impl Inner {
    fn grant(&mut self, owner: &str) {
        self.active += 1;
        *self.active_by_owner.entry(owner.to_string()).or_default() += 1;
        self.tick += 1;
        self.last_served.insert(owner.to_string(), self.tick);
    }

    /// 빈 슬롯마다 다음 대기자를 고른다.
    fn dispatch(&mut self) {
        while self.active < self.max_active && !self.waiters.is_empty() {
            let pick = (0..self.waiters.len())
                .min_by_key(|&i| {
                    let o = &self.waiters[i].owner;
                    (self.active_by_owner.get(o).copied().unwrap_or(0), self.last_served.get(o).copied().unwrap_or(0), i)
                })
                .expect("non-empty");
            let w = self.waiters.remove(pick).expect("index");
            let owner = w.owner.clone();
            // 받는 쪽이 이미 사라졌으면(취소) 다음 대기자로.
            if w.tx.send(()).is_ok() {
                self.grant(&owner);
            }
        }
    }

    fn release(&mut self, owner: &str) {
        self.active = self.active.saturating_sub(1);
        if let Some(n) = self.active_by_owner.get_mut(owner) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                self.active_by_owner.remove(owner);
            }
        }
        self.dispatch();
    }
}

#[derive(Default, Clone)]
pub struct Fair {
    inner: Arc<Mutex<Inner>>,
}

pub struct Permit {
    fair: Fair,
    owner: String,
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.fair.inner.lock().expect("fair").release(&self.owner);
    }
}

#[derive(Debug, PartialEq)]
pub enum AcquireError {
    Cancelled,
}

/// 대기 중인 턴의 상태(FAIR-011). 다른 소유자의 정보는 개수로만 보인다.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct WaitInfo {
    pub ahead: usize,
    pub active: usize,
    pub limit: usize,
}

impl Fair {
    pub async fn acquire(&self, owner: &str, turn_id: &str, max_active: usize, cancel: &mut watch::Receiver<bool>) -> Result<Permit, AcquireError> {
        let rx = {
            let mut g = self.inner.lock().expect("fair");
            g.max_active = max_active.max(1);
            // 한도가 늘었으면 기존 대기자부터 채운다.
            g.dispatch();
            if g.active < g.max_active && g.waiters.is_empty() {
                g.grant(owner);
                return Ok(Permit { fair: self.clone(), owner: owner.to_string() });
            }
            let (tx, rx) = oneshot::channel();
            g.waiters.push_back(Waiter { turn_id: turn_id.to_string(), owner: owner.to_string(), tx });
            rx
        };
        let mut rx = rx;
        loop {
            if *cancel.borrow() {
                break;
            }
            tokio::select! {
                r = &mut rx => {
                    return match r {
                        Ok(()) => Ok(Permit { fair: self.clone(), owner: owner.to_string() }),
                        Err(_) => Err(AcquireError::Cancelled),
                    };
                }
                ch = cancel.changed() => {
                    if ch.is_err() {
                        break;
                    }
                }
            }
        }
        // 취소: 큐에서 빼고, 그 사이 배정됐으면 바로 반환한다.
        let granted = {
            let mut g = self.inner.lock().expect("fair");
            let before = g.waiters.len();
            g.waiters.retain(|w| w.turn_id != turn_id);
            before == g.waiters.len()
        };
        if granted && rx.try_recv().is_ok() {
            drop(Permit { fair: self.clone(), owner: owner.to_string() });
        }
        Err(AcquireError::Cancelled)
    }

    pub fn waiting(&self, turn_id: &str) -> Option<WaitInfo> {
        let g = self.inner.lock().expect("fair");
        let pos = g.waiters.iter().position(|w| w.turn_id == turn_id)?;
        Some(WaitInfo { ahead: pos, active: g.active, limit: g.max_active })
    }

    /// 관찰용(시험·상태 화면): (실행 중, 대기 중)
    pub fn counts(&self) -> (usize, usize) {
        let g = self.inner.lock().expect("fair");
        (g.active, g.waiters.len())
    }
}

/// 접수 한도 검사(FAIR-003). 턴 접수와 같은 transaction에서 부른다.
pub fn admit(c: &rusqlite::Connection, owner: &str) -> crate::error::ApiResult<()> {
    use crate::error::ApiError;
    let lim = |k: &str| -> crate::error::ApiResult<i64> { Ok(crate::settings::effective(c, k, None, None)?.as_i64().unwrap_or(i64::MAX)) };
    let per_owner = lim("runs.max_queued_per_owner")?;
    let total = lim("runs.max_queued_total")?;
    let (mine, all): (i64, i64) = c.query_row(
        "SELECT COALESCE(SUM(owner_key = ?1), 0), COUNT(*) FROM turns WHERE status IN ('queued','running')",
        rusqlite::params![owner],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if mine >= per_owner || all >= total {
        let scope = if mine >= per_owner { "이 기기의" } else { "서버 전체" };
        return Err(ApiError::new(axum::http::StatusCode::TOO_MANY_REQUESTS, "queue_full", format!("{scope} 실행 대기열이 가득 찼습니다. 앞선 요청이 끝난 뒤 다시 시도하세요"))
            .retryable()
            .with_details(serde_json::json!({ "limit": if mine >= per_owner { per_owner } else { total } })));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn never() -> (watch::Sender<bool>, watch::Receiver<bool>) {
        watch::channel(false)
    }

    /// FAIR-012: A가 계속 요청을 쌓아도 B는 다음 빈 슬롯에서 진행한다.
    #[tokio::test]
    async fn newcomer_gets_next_slot_while_one_owner_floods() {
        let f = Fair::default();
        let (_k, mut c) = never();
        let a1 = f.acquire("A", "a1", 1, &mut c).await.unwrap();
        // A가 대기열에 3개 쌓은 뒤 B가 도착
        let mut hs = vec![];
        for i in 2..=4 {
            let f2 = f.clone();
            let (_k2, mut c2) = never();
            hs.push(tokio::spawn(async move {
                let p = f2.acquire("A", &format!("a{i}"), 1, &mut c2).await.unwrap();
                drop(_k2);
                (format!("a{i}"), p)
            }));
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let fb = f.clone();
        let hb = tokio::spawn(async move {
            let (_kb, mut cb) = never();
            let p = fb.acquire("B", "b1", 1, &mut cb).await.unwrap();
            ("b1".to_string(), p)
        });
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert_eq!(f.counts(), (1, 4));
        assert_eq!(f.waiting("b1"), Some(WaitInfo { ahead: 3, active: 1, limit: 1 }), "B는 줄 끝에 있지만");
        drop(a1);
        let (who, p) = hb.await.unwrap();
        assert_eq!(who, "b1", "A가 방금 썼으므로 다음 기회는 B");
        assert_eq!(f.counts(), (1, 3));
        drop(p);
        // 이후 A의 대기자들이 순서대로
        let mut order = vec![];
        for h in hs {
            let (id, p) = h.await.unwrap();
            order.push(id);
            drop(p);
        }
        assert_eq!(order, ["a2", "a3", "a4"]);
        assert_eq!(f.counts(), (0, 0), "슬롯 누수 없음");
    }

    #[tokio::test]
    async fn single_owner_uses_all_capacity_and_cancel_frees_queue() {
        let f = Fair::default();
        let (_k, mut c) = never();
        let p1 = f.acquire("A", "1", 2, &mut c).await.unwrap();
        let p2 = f.acquire("A", "2", 2, &mut c).await.unwrap();
        assert_eq!(f.counts(), (2, 0), "혼자면 남는 용량을 모두 쓴다");
        // 대기 중 취소 → 큐에서 빠지고 슬롯을 받지 않는다
        let (kt, mut ct) = watch::channel(false);
        let f2 = f.clone();
        let h = tokio::spawn(async move { f2.acquire("A", "3", 2, &mut ct).await.map(|_| ()) });
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert_eq!(f.counts(), (2, 1));
        kt.send(true).unwrap();
        assert_eq!(h.await.unwrap(), Err(AcquireError::Cancelled));
        assert_eq!(f.counts(), (2, 0));
        drop(p1);
        drop(p2);
        assert_eq!(f.counts(), (0, 0));
    }

    /// 취소 폭주·배정 경합에서도 누수 없음(FAIR-013).
    #[tokio::test]
    async fn cancel_storm_does_not_leak_slots() {
        let f = Fair::default();
        let mut hs = vec![];
        for i in 0..200 {
            let f2 = f.clone();
            let (k, mut c) = watch::channel(false);
            hs.push(tokio::spawn(async move {
                let cancel = tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_micros((i % 7) * 50)).await;
                    let _ = k.send(true);
                });
                if let Ok(p) = f2.acquire(if i % 2 == 0 { "A" } else { "B" }, &i.to_string(), 3, &mut c).await {
                    tokio::time::sleep(Duration::from_micros(100)).await;
                    drop(p);
                }
                cancel.await.unwrap();
            }));
        }
        for h in hs {
            h.await.unwrap();
        }
        assert_eq!(f.counts(), (0, 0));
    }

    #[tokio::test]
    async fn raising_limit_fills_waiters() {
        let f = Fair::default();
        let (_k, mut c) = never();
        let _p = f.acquire("A", "1", 1, &mut c).await.unwrap();
        let f2 = f.clone();
        let h = tokio::spawn(async move {
            let (_k, mut c) = watch::channel(false);
            f2.acquire("B", "2", 1, &mut c).await.map(|_| ())
        });
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert_eq!(f.counts(), (1, 1));
        // 다른 호출이 더 큰 한도로 들어오면 기존 대기자부터 채운다
        let _p3 = f.acquire("C", "3", 3, &mut c).await.unwrap();
        assert!(h.await.unwrap().is_ok());
    }
}
