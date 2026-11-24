#!/usr/bin/env python3
"""Grove 빌드 진입점(BUILD-002). 표준 라이브러리만 쓴다.

    scripts/build.py dev                 # debug 서버 + 웹(개발용, release 최적화 없음)
    scripts/build.py test --rust api     # 선택한 Rust integration target만
    scripts/build.py test --lib --filter config
    scripts/build.py test --vitest app/state/events.test.ts
    scripts/build.py test --e2e e2e/workspace.spec.ts  # debug 서버 + 웹 빌드 후 선택 E2E
    scripts/build.py test --e2e e2e/workspace.spec.ts --e2e-regression  # 기존 timeout·재시도 정책
    scripts/build.py test --full         # 명시적으로 전체 인수 검사
    scripts/build.py plan --changed F..  # 변경 파일 → 영향 범위(서버/웹/protocol/전체/없음)
    scripts/build.py package [--targets linux-x64,linux-arm64,windows-x64] [--dry-run] [--jobs N]
    scripts/build.py package --deb       # 현재 Linux의 압축본 + .deb(설치·배포 없음)

package 동작
- 웹 정적 산출물은 한 번 만들고 모든 target이 같은 bytes를 쓴다(BUILD-017).
- target별 입력 hash가 같고 기존 artifact hash가 receipt와 일치하면 다시 빌드하지 않는다(BUILD-034, 040).
  cache는 속도 수단일 뿐이므로 재사용 전에도 artifact sha256을 다시 계산해 대조한다.
- 산출물: 압축본, manifest.json(version·source hash·target·protocol·schema·파일 hash), SBOM, SHA256SUMS, NOTICE.
- 단계마다 wall/CPU/peak RSS를 build-log.json에 남긴다(BUILD-023).
- 패키지는 임시 위치에 풀어 실제로 실행·health·웹 응답을 확인한다(BUILD-019). 실행할 수 없는 target은 정적 검사만 하고 표시한다.
"""
import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import zipfile

import debian

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEV = os.path.join(ROOT, ".dev")
TARGETS = {
    # 이름: (rust target, 빌드 방식, 실행 파일, 압축 형식)
    "linux-x64": ("x86_64-unknown-linux-gnu", "native", "grove", "tar.gz"),
    "linux-arm64": ("aarch64-unknown-linux-gnu", "zig:aarch64-unknown-linux-gnu.2.31", "grove", "tar.gz"),
    "windows-x64": ("x86_64-pc-windows-gnu", "zig:x86_64-pc-windows-gnu", "grove.exe", "zip"),
}
SERVER_INPUTS = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src", "assets"]
WEB_INPUTS = ["web/package.json", "web/package-lock.json", "web/app", "web/public", "web/scripts", "web/vite.config.ts", "web/react-router.config.ts", "web/tsconfig.json"]
NOTICE_FILES = ["assets/licenses/agent-baseline-LICENSE", "assets/licenses/agent-baseline-NOTICE.md"]


# ---------- 공통 ----------

def env():
    e = dict(os.environ)
    # 공통 환경을 source한 worktree에서는 공유 툴체인을 덮어쓰지 않는다.
    e.setdefault("CARGO_HOME", os.path.join(DEV, "cargo"))
    e.setdefault("RUSTUP_HOME", os.path.join(DEV, "rustup"))
    e["PATH"] = os.pathsep.join([os.path.join(e["CARGO_HOME"], "bin"), os.path.join(DEV, "bin"), os.path.join(DEV, "venv", "bin"), e.get("PATH", "")])
    return e


def files_of(paths):
    out = []
    for p in paths:
        ap = os.path.join(ROOT, p)
        if os.path.isfile(ap):
            out.append(p)
        elif os.path.isdir(ap):
            for d, dirs, fs in os.walk(ap):
                dirs[:] = sorted(x for x in dirs if x not in ("node_modules", "build", ".react-router", "test-results"))
                out += [os.path.relpath(os.path.join(d, f), ROOT) for f in sorted(fs)]
    return sorted(out)


def tree_hash(paths, extra=""):
    h = hashlib.sha256(extra.encode())
    for f in files_of(paths):
        h.update(f.replace(os.sep, "/").encode() + b"\0")
        with open(os.path.join(ROOT, f), "rb") as fh:
            h.update(hashlib.sha256(fh.read()).digest())
    return h.hexdigest()


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


