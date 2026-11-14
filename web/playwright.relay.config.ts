import { defineConfig } from "@playwright/test";

// 폰과 같은 경로(브라우저 → relay → 데몬, 암호화 다중화 연결)를 시험한다.
// 기본: scripts/relay_stack.py로 로컬 스택(지연·끊김 주입 가능)을 띄운다.
// GROVE_RELAY_STATE=<상태 파일>: 이미 떠 있는 대상(스테이징 등)을 그대로 쓴다. 네트워크 주입 시험은 건너뛴다.
export default defineConfig({
    testDir: "relay-e2e",
    timeout: 90_000,
    expect: { timeout: 10_000 },
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [["list"]],
    globalSetup: "./relay-e2e/setup.ts",
    use: {
        channel: "chrome",
        headless: true,
        trace: "retain-on-failure",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    },
});
