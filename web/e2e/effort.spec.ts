import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, script, state } from "./helpers";

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
    await composerOption(view, "보내기 방식", "model");
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

// WORKFLOW-006: 꺼진 워크플로를 고른 대화는 선택을 유지한 채 기본 워크플로로 요청하고 그 사실을 보여 준다.
test("꺼진 워크플로를 고른 대화는 선택이 남고, 이번 요청은 기본 워크플로로 대신했다고 보여 준다", async ({ page }) => {
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
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    const wf = view.getByLabel("워크플로우");
    await expect(wf).toHaveValue(id);
    await expect(wf.locator("option:checked")).toContainText("꺼짐 · 다음 요청은 기본 워크플로우");
    await composerOption(view, "보내기 방식", "model");
    const before = (await requests()).length;
    await script({ frames: frames.text(["진행"]).slice(0, 1), hang: true });
    await view.getByLabel("메시지 입력").fill("꺼진 흐름으로");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("active-settings")).toContainText("(꺼진 꺼둘 흐름 대신)");
    await expect.poll(async () => (await requests()).length).toBe(before + 1);
    expect(JSON.stringify((await requests())[before])).not.toContain("WF-OFF-BODY");
    await view.getByTestId("turn-status").getByRole("button", { name: "취소" }).click();
    await expect(view.getByTestId("active-settings")).toHaveCount(0);
});

// FAIR-011: 사용량 화면은 서버 합계와 이 기기 요청의 상태를 보여 주고 거기서 취소할 수 있다.
test("사용량 화면의 실행 용량에서 이 기기의 실행 중 요청을 보고 취소한다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `용량 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    await composerOption(view, "보내기 방식", "model");
    await script({ frames: frames.text(["진행"]).slice(0, 1), hang: true });
    await view.getByLabel("메시지 입력").fill("오래 걸리는 일");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("active-settings")).toBeVisible();
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("사용량");
    const cap = page.getByTestId("usage-capacity");
    await expect(cap).toContainText(/서버 전체: 실행 \d+\/\d+/);
    const row = cap.getByTestId("capacity-request").filter({ hasText: title });
    await expect(row).toContainText("실행 중");
    await row.getByRole("button", { name: "취소" }).click();
    await expect(row).toHaveCount(0);
    const turns = await apiCall<{ status: string }[]>("GET", `/sessions/${s.id}/turns`);
    expect(turns[0]!.status).toBe("cancelled");
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
    await composerOption(view, "보내기 방식", "model");
    const sel = view.getByLabel("추론 강도");
    await sel.selectOption("low");
    const before = (await requests()).length;
    await script({ frames: frames.text(["진행"]).slice(0, 1), hang: true });
    await view.getByLabel("메시지 입력").fill("오래 걸리는 일");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const info = view.getByTestId("active-settings");
    await expect(info).toContainText("강도 low");
    // EFF-009: 요청값과 실제 전송값을 구분해 보여 준다
    await expect(info.getByTestId("effort-applied")).toHaveText("(실제 전송 reasoning_effort=low)");
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
