import { expect, test } from "@playwright/test";
import { apiCall, ensureProfile, ensureProjects, login } from "./helpers";

// UI-024: slash command 목록·검색·실행과 일반 글의 구분.
test("slash command 목록·검색·채우기·실행, 알 수 없는 명령은 보내지 않고 //는 글로 보낸다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `명령 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view").first();
    const box = view.getByLabel("메시지 입력");
    const list = view.getByTestId("slash-list");

    // 목록과 검색
    await box.fill("/");
    await expect(list.getByRole("option")).toHaveCount(8);
    await expect(list).toContainText("/compact");
    await expect(list).toContainText("/fork context|history");
    await box.pressSequentially("to");
    await expect(list.getByRole("option")).toHaveCount(1);
    await expect(list.getByRole("option")).toContainText("/tools on|off");
    // Tab으로 채우고 실행
    await box.press("Tab");
    await expect(box).toHaveValue("/tools ");
    await box.pressSequentially("on");
    await box.press("Control+Enter");
    await expect(view.getByRole("status").filter({ hasText: "도구 사용을 켰습니다" })).toBeVisible();
    await expect(view.getByLabel("도구", { exact: true })).toHaveCount(0);
    await expect(box).toHaveValue("");

    // 방향키 선택 + Enter 채우기
    await box.fill("/s");
    await expect(list.getByRole("option")).toHaveCount(1);
    await box.press("Enter");
    await expect(box).toHaveValue("/save ");
    await box.press("Control+Enter");
    await expect(view.getByTestId("model-summary")).toHaveText("메시지만 저장");

    // 알 수 없는 명령은 보내지 않는다
    await box.fill("/없는명령 해줘");
    await box.press("Control+Enter");
    await expect(view.getByText(/알 수 없는 명령 \/없는명령/)).toBeVisible();
    await expect(view.getByTestId("msg-user")).toHaveCount(0);
    await expect(box).toHaveValue("/없는명령 해줘");

    // //는 '/'로 시작하는 일반 글
    await box.fill("//compact 는 명령이 아니라 글");
    await expect(list).toHaveCount(0);
    await box.press("Control+Enter");
    await expect(view.getByTestId("msg-user")).toHaveCount(1);
    await expect(view.getByTestId("msg-user")).toContainText("/compact 는 명령이 아니라 글");
    await expect(box).toHaveValue("");

    // 화면 명령: 새 대화를 오른쪽에 연다
    await box.fill("/new 명령으로 만든 대화");
    await box.press("Control+Enter");
    await expect(page.getByTestId("pane")).toHaveCount(2);
    await expect(page.getByTestId("session-view").nth(1).getByRole("heading")).toContainText("명령으로 만든 대화");
});
