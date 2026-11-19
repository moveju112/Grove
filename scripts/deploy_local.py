#!/usr/bin/env python3
"""이 PC의 실사용 Grove 배포(설치·업데이트 공용 경로).

고정 구성
- 데몬: 127.0.0.1:49120, systemd user unit `grove-opus.service` 하나만. 같은 데이터 디렉터리 잠금(grove.lock)이 중복 실행을 막는다.
- 브라우저: http://127.0.0.1:4417, `grove-opus-web.service`(nginx)가 데몬으로 그대로 전달한다. 웹 파일은 데몬의 현재 release가 제공한다.

사용
    python3 scripts/deploy_local.py            # 처음이면 설치, 이후에는 같은 명령으로 업데이트
    python3 scripts/deploy_local.py --status   # 상태만 확인(변경 없음)

업데이트는 release 패키지 → 로컬 키로 서명한 manifest → `grove update apply`다.
실행 중 작업이 있으면 updater가 적용을 미루며(deferred), 실패하면 이전 release로 복구한다.
현재 대화만 실행 중인 것이 확인되면 대화 완료 후 독립 프로세스가 같은 패키지의 배포를 이어간다.

로컬 반영 뒤에는 같은 패키지의 웹 자산을 Cloudflare Pages(폰이 여는 공개 주소)에도 배포하고 실제 제공 자산을 대조한다.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import tempfile
from typing import NamedTuple
import urllib.request
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOME = os.path.expanduser("~")
INSTALL = os.path.join(HOME, ".local", "share", "grove-opus")
DATA = os.path.join(INSTALL, "data")
KEY = os.path.join(HOME, ".local", "share", "grove-opus-keys", "release")
DAEMON = "127.0.0.1:49120"
WEB = "127.0.0.1:4417"
UNIT = "grove-opus.service"
WEB_UNIT = "grove-opus-web.service"
UNIT_DIR = os.path.join(HOME, ".config", "systemd", "user")
TARGET = "linux-x64"
PAGES_PROJECT = "grove"
PAGES_ORIGIN = "https://grove.choondoggy.com"
# 줄바꿈 없는 current에서 실패하던 기존 Grove launcher의 SHA-256.
PREVIOUS_CLI_LAUNCHER_SHA256 = "8db69f1c9d911f65bdbf01a8a5ded011879422a3973003816123ff69fee14424"
BUSY_KEYS = {"active_turns", "awaiting_approval", "running_tasks", "running_terminals", "schedules_within_10m", "running_schedule_runs"}

RUN_SH = f"""#!/bin/sh
# grove-opus.service 진입점: current 포인터의 release를 실행한다(deploy_local.py가 생성).
set -eu
R="{INSTALL}"
id=$(cat "$R/current")
export GROVE_WEB_DIR="$R/releases/$id/web"
exec "$R/releases/$id/grove" serve --listen {DAEMON} --data-dir "{DATA}" --log-file "$R/logs/server.log"
"""

DAEMON_UNIT = f"""[Unit]
Description=Grove daemon ({DAEMON})

[Service]
Type=simple
ExecStart={INSTALL}/run.sh
Restart=on-failure
RestartSec=3
TimeoutStopSec=60

[Install]
WantedBy=default.target
"""

NGINX_CONF = f"""# 브라우저 진입점 {WEB} → 데몬 {DAEMON}. Host·Origin을 그대로 넘겨 데몬의 same-origin 검사를 유지한다.
worker_processes 1;
pid {INSTALL}/web-proxy/nginx.pid;
error_log {INSTALL}/logs/web-proxy.log warn;
events {{ worker_connections 256; }}
http {{
    access_log off;
    client_body_temp_path {INSTALL}/web-proxy/tmp/body;
    proxy_temp_path {INSTALL}/web-proxy/tmp/proxy;
    fastcgi_temp_path {INSTALL}/web-proxy/tmp/fastcgi;
    uwsgi_temp_path {INSTALL}/web-proxy/tmp/uwsgi;
    scgi_temp_path {INSTALL}/web-proxy/tmp/scgi;
    client_max_body_size 0;
    map $http_upgrade $connection_upgrade {{ default upgrade; '' close; }}
    server {{
        listen {WEB};
        location / {{
            proxy_pass http://{DAEMON};
            proxy_http_version 1.1;
            proxy_set_header Host $http_host;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_buffering off;
            proxy_request_buffering off;
            proxy_read_timeout 3600s;
            proxy_send_timeout 3600s;
        }}
    }}
}}
"""

WEB_UNIT_TEXT = f"""[Unit]
Description=Grove browser entry ({WEB} -> {DAEMON})
After={UNIT}

