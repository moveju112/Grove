import { expect, test } from "@playwright/test";
import { login } from "./helpers";

for (const width of [390, 1400]) {
    test.describe(`${width}px 안내 도움말`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
        test("로그인 설명은 호버·키보드·터치로만 펼치고 설정 설명도 같은 방식으로 표시한다", async ({ page }, info) => {
            await page.goto("/");
            const trigger = page.getByRole("button", { name: "보관 방식 도움말", exact: true });
            const tooltip = page.getByRole("tooltip");
            await expect(tooltip).toHaveCount(0);
            await expect(page.getByText("토큰은 이 브라우저에 저장하지 않습니다.", { exact: true })).toHaveCount(0);
            await trigger.hover();
            await expect(tooltip).toHaveText("토큰은 이 브라우저에 저장하지 않습니다.");
            await tooltip.hover();
            await expect(tooltip).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(tooltip).toHaveCount(0);
            await trigger.focus();
            await expect(tooltip).toBeVisible();
            await expect(trigger).toHaveAttribute("aria-describedby", await tooltip.getAttribute("id") as string);
            await page.keyboard.press("Tab");
            await expect(tooltip).toHaveCount(0);
            if (width < 760) await trigger.tap();
            else await trigger.click();
            await expect(tooltip).toBeVisible();
            const box = await tooltip.boundingBox();
            expect(box!.x).toBeGreaterThanOrEqual(16);
            expect(box!.x + box!.width).toBeLessThanOrEqual(width - 16);
            await page.screenshot({ path: info.outputPath("login-help.png"), fullPage: true });
            await page.getByRole("heading", { name: "Grove" }).click();
            await expect(tooltip).toHaveCount(0);
            await login(page);
            await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
            await page.getByLabel("설정 검색").fill("응답 언어");
            // Astryx는 포인터 포커스가 아니라 키보드 포커스에서 도움말을 미리 연다.
            await page.keyboard.press("Tab");
            await page.getByRole("button", { name: "응답 언어 도움말", exact: true }).focus();
            await expect(tooltip).toBeVisible();
            await expect(tooltip).toContainText("실제 적용값:");
            const settingsBox = await tooltip.boundingBox();
            expect(settingsBox!.x).toBeGreaterThanOrEqual(16);
            expect(settingsBox!.x + settingsBox!.width).toBeLessThanOrEqual(width - 16);
            await page.screenshot({ path: info.outputPath("settings-help.png"), fullPage: true });
        });
    });
}
