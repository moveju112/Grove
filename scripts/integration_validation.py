"""고정 commit의 선택 검증. run은 background task로 실행하고 inspect로 결과를 읽는다."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time


LOCK = Path("/home/ubuntu/.cache/grove-rust-check.lock")
VALUE_FLAGS = {"--rust", "--vitest", "--e2e", "--filter"}
SWITCH_FLAGS = {"--lib", "--typecheck", "--e2e-regression"}


def selection(args):
    """전체 검사·dry-run·임의 명령은 성공 근거로 허용하지 않는다."""
    selected = False
    index = 0
    while index < len(args):
        flag = args[index]
        if flag in SWITCH_FLAGS:
            selected |= flag in {"--lib", "--typecheck"}
            index += 1
        elif flag in VALUE_FLAGS:
            index += 1
            start = index
            while index < len(args) and not args[index].startswith("-"):
                index += 1
            if start == index:
                raise ValueError(f"{flag}: 검사 대상 필요")
            selected |= flag != "--filter"
        else:
            raise ValueError(f"허용하지 않은 선택 검사 옵션: {flag}")
    if not selected:
        raise ValueError("선택 검사 필요")
    return args


def git(root, *args):
    return subprocess.check_output(
        ["git", "--no-optional-locks", "-C", str(root), *args],
        text=True, stderr=subprocess.PIPE, timeout=30,
    ).strip()


def save(job, state):
    temporary = job / "state.tmp"
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(job / "state.json")


def inspect(job, root):
    state = json.loads((Path(job) / "state.json").read_text())
    # 같은 commit이어도 원본 미커밋 변경이 있으면 전체 결과를 재사용하지 않는다.
    head = git(root, "rev-parse", "HEAD")
    clean = not git(root, "status", "--porcelain", "--untracked-files=normal")
    state["current_head"] = head
    state["reusable"] = (
        state["status"] == "passed" and head == state["candidate"] and clean
        and str(Path(root).resolve()) == state["root"]
    )
    return state


def run(root, candidate, store, args, timeout):
    root = Path(root).resolve()
    if Path(git(root, "rev-parse", "--show-toplevel")) != root:
        raise ValueError("--root는 Git top-level이어야 함")
    args = selection(args)
    if timeout <= 0:
        raise ValueError("timeout은 양수여야 함")
    sha = git(root, "rev-parse", "--verify", f"{candidate}^{{commit}}")
    store = Path(store).resolve()
    if store == root or root in store.parents:
        raise ValueError("검증 저장소는 원본 checkout 밖이어야 함")
    store.mkdir(parents=True, exist_ok=True)
    job = Path(tempfile.mkdtemp(prefix="validation-", dir=store))
    state = dict(root=str(root), candidate=sha, selection=args, status="preparing",
                 started_at=time.time(), pid=os.getpid(), checkout=str(job / "checkout"))
    save(job, state)
    print(json.dumps({"job": str(job), "candidate": sha}), flush=True)
    process = None
    deadline = time.monotonic() + timeout

    def interrupted(signum, frame):
        raise InterruptedError(f"signal {signum}")

    previous = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGTERM, signal.SIGINT)}

    def execute(command, cwd, log, env=None):
        nonlocal process
        process = subprocess.Popen(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT,
                                   env=env, start_new_session=True)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(command, timeout)
        code = process.wait(timeout=remaining)
        process = None
        return code

    def stop():
        nonlocal process
        if process is not None:
            # timeout·중단 시 자식 서버도 함께 종료한 뒤 잠금을 반환한다.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            process = None

    try:
        with (job / "output.log").open("w") as log:
            checkout = job / "checkout"
            # 독립 clone이므로 원본 HEAD/index/worktree 등록을 바꾸지 않는다.
            code = execute(["git", "clone", "--no-hardlinks", "--no-checkout",
                            str(root), str(checkout)], job, log)
            if code:
                raise RuntimeError(f"clone exit {code}")
            code = execute(["git", "checkout", "--detach", sha], checkout, log)
            if code:
                raise RuntimeError(f"checkout exit {code}")
            for target, source in ((checkout / ".dev", root / ".dev"),
                                   (checkout / "web/node_modules", root / "web/node_modules")):
                if not source.is_dir():
                    raise ValueError(f"공유 검사 환경 없음: {source}")
                target.symlink_to(source.resolve(), target_is_directory=True)
            state["status"] = "waiting-lock"
            save(job, state)
            # 단일 공유 잠금은 유지한다. 프로세스 내부 대기만 하며 메인은 자유롭다.
            with LOCK.open("a") as lock:
                try:
                    def lock_timeout(signum, frame):
                        raise subprocess.TimeoutExpired(["lock"], timeout)

                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(["lock"], timeout)
                    old_alarm = signal.signal(signal.SIGALRM, lock_timeout)
                    signal.setitimer(signal.ITIMER_REAL, remaining)
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX)
                    finally:
                        signal.setitimer(signal.ITIMER_REAL, 0)
                        signal.signal(signal.SIGALRM, old_alarm)
                    state["status"] = "running"
                    state["test_started_at"] = time.time()
                    save(job, state)
                    environment = dict(os.environ)
                    # 공유 target 설정은 그대로 유지하며 모든 실행을 같은 잠금으로 감싼다.
                    code = execute([sys.executable, "scripts/build.py", "test", *args],
                                   checkout, log, environment)
                    state["returncode"] = code
                    unchanged = git(checkout, "rev-parse", "HEAD") == sha and not git(
                        checkout, "status", "--porcelain", "--untracked-files=normal")
                    state["status"] = "passed" if code == 0 and unchanged else "failed"
                    if not unchanged:
                        state["error"] = "검사 중 checkout 입력 변경"
                finally:
                    stop()
    except subprocess.TimeoutExpired as error:
        state.update(status="timed-out", error=str(error))
    except InterruptedError as error:
        state.update(status="interrupted", error=str(error))
    except Exception as error:
        state.update(status="error", error=str(error))
    finally:
        stop()
        state["finished_at"] = time.time()
        save(job, state)
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    return 0 if state["status"] == "passed" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    start = sub.add_parser("run")
    start.add_argument("--root", required=True)
    start.add_argument("--candidate", required=True)
    start.add_argument("--store", required=True)
    start.add_argument("--timeout", type=float, default=3600)
    start.add_argument("selection", nargs=argparse.REMAINDER)
    status = sub.add_parser("inspect")
    status.add_argument("--root", required=True)
    status.add_argument("job")
    options = parser.parse_args()
    try:
        if options.action == "inspect":
            print(json.dumps(inspect(options.job, options.root), ensure_ascii=False, indent=2))
            return 0
        args = options.selection
        if args[:1] == ["--"]:
            args = args[1:]
        return run(options.root, options.candidate, options.store, args, options.timeout)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
