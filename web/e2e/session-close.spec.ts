import { expect, test } from "@playwright/test";
import type { Layout } from "../app/state/layout";
import { projectLayoutKey } from "../app/state/projectLayout";
import { workspaceTabs, workspaceTabsKey } from "../app/state/workspaceTabs";
import { randomUUID } from "node:crypto";
import { apiCall, ensureProfile, ensureProjects, login, sessionView, useWorkspaces } from "./helpers";

for (const width of [390, 1400]) {
    test.describe(`${width}px 세션 닫기`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: "reduce" });

        test("탭을 닫으면 고정된 최근 항목도 숨기고 기록은 보존하며 다시 열면 표시한다", async ({ page }, info) => {
            const { a } = await ensureProjects();
            await useWorkspaces(a.id);
            await ensureProfile();
            const title = `close-session-${randomUUID()}`;
            const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
            await apiCall("POST", `/sessions/${session.id}/messages`, { text: "닫아도 남을 대화" });
            const item = await apiCall<{ id: string; revision: number }>("POST", "/recent/touch", {
                kind: "session", project_id: a.id, resource_id: session.id,
            });
            await apiCall("PATCH", `/recent/${item.id}`, { expected_revision: item.revision, pinned: true });
            const destructive: string[] = [];
            page.on("request", (request) => {
                if (request.method() === "DELETE" || /\/(?:cancel|archive|terminate)$/.test(new URL(request.url()).pathname))
                    destructive.push(request.url());
            });
            await login(page);
            if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            const recent = page.getByRole("region", { name: "최근", exact: true });
            const row = recent.getByTestId("recent-item").filter({ hasText: title });
            await row.getByRole("button", { name: new RegExp(title) }).click();
            const view = sessionView(page, session.id);
            await expect(view).toBeVisible();
            let release!: () => void;
            const held = new Promise<void>(resolve => { release = resolve; });
            const patchUrl = `**/api/v1/recent/${item.id}`;
            await page.route(patchUrl, async route => { await held; await route.continue(); });
            const confirmed = page.waitForResponse(response => response.url().endsWith(`/recent/${item.id}`) && response.ok());
            if (width < 760) {
                await page.getByRole("banner").getByRole("button", { name: "열린 세션", exact: true }).click();
                await page.getByRole("button", { name: `${title} 탭 닫기`, exact: true }).click();
            } else {
                await page.getByRole("tab", { selected: true }).getByRole("button", { name: "탭 닫기", exact: true }).click();
            }
            await expect(view).toHaveCount(0);
            await expect(row).toHaveCount(0);
            release();
            await confirmed;
            // 닫기 전에 시작한 읽음 갱신이 늦게 도착해도 다시 표시하지 않는다.
            await apiCall("POST", "/recent/touch", {
                kind: "session", project_id: a.id, resource_id: session.id, reopen: false, view_state: { last_seen_seq: 1 },
            });
            const hidden = await apiCall<{ items: { id: string; hidden: boolean; pinned: boolean }[] }>("GET", "/recent?filter=hidden&limit=200");
            expect(hidden.items.find((entry) => entry.id === item.id)).toMatchObject({ hidden: true, pinned: true });
            if (width < 760) {
                await page.getByRole("button", { name: "열린 세션 닫기", exact: true }).click();
                await page.getByRole("button", { name: "사이드바", exact: true }).click();
            }
            await page.screenshot({ path: info.outputPath(`session-closed-${width}.png`) });
            await page.reload();
            if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await expect(row).toHaveCount(0);
            const saved = await apiCall<{ archived_at: string | null }>("GET", `/sessions/${session.id}`);
            expect(saved.archived_at).toBeNull();
            await page.locator(`[data-testid="sidebar-session"][data-session="${session.id}"]`).getByTestId("sidebar-session-open").click();
            await expect(view).toBeVisible();
            await expect(view).toContainText("닫아도 남을 대화");
            if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await expect(row).toHaveCount(1);
            expect(destructive).toEqual([]);
        });
    });
}

test("같은 세션의 마지막 분할 탭을 닫을 때만 최근에서 숨긴다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `close-copy-${randomUUID()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    const device = `close-copy-${randomUUID()}`;
    const leaf = (id: string): Layout["root"] => ({ type: "leaf", id, active_tab: id,
        tabs: [{ id, kind: "session", project_id: a.id, resource_id: session.id, title }] });
    const layout: Layout = { schema: 1, focused_leaf: "left", root: {
        type: "split", direction: "row", ratio: 0.5, children: [leaf("left"), leaf("right")],
    } };
    await apiCall("PUT", `/layouts/${projectLayoutKey(device, a.id)}`, { expected_revision: 0, layout });
    const shared = `/layouts/${workspaceTabsKey(a.id)}`;
    const { revision } = await apiCall<{ revision: number }>("GET", shared);
    await apiCall("PUT", shared, { expected_revision: revision, layout: workspaceTabs(layout) });
    await page.addInitScript(({ device, project }) => {
        localStorage.setItem("grove.device.id", device);
        localStorage.setItem(`grove.layout.selected.${device}`, project);
    }, { device, project: a.id });
    await login(page);
    const views = sessionView(page, session.id);
    const row = page.getByRole("region", { name: "최근", exact: true }).getByTestId("recent-item").filter({ hasText: title });
    await expect(views).toHaveCount(2);
    await page.locator('[data-leaf="left"]').getByRole("button", { name: "탭 닫기", exact: true }).click();
    await expect(views).toHaveCount(1);
    await expect(row).toHaveCount(1);
    await page.locator('[data-leaf="right"]').getByRole("button", { name: "탭 닫기", exact: true }).click();
    await expect(views).toHaveCount(0);
    await expect(row).toHaveCount(0);
});

