//! process 서비스의 제한된 파일 로그(DB-019). foreground/systemd는 기본 stderr를 유지한다.
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::fmt::writer::BoxMakeWriter;

pub(crate) const FILE_BYTES: u64 = 2 * 1024 * 1024;
pub(crate) const ARCHIVES: usize = 3;
const EVENT_BYTES: usize = 16 * 1024;
const TRUNCATED: &[u8] = b" [grove: log event truncated]\n";
const TRIM_HEADER: &[u8] = b"[grove-log-tail:v1]\n";

/// fmt layer의 thread-local String에 적재하기 전에 제한한다. writer에서만 자르면
/// 디스크는 제한해도 큰 field를 포맷한 버퍼는 스레드마다 계속 남는다.
pub(crate) struct EventFormat(pub bool);

impl<S, N> tracing_subscriber::fmt::FormatEvent<S, N> for EventFormat
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
    N: for<'a> tracing_subscriber::fmt::FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        ctx: &tracing_subscriber::fmt::FmtContext<'_, S, N>,
        writer: tracing_subscriber::fmt::format::Writer<'_>,
        event: &tracing::Event<'_>,
    ) -> std::fmt::Result {
        use tracing_subscriber::fmt::format::{Format, Writer};
        if !self.0 {
            return Format::default().format_event(ctx, writer, event);
        }
        let mut limited = LimitedText {
            writer,
            remaining: EVENT_BYTES - TRUNCATED.len(),
            truncated: false,
        };
        Format::default().format_event(ctx, Writer::new(&mut limited), event)?;
        if limited.truncated {
            limited
                .writer
                .write_str(std::str::from_utf8(TRUNCATED).expect("ASCII marker"))?;
        }
        Ok(())
    }
}

struct LimitedText<'a> {
    writer: tracing_subscriber::fmt::format::Writer<'a>,
    remaining: usize,
    truncated: bool,
}

impl std::fmt::Write for LimitedText<'_> {
    fn write_str(&mut self, text: &str) -> std::fmt::Result {
        if self.truncated {
            return Ok(());
        }
        let mut keep = text.len().min(self.remaining);
        while !text.is_char_boundary(keep) {
            keep -= 1;
        }
        self.writer.write_str(&text[..keep])?;
        self.remaining -= keep;
        self.truncated = keep < text.len();
        Ok(())
    }
}

pub(crate) fn writer(path: Option<&Path>) -> io::Result<BoxMakeWriter> {
    match path {
        Some(path) => Ok(BoxMakeWriter::new(FileLog::open(path)?)),
        None => Ok(BoxMakeWriter::new(std::io::stderr)),
    }
}

/// 관리 CLI는 spawn 전에 파일 오류를 보고한다. 이전 서버에는 이 append handle을 전달한다.
pub(crate) fn prepare_file(path: &Path) -> io::Result<File> {
    let log = FileLog::open(path)?;
    let guard = log.0.lock().expect("log mutex");
    guard.file.as_ref().expect("opened log").try_clone()
}

#[derive(Clone)]
struct FileLog(Arc<Mutex<Rolling>>);

