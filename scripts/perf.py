#!/usr/bin/env python3
"""Grove 로컬 성능 측정(PERF). 표준 라이브러리만 쓴다.

    scripts/perf.py [--binary target/x86_64-unknown-linux-gnu/release/grove] [--quick]

외부 모델 지연을 빼기 위해 로컬 fixture 모델(OpenAI 형식 SSE)을 쓴다. fixture의 의도된 지연은
"모델 시간"으로 따로 기록하고, 전체 턴 시간에서 빼서 로컬 처리 시간을 구한다(PERF-009).
메모리는 /proc의 RSS·PSS·private(USS)를 따로 기록한다(PERF-005, 026).
결과: dist/perf/perf-<UTC>.json
"""
import argparse
import http.server
import json
import os
import shutil
import socket
import socketserver
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ---------- fixture 모델 ----------

class Fixture(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    chunks = 50
    delay = 0.01
    hang = False


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        self.rfile.read(n)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        s = self.server
        try:
            for i in range(10**6 if s.hang else s.chunks):
                self.wfile.write(f"data: {json.dumps({'choices': [{'delta': {'content': f'토큰{i} '}}]})}\n\n".encode())
                self.wfile.flush()
                time.sleep(s.delay)
            self.wfile.write(f"data: {json.dumps({'choices': [{'delta': {}, 'finish_reason': 'stop'}]})}\n\n".encode())
            self.wfile.write(f"data: {json.dumps({'choices': [], 'usage': {'prompt_tokens': 100, 'completion_tokens': s.chunks}})}\n\ndata: [DONE]\n\n".encode())
        except (BrokenPipeError, ConnectionResetError):
            pass


def free_port():
    with socket.socket() as so:
        so.bind(("127.0.0.1", 0))
        return so.getsockname()[1]


# ---------- 서버 ----------

class Server:
    def __init__(self, binary, data):
        self.binary, self.data = binary, data
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}/api/v1"
        self.n = 0

    def start(self):
        env = dict(os.environ, GROVE_DATA_DIR=self.data, GROVE_LOG="warn")
        env.pop("GROVE_WEB_DIR", None)
        t0 = time.monotonic()
        self.proc = subprocess.Popen([self.binary, "serve", "--listen", f"127.0.0.1:{self.port}"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        while True:
            try:
                if json.loads(urllib.request.urlopen(self.base + "/health", timeout=1).read())["status"] == "ready":
                    break
            except Exception:
                if self.proc.poll() is not None:
                    raise SystemExit("서버가 시작하지 못했습니다")
                time.sleep(0.005)
        self.token = open(os.path.join(self.data, "owner-token")).read().strip()
        return time.monotonic() - t0

    def stop(self):
        self.proc.terminate()
        self.proc.wait(30)

    def api(self, method, path, body=None):
        self.n += 1
        req = urllib.request.Request(self.base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"authorization": f"Bearer {self.token}", "content-type": "application/json", "idempotency-key": f"perf-{self.n}"})
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read()
            return json.loads(t) if t else None

    # /proc 기반 자원
    def mem(self):
        st = {}
        for line in open(f"/proc/{self.proc.pid}/status"):
            k, _, v = line.partition(":")
            if k in ("VmRSS", "VmHWM"):
                st[k] = int(v.split()[0]) / 1024
        roll = {}
        for line in open(f"/proc/{self.proc.pid}/smaps_rollup"):
            parts = line.split()
            if len(parts) >= 2 and parts[0].endswith(":") and parts[1].isdigit():
                roll[parts[0][:-1]] = int(parts[1]) / 1024
        return {"rss_mb": round(st["VmRSS"], 1), "peak_rss_mb": round(st["VmHWM"], 1), "pss_mb": round(roll.get("Pss", 0), 1),
                "private_mb": round(roll.get("Private_Clean", 0) + roll.get("Private_Dirty", 0), 1)}

    def cpu_ticks(self):
        f = open(f"/proc/{self.proc.pid}/stat").read().rsplit(")", 1)[1].split()
        return int(f[11]) + int(f[12])  # utime + stime


def pct(xs, p):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))] * 1000, 2)


def lat(fn, n):
    ts = []
    for _ in range(n):
        t0 = time.perf_counter()
        fn()
        ts.append(time.perf_counter() - t0)
    return {"p50_ms": pct(ts, 50), "p95_ms": pct(ts, 95), "n": n}


