"""GROVE_TEST_BIN=<검증한 실행 파일> python3 scripts/test_deploy_cli.py"""
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("deploy", Path(__file__).with_name("deploy_local.py"))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DaemonProcesses(unittest.TestCase):
    def test_counts_only_installed_serve_processes(self):
        root = "/test/grove/releases/current/grove"
        executables = {"1": root, "2": root, "3": "/other/grove", "4": root}
        commands = {"1": b"grove\0serve\0--listen\0localhost:49120\0",
                    "2": b"grove\0computer-mcp\0", "4": b"grove\0"}
        with patch.object(deploy, "INSTALL", "/test/grove"), \
                patch.object(deploy.os, "listdir", return_value=["1", "2", "3", "4", "self"]), \
                patch.object(deploy.os, "readlink", side_effect=lambda p: executables[p.split("/")[2]]), \
                patch("builtins.open", side_effect=lambda p, mode: io.BytesIO(commands[p.split("/")[2]])):
            self.assertEqual(deploy.daemon_pids(), [1])

    def test_ignores_process_that_exits_during_inspection(self):
        with patch.object(deploy, "INSTALL", "/test/grove"), \
                patch.object(deploy.os, "listdir", return_value=["1"]), \
                patch.object(deploy.os, "readlink", return_value="/test/grove/releases/current/grove"), \
                patch("builtins.open", side_effect=FileNotFoundError):
            self.assertEqual(deploy.daemon_pids(), [])


