import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login } from "./helpers";

// UI-026: 검색 결과를 누르면 그 대화의 정확한 메시지로 이동한다(첫 페이지 밖이면 이전 페이지를 읽어서).
test("검색 결과를 누르면 오래된 메시지까지 이전 페이지를 읽어 그 메시지로 이동하고 강조한다", async ({ page }) => {
    const { a } = await ensureProjects();
    const word = `needle${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `긴 대화 ${word.slice(-5)}` });
    // 첫 화면(최근 100개) 밖, 두 페이지 앞에 있는 메시지
    for (let i = 0; i < 230; i++) {
        await apiCall("POST", `/sessions/${s.id}/messages`, { text: i === 10 ? `여기에 ${word} 가 있다` : `채움 메시지 ${i}` });
    }
    await login(page);
    const panel = page.getByTestId("search-panel");
    await panel.locator("summary").click();
    await panel.getByLabel("대화 검색어").fill(word);
    const hit = panel.getByTestId("search-hit");
    await expect(hit).toHaveCount(1);
    await hit.getByRole("button").click();
    const view = page.getByTestId("session-view");
    const target = view.locator(".msg-row.focus-hit");
    await expect(target).toHaveCount(1, { timeout: 15_000 });
    await expect(target).toContainText(word);
    await expect(target).toBeInViewport();
    // 강조는 잠시 뒤 사라진다
    await expect(view.locator(".msg-row.focus-hit")).toHaveCount(0, { timeout: 8_000 });
    await expect(view.getByText(`여기에 ${word} 가 있다`)).toBeVisible();
});
