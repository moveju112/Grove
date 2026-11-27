import { expect, test } from "@playwright/test";
import { apiCall, composerOption, ensureProjects, expectComposerSetting, login, openDetails, openSettings, script, selectChoice, sessionView, state } from "./helpers";
import { frames } from "./fixture";

test("모델 기능을 설정하면 다른 화면의 미지원 선택·초안은 보존하고 명시적으로 수정한 뒤 보낸다", async ({ page, browser }) => {
    const { a } = await ensureProjects();
    const name = `capability ${Date.now()}`;
    const profile = await apiCall<{ id: string; revision: number }>("POST", "/model-profiles", {
        name, protocol: "openai", base_url: `http://127.0.0.1:${state().fixturePort}/v1`, model: "fixture-model",
    });
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: name });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await openSettings(page);
    await page.getByLabel("설정 검색").fill("프로필");
    const row = page.getByTestId("model-profile").filter({ hasText: name });
    await openDetails(row);
    await expect(row.getByRole("combobox", { name: "이미지 입력 지원 여부", exact: true })).toContainText("미확인");
    const context = await browser.newContext();
    try {
        const app = await context.newPage();
        await login(app);
        await app.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(name) }).click();
        const view = sessionView(app, session.id);
        await composerOption(view, "보내기 방식", "model");
        await composerOption(view, "모델 프로필", profile.id);
        await composerOption(view, "추론", "high");
        await composerOption(view, "도구", true);
        await view.getByLabel("메시지 입력").fill("capability draft");
        await row.getByLabel("context token 수", { exact: true }).fill("16000");
        await row.getByLabel("모델 출력 상한", { exact: true }).fill("1024");
        for (const label of ["이미지 입력", "Grove 도구 루프", "추론", "temperature"]) {
            await selectChoice(row.getByLabel(`${label} 지원 여부`, { exact: true }), "false");
        }
        await expect(row.getByRole("status").filter({ hasText: "저장됨" })).toBeVisible();
        await expect(row.getByLabel("context token 수", { exact: true })).toHaveValue("16000");
        await expect(row.getByTestId("model-capabilities")).toContainText("native PDF 미지원");
        await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeDisabled();
        await expect(view).toContainText("Grove 도구 루프 미지원");
        await expectComposerSetting(view, "모델 프로필", profile.id);
        await expect(view.getByLabel("메시지 입력")).toHaveValue("capability draft");
        await expectComposerSetting(view, "추론", "high");
        await composerOption(view, "도구", false);
        await expect(view).toContainText("추론 미지원");
        await composerOption(view, "추론", "auto");
        await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeEnabled();
        await expect(view.getByRole("checkbox", { name: "도구", exact: true })).toHaveCount(0);
        await script({ frames: frames.text(["capability reply"]) });
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(view.getByTestId("msg-assistant").last()).toContainText("capability reply");
        await expect(view.getByTestId("turn-status")).toHaveCount(0);
    } finally {
        await context.close();
        await apiCall("DELETE", `/model-profiles/${profile.id}`);
    }
});

test("모델 기능 편집은 다른 기기의 변경 revision을 자동 인수하지 않는다", async ({ page }) => {
    const name = `capability conflict ${Date.now()}`;
    const profile = await apiCall<{ id: string; revision: number }>("POST", "/model-profiles", {
        name, protocol: "openai", base_url: `http://127.0.0.1:${state().fixturePort}/v1`, model: "fixture-model",
    });
    try {
        await login(page);
        await openSettings(page);
        await page.getByLabel("설정 검색").fill("프로필");
        const row = page.getByTestId("model-profile").filter({ hasText: name });
        await openDetails(row);
        await row.getByLabel("context token 수", { exact: true }).fill("32000");
        await apiCall("PUT", `/model-profiles/${profile.id}`, { expected_revision: profile.revision, options: { context_window: 8000 } });
        await row.getByLabel("context token 수", { exact: true }).blur();
        await expect(row).toContainText("다른 기기에서 먼저 바뀌었어요");
        await expect(row.getByLabel("context token 수", { exact: true })).toHaveValue("32000");
        const stored = (await apiCall<{ id: string; capabilities: { context_tokens: number } }[]>("GET", "/model-profiles")).find((p) => p.id === profile.id)!;
        expect(stored.capabilities.context_tokens).toBe(8000);
        await row.getByRole("button", { name: "최신 값 사용", exact: true }).click();
        await expect(row.getByLabel("context token 수", { exact: true })).toHaveValue("8000");
    } finally {
        await apiCall("DELETE", `/model-profiles/${profile.id}`);
    }
});
