import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, composerCommand, composerOption, ensureProfile, ensureProjects, login, openDetails, script, selectChoice } from "./helpers";

test("진행사항 표시만 설정할 수 있고 도구 기록과 추론 요약은 항상 숨긴다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `표시 설정 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    // 업그레이드 전 설정값이 남아도 기록을 표시하지 않는다.
    await page.evaluate(() => localStorage.setItem("grove.device.prefs", JSON.stringify({ answerOnly: false, expandTools: true, reasoning: "expanded" })));
    await page.reload();
    const openSession = () => page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    await openSession();
    const view = page.getByTestId("session-view");

    // 진행 설명과 요약을 보내고, 도구 실행 뒤 요약과 최종 답변을 보낸다.
    await script({ frames: [
        ...frames.reasoning("파일 목록부터 확인한다", "파일 목록을 확인할게.").slice(0, 2),
        ...frames.tool("l1", "list", {}),
    ] });
    await script({ frames: frames.reasoning("목록을 보고 판단한다", "정리한 답") });
    await composerOption(view, "도구", true);
    await composerOption(view, "보내기 방식", "model");
    await composerCommand(view, "/model fixture");
    await view.getByLabel("메시지 입력").fill("목록 보고 답해");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const answer = view.getByTestId("msg-assistant").filter({ hasText: "정리한 답" });
    await expect(answer).toHaveCount(1, { timeout: 15_000 });
    await composerOption(view, "도구", false);
    await page.keyboard.press("Escape");

    await expect(view.getByTestId("msg-tool")).toHaveCount(0);
    await expect(view.getByText(/도구 호출:/)).toHaveCount(0);
    await expect(view.getByTestId("msg-assistant")).toHaveCount(1);
    await expect(view.getByTestId("msg-reasoning")).toHaveCount(0);
    await openDetails(answer.getByTestId("msg-progress"));
    const dialog = page.getByRole("dialog", { name: "진행 설명" });
    await expect(dialog.getByTestId("progress-step")).toHaveText(["파일 목록을 확인할게."]);
    await expect(page.getByText(/파일 목록부터 확인한다|목록을 보고 판단한다/)).toHaveCount(0);
    await page.keyboard.press("Escape");

    const openSettings = async () => {
        await page.getByTestId("sidebar").getByRole("button", { name: "설정", exact: true }).click();
        await page.getByLabel("설정 검색").fill("대화 표시");
    };
    const setting = page.getByRole("combobox", { name: "진행사항 보기", exact: true });
    const closeSettings = () => page.getByRole("button", { name: "설정 닫기", exact: true }).click();
    await openSettings();
    await expect(setting).toContainText("완료 시 접기");
    await expect(page.getByLabel("추론 보기", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("도구 실행 세부를 펼쳐서 표시", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("답만 보기", { exact: true })).toHaveCount(0);
    await selectChoice(setting, "hidden");
    await expect(setting).toContainText("안 보기");
    await closeSettings();
    await expect(answer).toBeVisible();
    await expect(view.getByTestId("msg-reasoning")).toHaveCount(0);
    await expect(view.getByTestId("msg-tool")).toHaveCount(0);
    await expect(view.getByTestId("msg-assistant")).toHaveCount(1);
    await expect(view.getByTestId("msg-user")).toHaveCount(1);
    await expect(answer.getByTestId("msg-progress")).toHaveCount(0);

    await page.reload();
    await openSession();
    await expect(view.getByTestId("msg-tool")).toHaveCount(0);
    await expect(view.getByTestId("msg-assistant")).toHaveCount(1);
    await expect(answer.getByTestId("msg-answer")).toContainText("정리한 답");
    await expect(answer.getByTestId("msg-progress")).toHaveCount(0);
    await expect(view.getByTestId("msg-reasoning")).toHaveCount(0);

    await openSettings();
    await selectChoice(setting, "collapse");
    await closeSettings();
    await expect(answer.getByTestId("msg-progress").getByRole("button")).toBeVisible();
});
