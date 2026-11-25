import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("이 화면에서 입력하면 다른 기기 알림을 줄이도록 1분에 한 번만 서버에 알린다", async ({ page }) => {
    const reports: number[] = [];
    page.on("response", (response) => {
        if (response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/presence") reports.push(response.status());
    });
    await login(page);
    await page.mouse.move(200, 200);
    await page.mouse.move(260, 240);
    await page.keyboard.press("Shift");
    await expect.poll(() => reports).toEqual([204]);
    await page.mouse.click(300, 300);
    await page.keyboard.press("Shift");
    await page.waitForTimeout(300);
    expect(reports).toEqual([204]);
});
