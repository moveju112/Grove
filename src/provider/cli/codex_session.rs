//! Keep an initialized app-server for the next compatible turn in the same conversation.

use super::{
    GroupGuard, ModelOutput, ModelRequest, OnDelta, Profile, ProviderError, Usage, claude_images,
    cli_command, codex, codex_image_paths,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::BufReader,
    process::{Child, ChildStdin, ChildStdout},
};

const IDLE_TTL: Duration = Duration::from_secs(120);
const MAX_IDLE: usize = 4;

#[derive(Default)]
pub(crate) struct Sessions(Mutex<State>);

#[derive(Default)]
struct State {
    idle: HashMap<String, Idle>,
    /// 프로필·실행 위치별로 턴을 마친 app-server가 보고한 skill 개수. 프로필마다 플러그인 구성이 다를 수 있다.
    skills: HashMap<(String, PathBuf), usize>,
    closed: bool,
}

struct Idle {
    key: Key,
    thread: String,
    since: Instant,
    process: Process,
}

#[derive(PartialEq, Eq)]
struct Key {
    profile: String,
    program: PathBuf,
    cwd: PathBuf,
    argv: Vec<String>,
    bridge_tools: Vec<&'static str>,
}

#[derive(Clone)]
pub(crate) struct Handle {
    pub sessions: Arc<Sessions>,
    pub session: String,
    pub profile: String,
}

impl std::fmt::Debug for Handle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CodexSession(<conversation>)")
    }
}

impl Sessions {
    pub(crate) fn invalidate(&self) {
        self.0.lock().expect("Codex sessions").idle.clear();
    }

    pub(crate) fn close(&self) {
        let mut state = self.0.lock().expect("Codex sessions");
        state.closed = true;
        state.idle.clear();
    }

    pub(crate) fn expire(&self) {
        self.0
            .lock()
            .expect("Codex sessions")
            .idle
            .retain(|_, idle| idle.since.elapsed() < IDLE_TTL);
    }
}

impl Handle {
    pub(crate) fn discard(&self) {
        self.sessions
            .0
            .lock()
            .expect("Codex sessions")
            .idle
            .remove(&self.session);
    }

    fn checkout(&self, key: &Key, thread: Option<&str>) -> Result<Option<Process>, ProviderError> {
        let mut state = self.sessions.0.lock().expect("Codex sessions");
        if state.closed {
            return Err(ProviderError::new("cancelled", "서버가 종료 중입니다"));
        }
        Ok(state
            .idle
            .remove(&self.session)
            .filter(|idle| {
                idle.since.elapsed() < IDLE_TTL
                    && &idle.key == key
                    && thread == Some(idle.thread.as_str())
            })
            .and_then(|mut idle| {
                idle.process
                    .child
                    .try_wait()
                    .ok()
                    .filter(Option::is_none)
                    .map(|_| idle.process)
            }))
    }

    fn known_skills(&self, key: &Key) -> Option<usize> {
        self.sessions.0.lock().expect("Codex sessions").skills.get(&(key.profile.clone(), key.cwd.clone())).copied()
    }

    fn remember_skills(&self, key: &Key, count: usize) {
        self.sessions.0.lock().expect("Codex sessions").skills.insert((key.profile.clone(), key.cwd.clone()), count);
    }

    fn park(&self, key: Key, thread: String, process: Process) {
        let mut state = self.sessions.0.lock().expect("Codex sessions");
        if state.closed {
            return;
        }
        if state.idle.len() >= MAX_IDLE
            && let Some(oldest) = state
                .idle
                .iter()
                .min_by_key(|(_, idle)| idle.since)
                .map(|(id, _)| id.clone())
        {
            state.idle.remove(&oldest);
        }
        state.idle.insert(
            self.session.clone(),
            Idle {
                key,
                thread,
                since: Instant::now(),
                process,
            },
        );
    }
}

