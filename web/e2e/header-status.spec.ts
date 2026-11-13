import { expect, test } from "@playwright/test";
import { login } from "./helpers";

for (const width of [390, 1280]) {
    test(`상단은 호스트·상태 문구 없이 상태 점만 표시한다 (${width}px)`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await login(page);
        const header = page.locator(".topbar");
        const status = header.getByTestId("conn");
        await expect(status).toHaveText("연결됨");
        await expect(status.locator(".conn-dot")).toBeVisible();
        await expect(status).toHaveAttribute("role", "status");
        await expect(status).toHaveAttribute("title", "서버 연결 상태: 연결됨");
        await expect(header.getByRole("button", { name: /^호스트 선택:/ })).toHaveCount(0);
        const box = await status.boundingBox();
        expect(box!.width).toBeLessThan(32);
        expect(box!.height).toBeLessThan(40);
    });
}
