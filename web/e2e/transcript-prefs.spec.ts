import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, openDetails, script } from "./helpers";

// UI-012: 생각 과정(reasoning) 접기·펼치기·숨김, 답만 보기, 도구 세부 펼침.
test("생각 과정 표시·답만 보기·도구 세부 펼침 설정이 대화 표시에 반영된다", async ({ page }) => {
    const { a } = await ensureProjects();
    const profile = await ensureProfile();
    const title = `표시 설정 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.evaluate(() => localStorage.removeItem("grove.device.prefs"));
    await page.reload();
    const openSession = () => page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    await openSession();
    const view = page.getByTestId("session-view");

    // 도구 실행(list는 자동 실행) → 생각 과정이 있는 답
    await script({ frames: frames.tool("l1", "list", {}) });
    await script({ frames: frames.reasoning("목록을 보고 판단한다", "정리한 답") });
    await composerOption(view, "도구", true);
    await composerOption(view, "보내기 방식", "model");
    await view.getByLabel("모델 프로필", { exact: true }).selectOption(profile);
    await view.getByLabel("메시지 입력").fill("목록 보고 답해");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const answer = view.getByTestId("msg-assistant").filter({ hasText: "정리한 답" });
    await expect(answer).toHaveCount(1, { timeout: 15_000 });
    await composerOption(view, "도구", false);
    await page.keyboard.press("Escape");

    // 기본: 생각 과정은 접힌 채 보이고, 도구 세부도 접혀 있다
    const r = answer.getByTestId("msg-reasoning");
    await expect(r).toBeVisible();
    await expect(r.getByRole("button")).toContainText("생각 과정 · 11자");
    await expect(r.getByText("목록을 보고 판단한다", { exact: true })).toHaveCount(0);
    await expect(view.getByTestId("msg-tool")).toHaveCount(1);
    await expect(view.getByTestId("msg-tool").getByTestId("tool-output")).toHaveCount(0);
    await openDetails(r);
    await expect(r.getByRole("dialog")).toContainText("목록을 보고 판단한다");
    await page.keyboard.press("Escape");

    // 설정 변경: 펼치기 + 도구 세부 펼침
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("대화 표시");
    await page.getByLabel("생각 과정 표시").selectOption("expanded");
    await page.getByRole("switch", { name: "도구 실행 세부를 펼쳐서 표시", exact: true }).check();
    await openSession();
    await expect(answer.getByTestId("msg-reasoning")).toContainText("목록을 보고 판단한다");
    await expect(view.getByTestId("msg-tool").getByTestId("tool-output")).toBeVisible();

    // 숨김 + 답만 보기: 생각 과정·도구 기록·글 없는 도구 호출 메시지가 사라지고 답은 남는다
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("대화 표시");
    await page.getByLabel("생각 과정 표시").selectOption("hidden");
    await page.getByRole("switch", { name: "답만 보기", exact: true }).check();
    await openSession();
    await expect(answer).toBeVisible();
    await expect(view.getByTestId("msg-reasoning")).toHaveCount(0);
    await expect(view.getByTestId("msg-tool")).toHaveCount(0);
    await expect(view.getByTestId("msg-assistant")).toHaveCount(1);
    await expect(view.getByTestId("msg-user")).toHaveCount(1);

    // 기기 설정이므로 새로고침 뒤에도 유지된다
    await page.reload();
    await openSession();
    await expect(view.getByTestId("msg-tool")).toHaveCount(0);
    await page.evaluate(() => localStorage.removeItem("grove.device.prefs"));
});
