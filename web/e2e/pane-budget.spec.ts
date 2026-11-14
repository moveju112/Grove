import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Layout, Node } from "../app/state/layout";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, script, state } from "./helpers";
import { frames } from "./fixture";

// UI-008의 pane당 80행 한도와 서버의 최대 16 pane에서 지킬 브라우저 회귀 예산.
// renderer JS heap만 측정한다. 브라우저 전체 RSS·GPU 메모리와 혼동하지 않는다.
const MAX_HEAP_BYTES = 128 * 1024 * 1024;
const MAX_DOM_NODES_PER_PANE = 2000;
const SHELL_DOM_NODES = 5000;

async function seed(page: Page, count: number, shared = true) {
    const { a } = await ensureProjects();
    const title = `pane-budget-${randomUUID()}`;
    const sessions: { id: string }[] = [];
    for (let index = 0; index < (shared ? 1 : count); index++) {
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `${title}-${index}` });
        sessions.push(session);
        for (let i = 0; i < 100; i++) await apiCall("POST", `/sessions/${session.id}/messages`, { text: `budget row ${i}\n${"fixture text ".repeat(20)}` });
    }
    const tree = (start: number, size: number, depth = 0): Node => size === 1 ? {
        type: "leaf", id: `pane-${start}`, active_tab: `tab-${start}`, tabs: [
            { id: `tab-${start}`, kind: "session", project_id: a.id, resource_id: sessions[shared ? 0 : start]!.id, title },
        ],
    } : {
        type: "split", direction: depth % 2 ? "column" : "row", ratio: 0.5,
        children: [tree(start, size / 2, depth + 1), tree(start + size / 2, size / 2, depth + 1)],
    };
    const device = `budget-${randomUUID()}`;
    const layout: Layout = { schema: 1, focused_leaf: "pane-0", root: tree(0, count) };
    await apiCall("PUT", `/layouts/${device}`, { expected_revision: 0, layout });
    await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
    return { session: sessions[0]!, sessions, title };
}

async function checkBudget(page: Page, count: number, shared: boolean) {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const { sessions } = await seed(page, count, shared);
    const ids = sessions.map((session) => session.id).sort();
    const active = new Set<import("@playwright/test").Request>();
    let messageReads = 0;
    const sets: string[][] = [];
    page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === "/api/v1/events") {
            active.add(request);
            sets.push((url.searchParams.get("sessions") ?? "").split(",").filter(Boolean));
        }
        if (ids.some((id) => url.pathname === `/api/v1/sessions/${id}/messages`)) messageReads++;
    });
    page.on("requestfinished", (request) => active.delete(request));
    page.on("requestfailed", (request) => active.delete(request));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await login(page);
    await expect(page.getByTestId("pane")).toHaveCount(count);
    await expect(page.getByTestId("session-view")).toHaveCount(count);
    for (const view of await page.getByTestId("session-view").all())
        await expect(view.getByText("budget row 99", { exact: false })).toBeInViewport();
    await expect.poll(() => active.size).toBe(1);
    expect(sets.at(-1)).toEqual(ids);
    // 최초 조회와 cursor 없는 첫 hello의 snapshot 재동기화만 허용한다. pane 수만큼 늘어나면 실패한다.
    expect(messageReads).toBeGreaterThanOrEqual(ids.length);
    expect(messageReads).toBeLessThanOrEqual(2 * ids.length);
    const rows = await page.locator(".msg-row").count();
    expect(rows).toBeLessThan(80 * count);
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const dom = await cdp.send("Memory.getDOMCounters");
    const performance = await cdp.send("Performance.getMetrics");
    const metrics = Object.fromEntries(performance.metrics.map((m) => [m.name, m.value]));
    console.info("pane budget", {
        panes: count, sessions: ids.length, connections: active.size, messageReads, renderedRows: rows,
        heapMiB: +(heap.usedSize / 1024 / 1024).toFixed(2), domNodes: dom.nodes,
        layoutCount: metrics.LayoutCount, scriptSeconds: metrics.ScriptDuration,
    });
    expect(heap.usedSize).toBeLessThan(MAX_HEAP_BYTES);
    expect(dom.nodes).toBeLessThan(SHELL_DOM_NODES + MAX_DOM_NODES_PER_PANE * count);
}

for (const count of [1, 4, 16]) test(`${count} pane·같은 대화의 조회·stream·DOM·JS heap은 예산 안에 머문다`, async ({ page }) => checkBudget(page, count, true));
test("16 pane·서로 다른 대화의 조회·stream·DOM·JS heap은 예산 안에 머문다", async ({ page }) => checkBudget(page, 16, false));

test("메시지가 세션 정보보다 먼저 도착해도 초기 위치와 스크롤 기록을 연결한다", async ({ page }) => {
    const { session } = await seed(page, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/v1/sessions/${session.id}`, async (route) => { await gate; await route.continue(); });
    const messages = page.waitForResponse((response) => response.url().includes(`/sessions/${session.id}/messages?`));
    try {
        await login(page);
        await messages;
        await expect(page.getByTestId("session-view")).toHaveCount(0);
        release();
        const view = page.getByTestId("session-view");
        await expect(view.getByText("budget row 99", { exact: false })).toBeInViewport();
        await view.getByRole("feed").focus();
        await page.keyboard.press("Home");
        await expect(view.locator('[data-virtual-seq="1"]')).toBeInViewport();
        await expect.poll(() => page.evaluate(() => {
            const copy = JSON.parse(sessionStorage.getItem("grove.scroll.tab-0") ?? "null");
            return copy && { anchorSeq: copy.anchorSeq, atBottom: copy.atBottom };
        })).toEqual({ anchorSeq: 1, atBottom: false });
    } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
});

test("숨긴 pane은 중간 응답을 렌더링하지 않아도 실행을 유지하고 복원 시 현재 snapshot을 표시한다", async ({ page }) => {
    const { session, title } = await seed(page, 4);
    await ensureProfile();
    await login(page);
    const first = page.locator('[data-leaf="pane-0"]');
    await expect(first.getByLabel("메시지 입력")).toBeEnabled();
    await script({ marker: title, frames: [frames.text(["pane stream fixture"])[0]!], hang: true });
    await composerOption(first, "보내기 방식", "model");
    await first.getByLabel("메시지 입력").fill(title);
    await first.getByRole("button", { name: "보내기", exact: true }).click();
    try {
        await expect(first.getByTestId("partial")).toContainText("pane stream fixture");
        await first.getByRole("button", { name: "영역 전체 보기", exact: true }).click();
        const hidden = page.locator('[data-testid="pane"]').filter({ hasNot: page.locator('[aria-label="분할 복원"]') });
        await expect(hidden).toHaveCount(3);
        await expect(hidden.getByTestId("partial")).toHaveCount(0);
        const turns = await apiCall<{ status: string }[]>("GET", `/sessions/${session.id}/turns?limit=5`);
        expect(turns).toHaveLength(1);
        expect(turns[0]?.status).toBe("running");
        await first.getByRole("button", { name: "분할 복원", exact: true }).click();
        for (const view of await page.getByTestId("session-view").all())
            await expect(view.getByTestId("partial")).toContainText("pane stream fixture");
        const requests = await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json() as { messages: unknown[] }[];
        expect(requests.filter((r) => JSON.stringify(r.messages).includes(title))).toHaveLength(1);
    } finally {
        const turns = await apiCall<{ id: string; status: string }[]>("GET", `/sessions/${session.id}/turns?limit=5`);
        for (const turn of turns) if (turn.status === "running") await apiCall("POST", `/turns/${turn.id}/cancel`, {});
    }
});
