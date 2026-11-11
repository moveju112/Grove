//! 작업 로그의 저장 상태. 실행 성공과 원문 보관 성공을 구분한다.
use crate::error::{ApiError, ApiResult};
use crate::{App, events, tasks};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

pub(crate) fn path(data: &Path, id: &str, stream: &str) -> PathBuf {
    data.join("tasks").join(format!("{id}.{stream}"))
}

pub(crate) fn begin(c: &Connection, id: &str, now: &str) -> ApiResult<()> {
    for stream in ["out", "err"] {
        c.execute("INSERT INTO task_logs(task_id,stream,storage_key,state,updated_at) VALUES (?1,?2,?3,'writing',?4)",
            params![id, stream, format!("tasks/{id}.{stream}"), now])?;
    }
    Ok(())
}

/// 실행 전에 두 파일을 확보한다. 실패하면 자식 프로세스를 시작하지 않는다.
pub(crate) fn create(data: &Path, id: &str) -> std::io::Result<[std::fs::File; 2]> {
    let dir = data.join("tasks");
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&dir)?;
    if !std::fs::symlink_metadata(&dir)?.file_type().is_dir() {
        return Err(std::io::Error::other("invalid log directory"));
    }
    let open = |stream| {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        opts.open(path(data, id, stream))
    };
    Ok([open("out")?, open("err")?])
}

pub(crate) struct Report {
    pub total: u64,
    size: u64,
    sha: Option<String>,
    error: Option<&'static str>,
}

impl Report {
    pub(crate) fn empty() -> Self {
        Self {
            total: 0,
            size: 0,
            sha: Some(crate::util::sha256_hex(b"")),
            error: None,
        }
    }
    pub(crate) fn failed(code: &'static str) -> Self {
        Self {
            total: 0,
            size: 0,
            sha: None,
            error: Some(code),
        }
    }
}

pub(crate) async fn pump<R: AsyncRead + Unpin>(mut r: R, f: std::fs::File) -> Report {
    let mut f = tokio::fs::File::from_std(f);
    let mut report = Report::empty();
    let mut digest = Sha256::new();
    let mut buf = [0u8; 16 * 1024];
    loop {
        match r.read(&mut buf).await {
            Ok(0) => break,
            Err(_) => {
                report.error.get_or_insert("log_read_failed");
                break;
            }
            Ok(n) => {
                report.total = report.total.saturating_add(n as u64);
                // 쓰기에 실패하거나 상한에 도달해도 pipe를 끝까지 비운다.
                if report.error.is_none() && report.size < tasks::MAX_LOG {
                    let take = (n as u64).min(tasks::MAX_LOG - report.size) as usize;
                    if f.write_all(&buf[..take]).await.is_err() {
                        report.error = Some("log_write_failed");
                    } else {
                        digest.update(&buf[..take]);
                        report.size += take as u64;
                    }
                }
            }
        }
    }
    if f.flush().await.is_err() || f.sync_data().await.is_err() {
        report.error.get_or_insert("log_flush_failed");
    }
    if report.error.is_some() {
        if let Ok(m) = f.metadata().await {
            report.size = m.len();
        }
    }
    report.sha = if report.error.is_none() {
        Some(format!("{:x}", digest.finalize()))
    } else {
        None
    };
    report
}

pub(crate) async fn join(mut h: tokio::task::JoinHandle<Report>) -> Report {
    match tokio::time::timeout(std::time::Duration::from_secs(5), &mut h).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Report::failed("log_pump_failed"),
        Err(_) => {
            h.abort();
            let _ = h.await;
            Report::failed("log_pump_timeout")
        }
    }
}

pub(crate) fn finish(c: &Connection, id: &str, reports: &[Report; 2], now: &str) -> ApiResult<()> {
    for (stream, r) in ["out", "err"].into_iter().zip(reports) {
        c.execute("UPDATE task_logs SET size=?3,sha256=?4,state=?5,error=?6,updated_at=?7 WHERE task_id=?1 AND stream=?2",
            params![id,stream,r.size as i64,r.sha,if r.error.is_some() { "error" } else { "ready" },r.error,now])?;
    }
    Ok(())
}

