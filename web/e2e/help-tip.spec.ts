import { expect, test } from "@playwright/test";
import { login, openSettings } from "./helpers";

// Astryx Layer는 Grove 테마의 --spacing-4(12px)를 viewport gutter로 사용한다.
const gutter = 12;

for (const width of [390, 1400]) {
    test.describe(`${width}px 안내 도움말`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
        test("로그인 설명은 호버·키보드·터치로만 펼치고 설정 설명도 같은 방식으로 표시한다", async ({ page }, info) => {
            await page.goto("/");
            const trigger = page.getByRole("button", { name: "보관 방식 도움말", exact: true });
            const tooltip = page.getByRole("tooltip");
            await expect(tooltip).toHaveCount(0);
            await expect(page.getByText("토큰은 이 브라우저에 저장하지 않습니다.", { exact: true })).not.toBeVisible();
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
            await expect.poll(async () => (await tooltip.boundingBox())!.x).toBeGreaterThanOrEqual(gutter);
            await expect.poll(async () => { const box = (await tooltip.boundingBox())!; return box.x + box.width; }).toBeLessThanOrEqual(width - gutter);
            await page.screenshot({ path: info.outputPath("login-help.png"), fullPage: true });
            await page.getByRole("heading", { name: "Grove" }).click();
            await expect(tooltip).toHaveCount(0);
            await login(page);
            await openSettings(page);
            await page.getByLabel("설정 검색").fill("출력 스타일");
            // Astryx는 포인터 포커스가 아니라 키보드 포커스에서 도움말을 미리 연다.
            await page.keyboard.press("Tab");
            await page.getByRole("button", { name: "출력 스타일 도움말", exact: true }).focus();
            await expect(tooltip).toBeVisible();
            await expect(tooltip).toContainText("실제 적용값:");
            await expect.poll(async () => (await tooltip.boundingBox())!.x).toBeGreaterThanOrEqual(gutter);
            await expect.poll(async () => { const box = (await tooltip.boundingBox())!; return box.x + box.width; }).toBeLessThanOrEqual(width - gutter);
            await page.screenshot({ path: info.outputPath("settings-help.png"), fullPage: true });
        });
    });
}
