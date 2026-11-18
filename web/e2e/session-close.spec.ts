import { expect, test } from "@playwright/test";
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
            if (width < 760) {
                await page.getByRole("banner").getByRole("button", { name: "열린 세션", exact: true }).click();
                await page.getByRole("button", { name: `${title} 탭 닫기`, exact: true }).click();
            } else {
                await page.getByRole("tab", { selected: true }).getByRole("button", { name: "탭 닫기", exact: true }).click();
            }
            await expect(view).toHaveCount(0);
            await expect(row).toHaveCount(0);
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
    await apiCall("PUT", `/layouts/${device}`, { expected_revision: 0, layout: {
        schema: 1, focused_leaf: "left", root: { type: "split", direction: "row", ratio: 0.5,
            children: ["left", "right"].map((id) => ({ type: "leaf", id, active_tab: id,
                tabs: [{ id, kind: "session", project_id: a.id, resource_id: session.id, title }] })),
        },
    } });
    await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
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
    await page.route(path, (route) => route.fulfill({
        status: 409, json: { error: { code: "fixture_close", message: "최근 숨김 시험 오류", retryable: false } },
    }));
    await page.getByRole("tab", { selected: true }).getByRole("button", { name: "탭 닫기", exact: true }).click();
    await expect(page.getByTestId("tab-close-error")).toContainText("최근 숨김 시험 오류");
    await expect(view).toBeVisible();
    await expect(row).toHaveCount(1);
    await page.unroute(path);
    await view.getByLabel("메시지 입력").focus();
    await page.keyboard.press("Control+w");
    await expect(view).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await expect(page.getByTestId("tab-close-error")).toHaveCount(0);
});
