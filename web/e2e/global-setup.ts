// 시험용 grove 서버와 로컬 모델 fixture를 띄운다. 데이터는 매번 새 임시 디렉터리에 둔다.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "./fixture";

export const STATE = join(tmpdir(), "grove-e2e-state.json");
const PORT = 17741;

export default async function globalSetup() {
    const root = new URL("../..", import.meta.url).pathname;
    const work = mkdtempSync(join(tmpdir(), "grove-e2e-"));
    const data = join(work, "data");
    const fixture = await startFixture(17742);
    const bin = process.env.GROVE_BIN ?? join(root, "target/debug/grove");
    const child = spawn(bin, ["serve", "--listen", `127.0.0.1:${PORT}`, "--data-dir", data], {
        // 원격 감시 시험은 loopback 평문 fixture를 쓴다(그 밖의 대상은 여전히 HTTPS만).
        env: { ...process.env, GROVE_WEB_DIR: join(root, "web/build/client"), GROVE_ENABLE_TOOL_LOOP: "1", GROVE_LOG: "warn", GROVE_REMOTE_WATCH_INSECURE_LOOPBACK: "1" },
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
    // 프로젝트 디렉터리 두 개
    const projA = mkdtempSync(join(work, "alpha-"));
    const projB = mkdtempSync(join(work, "beta-"));
    writeFileSync(STATE, JSON.stringify({ pid: child.pid, work, token, projA, projB, fixturePort: 17742 }));
    (globalThis as { __fixture?: { close: () => void } }).__fixture = fixture;
}
