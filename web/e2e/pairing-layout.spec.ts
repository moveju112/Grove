import { expect, test } from "@playwright/test";
import { apiCall, issueTestPairing } from "./helpers";

for (const theme of ["light", "dark"] as const) {
    test(`데스크톱 ${theme} 페어링의 빈 화면과 긴 링크를 가운데 정렬한다`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.goto("/");
        await page.getByRole("button", { name: "페어링 링크·QR로 등록" }).click();
        const form = page.getByRole("form", { name: "페어링 등록" });
        await expect(form.getByRole("heading", { name: "기기 연결" })).toBeVisible();
        await expect(form.getByLabel("비밀번호", { exact: true })).toHaveCount(0);
        await expect(form.getByLabel("이 기기 이름")).toHaveCount(0);
        await expect(form.locator('input[type="file"]')).toHaveCount(0);
        await form.getByRole("button", { name: "QR", exact: true }).click();
        await expect(form.getByRole("textbox", { name: "페어링 링크", exact: true })).toHaveCount(0);
        await expect(form.getByText("QR 사진 선택", { exact: true })).toBeVisible();
        await form.getByRole("button", { name: "페어링 링크", exact: true }).click();
        await page.screenshot({ path: info.outputPath("pairing-desktop-empty.png"), fullPage: true });
        const pair = await issueTestPairing(`layout-${theme}`, "desktop test-only password");
        try {
            await form.getByRole("textbox", { name: "페어링 링크", exact: true }).fill(`http://127.0.0.1:17741/#pairing=${pair.code}`);
            await expect(form.getByText("등록 대상:")).toContainText("127.0.0.1:17741");
            const box = await form.locator("..").boundingBox();
            const width = page.viewportSize()!.width;
            expect(box!.width).toBe(420);
            expect(Math.abs(box!.x - (width - box!.x - box!.width))).toBeLessThan(2);
            expect(await form.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
            await page.evaluate(() => document.fonts.ready);
            expect(await page.evaluate(() => [...document.fonts].some((font) => font.family === "Pretendard" && font.status === "loaded"))).toBe(true);
            await page.screenshot({ path: info.outputPath("pairing-desktop-link.png"), fullPage: true });
            await form.getByRole("button", { name: "연결", exact: true }).click();
            const dialog = page.getByRole("dialog", { name: "연결 비밀번호" });
            await expect(dialog.getByLabel("비밀번호", { exact: true })).toBeFocused();
            const modal = await dialog.boundingBox();
            expect(Math.abs(modal!.x + modal!.width / 2 - width / 2)).toBeLessThan(2);
            await dialog.getByLabel("비밀번호", { exact: true }).fill("discarded");
            await page.keyboard.press("Escape");
            await expect(dialog).toHaveCount(0);
            await form.getByRole("button", { name: "연결", exact: true }).click();
            await expect(dialog.getByLabel("비밀번호", { exact: true })).toHaveValue("");
        } finally {
            await apiCall("DELETE", `/pairings/${pair.id}`);
        }
    });
}
