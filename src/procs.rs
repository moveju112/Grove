//! 서버가 띄운 외부 프로세스 트리의 소유권과 정리(EXEC-010, SEC-014~016).
//!
//! - 모든 소유 프로세스는 실행마다 고유한 표식 환경변수(`GROVE_TASK_ID`)를 물려받는다.
//! - Linux: 셸을 새 process group의 leader로 띄운다. 정리할 때는 leader가 아직 회수되지 않았으면 그룹 전체를,
//!   회수된 뒤에는 "표식이 일치하는 구성원이 남아 있는 그룹"만 종료한다. 비어 있는 그룹 번호가
//!   다른 프로세스에 재사용됐을 때 남의 그룹을 죽이지 않기 위해서다(SEC-016).
//! - Windows: 실행마다 Job Object(`KILL_ON_JOB_CLOSE`)를 만들고 일시정지 상태로 띄운 프로세스를 넣은 뒤 재개한다.
//!   자손은 자동으로 같은 Job에 들어가고, 서버가 비정상 종료해 handle이 닫히면 OS가 트리 전체를 끝낸다.
//!   Job에 넣지 못하면 실행을 거부한다(SEC-015).

/// 소유 프로세스와 자손이 물려받는 실행 표식.
pub const OWNER_ENV: &str = "GROVE_TASK_ID";

/// 자원 한도(SEC-017). 0은 제한 없음.
/// Linux: 프로세스마다 주소 공간(`RLIMIT_AS`)·CPU 시간(`RLIMIT_CPU`, 초과 시 SIGXCPU 뒤 SIGKILL).
/// Windows: Job 전체(트리 합계)의 메모리·사용자 CPU 시간.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Limits {
    pub memory_mb: u64,
    pub cpu_seconds: u64,
}

impl Limits {
    pub fn from_json(v: &serde_json::Value) -> Self {
        Limits { memory_mb: v["memory_mb"].as_u64().unwrap_or(0), cpu_seconds: v["cpu_seconds"].as_u64().unwrap_or(0) }
    }
    pub fn to_json(self) -> serde_json::Value {
        serde_json::json!({ "memory_mb": self.memory_mb, "cpu_seconds": self.cpu_seconds })
    }
    /// 범위별 설정(`exec.max_memory_mb`·`exec.max_cpu_seconds`)의 실제 적용값.
    pub fn effective(c: &rusqlite::Connection, project: Option<&str>, session: Option<&str>) -> crate::error::ApiResult<Self> {
        let get = |k: &str| -> crate::error::ApiResult<u64> { Ok(crate::settings::effective(c, k, project, session)?.as_u64().unwrap_or(0)) };
        Ok(Limits { memory_mb: get("exec.max_memory_mb")?, cpu_seconds: get("exec.max_cpu_seconds")? })
    }
}

