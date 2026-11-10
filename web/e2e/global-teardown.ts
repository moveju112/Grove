import { readFileSync, rmSync } from "node:fs";
import { STATE } from "./global-setup";

export default async function globalTeardown() {
    const s = JSON.parse(readFileSync(STATE, "utf8")) as { pid: number; work: string };
    try {
        process.kill(s.pid, "SIGTERM");
    } catch {
        /* 이미 종료 */
    }
    await new Promise((r) => setTimeout(r, 500));
    (globalThis as { __fixture?: { close: () => void } }).__fixture?.close();
    // 이 시험이 만든 임시 디렉터리만 지운다.
    if (s.work.includes("grove-e2e-")) rmSync(s.work, { recursive: true, force: true });
    rmSync(STATE, { force: true });
}
