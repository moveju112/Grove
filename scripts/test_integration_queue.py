"""통합 큐 시험. 실행: python3 -m unittest scripts/test_integration_queue.py"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import integration_queue as queue


def readme(rows):
    return "## 준비 완료된 워크스페이스\n" + "\n".join(
        f"| {number:02} | parallel/b{number} | {path} | `wks_{number}` | 기능 |"
        for number, path in rows
    ) + "\n## 완료·정리 이력\n| 99 | old | /old | wks_old | 완료 |"


class Parsing(unittest.TestCase):
    def test_only_active_rows_and_backtick_ids(self):
        rows = queue.read_assignments(readme([(21, "/tmp/work 21")]))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["number"], 21)
        self.assertEqual(rows[0]["cwd"], "/tmp/work 21")
        self.assertEqual(rows[0]["workspace_id"], "wks_21")

    def test_duplicate_or_invalid_rows_are_not_an_empty_queue(self):
        for text in (
            readme([(21, "/a"), (21, "/b")]),
            readme([(21, "/a"), (22, "/a")]),
            readme([(21, "relative")]),
            "## different\n",
        ):
            with self.subTest(text=text), self.assertRaises(ValueError):
                queue.read_assignments(text)

    def test_porcelain_nul_format_preserves_spaces(self):
        trees = queue.read_worktrees(
            "worktree /tmp/a b\0HEAD abc\0branch refs/heads/parallel/b21\0\0"
            "worktree /tmp/snapshot\0HEAD def\0detached\0locked reason\0\0"
        )
        self.assertEqual(trees["/tmp/a b"]["branch"], "refs/heads/parallel/b21")
        self.assertIn("detached", trees["/tmp/snapshot"])

    def test_home_abbreviation_has_same_identity(self):
        self.assertEqual(queue.canonical("~/x"), str(Path.home() / "x"))


class Snapshot(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "work").mkdir()
        self.rows = [(number, self.root / f"wt-{number}") for number in range(21, 25)]
        (self.root / "work/README.md").write_text(readme(self.rows))
        self.dirty = set()
        self.handoff = set()
        self.ancestors = set()
        self.calls = []
        self.trees = {
            str(path): {"worktree": str(path), "HEAD": f"tip{number}",
                        "branch": f"refs/heads/parallel/b{number}"}
            for number, path in self.rows
        }

    def agent(self, number, status="idle"):
        return {"id": f"agent-{number}", "cwd": str(self.root / f"wt-{number}"), "status": status}

    def git(self, root, *args):
        self.calls.append((str(root), args))
        if args == ("rev-parse", "--show-toplevel"):
            return str(self.root)
        if args == ("rev-parse", "HEAD"):
            return "main-head"
        if args[:2] == ("worktree", "list"):
            return ""
        if args[0] == "status":
            return "?? changed\0" if str(root) in self.dirty else ""
        if args[0] == "ls-tree":
            return "100644 blob result" if args[1] in self.handoff else ""
        raise AssertionError(args)

    def result(self, number, state="ready", remaining=None, blockers=None):
        self.handoff.add(f"tip{number}")
        path = self.root / f"wt-{number}/work"
        path.mkdir(parents=True)
        data = {"state": state, "remaining": remaining or [], "blockers": blockers or [],
                "integration_checks": ["선택 E2E"]}
        (path / f"RESULT-{number}.md").write_text(
            "# 인계\n<!-- grove-handoff:v1\n" + json.dumps(data) + "\n-->\n"
        )

    def collect(self, agents):
        with patch.object(queue, "git", side_effect=self.git), \
                patch.object(queue, "read_worktrees", return_value=self.trees), \
                patch.object(queue, "is_ancestor", side_effect=lambda _, tip, head: tip in self.ancestors):
            return queue.collect(self.root, agents)

    def test_running_worktree_is_not_deeply_inspected(self):
        result = self.collect([self.agent(21, "running"), self.agent(21, "idle")])
        self.assertEqual(result["queue"][0]["state"], "running")
        self.assertEqual(result["running_sessions"], 1)
        self.assertFalse(any(root == str(self.root / "wt-21") for root, _ in self.calls))

    def test_idle_alone_is_not_completion(self):
        result = self.collect([self.agent(21)])
        self.assertEqual(result["queue"][0]["state"], "needs-handoff")
        self.assertEqual(result["queue"][1]["state"], "prepared")

    def test_dirty_error_and_unknown_status_are_preserved(self):
        self.dirty.add(str(self.root / "wt-21"))
        result = self.collect([self.agent(21), self.agent(22, "error"), self.agent(23, "waiting")])
        self.assertEqual([row["state"] for row in result["queue"][:3]],
                         ["dirty", "needs-attention", "needs-attention"])
        self.assertEqual(result["start_slots"], 0)

    def test_ready_and_already_integrated_are_separate_candidates(self):
        self.result(21)
        self.result(22)
        self.ancestors.add("tip22")
        result = self.collect([self.agent(21), self.agent(22)])
        self.assertEqual(result["candidates"], [21])
        self.assertEqual(result["integrated_candidates"], [22])
        self.assertEqual(result["backlog"], 2)

    def test_three_candidates_pause_new_starts(self):
        for number in (21, 22, 23):
            self.result(number)
        result = self.collect([self.agent(21), self.agent(22), self.agent(23)])
        self.assertEqual(result["backlog"], 3)
        self.assertEqual(result["start_slots"], 0)
        self.assertEqual(result["continuation_slots"], 4)

    def test_partial_and_external_blocker_are_not_ready(self):
        self.result(21, "needs-work", remaining=["기존 전송 경계 연결"])
        self.result(22, "blocked", blockers=[{"reason": "parser 승인 필요", "unblock": "의존성 승인"}])
        result = self.collect([self.agent(21), self.agent(22)])
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["needs_continuation"], [21])
        self.assertEqual(result["blocked"], [22])

    def test_legacy_handoff_requires_review_not_automatic_continuation(self):
        self.result(21)
        (self.root / "wt-21/work/RESULT-21.md").write_text("# 부분 완료라는 과거 자유 형식")
        result = self.collect([self.agent(21)])
        self.assertEqual(result["legacy_review"], [21])
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["needs_continuation"], [])

    def test_invalid_ready_contract_is_not_a_completion_candidate(self):
        self.result(21, remaining=["실행 가능한 미완료"])
        result = self.collect([self.agent(21)])
        self.assertEqual(result["queue"][0]["state"], "invalid-handoff")
        self.assertEqual(result["candidates"], [])

    def test_existing_over_limit_sessions_are_counted_not_cancelled(self):
        agents = [dict(self.agent(21, "running"), id=f"agent-{i}") for i in range(5)]
        result = self.collect(agents)
        self.assertEqual(result["running_sessions"], 5)
        self.assertEqual(result["start_slots"], 0)

    def test_unlisted_feature_session_still_uses_a_slot(self):
        path = str(self.root / "unlisted")
        self.trees[path] = {"branch": "refs/heads/parallel/old", "HEAD": "old"}
        result = self.collect([{"id": "old", "cwd": path, "status": "initializing"}])
        self.assertEqual(result["running_sessions"], 1)
        self.assertEqual(result["start_slots"], 3)

    def test_wrong_branch_is_not_prepared(self):
        self.trees[str(self.root / "wt-21")]["branch"] = "refs/heads/other"
        self.assertEqual(self.collect([])["queue"][0]["state"], "workspace-mismatch")

    def test_result_without_session_history_is_not_unstarted(self):
        work = self.root / "wt-21/work"
        work.mkdir(parents=True)
        (work / "RESULT-21.md").write_text("인계")
        self.assertEqual(self.collect([])["queue"][0]["state"], "orphaned-result")


class Commands(unittest.TestCase):
    def test_service_failure_returns_nonzero_without_success_json(self):
        failure = subprocess.CalledProcessError(7, ["paseo"], stderr="private service response")
        with patch.object(queue, "load_agents", side_effect=failure), \
                redirect_stdout(StringIO()) as out, redirect_stderr(StringIO()) as err:
            self.assertEqual(queue.main([]), 1)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("exit 7", err.getvalue())
        self.assertNotIn("private service response", err.getvalue())

    def test_invalid_service_shape_is_rejected(self):
        for payload in ({}, [{"id": "x", "cwd": "/a"}]):
            with patch.object(queue, "command", return_value=json.dumps(payload)), self.assertRaises(ValueError):
                queue.load_agents(Path.cwd())

    def test_ancestor_failure_is_not_treated_as_not_merged(self):
        result = subprocess.CompletedProcess([], 128, stderr="invalid object")
        with patch.object(queue.subprocess, "run", return_value=result), self.assertRaises(subprocess.CalledProcessError):
            queue.is_ancestor(Path.cwd(), "tip", "head")

    def test_invalid_or_incomplete_handoff_does_not_claim_ready(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "RESULT.md"
            for body in (
                "<!-- grove-handoff:v1\n{",
                "<!-- grove-handoff:v1\n{}\n-->",
                '<!-- grove-handoff:v1\n{"state":"ready","remaining":[],"blockers":[]}\n-->',
                '<!-- grove-handoff:v1\n{"state":"blocked","remaining":[],"blockers":[],'
                '"integration_checks":[]}\n-->',
            ):
                path.write_text(body)
                with self.subTest(body=body), self.assertRaises(ValueError):
                    queue.read_handoff(path)


class Repository(unittest.TestCase):
    def test_real_git_collection_is_read_only_and_distinguishes_ancestry(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "main"
            root.mkdir()
            worktree = Path(temp) / "feature with spaces"

            def git(cwd, *args):
                return subprocess.run(
                    ["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True,
                    env=dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null",
                             GIT_CONFIG_SYSTEM="/dev/null", GIT_AUTHOR_NAME="Queue Test",
                             GIT_AUTHOR_EMAIL="queue@example.invalid", GIT_COMMITTER_NAME="Queue Test",
                             GIT_COMMITTER_EMAIL="queue@example.invalid"),
                ).stdout

            git(root, "init", "-b", "master")
            (root / "work").mkdir()
            (root / "work/README.md").write_text(readme([(21, worktree)]))
            git(root, "add", "work/README.md")
            git(root, "commit", "-m", "통합 큐 시험 기준")
            git(root, "worktree", "add", "-b", "parallel/b21", str(worktree))
            (worktree / "work/RESULT-21.md").write_text(
                '<!-- grove-handoff:v1\n{"state":"ready","remaining":[],"blockers":[],'
                '"integration_checks":["e2e/owned.spec.ts"]}\n-->\n'
            )
            git(worktree, "add", "work/RESULT-21.md")
            git(worktree, "commit", "-m", "기능 인계 시험")
            agents = [{"id": "fixture", "cwd": str(worktree), "status": "idle"}]
            before = {path: (git(path, "rev-parse", "HEAD"), git(path, "status", "--porcelain"))
                      for path in (root, worktree)}
            first = queue.collect(root, agents)
            second = queue.collect(root, agents)
            self.assertEqual(first, second)
            self.assertEqual(first["candidates"], [21])
            self.assertEqual(first["integrated_candidates"], [])
            for path in (root, worktree):
                self.assertEqual(before[path],
                                 (git(path, "rev-parse", "HEAD"), git(path, "status", "--porcelain")))
            git(root, "merge", "--ff-only", "parallel/b21")
            merged = queue.collect(root, agents)
            self.assertEqual(merged["candidates"], [])
            self.assertEqual(merged["integrated_candidates"], [21])


if __name__ == "__main__":
    unittest.main()
