import { expect, test } from "@playwright/test";
import { login, openSettings, selectChoice } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

for (const theme of ["light", "dark"] as const) {
    test(`${theme}: Astryx 설정 카드와 선택기는 터치·키보드로 설정하고 새로고침 뒤 유지한다`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await login(page);
        await openSettings(page);
        await page.getByLabel("설정 검색").fill("Enter로");
        const group = page.getByRole("region", { name: "Enter로 보내기", exact: true });
        await expect(group).toBeVisible();
        const field = page.getByRole("combobox", { name: "Enter로 보내기", exact: true });
        await expect(field).toHaveAttribute("data-selected-value", "false");
        await selectChoice(field, "true");
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem("grove.device.prefs")!).enterToSend)).toBe(true);
        await field.focus();
        await field.press("Enter");
        await expect(page.getByRole("listbox")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("listbox")).toHaveCount(0);
        await page.screenshot({ path: info.outputPath(`settings-selector-${theme}-390.png`) });
        await page.reload();
        await page.getByLabel("설정 검색").fill("Enter로");
        await expect(page.getByRole("combobox", { name: "Enter로 보내기", exact: true })).toHaveAttribute("data-selected-value", "true");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
}
