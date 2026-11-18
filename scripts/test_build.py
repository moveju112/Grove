"""변경 영향 규칙 시험(BUILD-042). 실행: python3 -m unittest scripts/test_build.py"""
import os
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build  # noqa: E402


class Environment(unittest.TestCase):
    def test_explicit_shared_toolchain_and_cache_are_preserved(self):
        with patch.dict(os.environ, {"CARGO_HOME": "/shared/cargo",
                                    "RUSTUP_HOME": "/shared/rustup",
                                    "CARGO_TARGET_DIR": "/shared/target",
                                    "PATH": "/usr/bin"}, clear=True):
            result = build.env()
        self.assertEqual(result["CARGO_HOME"], "/shared/cargo")
        self.assertEqual(result["RUSTUP_HOME"], "/shared/rustup")
        self.assertEqual(result["CARGO_TARGET_DIR"], "/shared/target")
        self.assertEqual(result["PATH"].split(os.pathsep)[0], "/shared/cargo/bin")

    def test_unconfigured_checkout_uses_repository_toolchain(self):
        with patch.dict(os.environ, {"PATH": "/usr/bin"}, clear=True):
            result = build.env()
        self.assertEqual(result["CARGO_HOME"], os.path.join(build.DEV, "cargo"))
        self.assertEqual(result["RUSTUP_HOME"], os.path.join(build.DEV, "rustup"))

    def test_release_binary_uses_cargo_reported_shared_target(self):
        metadata = json.dumps({"target_directory": "/shared/cargo-target"})
        with patch.object(build, "run"), patch.object(build, "out", return_value=metadata):
            binary = build.build_server("linux-x64", 2)
        self.assertEqual(binary, "/shared/cargo-target/x86_64-unknown-linux-gnu/release/grove")


class Plan(unittest.TestCase):
    def scope(self, *files):
        return build.plan_for(list(files))

    def test_docs_only_builds_nothing(self):
        p = self.scope("TODO.md", "migration/RULEBOOK.md", "README.md")
        self.assertEqual(p["scope"], "none")
        self.assertEqual(p["builds"], [])

    def test_ui_only_does_not_rebuild_server(self):
        p = self.scope("web/app/components/SessionView.tsx", "web/app/app.css")
        self.assertEqual(p["builds"], ["web"])
        self.assertNotIn("rust", p["tests"])

    def test_server_only_does_not_rebuild_web_but_runs_e2e(self):
        p = self.scope("src/runner.rs")
        self.assertEqual(p["builds"], ["server"])
        self.assertIn("e2e", p["tests"])
        self.assertIn("ts_bindings", p["tests"], "서버 타입 변경이 생성 타입과 어긋나는지 확인")

    def test_protocol_change_builds_both(self):
        for f in ("web/app/api/generated.ts", "src/lib.rs"):
            p = self.scope(f)
            self.assertEqual(p["scope"], "protocol", f)
            self.assertEqual(set(p["builds"]), {"server", "web"})

    def test_lockfiles_and_toolchain_mean_everything(self):
        for f in ("Cargo.lock", "web/package-lock.json", "rust-toolchain.toml", "scripts/build.py"):
            self.assertEqual(self.scope(f)["scope"], "all", f)

    def test_unknown_paths_widen_to_all(self):
        self.assertEqual(self.scope("weird/thing.bin")["scope"], "all")

    def test_server_plus_web_is_full(self):
        self.assertEqual(set(self.scope("src/x.rs", "web/app/y.tsx")["builds"]), {"server", "web"})


class Scan(unittest.TestCase):
    def test_detects_personal_paths_secrets_and_dev_files(self):
        import tempfile

        d = tempfile.mkdtemp()
        open(os.path.join(d, "ok.txt"), "w").write("hello")
        open(os.path.join(d, "leak.js"), "w").write(f"x='{build.ROOT}/src'")
        open(os.path.join(d, "key.txt"), "w").write("-----BEGIN PRIVATE KEY-----")
        open(os.path.join(d, "app.js.map"), "w").write("{}")
        # 형식 정의(접두어·파일 이름)는 비밀이 아니다
        open(os.path.join(d, "login.js"), "w").write("if(t.startsWith('grv_'))x(); see owner-token file")
        open(os.path.join(d, "tok.txt"), "w").write("grv_01a1aaaf-f2b4-7207.abcdefghijklmnopqrstuvwxyz012345")
        bad = "\n".join(build.scan(d))
        self.assertNotIn("login.js", bad)
        self.assertIn("tok.txt: 비밀정보", bad)
        self.assertIn("leak.js: 개인 경로", bad)
        self.assertIn("key.txt: 비밀정보", bad)
        self.assertIn("app.js.map: 개발 파일", bad)
        self.assertFalse(any(line.startswith("ok.txt") for line in bad.splitlines()), bad)