def idle_cpu(s, secs):
    hz = os.sysconf("SC_CLK_TCK")
    a = s.cpu_ticks()
    time.sleep(secs)
    return round((s.cpu_ticks() - a) / hz / secs * 100, 3)


def wait_turn(s, tid, want, timeout=60):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        t = s.api("GET", f"/turns/{tid}")
        if t["status"] in want:
            return t
        time.sleep(0.01)
    raise SystemExit(f"턴 {tid}가 {want}에 이르지 않았습니다")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", default=os.path.join(ROOT, "target", "x86_64-unknown-linux-gnu", "release", "grove"))
    ap.add_argument("--quick", action="store_true", help="반복 수를 줄인다")
    ap.add_argument("--check", action="store_true", help="scripts/perf_budget.json 예산을 넘으면 실패")
    a = ap.parse_args()
    if not os.path.isfile(a.binary):
        raise SystemExit(f"바이너리 없음: {a.binary} (scripts/build.py package --targets linux-x64)")
    reps = 5 if a.quick else 20
    tmp = tempfile.mkdtemp(prefix="gperf-", dir="/tmp")
    fx = Fixture(("127.0.0.1", 0), Handler)
    threading.Thread(target=fx.serve_forever, daemon=True).start()
    res = {"binary": os.path.relpath(a.binary, ROOT), "machine": {"cpu": os.cpu_count(), "arch": os.uname().machine, "kernel": os.uname().release}}
    try:
        # 1) 시작 시간: 새 데이터(최초 migration 포함)·기존 데이터
        cold, warm = [], []
        for i in range(reps):
            s = Server(a.binary, os.path.join(tmp, f"start{i}"))
            cold.append(s.start())
            s.stop()
            warm.append(s.start())
            s.stop()
        res["start"] = {"cold_p50_ms": pct(cold, 50), "cold_p95_ms": pct(cold, 95), "warm_p50_ms": pct(warm, 50), "warm_p95_ms": pct(warm, 95), "n": reps}

        s = Server(a.binary, os.path.join(tmp, "main"))
        s.start()
        res["idle_empty"] = {"cpu_percent_10s": idle_cpu(s, 10), **s.mem()}
        proj_dir = os.path.join(tmp, "proj")
        os.makedirs(proj_dir)
        pid = s.api("POST", "/projects", {"root_path": proj_dir})["id"]
        sec = s.api("POST", "/secrets", {"label": "perf", "value": "sk-perf-fixture-000000"})
        prof = s.api("POST", "/model-profiles", {"name": "fx", "protocol": "openai", "base_url": f"http://127.0.0.1:{fx.server_address[1]}/v1", "model": "fx", "secret_id": sec["id"], "options": {"timeout_secs": 60}})["id"]

        # 2) 세션 수별 idle 자원(세션당 메시지 20개)
        sessions = []
        res["sessions"] = {}
        for target in (1, 10, 50):
            while len(sessions) < target:
                sid = s.api("POST", f"/projects/{pid}/sessions", {"title": f"perf {len(sessions)}"})["id"]
                for j in range(20):
                    s.api("POST", f"/sessions/{sid}/messages", {"text": f"메시지 {j} " + "가나다라 " * 20})
                sessions.append(sid)
            res["sessions"][str(target)] = {"cpu_percent_5s": idle_cpu(s, 5), **s.mem()}

        # 3) 주요 조회 지연
        sid0 = sessions[0]
        res["latency"] = {
            "health": lat(lambda: urllib.request.urlopen(s.base + "/health").read(), reps * 5),
            "session_list": lat(lambda: s.api("GET", f"/projects/{pid}/sessions?limit=50"), reps * 5),
            "open_session_messages": lat(lambda: s.api("GET", f"/sessions/{sid0}/messages"), reps * 5),
            "recent": lat(lambda: s.api("GET", "/recent"), reps * 5),
            "search_body": lat(lambda: s.api("GET", "/sessions/search?q=%EA%B0%80%EB%82%98&body=true"), reps),
        }

        # 4) 활성 턴: 로컬 처리 시간 = 전체 - fixture 의도 지연
        fx.chunks, fx.delay = 50, 0.01
        model_s = fx.chunks * fx.delay
        res["active"] = {}
        for conc in (1, 10):
            hz = os.sysconf("SC_CLK_TCK")
            c0 = s.cpu_ticks()
            t0 = time.monotonic()
            tids = [s.api("POST", f"/sessions/{sessions[i]}/turns", {"text": "질문", "profile_id": prof})["turn"]["id"] for i in range(conc)]
            totals = []
            for tid in tids:
                wait_turn(s, tid, ("completed",))
                t = s.api("GET", f"/turns/{tid}")
                totals.append(t["timing"]["total_ms"] / 1000)
            wall = time.monotonic() - t0
            res["active"][str(conc)] = {
                "turn_total_p50_ms": pct(totals, 50), "turn_total_p95_ms": pct(totals, 95), "model_stream_ms": model_s * 1000,
                "local_overhead_p50_ms": round(pct(totals, 50) - model_s * 1000, 2), "wall_s": round(wall, 2),
                "cpu_s": round((s.cpu_ticks() - c0) / hz, 3), **s.mem(),
            }

        # 5) 취소 응답: 무한 stream 중 cancel → cancelled까지
        fx.hang, fx.delay = True, 0.05
        cancels = []
        for i in range(min(reps, 10)):
            tid = s.api("POST", f"/sessions/{sessions[i]}/turns", {"text": "길게", "profile_id": prof})["turn"]["id"]
            wait_turn(s, tid, ("running",))
            time.sleep(0.2)
            t0 = time.perf_counter()
            s.api("POST", f"/turns/{tid}/cancel", {})
            wait_turn(s, tid, ("cancelled",))
            cancels.append(time.perf_counter() - t0)
        fx.hang, fx.delay = False, 0.01
        res["cancel"] = {"p50_ms": pct(cancels, 50), "p95_ms": pct(cancels, 95), "n": len(cancels)}

        # 6) 반복 연결·세션 생성/보관에 따른 메모리 증가
        before = s.mem()
        cycles = 50 if a.quick else 200
        for _ in range(cycles):
            # cursor=0: 저장된 이벤트(또는 resync)가 즉시 오므로 첫 줄을 받고 끊는다.
            req = urllib.request.Request(s.base + "/events?cursor=0", headers={"authorization": f"Bearer {s.token}"})
            with urllib.request.urlopen(req, timeout=10) as r:
                r.readline()
        for i in range(cycles):
            x = s.api("POST", f"/projects/{pid}/sessions", {"title": f"churn {i}"})
            s.api("PATCH", f"/sessions/{x['id']}", {"expected_revision": x["revision"], "archived": True})
        time.sleep(2)
        after = s.mem()
        res["churn"] = {"cycles": cycles, "rss_before_mb": before["rss_mb"], "rss_after_mb": after["rss_mb"], "rss_growth_mb": round(after["rss_mb"] - before["rss_mb"], 1),
                        "idle_cpu_after_percent_5s": idle_cpu(s, 5)}
        s.stop()
        res["disk"] = {"data_dir_mb": round(sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(os.path.join(tmp, "main")) for f in fs) / 2**20, 2),
                       "binary_mb": round(os.path.getsize(a.binary) / 2**20, 2)}
    finally:
        fx.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(os.path.join(ROOT, "dist", "perf"), exist_ok=True)
    out = os.path.join(ROOT, "dist", "perf", time.strftime("perf-%Y%m%dT%H%M%SZ.json", time.gmtime()))
    json.dump(res, open(out, "w"), indent=2, ensure_ascii=False)
    print(json.dumps(res, indent=2, ensure_ascii=False))
    print(f"저장: {os.path.relpath(out, ROOT)}", file=sys.stderr)
    if a.check:
        over = check_budget(res)
        if over:
            print("성능 예산 초과:\n  " + "\n  ".join(over), file=sys.stderr)
            sys.exit(1)
        print("성능 예산 이내", file=sys.stderr)


def check_budget(res):
    budget = json.load(open(os.path.join(ROOT, "scripts", "perf_budget.json")))
    over = []
    for key, limit in budget.items():
        if key.startswith("_"):
            continue
        v = res
        for part in key.split("."):
            v = v[part]
        if v > limit:
            over.append(f"{key}: {v} > {limit}")
    return over


if __name__ == "__main__":
    main()