/// 실행 전 준비: 표식·새 process group·자원 한도(Linux), 일시정지 생성(Windows; 한도는 `adopt`의 Job에 건다).
pub fn prepare(cmd: &mut tokio::process::Command, tag: &str, limits: Limits) {
    cmd.env(OWNER_ENV, tag);
    #[cfg(unix)]
    {
        cmd.process_group(0);
        if limits != Limits::default() {
            // SAFETY: fork 뒤 exec 전에는 async-signal-safe 함수(setrlimit)만 호출한다.
            unsafe {
                cmd.pre_exec(move || {
                    let set = |res, soft: u64, hard: u64| {
                        let r = libc::rlimit { rlim_cur: soft as libc::rlim_t, rlim_max: hard as libc::rlim_t };
                        if libc::setrlimit(res, &r) != 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
                    };
                    if limits.memory_mb > 0 {
                        let b = limits.memory_mb.saturating_mul(1024 * 1024);
                        set(libc::RLIMIT_AS, b, b)?;
                    }
                    if limits.cpu_seconds > 0 {
                        // soft 초과 시 SIGXCPU, 5초 뒤 hard에서 SIGKILL.
                        set(libc::RLIMIT_CPU, limits.cpu_seconds, limits.cpu_seconds + 5)?;
                    }
                    Ok(())
                });
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = limits;
        cmd.creation_flags(windows::CREATE_SUSPENDED | windows::CREATE_NEW_PROCESS_GROUP);
    }
}

/// 시작한 프로세스 트리의 소유권. Windows에서는 drop하면 남은 트리가 함께 끝난다.
pub struct Owned {
    pid: u32,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    tag: String,
    #[cfg(windows)]
    job: windows::Job,
}

/// 시작 직후 소유권을 확보한다. 실패하면 프로세스를 끝내고 오류를 돌려준다(격리 없는 실행 금지, SEC-015).
pub fn adopt(child: &mut tokio::process::Child, tag: &str, limits: Limits) -> Result<Owned, String> {
    let Some(pid) = child.id() else {
        return Err("프로세스가 시작 직후 끝났습니다".into());
    };
    #[cfg(windows)]
    {
        let job = match windows::Job::new(limits).and_then(|j| j.assign_and_resume(pid).map(|_| j)) {
            Ok(j) => j,
            Err(e) => {
                let _ = child.start_kill();
                return Err(format!("프로세스 격리(Job Object) 실패로 실행하지 않았습니다: {e}"));
            }
        };
        Ok(Owned { pid, tag: tag.to_string(), job })
    }
    #[cfg(not(windows))]
    {
        let _ = (child, limits);
        Ok(Owned { pid, tag: tag.to_string() })
    }
}

impl Owned {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// 트리 전체를 종료한다. `leader_alive`는 leader가 아직 회수(wait)되지 않았다는 뜻이다.
    pub fn kill_tree(&self, leader_alive: bool) {
        #[cfg(windows)]
        {
            let _ = leader_alive;
            self.job.terminate();
        }
        #[cfg(unix)]
        {
            if leader_alive {
                // SAFETY: 회수되지 않은 leader의 pid는 재사용될 수 없으므로 우리 그룹이다.
                unsafe {
                    libc::kill(-(self.pid as i32), libc::SIGKILL);
                }
            }
            #[cfg(target_os = "linux")]
            linux::kill_group_if_ours(self.pid as i32, &self.tag);
        }
    }
}

/// 이전 서버가 비정상 종료해 남은 프로세스를 표식으로 찾아 종료하고 표식별 종료 개수를 돌려준다.
/// 표식이 일치하면 그룹을 벗어난(setsid) 자손도 대상이다. 표식을 지운 자손(`env -i`)은 찾지 못한다.
/// Windows는 Job Object가 서버와 함께 트리를 끝내므로 찾을 것이 없다.
pub fn reap_leftovers(tags: &[String]) -> std::collections::HashMap<String, usize> {
    #[cfg(target_os = "linux")]
    {
        linux::reap(tags)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = tags;
        std::collections::HashMap::new()
    }
}

/// 재시작 때 남은 프로세스를 정리할 수 있는 OS인가(사유 문구용).
pub const REAPS_LEFTOVERS: bool = cfg!(any(target_os = "linux", windows));

#[cfg(target_os = "linux")]
mod linux {
    use super::OWNER_ENV;
    use std::collections::HashMap;
    use std::time::Duration;

    struct Proc {
        pid: i32,
        pgid: i32,
        tag: Vec<u8>,
    }

    /// `/proc`에서 표식이 있는 프로세스를 모은다. 다른 사용자·이미 끝난 프로세스는 건너뛴다.
    fn scan() -> Vec<Proc> {
        let me = std::process::id() as i32;
        let prefix = format!("{OWNER_ENV}=").into_bytes();
        let Ok(dir) = std::fs::read_dir("/proc") else { return vec![] };
        let mut out = vec![];
        for e in dir.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<i32>().ok()) else { continue };
            if pid == me {
                continue;
            }
            let Ok(env) = std::fs::read(e.path().join("environ")) else { continue };
            let Some(tag) = env.split(|b| *b == 0).find_map(|kv| kv.strip_prefix(prefix.as_slice())) else { continue };
            // stat: "pid (comm) state ppid pgrp ..." — comm에 공백·괄호가 있을 수 있어 마지막 ')' 뒤를 읽는다.
            let Ok(stat) = std::fs::read_to_string(e.path().join("stat")) else { continue };
            let Some(rest) = stat.rsplit_once(')').map(|x| x.1) else { continue };
            let Some(pgid) = rest.split_whitespace().nth(2).and_then(|s| s.parse().ok()) else { continue };
            out.push(Proc { pid, pgid, tag: tag.to_vec() });
        }
        out
    }

    fn sigkill(pid: i32) -> bool {
        // SAFETY: 표식을 확인한 대상에만 신호를 보낸다.
        unsafe { libc::kill(pid, libc::SIGKILL) == 0 }
    }

    /// 그룹 `pgid`에 같은 표식의 구성원이 남아 있으면(=그룹 번호가 아직 우리 것) 그룹 전체를 종료한다.
    /// 구성원이 하나라도 있는 동안 그룹 번호는 재사용되지 않는다.
    pub fn kill_group_if_ours(pgid: i32, tag: &str) {
        for _ in 0..20 {
            let ours = scan().iter().any(|p| p.pgid == pgid && p.tag == tag.as_bytes());
            if !ours {
                return;
            }
            sigkill(-pgid);
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn reap(tags: &[String]) -> HashMap<String, usize> {
        let mut killed: HashMap<String, usize> = HashMap::new();
        if tags.is_empty() {
            return killed;
        }
        // 종료 중 fork한 자식까지 잡도록 더 찾을 것이 없을 때까지 반복한다.
        for _ in 0..20 {
            let mut found = 0;
            for p in scan() {
                let Some(t) = tags.iter().find(|t| p.tag == t.as_bytes()) else { continue };
                if sigkill(p.pid) {
                    *killed.entry(t.clone()).or_default() += 1;
                    found += 1;
                }
            }
            if found == 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        killed
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn isolation_setup_failures_never_execute_the_payload() {
        for fail_group in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let marker = dir.path().join("payload-ran");
            let mut command = tokio::process::Command::new("bash");
            command.args(["-c", "printf ran > \"$1\"", "isolation-fixture"]).arg(&marker).kill_on_drop(true);
            prepare(&mut command, &crate::util::new_id(), Limits::default());
            if fail_group {
                // setpgid가 거부할 음수 PGID를 만들어 실제 process-group 생성 실패를 유도한다.
                command.process_group(-1);
            } else {
                // 자원/격리 설정이 exec 전에 실패하는 경계다. 사용자 payload는 시작하면 안 된다.
                unsafe {
                    command.pre_exec(|| Err(std::io::Error::from_raw_os_error(libc::EPERM)));
                }
            }
            let error = command.spawn().expect_err("격리 실패를 무시하고 실행하면 안 된다");
            assert!(error.raw_os_error().is_some(), "실제 spawn 오류여야 한다: {error}");
            assert!(!marker.exists(), "실패 뒤 사용자 명령을 실행하거나 재시도하지 않는다");
        }
    }

    fn spawn(tag: Option<&str>, script: &str) -> tokio::process::Child {
        let mut c = tokio::process::Command::new("bash");
        c.args(["-c", script]).env_remove(OWNER_ENV).kill_on_drop(true);
        match tag {
            Some(t) => prepare(&mut c, t, Limits::default()),
            None => {
                c.process_group(0);
            }
        }
        c.spawn().unwrap()
    }

    fn alive(pid: u32) -> bool {
        std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| !s.rsplit_once(')').unwrap().1.trim_start().starts_with('Z'))
    }

    /// 회수된 leader의 그룹은 표식이 일치하는 구성원이 있을 때만 종료한다(SEC-016).
    #[tokio::test]
    async fn group_kill_requires_matching_tag() {
        // 표식 없는 그룹(그룹 번호가 재사용된 남의 프로세스 흉내)은 건드리지 않는다.
        let mut other = spawn(None, "sleep 30");
        let o = Owned { pid: other.id().unwrap(), tag: "t-mine".into() };
        o.kill_tree(false);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(other.try_wait().unwrap().is_none(), "표식 없는 그룹은 유지");
        // 다른 표식의 그룹도 마찬가지
        let mut foreign = spawn(Some("t-foreign"), "sleep 30");
        Owned { pid: foreign.id().unwrap(), tag: "t-mine".into() }.kill_tree(false);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(foreign.try_wait().unwrap().is_none(), "다른 표식 그룹은 유지");
        // 우리 표식: leader가 끝난 뒤 그룹에 남은 자식(표식을 지운 env -i 자식 포함)까지 종료
        let mut mine = spawn(Some("t-mine"), "sleep 30 & env -i sleep 31 & sleep 0.2");
        let o = adopt(&mut mine, "t-mine", Limits::default()).unwrap();
        mine.wait().await.unwrap();
        let leftovers: Vec<u32> = std::fs::read_dir("/proc")
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
            .filter(|p| {
                std::fs::read_to_string(format!("/proc/{p}/stat")).is_ok_and(|s| s.rsplit_once(')').unwrap().1.split_whitespace().nth(2) == Some(&o.pid().to_string()))
            })
            .collect();
        assert_eq!(leftovers.len(), 2, "leader 종료 후 그룹에 남은 자식 둘");
        o.kill_tree(false);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(leftovers.iter().all(|p| !alive(*p)), "표식이 확인된 그룹 전체(표식 없는 자식 포함) 종료");
        other.kill().await.unwrap();
        foreign.kill().await.unwrap();
    }
}

#[cfg(all(test, windows))]
mod win_tests {
    use super::*;
    use std::process::Stdio;

    fn cmd(script: &str) -> tokio::process::Command {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/D", "/S", "/C", script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        c
    }

    /// 일시정지로 만든 프로세스를 Job에 넣고 재개하면 정상 실행된다.
    #[tokio::test]
    async fn adopted_process_runs_to_completion() {
        let plain = cmd("echo plain").output().await.unwrap();
        assert!(String::from_utf8_lossy(&plain.stdout).contains("plain"), "기준: Job 없이 실행");
        let mut c = cmd("echo owned");
        prepare(&mut c, "t-win", Limits::default());
        let mut child = c.spawn().unwrap();
        let _o = adopt(&mut child, "t-win", Limits::default()).unwrap();
        let out = tokio::time::timeout(std::time::Duration::from_secs(20), child.wait_with_output()).await.expect("재개되지 않아 끝나지 않음").unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains("owned"), "{out:?}");
    }

    /// 한도를 건 Job도 만들어지고 실행된다(한도 강제 자체는 실제 Windows에서 확인 필요).
    #[tokio::test]
    async fn limited_job_runs() {
        let l = Limits { memory_mb: 512, cpu_seconds: 30 };
        let mut c = cmd("echo limited");
        prepare(&mut c, "t-win3", l);
        let mut child = c.spawn().unwrap();
        let _o = adopt(&mut child, "t-win3", l).unwrap();
        let out = tokio::time::timeout(std::time::Duration::from_secs(20), child.wait_with_output()).await.unwrap().unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains("limited"), "{out:?}");
    }

    /// 트리 종료는 손자까지 끝낸다.
    #[tokio::test]
    async fn kill_tree_ends_grandchildren() {
        let mut c = cmd("cmd /c ping -n 300 127.0.0.1");
        prepare(&mut c, "t-win2", Limits::default());
        let mut child = c.spawn().unwrap();
        let o = adopt(&mut child, "t-win2", Limits::default()).unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        assert!(child.try_wait().unwrap().is_none(), "실행 중");
        o.kill_tree(true);
        let st = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait()).await.expect("종료되지 않음").unwrap();
        assert!(!st.success());
    }
}

