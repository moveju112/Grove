"""설치·서비스 변경 없이 실제 dpkg 패키징을 검사한다.

실행: python3 -m unittest scripts.test_debian
"""

from contextlib import redirect_stdout
import hashlib
from io import BytesIO, StringIO
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build
import debian


class DebianPolicy(unittest.TestCase):
    def test_prerelease_sorts_before_release_and_revisions_increase(self):
        prerelease = debian.version("0.1.0-beta.1", "1")
        release = debian.version("0.1.0", "1")
        self.assertEqual(prerelease, "0.1.0~beta.1-1")
        subprocess.run(["dpkg", "--compare-versions", prerelease, "lt", release], check=True)
        subprocess.run(["dpkg", "--compare-versions", release, "lt", debian.version("0.1.0", "2")], check=True)

    def test_invalid_platform_and_revision_fail_before_invoking_tools(self):
        with patch.object(debian.subprocess, "check_output") as command:
            for targets, revision in [(["windows-x64"], "1"), (["linux-x64"], "../1"),
                                      (["linux-x64"], "1\nDepends: evil")]:
                with self.subTest(targets=targets, revision=revision), self.assertRaises(SystemExit):
                    debian.validate(targets, revision)
            command.assert_not_called()

    def test_cross_build_is_explicitly_rejected(self):
        with patch.object(debian.subprocess, "check_output", return_value="amd64\n"):
            debian.validate(["linux-x64"], "1")
            with self.assertRaisesRegex(SystemExit, "native"):
                debian.validate(["linux-arm64"], "1")
        with patch.object(debian.subprocess, "check_output", return_value="arm64\n"):
            debian.validate(["linux-arm64"], "1")

    def test_dry_run_never_creates_dist_or_builds(self):
        with tempfile.TemporaryDirectory(prefix="grove-deb-plan-") as temporary:
            root = Path(temporary)
            (root / "Cargo.toml").write_text('[package]\nversion = "0.1.0"\n')
            with patch.object(build, "ROOT", temporary), patch.object(debian, "validate"), \
                    patch.object(build, "out", return_value="fixture tool version"), \
                    patch.object(build, "build_server") as server, \
                    patch.object(build, "build_web", return_value=("", "web-input", False)), \
                    redirect_stdout(StringIO()) as output:
                build.main(["package", "--targets", "linux-x64", "--deb", "--dry-run"])
            server.assert_not_called()
            self.assertFalse((root / "dist").exists())
            self.assertIn(".deb:", output.getvalue())

    def test_source_changes_cannot_be_reported_as_a_successful_build(self):
        with tempfile.TemporaryDirectory(prefix="grove-source-test-") as temporary:
            root = Path(temporary)
            (root / "server.rs").write_text("fixed server source")
            (root / "web.ts").write_text("fixed web source")
            with patch.object(build, "ROOT", temporary), \
                    patch.object(build, "SERVER_INPUTS", ["server.rs"]), \
                    patch.object(build, "WEB_INPUTS", ["web.ts"]):
                server = build.tree_hash(build.SERVER_INPUTS, "rust")
                web = build.tree_hash(build.WEB_INPUTS, "node")
                build.require_unchanged_sources(server, web, "rust", "node")
                (root / "server.rs").write_text("concurrent server edit")
                with self.assertRaisesRegex(SystemExit, "성공 receipt"):
                    build.require_unchanged_sources(server, web, "rust", "node")
                server = build.tree_hash(build.SERVER_INPUTS, "rust")
                (root / "web.ts").write_text("concurrent web edit")
                with self.assertRaisesRegex(SystemExit, "성공 receipt"):
                    build.require_unchanged_sources(server, web, "rust", "node")


