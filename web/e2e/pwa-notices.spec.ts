import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProfile, ensureProjects, login, sessionView, state } from "./helpers";

for (const width of [390, 1400]) for (const theme of ["light", "dark"] as const) {
    test.describe(`${width}px ${theme} 업데이트 알림`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760 });
        test("입력창을 가리지 않고 다른 알림과 함께 표시하며 초안을 유지한다", async ({ page }, info) => {
            const workerPath = join(state().work, "web/sw.js");
            const original = readFileSync(workerPath, "utf8");
            try {
                await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
                const { a } = await ensureProjects();
                await ensureProfile();
                const title = `겹치지 않는 업데이트 ${width} ${theme}`;
                const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
                await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
                await login(page);
                if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
                await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
                await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
                const view = sessionView(page, session.id);
                const input = view.getByLabel("메시지 입력", { exact: true });
                await input.fill("업데이트 알림이 떠도 유지할 초안");
                writeFileSync(workerPath, original.replace(/const VERSION = "([^"]+)"/, `const VERSION = "$1-notices-${width}-${theme}"`));
                await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
                await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === "installed",
                    undefined, { timeout: 15_000 });
                const banner = page.getByRole("status").filter({ hasText: "새 버전이 준비되었습니다" });
                await expect(banner).toBeVisible();
                const clearOfInput = async () => {
                    const notice = (await banner.boundingBox())!;
                    const surface = (await view.getByTestId("compose-surface").boundingBox())!;
                    expect(notice.y).toBeGreaterThanOrEqual(0);
                    expect(notice.x).toBeGreaterThanOrEqual(0);
                    expect(notice.x + notice.width).toBeLessThanOrEqual(width);
                    expect(notice.y + notice.height).toBeLessThanOrEqual(surface.y);
                };
                await page.screenshot({ path: info.outputPath("update-notices.png"), fullPage: true });
                await clearOfInput();
                expect(await page.getByTestId("app-notices").evaluate((node) => {
                    const style = getComputedStyle(node);
                    const pixel = document.createElement("canvas").getContext("2d")!;
                    pixel.fillStyle = style.backgroundColor;
                    pixel.fillRect(0, 0, 1, 1);
                    return pixel.getImageData(0, 0, 1, 1).data[3] === 255 && style.opacity === "1";
                })).toBe(true);
                await input.click();
                await input.press("End");
                await input.pressSequentially(" (계속 입력)");
                await expect(input).toHaveValue("업데이트 알림이 떠도 유지할 초안 (계속 입력)");
                if (width < 760) {
                    await page.setViewportSize({ width, height: 520 });
                    await clearOfInput();
                    await page.screenshot({ path: info.outputPath("update-small-viewport.png"), fullPage: true });
                }
                await page.context().setOffline(true);
                const offline = page.getByTestId("offline-banner");
                await expect(offline).toBeVisible();
                await expect(banner.getByRole("button", { name: "업데이트", exact: true })).toBeDisabled();
                const connection = (await offline.boundingBox())!;
                const update = (await banner.boundingBox())!;
                expect(connection.y + connection.height).toBeLessThanOrEqual(update.y);
                await clearOfInput();
                await page.screenshot({ path: info.outputPath("update-and-offline.png"), fullPage: true });
                await banner.getByRole("button", { name: "나중에", exact: true }).click();
                await expect(banner).toHaveCount(0);
                await expect(input).toHaveValue("업데이트 알림이 떠도 유지할 초안 (계속 입력)");
                await expect(offline).toBeVisible();
            } finally {
                await page.context().setOffline(false);
                writeFileSync(workerPath, original);
            }
        });
    });
}
