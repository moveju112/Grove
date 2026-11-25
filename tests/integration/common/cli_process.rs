use std::io::{BufRead, BufReader};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub struct Running {
    child: Child,
    lines: Receiver<String>,
    reader: Option<JoinHandle<String>>,
    stderr: tempfile::NamedTempFile,
}

impl Running {
    pub fn spawn(mut command: Command) -> Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP);
        }
        let stderr = tempfile::NamedTempFile::new().unwrap();
        let mut child = command.stdout(Stdio::piped()).stderr(stderr.reopen().unwrap()).spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut output = String::new();
            for line in BufReader::new(stdout).lines() {
                let line = line.unwrap();
                output.push_str(&line);
                output.push('\n');
                let _ = tx.send(line);
            }
            output
        });
        Self { child, lines, reader: Some(reader), stderr }
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn ready(&self, json_output: bool) -> String {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut output = String::new();
        loop {
            let line = self.lines.recv_timeout(deadline.saturating_duration_since(Instant::now())).expect("준비 안내가 제한 시간 안에 도착해야 한다");
            output.push_str(&line);
            output.push('\n');
            if json_output || line.starts_with("상세 진단:") {
                return output;
            }
        }
    }

    pub fn finish(&mut self) -> (ExitStatus, String, String) {
        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "시험 소유 서버 종료 시간 초과");
            std::thread::sleep(Duration::from_millis(10));
        };
        let stdout = self.reader.take().unwrap().join().unwrap();
        let stderr = std::fs::read_to_string(self.stderr.path()).unwrap();
        (status, stdout, stderr)
    }

    #[allow(dead_code)]
    pub fn stop(&mut self) -> (ExitStatus, String, String) {
        #[cfg(unix)]
        assert_eq!(unsafe { libc::kill(self.id() as libc::pid_t, libc::SIGTERM) }, 0);
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, GenerateConsoleCtrlEvent};
            assert_ne!(unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, self.id()) }, 0);
        }
        self.finish()
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}
