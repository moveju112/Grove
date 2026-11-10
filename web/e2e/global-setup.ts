// 시험용 grove 서버와 로컬 모델 fixture를 띄운다. 데이터는 매번 새 임시 디렉터리에 둔다.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    // FLOW-08: 서버를 띄우기 전에(같은 잠금) 기존 Paseo 형식 대화 하나를 가져온다.
    const projI = mkdtempSync(join(work, "imported-"));
    const src = join(work, "paseo-sessions");
    mkdirSync(src);
    const it = (ts: string, item: object) => ({ timestamp: ts, item });
    writeFileSync(
        join(src, "old-1.json"),
        JSON.stringify({
            version: 2, id: "old-1", cwd: projI, promptHash: "h", nativeSessionId: "n", createdAt: 1_790_000_000_000, updatedAt: 1_790_000_100_000,
            historyTruncated: false, active: null, receipts: {}, usage: {},
            items: [
                it("2026-09-21T10:00:00.000Z", { type: "user_message", id: "u1", clientMessageId: "c1", text: "예전에 묻던 질문" }),
                it("2026-09-21T10:00:01.000Z", { type: "tool_call", id: "x1", callId: "k1", name: "shell", status: "running", error: null, detail: { type: "plain_text", text: "make deploy" } }),
                it("2026-09-21T10:00:02.000Z", { type: "compaction", id: "cp", status: "completed", trigger: "auto", preTokens: 90000 }),
                it("2026-09-21T10:00:03.000Z", { type: "assistant_message", id: "a1", phase: "final_answer", text: "예전 답변" }),
            ],
        }),
    );
    execFileSync(bin, ["import", "paseo", src, "--data-dir", data], { stdio: ["ignore", "ignore", "inherit"] });
    const child = spawn(bin, ["serve", "--listen", `127.0.0.1:${PORT}`, "--data-dir", data], {
        env: { ...process.env, GROVE_WEB_DIR: join(root, "web/build/client"), GROVE_ENABLE_TOOL_LOOP: "1", GROVE_LOG: "warn" },
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
