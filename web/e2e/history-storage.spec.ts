import { expect, test } from "@playwright/test";
import { apiCall, login, openSettings } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("대화 기록 자동 압축은 기본 7일이고 기간을 자동 저장해 다시 열어도 유지한다", async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await login(page);
    await openSettings(page, "daemon");
    const settings = page.getByTestId("settings");
    await settings.getByLabel("설정 검색").fill("대화 기록 자동 압축");
    const row = settings.getByTestId("setting-storage.history_compress_after_days");
    const input = row.getByLabel("대화 기록 자동 압축(일)", { exact: true });
    await expect(input).toHaveValue("7");
    await input.fill("14");
    await input.blur();
    await expect(row).toContainText("저장됨");
    const effective = async () => (await apiCall<{ items: { key: string; effective: number }[] }>("GET", "/settings/effective"))
        .items.find((item) => item.key === "storage.history_compress_after_days")!.effective;
    await expect.poll(effective).toBe(14);
    await page.screenshot({ path: info.outputPath("history-storage-390.png"), animations: "disabled" });
    await page.reload();
    await openSettings(page, "daemon");
    await page.getByLabel("설정 검색").fill("대화 기록 자동 압축");
    await expect(input).toHaveValue("14");
    await input.fill("7");
    await input.blur();
    await expect.poll(effective).toBe(7);
});
