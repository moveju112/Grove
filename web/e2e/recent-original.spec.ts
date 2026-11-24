import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiCall, ensureProfile, ensureProjects, login, openDetails } from "./helpers";
import type { Layout } from "../app/state/layout";
import { projectLayoutKey } from "../app/state/projectLayout";
import { workspaceTabs, workspaceTabsKey } from "../app/state/workspaceTabs";

// RECENT-001: 원본 최근 탭의 시간 범위·숨김 후 재표시·분할 묶음·경과 시간 흐름을 유지한다.
test("시간 범위 밖 항목은 기본 4시간에서 빠지고 넓은 범위·고정에서는 보이며 선택을 기억한다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const old = await apiCall<{ id: string; title: string }>("POST", `/projects/${a.id}/sessions`, { title: `range-old-${randomUUID()}` });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: old.id });
    // 이 기기 시계를 5시간 뒤로 두면 방금 연 항목은 4시간 범위 밖, 12시간 범위 안이다.
    await page.clock.install({ time: new Date(Date.now() + 5 * 3_600_000) });
    const wide = (url: URL) => url.pathname === "/api/v1/recent" && !!url.searchParams.get("since")
        && Date.parse(url.searchParams.get("since")!) < Date.now() - 6 * 3_600_000;
    const warmed = page.waitForResponse(response => response.ok() && wide(new URL(response.url())));
    await login(page);
    const recent = page.getByRole("region", { name: "최근", exact: true });
    const ranges = recent.getByRole("group", { name: "시간 범위" });
    await expect(ranges.getByRole("button", { name: "최근 전체 범위" })).toHaveCount(0);
    await expect(ranges.getByRole("button", { name: "최근 4시간 범위" })).toHaveAttribute("aria-pressed", "true");
    const row = recent.getByTestId("recent-item").filter({ hasText: old.title });
    await expect(row).toHaveCount(0);
    await (await warmed).finished();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(wide, async route => { await held; await route.continue(); });
    try {
        await ranges.getByRole("button", { name: "최근 12시간 범위" }).click();
        await expect(row).toHaveCount(1);
    } finally { release(); }
    await page.unroute(wide);
    await expect(row.getByTestId("recent-time")).toHaveText("5h");
    await page.reload();
    await expect(recent.getByRole("group", { name: "시간 범위" }).getByRole("button", { name: "최근 12시간 범위" })).toHaveAttribute("aria-pressed", "true");
    await expect(row).toHaveCount(1);
    // 고정 항목은 범위와 무관하게 보인다.
    const pinned = (await apiCall<{ items: { id: string; revision: number; resource_id: string }[] }>("GET", "/recent?filter=all&limit=200")).items.find((item) => item.resource_id === old.id)!;
    const updated = await apiCall<{ revision: number }>("PATCH", `/recent/${pinned.id}`, { expected_revision: pinned.revision, pinned: true });
    await ranges.getByRole("button", { name: "최근 30분 범위" }).click();
    await expect(row).toHaveCount(1);
    await apiCall("PATCH", `/recent/${pinned.id}`, { expected_revision: updated.revision, pinned: false });
    await expect(row).toHaveCount(0);
    await ranges.getByRole("button", { name: "최근 12시간 범위" }).click();
    await expect(row).toHaveCount(1);
});

test("모바일에서 기존 전체 선택은 4시간으로 돌아오고 시간 범위만 보인다", async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("grove.device.prefs", JSON.stringify({ recentWindow: "all" })));
    await login(page);
    await page.getByRole("button", { name: "사이드바", exact: true }).click();
    const ranges = page.getByRole("region", { name: "최근", exact: true }).getByRole("group", { name: "시간 범위" });
    await expect(ranges.getByRole("button")).toHaveCount(3);
    await expect(ranges.getByRole("button", { name: "최근 전체 범위" })).toHaveCount(0);
    await expect(ranges.getByRole("button", { name: "최근 4시간 범위" })).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: info.outputPath("recent-mobile.png"), animations: "disabled" });
});