struct Rolling {
    path: PathBuf,
    file: Option<File>,
    size: u64,
    // 파일 교체와 무관한 별도 잠금을 서버 수명 동안 소유한다.
    _lock: File,
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn regular(path: &Path) -> io::Result<Option<std::fs::Metadata>> {
    match path.symlink_metadata() {
        Ok(m) => {
            if !m.file_type().is_file() {
                return Err(io::Error::other("로그 경로는 일반 파일이어야 합니다"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if m.nlink() != 1 {
                    return Err(io::Error::other(
                        "공유된 hardlink 로그는 사용할 수 없습니다",
                    ));
                }
            }
            Ok(Some(m))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn open(path: &Path, new: bool) -> io::Result<File> {
    regular(path)?;
    let mut options = OpenOptions::new();
    options.read(true).append(true);
    if new {
        options.create_new(true);
    } else {
        options.create(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let f = options.open(path)?;
    if !f.metadata()?.is_file() {
        return Err(io::Error::other("로그 경로는 일반 파일이어야 합니다"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if f.metadata()?.nlink() != 1 {
            return Err(io::Error::other(
                "공유된 hardlink 로그는 사용할 수 없습니다",
            ));
        }
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(f)
}

/// 이전 무제한 로그는 끝 2MiB만 복사한다. 실패하면 원본을 남긴다.
/// 일반 atomic_write는 staging에 쓴 뒤 권한을 맞추므로, 로그는 생성부터 0600인 파일을 쓴다.
fn trim(path: &Path) -> io::Result<()> {
    let Some(meta) = regular(path)? else {
        return Ok(());
    };
    if meta.len() <= FILE_BYTES {
        return Ok(());
    }
    let temporary = sibling(path, ".grove-tail.tmp");
    if let Some(m) = regular(&temporary)? {
        // 고정 slot만 사용한다. 이름만으로 지우지 않고 소유 형식·크기·권한을 검증한다.
        let mut owned = m.len() <= FILE_BYTES;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            owned &=
                m.uid() == unsafe { libc::geteuid() } && m.permissions().mode() & 0o777 == 0o600;
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let mut file = options.open(&temporary)?;
        let mut header = [0; TRIM_HEADER.len()];
        owned &= file.read_exact(&mut header).is_ok() && header == TRIM_HEADER;
        drop(file);
        if !owned {
            return Err(io::Error::other(
                "이전 로그 정리 임시 파일을 확인해야 합니다",
            ));
        }
        std::fs::remove_file(&temporary)?;
    }
    let mut source = open(path, false)?;
    let tail_bytes = FILE_BYTES - TRIM_HEADER.len() as u64;
    source.seek(SeekFrom::End(-(tail_bytes as i64)))?;
    let target = open(&temporary, true)?; // 생성하지 못한 파일은 오류 정리 대상이 아니다.
    let result = (|| {
        let mut target = target;
        target.write_all(TRIM_HEADER)?;
        let mut tail = source.take(tail_bytes);
        let copied = io::copy(&mut tail, &mut target)?;
        drop(tail); // Windows에서도 원본 handle을 닫은 뒤 교체한다.
        if copied != tail_bytes {
            return Err(io::Error::other("로그 끝부분 복사 중 원본이 바뀌었습니다"));
        }
        target.sync_all()?;
        drop(target);
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

impl FileLog {
    fn open(path: &Path) -> io::Result<Self> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut dirs = std::fs::DirBuilder::new();
        dirs.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            dirs.mode(0o700);
        }
        dirs.create(parent)?;
        if !parent.symlink_metadata()?.file_type().is_dir() {
            return Err(io::Error::other(
                "로그 폴더는 symlink가 아닌 디렉터리여야 합니다",
            ));
        }
        let lock = open(&sibling(path, ".lock"), false)?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err(io::Error::other("다른 서버가 이 로그를 사용 중입니다"));
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(e),
        }
        // 위험한 보관 경로를 먼저 모두 검사해 일부 회전 뒤에 발견하지 않게 한다.
        regular(path)?;
        for i in 1..=ARCHIVES {
            regular(&sibling(path, &format!(".{i}")))?;
        }
        trim(path)?;
        for i in 1..=ARCHIVES {
            trim(&sibling(path, &format!(".{i}")))?;
        }
        let file = open(path, false)?;
        let size = file.metadata()?.len();
        Ok(Self(Arc::new(Mutex::new(Rolling {
            path: path.into(),
            file: Some(file),
            size,
            _lock: lock,
        }))))
    }
}

impl Rolling {
    fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        if self.file.is_none() {
            let file = open(&self.path, false)?;
            self.size = file.metadata()?.len();
            self.file = Some(file);
        }
        if self.size + bytes.len() as u64 > FILE_BYTES {
            regular(&self.path)?;
            for i in 1..=ARCHIVES {
                regular(&sibling(&self.path, &format!(".{i}")))?;
            }
            self.file.take(); // Windows에서도 handle을 닫고 이름을 바꾼다.
            let last = sibling(&self.path, &format!(".{ARCHIVES}"));
            if regular(&last)?.is_some() {
                std::fs::remove_file(last)?;
            }
            for i in (1..ARCHIVES).rev() {
                let from = sibling(&self.path, &format!(".{i}"));
                if regular(&from)?.is_some() {
                    std::fs::rename(from, sibling(&self.path, &format!(".{}", i + 1)))?;
                }
            }
            std::fs::rename(&self.path, sibling(&self.path, ".1"))?;
            let file = open(&self.path, true)?;
            self.file = Some(file);
            self.size = 0;
        }
        let file = self.file.as_mut().expect("opened log");
        // 부분 쓰기 오류가 나도 다음 기록이 용량을 초과하지 않게 실제 크기를 다시 얻는다.
        let result = file.write_all(bytes);
        self.size = file.metadata()?.len();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(log: &FileLog, bytes: &[u8]) {
        log.make_writer().write_all(bytes).unwrap();
    }

    #[test]
    fn large_events_are_bounded_and_the_next_event_is_retained() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("server.log");
        let log = FileLog::open(&path).unwrap();
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .event_format(EventFormat(true))
            .with_writer(log.clone())
            .finish();
        // 큰 원문을 미리 String으로 만들지 않고 fmt::Write로 계속 생성한다.
        struct Large;
        impl std::fmt::Display for Large {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                for _ in 0..EVENT_BYTES {
                    f.write_str("한글")?;
                }
                Ok(())
            }
        }
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(message = %Large);
            tracing::info!("next event");
        });
        let bytes = std::fs::read(&path).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        let lines: Vec<_> = text.split_inclusive('\n').collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].len() <= EVENT_BYTES);
        assert!(lines[0].ends_with(std::str::from_utf8(TRUNCATED).unwrap()));
        assert!(lines[1].ends_with("next event\n"));
        // writer를 직접 잘못 써도 한 이벤트의 파일 상한을 넘기지 않는다.
        assert!(
            log.make_writer()
                .write_all(&vec![b'x'; EVENT_BYTES + 1])
                .is_err()
        );
    }

    #[test]
    fn rotation_keeps_only_four_bounded_files_and_recent_records() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("server.log");
        let unrelated = d.path().join("unrelated.log");
        std::fs::write(&unrelated, b"preserve").unwrap();
        let log = FileLog::open(&path).unwrap();
        // 9MiB 이상 기록해 한 번 이상 모든 보관 slot을 교체한다.
        for n in 0..2304 {
            let mut bytes = format!("record {n:04} ").into_bytes();
            bytes.resize(4095, b'x');
            bytes.push(b'\n');
            record(&log, &bytes);
        }
        drop(log);
        let mut total = 0;
        for i in 0..=ARCHIVES {
            let p = if i == 0 {
                path.clone()
            } else {
                sibling(&path, &format!(".{i}"))
            };
            let bytes = std::fs::read(p).unwrap();
            assert!(bytes.len() as u64 <= FILE_BYTES);
            assert!(!bytes.windows(12).any(|b| b == b"record 0000 "));
            total += bytes.len() as u64;
        }
        assert!(total <= FILE_BYTES * (ARCHIVES + 1) as u64);
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("record 2303 ")
        );
        assert_eq!(std::fs::read(unrelated).unwrap(), b"preserve");
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), ARCHIVES + 3);
    }

    #[test]
    fn startup_trims_sparse_legacy_logs_to_their_tail_and_releases_the_lock() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("server.log");
        for i in 0..=ARCHIVES {
            let p = if i == 0 {
                path.clone()
            } else {
                sibling(&path, &format!(".{i}"))
            };
            let mut f = File::create(p).unwrap();
            f.set_len(1024 * 1024 * 1024).unwrap();
            f.seek(SeekFrom::End(-4)).unwrap();
            f.write_all(b"tail").unwrap();
        }
        let log = FileLog::open(&path).unwrap();
        for i in 0..=ARCHIVES {
            let p = if i == 0 {
                path.clone()
            } else {
                sibling(&path, &format!(".{i}"))
            };
            let bytes = std::fs::read(p).unwrap();
            assert_eq!(bytes.len() as u64, FILE_BYTES);
            assert!(bytes.ends_with(b"tail"));
        }
        assert!(FileLog::open(&path).is_err());
        drop(log);
        let log = FileLog::open(&path).unwrap();
        record(&log, b"reopened\n");
        assert_eq!(std::fs::read(&path).unwrap(), b"reopened\n");
        assert!(
            std::fs::read(sibling(&path, ".1"))
                .unwrap()
                .ends_with(b"tail")
        );
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), ARCHIVES + 2);
    }

    #[test]
    fn interrupted_trim_recovers_only_a_recognized_private_staging_file() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("server.log");
        let original = vec![b'x'; FILE_BYTES as usize + 32];
        std::fs::write(&path, &original).unwrap();
        let stage = sibling(&path, ".grove-tail.tmp");
        std::fs::write(&stage, b"unrelated content").unwrap();
        assert!(FileLog::open(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read(&stage).unwrap(), b"unrelated content");
        // 이 fixture가 소유한 파일을 제품의 중단 형식으로 바꾼다.
        std::fs::remove_file(&stage).unwrap();
        let mut owned = open(&stage, true).unwrap();
        owned.write_all(TRIM_HEADER).unwrap();
        owned.write_all(b"partial tail").unwrap();
        drop(owned);
        let log = FileLog::open(&path).unwrap();
        assert!(!stage.exists());
        assert_eq!(std::fs::metadata(&path).unwrap().len(), FILE_BYTES);
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(TRIM_HEADER));
        assert!(bytes[TRIM_HEADER.len()..].iter().all(|&b| b == b'x'));
        drop(log);
    }

    #[test]
    fn concurrent_events_do_not_interleave() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("server.log");
        let log = FileLog::open(&path).unwrap();
        std::thread::scope(|scope| {
            for n in 0..4 {
                let log = log.clone();
                scope.spawn(move || {
                    for _ in 0..100 {
                        let mut event = log.make_writer();
                        for _ in 0..20 {
                            write!(event, "{n}").unwrap();
                        }
                        writeln!(event).unwrap();
                    }
                });
            }
        });
        let text = std::fs::read_to_string(path).unwrap();
        assert_eq!(text.lines().count(), 400);
        assert!(
            text.lines()
                .all(|line| line.len() == 20 && line.bytes().all(|b| b == line.as_bytes()[0]))
        );
    }

    #[test]
    fn unsafe_archive_fails_before_rotation_and_can_be_retried() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("server.log");
        std::fs::write(&path, vec![b'x'; FILE_BYTES as usize]).unwrap();
        let log = FileLog::open(&path).unwrap();
        let bad = sibling(&path, ".2");
        std::fs::create_dir(&bad).unwrap();
        assert!(log.make_writer().write_all(b"next\n").is_err());
        assert_eq!(std::fs::metadata(&path).unwrap().len(), FILE_BYTES);
        assert!(!sibling(&path, ".1").exists());
        std::fs::remove_dir(bad).unwrap();
        record(&log, b"next\n");
        assert_eq!(std::fs::read(&path).unwrap(), b"next\n");
        assert_eq!(
            std::fs::metadata(sibling(&path, ".1")).unwrap().len(),
            FILE_BYTES
        );
    }

    #[cfg(unix)]
    #[test]
    fn links_and_special_files_are_rejected_and_logs_are_private() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("target");
        std::fs::write(&target, b"preserve").unwrap();
        let path = d.path().join("server.log");
        symlink(&target, &path).unwrap();
        assert!(FileLog::open(&path).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::hard_link(&target, &path).unwrap();
        assert!(FileLog::open(&path).is_err());
        std::fs::remove_file(&path).unwrap();
        let fifo = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(FileLog::open(&path).is_err());
        std::fs::remove_file(&path).unwrap();
        let log = FileLog::open(&path).unwrap();
        record(&log, b"private\n");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(std::fs::read(target).unwrap(), b"preserve");
        let dir = d.path().join("linked-dir");
        symlink(d.path(), &dir).unwrap();
        assert!(FileLog::open(&dir.join("other.log")).is_err());
    }
}

struct EventWriter<'a> {
    log: MutexGuard<'a, Rolling>,
    remaining: usize,
}

impl<'a> MakeWriter<'a> for FileLog {
    type Writer = EventWriter<'a>;
    fn make_writer(&'a self) -> Self::Writer {
        EventWriter {
            log: self.0.lock().expect("log mutex"),
            remaining: EVENT_BYTES,
        }
    }
}

impl Write for EventWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.remaining {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "로그 이벤트 상한 초과",
            ));
        }
        self.log.write(bytes)?;
        self.remaining -= bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        if let Some(file) = self.log.file.as_mut() {
            file.flush()?;
        }
        Ok(())
    }
}
