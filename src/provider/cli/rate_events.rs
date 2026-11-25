//! Passive, versioned usage export for local consumers. Never persist the CLI envelope.
use crate::util::{Clock, SystemClock};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::{self, BufReader, Read},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

const MAX_SNAPSHOT: u64 = 16 * 1024;
static WRITE: Mutex<()> = Mutex::new(());

#[derive(Default, Deserialize, Serialize)]
struct Windows {
    #[serde(skip_serializing_if = "Option::is_none")]
    five_hour: Option<Reading>,
    #[serde(skip_serializing_if = "Option::is_none")]
    seven_day: Option<Reading>,
}
#[derive(Deserialize, Serialize)]
struct Reading {
    used_percent: f64,
    resets_at: Option<u64>,
    received_at: f64,
}
#[derive(Deserialize, Serialize)]
struct Snapshot {
    version: u8,
    account: Option<String>,
    windows: Windows,
}

#[derive(Deserialize)]
struct Profile {
    #[serde(rename = "oauthAccount")]
    account: Account,
}
#[derive(Deserialize)]
struct Account {
    #[serde(rename = "accountUuid")]
    uuid: String,
}

#[derive(Clone)]
pub(super) struct Export {
    path: PathBuf,
    account: Option<String>,
    pending: Arc<Mutex<Option<Windows>>>,
}

impl Windows {
    fn merge(&mut self, weekly: bool, mut reading: Reading) -> bool {
        let slot = if weekly {
            &mut self.seven_day
        } else {
            &mut self.five_hour
        };
        if let Some(old) = slot {
            if old.received_at >= reading.received_at {
                return false;
            }
            if reading.resets_at.is_none() {
                reading.resets_at = old.resets_at.filter(|t| *t as f64 > reading.received_at);
            }
        }
        *slot = Some(reading);
        true
    }
    fn absorb(&mut self, other: Windows) -> bool {
        let hour = other.five_hour.is_some_and(|row| self.merge(false, row));
        let week = other.seven_day.is_some_and(|row| self.merge(true, row));
        hour || week
    }
    fn latest(&self) -> Option<f64> {
        [&self.five_hour, &self.seven_day]
            .into_iter()
            .flatten()
            .map(|w| w.received_at)
            .reduce(f64::max)
    }
}

impl Export {
    pub(super) async fn new(data_dir: Option<&Path>) -> Option<Self> {
        let path = data_dir?.join("usage/v1/claude.json");
        let account = tokio::task::spawn_blocking(Self::account_id)
            .await
            .ok()
            .flatten();
        Some(Self {
            path,
            account,
            pending: Arc::default(),
        })
    }

    fn account_id() -> Option<String> {
        let root =
            crate::source_settings::user_root(crate::source_settings::SourceId::ClaudeUser, |k| {
                std::env::var_os(k)
            });
        root.and_then(|root| {
            let mut path = root.join(".claude.json");
            if !path.is_file() && root.file_name()? == ".claude" {
                let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
                if root.parent()? == Path::new(&home) {
                    path = Path::new(&home).join(".claude.json");
                }
            }
            let profile: Profile = serde_json::from_reader(
                BufReader::new(fs::File::open(path).ok()?).take(16 * 1024 * 1024),
            )
            .ok()?;
            let id = profile.account.uuid.trim();
            (!id.is_empty())
                .then(|| crate::util::sha256_hex(format!("claude-account-v1/{id}").as_bytes()))
        })
    }

    pub(super) fn turn(export: Option<&Self>) -> Turn {
        if let Some(export) = export {
            *export.pending.lock().expect("usage buffer") = Some(Windows::default());
        }
        Turn(export.cloned())
    }

    pub(super) async fn observe(&self, event: &Value) {
        if event["type"] != "rate_limit_event" {
            return;
        }
        let info = &event["rate_limit_info"];
        let received_at = SystemClock.now().unix_timestamp_nanos() as f64 / 1e9;
        // 정상 상태의 기간별 값은 unifiedWindows에만 온다. 최상위 값은 경고·거절 때 그 기간 하나만 가리킨다.
        let read = |key: &str| {
            Self::reading(&info["unifiedWindows"][key], received_at).or_else(|| {
                (info["rateLimitType"] == key)
                    .then(|| Self::reading(info, received_at))
                    .flatten()
            })
        };
        let updates = Windows {
            five_hour: read("five_hour"),
            seven_day: read("seven_day"),
        };
        if let Some(buffer) = self.pending.lock().expect("usage buffer").as_mut() {
            buffer.absorb(updates);
            return;
        }
        if let Some(write) = self.write(updates) {
            let _ = write.await;
        }
    }