test("다른 기기가 먼저 고정해도 이 기기의 숨김은 오류 없이 그 필드만 다시 적용하고 고정을 유지한다(RECENT-006)", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const s = await apiCall<{ id: string; title: string }>("POST", `/projects/${a.id}/sessions`, { title: `devices-${randomUUID()}` });
    const touched = await apiCall<{ id: string; revision: number }>("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    const recent = page.getByRole("region", { name: "최근", exact: true });
    const row = recent.getByTestId("recent-item").filter({ hasText: s.title });
    await expect(row).toHaveCount(1);
    const sent: unknown[] = [];
    await page.route(`**/api/v1/recent/${touched.id}`, async (route) => {
        sent.push(route.request().postDataJSON());
        // 이 기기의 첫 요청이 서버에 닿기 직전에 다른 기기가 고정한다.
        if (sent.length === 1) {
            const current = (await apiCall<{ items: { id: string; revision: number }[] }>("GET", "/recent?limit=200&filter=all")).items.find((i) => i.id === touched.id)!;
            await apiCall("PATCH", `/recent/${touched.id}`, { expected_revision: current.revision, pinned: true });
        }
        await route.continue();
    });
    const hiddenOnServer = page.waitForResponse(response => response.request().method() === "PATCH"
        && new URL(response.url()).pathname.startsWith("/api/v1/recent/") && response.ok());
    await row.getByRole("button", { name: "최근에서 숨기기", exact: true }).click();
    await expect(row).toHaveCount(0);
    await hiddenOnServer;
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ hidden: true });
    expect(sent[1]).not.toHaveProperty("pinned");
    await expect(recent.getByRole("alert")).toHaveCount(0);
    const hidden = (await apiCall<{ items: { id: string; pinned: boolean; hidden: boolean }[] }>("GET", "/recent?limit=200&filter=hidden")).items.find((i) => i.id === touched.id)!;
    expect(hidden).toMatchObject({ pinned: true, hidden: true });
});

