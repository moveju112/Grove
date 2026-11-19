#!/usr/bin/env python3
"""로컬 relay 시험 스택. 운영·스테이징과 분리된 데몬 + 로컬 relay(miniflare) + 네트워크 조건 프록시를 띄운다.

AI·개발자가 배포 없이 폰과 같은 경로(브라우저 → relay → 데몬, 암호화 다중화 연결)를 시험한다.
Cloudflare 고유 동작은 재현하지 못한다. 그 확인은 별도 승인된 스테이징에서 한다.

사용
    python3 scripts/relay_stack.py up [--state FILE] [--delay MS]   # 빌드된 debug 서버·웹으로 스택 기동, 상태 JSON 출력
    python3 scripts/relay_stack.py net --state FILE --delay 150      # 지연(ms, 방향별)
    python3 scripts/relay_stack.py net --state FILE --cut            # 현재 연결 모두 끊기(백그라운드에서 소켓 정리)
    python3 scripts/relay_stack.py net --state FILE --blackhole on   # 응답 없는 죽은 연결
    python3 scripts/relay_stack.py down --state FILE                 # 종료하고 이 스택이 만든 임시 디렉터리 삭제

데이터는 매번 새 임시 디렉터리에 만든다. 실사용 데이터·키·relay 비밀은 읽지 않는다.
"""
import argparse
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RELAY = os.path.join(ROOT, "relay")
DEFAULT_STATE = os.path.join(tempfile.gettempdir(), "grove-relay-stack.json")
WORK_PREFIX = "grove-relay-stack-"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def grove_binary():
    # build.py와 같은 툴체인 환경(CARGO_HOME·PATH)으로 target 디렉터리를 찾는다.
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    import build
    meta = json.loads(build.out(["cargo", "metadata", "--no-deps", "--format-version", "1"]))
    path = os.path.join(meta["target_directory"], "debug", "grove")
    if not os.path.exists(path):
        sys.exit("debug 서버가 없습니다. python3 scripts/build.py dev로 먼저 빌드하세요.")
    return path


def spawn(cmd, log, env=None, cwd=ROOT):
    # 스택 명령이 끝나도 계속 돌도록 새 세션으로 띄운다. 종료는 down이 process group 단위로 한다.
    out = open(log, "w")
    return subprocess.Popen(cmd, cwd=cwd, env={**os.environ, **(env or {})}, stdout=out, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, start_new_session=True).pid


