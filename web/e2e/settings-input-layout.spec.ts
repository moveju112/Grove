import { expect, test } from "@playwright/test";
import { login } from "./helpers";

for (const width of [390, 1280]) {
    for (const theme of ["light", "dark"] as const) {
        test.describe(`${width}px ${theme} 설정 입력 배치`, () => {
            test.use({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760 });
            test("테마·글자 크기·스위치는 제목 조작 없이 보이고 새로고침 뒤에도 유지된다", async ({ page }, info) => {
                await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
                await login(page);
                await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
                const settings = page.locator(".settings");
                await settings.getByRole("button", { name: "화면·입력", exact: true }).click();
                const font = settings.getByRole("slider", { name: "글자 크기", exact: true });
                const enter = settings.getByRole("switch", { name: "Enter로 보내기", exact: true });
                await expect(font).toBeVisible();
                await expect(enter).toBeVisible();
                await settings.getByRole("combobox", { name: "테마", exact: true }).selectOption("soft");
                await font.fill("18");
                await enter.focus();
                await page.keyboard.press("Space");
                const checked = await enter.isChecked();
                await expect(font).toHaveValue("18");
                expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
                await page.screenshot({ path: info.outputPath("settings-input.png"), fullPage: true });
                await page.reload();
                await settings.getByRole("button", { name: "화면·입력", exact: true }).click();
                await expect(settings.getByRole("combobox", { name: "테마", exact: true })).toHaveValue("soft");
                await expect(font).toHaveValue("18");
                if (checked) await expect(enter).toBeChecked();
                else await expect(enter).not.toBeChecked();
                expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
            });
        });
    }
}