class DebianArtifact(unittest.TestCase):
    def test_real_package_layout_metadata_ownership_and_data_preservation(self):
        architecture = subprocess.check_output(["dpkg", "--print-architecture"], text=True).strip()
        target = {"amd64": "linux-x64", "arm64": "linux-arm64"}[architecture]
        with tempfile.TemporaryDirectory(prefix="grove-deb-test-") as temporary:
            work = Path(temporary)
            home = work / "home"
            home.mkdir()
            (home / "grove.db").write_bytes(b"preserve user data")
            source = work / "grove"
            source.mkdir()
            shutil.copyfile("/bin/true", source / "grove")
            (source / "web").mkdir()
            (source / "web/index.html").write_text("<html>fixture</html>")
            (source / "licenses").mkdir()
            (source / "licenses/THIRD_PARTY_NOTICES.txt").write_text("fixture license notice\n")
            (source / "manifest.json").write_text('{"version": "0.1.0"}')
            archive = work / "grove.tar.gz"
            with tarfile.open(archive, "w:gz") as bundle:
                bundle.add(source, arcname="grove")
            # 서비스 unit·웹은 restrictive umask에서도 사용자에게 읽혀야 한다.
            previous = os.umask(0o077)
            try:
                result = debian.package(archive, work, target, "0.1.0", "1")
            finally:
                os.umask(previous)
            artifact = work / result["file"]
            fields = subprocess.check_output(
                ["dpkg-deb", "--field", str(artifact), "Package", "Version", "Architecture", "Depends"],
                text=True)
            self.assertIn("Package: grove\n", fields)
            self.assertIn("Version: 0.1.0-1\n", fields)
            self.assertIn(f"Architecture: {architecture}\n", fields)
            self.assertIn("libc6", result["depends"])
            self.assertEqual(hashlib.sha256(artifact.read_bytes()).hexdigest(), result["sha256"])
            unpacked = work / "unpacked"
            subprocess.run(["dpkg-deb", "--extract", str(artifact), str(unpacked)], check=True)
            command = unpacked / "usr/bin/grove"
            self.assertEqual(os.readlink(command), "../lib/grove/grove")
            self.assertEqual(command.read_bytes(), (source / "grove").read_bytes())
            self.assertEqual((unpacked / "usr/lib/grove/web/index.html").read_text(), "<html>fixture</html>")
            unit = (unpacked / "usr/lib/systemd/user/grove.service").read_text()
            self.assertIn("ExecStart=/usr/bin/grove serve\n", unit)
            self.assertNotIn("@EXEC_START@", unit)
            self.assertNotIn("User=root", unit)
            data = subprocess.check_output(["dpkg-deb", "--fsys-tarfile", str(artifact)])
            with tarfile.open(fileobj=BytesIO(data)) as bundle:
                for entry in bundle:
                    self.assertEqual((entry.uid, entry.gid), (0, 0), entry.name)
                    if entry.isdir():
                        self.assertEqual(entry.mode, 0o755, entry.name)
                    elif entry.isfile():
                        expected = 0o755 if entry.name == "./usr/lib/grove/grove" else 0o644
                        self.assertEqual(entry.mode, expected, entry.name)
                    self.assertTrue(entry.name == "." or entry.name.startswith("./usr"), entry.name)
            control = work / "control"
            subprocess.run(["dpkg-deb", "--control", str(artifact), str(control)], check=True)
            self.assertEqual({path.name for path in control.iterdir()}, {"control", "md5sums"})
            self.assertEqual((home / "grove.db").read_bytes(), b"preserve user data")
            self.assertIn("fixture license notice", (unpacked / "usr/share/doc/grove/copyright").read_text())
            self.assertFalse(any(path.name.startswith("grove-deb-") for path in work.iterdir()))


class DebianCache(unittest.TestCase):
    def test_existing_archive_can_gain_deb_and_changed_bytes_are_not_reused(self):
        with tempfile.TemporaryDirectory(prefix="grove-deb-cache-") as temporary:
            root = Path(temporary)
            (root / "grove.tar.gz").write_bytes(b"existing archive fixture")
            (root / "manifest.json").write_text('{"version": "0.1.0", "protocol": 1, "schema": 1}')
            (root / "sbom.cdx.json").write_text("{}")
            receipt = {"archive": "grove.tar.gz", "archive_sha256": build.sha256(str(root / "grove.tar.gz")),
                       "version": "0.1.0"}
            calls = []

            def package(archive, output_dir, target, upstream, revision):
                calls.append(revision)
                path = root / f"grove_0.1.0-{revision}_amd64.deb"
                path.write_bytes(b"deb fixture")
                return {"file": path.name, "sha256": build.sha256(str(path)), "size": path.stat().st_size}

            with patch.object(debian, "package", side_effect=package), \
                    patch.object(build, "verify_package", return_value={"executed": True}) as verify, \
                    redirect_stdout(StringIO()):
                build.add_deb(receipt, temporary, "linux-x64", "1")
                build.add_deb(receipt, temporary, "linux-x64", "1")
                self.assertEqual(calls, ["1"])
                (root / receipt["deb"]["file"]).write_bytes(b"corrupted")
                build.add_deb(receipt, temporary, "linux-x64", "1")
                build.add_deb(receipt, temporary, "linux-x64", "2")
                self.assertEqual(calls, ["1", "1", "2"])
                self.assertTrue(verify.call_args.kwargs["deb"])
            self.assertEqual(json.loads((root / "receipt.json").read_text())["deb"], receipt["deb"])
            for line in (root / "SHA256SUMS").read_text().splitlines():
                expected, filename = line.split("  ", 1)
                self.assertEqual(build.sha256(str(root / filename)), expected)
            self.assertEqual((root / "grove.tar.gz").read_bytes(), b"existing archive fixture")

    def test_failed_verification_does_not_publish_success_receipt(self):
        with tempfile.TemporaryDirectory(prefix="grove-deb-fail-") as temporary:
            root = Path(temporary)
            (root / "manifest.json").write_text("{}")
            receipt = {"archive": "grove.tar.gz", "archive_sha256": "fixture", "version": "0.1.0"}
            with patch.object(debian, "package", return_value={"file": "fixture.deb"}), \
                    patch.object(build, "verify_package", side_effect=SystemExit("health failure")):
                with self.assertRaisesRegex(SystemExit, "health failure"):
                    build.add_deb(receipt, temporary, "linux-x64", "1")
            self.assertNotIn("deb", receipt)
            self.assertFalse((root / "receipt.json").exists())


if __name__ == "__main__":
    unittest.main()
