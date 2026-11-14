import { expect, test } from "@playwright/test";
import { apiCall, composerOption, ensureProjects, login, script, sessionView, state } from "./helpers";
import { frames } from "./fixture";

test("수동 endpoint 프로필의 목록에서 모델을 선택하고 비활성화해도 선택·초안을 보존하며 재활성화 후 실행한다", async ({ page, browser }) => {
    const name = `zz catalog management ${Date.now()}`;
    const base = `http://127.0.0.1:${state().fixturePort}/v1`;
    const before = (await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json() as unknown[]).length;
    await login(page);
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("프로필");
    const form = page.locator("form").filter({ has: page.getByLabel("프로필 이름") });
    await form.getByLabel("프로필 이름").fill(name);
    await form.getByLabel("Base URL").fill(base);
    await form.getByLabel("모델", { exact: true }).fill("manual-start");
    await form.getByRole("button", { name: "추가", exact: true }).click();
    const row = page.getByTestId("model-profile").filter({ hasText: name });
    await expect(row).toContainText(base);
    await row.getByRole("button", { name: "모델 목록 새로고침" }).click();
    await expect(row.getByLabel(`${name} 공급자 모델`)).toBeEnabled();
    await row.getByLabel(`${name} 공급자 모델`).selectOption("fixture-model");
    await expect(row.locator("code")).toHaveText("fixture-model");
    await expect(row.getByRole("status")).toContainText("프로필이 바뀌었습니다");
    await page.route("**/api/v1/model-profiles/*/models", (route) => route.fulfill({
        status: 502, contentType: "application/json", body: JSON.stringify({ error: { code: "catalog_invalid", message: "fixture catalog failure" } }),
    }));
    await row.getByRole("button", { name: "모델 목록 새로고침" }).click();
    await expect(row.getByRole("alert")).toContainText("마지막 조회 목록은 보존");
    await expect(row).toContainText("1개");
    await page.unroute("**/api/v1/model-profiles/*/models");
    await row.getByRole("button", { name: "모델 목록 새로고침" }).click();
    await expect(row.getByLabel(`${name} 공급자 모델`)).toBeEnabled();
    expect((await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json() as unknown[]).length).toBe(before);
    const profiles = await apiCall<{ id: string; name: string }[]>("GET", "/model-profiles");
    const profile = profiles.find((profile) => profile.name === name)!;
    const { a } = await ensureProjects();
    const botName = `${name} bot`;
    const bot = await apiCall<{ id: string }>("POST", "/bots", { name: botName, project_id: a.id, profile_id: profile.id });
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: name });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    const context = await browser.newContext();
    try {
        const app = await context.newPage();
        await login(app);
        await app.locator(".recent").getByRole("button", { name: new RegExp(name) }).click();
        const view = sessionView(app, session.id);
        const botCard = app.getByTestId("bot").filter({ hasText: botName });
        await composerOption(view, "보내기 방식", "model");
        await view.getByLabel("모델 프로필").selectOption(profile.id);
        await view.getByLabel("메시지 입력").fill("catalog user prompt");
        await row.getByRole("button", { name: "비활성화", exact: true }).click();
        await expect(row.getByRole("button", { name: "활성화", exact: true })).toBeVisible();
        await expect(view.getByTestId("profile-disabled")).toBeVisible();
        await expect(botCard).toContainText("모델 비활성");
        await expect(view.getByLabel("모델 프로필")).toHaveValue(profile.id);
        await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeDisabled();
        await expect(view.getByLabel("메시지 입력")).toHaveValue("catalog user prompt");
        await row.getByRole("button", { name: "활성화", exact: true }).click();
        await expect(view.getByTestId("profile-disabled")).toHaveCount(0);
        await expect(botCard).not.toContainText("모델 비활성");
        await expect(botCard).not.toContainText("모델 없음");
        await expect(view.getByLabel("모델 프로필")).toHaveValue(profile.id);
        await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeEnabled();
        await script({ frames: frames.text(["catalog reply"]) });
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(view.getByTestId("msg-assistant").last()).toContainText("catalog reply");
        await expect(view.getByTestId("turn-status")).toHaveCount(0);
        await apiCall("DELETE", `/model-profiles/${profile.id}`);
        const currentBot = await apiCall<{ revision: number }>("GET", `/bots/${bot.id}`);
        await apiCall("POST", `/bots/${bot.id}/status`, { expected_revision: currentBot.revision, action: "delete" });
    } finally {
        await context.close();
    }
});
