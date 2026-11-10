import { defineConfig } from "@playwright/test";

// 실제 grove 실행 파일 + 빌드된 정적 웹앱 + 설치된 Google Chrome으로 시험한다.
export default defineConfig({
    testDir: "e2e",
    timeout: 60_000,
    fullyParallel: false,
    workers: 1,
    reporter: [["list"]],
    globalSetup: "./e2e/global-setup.ts",
    globalTeardown: "./e2e/global-teardown.ts",
    use: {
        baseURL: "http://127.0.0.1:17741",
        channel: "chrome",
        headless: true,
        trace: "off",
    },
    projects: [
        { name: "desktop", use: { viewport: { width: 1400, height: 900 } }, testIgnore: /mobile\.spec\.ts/ },
        { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, testMatch: /mobile\.spec\.ts/ },
    ],
});
