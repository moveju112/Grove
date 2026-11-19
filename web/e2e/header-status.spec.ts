import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, state } from "./helpers";
import type { ServerUpdateStatus } from "../app/api/updateSettings";

for (const width of [390, 1280]) {
    test(`상단은 호스트·상태 문구 없이 상태 점만 표시한다 (${width}px)`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await login(page);
        const header = page.getByRole("banner");
        const status = header.getByTestId("conn");
        await expect(status).toHaveText("연결됨");
        await expect(status.getByRole("img", { name: "연결됨", exact: true })).toBeVisible();
        await expect(status).toHaveAttribute("role", "status");
        await expect(status).toHaveAccessibleDescription("서버 연결 상태: 연결됨");
        await expect(header.getByRole("button", { name: /^호스트 선택:/ })).toHaveCount(0);
        const box = await status.boundingBox();
        expect(box!.width).toBeLessThan(32);
        expect(box!.height).toBeLessThan(40);
    });
}

test("초록점 호버로 메뉴를 열고, 눌렀을 때만 데몬 업데이트를 확인한다", async ({ page }) => {
    const checks: string[] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith("/updates/check")) checks.push(request.url());
    });
    await login(page);
    const trigger = page.getByRole("button", { name: "업데이트 확인", exact: true });
    const panel = page.getByRole("dialog", { name: "업데이트 확인", exact: true });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.hover();
    const daemon = panel.getByRole("button", { name: "데몬 업데이트 확인" });
    await expect(daemon).toBeEnabled();
    await daemon.hover();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(checks).toHaveLength(0);
    await daemon.click();
    await expect(panel).toContainText("데몬 업데이트 소스가 준비되지 않았어요");
    expect(checks).toHaveLength(1);
    const result = await apiCall<ServerUpdateStatus>("GET", "/updates/settings");
    expect(result.last_check?.error).toBe("local_source_unavailable");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await trigger.press("Enter");
    await expect(daemon).toBeEnabled();
    await page.keyboard.press("Tab");
    await expect(daemon).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
});

test("웹 확인은 최신과 새 버전을 구분하며 빈 탭도 새로고침하지 않는다", async ({ page }) => {
    const sw = join(dirname(state().projA), "web", "sw.js");
    const original = readFileSync(sw, "utf8");
    try {
        await login(page);
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
        await page.getByRole("button", { name: "업데이트 확인", exact: true }).hover();
        const panel = page.getByRole("dialog", { name: "업데이트 확인", exact: true });
        const web = panel.getByRole("button", { name: "웹 업데이트 확인" });
        await web.click();
        await expect(panel).toContainText("웹은 최신 버전이에요");
        writeFileSync(sw, `${original}\n// header-update-test\n`);
        await web.click();
        await expect(panel).toBeHidden();
        await expect(page.getByRole("button", { name: "업데이트", exact: true })).toBeVisible();
        expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(true);
    } finally {
        writeFileSync(sw, original);
    }
});

test.describe("모바일 업데이트 확인", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test("새 웹 버전을 찾으면 확인 팝오버를 닫아 업데이트 안내를 바로 누를 수 있다", async ({ page }) => {
        const sw = join(dirname(state().projA), "web", "sw.js");
        const original = readFileSync(sw, "utf8");
        try {
            await login(page);
            await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
            const trigger = page.getByRole("button", { name: "업데이트 확인", exact: true });
            const panel = page.getByRole("dialog", { name: "업데이트 확인", exact: true });
            await trigger.tap();
            writeFileSync(sw, `${original}\n// mobile-header-update-test\n`);
            await panel.getByRole("button", { name: "웹 업데이트 확인" }).tap();
            await expect(panel).toBeHidden();
            await expect(trigger).toHaveAttribute("aria-expanded", "false");
            await page.getByRole("button", { name: "업데이트", exact: true }).tap({ trial: true });
            // 확인만으로는 새 버전을 적용하거나 탭을 다시 로드하지 않는다.
            expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(true);
        } finally {
            writeFileSync(sw, original);
        }
    });

    test("초록점을 탭하면 화면 안에 두 확인 버튼이 열리고 바깥 탭으로 닫힌다", async ({ page }, info) => {
        await login(page);
        const trigger = page.getByRole("button", { name: "업데이트 확인", exact: true });
        const panel = page.getByRole("dialog", { name: "업데이트 확인", exact: true });
        await trigger.tap();
        await expect(panel.getByRole("button", { name: "데몬 업데이트 확인" })).toBeEnabled();
        await expect(panel.getByRole("button", { name: "웹 업데이트 확인" })).toBeEnabled();
        await expect(panel).toBeInViewport({ ratio: 1 });
        await page.screenshot({ path: info.outputPath("header-updates-390.png") });
        await page.touchscreen.tap(20, 400);
        await expect(panel).toBeHidden();
    });
});
