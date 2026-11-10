import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, ensureProfile, login, script } from "./helpers";

// FLOW-08: 가져온 대화를 열람하고, 같은 대화에서 후속 요청을 보낸다(재개는 텍스트만이라고 명시).
test("가져온 Paseo 대화를 열람하고 이어서 요청할 수 있으며 재개 범위가 표시된다", async ({ page }) => {
    await ensureProfile();
    const found = await apiCall<{ items: { id: string; project_id: string; title: string }[] }>("GET", "/sessions/search?q=" + encodeURIComponent("예전에"));
    const s = found.items.find((x) => x.title === "예전에 묻던 질문");
    expect(s, "global-setup에서 가져온 대화").toBeTruthy();
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: s!.project_id, resource_id: s!.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: /예전에 묻던 질문/ }).first().click();
    const view = page.getByTestId("session-view");
    await expect(view).toHaveAttribute("data-session", s!.id);

    await expect(view.getByTestId("msg-import-notice")).toContainText("도구 결과·압축 요약은 보내지 않습니다");
    await expect(view.getByTestId("msg-import-notice")).toContainText("실행 중이던 작업 1건은 결과를 알 수 없으며 다시 실행하지 않았습니다");
    await expect(view.getByTestId("msg-imported-tool")).toContainText("결과 불명(중단)");
    await expect(view.getByTestId("msg-imported-note")).toContainText("자동 압축된 지점");
    await expect(view.getByTestId("msg-user").first()).toContainText("예전에 묻던 질문");
    await expect(view.getByTestId("msg-assistant").first()).toContainText("예전 답변");

    // 후속 요청: 같은 대화에서 모델 응답을 받는다
    await script({ frames: frames.text(["이어서 ", "답변"]) });
    await view.getByLabel("보내기 방식").selectOption("model");
    await view.getByLabel("메시지 입력").fill("이어서 물어볼게");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("이어서 답변", { timeout: 15_000 });
    // 가져온 도구는 다시 실행되지 않았다(실행 기록 없음)
    const calls = await apiCall<unknown[] | { items: unknown[] }>("GET", `/tool-calls?session_id=${s!.id}`);
    expect(Array.isArray(calls) ? calls.length : calls.items.length).toBe(0);
});
