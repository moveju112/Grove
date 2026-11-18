import { expect, test } from "@playwright/test";
import { splitRecentItem, apiCall, composerOption, ensureProfile, ensureProjects, login, script, selectChoice, sessionView, useWorkspaces } from "./helpers";
import { frames } from "./fixture";

async function reply(session: string, profile: string, text: string) {
    await script({ marker: text, frames: frames.text([`답변 ${text}`]) });
    const accepted = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session}/turns`, { text, profile_id: profile, tools: false });
    await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${accepted.turn.id}`)).status).toBe("completed");
    const messages = await apiCall<{ items: { role: string; created_at: string }[] }>("GET", `/sessions/${session}/messages`);
    return messages.items.filter((message) => message.role === "assistant").at(-1)!.created_at;
}

async function sessions() {
    const { a, b } = await ensureProjects();
    const prefix = `recent-navigation-${Date.now()}`;
    const first = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `${prefix} first` });
    const second = await apiCall<{ id: string }>("POST", `/projects/${b.id}/sessions`, { title: `${prefix} second` });
    const profile = await ensureProfile();
    const firstReply = await reply(first.id, profile, `${prefix} first reply`);
    const secondReply = await reply(second.id, profile, `${prefix} second reply`);
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: first.id });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: b.id, resource_id: second.id });
    return { prefix, first, second, profile, firstReply, secondReply, project: a };
}

