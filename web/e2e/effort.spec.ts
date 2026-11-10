import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, script, state } from "./helpers";

// UI-020: 추론 강도 선택(auto·낮음·중간·높음)과 /effort 명령. auto는 provider에 보내지 않는다.
const requests = async () => (await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json()) as Record<string, unknown>[];

test("추론 강도를 고르면 모델 요청에 들어가고 auto는 보내지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `강도 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    await view.getByLabel("보내기 방식").selectOption("model");
    const sel = view.getByLabel("추론 강도");
    await expect(sel).toHaveValue("auto");
    const box = view.getByLabel("메시지 입력");

    let before = (await requests()).length;
    await script({ frames: frames.text(["자동"]) });
    await box.fill("자동 강도");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "자동" })).toHaveCount(1, { timeout: 15_000 });
    expect((await requests()).slice(before)[0]).not.toHaveProperty("reasoning_effort");

    await sel.selectOption("low");
    before = (await requests()).length;
    await script({ frames: frames.text(["낮게 답함"]) });
    await box.fill("낮은 강도");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "낮게 답함" })).toHaveCount(1, { timeout: 15_000 });
    expect((await requests()).slice(before)[0]!["reasoning_effort"]).toBe("low");

    // 명령으로도 바꾼다
    await box.fill("/effort high");
    await box.press("Control+Enter");
    await expect(sel).toHaveValue("high");
});

// RUN-009: 실행 중 바꾼 모델·강도는 이번 요청에 적용되지 않고, 적용 시점을 보여 준다.
test("실행 중 강도를 바꾸면 이번 요청은 그대로이고 다음 요청부터 적용된다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `적용 시점 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    await view.getByLabel("보내기 방식").selectOption("model");
    const sel = view.getByLabel("추론 강도");
    await sel.selectOption("low");
    const before = (await requests()).length;
    await script({ frames: frames.text(["진행"]).slice(0, 1), hang: true });
    await view.getByLabel("메시지 입력").fill("오래 걸리는 일");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const info = view.getByTestId("active-settings");
    await expect(info).toContainText("강도 low");
    await expect(info).toContainText("fixture-model");
    await expect(info).toContainText("다음 요청부터 적용");
    await sel.selectOption("high");
    await expect(info).toContainText("강도 low");
    await expect.poll(async () => (await requests()).length).toBe(before + 1);
    expect((await requests())[before]!["reasoning_effort"]).toBe("low");
    await view.getByTestId("turn-status").getByRole("button", { name: "취소" }).click();
    await expect(info).toHaveCount(0);
    await script({ frames: frames.text(["다음 요청"]) });
    await view.getByLabel("메시지 입력").fill("다음");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "다음 요청" })).toHaveCount(1, { timeout: 15_000 });
    expect((await requests())[before + 1]!["reasoning_effort"]).toBe("high");
});