struct Process {
    _guard: GroupGuard,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    usage_total: Option<Usage>,
    _scratch: tempfile::TempDir,
}

fn scratch() -> Result<tempfile::TempDir, ProviderError> {
    tempfile::Builder::new()
        .prefix("grove-codex-")
        .tempdir()
        .map_err(|_| ProviderError::new("cli_failed", "Codex 임시 폴더를 만들지 못했습니다"))
}

impl Process {
    fn start(key: &Key) -> Result<Self, ProviderError> {
        let scratch = scratch()?;
        let mut command = cli_command("codex_cli", &key.program);
        command
            .args(&key.argv)
            .current_dir(&key.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for var in ["TMPDIR", "TMP", "TEMP"] {
            command.env(var, scratch.path());
        }
        let tag = crate::util::new_id();
        crate::procs::prepare(&mut command, &tag);
        let mut child = command.spawn().map_err(|error| {
            if crate::deps::is_missing("codex", Some(&error)) {
                ProviderError::new("cli_not_found", crate::deps::message("codex"))
            } else {
                ProviderError::new("cli_failed", format!("codex 실행 실패: {error}"))
            }
        })?;
        let guard = GroupGuard(
            crate::procs::adopt(&mut child, &tag)
                .map_err(|error| ProviderError::new("cli_failed", error))?,
        );
        let stdin = child.stdin.take().expect("Codex stdin");
        let stdout = BufReader::new(child.stdout.take().expect("Codex stdout"));
        Ok(Self {
            _guard: guard,
            child,
            stdin,
            stdout,
            usage_total: None,
            _scratch: scratch,
        })
    }
}

pub(super) async fn run(
    handle: &Handle,
    profile: &Profile,
    req: &ModelRequest,
    on_delta: OnDelta<'_>,
    program: Option<&Path>,
) -> Result<ModelOutput, ProviderError> {
    let context = req.cli.as_ref().expect("Codex 대화 문맥");
    let key = Key {
        profile: handle.profile.clone(),
        program: program.unwrap_or(Path::new("codex")).to_path_buf(),
        cwd: context.cwd.clone(),
        argv: codex::args(req, false),
        // 권한이 바뀌면 이전 MCP 구성을 가진 프로세스를 버린다.
        bridge_tools: context
            .continuations
            .as_ref()
            .map(|bridge| bridge.tools.clone())
            .unwrap_or_default(),
    };
    let images = claude_images(req, context.resume.is_some())?;
    let image_directory = (!images.is_empty()).then(scratch).transpose()?;
    let image_paths = match &image_directory {
        Some(directory) => codex_image_paths(&images, directory.path())?,
        None => Vec::new(),
    };
    let (mut process, connection) = match handle.checkout(&key, context.resume.as_deref())? {
        Some(process) => {
            let connection = codex::Connection::Reused(process.usage_total.clone());
            (process, connection)
        }
        None => (Process::start(&key)?, codex::Connection::Fresh(handle.known_skills(&key))),
    };
    let fresh = matches!(connection, codex::Connection::Fresh(_));
    let (output, usage_total) = codex::run_turn(
        &mut process.stdin,
        &mut process.stdout,
        profile,
        req,
        &image_paths,
        on_delta,
        connection,
    )
    .await?;
    if fresh
        && let Some(count) = codex::skill_count(&mut process.stdin, &mut process.stdout, profile, req).await
    {
        handle.remember_skills(&key, count);
    }
    // 다음 턴의 config는 thread를 다시 불러올 때 적용한다. 이전 턴의 MCP 연결을 가진 프로세스는 보관하지 않는다.
    if let Some(thread) = output.native_session.as_ref()
        && codex::unsubscribe(
            &mut process.stdin,
            &mut process.stdout,
            profile,
            req,
            thread,
        )
        .await
    {
        process.usage_total = usage_total;
        handle.park(key, thread.clone(), process);
    }
    Ok(output)
}