pub(crate) fn describe(c: &Connection, id: &str) -> ApiResult<Vec<Value>> {
    let mut st = c.prepare("SELECT l.stream,l.storage_key,l.size,l.sha256,l.state,l.error,l.updated_at,t.project_id,t.session_id FROM task_logs l JOIN tasks t ON t.id=l.task_id WHERE l.task_id=?1 ORDER BY l.stream DESC")?;
    Ok(st.query_map([id], |r| Ok(json!({
        "stream": if r.get::<_, String>(0)? == "out" { "stdout" } else { "stderr" },
        "storage_key":r.get::<_,String>(1)?,"size":r.get::<_,i64>(2)?,"sha256":r.get::<_,Option<String>>(3)?,
        "state":r.get::<_,String>(4)?,"error":r.get::<_,Option<String>>(5)?,"updated_at":r.get::<_,String>(6)?,
        "project_id":r.get::<_,String>(7)?,"session_id":r.get::<_,String>(8)?,"ref_count":1
    })))?.collect::<Result<_,_>>()?)
}

pub(crate) fn open_read(p: &Path) -> Result<std::fs::File, &'static str> {
    let m = std::fs::symlink_metadata(&p).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "log_missing"
        } else {
            "log_read_failed"
        }
    })?;
    if !m.file_type().is_file() {
        return Err("log_invalid_file");
    }
    if m.len() > tasks::MAX_LOG {
        return Err("log_size_limit");
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let f = opts.open(p).map_err(|_| "log_read_failed")?;
    if !f.metadata().map_err(|_| "log_read_failed")?.is_file() {
        return Err("log_invalid_file");
    }
    Ok(f)
}

fn read(data: &Path, id: &str, stream: &str) -> Result<Vec<u8>, &'static str> {
    let f = open_read(&path(data, id, stream))?;
    let mut bytes = Vec::new();
    f.take(tasks::MAX_LOG + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "log_read_failed")?;
    if bytes.len() as u64 > tasks::MAX_LOG {
        return Err("log_size_limit");
    }
    Ok(bytes)
}

fn mark(c: &Connection, id: &str, stream: &str, code: &str, now: &str) -> ApiResult<()> {
    c.execute(
        "UPDATE task_logs SET state=?3,error=?4,updated_at=?5 WHERE task_id=?1 AND stream=?2",
        params![
            id,
            stream,
            if code == "log_missing" {
                "missing"
            } else {
                "error"
            },
            code,
            now
        ],
    )?;
    Ok(())
}

fn changed(c: &Connection, t: &tasks::Task, now: &str) -> ApiResult<()> {
    events::append(
        c,
        now,
        "task.changed",
        Some(&t.project_id),
        Some(&t.session_id),
        &serde_json::to_value(t)?,
    )?;
    Ok(())
}

