"""GROVE_TEST_BIN=<검증한 실행 파일> python3 scripts/test_deploy_cli.py"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("deploy", Path(__file__).with_name("deploy_local.py"))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


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
            (root / "current").write_text("existing\n")
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
            config = json.loads(subprocess.check_output([str(launcher), "config"], env=env, text=True))
            self.assertEqual(config["data_dir"], str(root / "data"))
            self.assertEqual(config["listen"], "127.0.0.1:49120")
            self.assertFalse((root / "data").exists())
            self.assertEqual((root / "current").read_text(), "existing\n")
            self.assertEqual((release / "grove").read_bytes(), before)
            self.assertEqual((release / "web/index.html").read_text(), "existing UI")

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
