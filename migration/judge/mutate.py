"""판정기(judge) 검증: 의도적 결함을 하나씩 넣은 사본에서 해당 시험이 실패하는지 확인한다.
실행: python3 migration/judge/mutate.py  (저장소 root에서, .envrc.dev 환경 필요)
작업 트리는 바꾸지 않고 임시 사본에서만 변경한다."""
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# (ID, 파일, 원문, 결함 버전, 잡아야 할 시험)
MUTATIONS = [
    ("M1-origin", "src/auth.rs", 'if site == "cross-site" {', "if false {", ("api", "cross_site_and_foreign_host_are_rejected")),
    ("M2-idempotency", "src/idem.rs", "if hash != request_hash {", "if false {", ("api", "idempotency_replay_conflict_and_missing_key")),
    ("M3-draft-revision", "src/workspace.rs", "let cur = load_draft(tx, &key)?;\n        if cur.revision != b.expected_revision {",
     "let cur = load_draft(tx, &key)?;\n        if false {", ("workspace", "drafts_conflict_instead_of_silent_overwrite")),
    ("M4-unknown-after-crash", "src/runner.rs", '&["running"],\n                    "unknown",', '&["running"],\n                    "succeeded",',
     ("turns", "crash_during_tool_marks_unknown_and_requires_review")),
    ("M5-deny-executes", "src/approvals.rs", 'let call = if b.decision == "approve" {', "let call = if true {",
     ("turns", "denied_write_keeps_file_absent_and_model_sees_denial")),
    ("M6-path-escape", "src/tools/fs.rs", "if !canon.starts_with(&root) {", "if false {", ("turns", "user_tool_requests_and_boundaries")),
    ("M7-edit-conflict", "src/tools/fs.rs", 'if sha256_hex(&bytes) != pre["sha256"].as_str().unwrap_or("") {', "if false {",
     ("turns", "approved_edit_applies_once_and_conflicts_if_file_changed")),
    ("M8-sse-dedupe", "src/events.rs", '"SELECT seq, created_at, kind, project_id, session_id, payload FROM events WHERE seq > ?1',
     '"SELECT seq, created_at, kind, project_id, session_id, payload FROM events WHERE seq >= ?1', ("api", "sse_cursor_replay_without_duplicates")),
]


def main() -> int:
    work = tempfile.mkdtemp(prefix="grove-mut-", dir="/tmp")
    try:
        for name in ["src", "tests", "assets", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml"]:
            s = os.path.join(ROOT, name)
            d = os.path.join(work, name)
            (shutil.copytree if os.path.isdir(s) else shutil.copy2)(s, d)
        os.makedirs(os.path.join(work, "web/app/api"), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, "web/app/api/generated.ts"), os.path.join(work, "web/app/api/generated.ts"))
        env = dict(os.environ, CARGO_TARGET_DIR=os.path.join(ROOT, "target", "mutation"))
        results = []
        for mid, rel, orig, bad, (test_file, test_name) in MUTATIONS:
            path = os.path.join(work, rel)
            src = open(path, encoding="utf-8").read()
            if src.count(orig) != 1:
                results.append((mid, "SETUP-ERROR", f"원문이 {src.count(orig)}번 나옴"))
                continue
            open(path, "w", encoding="utf-8").write(src.replace(orig, bad))
            r = subprocess.run(["cargo", "test", "--quiet", "--test", test_file, test_name], cwd=work, env=env, capture_output=True, text=True)
            open(path, "w", encoding="utf-8").write(src)
            caught = r.returncode != 0 and "test result: FAILED" in (r.stdout + r.stderr)
            results.append((mid, "CAUGHT" if caught else "MISSED", f"{test_file}::{test_name}"))
        for row in results:
            print("\t".join(row))
        return 0 if all(r[1] == "CAUGHT" for r in results) else 1
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
