import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, script } from "./helpers";

// UI-006: 실패한 요청은 원인 메시지와 함께 오류로 표시하고, 자동으로 다시 실행하지 않는다고 알린다.
test("실패한 요청은 원인과 함께 오류로 표시된다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `오류 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    // 이 대화에만 아주 작은 token 예산 → 첫 응답에서 예산 초과로 실패
    await apiCall("PUT", `/settings/session/${s.id}/runs.budget.max_tokens`, { expected_revision: 0, value: 1 });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    // 응답 usage(입력 11·출력 3)를 함께 보내는 대본
    const f = frames.text(["예산을 넘는 답"]);
    f.splice(1, 0, JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } }));
    await script({ frames: f });
    await view.getByLabel("보내기 방식").selectOption("model");
    await view.getByLabel("메시지 입력").fill("길게 답해");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const err = view.locator(".turn-status.err");
    await expect(err).toBeVisible({ timeout: 15_000 });
    await expect(err).toHaveAttribute("role", "alert");
    await expect(err).toContainText("마지막 요청이 실패했습니다");
    await expect(err).toContainText("token 한도 1");
    await expect(err).toContainText("자동으로 다시 실행하지 않습니다");
    const cause = view.getByTestId("msg-turn-ended").first();
    await expect(cause).toContainText("budget_exceeded");
    await cause.locator("summary").click();
    await expect(cause).toContainText("발생 시각:");
    await expect(cause).toContainText("마지막 진행:");
    await expect(cause).toContainText("적용 예산: 1 tokens");
    // RUN-024: 미완료 범위와 다음 조치를 배너·기록에 보여 주고 새로고침 뒤에도 같다
    await expect(cause.getByTestId("end-scope")).toContainText("진행 범위: 모델 응답 1단계 · 최종 답변 없음 · 도구 호출 없음");
    await expect(err.getByTestId("end-scope")).toContainText("다음 조치:");
    await page.reload();
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    await expect(err.getByTestId("end-scope")).toContainText("진행 범위: 모델 응답 1단계");

    // RUN-019: 예산을 풀고 '다시 실행'하면 같은 글로 새 요청을 보낸다
    await apiCall("PUT", `/settings/session/${s.id}/runs.budget.max_tokens`, { expected_revision: 1, value: null });
    await script({ frames: frames.text(["다시 실행한 답"]) });
    await err.getByRole("button", { name: "다시 실행" }).click();
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "다시 실행한 답" })).toHaveCount(1, { timeout: 15_000 });
    await expect(view.getByTestId("turn-ended")).toHaveCount(0);
    await expect(view.getByTestId("msg-user").filter({ hasText: "길게 답해" })).toHaveCount(2);
    await expect(cause).toContainText("budget_exceeded");

    // 다시 실패시키고 '닫기(포기)': 배너가 닫히고 새로고침 뒤에도 다시 뜨지 않는다
    await apiCall("PUT", `/settings/session/${s.id}/runs.budget.max_tokens`, { expected_revision: 2, value: 1 });
    const f2 = frames.text(["또 넘는 답"]);
    f2.splice(1, 0, JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } }));
    await script({ frames: f2 });
    await view.getByLabel("메시지 입력").fill("또 길게");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("turn-ended")).toBeVisible({ timeout: 15_000 });
    await view.getByTestId("turn-ended").getByRole("button", { name: "새 요청 쓰기" }).click();
    await expect(view.getByLabel("메시지 입력")).toBeFocused();
    await view.getByTestId("turn-ended").getByRole("button", { name: "닫기(포기)" }).click();
    await expect(view.getByTestId("turn-ended")).toHaveCount(0);
    await page.reload();
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    await expect(page.getByTestId("session-view").getByTestId("msg-user").filter({ hasText: "또 길게" })).toHaveCount(1);
    await expect(page.getByTestId("session-view").getByTestId("turn-ended")).toHaveCount(0);
    await expect(page.getByTestId("session-view").getByTestId("msg-turn-ended")).toHaveCount(2);
    await apiCall("PUT", `/settings/session/${s.id}/runs.budget.max_tokens`, { expected_revision: 3, value: null });
});
