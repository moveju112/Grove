import { expect, test } from "@playwright/test";
import { apiCall, ensureProfile, login, openSettings, profileAction, state } from "./helpers";

// AUTH-001: 설정에서 모델 프로필의 연결 상태를 확인한다(생성 요청 없이).
test("모델 프로필 연결 확인은 생성 요청 없이 상태와 지연을 보인다", async ({ page }) => {
    await ensureProfile();
    const before = ((await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json()) as unknown[]).length;
    await login(page);
    await openSettings(page);
    await page.getByLabel("설정 검색").fill("프로필");
    const item = page.getByTestId("model-profile").filter({ hasText: "fixture-model" }).first();
    await profileAction(item, "연결 확인");
    await expect(item.getByTestId("profile-check")).toContainText("연결됨");
    await expect(item.getByTestId("profile-check")).toContainText(/\d+ms/);
    await expect(item.getByTestId("profile-check")).toContainText("모델 확인됨");
    const after = ((await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json()) as unknown[]).length;
    expect(after).toBe(before);
});

test("모델과 공유 키를 다른 화면에서 바꾸면 예전 연결 성공을 지우고 현재 대상으로 다시 확인한다", async ({ page }) => {
    const name = `check state ${Date.now()}`;
    const secret = await apiCall<{ id: string }>("POST", "/secrets", { label: name, value: "synthetic-check-key" });
    const profile = await apiCall<{ id: string; revision: number }>("POST", "/model-profiles", {
        name, protocol: "openai", model: "fixture-model", base_url: `http://127.0.0.1:${state().fixturePort}/v1`, secret_id: secret.id,
    });
    try {
        await login(page);
        await openSettings(page);
        await page.getByLabel("설정 검색").fill("프로필");
        const row = page.getByTestId("model-profile").filter({ hasText: name });
        await profileAction(row, "연결 확인");
        await expect(row.getByTestId("profile-check")).toContainText("연결됨");
        await apiCall("PUT", `/model-profiles/${profile.id}`, { expected_revision: profile.revision, model: "new-selection" });
        await expect(row.getByTestId("profile-check")).toContainText("연결 확인 안 함");
        await profileAction(row, "연결 확인");
        await expect(row.getByTestId("profile-check")).toContainText("연결됨");
        await expect(row.getByTestId("profile-check")).toContainText("이 모델 없음");
        await row.getByRole("button", { name: "모델 목록 새로고침", exact: true }).click();
        await expect(row.getByRole("combobox", { name: `${name} 공급자 모델`, exact: true })).toBeEnabled();
        await apiCall("PUT", `/secrets/${secret.id}`, { label: name, value: "synthetic-replacement-key" });
        await expect(row.getByTestId("profile-check")).toContainText("연결 확인 안 함");
        await expect(row.getByRole("combobox", { name: `${name} 공급자 모델`, exact: true })).toBeDisabled();
        await profileAction(row, "연결 확인");
        await expect(row.getByTestId("profile-check")).toContainText("연결됨");
    } finally {
        await apiCall("DELETE", `/model-profiles/${profile.id}`);
        await apiCall("DELETE", `/secrets/${secret.id}`);
    }
});
