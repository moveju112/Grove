//! 배포 패키지의 foreground 진입점. /usr와 압축 해제 원본은 패키지 관리자의 소유다.
//! 실행 버전만 사용자 설치에 보관하고, 업데이트 사이에도 같은 터미널·서비스 PID를 유지한다.
use super::*;
use crate::config::Config;
use crate::server::{Shutdown, Signals};
use std::fs::{File, OpenOptions};
use std::process::ExitStatus;

pub fn package_directory() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    if let Some(releases) = dir.parent()
        && releases.file_name().is_some_and(|p| p == "releases")
        && releases.parent()?.join("install.json").is_file() {
        return None;
    }
    (dir.join("manifest.json").is_file() && dir.join(exe_name()) == exe).then(|| dir.to_owned())
}

/// 포트 0으로 시작한 foreground 데몬은 최초 배정된 주소를 재시작에도 사용한다.
pub(crate) fn bound_address(cfg: &Config, bound: std::net::SocketAddr) -> Result<(), String> {
    if cfg.listen.port() != 0 { return Ok(()); }
    if let Some(inst) = managed_install(cfg) {
        let mut installed = inst.cfg()?;
        if installed.service == "foreground" {
            installed.listen = bound.to_string();
            write_atomic(&inst.root.join("install.json"), &serde_json::to_vec(&installed).map_err(|e| e.to_string())?)?;
        }
    }
    Ok(())
}

fn lock_file(path: &Path) -> Result<File, String> {
    OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path).map_err(|e| e.to_string())
}

fn held(file: &File) -> Result<bool, String> {
    match file.try_lock_shared() {
        Ok(()) => { file.unlock().map_err(|e| e.to_string())?; Ok(false) }
        Err(std::fs::TryLockError::WouldBlock) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

pub(super) fn request_start(inst: &Install, release: &str) -> Result<(), String> {
    if !held(&lock_file(&inst.root.join("foreground.lock"))?)? {
        return Err("foreground 데몬이 종료되었습니다".into());
    }
    write_atomic(&inst.root.join("foreground-start"), release.as_bytes())
}

fn seed(inst: &Install, bundle: &Path) -> Result<(), String> {
    let manifest_path = bundle.join("manifest.json");
    let manifest: Value = read_json(&manifest_path)?;
    if manifest["product"] != "grove" || manifest["version"] != crate::VERSION {
        return Err("실행 파일과 배포 manifest 버전이 일치하지 않습니다".into());
    }
    if inst.state().state == "needs_attention" {
        return Err("업데이트 복구가 필요합니다. 설치 상태와 snapshot을 확인하세요".into());
    }
    if let Some(current) = inst.pointer("current") {
        let installed = inst.release_manifest(&current)?;
        let current_version = installed["version"].as_str().ok_or("현재 버전 정보가 없습니다")?;
        if !cmp_version(crate::VERSION, current_version).is_gt() { return Ok(()); }
    }
    let releases = inst.root.join("releases");
    std::fs::create_dir_all(&releases).map_err(|e| e.to_string())?;
    let id = format!("{}-bundle-{}", crate::VERSION, &file_digest(&manifest_path)?.0[..12]);
    if !inst.release_dir(&id).is_dir() {
        let stage = tempfile::tempdir_in(&releases).map_err(|e| e.to_string())?;
        let files = manifest["files"].as_array().ok_or("manifest files 없음")?;
        for entry in files {
            let rel = Path::new(entry["path"].as_str().ok_or("파일 경로 없음")?);
            if !rel.components().all(|c| matches!(c, std::path::Component::Normal(_))) {
                return Err("잘못된 패키지 경로입니다".into());
            }
            let dst = stage.path().join(rel);
            std::fs::create_dir_all(dst.parent().ok_or("파일 경로 없음")?).map_err(|e| e.to_string())?;
            std::fs::copy(bundle.join(rel), dst).map_err(|e| e.to_string())?;
        }
        verify_package_files(stage.path(), files, 4)?;
        std::fs::copy(manifest_path, stage.path().join("manifest.json")).map_err(|e| e.to_string())?;
        std::fs::rename(stage.path(), inst.release_dir(&id)).map_err(|e| e.to_string())?;
    }
    if !inst.root.join("trusted-keys.json").exists() { inst.save_trust(&Trust::default())?; }
    inst.set_pointer("current", &id)
}

pub fn serve(bundle: &Path, cfg: &Config) -> Result<i32, String> {
    std::fs::create_dir_all(&cfg.data_dir).map_err(|e| e.to_string())?;
    let data = cfg.data_dir.canonicalize().map_err(|e| e.to_string())?;
    // 사용자에게서 전달받은 프로젝트·DB 안의 파일을 실행하지 않는다.
    #[cfg(not(windows))]
    let base = std::env::var_os("XDG_STATE_HOME").map(PathBuf::from).filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from).filter(|p| p.is_absolute()).map(|p| p.join(".local/state")))
        .map(|p| p.join("grove")).ok_or("사용자 설치 경로가 없습니다")?;
    #[cfg(windows)]
    let base = crate::config::default_data_dir().ok_or("사용자 설치 경로가 없습니다")?;
    let key = crate::util::sha256_hex(data.as_os_str().as_encoded_bytes());
    let root = base.join("daemon-runtimes").join(key);
    let mut dirs = std::fs::DirBuilder::new();
    dirs.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        dirs.mode(0o700);
    }
    #[cfg(unix)]
    for parent in root.ancestors() {
        use std::os::unix::fs::MetadataExt;
        let metadata = match parent.symlink_metadata() {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        };
        let uid = metadata.uid();
        let sticky_root = uid == 0 && metadata.mode() & libc::S_ISVTX as u32 != 0;
        if !metadata.is_dir() || (uid != unsafe { libc::geteuid() } && uid != 0)
            || (metadata.mode() & 0o022 != 0 && !sticky_root) {
            return Err(format!("실행 사본의 경로 소유권 또는 권한을 확인하세요: {}", parent.display()));
        }
    }
    dirs.create(&root).map_err(|e| e.to_string())?;
    let owner = lock_file(&root.join("foreground.lock"))?;
    if let Err(e) = owner.try_lock() {
        if matches!(e, std::fs::TryLockError::WouldBlock) {
            let error = crate::startup::StartupError::new(crate::startup::FailureKind::AlreadyRunning, Some(&cfg.data_dir));
            if std::env::args_os().any(|arg| arg == "--json") { println!("{}", error.report(Some(cfg))); }
            else { eprintln!("시작 실패: {error}"); }
            return Ok(error.exit_code());
        }
        return Err(e.to_string());
    }
    let update_lock = lock_file(&root.join("update.lock"))?;
    update_lock.try_lock().map_err(|_| "업데이트 전환이 진행 중입니다")?;
    let inst = Install { root };
    seed(&inst, bundle)?;
    let installed = InstallCfg { data_dir: data, listen: cfg.listen.to_string(), service: "foreground".into() };
    write_atomic(&inst.root.join("install.json"), &serde_json::to_vec(&installed).map_err(|e| e.to_string())?)?;
    let request = inst.root.join("foreground-start");
    if request.exists() { std::fs::remove_file(&request).map_err(|e| e.to_string())?; }
    update_lock.unlock().map_err(|e| e.to_string())?;
    tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?
        .block_on(supervise(&inst, update_lock, request))
}

