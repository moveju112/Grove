import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, closeModelSettings, composerOption, composerSetting, ensureProfile, ensureProjects, login, openSettings, openUsage, openTool, script, selectChoice, state } from "./helpers";

// UI-020: 추론 강도 선택(auto·낮음·중간·높음)과 /effort 명령. auto는 provider에 보내지 않는다.
const requests = async () => (await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json()) as Record<string, unknown>[];

test("추론 강도를 고르면 모델 요청에 들어가고 auto는 보내지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `강도 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    await composerOption(view, "보내기 방식", "model");
    const sel = await composerSetting(view, "추론");
    await expect(sel).toHaveAttribute("data-selected-value", "auto");
    await closeModelSettings(view);
    const box = view.getByLabel("메시지 입력");

    let before = (await requests()).length;
    await script({ frames: frames.text(["자동"]) });
    await box.fill("자동 강도");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "자동" })).toHaveCount(1, { timeout: 15_000 });
    expect((await requests()).slice(before)[0]).not.toHaveProperty("reasoning_effort");

    await composerOption(view, "추론", "low");
    before = (await requests()).length;
    await script({ frames: frames.text(["낮게 답함"]) });
    await box.fill("낮은 강도");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "낮게 답함" })).toHaveCount(1, { timeout: 15_000 });
    expect((await requests()).slice(before)[0]!["reasoning_effort"]).toBe("low");

    // 명령으로도 바꾼다
    await box.fill("/effort high");
    await box.press("Control+Enter");
    await composerSetting(view, "추론");
    await expect(sel).toHaveAttribute("data-selected-value", "high");
});

// WORKFLOW-006: 꺼진 워크플로를 고른 대화는 선택을 유지한 채 기본 워크플로로 요청한다.
test("꺼진 워크플로를 고른 대화는 선택이 남고, 이번 요청은 기본 워크플로로 대신한다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const id = `wf-off-${Date.now()}`;
    await apiCall("POST", "/definitions/workflow", { id, name: "꺼둘 흐름", body: "WF-OFF-BODY" });
    const title = `꺼진 워크플로 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string; revision: number }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("PATCH", `/sessions/${s.id}`, { expected_revision: s.revision, workflow_id: id });
    const d = await apiCall<{ revision: number }>("GET", `/definitions/workflow/${id}`);
    await apiCall("PUT", `/definitions/workflow/${id}`, { expected_revision: d.revision, enabled: false });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    await openTool(view, "대화");
    const wf = view.getByRole("combobox", { name: "워크플로우", exact: true });
    await expect(wf).toHaveAttribute("data-selected-value", id);
    await expect(wf).toContainText("꺼짐 · 다음 요청은 기본 워크플로우");
    await page.keyboard.press("Escape");
    await composerOption(view, "보내기 방식", "model");
    const before = (await requests()).length;
    await script({ frames: frames.text(["진행"]).slice(0, 1), hang: true });
    await view.getByLabel("메시지 입력").fill("꺼진 흐름으로");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("turn-status")).toBeVisible();
    await expect.poll(async () => (await requests()).length).toBe(before + 1);
    expect(JSON.stringify((await requests())[before])).not.toContain("WF-OFF-BODY");
    await view.getByTestId("turn-status").getByRole("button", { name: "취소" }).click();
    await expect(view.getByTestId("turn-status")).toHaveCount(0);
});

// FAIR-011: 사용량 화면은 서버 합계와 이 기기 요청의 상태를 보여 주고 거기서 취소할 수 있다.
test("사용량 화면의 실행 용량에서 이 기기의 실행 중 요청을 보고 취소한다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `용량 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    await composerOption(view, "보내기 방식", "model");
    await script({ frames: frames.text(["진행"]).slice(0, 1), hang: true });
    await view.getByLabel("메시지 입력").fill("오래 걸리는 일");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("turn-status")).toBeVisible();
    const panel = await openUsage(page);
    await panel.getByRole("button", { name: "실행 현황·추정 비용", exact: true }).click();
    const cap = panel.getByTestId("usage-capacity");
    await expect(cap).toContainText(/서버 전체: 실행 \d+\/\d+/);
    const row = cap.getByTestId("capacity-request").filter({ hasText: title });
    await expect(row).toContainText("실행 중");
    await row.getByRole("button", { name: "취소" }).click();
    await expect(row).toHaveCount(0);
    const turns = await apiCall<{ status: string }[]>("GET", `/sessions/${s.id}/turns`);
    expect(turns[0]!.status).toBe("cancelled");
});

// RUN-009: 실행 설정 팝업 없이도 실행 중 강도 변경은 다음 요청부터 적용된다.
test("실행 설정 버튼 없이 실행 상태와 취소를 제공하고 강도 변경은 다음 요청부터 적용된다", async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `적용 시점 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    await composerOption(view, "보내기 방식", "model");
    const sel = await composerSetting(view, "추론");
    await selectChoice(sel, "low");
    await closeModelSettings(view);
    const before = (await requests()).length;
    await script({ frames: frames.text(["진행"]).slice(0, 1), hang: true });
    await view.getByLabel("메시지 입력").fill("오래 걸리는 일");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const status = view.getByTestId("turn-status");
    await expect(status).toContainText("실행 중");
    await expect(status.getByRole("button", { name: "취소", exact: true })).toBeVisible();
    await expect(view.getByRole("button", { name: "실행 설정", exact: true })).toHaveCount(0);
    await expect(view.getByRole("dialog", { name: "실행 설정", exact: true })).toHaveCount(0);
    await composerOption(view, "추론", "high");
    await expect.poll(async () => (await requests()).length).toBe(before + 1);
    expect((await requests())[before]!["reasoning_effort"]).toBe("low");
    const turns = await apiCall<{ definition: { effort: string; effort_applied: { field: string; value: string } } }[]>("GET", `/sessions/${s.id}/turns`);
    expect(turns[0]!.definition).toMatchObject({ effort: "low", effort_applied: { field: "reasoning_effort", value: "low" } });
    await page.screenshot({ path: info.outputPath("running-without-settings-390.png") });
    await status.getByRole("button", { name: "취소" }).click();
    await expect(status).toHaveCount(0);
    await script({ frames: frames.text(["다음 요청"]) });
    await view.getByLabel("메시지 입력").fill("다음");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "다음 요청" })).toHaveCount(1, { timeout: 15_000 });
    expect((await requests())[before + 1]!["reasoning_effort"]).toBe("high");
});
