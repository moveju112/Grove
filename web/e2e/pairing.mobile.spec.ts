import { expect, test } from "@playwright/test";
import { apiCall } from "./helpers";

for (const theme of ["light", "dark"] as const) {
    test(`${theme} 페어링은 긴 링크·오류·승인 대기에서도 좌우 여백과 글꼴을 유지한다`, async ({ page }, info) => {
        const password = "mobile-only test password";
        const pair = await apiCall<{ code: string; id: string }>("POST", "/pairings", { name: `mobile-${theme}`, password });
        const link = `http://127.0.0.1:17741/#pairing=${pair.code}`;
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.goto("/");
        await page.getByRole("button", { name: "페어링 링크·QR로 등록" }).click();
        const form = page.getByRole("form", { name: "페어링 등록" });
        await expect(form.getByLabel("페어링 링크", { exact: true })).toHaveValue("");
        await page.screenshot({ path: info.outputPath("pairing-empty.png"), fullPage: true });
        await form.getByLabel("페어링 링크", { exact: true }).fill(link);
        await form.getByLabel("비밀번호", { exact: true }).fill("incorrect");
        await form.getByRole("button", { name: "연결 요청", exact: true }).click();
        await expect(form.getByRole("alert")).toContainText("4회 더");
        await page.evaluate(() => document.fonts.ready);
        expect(await page.evaluate(() => [...document.fonts].some((font) => font.family === "Pretendard" && font.status === "loaded"))).toBe(true);
        const bounds = await form.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(16);
        expect(390 - bounds!.x - bounds!.width).toBeGreaterThanOrEqual(16);
        expect(Math.abs(bounds!.x - (390 - bounds!.x - bounds!.width))).toBeLessThan(2);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath("pairing-error.png"), fullPage: true });
        await form.getByLabel("비밀번호", { exact: true }).fill(password);
        await form.getByRole("button", { name: "연결 요청", exact: true }).click();
        await expect(form.locator(".pairing-code")).toHaveText(/^[A-F0-9]{4}-[A-F0-9]{4}$/);
        await expect(form.getByText("소유자 승인 대기 중", { exact: true })).toBeVisible();
        await page.screenshot({ path: info.outputPath("pairing-pending.png"), fullPage: true });
        await apiCall("DELETE", `/pairings/${pair.id}`);
        await expect(form.getByRole("alert")).toContainText("만료되었거나 폐기·사용");
    });
}
