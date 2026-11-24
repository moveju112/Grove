import { expect, test, type Page } from "@playwright/test";
import { apiCall, login, openSettings } from "./helpers";

async function open(page: Page) {
    await openSettings(page);
    await page.getByLabel("설정 검색").last().fill("서버 업데이트");
    return page.getByTestId("server-update-settings").last();
}

test("등록 기기는 자동 업데이트를 끌 수 없고 수동 확인은 유지된다", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const device = await login(page);
    try {
        await page.getByRole("banner").getByRole("button", { name: "업데이트 확인", exact: true }).hover();
        const dialog = page.getByRole("dialog", { name: "업데이트 확인", exact: true });
        await expect(dialog.getByRole("button", { name: "데몬 업데이트 확인" })).toBeEnabled();
        await expect(dialog.getByRole("button", { name: "웹 업데이트 확인" })).toBeEnabled();
        await page.keyboard.press("Escape");
        const panel = await open(page);
        await expect(panel).toContainText("자동 업데이트");
        await expect(panel.getByRole("combobox")).toHaveCount(0);
        await expect(panel.getByRole("button")).toHaveCount(0);
    } finally {
        await apiCall("DELETE", `/devices/${device.id}`);
    }
});