    fn reading(row: &Value, received_at: f64) -> Option<Reading> {
        let fraction = row["utilization"]
            .as_f64()
            .filter(|v| (0.0..=1.0).contains(v))?;
        let resets_at = match &row["resetsAt"] {
            Value::Null => None,
            n => Some(n.as_u64().filter(|n| *n > 0 && *n < 253402300800)?),
        };
        Some(Reading {
            used_percent: fraction * 100.0,
            resets_at,
            received_at,
        })
    }

    fn write(&self, updates: Windows) -> Option<tokio::task::JoinHandle<()>> {
        updates.latest()?;
        let export = self.clone();
        Some(tokio::task::spawn_blocking(move || {
            if export.store(updates).is_err() {
                tracing::warn!("Claude 사용량 스냅샷을 저장하지 못했습니다");
            }
        }))
    }

    fn store(&self, updates: Windows) -> io::Result<()> {
        let _guard = WRITE.lock().map_err(|_| io::Error::other("usage lock"))?;
        let dir = self.path.parent().expect("snapshot parent");
        fs::create_dir_all(dir)?;
        let mut snapshot = Snapshot {
            version: 1,
            account: self.account.clone(),
            windows: Windows::default(),
        };
        match fs::File::open(&self.path) {
            Ok(file) => {
                match serde_json::from_reader::<_, Value>(file.take(MAX_SNAPSHOT)) {
                    Ok(old) if old.get("version").is_some_and(|v| v != 1) => {
                        return Err(io::Error::other("unknown usage schema"));
                    }
                    Ok(old) => {
                        if let Ok(old) = serde_json::from_value::<Snapshot>(old) {
                            if old.account == self.account {
                                snapshot = old;
                            } else if old.windows.latest() >= updates.latest()
                                || Self::account_id() != self.account
                            {
                                return Ok(());
                            }
                        }
                    }
                    Err(error) if error.is_io() => return Err(error.into()),
                    // A truncated v1 snapshot can be rebuilt from the next actual observation.
                    Err(_) => {}
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        if !snapshot.windows.absorb(updates) {
            return Ok(());
        }
        let mut temp = tempfile::NamedTempFile::new_in(dir)?;
        serde_json::to_writer(&mut temp, &snapshot)?;
        temp.persist(&self.path)?;
        Ok(())
    }
}

pub(super) struct Turn(Option<Export>);
impl Turn {
    fn flush(&mut self) -> Option<tokio::task::JoinHandle<()>> {
        let export = self.0.take()?;
        let updates = export.pending.lock().expect("usage buffer").take()?;
        export.write(updates)
    }
    pub(super) async fn finish(mut self) {
        if let Some(write) = self.flush() {
            let _ = write.await;
        }
    }
}
impl Drop for Turn {
    fn drop(&mut self) {
        drop(self.flush());
    }
}

// A reusable CLI can emit its limit *after* result, while its turn reader is parked.
// Pass partial lines through immediately so the existing partial-result timeout stays intact.
pub(super) fn observe_stdout<R: AsyncRead + Unpin + Send + 'static>(
    mut source: R,
    export: Option<Export>,
) -> Box<dyn AsyncRead + Unpin + Send> {
    let Some(export) = export else {
        return Box::new(source);
    };
    let (reader, mut writer) = tokio::io::duplex(65536);
    tokio::spawn(async move {
        let mut chunk = [0; 8192];
        let mut line = Vec::new();
        let mut oversize = false;
        while let Ok(n) = source.read(&mut chunk).await {
            if n == 0 {
                break;
            }
            for part in chunk[..n].split_inclusive(|&b| b == b'\n') {
                if !oversize && line.len() + part.len() <= MAX_SNAPSHOT as usize {
                    line.extend_from_slice(part);
                } else {
                    oversize = true;
                }
                if part.ends_with(b"\n") {
                    if !oversize
                        && std::str::from_utf8(&line)
                            .is_ok_and(|s| s.contains("\"rate_limit_event\""))
                        && let Ok(event) = serde_json::from_slice(&line)
                    {
                        export.observe(&event).await;
                    }
                    line.clear();
                    oversize = false;
                }
            }
            if writer.write_all(&chunk[..n]).await.is_err() {
                break;
            }
        }
    });
    Box::new(reader)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(kind: &str, amount: Value) -> Value {
        json!({"type":"rate_limit_event","rate_limit_info":{"rateLimitType":kind,"utilization":amount,
              "resetsAt":2100000000,"unrelated":"discard-me"},"session_id":"discard-me"})
    }

    fn sample(dir: &Path) -> Export {
        Export {
            path: dir.join("usage/v1/claude.json"),
            account: Some("sample".into()),
            pending: Arc::default(),
        }
    }

    // Claude Code 2.1.332는 정상 상태에서 기간별 사용률을 unifiedWindows에만 담는다.
    #[tokio::test]
    async fn allowed_event_exports_each_unified_window() {
        let dir = tempfile::tempdir().unwrap();
        let export = sample(dir.path());
        let saved = || serde_json::from_slice::<Value>(&fs::read(&export.path).unwrap()).unwrap();
        export.observe(&json!({"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":2100000000u64,
            "unifiedWindows":{"five_hour":{"utilization":0.25,"resetsAt":2100000000u64,"status":"allowed"},
                              "seven_day":{"utilization":0,"resetsAt":2100500000u64}}}})).await;
        let first = saved();
        assert_eq!(first["windows"]["five_hour"]["used_percent"], 25.0);
        assert_eq!(first["windows"]["five_hour"]["resets_at"], 2100000000u64);
        assert_eq!(first["windows"]["seven_day"]["used_percent"], 0.0);
        assert_eq!(first["windows"]["seven_day"]["resets_at"], 2100500000u64);
        // 경고 이벤트: 기간별 값이 있으면 그 값을, 없으면 최상위가 가리키는 기간만 읽는다.
        export.observe(&json!({"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning",
            "rateLimitType":"seven_day","utilization":0.75,"resetsAt":2100500000u64,
            "unifiedWindows":{"five_hour":{"utilization":0.5,"resetsAt":2100000000u64},"seven_day":{"utilization":7}}}})).await;
        let next = saved();
        assert_eq!(next["windows"]["five_hour"]["used_percent"], 50.0);
        assert_eq!(next["windows"]["seven_day"]["used_percent"], 75.0);
        assert_eq!(next["windows"]["seven_day"]["resets_at"], 2100500000u64);
    }