async fn supervise(inst: &Install, update_lock: File, request: PathBuf) -> Result<i32, String> {
    let mut signals = Signals::new();
    loop {
        let id = inst.pointer("current").ok_or("현재 릴리즈가 없습니다")?;
        let mut cmd = tokio::process::Command::new(inst.release_dir(&id).join(exe_name()));
        cmd.args(std::env::args_os().skip(1)).arg("--listen").arg(inst.cfg()?.listen).kill_on_drop(true);
        // 배포 검사·launcher가 원본 web을 지정했어도 새 버전은 같은 패키지의 web을 사용한다.
        if let Some(web) = std::env::var_os("GROVE_WEB_DIR").and_then(|p| PathBuf::from(p).canonicalize().ok())
            && package_directory().is_some_and(|p| p.join("web").canonicalize().is_ok_and(|bundled| bundled == web)) {
            cmd.env("GROVE_WEB_DIR", inst.release_dir(&id).join("web"));
        }
        #[cfg(unix)]
        cmd.process_group(0);
        #[cfg(target_os = "linux")]
        {
            let parent = std::process::id();
            // SIGKILL 등으로 launcher가 사라져도 별도 서버가 남지 않는다.
            unsafe { cmd.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 { return Err(std::io::Error::last_os_error()); }
                if libc::getppid() as u32 != parent { return Err(std::io::Error::other("launcher exited")); }
                Ok(())
            }); }
        }
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let status = tokio::select! {
            s = child.wait() => s.map_err(|e| e.to_string())?,
            signal = signals.next() => {
                stop_child(&mut child, signal).await?;
                return Ok(0);
            }
        };
        // 일반 종료는 즉시 그대로 전달한다. 실제 업데이트 잠금 아래에서만 다음 기동을 기다린다.
        loop {
            if request.is_file() {
                let wanted = std::fs::read_to_string(&request).map_err(|e| e.to_string())?;
                std::fs::remove_file(&request).map_err(|e| e.to_string())?;
                if Some(wanted) != inst.pointer("current") { return Err("실행 요청과 현재 릴리즈가 다릅니다".into()); }
                break;
            }
            if !held(&update_lock)? || inst.state().state != "applying" {
                return Ok(exit_code(status));
            }
            tokio::select! {
                _ = signals.next() => return Ok(0),
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
        }
    }
}

fn exit_code(status: ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() { return 128 + signal; }
    }
    status.code().unwrap_or(1)
}

async fn stop_child(child: &mut tokio::process::Child, signal: Shutdown) -> Result<(), String> {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let sig = match signal { Shutdown::Interrupt => libc::SIGINT, Shutdown::Terminate => libc::SIGTERM, Shutdown::ConsoleClosed => libc::SIGHUP };
        // PID는 아직 wait하지 않은 이 launcher의 자식이다.
        unsafe { libc::kill(pid as i32, sig); }
    }
    #[cfg(windows)]
    let _ = signal; // 콘솔 이벤트는 같은 콘솔에 연결한 자식에게도 전달된다.
    if tokio::time::timeout(Duration::from_secs(65), child.wait()).await.is_err() {
        child.kill().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}
