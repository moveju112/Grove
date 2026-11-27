import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("자동 확인 실패는 조용히 재시도하고 직접 확인한 실패만 알린다", async ({ page }, info) => {
    await login(page);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.clock.install();
    await page.addInitScript(() => {
        ServiceWorkerRegistration.prototype.update = async function (this: ServiceWorkerRegistration) {
            const root = document.documentElement;
            root.dataset.updateChecks = String(Number(root.dataset.updateChecks ?? 0) + 1);
            if (!root.dataset.updateCheckRecovered) throw new TypeError("offline");
            return this;
        };
    });
    await page.reload();
    const html = page.locator("html");
    const alert = page.getByRole("alert").filter({ hasText: /새 UI 확인에 실패했습니다|새 화면 업데이트를 확인하지 못했어요/ });
    await expect(html).toHaveAttribute("data-update-checks", "1");
    await page.clock.fastForward(30 * 60 * 1000);
    await expect(html).toHaveAttribute("data-update-checks", "2");
    await expect(alert).toHaveCount(0);

    await page.route("**/api/v1/health", route => route.fulfill({ json: { protocol: 999 } }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const check = page.getByTestId("protocol-banner").getByRole("button", { name: "새 UI 확인", exact: true });
    await check.tap();
    await expect(alert).toContainText("새 화면 업데이트를 확인하지 못했어요.");
    await page.screenshot({ path: info.outputPath("update-error.png") });
    const root = await html.elementHandle();
    await page.getByRole("button", { name: "업데이트 알림 닫기" }).tap();
    await expect(alert).toHaveCount(0);
    expect(await root!.evaluate(node => node.isConnected)).toBe(true);

    await check.tap();
    await expect(alert).toBeVisible();
    await html.evaluate(root => { root.dataset.updateCheckRecovered = "true"; });
    await check.tap();
    await expect(alert).toHaveCount(0);
});
