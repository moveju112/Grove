//! 등록한 project_id 기준으로 서버 파일·Git 작업의 공유 읽기/배타 변경을 제어한다.
//! 사용자 직접 병렬 프로세스는 유지한다. 임의 셸의 프로젝트 밖 접근을 격리하는 sandbox는 아니다.
use crate::{App, error::{ApiError, ApiResult}, tools::{Effect, ToolError, ToolResult}};
use std::{collections::HashMap, sync::{Arc, Mutex, Weak}};
use tokio::sync::{RwLock, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, watch};

#[derive(Default)]
pub struct ProjectResources {
    locks: Mutex<HashMap<String, Weak<RwLock<()>>>>,
}

/// 같은 프로젝트의 Git 변경/프로세스 접수는 각 경로의 요청 순서를 보존한다.
#[derive(Default)]
pub struct ProjectQueues {
    map: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl ProjectQueues {
    pub(crate) fn get(&self, project: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.map.lock().expect("project queues").entry(project.to_string()).or_default().clone()
    }
}

pub enum Lease {
    Read { _guard: OwnedRwLockReadGuard<()> },
    Write { _guard: OwnedRwLockWriteGuard<()> },
}

fn busy() -> ApiError {
    ApiError::conflict("resource_busy", "이 프로젝트에서 다른 파일·Git 작업 또는 프로세스가 실행 중입니다. 작업을 끝내거나 취소한 뒤 다시 시도하세요")
}

async fn processes_running(app: &App, project: &str) -> ApiResult<bool> {
    let project = project.to_string();
    app.db.call(move |c| Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE project_id=?1 AND status='running')", [project], |r| r.get(0),
    )?)).await
}

impl ProjectResources {
    fn get(&self, project: &str) -> Arc<RwLock<()>> {
        let mut locks = self.locks.lock().expect("project resource locks");
        locks.retain(|_,lock|lock.strong_count()>0);
        if let Some(lock) = locks.get(project).and_then(Weak::upgrade) { return lock; }
        let lock = Arc::new(RwLock::new(()));
        locks.insert(project.to_string(),Arc::downgrade(&lock));
        lock
    }

    pub async fn ui_read(&self, app: &App, project: &str, principal: &crate::auth::Principal) -> ApiResult<OwnedRwLockReadGuard<()>> {
        if processes_running(app, project).await? { return Err(busy()); }
        let mut shutdown=app.shutdown_rx.clone();
        let guard=tokio::select! {
            biased;
            _=shutdown.wait_for(|v|*v) => return Err(ApiError::conflict("interrupted","서버 종료로 파일 작업을 시작하지 않았습니다")),
            guard=self.get(project).read_owned() => guard,
        };
        if processes_running(app, project).await? { return Err(busy()); }
        crate::auth::revalidate(app,principal).await?;
        Ok(guard)
    }

    pub async fn ui_write(&self, app: &App, project: &str, principal: &crate::auth::Principal) -> ApiResult<OwnedRwLockWriteGuard<()>> {
        if processes_running(app, project).await? { return Err(busy()); }
        let guard=self.write_guard(app,project).await?;
        if processes_running(app, project).await? { return Err(busy()); }
        crate::auth::revalidate(app,principal).await?;
        Ok(guard)
    }

    /// UI의 명시적 병렬 프로세스 접수는 보존한다. 파일 작업과 접수/실제 spawn 사이만 배타로 묶는다.
    pub async fn process_start(&self, app: &App, project: &str, principal: &crate::auth::Principal) -> ApiResult<OwnedRwLockWriteGuard<()>> {
        let guard=self.write_guard(app,project).await?;
        crate::auth::revalidate(app,principal).await?;
        Ok(guard)
    }

    async fn write_guard(&self, app: &App, project: &str) -> ApiResult<OwnedRwLockWriteGuard<()>> {
        let mut shutdown=app.shutdown_rx.clone();
        tokio::select! {
            biased;
            _=shutdown.wait_for(|v|*v) => Err(ApiError::conflict("interrupted","서버 종료로 파일 작업을 시작하지 않았습니다")),
            guard=self.get(project).write_owned() => Ok(guard),
        }
    }

    pub async fn tool(&self, app: &App, project: &str, effect: Effect, cancel: &mut watch::Receiver<bool>) -> ToolResult<Option<Lease>> {
        if !matches!(effect, Effect::Read | Effect::Write | Effect::Execute) { return Ok(None); }
        // 구독 후 guard와 snapshot을 얻으므로 guard를 기다리는 사이 끝난 작업도 놓치지 않는다.
        let mut events = app.seq_tx.subscribe();
        let mut shutdown = app.shutdown_rx.clone();
        if *cancel.borrow() { return Err(ToolError::new("cancelled","프로젝트 자원 대기 중 취소됐습니다")); }
        if *shutdown.borrow() { return Err(ToolError::new("interrupted","서버 종료로 프로젝트 작업을 시작하지 않았습니다")); }
        let lock = self.get(project);
        let acquire = async move {
            if effect == Effect::Read { Lease::Read { _guard:lock.read_owned().await } }
            else { Lease::Write { _guard:lock.write_owned().await } }
        };
        let lease = tokio::select! {
            biased;
            _ = cancel.wait_for(|v| *v) => return Err(ToolError::new("cancelled","프로젝트 자원 대기 중 취소됐습니다")),
            _ = shutdown.wait_for(|v| *v) => return Err(ToolError::new("interrupted","서버 종료로 프로젝트 작업을 시작하지 않았습니다")),
            lease = acquire => lease,
        };
        // guard를 가진 동안 새 프로세스 접수는 막힌다. 기존 프로세스의 종료·취소·로그 조회는 guard가 필요 없다.
        loop {
            if *cancel.borrow() { return Err(ToolError::new("cancelled","프로젝트 자원 대기 중 취소됐습니다")); }
            if *shutdown.borrow() { return Err(ToolError::new("interrupted","서버 종료로 프로젝트 작업을 시작하지 않았습니다")); }
            if !processes_running(app,project).await.map_err(|e|ToolError::new(e.code,e.message))? { return Ok(Some(lease)); }
            tokio::select! {
                _ = cancel.wait_for(|v| *v) => return Err(ToolError::new("cancelled","프로젝트 자원 대기 중 취소됐습니다")),
                _ = shutdown.wait_for(|v| *v) => return Err(ToolError::new("interrupted","서버 종료로 프로젝트 작업을 시작하지 않았습니다")),
                changed = events.changed() => changed.map_err(|_|ToolError::new("interrupted","프로젝트 자원 이벤트가 중단됐습니다"))?,
            }
        }
    }
}
