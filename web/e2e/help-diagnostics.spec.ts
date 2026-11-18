import { expect, test } from "@playwright/test";
import { login, openSettings, state } from "./helpers";

// UI-031: 버전 상세·진단 정보(민감 정보 제외).
test("도움말·클라이언트 상태 없이 서버 진단 정보는 토큰 없이 복사된다", async ({ page }) => {
    await login(page);
    await openSettings(page);
    await page.getByLabel("설정 검색").fill("진단");
    const v = page.getByTestId("version-details");
    await expect(v).toContainText("서버 버전");
    await expect(v).toContainText(/x86_64-linux|aarch64-linux/);
    await expect(v).not.toContainText("다름");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "진단 정보 복사" }).click();
    await expect(page.getByText("진단 정보를 복사했습니다")).toBeVisible();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    const d = JSON.parse(text) as { server: { version: string; protocol: number }; web: { build: string; protocol_matches: boolean }; connection: string };
    expect(d.server.version).toBeTruthy();
    expect(d.web.build).toMatch(/^[0-9a-f]{16}$/);
    expect(d.web.protocol_matches).toBe(true);
    expect(d.connection).toBe("live");
    expect(text).not.toContain(state().token);
    expect(text.toLowerCase()).not.toContain("bearer");
    await page.getByTestId("settings").getByRole("tab", { name: "로컬 설정", exact: true }).click();
    await expect(page.getByRole("button", { name: "도움말", exact: true })).toHaveCount(0);
    for (const keyword of ["도움말", "클라이언트 상태"]) {
        await page.getByLabel("설정 검색").fill(keyword);
        await expect(page.getByTestId("settings")).toContainText("검색 결과 0개");
    }
    await expect(page.getByTestId("setting-help")).toHaveCount(0);
    await expect(page.getByTestId("setting-client-status")).toHaveCount(0);
});
