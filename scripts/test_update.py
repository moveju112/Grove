#!/usr/bin/env python3
"""설치·업데이트 전체 흐름 시험(UPDATE). 일회용 설치 디렉터리·데이터만 쓴다.

소스를 임시 폴더에 복사해 버전·schema가 다른 실제 바이너리를 만든다.
  A = 현재 소스(0.1.0), B = 0.1.1 + migration 1개, C = 0.1.2 + migration 2개 + 웹 누락(readiness 실패 유도)
실행: python3 scripts/test_update.py
"""
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import build  # noqa: E402

ENV = build.env()
TMP = tempfile.mkdtemp(prefix="gupd-", dir="/tmp")
# 빌드 산출물은 실행마다 새로 만들지 않고 저장소 target/(큰 디스크)에서 재사용한다(실행당 수 GB가 /tmp에 쌓이지 않게).
TARGET = os.path.join(ROOT, "target", "update-test")
FAILS = []


def sh(cmd, check=True, **kw):
    r = subprocess.run(cmd, env=ENV, capture_output=True, text=True, **kw)
    if check and r.returncode != 0:
        raise SystemExit(f"실패: {' '.join(map(str, cmd))}\n{r.stdout}\n{r.stderr}")
    return r


def ok(cond, what):
    print(("  ✓ " if cond else "  ✗ ") + what, flush=True)
    if not cond:
        FAILS.append(what)


def variant(name, version, migrations, legacy_log=False):
    """소스 복사본을 버전·migration만 바꿔 debug 빌드한다(의존성은 공용 target에서 재사용)."""
    src = os.path.join(TMP, f"src-{name}")
    os.makedirs(src)
    for p in ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src", "assets"]:
        a = os.path.join(ROOT, p)
        (shutil.copytree if os.path.isdir(a) else shutil.copy2)(a, os.path.join(src, p))
    ct = os.path.join(src, "Cargo.toml")
    t = open(ct).read().replace('version = "0.1.0"', f'version = "{version}"', 1)
    open(ct, "w").write(t)
    st = os.path.join(src, "src", "store.rs")
    s = open(st).read()
    # MIGRATIONS 배열의 끝(마지막 원문 문자열 뒤의 "];"). 마지막 migration 내용에 의존하지 않는다.
    marker = '    "#,\n];'
    assert s.count(marker) == 1, "migration 끝 표식을 찾지 못했습니다"
    extra = "".join(f'    r#"CREATE TABLE {m} (x INTEGER);"#,\n' for m in migrations)
    open(st, "w").write(s.replace(marker, marker[:-3] + extra + "];"))
    if legacy_log:
        # 이전 release 흉내: 기능 목록(CAPABILITIES)에서 로그 회전 표식을 빼고 --log-file을 거부한다.
        # 두 치환 중 하나라도 맞지 않으면 픽스처가 깨진 것이므로 바로 멈춘다.
        lib = os.path.join(src, "src", "lib.rs")
        caps = open(lib).read()
        assert caps.count('    "file_log_rotation_v1",\n') == 1, "CAPABILITIES의 file_log_rotation_v1 줄을 찾지 못했습니다"
        open(lib, "w").write(caps.replace('    "file_log_rotation_v1",\n', ''))
        cli = os.path.join(src, "src", "cli.rs")
        text = open(cli).read()
        arg = '"--log-file" => o.log_file = Some(PathBuf::from(val(&mut it, a)?)),'
        assert text.count(arg) == 1, "--log-file 인수 처리를 찾지 못했습니다"
        open(cli, "w").write(text.replace(arg, '"--log-file" => return Err("legacy fixture: unsupported --log-file".into()),'))
    # 고정한 공용 target의 기존 의존성 cache를 쓴다. 임시 소스 경로 hash마다 새로 컴파일하지 않는다.
    sh(["cargo", "--config", f'build.build-dir="{TARGET}"', "build", "--offline", "--bin", "grove"], cwd=src)
    return os.path.join(TARGET, "debug", "grove")


