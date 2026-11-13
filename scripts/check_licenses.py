#!/usr/bin/env python3
"""배포물에 들어가는 의존성 라이선스 검사(FRAME-001, BRAND-010).

- Rust: 대상 플랫폼별 일반·빌드 의존성(dev 제외)
- 웹: package.json dependencies의 전이 의존성(번들에 들어가는 것만)
허용 목록 밖의 라이선스가 하나라도 있으면 종료 코드 1. `--notice 파일`로 NOTICE 목록을 쓴다.
"""
import argparse
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALLOWED = {
    "MIT", "Apache-2.0", "Apache-2.0 WITH LLVM-exception", "BSD-3-Clause", "BSD-2-Clause", "ISC", "Zlib", "Unicode-3.0", "Unicode-DFS-2016",
    "CC0-1.0", "0BSD", "BSL-1.0", "Unlicense", "CDLA-Permissive-2.0", "MPL-2.0",
}
TARGETS = ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"]


def ok(expr: str) -> bool:
    """SPDX 식: OR는 하나만 허용되면 되고, AND는 모두 허용되어야 한다."""
    e = expr.replace("/", " OR ").replace("(", " ").replace(")", " ")
    return any(all(t.strip() in ALLOWED for t in alt.split(" AND ")) for alt in e.split(" OR "))


def cargo(target: str):
    out = subprocess.run(["cargo", "metadata", "--format-version", "1", "--filter-platform", target], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    m = json.loads(out)
    pk = {p["id"]: p for p in m["packages"]}
    nodes = {n["id"]: n for n in m["resolve"]["nodes"]}
    root = m["resolve"]["root"]
    seen, st = set(), [root]
    while st:
        i = st.pop()
        if i in seen:
            continue
        seen.add(i)
        for d in nodes[i]["deps"]:
            if any(k["kind"] in (None, "build") for k in d["dep_kinds"]):
                st.append(d["pkg"])
    seen.discard(root)
    return [(pk[i]["name"], pk[i]["version"], pk[i].get("license") or "") for i in seen]


def npm():
    web = os.path.join(ROOT, "web")
    pj = json.load(open(os.path.join(web, "package.json")))
    st, seen, res = list(pj.get("dependencies", {})), set(), []
    while st:
        n = st.pop()
        if n in seen:
            continue
        seen.add(n)
        p = os.path.join(web, "node_modules", n, "package.json")
        if not os.path.exists(p):
            res.append((n, "?", "MISSING"))
            continue
        d = json.load(open(p))
        lic = d.get("license") or ""
        if isinstance(lic, dict):
            lic = lic.get("type", "")
        res.append((n, d.get("version", "?"), lic))
        st.extend(d.get("dependencies", {}))
        st.extend(k for k, v in d.get("peerDependencies", {}).items() if not d.get("peerDependenciesMeta", {}).get(k, {}).get("optional"))
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--notice")
    a = ap.parse_args()
    rows = {}
    for t in TARGETS:
        for r in cargo(t):
            rows[("cargo",) + r] = t
    for r in npm():
        rows[("npm",) + r] = "web"
    bad = sorted(k for k in rows if not ok(k[3]))
    print(f"검사 대상 {len(rows)}개(cargo {sum(1 for k in rows if k[0] == 'cargo')}, npm {sum(1 for k in rows if k[0] == 'npm')})")
    if a.notice:
        with open(a.notice, "w") as f:
            f.write("Grove에 포함된 제3자 구성요소와 라이선스(자동 생성: scripts/check_licenses.py)\n\n")
            for k in sorted(rows):
                f.write(f"{k[0]}\t{k[1]}\t{k[2]}\t{k[3]}\n")
    if bad:
        print("허용 목록 밖 라이선스:")
        for b in bad:
            print("  ", *b)
        sys.exit(1)
    print("모두 허용 라이선스")


if __name__ == "__main__":
    main()
