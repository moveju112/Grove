// 시험용 grove 서버와 로컬 모델 fixture를 띄운다. 데이터는 매번 새 임시 디렉터리에 둔다.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "./fixture";

export const STATE = join(tmpdir(), "grove-e2e-state.json");
const PORT = 17741;
export const ISSUANCE_PASSWORD = "test-only e2e issuance password";

export function configurePairing(bin: string, data: string) {
    execFileSync(bin, ["pairing", "set-password", "--password-stdin", "--data-dir", data], {
        input: `${ISSUANCE_PASSWORD}\n`,
    });
}

export default async function globalSetup() {
    const root = new URL("../..", import.meta.url).pathname;
    const work = mkdtempSync(join(tmpdir(), "grove-e2e-"));
    const data = join(work, "data");
    // 다른 빌드가 공용 산출물을 교체해도 실행 중인 검사의 HTML·청크·SW는 같은 빌드로 유지한다.
    const web = join(work, "web");
    cpSync(join(root, "web/build/client"), web, { recursive: true });
    const fixture = await startFixture(17742);
    const bin = process.env.GROVE_BIN ?? join(root, "target/debug/grove");
    configurePairing(bin, data);
    const cliDir = process.env.GROVE_E2E_FAKE_CLI === "1" ? mkdtempSync(join(work, "cli-")) : undefined;
    if (cliDir) {
        copyFileSync(join(root, "web/e2e/fixtures/codex.mjs"), join(cliDir, "codex"));
        chmodSync(join(cliDir, "codex"), 0o700);
        copyFileSync(join(root, "web/e2e/fixtures/codex.mjs"), join(cliDir, "claude"));
        chmodSync(join(cliDir, "claude"), 0o700);
        writeFileSync(join(cliDir, "claude-auth"), "in");
    }
    const child = spawn(bin, ["serve", "--listen", `127.0.0.1:${PORT}`, "--data-dir", data], {
        // 원격 감시 시험은 loopback 평문 fixture를 쓴다(그 밖의 대상은 여전히 HTTPS만).
        env: { ...process.env, GROVE_WEB_DIR: web, GROVE_LOG: "warn", GROVE_REMOTE_WATCH_INSECURE_LOOPBACK: "1",
            ...(cliDir ? { PATH: `${cliDir}:${process.env.PATH}`, CLI_FIXTURE_DIR: cliDir,
                AGENTS_IMAGE_CACHE: join(work, "image-downscale") } : {}) },
        stdio: ["ignore", "inherit", "inherit"],
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/api/v1/health`);
            if (r.ok) break;
        } catch {
            /* 아직 기동 중 */
        }
        if (Date.now() > deadline) throw new Error("grove 서버가 시작되지 않았습니다");
        await new Promise((r) => setTimeout(r, 100));
    }
    const token = readFileSync(join(data, "owner-token"), "utf8").trim();
    // 일반 회귀 시험은 초기 구성이 끝난 서버를 사용한다. 위저드 시험은 별도 데몬에서 검증한다.
    const setup = await fetch(`http://127.0.0.1:${PORT}/api/v1/daemon-setup`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "e2e-initial-setup" },
        body: JSON.stringify({ output_style: "default", output_style_revision: 0 }),
    });
    if (!setup.ok) { child.kill(); fixture.close(); throw new Error(`시험용 데몬 초기 설정 실패: ${setup.status}`); }
    // 프로젝트 디렉터리 두 개
    const projA = mkdtempSync(join(work, "alpha-"));
    const projB = mkdtempSync(join(work, "beta-"));
    writeFileSync(STATE, JSON.stringify({ pid: child.pid, work, token, projA, projB, fixturePort: 17742, cliDir }));
    (globalThis as { __fixture?: { close: () => void } }).__fixture = fixture;
}