class Verification(unittest.TestCase):
    def execute(self, *args, fail=None):
        calls = []

        def run(step, cmd, **kwargs):
            calls.append((step, cmd, kwargs))
            if step == fail:
                raise SystemExit(23)
            return 0

        metadata = '{"target_directory": "/tmp/grove-custom-target"}'
        with patch.dict(os.environ), patch.object(build, "run", side_effect=run), patch.object(build, "out", return_value=metadata) as out, redirect_stdout(StringIO()) as output:
            try:
                build.main(["test", *args])
            except SystemExit as e:
                return calls, e.code, output.getvalue()
            if "--dry-run" in args:
                out.assert_not_called()
        return calls, 0, output.getvalue()

    def test_scope_is_required_before_running_anything(self):
        calls, code, _ = self.execute()
        self.assertEqual(code, 2)
        self.assertEqual(calls, [])

    def test_rust_selection_does_not_run_unrelated_checks(self):
        calls, code, _ = self.execute("--rust", "storage", "worktrees")
        self.assertEqual(code, 0)
        self.assertEqual([cmd for _, cmd, _ in calls], [
            ["cargo", "test", "--test", "storage", "--test", "worktrees"],
        ])

    def test_library_filter_is_passed_to_cargo(self):
        calls, code, _ = self.execute("--lib", "--filter", "config::tests")
        self.assertEqual(code, 0)
        self.assertEqual(calls[0][1], ["cargo", "test", "--lib", "config::tests"])

    def test_filter_without_rust_scope_is_rejected(self):
        calls, code, _ = self.execute("--filter", "config")
        self.assertEqual(code, 2)
        self.assertEqual(calls, [])

    def test_web_selection_does_not_compile_rust(self):
        calls, code, _ = self.execute("--vitest", "app/state/capabilities.test.ts", "--typecheck")
        self.assertEqual(code, 0)
        self.assertEqual([cmd for _, cmd, _ in calls], [
            ["npm", "run", "typecheck"],
            ["npx", "vitest", "run", "app/state/capabilities.test.ts"],
        ])

    def test_e2e_builds_debug_and_uses_that_exact_binary(self):
        calls, code, _ = self.execute("--e2e", "e2e/worktrees.spec.ts")
        self.assertEqual(code, 0)
        self.assertEqual([cmd for _, cmd, _ in calls], [
            ["cargo", "build", "--bin", "grove"],
            ["npm", "run", "build"],
            ["npx", "playwright", "test", "e2e/worktrees.spec.ts"],
        ])
        expected = os.path.join("/tmp/grove-custom-target", "debug", "grove.exe" if os.name == "nt" else "grove")
        self.assertEqual(calls[-1][2]["extra_env"]["GROVE_BIN"], expected)
        self.assertEqual(calls[-1][2]["extra_env"]["GROVE_E2E_FAST"], "1")
        self.assertNotIn("--release", [arg for _, cmd, _ in calls for arg in cmd])

    def test_selected_regression_keeps_original_policy(self):
        with patch.dict(os.environ, {"GROVE_E2E_FAST": "1"}):
            calls, code, _ = self.execute("--e2e", "e2e/scroll.spec.ts", "--e2e-regression")
        self.assertEqual(code, 0)
        self.assertEqual(calls[-1][1], ["npx", "playwright", "test", "e2e/scroll.spec.ts"])
        self.assertEqual(calls[-1][2]["extra_env"]["GROVE_E2E_FAST"], "0")

    def test_relay_selection_builds_once_and_uses_isolated_browser_tmp(self):
        calls, code, _ = self.execute("--e2e", "e2e/encrypted.spec.ts", "--relay-e2e", "mobile-relay.spec.ts")
        self.assertEqual(code, 0)
        self.assertEqual([name for name, _, _ in calls].count("server debug build"), 1)
        self.assertEqual([name for name, _, _ in calls].count("web build"), 1)
        self.assertEqual(calls[-1][1], ["npx", "playwright", "test", "-c", "playwright.relay.config.ts", "mobile-relay.spec.ts"])
        self.assertTrue(calls[-1][2]["extra_env"]["TMPDIR"].startswith("/tmp/gpr-"))

    def test_relay_without_file_runs_all_relay_scenarios_but_not_full(self):
        calls, code, _ = self.execute("--relay-e2e")
        self.assertEqual(code, 0)
        self.assertEqual(calls[-1][1], ["npx", "playwright", "test", "-c", "playwright.relay.config.ts"])
        calls, code, _ = self.execute("--full", "--relay-e2e")
        self.assertEqual(code, 2)
        self.assertEqual(calls, [])

    def test_regression_mode_requires_selected_e2e(self):
        for args in [[], ["--typecheck"], ["--full"]]:
            with self.subTest(args=args):
                calls, code, _ = self.execute(*args, "--e2e-regression")
                self.assertEqual(code, 2)
                self.assertEqual(calls, [])

    def test_full_is_explicit_and_covers_all_suites(self):
        calls, code, _ = self.execute("--full")
        self.assertEqual(code, 0)
        self.assertEqual(calls[0][1], ["cargo", "test", "--no-fail-fast"])
        self.assertIn(["npx", "vitest", "run"], [cmd for _, cmd, _ in calls])
        self.assertEqual(calls[-1][1], ["npx", "playwright", "test"])
        self.assertEqual(calls[-1][2]["extra_env"]["GROVE_E2E_FAST"], "0")

    def test_full_cannot_be_misreported_with_a_filter(self):
        calls, code, _ = self.execute("--full", "--lib", "--filter", "config")
        self.assertEqual(code, 2)
        self.assertEqual(calls, [])

    def test_failure_preserves_exit_code_and_reports_unrun_checks(self):
        calls, code, output = self.execute("--full", fail="rust tests")
        self.assertEqual(code, 23)
        self.assertEqual(len(calls), 1)
        self.assertIn("미실행", output)
        self.assertIn("e2e", output)

    def test_failed_debug_build_never_launches_e2e(self):
        calls, code, output = self.execute("--e2e", "e2e/worktrees.spec.ts", fail="server debug build")
        self.assertEqual(code, 23)
        self.assertEqual(len(calls), 1)
        self.assertIn("미실행", output)

    def test_dry_run_has_no_build_or_test_side_effects(self):
        calls, code, output = self.execute("--rust", "api", "--dry-run")
        self.assertEqual(code, 0)
        self.assertEqual(calls, [])
        self.assertIn("cargo test --test api", output)

    def test_e2e_dry_run_displays_policy_without_running(self):
        for args, mode in [
            (["--e2e", "e2e/scroll.spec.ts"], "1"),
            (["--e2e", "e2e/scroll.spec.ts", "--e2e-regression"], "0"),
            (["--full"], "0"),
        ]:
            with self.subTest(args=args):
                calls, code, output = self.execute(*args, "--dry-run")
                self.assertEqual(code, 0)
                self.assertEqual(calls, [])
                self.assertIn(f"e2e: GROVE_E2E_FAST={mode} npx playwright test", output)

    def test_real_child_failure_keeps_its_exit_status(self):
        with redirect_stdout(StringIO()), self.assertRaises(SystemExit) as raised:
            build.run("intentional failure", [sys.executable, "-c", "raise SystemExit(23)"])
        self.assertEqual(raised.exception.code, 23)
        self.assertEqual(build.LOG[-1]["exit"], 23)


