"""이벤트 정합성·비밀 배제·동시 append 회귀."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import integration_events as events


class Events(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "events.jsonl"

    def read(self):
        return [json.loads(line) for line in self.path.read_text().splitlines()]

    def test_concurrent_append_is_complete_and_private(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda n: events.emit(self.path, "started", work=n), range(40)))
        rows = self.read()
        self.assertEqual(len(rows), 40)
        self.assertEqual({r["work"] for r in rows}, set(range(40)))
        self.assertEqual(len({r["event_id"] for r in rows}), 40)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertTrue(all(r["observed_at"].endswith("+00:00") for r in rows))

    def test_unknown_fields_and_free_text_are_rejected(self):
        for fields in ({"token": "redacted"}, {"reason": "free text"},
                       {"commit": "main"}, {"job": "/private/path"},
                       {"duration_seconds": float("nan")}, {"work": True}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                events.emit(self.path, "started", **fields)
        self.assertFalse(self.path.exists())

    def test_symlink_is_not_followed(self):
        original = self.path.with_suffix(".other")
        original.write_text("preserve")
        self.path.symlink_to(original)
        with self.assertRaises(OSError):
            events.emit(self.path, "started", work=1)
        self.assertEqual(original.read_text(), "preserve")

    def test_snapshot_keeps_only_observed_public_fields(self):
        snapshot = dict(head="a" * 40, running_sessions=1, backlog=0, max_running=6,
                        start_slots=5, queue=[dict(number=38, state="running",
                        tip="b" * 40, cwd="/private", sessions=[{"id": "private"}])])
        events.observe(self.path, snapshot)
        rows = self.read()
        self.assertEqual([r["event"] for r in rows], ["queue-observed", "workspace-observed"])
        self.assertNotIn("private", self.path.read_text())
        self.assertNotIn("started_at", rows[1])

    def test_bad_event_is_rejected(self):
        with self.assertRaises(ValueError):
            events.emit(self.path, "guessed-completion", work=1)

    def test_operational_cli_links_work_commit_and_job(self):
        subprocess.run([sys.executable, events.__file__, "--events", str(self.path),
                        "--event", "intake-started", "--work", "38",
                        "--commit", "a" * 40, "--job", "validation-example"], check=True)
        row = self.read()[0]
        self.assertEqual((row["work"], row["commit"], row["job"]),
                         (38, "a" * 40, "validation-example"))


if __name__ == "__main__":
    unittest.main()
