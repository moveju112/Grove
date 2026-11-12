import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, script } from "./helpers";

type Home = { home_session_id: string; name: string };

// BOT-008: 봇 home을 분할로 열고, 한쪽 탭을 닫아도 다른 칸의 봇·서버 실행이 바뀌지 않는다.
test("두 봇을 나란히 열고 한쪽 탭을 닫아도 다른 칸의 봇 대화와 실행은 그대로다", async ({ page }) => {
    const { a } = await ensureProjects();
    const prof = await ensureProfile();
    const tag = Date.now().toString(36);
    const make = async (name: string) => {
        const b = await apiCall<{ id: string }>("POST", "/bots", { name, project_id: a.id, profile_id: prof });
        return apiCall<Home>("POST", `/bots/${b.id}/home`);
    };
    const one = await make(`분할 봇1 ${tag}`);
    const two = await make(`분할 봇2 ${tag}`);
    await login(page);
    const panel = page.getByTestId("bots-panel");
    const item = (h: Home) => panel.getByTestId("bot").filter({ hasText: h.name });
    await item(one).locator(".bot-open").click();
    await item(two).getByLabel(`${two.name} 관리`).click();
    await item(two).getByRole("button", { name: "오른쪽에 열기" }).click();
    await expect(page.getByTestId("pane")).toHaveCount(2);
    const left = page.getByTestId("pane").nth(0);
    const right = page.getByTestId("pane").nth(1);
    await expect(left.locator(`[data-testid=session-view][data-session="${one.home_session_id}"]`)).toBeVisible();
    await expect(right.locator(`[data-testid=session-view][data-session="${two.home_session_id}"]`)).toBeVisible();
    // 왼쪽 봇에서 느린 답을 받는 중에 오른쪽 탭을 닫는다
    await script({ frames: frames.text(["왼쪽 ", "봇 ", "끝"]), delayMs: 400 });
    await left.getByLabel("보내기 방식").selectOption("model");
    await left.getByLabel("메시지 입력").fill("천천히");
    await left.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(item(one)).toContainText("실행 중");
    await right.locator(".tabbar .tab.on").getByRole("button", { name: "탭 닫기", exact: true }).click();
    await expect(page.locator(`[data-testid=session-view][data-session="${two.home_session_id}"]`)).toHaveCount(0);
    const leftView = page.locator(`[data-testid=session-view][data-session="${one.home_session_id}"]`);
    await expect(leftView).toBeVisible();
    await expect(leftView.getByTestId("msg-assistant").last()).toContainText("왼쪽 봇 끝", { timeout: 15_000 });
    // 오른쪽 봇의 서버 상태는 바뀌지 않았다(턴 없음)
    const turns = await apiCall<unknown[]>("GET", `/sessions/${two.home_session_id}/turns`);
    expect(turns).toHaveLength(0);
    await page.reload();
    await expect(page.locator(`[data-testid=session-view][data-session="${one.home_session_id}"]`)).toBeVisible();
});