class DeploymentHandoff(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.data = self.root / "data"
        self.data.mkdir()
        (self.root / "current").write_text("old-release\n")
        self.database = self.data / "grove.db"
        with sqlite3.connect(self.database) as c:
            c.executescript("CREATE TABLE turns(id TEXT,session_id TEXT,profile_id TEXT,status TEXT);"
                            "CREATE TABLE cli_sessions(session_id TEXT,profile_id TEXT,native_id TEXT);"
                            "CREATE TABLE tool_calls(id TEXT,session_id TEXT,turn_id TEXT,name TEXT);"
                            "CREATE TABLE tasks(id TEXT,session_id TEXT,call_id TEXT,pid INTEGER,status TEXT,detached INTEGER);"
                            "INSERT INTO turns VALUES('own-turn','own-session','profile','running');"
                            "INSERT INTO cli_sessions VALUES('own-session','profile','native-own');")
        reserve = patch.object(deploy, "reserve_deployment_report", return_value="report-fixture")
        self.reserve = reserve.start()
        self.addCleanup(reserve.stop)
        self.archive = self.root / "package.tar.gz"
        self.archive.write_bytes(b"verified package fixture")
        self.receipt = {"archive_sha256": hashlib.sha256(self.archive.read_bytes()).hexdigest(), "size": self.archive.stat().st_size}
        self.manifest = {"version": "0.1.0", "commit": "test-commit"}
        self.request = {"archive": str(self.archive), "receipt": self.receipt, "manifest": self.manifest,
                        "turn_id": "own-turn", "previous_release": "old-release", "skip_pages": True}
        for key, value in (("INSTALL", str(self.root)), ("DATA", str(self.data))):
            patcher = patch.object(deploy, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def readiness(self, **counts):
        busy = dict.fromkeys(deploy.BUSY_KEYS, 0)
        busy.update(counts)
        return {"idle": all(n == 0 for n in busy.values()), "busy": busy}

    def turn_status(self, status):
        with sqlite3.connect(self.database) as c:
            c.execute("UPDATE turns SET status=? WHERE id='own-turn'", (status,))

    def identify(self, environment=None, cli=None, attached=True, task_id=None):
        chain = {100: (90, ["python3", "deploy_local.py"]),
                 90: (80, ["bash"]), 80: (10 if attached else 1, cli or ["codex", "app-server"])}
        with patch.dict(os.environ, environment or {}, clear=True), \
                patch.object(deploy, "daemon_pids", return_value=[10]), \
                patch.object(deploy.os, "getpid", return_value=100), \
                patch.object(deploy, "process_info", side_effect=chain.__getitem__), \
                patch.object(deploy, "process_task_id", return_value=task_id) as marker:
            caller = deploy.deployment_caller()
            if attached:
                marker.assert_called_once_with(80)
            return caller

    def test_requires_both_daemon_ancestry_and_matching_native_session(self):
        self.assertEqual(self.identify({"CODEX_THREAD_ID": "native-own"}), ("own-turn", None))
        self.assertIsNone(self.identify({"CODEX_THREAD_ID": "native-other"}))
        self.assertIsNone(self.identify({"CODEX_THREAD_ID": "native-own"}, attached=False))
        self.assertIsNone(self.identify())
        with sqlite3.connect(self.database) as c:
            c.execute("INSERT INTO turns VALUES('ambiguous','own-session','profile','running')")
        self.assertIsNone(self.identify({"CODEX_SESSION_ID": "native-own"}))

    def test_identifies_claude_new_and_resumed_sessions(self):
        for command in (["/usr/bin/claude"], ["node", "/npm/@anthropic-ai/claude-code/cli.js"]):
            for flag in ("--session-id", "--resume"):
                with self.subTest(command=command, flag=flag):
                    self.assertEqual(self.identify(cli=command + ["-p", flag, "native-own"]), ("own-turn", None))

    def test_missing_native_mapping_and_disappearing_process_are_not_self(self):
        with sqlite3.connect(self.database) as c:
            c.execute("DELETE FROM cli_sessions")
        self.assertIsNone(self.identify({"CODEX_THREAD_ID": "native-own"}))
        with patch.object(deploy, "daemon_pids", return_value=[10]), \
                patch.object(deploy, "process_info", side_effect=FileNotFoundError):
            self.assertIsNone(deploy.deployment_caller())

    def register_shell_task(self):
        with sqlite3.connect(self.database) as c:
            c.executescript("DELETE FROM cli_sessions;"
                            "INSERT INTO tool_calls VALUES('shell-call','own-session','own-turn','shell');"
                            "INSERT INTO tasks VALUES('deploy-task','own-session','shell-call',80,'running',0);")

    def test_api_shell_identifies_turn_before_and_after_detachment(self):
        self.register_shell_task()
        self.assertEqual(self.identify(task_id="deploy-task"), ("own-turn", "deploy-task"))
        with sqlite3.connect(self.database) as c:
            c.execute("UPDATE tasks SET detached=1")
        self.assertEqual(self.identify(task_id="deploy-task"), ("own-turn", "deploy-task"))

    def test_api_shell_requires_daemon_ancestry_and_the_live_task_pid(self):
        self.register_shell_task()
        self.assertIsNone(self.identify(task_id="deploy-task", attached=False))
        self.assertIsNone(self.identify({"GROVE_TASK_ID": "deploy-task"}))
        self.assertIsNone(self.identify(task_id="unknown-task"))
        with sqlite3.connect(self.database) as c:
            c.execute("UPDATE tasks SET pid=90")
        self.assertIsNone(self.identify(task_id="deploy-task"))
        with sqlite3.connect(self.database) as c:
            c.execute("UPDATE tasks SET pid=80,status='completed'")
        self.assertIsNone(self.identify(task_id="deploy-task"))
        with sqlite3.connect(self.database) as c:
            c.execute("UPDATE tasks SET status='running',call_id=NULL")
        self.assertIsNone(self.identify(task_id="deploy-task"))
        with sqlite3.connect(self.database) as c:
            c.execute("UPDATE tasks SET call_id='shell-call'")
        self.turn_status("completed")
        self.assertIsNone(self.identify(task_id="deploy-task"))

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux /proc 실행 표식 검사")
    def test_api_shell_reads_real_process_marker(self):
        self.register_shell_task()
        probe = """
import json, os, runpy, sqlite3, sys
from pathlib import Path
from unittest.mock import patch

caller = runpy.run_path(sys.argv[1])["deployment_caller"]
data = Path(sys.argv[2])
with sqlite3.connect(data / "grove.db") as db:
    db.execute("UPDATE tasks SET pid=?", (os.getpid(),))
with patch.dict(caller.__globals__, DATA=str(data), daemon_pids=lambda: [os.getppid()]):
    print(json.dumps(caller()))
"""
        result = subprocess.run([sys.executable, "-c", probe, deploy.__file__, str(self.data)],
                                env={**os.environ, "GROVE_TASK_ID": "deploy-task"},
                                check=True, capture_output=True, text=True, timeout=10)
        self.assertEqual(json.loads(result.stdout), ["own-turn", "deploy-task"])

    def test_busy_check_rejects_other_work_and_incomplete_readiness(self):
        self.assertTrue(deploy.work_matches(self.readiness(active_turns=1), 1))
        self.assertTrue(deploy.work_matches(self.readiness(active_turns=1, running_tasks=1), 1, running_tasks=1))
        self.assertTrue(deploy.work_matches(self.readiness(), 0))
        for data in (None, {}, {"idle": True, "busy": {}}, self.readiness(active_turns=2),
                     self.readiness(active_turns=1, running_tasks=1), self.readiness(active_turns=1, awaiting_approval=1),
                     self.readiness(active_turns=1, running_terminals=1), self.readiness(active_turns=1, future_work=1)):
            with self.subTest(data=data):
                self.assertFalse(deploy.work_matches(data, 1))
        invalid = self.readiness()
        invalid["busy"]["active_turns"] = False
        self.assertFalse(deploy.work_matches(invalid, 0))

    def test_waits_for_saved_completion_and_all_other_work(self):
        def tick(_seconds):
            self.turn_status("completed")
        with patch.object(deploy.time, "sleep", side_effect=tick) as sleep, \
                patch.object(deploy, "update_readiness", side_effect=[self.readiness(active_turns=1), self.readiness()]) as ready:
            self.assertIsNone(deploy.wait_for_deployment(self.request))
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(ready.call_count, 2, "running 중에는 전환 readiness도 조회하지 않는다")

    def test_failed_or_cancelled_turn_never_applies(self):
        for status in ("failed", "cancelled", "interrupted"):
            self.turn_status(status)
            with patch.object(deploy, "update_readiness") as ready:
                self.assertEqual(deploy.wait_for_deployment(self.request), "caller_not_completed")
            ready.assert_not_called()
        self.assertEqual(deploy.wait_for_deployment(self.request, timeout=0), "idle_timeout")

    def test_readiness_errors_and_unknown_counts_keep_waiting(self):
        self.turn_status("completed")
        with patch.object(deploy, "update_readiness", side_effect=[OSError(), {}, self.readiness()]), \
                patch.object(deploy.time, "sleep") as sleep:
            self.assertIsNone(deploy.wait_for_deployment(self.request))
        self.assertEqual(sleep.call_count, 2)

    def test_handoff_copies_verified_package_and_uses_independent_unit(self):
        with patch.object(deploy.subprocess, "run") as launch:
            deploy.queue_deployment(str(self.archive), self.receipt, self.manifest, "own-turn", True)
        directory = next((self.root / "deployments").iterdir())
        request = json.loads((directory / "request.json").read_text())
        self.archive.write_bytes(b"changed after queue")
        self.assertEqual(Path(request["archive"]).read_bytes(), b"verified package fixture")
        self.assertEqual((directory / "request.json").stat().st_mode & 0o777, 0o600)
        command = launch.call_args.args[0]
        self.assertEqual(command[:2], ["systemd-run", "--user"])
        self.assertNotIn("--scope", command)
        self.assertNotIn("--force", command)
        self.assertIn("--resume-deployment", command)
        self.assertTrue((directory / "scripts/deploy_local.py").is_file())

    def test_handoff_start_failure_is_visible(self):
        with patch.object(deploy.subprocess, "run", side_effect=OSError()), self.assertRaises(SystemExit):
            deploy.queue_deployment(str(self.archive), self.receipt, self.manifest, "own-turn", True)
        directory = next((self.root / "deployments").iterdir())
        self.assertEqual(json.loads((directory / "state.json").read_text())["state"], "failed")

    def resume(self):
        (self.root / "request.json").write_text(json.dumps(self.request))
        result = deploy.resume_deployment(str(self.root))
        return result, json.loads((self.root / "state.json").read_text())

    def test_resume_never_rebuilds_or_forces_and_reports_success_after_deploy(self):
        for skip_pages in (True, False):
            self.request["skip_pages"] = skip_pages
            with self.subTest(skip_pages=skip_pages), patch.object(deploy, "wait_for_deployment", return_value=None), \
                    patch.object(deploy, "deploy_prepared") as prepared, patch.object(deploy, "package") as package:
                result, state = self.resume()
            self.assertEqual((result, state["state"]), (0, "applied"))
            self.assertEqual(state["pages"], None if skip_pages else deploy.PAGES_ORIGIN)
            package.assert_not_called()
            prepared.assert_called_once_with(str(self.archive), self.receipt, self.manifest, skip_pages=skip_pages)

    def test_completion_is_sent_only_after_full_deployment_verification(self):
        self.request.update(unit="deploy-fixture", continuation_id="report-fixture", skip_pages=False)
        order = []
        with patch.object(deploy, "wait_for_deployment", return_value=None), \
                patch.object(deploy, "deploy_prepared", side_effect=lambda *a, **kw: order.append("verified")), \
                patch.object(deploy, "continuation_api", side_effect=lambda *a: order.append(a)):
            result, state = self.resume()
        self.assertEqual((result, state["state"]), (0, "applied"))
        self.assertEqual(order[0], "verified")
        self.assertEqual(order[1][0], "continuations/report-fixture/complete")
        self.assertEqual(order[1][1]["status"], "completed")
        self.assertEqual(json.loads(order[1][1]["detail"])["pages"], deploy.PAGES_ORIGIN)
        self.assertEqual(json.loads((self.root / "report.json").read_text())["status"], "accepted")

    def test_callback_failure_preserves_applied_result_and_never_replays_deployment(self):
        self.request.update(unit="deploy-fixture", continuation_id="report-fixture")
        with patch.object(deploy, "wait_for_deployment", return_value=None), \
                patch.object(deploy, "deploy_prepared") as prepared, \
                patch.object(deploy, "continuation_api", side_effect=OSError), \
                patch.object(deploy.sys, "stderr", io.StringIO()):
            result, state = self.resume()
        self.assertEqual((result, state["state"]), (0, "applied"))
        prepared.assert_called_once()
        self.assertEqual(json.loads((self.root / "report.json").read_text())["status"], "unconfirmed")

    def test_first_upgrade_registers_after_cutover_and_failure_is_not_reported_as_success(self):
        self.request.update(unit="deploy-fixture")
        order = []
        with patch.object(deploy, "wait_for_deployment", return_value=None), \
                patch.object(deploy, "deploy_prepared", side_effect=SystemExit(1)), \
                patch.object(deploy, "continuation_api", side_effect=lambda *a: order.append(a)):
            result, state = self.resume()
        self.assertEqual((result, state["state"]), (1, "incomplete"))
        self.reserve.assert_called_once_with("own-turn", "deploy-fixture")
        self.assertEqual(order[0][1]["status"], "unknown")
        self.assertEqual(json.loads((self.root / "request.json").read_text())["continuation_id"], "report-fixture")

    def test_resume_refuses_timeout_changed_release_or_tampered_archive(self):
        with patch.object(deploy, "wait_for_deployment", return_value="idle_timeout"), patch.object(deploy, "deploy_prepared") as prepared:
            self.assertEqual(self.resume()[1]["state"], "deferred")
            prepared.assert_not_called()
        with patch.object(deploy, "wait_for_deployment", return_value=None), patch.object(deploy, "deploy_prepared") as prepared, \
                patch.object(deploy.sys, "stderr", io.StringIO()):
            (self.root / "current").write_text("newer-release")
            self.assertEqual(self.resume()[1]["reason"], "operating_release_changed")
            (self.root / "current").write_text("old-release")
            self.archive.write_bytes(b"tampered")
            self.assertEqual(self.resume()[1]["state"], "incomplete")
            prepared.assert_not_called()

    def test_resume_preserves_updater_deferral_and_failure(self):
        for code, state in ((3, "deferred"), (1, "incomplete")):
            with patch.object(deploy, "wait_for_deployment", return_value=None), \
                    patch.object(deploy, "deploy_prepared", side_effect=SystemExit(code)):
                result, observed = self.resume()
            self.assertEqual((result, observed["state"]), (code, state))

    def test_main_hands_off_only_when_self_is_the_only_work(self):
        cli = deploy.DeploymentCaller("own-turn")
        shell = deploy.DeploymentCaller("own-turn", "deploy-task")
        for caller, counts, force, expected_queue in (
            (cli, {"active_turns": 1}, False, True),
            (cli, {"active_turns": 2}, False, False),
            (cli, {"active_turns": 1, "running_tasks": 1}, False, False),
            (shell, {"active_turns": 1, "running_tasks": 1}, False, True),
            (shell, {"active_turns": 1, "running_tasks": 2}, False, False),
            (shell, {"active_turns": 2, "running_tasks": 1}, False, False),
            (shell, {"active_turns": 1}, False, False),
            (shell, {"active_turns": 1, "running_tasks": 1, "awaiting_approval": 1}, False, False),
            (None, {"active_turns": 1}, False, False),
            (cli, {"active_turns": 1}, True, False),
        ):
            with self.subTest(caller=caller, counts=counts, force=force), \
                    patch.object(sys, "argv", ["deploy_local.py"] + (["--force"] if force else [])), \
                    patch.object(deploy, "package", return_value=(str(self.archive), self.receipt, self.manifest)), \
                    patch.object(deploy, "deployment_caller", return_value=caller), \
                    patch.object(deploy, "update_readiness", return_value=self.readiness(**counts)), \
                    patch.object(deploy, "queue_deployment") as queue, patch.object(deploy, "deploy_prepared") as prepared:
                deploy.main()
                self.assertEqual(queue.called, expected_queue)
                self.assertEqual(prepared.called, not expected_queue)
                if expected_queue:
                    queue.assert_called_once_with(str(self.archive), self.receipt, self.manifest, "own-turn", False)

    def test_first_install_and_unchanged_release_keep_existing_path(self):
        for current in (None, f"0.1.0-{self.receipt['archive_sha256'][:12]}"):
            if current is None:
                (self.root / "current").unlink()
            else:
                (self.root / "current").write_text(current)
            with patch.object(sys, "argv", ["deploy_local.py"]), \
                    patch.object(deploy, "package", return_value=(str(self.archive), self.receipt, self.manifest)), \
                    patch.object(deploy, "deployment_caller") as caller, patch.object(deploy, "deploy_prepared") as prepared:
                deploy.main()
            caller.assert_not_called()
            prepared.assert_called_once()

    def test_updater_deferral_does_not_install_cli_or_publish_pages(self):
        deferred = subprocess.CompletedProcess([], 3, stdout='{"status":"deferred"}', stderr="")
        with patch.object(deploy, "signed_manifest", return_value="signed.json"), \
                patch.object(deploy, "grove_bin", return_value="grove"), \
                patch.object(deploy.subprocess, "run", return_value=deferred) as update, \
                patch.object(deploy, "install_cli") as cli, patch.object(deploy, "publish_pages") as pages, \
                self.assertRaises(SystemExit) as raised:
            deploy.deploy_prepared(str(self.archive), self.receipt, self.manifest)
        self.assertEqual(raised.exception.code, 3)
        self.assertNotIn("--force", update.call_args.args[0])
        cli.assert_not_called()
        pages.assert_not_called()


class CliInstall(unittest.TestCase):
    def test_install_repeat_help_defaults_and_existing_daemon_are_preserved(self):
        binary = Path(os.environ["GROVE_TEST_BIN"]).resolve()
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            root = home / ".local/share/grove-opus"
            release = root / "releases/existing"
            release.mkdir(parents=True)
            shutil.copyfile(binary, release / "grove")
            (release / "grove").chmod(0o755)
            (root / "current").write_text("existing")
            (release / "web").mkdir()
            (release / "web/index.html").write_text("existing UI")
            before = (release / "grove").read_bytes()
            env = {**os.environ, "HOME": str(home)}
            env.pop("GROVE_DATA_DIR", None)
            env.pop("GROVE_LISTEN", None)
            with patch.object(deploy, "HOME", str(home)), patch.object(deploy, "INSTALL", str(root)):
                deploy.install_cli(str(binary))
                deploy.install_cli(str(binary))
            launcher = home / ".local/bin/grove"
            help_result = subprocess.run([str(launcher), "pairing", "--help"], env=env, capture_output=True, text=True, check=True)
            self.assertIn("grove pairing create", help_result.stdout)
            self.assertIn("grove pairing --help", subprocess.check_output([str(launcher), "--help"], env=env, text=True))
            version = json.loads(subprocess.check_output([str(launcher), "version", "--json"], env=env, text=True))
            self.assertIn("version", version)
            config = json.loads(subprocess.check_output([str(launcher), "config"], env=env, text=True))
            self.assertEqual(config["data_dir"], str(root / "data"))
            self.assertEqual(config["listen"], "127.0.0.1:49120")
            self.assertFalse((root / "data").exists())
            self.assertEqual((root / "current").read_text(), "existing")
            self.assertEqual((release / "grove").read_bytes(), before)
            self.assertEqual((release / "web/index.html").read_text(), "existing UI")

    def test_existing_grove_launcher_is_upgraded(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            launcher = home / ".local/bin/grove"
            launcher.parent.mkdir(parents=True)
            previous = b"#!/bin/sh\n# Previous launcher fixture\n"
            launcher.write_bytes(previous)
            with patch.object(deploy, "HOME", str(home)), \
                    patch.object(deploy, "INSTALL", str(home / "installation")), \
                    patch.object(deploy, "PREVIOUS_CLI_LAUNCHER_SHA256", hashlib.sha256(previous).hexdigest()):
                deploy.install_cli(os.environ["GROVE_TEST_BIN"])
            self.assertEqual(launcher.read_bytes(), Path(__file__).with_name("grove_local.sh").read_bytes())

    def test_existing_unowned_command_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            launcher = home / ".local/bin/grove"
            launcher.parent.mkdir(parents=True)
            launcher.write_text("existing user command")
            with patch.object(deploy, "HOME", str(home)), patch.object(deploy, "INSTALL", str(home / "installation")):
                with self.assertRaises(SystemExit):
                    deploy.install_cli(os.environ["GROVE_TEST_BIN"])
            self.assertEqual(launcher.read_text(), "existing user command")
            self.assertFalse((home / "installation").exists())


if __name__ == "__main__":
    unittest.main()
