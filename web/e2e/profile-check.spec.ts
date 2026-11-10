import { expect, test } from "@playwright/test";
import { ensureProfile, login, state } from "./helpers";

// AUTH-001: 설정에서 모델 프로필의 연결 상태를 확인한다(생성 요청 없이).
test("모델 프로필 연결 확인은 생성 요청 없이 상태와 지연을 보인다", async ({ page }) => {
    await ensureProfile();
    const before = ((await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json()) as unknown[]).length;
    await login(page);
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("프로필");
    const item = page.locator("li").filter({ hasText: "fixture-model" }).first();
    await item.getByRole("button", { name: "연결 확인" }).click();
    await expect(item.getByTestId("profile-check")).toContainText("연결됨");
    await expect(item.getByTestId("profile-check")).toContainText(/\d+ms/);
    await expect(item.getByTestId("profile-check")).toContainText("모델 확인됨");
    const after = ((await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json()) as unknown[]).length;
    expect(after).toBe(before);
});
