"""공식 원격이나 실사용 서비스에 쓰지 않는 릴리즈 경계 시험."""
import io
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
import push_release as push


class ReleasePush(unittest.TestCase):
    @unittest.skipUnless(shutil.which("cargo", path=push.build.env()["PATH"]), "Cargo가 필요합니다")
    def test_releases_reuse_dependency_and_rebuild_changed_archived_source(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"CARGO_BUILD_BUILD_DIR": "{workspace-root}/target"}):
            parent = Path(temp).resolve()
            dep = parent / "dep"
            (dep / "src").mkdir(parents=True)
            (dep / "Cargo.toml").write_text('[package]\nname="dep"\nversion="0.1.0"\nedition="2021"')
            (dep / "src/lib.rs").write_text('pub const VALUE: u8 = 3;')
            for attempt in (1, 2):
                with push.release_source(parent) as (source, _lock_fd):
                    (source / "src").mkdir()
                    (source / "Cargo.toml").write_text('[package]\nname="probe"\nversion="0.1.0"\nedition="2021"\n[dependencies]\ndep={path="../dep"}')
                    code = f'fn main() {{ println!("{{}}", dep::VALUE + {attempt}); }}'.encode()
                    with tempfile.TemporaryFile() as archive:
                        with tarfile.open(fileobj=archive, mode="w") as tar:
                            member = tarfile.TarInfo("src/main.rs")
                            member.size = len(code)
                            member.mtime = 100
                            tar.addfile(member, io.BytesIO(code))
                        archive.seek(0)
                        with tarfile.open(fileobj=archive) as tar:
                            tar.extractall(source, filter=push.fresh_member)
                    env = push.release_build_env(source, parent)
                    self.assertEqual(Path(env["CARGO_BUILD_BUILD_DIR"]), parent / "cargo-build")
                    out = subprocess.check_output(["cargo", "build", "--offline", "--message-format=json"],
                                                  cwd=source, env=env, text=True)
                    dep_result = next(row for row in map(json.loads, out.splitlines())
                                      if row["reason"] == "compiler-artifact" and row["target"]["name"] == "dep")
                    self.assertEqual(dep_result["fresh"], attempt == 2)
                    binary = source / "target/debug/probe"
                    self.assertEqual(subprocess.check_output([binary], text=True).strip(), str(3 + attempt))
            source = parent / "source"
            source.mkdir()
            (source / "notes").write_text("preserve")
            with self.assertRaises(ValueError), push.release_source(parent):
                pass
            self.assertTrue((source / "notes").exists())

    def test_version_step_only_changes_the_product_versions(self):
        self.assertEqual(push.next_patch("0.1.9"), "0.1.10")
        for v in ("latest", "v0.1.0", "0.1.0-beta.1"):
            with self.assertRaises(ValueError):
                push.next_patch(v)
        old = push.tomllib.loads((push.ROOT / "Cargo.toml").read_text())["package"]["version"]
        edits = push.version_files(push.ROOT, old, push.next_patch(old))
        self.assertEqual(len(edits), 4)
        self.assertEqual(sum(a != b for a, b in zip((push.ROOT / "Cargo.lock").read_text().splitlines(),
                                                    edits[push.ROOT / "Cargo.lock"].splitlines())), 1)
        lock = json.loads(edits[push.ROOT / "web/package-lock.json"])
        self.assertEqual(lock["version"], lock["packages"][""]["version"])

    def test_normal_git_push_runs_once_and_fetch_dry_run_and_push_only_do_not(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "local"
            root.mkdir()
            def git(*args, **kwargs):
                subprocess.run(["git", *args], cwd=root, capture_output=True, check=True, **kwargs)
            git("init", "--bare", str(Path(temp) / "remote"))
            git("init", "-b", "main")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@example.invalid")
            git("remote", "add", "origin", str(Path(temp) / "remote"))
            scripts = root / "scripts"
            scripts.mkdir()
            for name in ("git_release_hook.sh", "git_release_pre_push.sh"):
                shutil.copy(push.ROOT / "scripts" / name, scripts)
            (scripts / "push_release.py").write_text(
                "import os, subprocess\nfrom pathlib import Path\n"
                "def git(*args): subprocess.run(['git', *args], check=True, env={**os.environ, 'GROVE_RELEASE_PUSH_INTERNAL': '1'})\n"
                "count = Path('calls')\nversion = len(count.read_text().splitlines()) + 1 if count.exists() else 1\n"
                "git('commit', '--allow-empty', '-m', f'patch {version}')\n"
                "git('push', '--atomic', 'origin', 'HEAD:refs/heads/main', f'HEAD:refs/tags/v0.1.{version}')\n"
                "with count.open('a') as f: f.write('published\\n')\n"
            )
            git("add", "scripts")
            git("commit", "-m", "fixture")
            with patch.object(push, "ROOT", root):
                push.install_hook()
                push.install_hook()
            git("push", "--dry-run", "origin", "main")
            self.assertFalse((root / "calls").exists())
            git("push", "origin", "main")
            git("push", "origin", "main")
            git("fetch", "origin")
            git("commit", "--allow-empty", "-m", "second patch")
            git("push", "origin", "HEAD:main")
            git("commit", "--allow-empty", "-m", "next")
            git("push", "origin", "main", env={**os.environ, "GROVE_PUSH_ONLY": "1"})
            git("commit", "--allow-empty", "-m", "internal")
            git("push", "origin", "main", env={**os.environ, "GROVE_RELEASE_PUSH_INTERNAL": "1"})
            git("ls-remote", "--exit-code", "origin", "refs/tags/v0.1.2")
            self.assertEqual((root / "calls").read_text(), "published\npublished\n")

    def test_next_patch_and_retry_of_published_commit(self):
        from contextlib import redirect_stdout
        from io import StringIO
        for latest, head, source, expected in (
                ("0.1.0", "new", "0.1.0", "v0.1.1"),
                ("0.1.0", "new", "0.1.1", "v0.1.1"),
                ("0.1.1", "tagged", "0.1.1", "v0.1.1"),
                ("0.1.1", "next", "0.1.1", "v0.1.2")):
            def output(*args):
                return {("branch", "--show-current"): "main",
                        ("remote", "get-url", "--push", "origin"): f"https://github.com/{push.REPO}.git",
                        ("rev-parse", "HEAD"): head,
                        ("show", "HEAD:Cargo.toml"): f'[package]\nversion = "{source}"',
                        ("status", "--porcelain", "--untracked-files=no"): ""}[args[1:]]
            message = StringIO()
            with self.subTest(head=head, source=source), patch.object(push, "output", side_effect=output), \
                    patch.object(push, "gh", side_effect=[json.dumps({"tag_name": "v" + latest}), '{"sha":"tagged"}']), \
                    redirect_stdout(message):
                push.publish(plan_only=True)
            self.assertIn(f" · {expected} · ", message.getvalue())

    def test_upload_retry_never_overwrites_a_different_asset(self):
        with tempfile.TemporaryDirectory() as temp:
            pkg = Path(temp)
            names = push.file_names("0.1.1")
            assets = []
            for name in names:
                (pkg / name).write_text(name)
                assets.append({"name": name, "digest": "sha256:" + push.build.sha256(pkg / name), "state": "uploaded"})
            draft = {"id": 1, "draft": True, "assets": assets[:-1]}
            with patch.object(push, "run") as run, patch.object(push, "gh", side_effect=[
                    json.dumps(dict(draft, assets=assets)), '{"tag_name":"v0.1.0"}']):
                push.sync_assets("v0.1.1", pkg, "0.1.1", draft)
                self.assertEqual([c.args[2] for c in run.call_args_list], ["upload", "edit"])
            assets[0]["digest"] = "different"
            with patch.object(push, "run") as run, self.assertRaises(ValueError):
                push.sync_assets("v0.1.1", pkg, "0.1.1", draft)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