[Service]
Type=simple
ExecStart=/usr/sbin/nginx -p {INSTALL}/web-proxy -e {INSTALL}/logs/web-proxy.log -c {INSTALL}/web-proxy/nginx.conf -g "daemon off;"
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
"""


def run(cmd, **kw):
    print("$", " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=True, **kw)


def write(path, text, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def grove_bin():
    cur = open(os.path.join(INSTALL, "current")).read().strip()
    return os.path.join(INSTALL, "releases", cur, "grove")


def package():
    run([sys.executable, os.path.join(REPO, "scripts", "build.py"), "package", "--targets", TARGET])
    d = os.path.join(REPO, "dist", "release")
    dirs = [os.path.join(d, n) for n in os.listdir(d) if n.endswith("-" + TARGET) and os.path.isfile(os.path.join(d, n, "receipt.json"))]
    pkg = max(dirs, key=lambda p: os.path.getmtime(os.path.join(p, "receipt.json")))
    receipt = json.load(open(os.path.join(pkg, "receipt.json")))
    manifest = json.load(open(os.path.join(pkg, "manifest.json")))
    return os.path.join(pkg, receipt["archive"]), receipt, manifest


def daemon_pids():
    """설치 디렉터리의 release를 serve 모드로 실행 중인 데몬."""
    out = []
    prefix = os.path.join(INSTALL, "releases") + os.sep
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            exe = os.readlink(f"/proc/{pid}/exe")
            if not exe.startswith(prefix):
                continue
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                args = f.read().split(b"\0")
        except OSError:
            continue
        if args[1:2] == [b"serve"]:
            out.append(int(pid))
    return out


def process_info(pid):
    with open(f"/proc/{pid}/status") as f:
        parent = next(int(line.split()[1]) for line in f if line.startswith("PPid:"))
    with open(f"/proc/{pid}/cmdline", "rb") as f:
        args = [os.fsdecode(arg) for arg in f.read().split(b"\0") if arg]
    return parent, args


class DeploymentCaller(NamedTuple):
    turn_id: str
    task_id: str | None = None


def process_task_id(pid):
    # 호출자의 환경이 아닌 설치 데몬 직속 프로세스의 서버 실행 표식을 읽는다.
    with open(f"/proc/{pid}/environ", "rb") as f:
        prefix = b"GROVE_TASK_ID="
        return next((os.fsdecode(entry[len(prefix):]) for entry in f.read().split(b"\0") if entry.startswith(prefix)), None)


def deployment_caller():
    """Grove 셸 실행 기록 또는 외부 CLI의 native 매핑을 실행 중 턴과 대조한다."""
    native = {os.environ[key] for key in ("CODEX_THREAD_ID", "CODEX_SESSION_ID") if os.environ.get(key)}
    pid = os.getpid()
    try:
        daemons = set(daemon_pids())
        for _ in range(64):
            if pid <= 1 or pid in daemons:
                return None
            parent, args = process_info(pid)
            # Claude의 신규 대화와 이어쓰기 모두 공식 CLI 인자에서 식별한다.
            if any(os.path.basename(arg) == "claude" or arg.endswith("/@anthropic-ai/claude-code/cli.js") for arg in args[:2]):
                for flag in ("--session-id", "--resume"):
                    if flag in args and args.index(flag) + 1 < len(args):
                        native.add(args[args.index(flag) + 1])
            if parent in daemons:
                break
            pid = parent
        else:
            return None
        task_id = process_task_id(pid)
        database = Path(DATA, "grove.db").resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(database, uri=True, timeout=2)) as connection:
            if task_id is not None:
                row = connection.execute(
                    "SELECT t.id FROM tasks k JOIN tool_calls c ON c.id=k.call_id AND c.session_id=k.session_id "
                    "JOIN turns t ON t.id=c.turn_id AND t.session_id=c.session_id "
                    "WHERE k.id=? AND k.pid=? AND k.status='running' AND c.name='shell' AND t.status='running'",
                    (task_id, pid),
                ).fetchone()
                if row:
                    return DeploymentCaller(row[0], task_id)
                # 외부 CLI 에이전트도 데몬 소유 프로세스 표식을 받는다. 셸 작업이 아니면 native 매핑으로만 판별한다.
            if not native:
                return None
            rows = connection.execute(
                "SELECT DISTINCT t.id FROM turns t JOIN cli_sessions c ON c.session_id=t.session_id AND c.profile_id=t.profile_id "
                "WHERE t.status='running' AND c.native_id IN (" + ",".join("?" for _ in native) + ")", tuple(native),
            ).fetchall()
        return DeploymentCaller(rows[0][0]) if len(rows) == 1 else None
    except (OSError, StopIteration, ValueError, sqlite3.Error):
        return None


def update_readiness():
    token = Path(DATA, "owner-token").read_text().strip()
    request = urllib.request.Request(f"http://{DAEMON}/api/v1/admin/update-readiness", headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def continuation_api(path, body, key):
    """Local authenticated, idempotent receipt calls; never print credentials or replay deployment."""
    token = Path(DATA, "owner-token").read_text().strip()
    request = urllib.request.Request(f"http://{DAEMON}/api/v1/{path}", data=json.dumps(body).encode(),
                                     headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "Idempotency-Key": key})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def reserve_deployment_report(turn_id, unit):
    try:
        return continuation_api(f"turns/{turn_id}/continuations", {
            "action": "external", "request_id": unit, "delay_seconds": 86400,
            "prompt": "사용자가 요청한 배포의 실제 결과를 확인해서 같은 대화에 보고해줘. 서버·CLI·웹 검증 범위를 구분하고 미완료·실패·결과 불명도 정확히 알려줘. 새 배포나 수정 명령은 실행하지 마.",
        }, unit + "-reserve")["id"]
    except urllib.error.HTTPError as error:
        # First upgrade from a version without this capability: register after cutover.
        if error.code != 404:
            raise
        return None


def report_deployment(directory, request, state, **details):
    """The outer deployment, including Pages verification, owns the completion signal."""
    turn = request.get("turn_id")
    unit = request.get("unit")
    if not turn or not unit:
        return
    try:
        continuation = request.get("continuation_id")
        if not continuation:
            continuation = reserve_deployment_report(turn, unit)
            if not continuation:
                raise RuntimeError("continuations_unavailable")
            request["continuation_id"] = continuation
            write(os.path.join(directory, "request.json"), json.dumps(request, indent=2) + "\n", mode=0o600)
        result = "completed" if state == "applied" else "unknown" if state == "incomplete" else "failed"
        continuation_api(f"continuations/{continuation}/complete", {
            "status": result, "detail": json.dumps({"deployment_state": state, **details}, ensure_ascii=False),
        }, unit + "-complete")
        write(os.path.join(directory, "report.json"), json.dumps({"status": "accepted", "continuation_id": continuation}) + "\n", mode=0o600)
    except Exception as error:
        # Deployment outcome remains intact. A failed callback must never rerun deployment.
        write(os.path.join(directory, "report.json"), json.dumps({"status": "unconfirmed", "error_type": type(error).__name__}) + "\n", mode=0o600)
        print("배포 결과의 AI 보고 접수를 확인하지 못했습니다. report.json과 원래 대화의 후속 작업 상태를 확인하세요", file=sys.stderr)


def work_matches(readiness, active_turns, running_tasks=0):
    if not isinstance(readiness, dict):
        return False
    busy = readiness.get("busy")
    expected = {"active_turns": active_turns, "running_tasks": running_tasks}
    return (isinstance(busy, dict) and BUSY_KEYS.issubset(busy)
            and readiness.get("idle") is (active_turns == 0 and running_tasks == 0)
            and all(type(value) is int and value == expected.get(key, 0) for key, value in busy.items()))


def deployment_state(directory, state, **details):
    write(os.path.join(directory, "state.json"), json.dumps({
        "state": state, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **details,
    }, ensure_ascii=False, indent=2) + "\n", mode=0o600)


def check_archive(archive, receipt):
    with open(archive, "rb") as f:
        digest = hashlib.file_digest(f, "sha256").hexdigest()
    if digest != receipt["archive_sha256"] or os.path.getsize(archive) != receipt["size"]:
        sys.exit("준비한 배포 패키지의 크기·hash가 receipt와 다릅니다")


def queue_deployment(archive, receipt, manifest, turn_id, skip_pages):
    """완성된 패키지만 보관하고 서버 자손이 아닌 systemd user unit으로 인계한다."""
    check_archive(archive, receipt)
    parent = os.path.join(INSTALL, "deployments")
    os.makedirs(parent, mode=0o700, exist_ok=True)
    directory = tempfile.mkdtemp(prefix="deploy-", dir=parent)
    unit = "grove-deploy-" + uuid.uuid4().hex[:12]
    manifest = dict(manifest)
    if not skip_pages and not manifest.get("commit"):
        manifest["commit"] = subprocess.check_output(["git", "-C", REPO, "rev-parse", "HEAD"], text=True).strip()
    for name in ("deploy_local.py", "grove_local.sh"):
        destination = os.path.join(directory, "scripts", name)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        shutil.copyfile(os.path.join(REPO, "scripts", name), destination)
    if not skip_pages:
        dependencies = os.path.join(REPO, "relay", "node_modules")
        if not os.path.isfile(os.path.join(dependencies, ".bin", "wrangler")):
            sys.exit("배포 인계에는 기존 relay/node_modules의 Wrangler가 필요합니다")
        os.makedirs(os.path.join(directory, "relay"))
        os.symlink(os.path.realpath(dependencies), os.path.join(directory, "relay", "node_modules"))
    frozen = os.path.join(directory, os.path.basename(archive))
    shutil.copyfile(archive, frozen)
    check_archive(frozen, receipt)
    request = {"archive": frozen, "receipt": receipt, "manifest": manifest, "turn_id": turn_id,
               "previous_release": Path(INSTALL, "current").read_text().strip(), "skip_pages": skip_pages, "unit": unit}
    request["continuation_id"] = reserve_deployment_report(turn_id, unit)
    write(os.path.join(directory, "request.json"), json.dumps(request, indent=2) + "\n", mode=0o600)
    deployment_state(directory, "waiting_for_turn", unit=unit)
    log = os.path.join(directory, "deployment.log")
    write(log, "", mode=0o600)
    command = ["systemd-run", "--user", "--unit=" + unit, "--collect", "--property=UMask=0077",
               "--property=StandardOutput=append:" + log, "--property=StandardError=inherit", "--working-directory=" + directory,
               "--setenv=PATH=" + os.environ.get("PATH", os.defpath), sys.executable,
               os.path.join(directory, "scripts", "deploy_local.py"), "--resume-deployment", directory]
    try:
        subprocess.run(command, check=True, capture_output=True)
    except (OSError, subprocess.CalledProcessError):
        deployment_state(directory, "failed", reason="handoff_start_failed")
        report_deployment(directory, request, "failed", reason="handoff_start_failed")
        sys.exit("독립 배포 프로세스를 시작하지 못했습니다. 운영 서버는 유지됩니다")
    print(json.dumps({"deployment": "waiting_for_turn", "message": "현재 대화 완료 후 유휴 상태에서 서버·CLI·웹 배포를 이어갑니다",
                      "directory": directory, "unit": unit}, ensure_ascii=False, indent=2))


def wait_for_deployment(request, timeout=1800):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            database = Path(DATA, "grove.db").resolve().as_uri() + "?mode=ro"
            with closing(sqlite3.connect(database, uri=True, timeout=2)) as connection:
                row = connection.execute("SELECT status FROM turns WHERE id=?", (request["turn_id"],)).fetchone()
            if not row or row[0] not in ("queued", "running", "awaiting_approval", "completed"):
                return "caller_not_completed"
            if row[0] == "completed" and work_matches(update_readiness(), 0):
                return None
        except (OSError, ValueError, sqlite3.Error):
            pass
        time.sleep(2)
    return "idle_timeout"


def resume_deployment(directory):
    request = {}
    try:
        request = json.loads(Path(directory, "request.json").read_text())
        reason = wait_for_deployment(request)
        if reason:
            deployment_state(directory, "deferred", reason=reason)
            report_deployment(directory, request, "deferred", reason=reason)
            return 3
        expected = f"{request['manifest']['version']}-{request['receipt']['archive_sha256'][:12]}"
        current = Path(INSTALL, "current").read_text().strip()
        if current not in (request["previous_release"], expected):
            deployment_state(directory, "deferred", reason="operating_release_changed")
            report_deployment(directory, request, "deferred", reason="operating_release_changed")
            return 3
        check_archive(request["archive"], request["receipt"])
        deployment_state(directory, "applying")
        deploy_prepared(request["archive"], request["receipt"], request["manifest"], skip_pages=request["skip_pages"])
        deployment_state(directory, "applied", release=expected, pages=None if request["skip_pages"] else PAGES_ORIGIN)
        report_deployment(directory, request, "applied", release=expected, pages=None if request["skip_pages"] else PAGES_ORIGIN)
        return 0
    except SystemExit as error:
        code = error.code if isinstance(error.code, int) and error.code else 1
        if isinstance(error.code, str):
            print(error.code, file=sys.stderr)
        deployment_state(directory, "deferred" if code == 3 else "incomplete", exit_code=code)
        report_deployment(directory, request, "deferred" if code == 3 else "incomplete", exit_code=code)
        return code
    except Exception as error:
        deployment_state(directory, "incomplete", reason="deployment_failed", error_type=type(error).__name__)
        report_deployment(directory, request, "incomplete", reason="deployment_failed")
        return 1


def port_busy(addr):
    host, port = addr.rsplit(":", 1)
    r = subprocess.run(["ss", "-Hltn", f"sport = :{port}"], capture_output=True, text=True, check=True)
    return any(f"{host}:{port}" in line for line in r.stdout.splitlines())


def http_status(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except OSError:
        return None, b""


def status():
    st, body = http_status(f"http://{DAEMON}/api/v1/health")
    health = json.loads(body) if st == 200 else None
    web, _ = http_status(f"http://{WEB}/")
    proxied, _ = http_status(f"http://{WEB}/api/v1/health")
    pids = daemon_pids()
    out = {
        "daemon": DAEMON, "health": health and {k: health[k] for k in ("status", "version", "schema")},
        "browser": f"http://{WEB}/", "web_status": web, "proxied_health": proxied,
        "daemon_processes": pids, "release": open(os.path.join(INSTALL, "current")).read().strip() if os.path.exists(os.path.join(INSTALL, "current")) else None,
    }
    jobs = sorted(Path(INSTALL, "deployments").glob("deploy-*/state.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:5]
    if jobs:
        out["deployment_jobs"] = [{"directory": str(p.parent), **json.loads(p.read_text())} for p in jobs]
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return out


def signed_manifest(gbin, archive, receipt, manifest):
    rel = {
        "product": manifest["product"], "channel": "stable", "version": manifest["version"],
        "protocol": manifest["protocol"], "schema": manifest["schema"],
        "issued_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "artifacts": {TARGET: {"url": archive, "sha256": receipt["archive_sha256"], "size": receipt["size"]}},
    }
    work = os.path.join(INSTALL, "manifests")
    os.makedirs(work, exist_ok=True)
    unsigned = os.path.join(work, f"release-{receipt['archive_sha256'][:12]}.unsigned.json")
    signed = os.path.join(work, f"release-{receipt['archive_sha256'][:12]}.json")
    json.dump(rel, open(unsigned, "w"), indent=2)
    run([gbin, "release", "sign", "--key", KEY, unsigned, signed], stdout=subprocess.DEVNULL)
    return signed


def first_install(archive):
    for addr in (DAEMON, WEB):
        if port_busy(addr):
            sys.exit(f"{addr}가 이미 사용 중입니다. 다른 서버를 먼저 확인하세요(데몬은 하나만 실행).")
    # 서명 키는 패키지 안의 grove로 만든다(설치 전이라 임시로 풀어서 사용).
    stage = os.path.join(INSTALL + ".stage")
    shutil.rmtree(stage, ignore_errors=True)
    os.makedirs(stage)
    run(["tar", "-xzf", archive, "-C", stage])
    gtmp = next(os.path.join(r, "grove") for r, _, f in os.walk(stage) if "grove" in f)
    if not os.path.exists(KEY):
        os.makedirs(os.path.dirname(KEY), mode=0o700, exist_ok=True)
        run([gtmp, "release", "keygen", KEY], stdout=subprocess.DEVNULL)
    run([gtmp, "install", "--install", INSTALL, "--package", archive, "--data-dir", DATA, "--listen", DAEMON,
         "--trust-key", KEY + ".pub", "--service", f"systemd-user:{UNIT}"])
    shutil.rmtree(stage)
    for sub in ("logs", "web-proxy/tmp"):
        os.makedirs(os.path.join(INSTALL, sub), exist_ok=True)
    write(os.path.join(INSTALL, "run.sh"), RUN_SH, 0o755)
    write(os.path.join(INSTALL, "web-proxy", "nginx.conf"), NGINX_CONF)
    write(os.path.join(UNIT_DIR, UNIT), DAEMON_UNIT)
    write(os.path.join(UNIT_DIR, WEB_UNIT), WEB_UNIT_TEXT)
    run(["systemctl", "--user", "daemon-reload"])
    run(["systemctl", "--user", "enable", "--now", UNIT, WEB_UNIT])


def wait_ready(timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st, _ = http_status(f"http://{WEB}/api/v1/health")
        if st == 200:
            return True
        time.sleep(0.5)
    return False


def wrangler():
    path = os.path.join(REPO, "relay", "node_modules", ".bin", "wrangler")
    if not os.path.exists(path):
        run(["npm", "ci", "--no-audit", "--no-fund"], cwd=os.path.join(REPO, "relay"))
    return path


def fetch(url):
    # Cloudflare는 User-Agent 없는 요청을 403으로 막는다.
    request = urllib.request.Request(url, headers={"User-Agent": "grove-deploy-check/1", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def publish_pages(archive, manifest):
    """설치한 패키지와 같은 웹 자산을 Pages production에 배포하고 사용자 도메인의 제공 자산을 대조한다."""
    stage = tempfile.mkdtemp(prefix="grove-pages-")
    try:
        run(["tar", "-xzf", archive, "-C", stage])
        web = next(os.path.join(root, "web") for root, dirs, _ in os.walk(stage) if "web" in dirs)
        commit = manifest.get("commit") or subprocess.run(["git", "-C", REPO, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        run([wrangler(), "pages", "deploy", web, "--project-name", PAGES_PROJECT, "--branch", "main",
             "--commit-hash", commit[:40], "--commit-message", f"grove {manifest['version']} {manifest['source_hash'][:12]}", "--commit-dirty=true"],
            cwd=stage)  # relay의 Worker용 wrangler.jsonc를 Pages 설정으로 읽지 않게 한다.
        assets = [f for f in manifest["files"] if f["path"].startswith("web/assets/")]
        deadline = time.time() + 120
        while True:
            mismatched = []
            for f in assets:
                try:
                    if hashlib.sha256(fetch(PAGES_ORIGIN + "/" + f["path"][len("web/"):])).hexdigest() != f["sha256"]:
                        mismatched.append(f["path"])
                except OSError:
                    mismatched.append(f["path"])
            if not mismatched:
                break
            if time.time() > deadline:
                sys.exit(f"Pages 사용자 도메인이 새 자산을 제공하지 않습니다: {mismatched[:5]}")
            time.sleep(5)
        # Cloudflare가 분석 스크립트를 덧붙이므로 HTML 전체 대신 패키지 첫 화면이 참조하는 자산을 대조한다.
        with open(os.path.join(web, "index.html")) as f:
            expected = set(re.findall(r'(?:src|href)="(/assets/[^"]+)"', f.read()))
        served = set(re.findall(r'(?:src|href)="(/assets/[^"]+)"', fetch(PAGES_ORIGIN + "/").decode()))
        missing = sorted(expected - served)
        if missing:
            sys.exit(f"Pages 첫 화면이 새 자산을 참조하지 않습니다: {missing[:5]}")
        print(json.dumps({"pages": PAGES_ORIGIN, "assets_verified": len(assets)}, ensure_ascii=False))
    finally:
        shutil.rmtree(stage)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--install-cli", metavar="BINARY", help="검증한 CLI만 설치하고 grove 명령 등록(데몬·웹·DB 변경 없음)")
    ap.add_argument("--force", action="store_true", help="실행 중 작업이 있어도 적용(작업 중단)")
    ap.add_argument("--skip-pages", action="store_true", help="공개 Pages 배포 생략(완료 보고에 미반영으로 표시)")
    ap.add_argument("--resume-deployment", help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a.resume_deployment:
        sys.exit(resume_deployment(os.path.abspath(a.resume_deployment)))
    if a.status:
        status()
        return
    if a.install_cli:
        install_cli(os.path.abspath(a.install_cli))
        return
    archive, receipt, manifest = package()
    current = Path(INSTALL, "current")
    expected = f"{manifest['version']}-{receipt['archive_sha256'][:12]}"
    if not a.force and current.exists() and current.read_text().strip() != expected:
        caller = deployment_caller()
        if caller:
            try:
                readiness = update_readiness()
            except (OSError, ValueError):
                readiness = {}
            if work_matches(readiness, 1, running_tasks=int(caller.task_id is not None)):
                queue_deployment(archive, receipt, manifest, caller.turn_id, a.skip_pages)
                return
    deploy_prepared(archive, receipt, manifest, force=a.force, skip_pages=a.skip_pages)


def deploy_prepared(archive, receipt, manifest, force=False, skip_pages=False):
    if not os.path.exists(os.path.join(INSTALL, "current")):
        first_install(archive)
    else:
        signed = signed_manifest(grove_bin(), archive, receipt, manifest)
        cmd = [grove_bin(), "update", "apply", "--install", INSTALL, "--manifest", signed]
        if force:
            cmd.append("--force")
        r = subprocess.run(cmd, capture_output=True, text=True)
        print(r.stdout.strip() or r.stderr.strip())
        if r.returncode != 0:
            sys.exit(r.returncode)
    if not wait_ready():
        status()
        sys.exit("브라우저 진입점이 준비되지 않았습니다")
    out = status()
    if len(out["daemon_processes"]) != 1:
        sys.exit(f"데몬 프로세스가 {len(out['daemon_processes'])}개입니다(1개여야 함)")
    if out["release"] != f"{manifest['version']}-{receipt['archive_sha256'][:12]}":
        sys.exit(f"운영 release가 새 패키지가 아닙니다(적용 보류 또는 실패): {out['release']}")
    install_cli(grove_bin())
    if skip_pages:
        print("공개 Pages: 미반영(--skip-pages)")
    else:
        publish_pages(archive, manifest)


def install_cli(binary):
    """설치 중인 서비스와 별개인 관리 CLI·launcher를 같은 업데이트 경로에서 제공한다."""
    checked = subprocess.run([binary, "pairing", "--help"], capture_output=True, text=True, check=True)
    if "grove pairing create" not in checked.stdout:
        sys.exit("이 실행 파일에는 승인형 페어링 CLI가 없습니다")
    template = os.path.join(REPO, "scripts", "grove_local.sh")
    launcher = os.path.join(HOME, ".local", "bin", "grove")
    if os.path.lexists(launcher):
        if os.path.islink(launcher):
            sys.exit(f"다른 grove 명령을 덮어쓰지 않았습니다: {launcher}")
        with open(launcher, "rb") as current, open(template, "rb") as expected:
            installed = current.read()
            if installed != expected.read() and hashlib.sha256(installed).hexdigest() != PREVIOUS_CLI_LAUNCHER_SHA256:
                sys.exit(f"다른 grove 명령을 덮어쓰지 않았습니다: {launcher}")
    targets = [(binary, os.path.join(INSTALL, "cli", "grove")), (template, launcher)]
    for source, target in targets:
        parent = os.path.dirname(target)
        os.makedirs(parent, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".grove-cli-", dir=parent)
        os.close(fd)
        try:
            shutil.copyfile(source, temporary)
            os.chmod(temporary, 0o755)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    print(f"CLI 설치 완료: {launcher} (데몬·웹·DB 변경 없음)")


if __name__ == "__main__":
    main()
