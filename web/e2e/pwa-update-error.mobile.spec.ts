import { expect, test } from "@playwright/test";

test("업데이트 확인 오류 알림은 ×를 누르면 현재 탭에서 닫힌다", async ({ page }, info) => {
    await page.goto("/");
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.addInitScript(() => {
        ServiceWorkerRegistration.prototype.update = async () => { throw new TypeError("offline"); };
    });
    await page.reload();
    const alert = page.getByRole("alert").filter({ hasText: "새 UI 확인에 실패했습니다" });
    await expect(alert).toBeVisible();
    await page.screenshot({ path: info.outputPath("update-error.png") });
    const root = await page.locator("html").elementHandle();
    await page.getByRole("button", { name: "업데이트 알림 닫기" }).tap();
    await expect(alert).toHaveCount(0);
    expect(await root!.evaluate(node => node.isConnected)).toBe(true);
});