def wait_line(log, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with open(log) as f:
            for line in f:
                line = line.strip()
                if line.startswith("{") or line.startswith("http"):
                    return line
        time.sleep(0.1)
    sys.exit(f"시작 출력이 없습니다: {log}")


def identity(data):
    """데몬이 쓸 E2EE 신원 키를 미리 만들어 relay 방 ID(공개키 SHA-256)를 정한다."""
    os.makedirs(data, mode=0o700)
    path = os.path.join(data, "e2ee-identity.key")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(secrets.token_bytes(32))
    script = ("const c=require('crypto');const s=require('fs').readFileSync(process.argv[1]);"
              "const k=c.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),s]),format:'der',type:'pkcs8'});"
              "const p=c.createPublicKey(k).export({format:'der',type:'spki'}).subarray(-32);"
              "console.log(JSON.stringify({key:p.toString('base64'),room:c.createHash('sha256').update(p).digest('hex')}))")
    return json.loads(subprocess.run(["node", "-e", script, path], capture_output=True, text=True, check=True).stdout)


def http(url, method="GET"):
    with urllib.request.urlopen(urllib.request.Request(url, method=method), timeout=5) as r:
        return json.loads(r.read() or b"null")


def up(a):
    if os.path.exists(a.state):
        sys.exit(f"이미 스택 상태 파일이 있습니다: {a.state} (down으로 먼저 정리하세요)")
    binary = grove_binary()
    web = os.path.join(ROOT, "web", "build", "client")
    if not os.path.exists(os.path.join(web, "index.html")):
        sys.exit("빌드된 웹이 없습니다. python3 scripts/build.py dev로 먼저 빌드하세요.")
    work = tempfile.mkdtemp(prefix=WORK_PREFIX, dir="/tmp")
    data = os.path.join(work, "data")
    ident = identity(data)
    daemon_port = free_port()
    pages_port = free_port()
    origin = f"http://127.0.0.1:{pages_port}"
    token = secrets.token_hex(32)
    # origin: 브라우저가 여는 화면 주소, api: 시험 준비용 데몬 직접 주소(loopback), control: 네트워크 주입 제어.
    state = {"target": "local", "work": work, "data": data, "pids": {}, "origin": origin, "api": f"http://127.0.0.1:{daemon_port}",
             "key": ident["key"], "room": ident["room"]}
    try:
        # Pages처럼 정적 웹을 별도로 제공한다. 데몬의 self-only CSP는 완화하지 않는다.
        state["pids"]["pages"] = spawn(
            [sys.executable, "-m", "http.server", str(pages_port), "--bind", "127.0.0.1", "--directory", web],
            os.path.join(work, "pages.log"))
        state["pids"]["relay"] = spawn(["node", "fixture.mjs"], os.path.join(work, "relay.log"),
                                       {"TEST_ROOM": ident["room"], "TEST_TOKEN": token, "PAGES_ORIGIN": origin, "FIXTURE_DETACHED": "1"}, cwd=RELAY)
        relay_port = int(wait_line(os.path.join(work, "relay.log")).rstrip("/").rsplit(":", 1)[1])
        state["pids"]["netem"] = spawn(["node", "netem.mjs", "--target", f"127.0.0.1:{relay_port}", "--delay", str(a.delay)],
                                       os.path.join(work, "netem.log"), cwd=RELAY)
        ports = json.loads(wait_line(os.path.join(work, "netem.log")))
        state["control"] = f"http://127.0.0.1:{ports['control']}"
        state["endpoint"] = f"ws://127.0.0.1:{ports['proxy']}/api/e2ee/{ident['room']}"
        relay_json = os.path.join(data, "relay.json")
        fd = os.open(relay_json, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"url": f"ws://127.0.0.1:{ports['proxy']}", "token": token}, f)
        password = secrets.token_urlsafe(32)
        subprocess.run([binary, "pairing", "set-password", "--password-stdin", "--data-dir", data],
                       input=password + "\n", text=True, capture_output=True, check=True)
        state["pairing_issuance_password_file"] = os.path.join(work, "test-pairing-issuance-password")
        fd = os.open(state["pairing_issuance_password_file"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(password)
        state["pids"]["daemon"] = spawn([binary, "serve", "--listen", f"127.0.0.1:{daemon_port}", "--data-dir", data],
                                        os.path.join(work, "daemon.log"),
                                        {"GROVE_WEB_DIR": web, "GROVE_LOG": "warn"})
        state["token_file"] = os.path.join(data, "owner-token")
        state["page"] = f"{origin}/#connect={urllib.request.quote(state['endpoint'], safe='')}&key={urllib.request.quote(ident['key'], safe='')}"
        with open(a.state, "w") as f:
            json.dump(state, f, indent=2)
        # 데몬이 relay 제어 연결을 맺어 브라우저 경로가 실제로 동작할 때까지 기다린다.
        deadline = time.time() + 30
        while True:
            r = subprocess.run(["node", "probe.mjs", "v1", "1", "--state", a.state], cwd=RELAY, capture_output=True, text=True)
            if r.returncode == 0:
                break
            if time.time() > deadline:
                sys.exit(f"relay 경로가 준비되지 않았습니다: {r.stdout.strip() or r.stderr.strip()}")
            time.sleep(0.3)
    except BaseException:
        down_state(state)
        if os.path.exists(a.state):
            os.unlink(a.state)
        raise
    print(json.dumps(state, ensure_ascii=False, indent=2))


def down_state(state):
    for pid in state.get("pids", {}).values():
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.time() + 10
    for pid in state.get("pids", {}).values():
        while time.time() < deadline:
            try:
                os.killpg(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    work = state.get("work", "")
    # 이 스택이 만든 /tmp 아래 디렉터리만 지운다.
    if os.path.basename(work).startswith(WORK_PREFIX) and os.path.dirname(work) == "/tmp":
        shutil.rmtree(work, ignore_errors=True)


def down(a):
    if not os.path.exists(a.state):
        print("실행 중인 스택이 없습니다")
        return
    with open(a.state) as f:
        down_state(json.load(f))
    os.unlink(a.state)
    print("스택을 종료했습니다")


def net(a):
    with open(a.state) as f:
        control = json.load(f)["control"]
    if a.delay is not None:
        http(f"{control}/delay?ms={a.delay}", "POST")
    if a.cut:
        http(f"{control}/cut", "POST")
    if a.blackhole:
        http(f"{control}/blackhole?on={int(a.blackhole == 'on')}", "POST")
    print(json.dumps(http(f"{control}/stats"), ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)
    p = sub.add_parser("up")
    p.add_argument("--state", default=DEFAULT_STATE)
    p.add_argument("--delay", type=int, default=0)
    p.set_defaults(func=up)
    p = sub.add_parser("down")
    p.add_argument("--state", default=DEFAULT_STATE)
    p.set_defaults(func=down)
    p = sub.add_parser("net")
    p.add_argument("--state", default=DEFAULT_STATE)
    p.add_argument("--delay", type=int)
    p.add_argument("--cut", action="store_true")
    p.add_argument("--blackhole", choices=["on", "off"])
    p.set_defaults(func=net)
    a = ap.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