    #[tokio::test]
    async fn snapshot_is_private_bounded_and_tracks_independent_event_times() {
        let dir = tempfile::tempdir().unwrap();
        let export = sample(dir.path());
        let saved = || serde_json::from_slice::<Value>(&fs::read(&export.path).unwrap()).unwrap();
        let turn = Export::turn(Some(&export));
        export.observe(&event("five_hour", json!(0.125))).await;
        export.observe(&event("seven_day", json!(0.82))).await;
        assert!(!export.path.exists());
        turn.finish().await;
        let first = saved();
        assert_eq!(first["windows"]["five_hour"]["used_percent"], 12.5);
        assert_eq!(first["windows"]["five_hour"]["resets_at"], 2100000000);
        assert_eq!(first["windows"]["seven_day"]["used_percent"], 82.0);
        assert!(!first.to_string().contains("discard-me"));
        let next = Export::turn(Some(&export));
        for e in [
            event("five_hour", Value::Null),
            event("seven_day_opus", json!(1)),
            event("five_hour", json!(110)),
        ] {
            export.observe(&e).await;
        }
        next.finish().await;
        assert_eq!(first, saved());
        export.observe(&event("five_hour", json!(0))).await;
        let last = saved();
        assert_eq!(last["windows"]["five_hour"]["used_percent"], 0.0);
        assert_eq!(last["windows"]["seven_day"], first["windows"]["seven_day"]);
        assert_eq!(
            fs::read_dir(export.path.parent().unwrap()).unwrap().count(),
            1
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&export.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let mut old = Windows::default();
        old.merge(
            false,
            Reading {
                used_percent: 98.0,
                resets_at: None,
                received_at: 1.0,
            },
        );
        export.store(old).unwrap();
        assert_eq!(saved(), last);
    }
}
