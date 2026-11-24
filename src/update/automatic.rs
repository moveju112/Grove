//! 설치된 데몬만 검사한다. 실제 전환은 서비스가 정지해도 살아 있는 별도 프로세스가 맡는다.
use super::*;
use crate::config::Config;
use std::process::Stdio;

pub fn managed_install(cfg: &Config) -> Option<Install> {
    let exe = std::env::current_exe().ok()?;
    let releases = exe.parent()?.parent()?;
    if releases.file_name()? != "releases" { return None; }
    let inst = Install { root: releases.parent()?.to_owned() };
    let installed = inst.cfg().ok()?;
    let current = inst.pointer("current")?;
    if inst.release_dir(&current).join(exe_name()) != exe
        || installed.data_dir.canonicalize().ok()? != cfg.data_dir.canonicalize().ok()? { return None; }
    if installed.listen.parse::<std::net::SocketAddr>().ok()? != cfg.listen {
        return None;
    }
    Some(inst)
}

pub(super) struct Attempt {
    pid: u32,
    preferences: UpdateSettings,
}

impl Attempt {
    fn preferences(inst: &Install) -> Result<UpdateSettings, String> {
        let db = rusqlite::Connection::open_with_flags(inst.cfg()?.data_dir.join("grove.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
        settings(&db).map_err(|e| e.message)
    }

    pub(super) fn validate(&self, inst: &Install) -> Result<(), String> {
        let cfg = inst.cfg()?;
        let lock = std::fs::File::open(cfg.data_dir.join("grove.lock")).map_err(|e| e.to_string())?;
        if !matches!(lock.try_lock_shared(), Err(std::fs::TryLockError::WouldBlock))
            || std::fs::read_to_string(cfg.data_dir.join("grove.lock")).ok().and_then(|s| s.parse().ok()) != Some(self.pid)
            || Self::preferences(inst)?.revision != self.preferences.revision
            || !health(inst).is_some_and(|h| h["status"] == "ready" && h["version"] == crate::VERSION) {
            return Err("자동 업데이트를 요청한 데몬 또는 설정이 변경되었습니다".into());
        }
        Ok(())
    }

    pub(super) fn accept_cutover(&self, inst: &Install, seq: i64) -> Result<bool, String> {
        self.validate(inst)?;
        let url = format!("{}/admin/shutdown-if-idle?pid={}&revision={}&snapshot_seq={seq}",
            inst.base_url()?, self.pid, self.preferences.revision);
        match http(Some(inst), "POST", &url, Some(&inst.token()?))?.0 {
            202 => Ok(true),
            409 => Ok(false),
            status => Err(format!("유휴 종료 요청 실패: HTTP {status}")),
        }
    }

    pub(super) fn eligible(&self, current: &str, release: &Release) -> Result<bool, String> {
        if release.channel != self.preferences.channel.name() {
            return Err("선택한 업데이트 채널과 manifest 채널이 다릅니다".into());
        }
        fn core(version: &str) -> impl Iterator<Item = &str> {
            version.split(['-', '+']).next().unwrap_or(version).split('.')
        }
        let levels = if matches!(self.preferences.auto_apply, AutoApplyScope::Patch) { 2 } else { 1 };
        Ok(cmp_version(&release.version, current).is_gt() && core(&release.version).take(levels).eq(core(current).take(levels))
            && release.artifacts.contains_key(platform()))
    }
}

pub fn run_automatic(root: &Path, source: &str, pid: u32, revision: i64) -> Result<Value, String> {
    let inst = Install { root: root.to_owned() };
    if inst.state().state == "needs_attention" { return Err("업데이트 복구가 필요합니다".into()); }
    let preferences = Attempt::preferences(&inst)?;
    if preferences.revision != revision { return Err("업데이트 설정이 변경되었습니다".into()); }
    apply_inner(root, source, &ApplyOpts { force: false, allow_downgrade: false, ready_timeout: Duration::from_secs(60) },
        Some(&Attempt { pid, preferences }))
}

async fn tick(app: &crate::App, inst: &Install) -> Result<bool, String> {
    let preferences = app.db.call(|db| settings(db)).await.map_err(|e| e.message)?;
    let source = if let Some(path) = &app.cfg.release_mirror {
        let mirror: SettingsSource = read_json(path)?;
        let manifest = mirror.manifests.get(preferences.channel.name()).filter(|p| p.is_absolute())
            .ok_or("로컬 채널 manifest가 없습니다")?;
        manifest.to_str().ok_or("manifest 경로가 올바르지 않습니다")?.to_owned()
    } else {
        release_url(&release_client()?, preferences.channel).await?
    };
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let cfg = inst.cfg()?;
    let mut command = if cfg.service.starts_with("systemd-user:") {
        let mut command = tokio::process::Command::new("systemd-run");
        command.args(["--user", "--collect", "--quiet", "--wait", "--property=UMask=0077", "--"]).arg(exe);
        command
    } else if matches!(cfg.service.as_str(), "process" | "foreground") {
        let mut command = tokio::process::Command::new(exe);
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        command.creation_flags(0x0000_0008 | 0x0000_0200);
        command
    } else {
        return Err("지원하지 않는 설치 서비스입니다".into());
    };
    let status = command.args(["update", "auto-apply"]).arg(std::process::id().to_string())
        .arg(preferences.revision.to_string()).arg("--install").arg(&inst.root).arg("--manifest").arg(source)
        .stdin(Stdio::null()).stdout(Stdio::null()).status().await.map_err(|e| e.to_string())?;
    if status.code() == Some(3) { return Ok(true); }
    if !status.success() { return Err(format!("자동 업데이트 작업 종료 상태 {status}")); }
    Ok(false)
}

pub async fn schedule_automatic(app: crate::App, inst: Install) {
    let mut delay = Duration::from_secs(30);
    loop {
        tokio::time::sleep(delay).await;
        delay = match tick(&app, &inst).await {
            Ok(true) => Duration::from_secs(60),
            Ok(false) => Duration::from_secs(30 * 60),
            Err(error) => {
                tracing::warn!(%error, "데몬 자동 업데이트 확인 실패");
                Duration::from_secs(30 * 60)
            }
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn respects_channel_scope_and_platform() {
        let mut attempt = Attempt { pid: 1, preferences: UpdateSettings::default() };
        let mut release: Release = serde_json::from_value(json!({
            "product": "grove", "version": "1.3.0", "channel": "stable", "protocol": 1, "schema": 1,
            "issued_at": "", "artifacts": { platform(): { "url": "fixture", "sha256": "0".repeat(64), "size": 1 } }
        })).unwrap();
        assert!(attempt.eligible("1.2.0", &release).unwrap());
        assert!(!attempt.eligible("0.9.0", &release).unwrap());
        attempt.preferences.auto_apply = AutoApplyScope::Patch;
        assert!(!attempt.eligible("1.2.0", &release).unwrap());
        release.version = "1.2.4".into();
        assert!(attempt.eligible("1.2.3", &release).unwrap());
        assert!(!attempt.eligible("1.2.4", &release).unwrap());
        assert!(!attempt.eligible("1.2.5", &release).unwrap());
        release.channel = "beta".into();
        assert!(attempt.eligible("1.2.3", &release).is_err());
        attempt.preferences.channel = UpdateChannel::Beta;
        release.artifacts.clear();
        assert!(!attempt.eligible("1.2.3", &release).unwrap());
    }
}
