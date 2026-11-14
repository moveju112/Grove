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
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import tempfile
import urllib.request

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
    """설치 디렉터리의 release를 실행 중인 grove 프로세스."""
    out = []
    prefix = os.path.join(INSTALL, "releases") + os.sep
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            exe = os.readlink(f"/proc/{pid}/exe")
        except OSError:
            continue
        if exe.startswith(prefix):
            out.append(int(pid))
    return out


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--install-cli", metavar="BINARY", help="검증한 CLI만 설치하고 grove 명령 등록(데몬·웹·DB 변경 없음)")
    ap.add_argument("--force", action="store_true", help="실행 중 작업이 있어도 적용(작업 중단)")
    a = ap.parse_args()
    if a.status:
        status()
        return
    if a.install_cli:
        install_cli(os.path.abspath(a.install_cli))
        return
    archive, receipt, manifest = package()
    if not os.path.exists(os.path.join(INSTALL, "current")):
        first_install(archive)
    else:
        signed = signed_manifest(grove_bin(), archive, receipt, manifest)
        cmd = [grove_bin(), "update", "apply", "--install", INSTALL, "--manifest", signed]
        if a.force:
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
    install_cli(grove_bin())


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
            if current.read() != expected.read():
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
