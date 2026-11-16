"""실제 Win32 창을 쓰는 Windows backend 인수 검사. Linux에서는 Xvfb·Wine에 격리한다.

python3 tests/fixtures/computer_windows.py <grove.exe> <computer_windows.exe>
fixture는 computer_windows.c를 Windows target으로 컴파일한 파일이다.
Windows에서는 직접 실행하고 로그인된 사용자의 시험 창만 만든다.
Wine 9는 프로세스 간 PrintWindow를 구현하지 않아 전체 검사를 통과할 수 없다.
Wine의 같은 프로세스 캡처·입력 회귀는 tests/computer_windows.rs로 검사한다.
"""
import argparse
import contextlib
import json
import os
from pathlib import Path
import select
import queue
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import urllib.request
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary")
    parser.add_argument("fixture")
    args = parser.parse_args()
    with test_directory() as directory, contextlib.ExitStack() as stack:
        work = Path(directory)
        log = stack.enter_context((work / "native.log").open("wb"))
        env = {**os.environ}
        runner = []
        if os.name != "nt":
            x = subprocess.Popen(["Xvfb", "-displayfd", "1", "-screen", "0", "1024x768x24", "-nolisten", "tcp"],
                                 stdout=subprocess.PIPE, stderr=log)
            stack.callback(stop, x)
            assert select.select([x.stdout], [], [], 10)[0], "Xvfb startup timed out"
            number = x.stdout.readline().decode().strip()
            assert number.isdecimal()
            env.update(DISPLAY=":" + number, WINEPREFIX=str(work / "wine"), WINEDEBUG="-all")
            env.pop("WAYLAND_DISPLAY", None)
            runner = ["wine"]
            stack.callback(subprocess.run, ["wineserver", "-k"], env=env, check=True, stdout=log, stderr=log, timeout=20)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        data = work / "data"
        project = work / "project"
        project.mkdir()

        def winpath(path):
            absolute = str(Path(path).resolve())
            return absolute if os.name == "nt" else "Z:" + absolute.replace("/", "\\")

        server = subprocess.Popen(runner + [str(Path(args.binary).resolve()), "serve", "--listen", f"127.0.0.1:{port}",
                                           "--data-dir", winpath(data)],
                                  stdout=subprocess.PIPE, stderr=log, env=env)
        stack.callback(stop, server)
        # 기존 readiness 줄을 읽는다. 자격 값은 출력하지 않는다.
        startup = read_line(server.stdout).decode("utf-8").strip()
        assert startup.startswith("서버 준비 완료"), "Windows Grove startup failed: " + startup
        token = (data / "owner-token").read_text().strip()
        base = f"http://127.0.0.1:{port}/api/v1"

        def api(method, path, body=None):
            request = urllib.request.Request(base + path, method=method,
                        data=None if body is None else json.dumps(body).encode(),
                        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json",
                                 "Idempotency-Key": str(uuid.uuid4())})
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)

        program = subprocess.Popen(runner + [str(Path(args.fixture).resolve())], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=log, env=env)
        stack.callback(stop, program)
        initial = json.loads(read_line(program.stdout))
        window = initial["window_id"]

        def fixture(command):
            program.stdin.write((command + "\n").encode())
            program.stdin.flush()
            return json.loads(read_line(program.stdout))

        status = api("GET", "/computer/status")
        assert status["platform"] == "windows" and status["backend"] == "win32_window_messages", status
        assert status["platform_supported"] and status["desktop_session_present"], status
        api("PUT", "/settings/server/-/computer.enabled", {"expected_revision": 0, "value": True})
        p = api("POST", "/projects", {"root_path": winpath(project)})
        session = api("POST", f"/projects/{p['id']}/sessions", {"title": "isolated Win32 check"})["id"]

        def run(arguments):
            call = api("POST", f"/sessions/{session}/tool-requests", {"name": "computer", "args": arguments})
            assert call["status"] == "pending_approval", call
            request = urllib.request.Request(base + "/events", headers={"Authorization": "Bearer " + token})
            with urllib.request.urlopen(request, timeout=20) as events:
                api("POST", f"/tool-calls/{call['id']}/decision", {"decision": "approve", "expected_revision": call["revision"]})
                current = api("GET", f"/tool-calls/{call['id']}")
                if current["status"] in ("succeeded", "failed", "unknown", "cancelled"):
                    return current["result"]
                for raw in events:
                    if raw.startswith(b"data:"):
                        payload = json.loads(raw[5:]).get("payload", {})
                        if payload.get("id") == call["id"] and payload.get("status") in ("succeeded", "failed", "unknown", "cancelled"):
                            return api("GET", f"/tool-calls/{call['id']}")["result"]
            raise AssertionError("Win32 call did not complete")

        listing = run({"target": "server", "action": "list"})
        assert "error" not in listing, listing
        assert any(w["window_id"] == window and w["active"] for w in listing["windows"]), listing
        captured = run({"target": "server", "action": "capture", "window_id": window})
        assert "error" not in captured, captured
        assert (captured["width"], captured["height"]) == (initial["width"], initial["height"])
        with (data / "computer" / session / captured["image_sha256"]).open("rb") as image:
            assert image.read(2) == b"\xff\xd8"
        result = run({"target": "server", "action": "act", "window_id": window, "frame_id": captured["frame_id"],
                      "actions": [{"type": "click", "x": 50, "y": 85},
                                  {"type": "type", "text": "한글🪟A"},
                                  {"type": "key", "key": "Backspace"}]})
        assert "error" not in result, result
        assert result["effect"] == "messages_delivered_goal_unverified"
        after = fixture("state")
        assert after["text"] == "한글🪟", after
        assert after["clicks"] >= 1 and after["keys"] >= 1, after
        assert result["pointer"] == captured["pointer"], "physical pointer changed"
        scrolled = run({"target": "server", "action": "act", "window_id": window, "frame_id": result["frame_id"],
                        "actions": [{"type": "scroll", "x": 10, "y": 10, "direction": "down", "amount": 2}]})
        assert "error" not in scrolled, scrolled
        assert fixture("state")["wheel"] == -240
        fixture("repaint")
        refused = run({"target": "server", "action": "act", "window_id": window, "frame_id": scrolled["frame_id"],
                       "actions": [{"type": "click", "x": 10, "y": 10}]})
        assert refused.get("error", {}).get("code") == "stale_frame", {"result": refused, "fixture": fixture("state")}
        fixture("blur")
        refused = run({"target": "server", "action": "capture", "window_id": window})
        assert refused["error"]["code"] == "focus_required", refused
        print(json.dumps({"status": "passed", "runtime": "Windows" if os.name == "nt" else "Wine isolated Xvfb",
                          "automatic_windows_backend": True, "capture": True, "unicode_child_input": True,
                          "click_key_scroll": True, "stale_and_focus_refused": True,
                          "physical_pointer_unchanged": True, "approval_path": True}))


@contextlib.contextmanager
def test_directory():
    directory = tempfile.mkdtemp(prefix="grove-win32-")
    try:
        yield directory
    except BaseException:
        print("Win32 fixture logs: " + str(Path(directory) / "native.log"), file=sys.stderr)
        raise
    else:
        shutil.rmtree(directory)


def stop(process):
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=20)

def read_line(stream):
    result = queue.Queue()
    def read():
        try:
            result.put(stream.readline())
        except Exception as error:
            result.put(error)
    threading.Thread(target=read, daemon=True).start()
    value = result.get(timeout=90)
    if isinstance(value, Exception):
        raise value
    return value


if __name__ == "__main__":
    main()