/// 호출자는 오류 응답도 metadata와 함께 commit한다. 원문은 손상돼도 삭제하지 않는다.
pub(crate) fn output(
    c: &Connection,
    data: &Path,
    t: &tasks::Task,
    stream: &str,
    offset: u64,
    limit: u64,
    now: &str,
) -> ApiResult<Value> {
    let meta: Option<(String, i64, Option<String>, Option<String>)> = c
        .query_row(
            "SELECT state,size,sha256,error FROM task_logs WHERE task_id=?1 AND stream=?2",
            params![t.id, stream],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let (state, size, sha, error) =
        meta.ok_or_else(|| ApiError::gone("로그 metadata가 없습니다"))?;
    if matches!(state.as_str(), "expired" | "missing" | "error") {
        return Err(unavailable(&state, error.as_deref()));
    }
    let bytes = match read(data, &t.id, stream) {
        Ok(b) => b,
        Err(code) if t.status == "running" && code == "log_missing" => Vec::new(),
        Err(code) => {
            mark(c, &t.id, stream, code, now)?;
            changed(c, t, now)?;
            return Err(unavailable(
                if code == "log_missing" {
                    "missing"
                } else {
                    "error"
                },
                Some(code),
            ));
        }
    };
    if t.status != "running" {
        let digest = crate::util::sha256_hex(&bytes);
        if state == "ready" && (size != bytes.len() as i64 || sha.as_deref() != Some(&digest)) {
            mark(c, &t.id, stream, "log_hash_mismatch", now)?;
            changed(c, t, now)?;
            return Err(unavailable("error", Some("log_hash_mismatch")));
        }
        if state == "writing" {
            c.execute("UPDATE task_logs SET size=?3,sha256=?4,state='ready',error=NULL,updated_at=?5 WHERE task_id=?1 AND stream=?2",params![t.id,stream,bytes.len() as i64,digest,now])?;
        }
    }
    let start = offset.min(bytes.len() as u64) as usize;
    let end = start.saturating_add(limit as usize).min(bytes.len());
    let total = if stream == "out" {
        t.stdout_bytes
    } else {
        t.stderr_bytes
    } as u64;
    Ok(
        json!({"task_id":t.id,"stream":if stream=="out" {"stdout"} else {"stderr"},"offset":offset,
            "next_offset":offset.saturating_add((end-start) as u64),"data":String::from_utf8_lossy(&bytes[start..end]),
            "stored_bytes":bytes.len(),"eof":offset.saturating_add((end-start) as u64)>=bytes.len() as u64 && t.status!="running",
            "dropped_bytes":if t.status!="running" {total.saturating_sub(bytes.len() as u64)} else {0},
            "log":describe(c,&t.id)?.into_iter().find(|m| m["stream"] == if stream=="out" {"stdout"} else {"stderr"})
        }),
    )
}

fn unavailable(state: &str, code: Option<&str>) -> ApiError {
    ApiError::new(
        axum::http::StatusCode::GONE,
        "task_log_unavailable",
        "작업 로그 원문을 사용할 수 없습니다",
    )
    .with_details(json!({"state":state,"reason":code}))
}

/// 기존/중단 로그를 제한된 행·바이트 예산으로 검사한다. unknown 원문도 검사만 하고 보존한다.
pub(crate) fn reconcile(app: &App, after: &mut i64, limit: usize) -> ApiResult<usize> {
    app.db.call_sync(|c| {
        let mut st = c.prepare("SELECT l.rowid,l.task_id,l.stream,l.state,l.size,t.status FROM task_logs l JOIN tasks t ON t.id=l.task_id WHERE l.rowid>?1 ORDER BY l.rowid LIMIT ?2")?;
        let rows = st.query_map(params![*after,limit as i64],|r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?,r.get::<_,String>(5)?)))?.collect::<Result<Vec<_>,_>>()?;
        drop(st);
        if rows.is_empty() { *after=0; }
        let mut budget = 32 * 1024 * 1024u64;
        let mut marked = 0;
        for (row,id,stream,state,size,status) in rows {
            if state == "writing" && status != "running" && budget < tasks::MAX_LOG { break; }
            *after=row;
            if status == "running" || matches!(state.as_str(),"expired"|"error"|"missing") { continue; }
            let now=app.now();
            let p=path(&app.cfg.data_dir,&id,&stream);
            let failure = match std::fs::symlink_metadata(p) {
                Err(e) if e.kind()==std::io::ErrorKind::NotFound => Some("log_missing"),
                Err(_) => Some("log_read_failed"),
                Ok(m) if !m.file_type().is_file() => Some("log_invalid_file"),
                Ok(m) if m.len()>tasks::MAX_LOG => Some("log_size_limit"),
                Ok(m) if state=="ready" && m.len()!=size as u64 => Some("log_size_mismatch"),
                Ok(_) if state=="writing" => {
                    budget -= tasks::MAX_LOG;
                    match read(&app.cfg.data_dir,&id,&stream) {
                        Ok(b) => { c.execute("UPDATE task_logs SET size=?3,sha256=?4,state='ready',updated_at=?5 WHERE task_id=?1 AND stream=?2",params![id,stream,b.len() as i64,crate::util::sha256_hex(&b),now])?; None }
                        Err(code) => Some(code)
                    }
                }
                Ok(_) => None,
            };
            if let Some(code)=failure {
                let tx=c.transaction()?;
                mark(&tx,&id,&stream,code,&now)?;
                changed(&tx,&tasks::get(&tx,&id)?,&now)?;
                tx.commit()?;
                marked+=1;
            }
        }
        Ok(marked)
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn failed_write_drains_the_pipe_and_records_storage_failure() {
        let input = vec![b'x'; 128 * 1024];
        let f = std::fs::OpenOptions::new()
            .write(true)
            .open("/dev/full")
            .unwrap();
        let report = pump(&input[..], f).await;
        assert_eq!(report.total, input.len() as u64);
        assert_eq!(report.error, Some("log_write_failed"));
        assert!(report.sha.is_none());
    }

    #[tokio::test]
    async fn digest_covers_only_the_retained_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let file = std::fs::File::create(dir.path().join("out")).unwrap();
        let input = vec![b'x'; tasks::MAX_LOG as usize + 1024];
        let report = pump(&input[..], file).await;
        assert_eq!(report.total, input.len() as u64);
        assert_eq!(report.size, tasks::MAX_LOG);
        assert_eq!(
            report.sha,
            Some(crate::util::sha256_hex(&input[..tasks::MAX_LOG as usize]))
        );
        assert!(report.error.is_none());
    }
}