test("최근 행에는 열기와 x 숨김만 남고 키보드로 숨길 수 있다", async ({ page }) => {
    const { prefix, project } = await sessions();
    await login(page);
    const recent = page.getByRole("region", { name: "최근", exact: true });
    const first = recent.getByTestId("recent-item").filter({ hasText: `${prefix} first` });
    await expect(first.getByRole("button")).toHaveCount(2);
    await expect(first).not.toContainText(project.name);
    await expect(first.getByRole("button").first()).toHaveAttribute("title", new RegExp(project.name));
    await expect(first.getByRole("button", { name: "최근 항목 관리", exact: true })).toHaveCount(0);
    await first.getByRole("button", { name: "최근에서 숨기기", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(first).toHaveCount(0);
    await page.reload();
    await expect(recent.getByTestId("recent-list")).toHaveAttribute("aria-busy", "false");
    await expect(first).toHaveCount(0);
});

test("최근 항목은 다른 pane의 열린 탭으로 이동하고 명시적인 분할만 새 사본을 만든다", async ({ page }) => {
    const { prefix, first, second } = await sessions();
    await login(page);
    const recent = page.getByRole("region", { name: "최근", exact: true });
    const firstItem = recent.getByTestId("recent-item").filter({ hasText: `${prefix} first` });
    const secondItem = recent.getByTestId("recent-item").filter({ hasText: `${prefix} second` });
    const touched = (id: string, seen: boolean) => page.waitForResponse((r) =>
        r.url().endsWith("/api/v1/recent/touch") && r.request().method() === "POST"
        && r.request().postDataJSON().resource_id === id && (r.request().postDataJSON().view_state !== undefined) === seen);
    const firstSeen = touched(first.id, true);
    await firstItem.getByRole("button", { name: new RegExp(`${prefix} first`) }).click();
    await firstSeen;
    const firstView = page.locator(`[data-testid=session-view][data-session="${first.id}"]`);
    const secondView = page.locator(`[data-testid=session-view][data-session="${second.id}"]`);
    await firstView.getByLabel("메시지 입력").fill("first pane draft fixture");
    const secondSeen = touched(second.id, true);
    await splitRecentItem(secondItem);
    await secondSeen;
    await expect(page.getByTestId("pane")).toHaveCount(2);
    await secondView.getByLabel("메시지 입력").fill("second pane draft fixture");
    const access = touched(first.id, false);
    await firstItem.getByRole("button", { name: new RegExp(`${prefix} first`) }).click();
    await access;
    await expect(recent.getByTestId("recent-item").first()).toContainText(`${prefix} second`);
    await expect(firstView).toHaveCount(1);
    await expect(firstView.getByLabel("메시지 입력")).toHaveValue("first pane draft fixture");
    await expect(secondView.getByLabel("메시지 입력")).toHaveValue("second pane draft fixture");
    await expect(page.getByTestId("pane").and(page.locator('[data-focused="true"]')).filter({ visible: true }).filter({ has: firstView })).toHaveCount(1);
    await expect(page.locator('[role="tablist"][aria-label="열린 대화와 화면"] [role="tab"]')).toHaveCount(2);
    await splitRecentItem(firstItem);
    await expect(page.getByTestId("pane")).toHaveCount(3);
    await expect(firstView).toHaveCount(2);
    const copy = page.getByTestId("pane").and(page.locator('[data-focused="true"]')).filter({ visible: true }).getByLabel("메시지 입력");
    await copy.fill("explicit copy draft fixture");
    await firstItem.getByRole("button", { name: new RegExp(`${prefix} first`) }).click();
    await expect(page.getByTestId("pane").and(page.locator('[data-focused="true"]')).filter({ visible: true }).getByLabel("메시지 입력")).toHaveValue("explicit copy draft fixture");
    await expect(firstView).toHaveCount(2);
    await expect(page.locator('[role="tablist"][aria-label="열린 대화와 화면"] [role="tab"]')).toHaveCount(3);
});

test("열기·보내기는 최근 시각을 바꾸지 않고 답변이 도착해야 순서와 표시 시각이 갱신된다", async ({ page }) => {
    const { prefix, first, profile, firstReply, secondReply } = await sessions();
    await login(page);
    const recent = page.getByRole("region", { name: "최근", exact: true });
    const items = recent.getByTestId("recent-item").filter({ hasText: prefix });
    const firstItem = items.filter({ hasText: `${prefix} first` });
    const secondItem = items.filter({ hasText: `${prefix} second` });
    await firstItem.getByRole("button", { name: new RegExp(`${prefix} first`) }).click();
    await expect(firstItem.getByTestId("recent-time").locator("time")).toHaveAttribute("datetime", firstReply);
    await expect(items.first()).toContainText(`${prefix} second`);
    await apiCall("POST", `/sessions/${first.id}/messages`, { text: "답변 없이 메시지만 보냄" });
    await expect(firstItem.getByTestId("recent-time").locator("time")).toHaveAttribute("datetime", firstReply);
    await expect(items.first()).toContainText(`${prefix} second`);

    const view = sessionView(page, first.id);
    await composerOption(view, "모델 프로필", profile);
    await composerOption(view, "보내기 방식", "model");
    const prompt = `${prefix} latest answer`;
    await script({ marker: prompt, frames: frames.text(["새 답변을 받았습니다"]) });
    await view.getByLabel("메시지 입력").fill(prompt);
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("새 답변을 받았습니다");
    const messages = await apiCall<{ items: { role: string; created_at: string }[] }>("GET", `/sessions/${first.id}/messages`);
    const receivedAt = messages.items.filter((message) => message.role === "assistant").at(-1)!.created_at;
    expect(receivedAt).not.toBe(firstReply);
    await expect(items.first()).toContainText(`${prefix} first`);
    await expect(firstItem.getByTestId("recent-time").locator("time")).toHaveAttribute("datetime", receivedAt);
    await expect(secondItem.getByTestId("recent-time").locator("time")).toHaveAttribute("datetime", secondReply);
    await page.reload();
    await expect(firstItem.getByTestId("recent-time").locator("time")).toHaveAttribute("datetime", receivedAt);
    await expect(items.first()).toContainText(`${prefix} first`);
});

test.describe("390px 탐색 더보기", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    for (const theme of ["light", "dark"] as const) {
        test(`${theme}: 최근은 작은 x만 표시하고 세션·프로젝트 메뉴는 동작 명칭을 표시한다`, async ({ page }, info) => {
            await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
            await page.addInitScript((theme) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme })), theme);
            const { prefix, first, project } = await sessions();
            await useWorkspaces(project.id);
            await login(page);
            await page.getByRole("button", { name: "사이드바", exact: true }).click();
            const drawer = page.getByTestId("mobile-drawer-left");
            const row = drawer.getByRole("region", { name: "최근", exact: true }).getByTestId("recent-item").filter({ hasText: `${prefix} first` });
            await expect(row.getByRole("button")).toHaveCount(2);
            await expect(row).not.toContainText(project.name);
            const close = row.getByRole("button", { name: "최근에서 숨기기", exact: true });
            await expect(close).toBeVisible();
            await expect(row.getByTestId("recent-time")).toHaveText("0m");
            const timeBounds = (await row.getByTestId("recent-time").boundingBox())!;
            const closeBounds = (await close.boundingBox())!;
            expect(closeBounds.x - timeBounds.x - timeBounds.width).toBeLessThanOrEqual(1);
            expect(closeBounds.width).toBeLessThanOrEqual(24);
            expect(closeBounds.height).toBe(24);
            expect((await row.getByRole("button").first().boundingBox())!.height).toBe(24);
            expect((await close.locator("svg").boundingBox())!.width).toBe(12);
            await page.screenshot({ path: info.outputPath(`recent-close-${theme}-390.png`), animations: "disabled" });
            const session = drawer.locator(`[data-testid="sidebar-session"][data-session="${first.id}"]`);
            await session.getByRole("button", { name: `${prefix} first 도구`, exact: true }).click();
            const actions = page.getByRole("toolbar", { name: `${prefix} first 도구`, exact: true });
            await expect(actions.getByRole("button", { name: "세션 고정", exact: true })).toContainText("고정");
            await expect(actions.getByRole("button", { name: "읽음 표시", exact: true })).toContainText("읽음 표시");
            await page.screenshot({ path: info.outputPath(`session-menu-${theme}-390.png`), animations: "disabled" });
            await page.keyboard.press("Escape");
            await drawer.getByRole("button", { name: `${project.name} 대화 도구`, exact: true }).click();
            const tools = page.getByRole("toolbar", { name: `${project.name} 도구`, exact: true });
            for (const label of ["읽지 않음만", "목록 새로고침"]) {
                await expect(tools.getByRole("button", { name: label, exact: true })).toContainText(label);
            }
            await expect(tools.getByRole("button", { name: /대화 접기/ })).toContainText("대화 접기");
            await page.screenshot({ path: info.outputPath(`project-menu-${theme}-390.png`), animations: "disabled" });
        });
    }
});
