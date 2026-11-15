import { expect, test } from "@playwright/test";
import { login, openSettings, selectChoice } from "./helpers";

for (const width of [390, 1280]) {
    for (const theme of ["light", "dark"] as const) {
        test.describe(`${width}px ${theme} 설정 입력 배치`, () => {
            test.use({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760 });
            test("설정은 카드와 드롭다운으로 구분되고 새로고침 뒤에도 유지된다", async ({ page }, info) => {
                await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
                await login(page);
                await openSettings(page);
                const settings = page.getByTestId("settings");
                await settings.getByRole("button", { name: "화면·입력", exact: true }).click();
                const font = settings.getByRole("slider", { name: "글자 크기", exact: true });
                const enter = settings.getByRole("combobox", { name: "Enter로 보내기", exact: true });
                await expect(font).toBeVisible();
                await expect(enter).toBeVisible();
                await selectChoice(settings.getByRole("combobox", { name: "테마", exact: true }), "soft");
                await font.press("End");
                await font.press("ArrowLeft");
                await font.press("ArrowLeft");
                const selected = await enter.getAttribute("data-selected-value") === "true" ? "false" : "true";
                await selectChoice(enter, selected);
                await expect(settings.getByRole("checkbox")).toHaveCount(0);
                await expect(settings.getByRole("radio")).toHaveCount(0);
                const recent = settings.getByRole("combobox", { name: "최근 시간 범위 1", exact: true });
                await selectChoice(recent, "15m");
                await expect(recent).toHaveAttribute("data-selected-value", "15m");
                await expect(font).toHaveAttribute("aria-valuenow", "18");
                expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
                await page.screenshot({ path: info.outputPath("settings-input.png"), fullPage: true });
                await page.reload();
                await settings.getByRole("button", { name: "화면·입력", exact: true }).click();
                await expect(settings.getByRole("combobox", { name: "테마", exact: true })).toHaveAttribute("data-selected-value", "soft");
                await expect(font).toHaveAttribute("aria-valuenow", "18");
                await expect(enter).toHaveAttribute("data-selected-value", selected);
                await expect(recent).toHaveAttribute("data-selected-value", "15m");
                expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
            });
        });
    }
}
