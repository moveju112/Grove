import { expect, test } from "@playwright/test";
import { apiCall, composerOption, ensureProjects, login, removeProfiles } from "./helpers";

// FLOW-02(실모델, opt-in): 로그인 → 첫 대화 → 새로고침 후 같은 대화·답이 보인다.
// 실제 외부 계정 대신 로컬 OpenAI 호환 경량 모델(예: Ollama qwen2.5:3b)로 실행한다.
//   GROVE_REAL_BASE=http://127.0.0.1:11434/v1 GROVE_REAL_MODEL=qwen2.5:3b npx playwright test e2e/real-model.spec.ts
const BASE = process.env.GROVE_REAL_BASE;
const MODEL = process.env.GROVE_REAL_MODEL;

test.skip(!BASE || !MODEL, "실모델 opt-in 시험: GROVE_REAL_BASE·GROVE_REAL_MODEL이 없어 건너뜀");

test("실제 경량 모델로 첫 대화를 하고 새로고침해도 대화와 답이 남는다", async ({ page }) => {
    if (process.env.GROVE_E2E_FAST !== "1") test.setTimeout(300_000);
    const { a } = await ensureProjects();
    const name = `real-${Date.now()}`;
    const prof = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name, protocol: "openai", base_url: BASE, model: MODEL, options: { timeout_secs: 240, max_tokens: 256 },
    });
    try {
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "실모델 첫 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: /실모델 첫 대화/ }).first().click();
    const view = page.getByTestId("session-view");
    await expect(view).toHaveAttribute("data-session", s.id);
    await composerOption(view, "보내기 방식", "model");
    await view.getByLabel("모델 프로필").selectOption(prof.id);
    await view.getByLabel("메시지 입력").fill("Say hello in one short sentence.");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const answer = view.getByTestId("msg-assistant").last();
    await expect(answer).not.toBeEmpty({ timeout: 240_000 });
    await expect(view.getByTestId("turn-status")).toHaveCount(0, { timeout: 240_000 });
    // 답 본문만 같은 방식(textContent)으로 비교한다. innerText는 블록 사이 줄바꿈을 넣어 toHaveText와 다르게 보인다.
    const text = ((await answer.locator(".text").textContent()) ?? "").trim();
    expect(text.length).toBeGreaterThan(0);
    // 새로고침 후 같은 대화와 답
    await page.reload();
    await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
    const v2 = page.getByTestId("session-view");
    await expect(v2).toHaveAttribute("data-session", s.id);
    await expect(v2.getByTestId("msg-assistant").last().locator(".text")).toHaveText(text);
    const turns = await apiCall<{ status: string; usage: Record<string, unknown> }[]>("GET", `/sessions/${s.id}/turns`);
    expect(turns[0]!.status).toBe("completed");
    } finally {
        // 공유 시험 서버에 남으면 다른 시험의 기본 프로필(목록 첫 항목)이 바뀐다.
        await removeProfiles((n) => n === name);
    }
});
