import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, script, state } from "./helpers";

// RUN-021: 사용자가 정한 예산만 적용하고, 실행 전(다음 요청 예산·출처)과 실행 중(고정값·기준 시각·남은 시간)에 보인다.
test("예산이 없으면 표시하지 않고, 정하면 실행 전과 실행 중에 범위·기준·남은 시간을 보인다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `예산 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    await expect(view.getByTestId("budget-next")).toHaveCount(0);

    await apiCall("PUT", `/settings/session/${s.id}/runs.budget.max_minutes`, { expected_revision: 0, value: 2 });
    await expect(view.getByTestId("budget-next")).toContainText("시간 2분");
    await expect(view.getByTestId("budget-next")).toContainText("이 대화 설정");
    await expect(view.getByTestId("budget-next")).not.toContainText("token");

    const before = (await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json()).length as number;
    await script({ frames: frames.text(["진행 중"]).slice(0, 1), hang: true });
    await composerOption(view, "보내기 방식", "model");
    await view.getByLabel("메시지 입력").fill("오래 걸리는 일");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const live = view.getByTestId("budget-live");
    await expect(live).toContainText("시간 2분");
    await expect(live).toContainText("시작 기준");
    await expect(live).toContainText(/남은 1분 \d+초/);
    await expect.poll(async () => (await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json()).length).toBe(before + 1);
    await view.getByTestId("turn-status").getByRole("button", { name: "취소" }).click();
    await expect(view.getByTestId("turn-status")).toHaveCount(0);
    await expect(view.getByTestId("budget-next")).toBeVisible();
    // 정리: 공유 시험 서버의 다른 대화에는 영향이 없지만 이 대화 예산도 지운다
    await apiCall("PUT", `/settings/session/${s.id}/runs.budget.max_minutes`, { expected_revision: 1, value: null });
    await expect(view.getByTestId("budget-next")).toHaveCount(0);
});