def package(binary, out, web=True):
    v = json.loads(sh([binary, "version", "--json"]).stdout)
    top = os.path.join(TMP, "stage", f"grove-{v['version']}-{build.TARGETS['linux-x64'][0]}")
    shutil.rmtree(os.path.dirname(top), ignore_errors=True)
    os.makedirs(top)
    shutil.copy2(binary, os.path.join(top, "grove"))
    if web:
        shutil.copytree(os.path.join(ROOT, "web", "build", "client"), os.path.join(top, "web"))
    files = []
    for base, _, fs in os.walk(top):
        for f in fs:
            p = os.path.join(base, f)
            files.append({"path": os.path.relpath(p, top), "size": os.path.getsize(p), "sha256": build.sha256(p)})
    json.dump({"product": "grove", "version": v["version"], "protocol": v["protocol"], "schema": v["schema"], "target": "linux-x64", "files": files}, open(os.path.join(top, "manifest.json"), "w"))
    with tarfile.open(out, "w:gz") as tf:
        tf.add(top, arcname=os.path.basename(top))
    return v


def release(v, archive, key, out, extra=None, tamper=False):
    rel = {"product": "grove", "channel": "stable", "version": v["version"], "protocol": v["protocol"], "schema": v["schema"],
           "issued_at": "2026-11-05T00:00:00Z", "artifacts": {"linux-x64": {"url": archive, "sha256": build.sha256(archive), "size": os.path.getsize(archive)}}}
    rel.update(extra or {})
    unsigned = out + ".unsigned.json"
    json.dump(rel, open(unsigned, "w"))
    sh([A, "release", "sign", "--key", key, unsigned, out])
    if tamper:
        m = json.load(open(out))
        m["signed"]["artifacts"]["linux-x64"]["url"] = "/tmp/evil.tar.gz"
        json.dump(m, open(out, "w"))
    return out


def free_port():
    with socket.socket() as so:
        so.bind(("127.0.0.1", 0))
        return so.getsockname()[1]


def api(method, path, body=None):
    tok = open(os.path.join(DATA, "owner-token")).read().strip()
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/api/v1{path}", method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"authorization": f"Bearer {tok}", "content-type": "application/json", "idempotency-key": str(time.time_ns())})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read() or b"null")


def health():
    try:
        return json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/v1/health", timeout=2).read())
    except Exception:
        return None


def upd(*args):
    r = subprocess.run([A, *args, "--install", INST], env=ENV, capture_output=True, text=True)
    try:
        body = json.loads(r.stdout) if r.stdout.strip() else None
    except json.JSONDecodeError:
        body = r.stdout
    return r.returncode, body, r.stderr