class PlaywrightPolicy(unittest.TestCase):
    def test_loaded_config_applies_fast_mode_only_when_explicit(self):
        # --list로 실제 설정을 읽되 서버·브라우저·실모델은 실행하지 않는다.
        web = os.path.join(build.ROOT, "web")
        with tempfile.TemporaryDirectory(prefix="grove-policy-") as tmp:
            config = os.path.join(tmp, "playwright.config.ts")
            with open(config, "w") as f:
                f.write(
                    f"import original from {json.dumps(os.path.join(web, 'playwright.config.ts'))};\n"
                    "console.log('GROVE_POLICY=' + JSON.stringify({"
                    "timeout: original.timeout, expect: original.expect?.timeout,"
                    "maxFailures: original.maxFailures, retries: original.retries}));\n"
                    f"export default {{ ...original, testDir: {json.dumps(os.path.join(web, 'e2e'))},"
                    "globalSetup: undefined, globalTeardown: undefined };\n"
                )
            for mode, expected in [
                ("1", {"timeout": 20_000, "expect": 3_000, "maxFailures": 1, "retries": 0}),
                ("0", {"timeout": 60_000}),
                (None, {"timeout": 60_000}),
            ]:
                with self.subTest(mode=mode):
                    e = dict(os.environ)
                    e.pop("GROVE_E2E_FAST", None)
                    if mode is not None:
                        e["GROVE_E2E_FAST"] = mode
                    result = subprocess.run(
                        ["node", os.path.join(web, "node_modules", "@playwright", "test", "cli.js"),
                         "test", "--config", config, "--list", "scroll.spec.ts"],
                        cwd=web, env=e, capture_output=True, text=True, timeout=20,
                    )
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    policy = next(line.removeprefix("GROVE_POLICY=") for line in result.stdout.splitlines()
                                  if line.startswith("GROVE_POLICY="))
                    self.assertEqual(json.loads(policy), expected)


if __name__ == "__main__":
    unittest.main()
