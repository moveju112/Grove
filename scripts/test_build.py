"""변경 영향 규칙 시험(BUILD-042). 실행: python3 -m unittest scripts/test_build.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
