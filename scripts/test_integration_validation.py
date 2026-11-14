"""독립 임시 Git 저장소에서 candidate·실패·timeout 격리를 검증한다."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import integration_validation as validation


class Validation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "repo"
        self.root.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Fixture")
        (self.root / "scripts").mkdir()
        (self.root / "web/node_modules").mkdir(parents=True)
        (self.root / "web/package.json").write_text("{}\n")
        (self.root / ".dev").mkdir()
        (self.root / ".gitignore").write_text(".dev\nweb/node_modules\n")
        self.builder = self.root / "scripts/build.py"
        self.builder.write_text("import sys\nsys.exit(0)\n")
        self.commit()
        self.store = self.base / "jobs"
        self.lock_patch = patch.object(validation, "LOCK", self.base / "check.lock")
        self.lock_patch.start()
        self.addCleanup(self.lock_patch.stop)

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args],
                                       text=True, stderr=subprocess.PIPE).strip()

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def run_job(self, timeout=10):
        before = self.git("status", "--porcelain")
        head = self.git("rev-parse", "HEAD")
        code = validation.run(self.root, head, self.store, ["--typecheck"], timeout,
                              events=self.base / "events.jsonl", work=38)
        self.assertEqual(self.git("rev-parse", "HEAD"), head)
        self.assertEqual(self.git("status", "--porcelain"), before)
        job = sorted(self.store.iterdir(), key=lambda path: path.stat().st_mtime_ns)[-1]
        return code, job, json.loads((job / "state.json").read_text())

    def test_success_and_stale_head(self):
        code, job, state = self.run_job()
        self.assertEqual(code, 0)
        self.assertEqual(state["status"], "passed")
        events = [json.loads(line) for line in (self.base / "events.jsonl").read_text().splitlines()]
        self.assertEqual([event["status"] for event in events],
                         ["preparing", "waiting-lock", "running", "passed"])
        self.assertTrue(all(event["work"] == 38 for event in events))
        self.assertEqual(set(state["phase_seconds"]), {"preparing", "waiting-lock", "running"})
        self.assertNotIn(str(self.base), (self.base / "events.jsonl").read_text())
        self.assertTrue(validation.inspect(job, self.root)["reusable"])
        (self.root / "new").write_text("change")
        self.assertFalse(validation.inspect(job, self.root)["reusable"])
        self.commit()
        self.assertFalse(validation.inspect(job, self.root)["reusable"])

    def test_failure_is_retained_and_next_job_can_pass(self):
        self.builder.write_text("import sys\nprint('failure evidence')\nsys.exit(7)\n")
        self.commit()
        code, job, state = self.run_job()
        self.assertEqual(code, 1)
        self.assertEqual(state["returncode"], 7)
        self.assertIn("failure evidence", (job / "output.log").read_text())
        self.builder.write_text("pass\n")
        self.commit()
        self.assertEqual(self.run_job()[0], 0)
        self.assertEqual(json.loads((job / "state.json").read_text())["status"], "failed")

    def test_timeout_is_not_success(self):
        self.builder.write_text("import threading\nthreading.Event().wait()\n")
        self.commit()
        code, job, state = self.run_job(timeout=0.5)
        self.assertEqual(code, 1)
        self.assertEqual(state["status"], "timed-out")
        self.assertEqual(json.loads((self.base / "events.jsonl").read_text().splitlines()[-1])["status"],
                         "timed-out")
        self.assertFalse(validation.inspect(job, self.root)["reusable"])

    def test_changed_checkout_is_not_evidence(self):
        self.builder.write_text("from pathlib import Path\nPath('new').write_text('modified')\n")
        self.commit()
        code, _, state = self.run_job()
        self.assertEqual(code, 1)
        self.assertEqual(state["status"], "failed")

    def test_dirty_source_is_not_copied(self):
        self.builder.write_text("raise RuntimeError('uncommitted')\n")
        code, job, _ = self.run_job()
        self.assertEqual(code, 0)
        self.assertFalse(validation.inspect(job, self.root)["reusable"])

    def test_missing_environment_is_explicit(self):
        (self.root / ".dev").rmdir()
        code, _, state = self.run_job()
        self.assertEqual(code, 1)
        self.assertEqual(state["status"], "error")
        self.assertIn("공유 검사 환경 없음", state["error"])

    def test_interruption_is_retained(self):
        self.builder.write_text(
            "import os, signal, threading\n"
            "os.kill(os.getppid(), signal.SIGTERM)\nthreading.Event().wait()\n"
        )
        self.commit()
        code, _, state = self.run_job()
        self.assertEqual(code, 1)
        self.assertEqual(state["status"], "interrupted")

    def test_lock_wait_has_deadline(self):
        holder = subprocess.Popen(
            [sys.executable, "-c",
             "import fcntl,sys,threading\n"
             "with open(sys.argv[1], 'a') as f:\n"
             " fcntl.flock(f, fcntl.LOCK_EX)\n"
             " print('locked', flush=True)\n"
             " threading.Event().wait()\n", str(validation.LOCK)],
            stdout=subprocess.PIPE, text=True,
        )
        try:
            self.assertEqual(holder.stdout.readline().strip(), "locked")
            code, _, state = self.run_job(timeout=0.5)
            self.assertEqual(code, 1)
            self.assertEqual(state["status"], "timed-out")
            self.assertNotIn("test_started_at", state)
        finally:
            holder.kill()
            holder.wait()
            holder.stdout.close()

    def test_store_inside_checkout_rejected(self):
        with self.assertRaises(ValueError):
            validation.run(self.root, "HEAD", self.root / "jobs", ["--typecheck"], 10)

    def test_only_selected_checks(self):
        for args in ([], ["--full"], ["--dry-run"], ["--rust"], ["--filter", "x"]):
            with self.subTest(args=args), self.assertRaises(ValueError):
                validation.selection(args)
        self.assertEqual(validation.selection(["--rust", "storage", "worktrees", "--typecheck"]),
                         ["--rust", "storage", "worktrees", "--typecheck"])


if __name__ == "__main__":
    unittest.main()