for (const theme of ["light", "dark", "soft"] as const) {
test(`${theme}: 숨긴 대화는 새 메시지로 복원하고 분할 묶음에는 파란 왼쪽 선만 남긴다`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: theme === "dark" ? "dark" : "light", reducedMotion: "reduce" });
    await page.addInitScript((theme) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme })), theme);
    const { a, b } = await ensureProjects();
    await ensureProfile();
    const make = async (title: string) => {
        const s = await apiCall<{ id: string; title: string }>("POST", `/projects/${a.id}/sessions`, { title });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
        return s;
    };
    const one = await make(`linked-one-${randomUUID()}`);
    const two = await make(`linked-two-${randomUUID()}`);
    const hidden = await make(`revive-${randomUUID()}`);
    const outside = await apiCall<{ id: string; title: string }>("POST", `/projects/${b.id}/sessions`, { title: `outside-${randomUUID()}` });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: b.id, resource_id: outside.id });
    const device = `recent-${randomUUID()}`;
    const layout: Layout = { schema: 1, focused_leaf: "l", root: { type: "split", direction: "row", ratio: 0.5, children: [
        { type: "leaf", id: "l", active_tab: "t1", tabs: [{ id: "t1", kind: "session", project_id: a.id, resource_id: one.id, title: one.title }] },
        { type: "leaf", id: "r", active_tab: "t2", tabs: [{ id: "t2", kind: "session", project_id: a.id, resource_id: two.id, title: two.title }] },
    ] } };
    await apiCall("PUT", `/layouts/${projectLayoutKey(device, a.id)}`, { expected_revision: 0, layout });
    const sharedPath = `/layouts/${workspaceTabsKey(a.id)}`;
    const shared = await apiCall<{ revision: number }>("GET", sharedPath);
    await apiCall("PUT", sharedPath, { expected_revision: shared.revision, layout: workspaceTabs(layout) });
    await page.addInitScript(({ device, project }) => {
        localStorage.setItem("grove.device.id", device);
        const key = `grove.layout.selected.${device}`;
        if (!localStorage.getItem(key)) localStorage.setItem(key, project);
    }, { device, project: a.id });
    await login(page);
    const recent = page.getByRole("region", { name: "최근", exact: true });
    const group = recent.getByTestId("recent-split-group");
    await expect(group.getByTestId("recent-item")).toHaveCount(2);
    await expect(group).toContainText(one.title);
    await expect(group).toContainText(two.title);
    const row = recent.getByTestId("recent-item").filter({ hasText: hidden.title });
    await expect(row).toBeVisible();
    const titleStart = (id: string) => recent.locator(`[data-testid="recent-item"][data-session="${id}"]`)
        .locator("[data-grove-button-content]").evaluate((node) => node.getBoundingClientRect().x);
    expect(await titleStart(one.id)).toBe(await titleStart(hidden.id));
    const colors = await group.getByTestId("recent-split-surface").evaluate((node) => {
        const context = document.createElement("canvas").getContext("2d")!;
        const rgb = (color: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const line = getComputedStyle(node, "::after");
        const lineColor = rgb(line.borderInlineStartColor);
        return {
            background: getComputedStyle(node).backgroundColor,
            blue: lineColor[2]! > lineColor[0]!,
            border: parseFloat(line.borderInlineStartWidth),
        };
    });
    expect(colors.background).toBe("rgba(0, 0, 0, 0)");
    expect(colors.blue).toBe(true);
    expect(colors.border).toBeGreaterThanOrEqual(3);
    await page.screenshot({ path: info.outputPath(`recent-split-${theme}.png`) });

    const rightPane = page.locator('[data-leaf="r"]');
    await rightPane.getByRole("button", { name: "새 대화 탭", exact: true }).click();
    await expect(rightPane.getByRole("tab", { selected: true })).toContainText("새 대화");
    await expect(group.getByTestId("recent-item")).toHaveCount(2);
    await expect(group).toContainText(one.title);
    await expect(group).toContainText(two.title);
    await rightPane.getByTestId("tab-title").filter({ hasText: two.title }).click();
    await expect(group.getByTestId("recent-item")).toHaveCount(2);

    if (theme === "dark") {
        const outsideRow = recent.getByTestId("recent-item").filter({ hasText: outside.title });
        await outsideRow.getByRole("button", { name: outside.title, exact: true }).click();
        await expect(page.getByTestId("session-view").filter({ visible: true })).toHaveAttribute("data-session", outside.id);
        await expect(rightPane).toBeHidden();
        await expect(group.getByTestId("recent-item")).toHaveCount(2);
        await expect(group).not.toContainText(outside.title);
        // 다른 프로젝트에서 다시 열어도 로컬에 저장된 이전 분할을 읽는다.
        await expect.poll(async () => {
            const resume = await apiCall<{ layout: Layout | null }>("GET", "/layouts/workspace-resume");
            return resume.layout?.root.type === "leaf" ? resume.layout.root.tabs[0]?.project_id : undefined;
        }).toBe(b.id);
        await page.reload();
        await expect(page.getByTestId("session-view").filter({ visible: true })).toHaveAttribute("data-session", outside.id);
        await expect(rightPane).toHaveCount(0);
        await expect(group.getByTestId("recent-item")).toHaveCount(2);
        await group.locator(`[data-testid="recent-item"][data-session="${two.id}"]`).getByRole("button", { name: new RegExp(two.title) }).click();
        await expect(rightPane).toBeVisible();
    }

    const hiddenOnServer = page.waitForResponse(response => response.request().method() === "PATCH"
        && new URL(response.url()).pathname.startsWith("/api/v1/recent/") && response.ok());
    await row.getByRole("button", { name: "최근에서 숨기기", exact: true }).click();
    await expect(row).toHaveCount(0);
    await hiddenOnServer;
    await apiCall("POST", `/sessions/${hidden.id}/messages`, { text: "다시 보여 줘" });
    await expect(row).toHaveCount(1);
    const leftPane = page.locator('[data-leaf="l"]');
    while (await rightPane.getByTestId("tab-title").count()) {
        const count = await rightPane.getByTestId("tab-title").count();
        await rightPane.getByTestId("tab-title").first().dragTo(leftPane.getByTestId("tab-title").first());
        await expect(rightPane.getByTestId("tab-title")).toHaveCount(count - 1);
    }
    await expect(group).toHaveCount(0);
    await expect(recent.getByTestId("recent-item").filter({ hasText: one.title })).toHaveCount(1);
    await expect(recent.getByTestId("recent-item").filter({ hasText: two.title })).toHaveCount(1);
});
}