try:
    ENV["CARGO_TARGET_DIR"] = TARGET
    print("빌드: A·B·C(debug, 공용 target)", flush=True)
    A_src = variant("a", "0.1.0", [], legacy_log=True)
    A = os.path.join(TMP, "grove-a")
    shutil.copy2(A_src, A)
    B = variant("b", "0.1.1", ["update_probe_b"])
    shutil.copy2(B, os.path.join(TMP, "grove-b"))
    B = os.path.join(TMP, "grove-b")
    C = variant("c", "0.1.2", ["update_probe_b", "update_probe_c"])
    shutil.copy2(C, os.path.join(TMP, "grove-c"))
    C = os.path.join(TMP, "grove-c")
    D = variant("d", "0.1.3", ["update_probe_b", "update_probe_d"])
    shutil.copy2(D, os.path.join(TMP, "grove-d"))
    D = os.path.join(TMP, "grove-d")
    pa, pb, pc, pd_ = (os.path.join(TMP, f"{n}.tar.gz") for n in "abcd")
    va, vb, vc = package(A, pa), package(B, pb), package(C, pc, web=False)
    vd = package(D, pd_)
    ok((vb["schema"], vc["schema"]) == (va["schema"] + 1, va["schema"] + 2), f"schema A/B/C = {va['schema']}/{vb['schema']}/{vc['schema']}")

    keydir = os.path.join(TMP, "keys")
    os.makedirs(keydir)
    sh([A, "release", "keygen", os.path.join(keydir, "k1")])
    k1 = os.path.join(keydir, "k1")
    sh([A, "release", "keygen", os.path.join(keydir, "evil")])
    mb = release(vb, pb, k1, os.path.join(TMP, "mb.json"))
    mc = release(vc, pc, k1, os.path.join(TMP, "mc.json"))
    ma = release(va, pa, k1, os.path.join(TMP, "ma.json"))
    m_tamper = release(vb, pb, k1, os.path.join(TMP, "mt.json"), tamper=True)
    m_evil = release(vb, pb, os.path.join(keydir, "evil"), os.path.join(TMP, "me.json"))
    bad_hash = os.path.join(TMP, "bad.tar.gz")
    shutil.copy2(pb, bad_hash)
    m_badhash = release(vb, pb, k1, os.path.join(TMP, "mbh.json"))
    j = json.load(open(m_badhash))
    j["signed"]["artifacts"]["linux-x64"]["url"] = bad_hash
    with open(bad_hash, "ab") as f:
        f.write(b"x")

    INST = os.path.join(TMP, "install")
    DATA = os.path.join(TMP, "data")
    PORT = free_port()

    print("새 설치", flush=True)
    r = subprocess.run([A, "install", "--install", INST, "--package", pa, "--data-dir", DATA, "--listen", f"127.0.0.1:{PORT}", "--trust-key", k1 + ".pub"], env=ENV, capture_output=True, text=True)
    ok(r.returncode == 0, f"install: {r.stdout.strip()[:120]} {r.stderr.strip()[:200]}")
    r2 = subprocess.run([A, "install", "--install", INST, "--package", pa, "--data-dir", DATA, "--listen", f"127.0.0.1:{PORT}"], env=ENV, capture_output=True, text=True)
    ok(r2.returncode != 0 and "이미 설치" in r2.stderr, "중복 설치 거부")
    upd("start")
    for _ in range(100):
        if health():
            break
        time.sleep(0.1)
    ok((health() or {}).get("version") == "0.1.0", "A 실행")
    log_path = os.path.join(INST, "logs", "server.log")
    ok(os.path.isfile(log_path), "이전 release의 stderr 파일 로그 시작 호환")
    pid_a = open(os.path.join(INST, "server.pid")).read()
    code, _, err = upd("start")
    ok(code != 0 and "이미 응답" in err and open(os.path.join(INST, "server.pid")).read() == pid_a,
       "중복 시작은 기존 process·PID·로그를 교체하지 않음")

    print("확인(무중단)", flush=True)
    code, c, _ = upd("update", "check", "--manifest", mb)
    ok(code == 0 and c["kind"] == "upgrade" and c["available"] == "0.1.1", f"check upgrade: {c}")
    ok((health() or {}).get("version") == "0.1.0", "확인 중 서비스 유지")
    code, c, _ = upd("update", "check", "--manifest", ma)
    ok(c["kind"] == "same", "같은 버전 판정")

    print("서명·hash 거부", flush=True)
    code, _, err = upd("update", "apply", "--manifest", m_tamper)
    ok(code != 0 and "서명" in err, f"변조 manifest 거부: {err.strip()[:80]}")
    code, _, err = upd("update", "apply", "--manifest", m_evil)
    ok(code != 0 and "서명" in err, "신뢰하지 않는 키 거부")
    json.dump(j, open(m_badhash, "w"))  # 서명 뒤 url 변경 = 변조
    code, _, err = upd("update", "apply", "--manifest", m_badhash)
    ok(code != 0, "서명 뒤 바뀐 url 거부")
    m_badhash2 = release(vb, bad_hash, k1, os.path.join(TMP, "mbh2.json"))
    jj = json.load(open(m_badhash2))
    # 서명은 원래 파일 hash로, 실제 파일은 손상: hash 불일치
    jj["signed"]["artifacts"]["linux-x64"]["sha256"] = build.sha256(pb)
    jj["signed"]["artifacts"]["linux-x64"]["size"] = os.path.getsize(pb)
    json.dump(jj["signed"], open(os.path.join(TMP, "mbh2.unsigned.json"), "w"))
    sh([A, "release", "sign", "--key", k1, os.path.join(TMP, "mbh2.unsigned.json"), m_badhash2])
    code, _, err = upd("update", "apply", "--manifest", m_badhash2)
    ok(code != 0 and "hash" in err, f"다운로드 hash 불일치 거부: {err.strip()[:80]}")
    ok((health() or {}).get("version") == "0.1.0" and open(os.path.join(INST, "server.pid")).read() == pid_a, "거부된 시도는 서비스를 건드리지 않음")

    print("실행 중 작업이 있으면 보류", flush=True)
    proj = os.path.join(TMP, "proj")
    os.makedirs(proj)
    pid = api("POST", "/projects", {"root_path": proj})["id"]
    term = api("POST", f"/projects/{pid}/terminals", {"name": "t"})
    code, rc, _ = upd("update", "apply", "--manifest", mb)
    ok(code == 3 and rc["status"] == "deferred" and rc["busy"]["running_terminals"] == 1, f"보류: {rc and rc.get('busy')}")
    ok((health() or {}).get("version") == "0.1.0", "보류 중 서비스 유지")
    api("POST", f"/terminals/{term['id']}/kill", {})

    print("적용", flush=True)
    for _ in range(50):
        if api("GET", "/admin/update-readiness")["idle"]:
            break
        time.sleep(0.2)
    # 이전 append 로그가 이미 꽉 찼어도 새 writer가 잘라 보관하고 시작한다.
    with open(log_path, "ab") as f:
        f.truncate(2 * 1024 * 1024)
    code, rc, err = upd("update", "apply", "--manifest", mb)
    ok(code == 0 and rc["status"] == "applied", f"B 적용: {rc and rc.get('status')} {err.strip()[:200]}")
    h = health() or {}
    ok(h.get("version") == "0.1.1" and h.get("schema") == vb["schema"], f"B 실행 {h}")
    ok(rc and rc.get("downtime_ms", 10**9) < 30000, f"중단 시간 {rc and rc.get('downtime_ms')}ms")
    ok(api("GET", f"/projects/{pid}")["id"] == pid, "기존 데이터 유지")
    ok(os.path.getsize(log_path + ".1") == 2 * 1024 * 1024 and os.path.getsize(log_path) < 2 * 1024 * 1024,
       "기존 append 로그에서 회전 로그로 전환")
    notes = api("GET", "/notifications")
    ok(any("업데이트 완료" in n["title"] for n in notes["items"]), "결과 알림(영속)")
    ups = api("GET", "/updates")
    ok(any(u["status"] == "applied" for u in ups["items"]) and any(u["status"] == "deferred" for u in ups["items"]), "/updates 이력 조회")

    print("이미 적용됨", flush=True)
    pid_b = open(os.path.join(INST, "server.pid")).read()
    code, rc, _ = upd("update", "apply", "--manifest", mb)
    ok(code == 0 and rc["status"] == "already" and open(os.path.join(INST, "server.pid")).read() == pid_b, "재시도는 아무것도 반복하지 않음")

    print("다운그레이드", flush=True)
    code, _, err = upd("update", "apply", "--manifest", ma)
    ok(code != 0 and "다운그레이드" in err, "플래그 없는 다운그레이드 거부")
    code, _, err = upd("update", "apply", "--manifest", ma, "--allow-downgrade")
    ok(code != 0 and "schema" in err, "schema 다운그레이드 거부")
    ok((health() or {}).get("version") == "0.1.1", "거부 후 서비스 유지")

    print("동시 업데이트", flush=True)
    import fcntl
    lf = open(os.path.join(INST, "update.lock"), "a")
    fcntl.flock(lf, fcntl.LOCK_EX)
    code, _, err = upd("update", "apply", "--manifest", mc)
    ok(code != 0 and "진행 중" in err, "lock 중 거부")
    fcntl.flock(lf, fcntl.LOCK_UN)
    lf.close()

    print("고장 버전 → 복구", flush=True)
    code, rc, err = upd("update", "apply", "--manifest", mc, "--ready-timeout", "10")
    ok(code == 4 and rc["status"] == "rolled_back" and rc.get("restored_snapshot") is True, f"C 실패 후 되돌림: {rc and (rc.get('status'), rc.get('message'))}")
    h = health() or {}
    ok(h.get("version") == "0.1.1" and h.get("schema") == vb["schema"], f"B로 복귀 {h}")
    ok(api("GET", f"/projects/{pid}")["id"] == pid, "복구 후 데이터 유지")
    st = json.loads(subprocess.run([A, "update", "status", "--install", INST], env=ENV, capture_output=True, text=True).stdout)
    ok(st["state"]["state"] == "idle", f"상태 idle: {st['state']['state']}")
    failed = [d for d in os.listdir(os.path.join(INST, "backups")) if d.startswith("failed-")]
    ok(len(failed) == 1, "실패한 DB 보관")

    print("강제 적용(중단 대상 명시)", flush=True)
    md = release(vd, pd_, k1, os.path.join(TMP, "md.json"))
    term2 = api("POST", f"/projects/{pid}/terminals", {"name": "t2"})
    code, rc, err = upd("update", "apply", "--manifest", md, "--force")
    ok(code == 0 and rc["status"] == "applied", f"D 강제 적용: {rc and rc.get('status')}")
    ok("강제 적용" in err and "running_terminals" in err, f"중단 대상 출력: {err.strip()[:120]}")
    t2 = [t for t in api("GET", f"/projects/{pid}/terminals")["terminals"] if t["id"] == term2["id"]]
    # 정상 종료 경로이므로 서버가 터미널을 끝내고 exited로 기록한다(비정상 종료일 때만 lost).
    ok(t2 and t2[0]["status"] in ("exited", "lost"), f"중단된 터미널은 실행 중으로 남지 않음: {t2 and t2[0]['status']}")

    print("수동 되돌리기(schema가 다르면 거부)", flush=True)
    code, _, err = upd("update", "rollback")
    ok(code != 0 and "schema" in err, f"A로 되돌리기 거부: {err.strip()[:80]}")

    upd("stop")
    ok(health() is None, "정지")
    logs = [log_path] + [log_path + f".{i}" for i in range(1, 4)]
    ok(all(os.path.getsize(p) <= 2 * 1024 * 1024 for p in logs if os.path.isfile(p)), "업데이트·실패 복구·정지 뒤 파일별 로그 상한 유지")
    text = open(log_path).read()
    ok("서버 준비 완료" in text and "서버 종료 중" in text and "\x1b" not in text, "현재 서버 로그는 ANSI 없는 시작·종료 기록")
except BaseException as e:  # 중단도 실패로 기록한다(성공으로 보고하지 않음)
    FAILS.append(f"예외로 중단: {e!r}")
    raise
finally:
    if FAILS:
        print(f"\n실패 {len(FAILS)}건:\n  " + "\n  ".join(FAILS))
        print(f"(조사용으로 남김: {TMP})")
    else:
        try:
            subprocess.run([os.path.join(TMP, "grove-a"), "stop", "--install", os.path.join(TMP, "install")], env=ENV, capture_output=True, timeout=60)
        except Exception:
            pass
        shutil.rmtree(TMP, ignore_errors=True)
        print("\n모두 통과")
sys.exit(1 if FAILS else 0)
