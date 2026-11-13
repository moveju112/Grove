"""실제 systemd·linger·바이너리 실행 없는 시험.

실행: python3 -m unittest scripts/test_user_service.py
"""

from contextlib import redirect_stderr, redirect_stdout
import hashlib
from io import StringIO
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import user_service as service


class FakeManager:
    def __init__(self):
        self.calls = []
        self.failure = None
        self.fragment = ""
        self.load_state = "not-found"
        self.enabled = False
        self.active = False
        self.target = None
        self.discover = True

    def __call__(self, argv):
        self.calls.append(argv)
        verb = argv[2] if argv[0] == "systemctl" else "logs"
        if self.failure == verb:
            return subprocess.CompletedProcess(argv, 7, "", "private diagnostic")
        if verb == "show":
            if argv[-1] == "--property=LoadState,FragmentPath":
                return subprocess.CompletedProcess(
                    argv, 1 if self.load_state == "not-found" else 0,
                    f"LoadState={self.load_state}\nFragmentPath={self.fragment}\n", "")
            return subprocess.CompletedProcess(
                argv, 0, f"ActiveState={'active' if self.active else 'inactive'}\n"
                f"UnitFileState={'enabled' if self.enabled else 'disabled'}\n", "")
        if verb == "enable":
            self.enabled = True
        if verb == "disable":
            self.enabled = self.active = False
        if verb == "daemon-reload" and self.discover:
            exists = self.target is not None and self.target.exists()
            self.load_state = "loaded" if exists else "not-found"
            self.fragment = str(self.target) if exists else ""
        if verb == "start":
            self.active = True
        if verb == "stop":
            self.active = False
        return subprocess.CompletedProcess(argv, 0, "journal sample\n" if verb == "logs" else "", "")


class UserServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="grove-user-service-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.install = self.root / "install"
        self.install.mkdir()
        self.data = self.root / "data"
        self.data.mkdir()
        self.config = self.install / "install.json"
        self.config.write_text(json.dumps({
            "data_dir": str(self.data), "listen": "127.0.0.1:8456",
            "service": "systemd-user:grove.service",
        }))
        self.binary, self.sha = self.release("0.1.0-abcdef012345", b"verified fixture, never executed")
        self.manager = FakeManager()
        self.tool = service.UserService(self.config, "grove.service",
                                        self.root / "units", self.manager)
        self.manager.target = self.tool.target

    def release(self, name, content):
        release = self.install / "releases" / name
        release.mkdir(parents=True)
        (release / "web").mkdir()
        binary = release / "grove"
        binary.write_bytes(content)
        binary.chmod(0o700)
        sha = hashlib.sha256(content).hexdigest()
        (release / "manifest.json").write_text(json.dumps({
            "files": [{"path": "grove", "sha256": sha}],
        }))
        (self.install / "current").write_text(name)
        return binary, sha

    def register(self):
        return self.tool.execute("register", self.binary, self.sha)

    def snapshot(self):
        return {p.relative_to(self.install): p.read_bytes()
                for p in self.install.rglob("*") if p.is_file()}

    def test_plan_validates_without_commands_or_writes(self):
        before = self.snapshot()
        plan = self.tool.plan("register", self.binary, self.sha)
        self.assertFalse(plan["applied"])
        self.assertIn('"run" "--apply"', plan["unit_content"])
        self.assertEqual(self.manager.calls, [])
        self.assertFalse(self.tool.unit_dir.exists())
        self.assertEqual(self.snapshot(), before)

    def test_registration_is_repeatable_and_never_starts(self):
        self.assertTrue(self.register()["applied"])
        original = self.tool.target.read_bytes()
        self.register()
        self.assertEqual(self.tool.target.read_bytes(), original)
        self.assertTrue(self.manager.enabled)
        self.assertFalse(self.manager.active)
        self.assertFalse(any("start" in call for call in self.manager.calls))
        self.assertEqual(self.tool.target.stat().st_mode & 0o777, 0o600)

    def test_explicit_start_stop_status_and_logs(self):
        self.register()
        self.tool.execute("start")
        self.assertTrue(self.manager.active)
        status = self.tool.execute("status")
        self.assertIn("ActiveState=active", status["output"])
        self.assertIn("별도", status["note"])
        self.assertEqual(self.tool.execute("logs")["output"], "journal sample\n")
        self.assertEqual(self.manager.calls[-1], [
            "journalctl", "--user", "--unit", "grove.service", "--no-pager", "--lines=100"])
        self.tool.execute("stop")
        self.assertFalse(self.manager.active)

    def test_unregister_preserves_all_install_and_user_data_and_repeats(self):
        (self.data / "grove.db").write_bytes(b"conversation fixture")
        (self.data / "owner-token").write_bytes(b"credential fixture")
        before = self.snapshot()
        user_data = {p.name: p.read_bytes() for p in self.data.iterdir()}
        self.register()
        self.tool.execute("start")
        self.tool.execute("unregister")
        self.assertFalse(self.tool.target.exists())
        self.assertFalse(self.manager.active)
        self.assertFalse(self.manager.enabled)
        self.tool.execute("unregister")
        self.assertEqual(self.snapshot(), before)
        self.assertEqual({p.name: p.read_bytes() for p in self.data.iterdir()}, user_data)

    def test_unregister_without_installation_does_not_require_binary_or_data(self):
        self.register()
        self.config.unlink()
        self.tool.execute("unregister")
        self.assertFalse(self.tool.target.exists())

    def test_registration_command_failures_reconcile_on_retry(self):
        for verb in ("daemon-reload", "enable"):
            with self.subTest(verb=verb):
                self.manager.failure = verb
                with self.assertRaises(service.ServiceError):
                    self.register()
                self.assertTrue(self.tool.target.exists())
                self.manager.failure = None
                self.register()
                self.assertTrue(self.manager.enabled)
                self.tool.execute("unregister")

    def test_unregister_failure_preserves_ownership_until_disabled(self):
        self.register()
        self.manager.failure = "disable"
        with self.assertRaises(service.ServiceError):
            self.tool.execute("unregister")
        self.assertTrue(self.tool.target.exists())
        self.manager.failure = None
        self.tool.execute("unregister")
        self.assertFalse(self.tool.target.exists())

    def test_unregister_reload_failure_can_resume_after_unit_removed(self):
        self.register()
        self.manager.failure = "daemon-reload"
        with self.assertRaises(service.ServiceError):
            self.tool.execute("unregister")
        self.assertFalse(self.tool.target.exists())
        self.manager.failure = None
        self.tool.execute("unregister")
        self.assertFalse(self.manager.enabled)

    def test_atomic_publication_failure_leaves_no_partial_unit(self):
        with patch.object(service.os, "link", side_effect=OSError("interrupted")):
            with self.assertRaises(OSError):
                self.register()
        self.assertFalse(self.tool.target.exists())
        self.assertEqual(list(self.tool.unit_dir.glob(".grove-unit-*")), [])
        self.register()

    def test_foreign_local_unit_is_not_overwritten_or_stopped(self):
        self.tool.unit_dir.mkdir()
        self.tool.target.write_text("[Service]\nExecStart=/other/server\n")
        for action in ("register", "unregister", "stop"):
            with self.subTest(action=action), self.assertRaises(service.ServiceError):
                self.tool.execute(action, self.binary, self.sha)
        self.assertEqual(self.manager.calls, [])
        self.assertIn("/other/server", self.tool.target.read_text())

    def test_foreign_loaded_unit_is_not_changed(self):
        self.manager.load_state = "loaded"
        self.manager.fragment = "/usr/lib/systemd/user/grove.service"
        for action in ("register", "unregister"):
            with self.subTest(action=action), self.assertRaises(service.ServiceError):
                self.tool.execute(action, self.binary, self.sha)
        self.assertFalse(self.tool.unit_dir.exists())
        self.assertTrue(all("show" in call for call in self.manager.calls))

    def test_loaded_own_unit_is_accepted(self):
        self.register()
        self.manager.load_state = "loaded"
        self.manager.fragment = str(self.tool.target)
        self.register()
        self.tool.execute("unregister")

    def test_unit_outside_search_path_is_not_enabled(self):
        self.manager.discover = False
        with self.assertRaises(service.ServiceError):
            self.register()
        self.assertFalse(self.manager.enabled)
        self.assertFalse(any("enable" in call for call in self.manager.calls))
        self.assertTrue(self.tool.target.exists())
        self.manager.discover = True
        self.register()
        self.assertTrue(self.manager.enabled)

    def test_foreign_unit_discovered_after_reload_is_not_enabled(self):
        manager = self.manager

        def foreign_after_reload(argv):
            result = manager(argv)
            if argv[-1] == "daemon-reload":
                manager.fragment = "/other/grove.service"
                manager.load_state = "loaded"
            return result

        self.tool.runner = foreign_after_reload
        with self.assertRaises(service.ServiceError):
            self.register()
        self.assertFalse(manager.enabled)
        self.assertFalse(any("enable" in call for call in manager.calls))

    def test_missing_journalctl_is_reported(self):
        self.register()
        manager = self.manager

        def without_journal(argv):
            if argv[0] == "journalctl":
                raise FileNotFoundError()
            return manager(argv)

        self.tool.runner = without_journal
        with self.assertRaises(service.ServiceError):
            self.tool.execute("logs")

    def test_missing_manager_and_bus_failure_are_not_success(self):
        for error in (FileNotFoundError(), subprocess.TimeoutExpired(["systemctl"], 90)):
            with self.subTest(error=type(error).__name__):
                tool = service.UserService(self.config, "grove.service", self.root / "units",
                                           runner=lambda _: (_ for _ in ()).throw(error))
                with self.assertRaises(service.ServiceError):
                    tool.execute("register", self.binary, self.sha)
        self.manager.failure = "show"
        with self.assertRaises(service.ServiceError):
            self.register()
        self.assertFalse(self.tool.unit_dir.exists())

    def test_bus_exit_one_without_properties_is_not_missing_unit(self):
        self.tool.runner = lambda argv: subprocess.CompletedProcess(argv, 1, "", "no bus")
        with self.assertRaises(service.ServiceError):
            self.register()
        self.assertFalse(self.tool.unit_dir.exists())

    def test_show_failure_with_loaded_properties_is_not_ignored(self):
        self.tool.runner = lambda argv: subprocess.CompletedProcess(
            argv, 1, f"LoadState=loaded\nFragmentPath={self.tool.target}\n", "failure")
        with self.assertRaises(service.ServiceError):
            self.register()
        self.assertFalse(self.tool.unit_dir.exists())

    def test_platform_and_root_rejected_without_commands(self):
        for platform, uid in (("win32", 1000), ("linux", 0)):
            with self.subTest(platform=platform, uid=uid):
                with patch.object(service.sys, "platform", platform), patch.object(
                        service.os, "geteuid", return_value=uid):
                    with self.assertRaises(service.ServiceError):
                        self.register()
                    with patch.object(service.os, "execve") as execute:
                        with self.assertRaises(service.ServiceError):
                            service.launch(self.config, "grove.service")
                        execute.assert_not_called()
        self.assertEqual(self.manager.calls, [])

    def test_strict_names_paths_hashes_and_process_ownership(self):
        for unit in ("other.service", "../grove.service", "grove@a.service",
                     "grove.service\n", "grove-a;id.service", "grove--a.service"):
            with self.subTest(unit=unit), self.assertRaises(service.ServiceError):
                service.UserService(self.config, unit, self.root / "units")
        for path in ("relative/install.json", str(self.root / "../install.json"),
                     str(self.root / "bad\n/install.json")):
            with self.subTest(path=path), self.assertRaises(service.ServiceError):
                service.UserService(path, "grove.service", self.root / "units")
        for binary, sha in ((self.binary, "0" * 64),
                            (self.root / "grove", self.sha), (None, None)):
            with self.subTest(binary=binary), self.assertRaises(service.ServiceError):
                self.tool.plan("register", binary, sha)
        cfg = json.loads(self.config.read_text())
        cfg["service"] = "process"
        self.config.write_text(json.dumps(cfg))
        with self.assertRaises(service.ServiceError):
            self.tool.plan("register", self.binary, self.sha)
        self.assertEqual(self.manager.calls, [])

    def test_tampered_binary_and_manifest_and_pointer_are_rejected(self):
        original = self.binary.read_bytes()
        self.binary.write_bytes(b"tampered")
        with self.assertRaises(service.ServiceError):
            self.tool.plan("register", self.binary, self.sha)
        self.binary.write_bytes(original)
        manifest = self.binary.parent / "manifest.json"
        manifest.write_text('{"files": []}')
        with self.assertRaises(service.ServiceError):
            self.tool.plan("register", self.binary, self.sha)
        (self.install / "current").write_text("../other")
        with self.assertRaises(service.ServiceError):
            self.tool.plan("register", self.binary, self.sha)

    def test_unsafe_permissions_and_symlinks_are_rejected(self):
        self.config.chmod(0o666)
        with self.assertRaises(service.ServiceError):
            self.tool.plan("register", self.binary, self.sha)
        self.config.chmod(0o600)
        self.tool.unit_dir.mkdir()
        self.tool.target.symlink_to(self.config)
        with self.assertRaises(service.ServiceError):
            self.tool.plan("unregister")
        self.tool.target.unlink()
        link = self.root / "linked"
        link.symlink_to(self.install, target_is_directory=True)
        tool = service.UserService(link / "install.json", "grove.service", self.root / "units")
        with self.assertRaises(service.ServiceError):
            tool.plan("register", self.binary, self.sha)

    def test_invalid_listen_addresses_rejected_and_ipv6_supported(self):
        cfg = json.loads(self.config.read_text())
        for listen in ("localhost:8456", "127.0.0.1:0", "[127.0.0.1]:80",
                       "::1:8456", "[[::1]]:8456", "127.0.0.1:65536", "127.0.0.1:８０"):
            cfg["listen"] = listen
            self.config.write_text(json.dumps(cfg))
            with self.subTest(listen=listen), self.assertRaises(service.ServiceError):
                service.installed_server(self.config, "grove.service")
        cfg["listen"] = "[::1]:8456"
        self.config.write_text(json.dumps(cfg))
        argv, _ = service.installed_server(self.config, "grove.service")
        self.assertEqual(argv[3], "[::1]:8456")

    def test_missing_data_directory_is_not_created_during_registration(self):
        self.data.rmdir()
        self.register()
        self.assertFalse(self.data.exists())

    def test_malformed_config_and_unsafe_current_symlink_rejected(self):
        original = self.config.read_bytes()
        for text in ("{", "[]", '{"data_dir": 1, "service": "systemd-user:grove.service"}'):
            self.config.write_text(text)
            with self.subTest(text=text), self.assertRaises(service.ServiceError):
                self.tool.plan("register", self.binary, self.sha)
        self.config.write_bytes(original)
        pointer = self.install / "current"
        text = pointer.read_text()
        pointer.unlink()
        elsewhere = self.root / "pointer"
        elsewhere.write_text(text)
        pointer.symlink_to(elsewhere)
        with self.assertRaises(service.ServiceError):
            self.tool.plan("register", self.binary, self.sha)

    def test_launcher_uses_updated_pointer_and_rollback_without_new_updater(self):
        self.register()
        old = (self.install / "current").read_text()
        new_binary, _ = self.release("0.2.0-012345abcdef", b"new verified release")
        with patch.object(service.os, "execve") as execute:
            service.launch(self.config, "grove.service")
            argv = execute.call_args.args[1]
            env = execute.call_args.args[2]
            self.assertEqual(argv, [str(new_binary), "serve", "--listen", "127.0.0.1:8456",
                                    "--data-dir", str(self.data)])
            self.assertEqual(env["GROVE_WEB_DIR"], str(new_binary.parent / "web"))
            (self.install / "current").write_text(old)
            service.launch(self.config, "grove.service")
            self.assertEqual(execute.call_args.args[0], str(self.binary))

    def test_systemd_arguments_escape_expansion_without_shell(self):
        self.assertEqual(service.systemd_arg('a %h $HOME "x" \\'),
                         '"a %%h $$HOME \\"x\\" \\\\"')
        text = self.tool.unit_text()
        self.assertNotIn("@EXEC_START@", text)
        self.assertIn("KillMode=control-group", text)
        self.assertIn("StandardError=journal", text)
        self.assertNotIn("/bin/sh", text)

    def test_special_path_characters_are_literal_in_launch_and_escaped_in_unit(self):
        special = self.root / 'install %h $HOME "quoted"'
        self.install.rename(special)
        self.config = special / "install.json"
        tool = service.UserService(self.config, "grove.service", self.root / "units", self.manager)
        text = tool.unit_text()
        self.assertIn('install %%h $$HOME \\"quoted\\"', text)
        with patch.object(service.os, "execve") as execute:
            service.launch(self.config, "grove.service")
            self.assertEqual(execute.call_args.args[0],
                             str(special / "releases/0.1.0-abcdef012345/grove"))

    def test_cli_plan_linger_and_run_require_no_host_calls(self):
        base = ["--config", str(self.config), "--unit", "grove.service",
                "--unit-dir", str(self.tool.unit_dir)]
        with patch.object(service, "run_command", side_effect=AssertionError("host command")), \
                patch.object(service.os, "execve", side_effect=AssertionError("host binary")), \
                redirect_stdout(StringIO()) as output, redirect_stderr(StringIO()):
            self.assertEqual(service.main(["register", *base, "--binary", str(self.binary),
                                           "--sha256", self.sha]), 0)
            self.assertFalse(json.loads(output.getvalue())["applied"])
            self.assertEqual(service.main(["linger", *base, "--apply"]), 0)
            self.assertEqual(service.main(["run", *base]), 1)
        self.assertFalse(self.tool.unit_dir.exists())

    def test_command_error_does_not_echo_private_output(self):
        self.register()
        self.manager.failure = "start"
        with self.assertRaises(service.ServiceError) as raised:
            self.tool.execute("start")
        self.assertNotIn("private diagnostic", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
