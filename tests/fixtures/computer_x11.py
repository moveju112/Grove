"""실제 PC 대신 고유 Xvfb 화면에서 창 전환·캡처·XTEST 입력을 검사한다.

실행: python3 tests/fixtures/computer_x11.py /절대/경로/grove
필요: Xvfb, libX11, libXtst. 사용자 DISPLAY나 기존 창을 사용하지 않는다.
"""
import ctypes as c
import json
import os
import select
import subprocess
import sys
import tempfile
import socket
import urllib.request
import uuid
import argparse
import threading


class ClientMessage(c.Structure):
    _fields_ = [("kind", c.c_int), ("serial", c.c_ulong), ("synthetic", c.c_int),
                ("display", c.c_void_p), ("window", c.c_ulong), ("message_type", c.c_ulong),
                ("format", c.c_int), ("data", c.c_long * 5)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary")
    parser.add_argument("--real-cli", help="예: codex_cli:gpt-6-luna (실제 모델 비용 발생)")
    args = parser.parse_args()
    binary = os.path.abspath(args.binary)
    with tempfile.TemporaryDirectory(prefix="grove-x11-") as temp:
        with open(os.path.join(temp, "xvfb.log"), "wb") as log:
            server = subprocess.Popen(
                ["Xvfb", "-displayfd", "1", "-screen", "0", "800x600x24", "-nolisten", "tcp"],
                stdout=subprocess.PIPE, stderr=log,
            )
            display = None
            x = None
            grove = None
            manager = None
            manager_thread = None
            stopped = threading.Event()
            try:
                assert select.select([server.stdout], [], [], 10)[0], "Xvfb startup timed out"
                number = server.stdout.readline().decode().strip()
                assert number.isdecimal(), "Xvfb did not publish an isolated display"
                env = {**os.environ, "DISPLAY": ":" + number}
                env.pop("WAYLAND_DISPLAY", None)
                x = c.CDLL("libX11.so.6")
                signatures = {
                    "XInitThreads": ([], c.c_int),
                    "XOpenDisplay": ([c.c_char_p], c.c_void_p),
                    "XCloseDisplay": ([c.c_void_p], c.c_int),
                    "XDefaultRootWindow": ([c.c_void_p], c.c_ulong),
                    "XCreateSimpleWindow": ([c.c_void_p, c.c_ulong, c.c_int, c.c_int, c.c_uint, c.c_uint, c.c_uint, c.c_ulong, c.c_ulong], c.c_ulong),
                    "XInternAtom": ([c.c_void_p, c.c_char_p, c.c_int], c.c_ulong),
                    "XChangeProperty": ([c.c_void_p, c.c_ulong, c.c_ulong, c.c_ulong, c.c_int, c.c_int, c.c_void_p, c.c_int], c.c_int),
                    "XMapWindow": ([c.c_void_p, c.c_ulong], c.c_int),
                    "XSelectInput": ([c.c_void_p, c.c_ulong, c.c_long], c.c_int),
                    "XSetInputFocus": ([c.c_void_p, c.c_ulong, c.c_int, c.c_ulong], c.c_int),
                    "XSync": ([c.c_void_p, c.c_int], c.c_int),
                    "XPending": ([c.c_void_p], c.c_int),
                    "XNextEvent": ([c.c_void_p, c.c_void_p], c.c_int),
                    "XConnectionNumber": ([c.c_void_p], c.c_int),
                    "XSetWindowBackground": ([c.c_void_p, c.c_ulong, c.c_ulong], c.c_int),
                    "XClearWindow": ([c.c_void_p, c.c_ulong], c.c_int),
                    "XDefaultGC": ([c.c_void_p, c.c_int], c.c_void_p),
                    "XSetForeground": ([c.c_void_p, c.c_void_p, c.c_ulong], c.c_int),
                    "XDrawString": ([c.c_void_p, c.c_ulong, c.c_void_p, c.c_int, c.c_int, c.c_char_p, c.c_int], c.c_int),
                    "XRaiseWindow": ([c.c_void_p, c.c_ulong], c.c_int),
                }
                for name, (arg_types, result) in signatures.items():
                    fn = getattr(x, name)
                    fn.argtypes, fn.restype = arg_types, result
                assert x.XInitThreads()
                display = x.XOpenDisplay(env["DISPLAY"].encode())
                assert display, "isolated X11 connection failed"
                root = x.XDefaultRootWindow(display)
                window = x.XCreateSimpleWindow(display, root, 100, 100, 240, 160, 0, 0, 0x336699)
                other = x.XCreateSimpleWindow(display, root, 400, 100, 240, 160, 0, 0, 0x663399)

                def prop(w, name, values, kind=6, connection=display):
                    data = (c.c_ulong * len(values))(*values)
                    x.XChangeProperty(connection, w, x.XInternAtom(connection, name.encode(), 0), kind, 32, 0, data, len(values))

                prop(root, "_NET_CLIENT_LIST", [window, other], 33)
                prop(root, "_NET_ACTIVE_WINDOW", [window], 33)
                prop(window, "_NET_WM_PID", [os.getpid()])
                prop(other, "_NET_WM_PID", [os.getpid()])
                title = b"Grove isolated computer fixture"
                x.XChangeProperty(display, window, x.XInternAtom(display, b"_NET_WM_NAME", 0),
                                  x.XInternAtom(display, b"UTF8_STRING", 0), 8, 0, c.c_char_p(title), len(title))
                x.XSelectInput(display, window, 1 | 2 | 4 | 8)
                x.XMapWindow(display, window)
                x.XMapWindow(display, other)
                x.XSetInputFocus(display, window, 1, 0)
                x.XSync(display, 0)
                manager = x.XOpenDisplay(env["DISPLAY"].encode())
                assert manager
                active_atom = x.XInternAtom(manager, b"_NET_ACTIVE_WINDOW", 0)
                x.XSelectInput(manager, root, 1 << 19)
                x.XSync(manager, 0)

                def window_manager():
                    fd = x.XConnectionNumber(manager)
                    while not stopped.is_set():
                        if not x.XPending(manager) and not select.select([fd], [], [], 0.05)[0]:
                            continue
                        if not x.XPending(manager):
                            continue
                        event = (c.c_long * 24)()
                        x.XNextEvent(manager, event)
                        msg = c.cast(event, c.POINTER(ClientMessage)).contents
                        if (msg.kind, msg.message_type, msg.format, msg.data[0]) == (33, active_atom, 32, 2) and msg.window in (window, other):
                            x.XRaiseWindow(manager, msg.window)
                            x.XSetInputFocus(manager, msg.window, 1, 0)
                            prop(root, "_NET_ACTIVE_WINDOW", [msg.window], 33, manager)
                            x.XSync(manager, 0)

                manager_thread = threading.Thread(target=window_manager)
                manager_thread.start()

                with socket.socket() as listener:
                    listener.bind(("127.0.0.1", 0))
                    port = listener.getsockname()[1]
                data = os.path.join(temp, "data")
                project = os.path.join(temp, "project")
                os.mkdir(project)
                grove = subprocess.Popen(
                    [binary, "serve", "--listen", f"127.0.0.1:{port}", "--data-dir", data],
                    env=env, stdout=subprocess.PIPE, stderr=log,
                )
                assert select.select([grove.stdout], [], [], 15)[0], "Grove startup timed out"
                ready = grove.stdout.readline().decode()
                assert ready.startswith("서버 준비 완료"), "isolated Grove startup failed"
                with open(os.path.join(data, "owner-token")) as f:
                    token = f.read().strip()
                base = f"http://127.0.0.1:{port}/api/v1"

                def api(method, path, body=None):
                    request = urllib.request.Request(
                        base + path, method=method,
                        data=None if body is None else json.dumps(body).encode(),
                        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json",
                                 "Idempotency-Key": str(uuid.uuid4())},
                    )
                    with urllib.request.urlopen(request, timeout=15) as response:
                        return json.load(response)

                api("PUT", "/settings/server/-/computer.enabled", {"expected_revision": 0, "value": True})
                p = api("POST", "/projects", {"root_path": project})
                session = api("POST", f"/projects/{p['id']}/sessions", {"title": "isolated native check"})["id"]

                approved_session = False

                def run(command):
                    nonlocal approved_session
                    call = api("POST", f"/sessions/{session}/tool-requests", {"name": "computer", "args": command})
                    assert call["status"] == ("approved" if approved_session else "pending_approval"), call
                    if approved_session:
                        assert call["approval_scope"] == "session", call
                    request = urllib.request.Request(base + "/events", headers={"Authorization": "Bearer " + token})
                    with urllib.request.urlopen(request, timeout=15) as events:
                        if not approved_session:
                            api("POST", f"/tool-calls/{call['id']}/decision",
                                {"decision": "approve_session", "expected_revision": call["revision"]})
                            approved_session = True
                        current = api("GET", f"/tool-calls/{call['id']}")
                        if current["status"] in ("succeeded", "failed", "unknown", "cancelled"):
                            return current["result"]
                        for raw in events:
                            if not raw.startswith(b"data:"):
                                continue
                            event = json.loads(raw[5:])
                            payload = event.get("payload", {})
                            if payload.get("id") == call["id"] and payload.get("status") in ("succeeded", "failed", "unknown", "cancelled"):
                                return api("GET", f"/tool-calls/{call['id']}")["result"]
                    raise AssertionError("native call did not finish")

                listed = run({"target": "server", "action": "list"})
                assert "windows" in listed, listed
                assert listed["windows"][0]["window_id"] == str(window), listed
                assert listed["windows"][0]["active"] is True
                assert listed["windows"][1]["active"] is False
                old = run({"target": "server", "action": "capture", "window_id": str(window)})
                activated = run({"target": "server", "action": "focus", "window_id": str(other)})
                assert activated == {"window_id": str(other), "active": True}, activated
                second = run({"target": "server", "action": "capture", "window_id": str(other)})
                assert second["frame_id"] and second["pixels_sha256"] != old["pixels_sha256"], second
                activated = run({"target": "server", "action": "focus", "window_id": str(window)})
                assert activated == {"window_id": str(window), "active": True}, activated
                retired = run({"target": "server", "action": "act", "window_id": str(window),
                               "frame_id": old["frame_id"], "actions": [{"type": "key", "key": "Enter"}]})
                assert retired["error"]["code"] == "stale_frame", retired
                captured = run({"target": "server", "action": "capture", "window_id": str(window)})
                assert "error" not in captured, captured
                assert (captured["width"], captured["height"]) == (240, 160)
                with open(os.path.join(data, "computer", session, captured["image_sha256"]), "rb") as f:
                    assert f.read(2) == b"\xff\xd8", "real JPEG capture expected"
                command = {
                    "target": "server", "action": "act", "window_id": str(window), "frame_id": captured["frame_id"],
                    "actions": [{"type": "click", "x": 20, "y": 30}, {"type": "type", "text": "Ab1"}, {"type": "key", "key": "Enter"}],
                }
                result = run(command)
                assert "error" not in result, result
                assert result["effect"] == "input_delivered_goal_unverified"
                assert result["pointer"] == [120, 130], "pointer didn't move to the target"
                events = []
                fd = x.XConnectionNumber(display)
                while len(events) < 12:
                    if not x.XPending(display):
                        assert select.select([fd], [], [], 3)[0], "expected fixture input events"
                    event = (c.c_long * 24)()
                    x.XNextEvent(display, event)
                    kind = c.cast(event, c.POINTER(c.c_int))[0]
                    if kind in (2, 3, 4, 5):
                        assert not c.cast(event, c.POINTER(ClientMessage)).contents.synthetic, "client-only event"
                        events.append(kind)
                assert events.count(4) == 1 and events.count(5) == 1, events
                assert events.count(2) == 5 and events.count(3) == 5, events
                x.XSetWindowBackground(display, window, 0x993366)
                x.XClearWindow(display, window)
                x.XSync(display, 0)
                command["frame_id"] = result["frame_id"]
                refused = run(command)
                assert refused["error"]["code"] == "stale_frame", refused
                # Reject a visible overlay even when the intended window still owns keyboard focus.
                clear = run({"target": "server", "action": "capture", "window_id": str(window)})
                cover = x.XCreateSimpleWindow(display, root, 115, 125, 20, 20, 0, 0, 0x0)
                x.XSelectInput(display, cover, 4 | 8)
                x.XMapWindow(display, cover)
                x.XSync(display, 0)
                covered = run({"target": "server", "action": "capture", "window_id": str(window)})
                assert covered["frame_id"] != clear["frame_id"], covered
                refused = run({**command, "frame_id": covered["frame_id"], "actions": command["actions"][:1]})
                assert refused["error"]["code"] == "focus_required", refused
                assert not x.XPending(display), "click escaped the observed window"
                prop(root, "_NET_ACTIVE_WINDOW", [root], 33)
                x.XSync(display, 0)
                refused = run({"target": "server", "action": "capture", "window_id": str(window)})
                assert refused["error"]["code"] == "focus_required", refused
                if args.real_cli:
                    # 답은 prompt·title·파일에 넣지 않고 격리 창의 픽셀에만 그린다.
                    code = "GROVE-" + uuid.uuid4().hex[:6].upper()
                    prop(root, "_NET_ACTIVE_WINDOW", [window], 33)
                    x.XSetWindowBackground(display, window, 0x336699)
                    x.XClearWindow(display, window)
                    gc = x.XDefaultGC(display, 0)
                    x.XSetForeground(display, gc, 0xFFFFFF)
                    x.XDrawString(display, window, gc, 25, 70, code.encode(), len(code))
                    x.XSync(display, 0)
                    protocol, model = args.real_cli.split(":", 1)
                    profile = api("POST", "/model-profiles", {
                        "name": "isolated real computer CLI", "protocol": protocol,
                        "base_url": "", "model": model, "options": {"timeout_secs": 120},
                    })
                    turn_request = urllib.request.Request(base + "/events", headers={"Authorization": "Bearer " + token})
                    with urllib.request.urlopen(turn_request, timeout=180) as events:
                        turn = api("POST", f"/sessions/{session}/turns", {
                            "profile_id": profile["id"], "tools": False,
                            "text": "Use the grove_computer MCP computer tool to list the server windows, then capture the one titled Grove isolated computer fixture. Read the code drawn in that screenshot and return that code only. Do not use shell, file tools, or input actions. This is a disposable X11 fixture.",
                        })["turn"]["id"]
                        approved = set()
                        completed = False
                        for raw in events:
                            if not raw.startswith(b"data:"):
                                continue
                            event = json.loads(raw[5:])
                            payload = event.get("payload", {})
                            if payload.get("turn_id") == turn and payload.get("name") == "computer" and payload.get("status") == "pending_approval":
                                arguments = payload["args"]
                                assert arguments["target"] == "server" and arguments["action"] in ("list", "capture"), "real model requested an unexpected action"
                                if arguments["action"] == "capture":
                                    assert arguments["window_id"] == str(window)
                                if payload["id"] not in approved:
                                    approved.add(payload["id"])
                                    api("POST", f"/tool-calls/{payload['id']}/decision",
                                        {"decision": "approve", "expected_revision": payload["revision"]})
                            if event.get("kind") == "turn.updated" and payload.get("id") == turn and payload.get("status") in ("completed", "failed", "cancelled", "interrupted"):
                                completed = payload["status"] == "completed"
                                if not completed:
                                    detail = api("GET", f"/turns/{turn}")
                                    raise AssertionError(f"real CLI turn failed: {detail.get('error')}")
                                break
                    messages = api("GET", f"/sessions/{session}/messages")["items"]
                    answer = next(m["content"]["text"] for m in reversed(messages) if m["role"] == "assistant")
                    if not completed or len(approved) < 2:
                        activity = [item.get("name", item.get("kind", "")) for message in messages
                                    if message["content"].get("type") == "cli_activity"
                                    for item in message["content"].get("items", [])]
                        raise AssertionError(f"real CLI did not complete list and capture: completed={completed}, approvals={len(approved)}, activity={activity}, answer={answer[:1500]}")
                    assert code in answer.upper(), "real model did not read the code from screenshot pixels"
                    print(json.dumps({"real_cli": args.real_cli, "mcp_list_capture_approved": True, "model_read_screenshot_code": True}))
                print(json.dumps({"status": "passed", "isolated_x11": True, "jpeg_capture": True,
                                  "click_text_key_events": True, "stale_frame_refused": True,
                                  "focus_change_refused": True, "app_switch": True, "overlay_refused": True,
                                  "approval_path": True}))
            finally:
                stopped.set()
                if manager_thread:
                    manager_thread.join(timeout=2)
                if manager:
                    x.XCloseDisplay(manager)
                if grove:
                    grove.terminate()
                    grove.wait(timeout=15)
                if display:
                    x.XCloseDisplay(display)
                server.terminate()
                server.wait(timeout=10)


if __name__ == "__main__":
    main()