#[cfg(windows)]
mod windows {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_JOB_TIME, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, OpenThread, PROCESS_SET_QUOTA, PROCESS_TERMINATE, ResumeThread, THREAD_SUSPEND_RESUME};

    pub use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED};

    pub struct Job(HANDLE);
    // SAFETY: Job handle은 스레드에 묶이지 않는 커널 객체 handle이다.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    fn last_err() -> std::io::Error {
        std::io::Error::last_os_error()
    }

    impl Job {
        pub fn new(limits: super::Limits) -> std::io::Result<Job> {
            // SAFETY: 이름 없는 Job 생성, 반환 handle은 Drop에서 닫는다.
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return Err(last_err());
                }
                let job = Job(h);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if limits.memory_mb > 0 {
                    info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
                    info.JobMemoryLimit = limits.memory_mb.saturating_mul(1024 * 1024) as usize;
                }
                if limits.cpu_seconds > 0 {
                    // 100ns 단위. 초과하면 Job의 모든 프로세스가 종료된다.
                    info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_TIME;
                    info.BasicLimitInformation.PerJobUserTimeLimit = (limits.cpu_seconds as i64).saturating_mul(10_000_000);
                }
                let ok = SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    return Err(last_err());
                }
                Ok(job)
            }
        }

        /// 일시정지 상태로 만든 프로세스를 Job에 넣고 스레드를 재개한다.
        pub fn assign_and_resume(&self, pid: u32) -> std::io::Result<()> {
            // SAFETY: 직접 만든 자식 프로세스의 handle과 그 스레드에만 접근한다.
            unsafe {
                let p = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if p.is_null() {
                    return Err(last_err());
                }
                let ok = AssignProcessToJobObject(self.0, p);
                let err = last_err();
                CloseHandle(p);
                if ok == 0 {
                    return Err(err);
                }
                let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
                if snap == INVALID_HANDLE_VALUE {
                    return Err(last_err());
                }
                let mut te: THREADENTRY32 = std::mem::zeroed();
                te.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
                let mut resumed = 0;
                let mut more = Thread32First(snap, &mut te) != 0;
                while more {
                    if te.th32OwnerProcessID == pid {
                        let t = OpenThread(THREAD_SUSPEND_RESUME, 0, te.th32ThreadID);
                        if !t.is_null() {
                            // 반환값은 이전 suspend count다. 1 이하가 될 때까지 풀어야 실제로 실행된다.
                            for _ in 0..8 {
                                match ResumeThread(t) {
                                    u32::MAX => break,
                                    n if n <= 1 => {
                                        resumed += 1;
                                        break;
                                    }
                                    _ => {}
                                }
                            }
                            CloseHandle(t);
                        }
                    }
                    more = Thread32Next(snap, &mut te) != 0;
                }
                CloseHandle(snap);
                if resumed == 0 {
                    return Err(std::io::Error::other("재개할 스레드를 찾지 못했습니다"));
                }
                Ok(())
            }
        }

        pub fn terminate(&self) {
            // SAFETY: 유효한 Job handle.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: 마지막 handle을 닫으면 KILL_ON_JOB_CLOSE로 남은 트리가 끝난다.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
