// relay 시험 대상 준비. GROVE_RELAY_STATE가 없으면 로컬 스택을 새로 띄우고 teardown에서 정리한다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default async function setup() {
    if (process.env.GROVE_RELAY_STATE) return;
    const root = new URL("../..", import.meta.url).pathname;
    const work = mkdtempSync(join(tmpdir(), "grove-relay-e2e-"));
    const state = join(work, "stack.json");
    try {
        execFileSync("python3", [join(root, "scripts/relay_stack.py"), "up", "--state", state], { stdio: ["ignore", "ignore", "inherit"] });
    } catch (error) {
        rmSync(work, { recursive: true });
        throw error;
    }
    process.env.GROVE_RELAY_STATE = state;
    // 이번 실행이 만든 경로만 closure가 소유한다. 병렬 실행이나 외부 지정 대상을 정리하지 않는다.
    return () => {
        execFileSync("python3", [join(root, "scripts/relay_stack.py"), "down", "--state", state], { stdio: "inherit" });
        rmSync(work, { recursive: true });
    };
}