LOG = []


def run(step, cmd, cwd=ROOT, extra_env=None, check=True):
    """명령 실행 + 이 프로세스 트리의 wall/CPU/peak RSS 기록(wait4)."""
    e = env()
    e.update(extra_env or {})
    t0 = time.monotonic()
    p = subprocess.Popen(cmd, cwd=cwd, env=e)
    _, status, ru = os.wait4(p.pid, 0)
    p.returncode = os.waitstatus_to_exitcode(status)
    rec = {"step": step, "cmd": cmd if isinstance(cmd, str) else " ".join(cmd), "wall_s": round(time.monotonic() - t0, 2),
           "cpu_s": round(ru.ru_utime + ru.ru_stime, 2), "peak_rss_mb": round(ru.ru_maxrss / 1024, 1), "exit": p.returncode}
    LOG.append(rec)
    print(f"  · {step}: {rec['wall_s']}s wall, {rec['cpu_s']}s cpu, {rec['peak_rss_mb']}MB peak, exit {p.returncode}", flush=True)
    if check and p.returncode != 0:
        print(f"단계 실패: {step} (exit {p.returncode})", file=sys.stderr, flush=True)
        raise SystemExit(p.returncode if p.returncode > 0 else 128 - p.returncode)
    return p.returncode


def out(cmd):
    return subprocess.run(cmd, cwd=ROOT, env=env(), capture_output=True, text=True, check=True).stdout.strip()


