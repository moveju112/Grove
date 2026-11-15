import { expect, test, type Page } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, openDetails, script, sessionView } from "./helpers";

const row = (page: Page, id: string) => page.locator(`[data-testid="sidebar-session"][data-session="${id}"]`);
const project = (page: Page, id: string) => page.locator(`[data-testid="sidebar-project"][data-project-id="${id}"]`);

test("사이드바 핀·읽음은 다른 기기와 새로고침에 유지되고 최근·분할 열기를 보존한다", async ({ page, browser, baseURL }) => {
    const { a } = await ensureProjects();
    const title = `sidebar-shared-${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", `/sessions/${session.id}/messages`, { text: "기기 간 읽지 않음" });
    const context = await browser.newContext({ baseURL });
    try {
        const other = await context.newPage();
        await login(page);
        await login(other);
        const first = row(page, session.id);
        const second = row(other, session.id);
        await expect(first).toContainText("읽지 않음");
        await expect(second).toContainText("읽지 않음");
        await openDetails(first.locator(".sidebar-session-actions"));
        await openDetails(second.locator(".sidebar-session-actions"));
        const pin = first.getByRole("button", { name: "세션 고정", exact: true });
        await pin.focus();
        await pin.press("Enter");
        await expect(second.getByRole("button", { name: "세션 고정 해제", exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(project(page, a.id).getByTestId("sidebar-session").first()).toHaveAttribute("data-session", session.id);
        await openDetails(first.locator(".sidebar-session-actions"));
        await first.getByRole("button", { name: "읽음 표시", exact: true }).click();
        await expect(second.locator(".sidebar-unread")).toHaveCount(0);
        await page.reload();
        await openDetails(first.locator(".sidebar-session-actions"));
        await expect(first.getByRole("button", { name: "세션 고정 해제", exact: true })).toBeVisible();
        await expect(first.locator(".sidebar-unread")).toHaveCount(0);
        await apiCall("POST", `/sessions/${session.id}/messages`, { text: "읽은 뒤 새 메시지" });
        await expect(first.locator(".sidebar-unread")).toBeVisible();
        await expect(second.locator(".sidebar-unread")).toBeVisible();
        await first.getByRole("button", { name: "세션 오른쪽에 열기", exact: true }).click();
        await expect(sessionView(page, session.id)).toBeVisible();
        await expect(page.getByTestId("pane")).toHaveCount(2);
        await expect(first.locator(".sidebar-unread")).toHaveCount(0);
        await expect(page.locator(".recent").getByTestId("recent-item").filter({ hasText: title })).toBeVisible();
        await second.getByRole("button", { name: "세션 고정 해제", exact: true }).click();
        await openDetails(first.locator(".sidebar-session-actions"));
        await expect(first.getByRole("button", { name: "세션 고정", exact: true })).toHaveAttribute("aria-pressed", "false");
    } finally {
        await context.close();
    }
});

test("실제 턴의 실행 중·승인 대기·완료·오류를 프로젝트와 세션에 표시한다", async ({ page }) => {
    const { a } = await ensureProjects();
    const profile = await ensureProfile();
    const marker = `sidebar-status-${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: marker });
    await login(page);
    const item = row(page, session.id);
    await expect(item.getByTestId("sidebar-status")).toHaveText("○ 대기");
    try {
        await script({ frames: [], hang: true, marker: `${marker}-running` });
        const started = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, {
            text: `${marker}-running`, profile_id: profile, tools: false,
        });
        await expect(item.getByTestId("sidebar-status")).toHaveText("▶ 실행 중");
        await expect(project(page, a.id).locator(".sidebar-project-summary")).toContainText("실행 중");
        await apiCall("POST", `/turns/${started.turn.id}/cancel`);
        await expect(item.getByTestId("sidebar-status")).toHaveText("− 취소됨");

        await script({ frames: frames.tool("sidebar-write", "write", { path: `${marker}.txt`, content: "fixture" }), marker: `${marker}-approval` });
        await script({ frames: frames.text(["승인 거부 확인"]), marker: `${marker}-approval` });
        await apiCall("POST", `/sessions/${session.id}/turns`, { text: `${marker}-approval`, profile_id: profile, tools: true });
        await expect(item.getByTestId("sidebar-status")).toHaveText("◇ 승인 대기");
        await expect(project(page, a.id).locator(".sidebar-project-summary")).toContainText("승인 대기");
        await item.locator(".sidebar-session-open").click();
        await sessionView(page, session.id).getByTestId("approval").getByRole("button", { name: "거부", exact: true }).click();
        await expect(item.getByTestId("sidebar-status")).toHaveText("✓ 완료");

        await apiCall("PUT", `/settings/session/${session.id}/runs.budget.max_tokens`, { expected_revision: 0, value: 1 });
        const response = frames.text(["예산 초과"]);
        response.splice(1, 0, JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } }));
        await script({ frames: response, marker: `${marker}-failure` });
        await apiCall("POST", `/sessions/${session.id}/turns`, { text: `${marker}-failure`, profile_id: profile, tools: false });
        await expect(item.getByTestId("sidebar-status")).toHaveText("× 오류");
        await expect(project(page, a.id).locator(".sidebar-project-summary")).toContainText("오류");
        await page.reload();
        await expect(item.getByTestId("sidebar-status")).toHaveText("× 오류");
    } finally {
        const turns = await apiCall<{ id: string; status: string }[]>("GET", `/sessions/${session.id}/turns`);
        for (const turn of turns.filter((t) => ["running", "queued", "awaiting_approval"].includes(t.status))) {
            await apiCall("POST", `/turns/${turn.id}/cancel`);
        }
    }
});

