import { expect, test } from "@playwright/test";
import { apiCall, login, openDetails, openSettings, profileAction, state } from "./helpers";

test("프로필 기능 편집은 비공개 헤더 참조를 보존하고 키 교체 뒤 연결 확인을 지운다", async ({ page }) => {
    const name = `private header ${Date.now()}`;
    const value = "synthetic-private-header-browser-value";
    const secret = await apiCall<{ id: string }>("POST", "/secrets", { label: name, value });
    const profile = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name, protocol: "openai", model: "fixture-model", base_url: `http://127.0.0.1:${state().fixturePort}/v1`,
        options: { headers: { "X-Client-Name": { secret_id: secret.id } } },
    });
    try {
        await login(page);
        await openSettings(page);
        await page.getByLabel("설정 검색").fill("프로필");
        const row = page.getByTestId("model-profile").filter({ hasText: name });
        await openDetails(row);
        await row.getByLabel("context token 수", { exact: true }).fill("16000");
        await row.getByLabel("context token 수", { exact: true }).blur();
        await expect(row.getByRole("status").filter({ hasText: "저장됨" })).toBeVisible();
        const all = await apiCall<{ id: string; options: { headers: { "X-Client-Name": { secret_id: string } } } }[]>("GET", "/model-profiles");
        const stored = all.find((p) => p.id === profile.id)!;
        expect(stored.options.headers["X-Client-Name"]).toEqual({ secret_id: secret.id });
        expect(JSON.stringify(all)).not.toContain(value);
        expect(await page.locator("body").innerText()).not.toContain(value);
        expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(value);
        await row.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }).click();
        await profileAction(row, "연결 확인");
        await expect(row.getByTestId("profile-check")).toContainText("연결됨");
        await apiCall("PUT", `/secrets/${secret.id}`, { label: name, value: "synthetic-rotated-header-browser-value" });
        await expect(row.getByTestId("profile-check")).toContainText("연결 확인 안 함");
    } finally {
        await apiCall("DELETE", `/model-profiles/${profile.id}`);
        await apiCall("DELETE", `/secrets/${secret.id}`);
    }
});