def default_jobs():
    # 병렬도는 CPU와 메모리(작업당 약 2GB)에 맞춘다(BUILD-027).
    cpus = os.cpu_count() or 2
    try:
        mem_gb = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2**30
    except (ValueError, OSError):
        mem_gb = 8
    return max(1, min(cpus, int(mem_gb // 2)))


# ---------- 변경 영향(BUILD-024, 042) ----------

def classify(path):
    p = path.replace(os.sep, "/")
    if p in ("Cargo.lock", "web/package-lock.json", "rust-toolchain.toml", "Cargo.toml", "web/package.json") or p.startswith("scripts/build"):
        return "all"
    if p.endswith(".md") or p.startswith("migration/") or p in ("TODO.md", "THIRD_PARTY_NOTICES.txt"):
        return "none"
    if p == "web/app/api/generated.ts" or p == "src/lib.rs" or p.startswith("tests/ts_bindings"):
        return "protocol"
    if p.startswith(("src/", "assets/", "tests/")):
        return "server"
    if p.startswith("web/"):
        return "web"
    return "all"  # 모르는 파일은 넓게 잡는다


def plan_for(changed):
    kinds = {classify(c) for c in changed}
    kinds.discard("none")
    if not kinds:
        return {"scope": "none", "builds": [], "tests": []}
    if "all" in kinds or "protocol" in kinds or {"server", "web"} <= kinds:
        return {"scope": "all" if "all" in kinds else "protocol", "builds": ["server", "web"], "tests": ["rust", "ts_bindings", "vitest", "e2e"]}
    if "server" in kinds:
        return {"scope": "server", "builds": ["server"], "tests": ["rust", "ts_bindings", "e2e"]}
    return {"scope": "web", "builds": ["web"], "tests": ["vitest", "e2e"]}


# ---------- 명령 ----------

def cmd_dev(_a):
    run("server debug build", ["cargo", "build"])
    run("web build", ["npm", "run", "build"], cwd=os.path.join(ROOT, "web"))


def test_steps(a):
    """범위를 추측해 전체로 넓히지 않고, 요청한 검사만 실행한다."""
    if a.e2e_regression and not a.e2e:
        raise ValueError("--e2e-regression에는 --e2e FILE이 필요합니다 (--full은 기존 정책 사용)")
    if a.full and (a.rust or a.lib or a.filter or a.vitest or a.e2e or a.typecheck or a.relay_e2e is not None):
        raise ValueError("--full과 선택 검사 옵션은 함께 사용할 수 없습니다")
    if a.filter and not (a.rust or a.lib):
        raise ValueError("--filter에는 --rust 또는 --lib가 필요합니다")
    if not (a.full or a.rust or a.lib or a.vitest or a.e2e or a.typecheck or a.relay_e2e is not None):
        raise ValueError("검사 범위를 지정하세요: --rust TARGET, --lib, --vitest FILE, --e2e FILE, --relay-e2e [FILE], --typecheck 또는 --full")
    steps = []
    web = os.path.join(ROOT, "web")
    if a.full or a.rust or a.lib:
        cmd = ["cargo", "test"]
        if a.full:
            cmd += ["--no-fail-fast"]
        else:
            if a.lib:
                cmd += ["--lib"]
            for target in a.rust or []:
                cmd += ["--test", target]
            if a.filter:
                cmd += [a.filter]
        steps.append(("rust tests", cmd, ROOT))
    if a.full or a.typecheck:
        steps.append(("typecheck", ["npm", "run", "typecheck"], web))
    if a.full or a.vitest:
        steps.append(("vitest", ["npx", "vitest", "run", *(a.vitest or [])], web))
    if a.full or a.e2e:
        steps += [
            ("server debug build", ["cargo", "build", "--bin", "grove"], ROOT),
            ("web build", ["npm", "run", "build"], web),
            ("e2e", ["npx", "playwright", "test", *(a.e2e or [])], web),
        ]
    if a.relay_e2e is not None:
        # 폰과 같은 relay 경로. 기본은 로컬 스택, GROVE_RELAY_STATE를 주면 그 대상(스테이징)을 시험한다.
        if not any(step[0] == "server debug build" for step in steps):
            steps += [("server debug build", ["cargo", "build", "--bin", "grove"], ROOT), ("web build", ["npm", "run", "build"], web)]
        steps.append(("relay e2e", ["npx", "playwright", "test", "-c", "playwright.relay.config.ts", *a.relay_e2e], web))
    return steps


def cmd_test(a):
    try:
        steps = test_steps(a)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        raise SystemExit(2) from e
    if a.dry_run:
        for name, cmd, _ in steps:
            mode = f"GROVE_E2E_FAST={int(not a.full and not a.e2e_regression)} " if name == "e2e" else ""
            print(f"{name}: {mode}{shlex.join(cmd)}")
        return
    for index, (name, cmd, cwd) in enumerate(steps):
        try:
            if name == "e2e":
                metadata = json.loads(out(["cargo", "metadata", "--no-deps", "--format-version", "1"]))
                binary = os.path.join(metadata["target_directory"], "debug", "grove.exe" if os.name == "nt" else "grove")
                # Chrome 소켓 경로 한도를 지키고, 부모의 오래된 GROVE_BIN은 사용하지 않는다.
                with tempfile.TemporaryDirectory(prefix="gpw-", dir="/tmp") as tmp:
                    run(name, cmd, cwd=cwd, extra_env={
                        "TMPDIR": tmp, "GROVE_BIN": binary,
                        "GROVE_E2E_FAST": str(int(not a.full and not a.e2e_regression)),
                    })
            elif name == "relay e2e":
                # Chrome 소켓 경로 한도 때문에 짧은 TMPDIR을 쓴다(일반 e2e와 같은 이유).
                with tempfile.TemporaryDirectory(prefix="gpr-", dir="/tmp") as tmp:
                    run(name, cmd, cwd=cwd, extra_env={"TMPDIR": tmp})
            else:
                run(name, cmd, cwd=cwd)
        except (SystemExit, subprocess.CalledProcessError, OSError):
            remaining = ", ".join(step[0] for step in steps[index + 1:]) or "없음"
            print(f"검증 중단: {name}. 미실행: {remaining}", flush=True)
            raise
    print("지정한 검사 단계가 모두 통과했습니다. 미선택 검사는 실행하지 않았습니다.", flush=True)


def cmd_bench(a):
    """빌드 시간 기준선(PERF-003, 020). 파일 내용은 바꾸지 않고 수정 시각만 갱신해 재빌드를 유도한다."""
    web = os.path.join(ROOT, "web")
    cold_dir = tempfile.mkdtemp(prefix="gcold-", dir="/tmp")
    res = {}

    def step(name, cmd, cwd=ROOT, extra=None):
        run(name, cmd, cwd=cwd, extra_env=extra)
        res[name] = LOG[-1]

    def touch(rel):
        p = os.path.join(ROOT, rel)
        os.utime(p, None)

    try:
        step("cold_server_debug", ["cargo", "build", "--locked"], extra={"CARGO_TARGET_DIR": cold_dir})
        step("cold_web", ["npm", "run", "build"], cwd=web)
        step("warm_server_nochange", ["cargo", "build", "--locked"])
        touch("src/titles.rs")
        step("server_one_file", ["cargo", "build", "--locked"])
        touch("web/app/components/SearchPanel.tsx")
        step("ui_one_file_web", ["npm", "run", "build"], cwd=web)
        step("ui_one_file_server_check", ["cargo", "build", "--locked"])  # UI 변경 뒤 서버는 재컴파일 없음이어야 한다
        touch("src/lib.rs")
        step("protocol_server", ["cargo", "build", "--locked"])
        step("protocol_bindings", ["cargo", "test", "--locked", "--test", "ts_bindings"])
        step("protocol_web", ["npm", "run", "build"], cwd=web)
    finally:
        shutil.rmtree(cold_dir, ignore_errors=True)
    os.makedirs(os.path.join(ROOT, "dist", "perf"), exist_ok=True)
    out_p = os.path.join(ROOT, "dist", "perf", time.strftime("build-%Y%m%dT%H%M%SZ.json", time.gmtime()))
    json.dump({"jobs": default_jobs(), "cpu": os.cpu_count(), "steps": res}, open(out_p, "w"), indent=2, ensure_ascii=False)
    print(f"저장: {os.path.relpath(out_p, ROOT)}")


def cmd_plan(a):
    print(json.dumps(plan_for(a.changed), ensure_ascii=False, indent=2))


def build_web(dist, dry):
    h = tree_hash(WEB_INPUTS)
    cache = os.path.join(dist, "web", h)
    if os.path.isfile(os.path.join(cache, "receipt.json")):
        r = json.load(open(os.path.join(cache, "receipt.json")))
        if r.get("tree") == dir_hash(os.path.join(cache, "client")):
            print(f"웹: 재사용 {h[:12]}")
            return cache, h, True
    if dry:
        return cache, h, False
    run("web build", ["npm", "run", "build"], cwd=os.path.join(ROOT, "web"))
    shutil.rmtree(cache, ignore_errors=True)
    shutil.copytree(os.path.join(ROOT, "web", "build", "client"), os.path.join(cache, "client"))
    json.dump({"inputs": h, "tree": dir_hash(os.path.join(cache, "client"))}, open(os.path.join(cache, "receipt.json"), "w"))
    return cache, h, False


def dir_hash(d):
    h = hashlib.sha256()
    for base, dirs, fs in os.walk(d):
        dirs.sort()
        for f in sorted(fs):
            p = os.path.join(base, f)
            h.update(os.path.relpath(p, d).replace(os.sep, "/").encode() + b"\0" + sha256(p).encode())
    return h.hexdigest()


def remap_flags():
    # 개인 경로가 바이너리 문자열(panic 위치 등)에 남지 않게 한다(BUILD-033).
    pairs = [(ROOT, "/grove"), (os.path.join(DEV, "cargo"), "/cargo"), (os.path.join(DEV, "rustup"), "/rustup"), (os.path.expanduser("~"), "/home")]
    return " ".join(f"--remap-path-prefix={a}={b}" for a, b in pairs)


def build_server(name, jobs):
    triple, how, exe, _ = TARGETS[name]
    extra = {"RUSTFLAGS": remap_flags(), "CARGO_BUILD_JOBS": str(jobs)}
    if how == "native":
        run(f"server release {name}", ["cargo", "build", "--release", "--locked", "--target", triple], extra_env=extra)
    else:
        run(f"server release {name}", ["cargo", "zigbuild", "--release", "--locked", "--target", how.split(":", 1)[1]], extra_env=extra)
    target_dir = json.loads(out(["cargo", "metadata", "--no-deps", "--format-version", "1"]))["target_directory"]
    return os.path.join(target_dir, triple, "release", exe)


# 실제 비밀값 형식만 찾는다(접두어 상수·파일 이름 같은 형식 정의는 비밀이 아니다).
SECRET_PATTERNS = [
    rb"-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----",
    rb"sk-ant-[A-Za-z0-9_-]{20,}",
    rb"sk-(?:proj-)?[A-Za-z0-9]{32,}",
    # GitHub classic PAT는 접두어 뒤 정확히 36자다. 인접 문자열이 병합된 rodata 오탐을 막는다.
    rb"ghp_[A-Za-z0-9]{36}(?![A-Za-z0-9])",
    rb"AKIA[0-9A-Z]{16}",
    rb"grv_[0-9a-f-]{8,}\.[A-Za-z0-9_-]{20,}",
]


def scan(stage):
    """비밀정보·개인 경로·개발 산출물 검사(BUILD-033). 문제가 있으면 목록을 돌려준다."""
    bad = []
    personal = [ROOT.encode(), DEV.encode(), os.path.expanduser("~").encode()]
    for base, _, fs in os.walk(stage):
        for f in fs:
            p = os.path.join(base, f)
            rel = os.path.relpath(p, stage)
            if f.endswith((".map", ".log", ".db", ".db-wal", ".env")) or f.startswith(".env"):
                bad.append(f"{rel}: 개발 파일")
                continue
            data = open(p, "rb").read()
            for s in personal:
                if s in data:
                    bad.append(f"{rel}: 개인 경로 {s.decode()}")
            for pat in SECRET_PATTERNS:
                if re.search(pat, data):
                    bad.append(f"{rel}: 비밀정보 패턴 {pat.decode()}")
    return bad


def sbom(target):
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    import check_licenses as cl  # noqa: E402

    comps = [{"type": "library", "name": n, "version": v, "licenses": [{"expression": l}], "purl": f"pkg:cargo/{n}@{v}"} for n, v, l in cl.cargo(target)]
    comps += [{"type": "library", "name": n, "version": v, "licenses": [{"expression": l}], "purl": f"pkg:npm/{n}@{v}"} for n, v, l in cl.npm()]
    bad = [c for c in comps if not cl.ok(c["licenses"][0]["expression"])]
    if bad:
        raise SystemExit(f"허용 목록 밖 라이선스: {[(c['name'], c['licenses']) for c in bad]}")
    return {"bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1, "components": sorted(comps, key=lambda c: c["purl"])}


def verify_package(name, archive, manifest, deb=False):
    """압축을 풀어 실제로 실행해 본다. 실행 불가 target은 이유를 남긴다."""
    triple, _, exe, fmt = TARGETS[name]
    runner = None
    if name == "linux-x64" and os.uname().machine == "x86_64":
        runner = []
    elif name == "linux-arm64" and os.uname().machine == "aarch64":
        runner = []
    elif name == "windows-x64" and shutil.which("wine"):
        runner = ["wine"]
    if runner is None:
        return {"executed": False, "reason": f"이 머신({os.uname().machine})에서 {name} 실행 불가: 해당 플랫폼에서 검증 필요"}
    tmp = tempfile.mkdtemp(prefix="gverify-", dir="/tmp")
    proc = None
    try:
        if deb:
            subprocess.run(["dpkg-deb", "--extract", archive, tmp], check=True)
        elif fmt == "zip":
            zipfile.ZipFile(archive).extractall(tmp)
        else:
            with tarfile.open(archive) as t:
                t.extractall(tmp, filter="data")
        top = os.path.join(tmp, "usr", "lib", "grove") if deb else os.path.join(tmp, os.listdir(tmp)[0])
        binp = os.path.join(tmp, "usr", "bin", "grove") if deb else os.path.join(top, exe)
        os.chmod(binp, 0o755)
        e = env()
        if runner:
            e["WINEPREFIX"] = os.path.join(tmp, "wine")
            e["WINEDEBUG"] = "-all"
        v = json.loads(subprocess.run(runner + [binp, "version", "--json"], env=e, capture_output=True, text=True, timeout=120).stdout.strip().splitlines()[-1])
        if (v["version"], v["protocol"], v["schema"]) != (manifest["version"], manifest["protocol"], manifest["schema"]):
            raise SystemExit(f"{name}: 실행 파일 버전 정보가 manifest와 다릅니다: {v}")
        data = os.path.join(tmp, "data")
        port = 17900 + list(TARGETS).index(name)
        e["GROVE_DATA_DIR"] = ("Z:" + data) if runner else data
        e.pop("GROVE_WEB_DIR", None)  # 패키지 안의 web/를 스스로 찾아야 한다
        proc = subprocess.Popen(runner + [binp, "serve", "--listen", f"127.0.0.1:{port}"], env=e, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        health, web = None, None
        for _ in range(90):
            try:
                health = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/api/v1/health", timeout=2).read())
                web = urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2).status
                break
            except Exception:
                time.sleep(1)
        if not health or health.get("status") != "ready" or web != 200:
            raise SystemExit(f"{name}: 패키지 실행 검증 실패(health={health}, web={web})")
        return {"executed": True, "runner": runner[0] if runner else "native", "health": health, "web_status": web}
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(20)
            except subprocess.TimeoutExpired:
                proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)


def add_deb(receipt, rdir, name, revision):
    inputs = tree_hash(debian.INPUTS, f"{receipt['archive_sha256']}:{revision}")
    previous = receipt.get("deb", {})
    path = os.path.join(rdir, previous.get("file", ""))
    if previous.get("inputs") == inputs and os.path.isfile(path) and sha256(path) == previous.get("sha256"):
        print(f"{name}: .deb hash 일치 → 재사용")
        return
    result = debian.package(os.path.join(rdir, receipt["archive"]), rdir, name, receipt["version"], revision)
    manifest = json.load(open(os.path.join(rdir, "manifest.json")))
    result["verify"] = verify_package(name, os.path.join(rdir, result["file"]), manifest, deb=True)
    result["inputs"] = inputs
    receipt["deb"] = result
    json.dump(receipt, open(os.path.join(rdir, "receipt.json"), "w"), indent=2, ensure_ascii=False)
    sums = [receipt["archive"], "manifest.json", "sbom.cdx.json", result["file"]]
    with open(os.path.join(rdir, "SHA256SUMS"), "w") as stream:
        for filename in sorted(sums):
            stream.write(f"{sha256(os.path.join(rdir, filename))}  {filename}\n")


def require_unchanged_sources(server_inputs, web_inputs, toolchain, node):
    if tree_hash(SERVER_INPUTS, toolchain) != server_inputs or tree_hash(WEB_INPUTS, node) != web_inputs:
        raise SystemExit("빌드 중 소스가 변경되었습니다. 성공 receipt를 발행하지 않습니다. 고정된 소스 복사본에서 다시 빌드하세요")


def cmd_package(a):
    names = a.targets.split(",") if a.targets else (["linux-arm64" if os.uname().machine == "aarch64" else "linux-x64"] if a.deb else list(TARGETS))
    for n in names:
        if n not in TARGETS:
            raise SystemExit(f"알 수 없는 target: {n} (가능: {', '.join(TARGETS)})")
    if a.deb:
        debian.validate(names, a.deb_revision)
    version = next(l.split('"')[1] for l in open(os.path.join(ROOT, "Cargo.toml")) if l.startswith("version"))
    toolchain = out(["rustc", "-V"])
    node = out(["node", "-v"])
    server_h = tree_hash(SERVER_INPUTS, toolchain)
    web_h = tree_hash(WEB_INPUTS, node)
    source_h = hashlib.sha256((server_h + web_h).encode()).hexdigest()
    dist = os.path.join(ROOT, "dist")
    jobs = a.jobs or default_jobs()
    plan = []
    for n in names:
        inputs = tree_hash(["scripts/build.py"], f"{server_h}{web_h}{n}{TARGETS[n]}")
        rdir = os.path.join(dist, "release", f"grove-{version}-{n}")
        receipt = os.path.join(rdir, "receipt.json")
        reuse = False
        if os.path.isfile(receipt):
            r = json.load(open(receipt))
            arch = os.path.join(rdir, r.get("archive", ""))
            reuse = r.get("inputs") == inputs and os.path.isfile(arch) and sha256(arch) == r.get("archive_sha256")
        plan.append({"target": n, "rust_target": TARGETS[n][0], "inputs": inputs, "action": "reuse" if reuse else "build", "dir": os.path.relpath(rdir, ROOT)})
    print(json.dumps({"version": version, "source_hash": source_h, "toolchain": toolchain, "node": node, "jobs": jobs, "targets": plan}, ensure_ascii=False, indent=2))
    if a.dry_run:
        _, wh, wreuse = build_web(dist, True)
        print(f"웹: {'재사용' if wreuse else '빌드'} {wh[:12]} (dry-run: 아무것도 만들지 않음)")
        if a.deb:
            print(f".deb: native Linux, revision={a.deb_revision}, apt 소유·서비스 자동 시작 없음")
        return
    if all(p["action"] == "reuse" for p in plan):
        if a.deb:
            for p in plan:
                rdir = os.path.join(ROOT, p["dir"])
                receipt = json.load(open(os.path.join(rdir, "receipt.json")))
                add_deb(receipt, rdir, p["target"], a.deb_revision)
        print("압축본 재사용: .deb 준비 완료" if a.deb else "변경 없음: 빌드·패키징을 하지 않습니다(BUILD-026)")
        return
    os.makedirs(dist, exist_ok=True)
    web_dir, web_inputs, _ = build_web(dist, False)
    # 버전 정보는 호스트 target 실행 파일에서 읽는다(같은 소스). 호스트 target 빌드와 같은 경로·옵션이라 cache를 공유한다.
    host = next(l.split(": ", 1)[1] for l in out(["rustc", "-vV"]).splitlines() if l.startswith("host: "))
    host_name = next((k for k, v in TARGETS.items() if v[0] == host and v[1] == "native"), None)
    if host_name is None:
        raise SystemExit(f"호스트 {host}용 native target 정의가 없습니다")
    host_v = json.loads(out([build_server(host_name, jobs), "version", "--json"]))
    results = []
    for p in plan:
        n = p["target"]
        if p["action"] == "reuse":
            print(f"{n}: 입력·artifact hash 일치 → 재사용")
            results.append(json.load(open(os.path.join(ROOT, p["dir"], "receipt.json"))))
            if a.deb:
                add_deb(results[-1], os.path.join(ROOT, p["dir"]), n, a.deb_revision)
            continue
        print(f"{n}: 빌드")
        binp = build_server(n, jobs)
        rdir = os.path.join(ROOT, p["dir"])
        shutil.rmtree(rdir, ignore_errors=True)
        stage_parent = tempfile.mkdtemp(prefix="gstage-", dir=dist)
        stage = os.path.join(stage_parent, f"grove-{version}-{n}")
        os.makedirs(os.path.join(stage, "licenses"))
        shutil.copy2(binp, os.path.join(stage, TARGETS[n][2]))
        shutil.copytree(os.path.join(web_dir, "client"), os.path.join(stage, "web"))
        for f in NOTICE_FILES:
            shutil.copy2(os.path.join(ROOT, f), os.path.join(stage, "licenses"))
        subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "check_licenses.py"), "--notice", os.path.join(stage, "licenses", "THIRD_PARTY_NOTICES.txt")], env=env(), check=True, capture_output=True)
        cli = f"./{TARGETS[n][2]}"
        with open(os.path.join(stage, "README.txt"), "w", encoding="utf-8") as f:
            f.write(
                f"Grove {version} ({n})\n\n"
                f"압축을 푼 폴더에서 {cli} pairing set-password 로 발급 비밀번호를 설정한 뒤 "
                f"{cli} serve 로 서버를 실행하세요.\n"
                f"다른 터미널에서 같은 폴더를 열고 {cli} pairing create 로 링크를 발급하세요.\n"
                f"브라우저에서 링크를 열고 링크 비밀번호를 입력한 뒤 {cli} pairing list 로 "
                "대기 요청을 확인하세요. 양쪽의 확인 코드가 일치하면 다음 명령으로 승인하세요.\n"
                f"{cli} pairing approve <링크-ID> <요청-ID> <확인-코드>\n"
            )
        bad = scan(stage)
        if bad:
            raise SystemExit(f"{n}: 패키지 검사 실패\n  " + "\n  ".join(bad))
        files = []
        for base, _, fs in os.walk(stage):
            for f in sorted(fs):
                fp = os.path.join(base, f)
                files.append({"path": os.path.relpath(fp, stage).replace(os.sep, "/"), "size": os.path.getsize(fp), "sha256": sha256(fp)})
        manifest = {
            "product": "grove", "version": version, "protocol": host_v["protocol"], "schema": host_v["schema"], "target": n, "rust_target": TARGETS[n][0],
            "source_hash": source_h, "server_inputs": server_h, "web_inputs": web_inputs, "toolchain": toolchain, "node": node,
            "commit": None, "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "files": sorted(files, key=lambda x: x["path"]),
        }
        json.dump(manifest, open(os.path.join(stage, "manifest.json"), "w"), indent=2, ensure_ascii=False)
        os.makedirs(rdir)
        archive = os.path.join(rdir, f"grove-{version}-{n}.{TARGETS[n][3]}")
        if TARGETS[n][3] == "zip":
            with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
                for base, _, fs in os.walk(stage):
                    for f in sorted(fs):
                        fp = os.path.join(base, f)
                        z.write(fp, os.path.relpath(fp, stage_parent))
        else:
            with tarfile.open(archive, "w:gz") as t:
                t.add(stage, arcname=os.path.basename(stage))
        shutil.rmtree(stage_parent)
        json.dump(manifest, open(os.path.join(rdir, "manifest.json"), "w"), indent=2, ensure_ascii=False)
        json.dump(sbom(TARGETS[n][0]), open(os.path.join(rdir, "sbom.cdx.json"), "w"), indent=1)
        verify = verify_package(n, archive, manifest)
        print(f"{n}: 실행 검증 {verify}")
        require_unchanged_sources(server_h, web_h, toolchain, node)
        sums = {os.path.basename(x): sha256(x) for x in [archive, os.path.join(rdir, "manifest.json"), os.path.join(rdir, "sbom.cdx.json")]}
        with open(os.path.join(rdir, "SHA256SUMS"), "w") as f:
            f.writelines(f"{h}  {k}\n" for k, h in sorted(sums.items()))
        receipt = {"target": n, "inputs": p["inputs"], "archive": os.path.basename(archive), "archive_sha256": sums[os.path.basename(archive)],
                   "size": os.path.getsize(archive), "verify": verify, "version": version, "protocol": manifest["protocol"], "schema": manifest["schema"]}
        json.dump(receipt, open(os.path.join(rdir, "receipt.json"), "w"), indent=2, ensure_ascii=False)
        if a.deb:
            add_deb(receipt, rdir, n, a.deb_revision)
        results.append(receipt)
    log = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "jobs": jobs, "steps": LOG, "results": results}
    json.dump(log, open(os.path.join(dist, "build-log.json"), "w"), indent=2, ensure_ascii=False)
    print(json.dumps([{k: r[k] for k in ("target", "archive", "size", "archive_sha256")} | {"executed": r["verify"]["executed"]} for r in results], ensure_ascii=False, indent=2))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Grove 빌드")
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("dev")
    t = sp.add_parser("test")
    t.add_argument("--rust", nargs="+", metavar="TARGET", help="Rust integration test target 이름")
    t.add_argument("--lib", action="store_true", help="Rust library 시험")
    t.add_argument("--filter", help="선택한 Rust 시험의 이름 필터")
    t.add_argument("--vitest", nargs="+", metavar="FILE", help="Vitest 파일")
    t.add_argument("--e2e", nargs="+", metavar="FILE", help="Playwright spec (debug 서버 사용)")
    t.add_argument("--e2e-regression", action="store_true", help="선택 E2E에 기존 timeout·재시도 정책 사용 (기본: 빠른 실패)")
    t.add_argument("--relay-e2e", nargs="*", metavar="FILE", help="relay 경로 시험(로컬 스택, GROVE_RELAY_STATE로 스테이징 지정)")
    t.add_argument("--typecheck", action="store_true")
    t.add_argument("--full", action="store_true", help="전체 Rust·타입·Vitest·Playwright 인수 검사")
    t.add_argument("--dry-run", action="store_true", help="실행 없이 선택한 명령 표시")
    pl = sp.add_parser("plan")
    pl.add_argument("--changed", nargs="*", default=[])
    pk = sp.add_parser("package")
    pk.add_argument("--targets")
    pk.add_argument("--dry-run", action="store_true")
    pk.add_argument("--jobs", type=int)
    pk.add_argument("--deb", action="store_true", help="Linux native .deb도 생성(기본 target: 현재 아키텍처, 설치·배포 없음)")
    pk.add_argument("--deb-revision", default="1", help="Debian packaging revision (기본: 1)")
    sp.add_parser("bench")
    a = ap.parse_args(argv)
    # 하위 도구(라이선스·SBOM 포함)가 모두 저장소 전용 툴체인을 쓰게 한다.
    os.environ.update(env())
    {"dev": cmd_dev, "test": cmd_test, "plan": cmd_plan, "package": cmd_package, "bench": cmd_bench}[a.cmd](a)


if __name__ == "__main__":
    main()