test("toolbar의 읽지 않음 필터·접기·오류 복구는 서버 상태를 지우지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `sidebar-toolbar-${Date.now()}` });
    await apiCall("POST", `/sessions/${session.id}/messages`, { text: "읽지 않음 fixture" });
    await login(page);
    const nav = project(page, a.id);
    await openDetails(nav.locator(".sidebar-project-tools"));
    const toolbar = nav.getByRole("toolbar", { name: `${a.name} 도구`, exact: true });
    const clickTool = async (name: string | RegExp) => {
        await openDetails(nav.locator(".sidebar-project-tools"));
        await toolbar.getByRole("button", { name }).click();
    };
    const filter = toolbar.getByRole("button", { name: "읽지 않음만", exact: true });
    await filter.focus();
    await filter.press("End");
    await expect(toolbar.getByRole("button", { name: "목록 새로고침" })).toBeFocused();
    await filter.click();
    await expect(nav.getByLabel("읽지 않음 필터 적용 중")).toBeVisible();
    await expect(row(page, session.id)).toBeVisible();
    await openDetails(row(page, session.id).locator(".sidebar-session-actions"));
    await row(page, session.id).getByRole("button", { name: "읽음 표시" }).click();
    await expect(row(page, session.id)).toHaveCount(0);
    await clickTool("읽지 않음만");
    await expect(row(page, session.id)).toBeVisible();
    await clickTool(/대화 접기/);
    await expect(row(page, session.id)).toBeHidden();
    await clickTool(/대화 펼치기/);
    await expect(row(page, session.id)).toBeVisible();
    await page.route(`**/api/v1/projects/${a.id}/sidebar?*`, (route) => route.fulfill({
        status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "fixture" } }),
    }));
    await clickTool("목록 새로고침");
    await expect(nav.getByRole("alert")).toContainText("대화 목록을 불러오지 못했습니다");
    await expect(row(page, session.id)).toBeVisible();
    await page.unroute(`**/api/v1/projects/${a.id}/sidebar?*`);
    await clickTool("목록 새로고침");
    await expect(nav.getByRole("alert")).toHaveCount(0);
});