test("최근 숨김이 실패하면 세션 탭을 유지하고 닫기 단축키로 재시도한다", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `close-retry-${randomUUID()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    const item = await apiCall<{ id: string }>("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    const row = page.getByRole("region", { name: "최근", exact: true }).getByTestId("recent-item").filter({ hasText: title });
    await row.getByRole("button", { name: new RegExp(title) }).click();
    const view = sessionView(page, session.id);
    await expect(view).toBeVisible();
    const path = `**/api/v1/recent/${item.id}`;
    await view.getByLabel("메시지 입력").fill("복원할 초안");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(path, async route => {
        await held;
        await route.fulfill({ status: 409, json: { error: { code: "fixture_close", message: "최근 숨김 시험 오류", retryable: false } } });
    });
    await page.getByRole("tab", { selected: true }).getByRole("button", { name: "탭 닫기", exact: true }).click();
    await expect(view).toHaveCount(0);
    await expect(row).toHaveCount(0);
    release();
    await expect(page.getByTestId("tab-close-error")).toContainText("최근 숨김 시험 오류");
    await expect(view).toBeVisible();
    await expect(row).toHaveCount(1);
    await expect(view.getByLabel("메시지 입력")).toHaveValue("복원할 초안");
    await page.unroute(path);
    await view.getByLabel("메시지 입력").focus();
    await page.keyboard.press("Control+w");
    await expect(view).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await expect(page.getByTestId("tab-close-error")).toHaveCount(0);
});

test("닫기 응답 전에 다른 대화로 이동하면 실패 복원도 그 선택을 유지한다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const make = async () => {
        const title = `close-focus-${randomUUID()}`;
        const { id } = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
        const recent = await apiCall<{ id: string }>("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: id });
        return { id, title, recent };
    };
    const first = await make(), second = await make();
    await login(page);
    const list = page.getByRole("region", { name: "최근", exact: true });
    await list.getByRole("button", { name: first.title, exact: true }).click();
    await expect(sessionView(page, first.id)).toBeVisible();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/v1/recent/${first.recent.id}`, async route => {
        await held;
        await route.fulfill({ status: 403, json: { error: { code: "forbidden", message: "닫기 권한이 없어요." } } });
    });
    try {
        await page.getByRole("tab", { selected: true }).getByRole("button", { name: "탭 닫기" }).click();
        await list.getByRole("button", { name: second.title, exact: true }).click();
        await sessionView(page, second.id).getByLabel("메시지 입력").fill("다른 탭에서 계속 작성");
    } finally { release(); }
    await expect(page.getByTestId("tab-close-error")).toContainText("닫기 권한이 없어요.");
    await expect(page.getByRole("tab", { selected: true })).toContainText(second.title);
    await expect(sessionView(page, second.id).getByLabel("메시지 입력")).toBeFocused();
    await expect(page.getByRole("tab", { selected: false }).filter({ hasText: first.title })).toBeVisible();
});

test("닫는 중 다시 연 세션은 이전 닫기가 성공해도 열려 있고 최근에 남는다", async ({ page }) => {
    const { a } = await ensureProjects();
    await useWorkspaces(a.id);
    await ensureProfile();
    const title = `close-reopen-${randomUUID()}`;
    const { id } = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    const recent = await apiCall<{ id: string }>("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: id });
    await login(page);
    const list = page.getByRole("region", { name: "최근", exact: true });
    await list.getByRole("button", { name: title, exact: true }).click();
    const view = sessionView(page, id);
    await expect(view).toBeVisible();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const path = `**/api/v1/recent/${recent.id}`;
    await page.route(path, async route => { await held; await route.continue(); });
    const started = page.waitForRequest(request => request.method() === "PATCH" && request.url().endsWith(`/recent/${recent.id}`));
    await page.getByRole("tab", { selected: true }).getByRole("button", { name: "탭 닫기" }).click();
    await started;
    await expect(view).toHaveCount(0);
    const reopened = page.waitForResponse(response => response.ok() && response.url().endsWith("/recent/touch")
        && response.request().postDataJSON().resource_id === id && response.request().postDataJSON().reopen !== false);
    try {
        await page.locator(`[data-testid="sidebar-session"][data-session="${id}"]`).getByTestId("sidebar-session-open").click();
        await expect(view).toBeVisible();
    } finally { release(); }
    await reopened;
    await expect(view).toBeVisible();
    await expect(list.getByRole("button", { name: title, exact: true })).toBeVisible();
    expect((await apiCall<{ items: { id: string }[] }>("GET", "/recent?filter=hidden&limit=200")).items.some(it => it.id === recent.id)).toBe(false);
});
