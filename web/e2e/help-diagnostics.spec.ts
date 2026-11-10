import { expect, test } from "@playwright/test";
import { login, state } from "./helpers";

// UI-031: 버전 상세·진단 정보(민감 정보 제외)·도움말.
test("버전 상세를 보이고 진단 정보는 토큰 없이 복사되며 도움말을 찾을 수 있다", async ({ page }) => {
    await login(page);
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("진단");
    const v = page.getByTestId("version-details");
    await expect(v).toContainText("서버 버전");
    await expect(v).toContainText(/x86_64-linux|aarch64-linux/);
    await expect(v.locator("code")).toHaveText(/^[0-9a-f]{16}$/);
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
    await page.getByLabel("설정 검색").fill("단축키");
    await expect(page.getByTestId("help")).toContainText("한글 조합 중");
});
