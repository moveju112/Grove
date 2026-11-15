import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Layout } from "../app/state/layout";
import { frames } from "./fixture";
import { activateMobileTab, apiCall, closeMobileSidebar, ensureProfile, ensureProjects, login, script } from "./helpers";

async function setup(page: Page) {
    const { a, b } = await ensureProjects();
    const device = `nav-${randomUUID()}`;
    const title = `동일 제목 ${device}`;
    const left = await apiCall<{ id: string; title: string }>("POST", `/projects/${a.id}/sessions`, { title });
    const right = await apiCall<{ id: string; title: string }>("POST", `/projects/${b.id}/sessions`, { title });
    const layout: Layout = { schema: 1, focused_leaf: "left", root: {
        type: "split", direction: "row", ratio: 0.6, children: [
            { type: "leaf", id: "left", active_tab: "left-session", tabs: [
                { id: "left-session", kind: "session", project_id: a.id, resource_id: left.id, title: "이전 제목" },
                { id: "left-project", kind: "project", project_id: a.id, resource_id: a.id, title: a.name },
            ] },
            { type: "leaf", id: "right", active_tab: "right-session", tabs: [
                { id: "right-session", kind: "session", project_id: b.id, resource_id: right.id, title: "이전 제목" },
            ] },
        ],
    } };
    await apiCall("PUT", `/layouts/${device}`, { expected_revision: 0, layout });
    const narrow = structuredClone(layout);
    if (narrow.root.type === "split") for (const leaf of narrow.root.children) {
        if (leaf.type !== "leaf") continue;
        leaf.tabs.forEach((tab) => { tab.id += "-narrow"; });
        leaf.active_tab += "-narrow";
    }
    await apiCall("PUT", `/layouts/${device}-narrow`, { expected_revision: 0, layout: narrow });
    await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
    return { a, b, left, right, title };
}

test("현재 위치 설명은 호버로 표시하고 조작·배치를 늘리지 않은 채 Escape로 닫는다", async ({ page }) => {
    const { left } = await setup(page);
    await login(page);
    const nav = page.getByRole("navigation", { name: "현재 위치", exact: true });
    await expect(nav).toHaveAttribute("data-session-id", left.id);
    const current = nav.locator('[aria-current="page"]');
    const before = await current.boundingBox();
    const actions = await nav.getByRole("button").count();
    await current.hover();
    const tip = page.getByRole("tooltip");
    await expect(tip).toContainText(left.id);
    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
    expect(await current.boundingBox()).toEqual(before);
    await expect(nav.getByRole("button")).toHaveCount(actions);
});

test("실제 pane·탭의 부모 탐색은 다른 pane·초안·진행 중 작업을 유지하고 세션을 만들지 않는다", async ({ page }) => {
    const { a, b, left, right, title } = await setup(page);
    const profile = await ensureProfile();
    await login(page);
    const nav = page.getByRole("navigation", { name: "현재 위치", exact: true });
    const leftPane = page.locator('[data-layout-mode="wide"] [data-leaf="left"]');
    const rightPane = page.locator('[data-layout-mode="wide"] [data-leaf="right"]');
    await expect(nav).toHaveAttribute("data-session-id", left.id);
    await expect(nav.locator('[aria-current="page"]')).toContainText(title);
    await expect(nav).toHaveAttribute("data-project-id", a.id);
    await leftPane.getByLabel("메시지 입력").fill("왼쪽 초안");
    await rightPane.getByLabel("메시지 입력").fill("오른쪽 초안");
    await expect(nav).toHaveAttribute("data-project-id", b.id);
    await expect(nav).toHaveAttribute("data-session-id", right.id);
    // 키보드 포커스만 옮겨도 현재 위치는 해당 pane을 따른다.
    await leftPane.getByLabel("메시지 입력").focus();
    await expect(nav).toHaveAttribute("data-session-id", left.id);
    await script({ marker: title, frames: frames.tool("navigation-work", "shell", { command: "printf 'navigation fixture\\n'" }) });
    const accepted = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${left.id}/turns`,
        { text: title, profile_id: profile, tools: true });
    try {
        await expect(leftPane.getByTestId("approval")).toBeVisible();
        const rightInput = await rightPane.getByLabel("메시지 입력").elementHandle();
        const tabs = await page.getByRole("tablist").getByRole("tab").count();
        const mutations: string[] = [];
        page.on("request", (request) => {
            if (request.method() !== "GET" && /\/(?:sessions|turns)(?:\/[^/?]+)?(?:\/cancel)?$/.test(request.url())) {
                mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
            }
        });
        // native 버튼의 키보드 활성화로 이미 열린 프로젝트 탭을 재사용한다.
        const parent = nav.getByRole("button", { name: `프로젝트: ${a.name} (${a.id}) 대화 목록으로`, exact: true });
        await parent.focus();
        await parent.press("Enter");
        await expect(nav.locator('[aria-current="page"]')).toHaveText(a.name);
        await expect(nav).not.toHaveAttribute("data-session-id");
        await expect(page.getByRole("tablist").getByRole("tab")).toHaveCount(tabs);
        await expect(rightPane.getByLabel("메시지 입력")).toHaveValue("오른쪽 초안");
        expect(await rightInput!.evaluate((node) => node.isConnected)).toBe(true);
        expect((await apiCall<{ status: string }>("GET", `/turns/${accepted.turn.id}`)).status).toBe("awaiting_approval");
        await leftPane.getByRole("tab").filter({ hasText: "이전 제목" }).getByRole("button").first().click();
        await expect(nav).toHaveAttribute("data-session-id", left.id);
        await expect(leftPane.getByLabel("메시지 입력")).toHaveValue("왼쪽 초안");
        await expect(leftPane.getByTestId("approval")).toBeVisible();
        await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
        await expect(nav.locator('[aria-current="page"]')).toHaveText("설정");
        await expect(nav).not.toHaveAttribute("data-project-id");
        await expect(nav).not.toHaveAttribute("data-session-id");
        // 프로젝트 탐색은 기존 sidebar만 열고 현재 작업을 바꾸지 않는다.
        await nav.getByRole("button", { name: "프로젝트 탐색", exact: true }).click();
        await expect(page.getByRole("button", { name: "사이드바", exact: true })).toHaveAttribute("aria-expanded", "true");
        await expect(nav.locator('[aria-current="page"]')).toHaveText("설정");
        expect(mutations).toEqual([]);
    } finally {
        await apiCall("POST", `/turns/${accepted.turn.id}/cancel`, {});
    }
});

test("다른 프로젝트로 이동한 뒤 도착한 세션 응답은 현재 위치를 되돌리지 않는다", async ({ page }) => {
    const { b, left, right } = await setup(page);
    let release!: () => void;
    let fetched!: () => void;
    const ready = new Promise<void>((resolve) => { fetched = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/v1/sessions/${left.id}`, async (route) => {
        const response = await route.fetch();
        fetched();
        await gate;
        await route.fulfill({ response });
    });
    try {
        await login(page);
        await ready;
        const nav = page.getByRole("navigation", { name: "현재 위치", exact: true });
        await page.locator('[data-layout-mode="wide"] [data-leaf="right"]').getByLabel("메시지 입력").focus();
        await expect(nav).toHaveAttribute("data-session-id", right.id);
        release();
        await expect(page.locator(`[data-session="${left.id}"][data-testid="session-view"]`)).toBeVisible();
        await expect(nav).toHaveAttribute("data-project-id", b.id);
        await expect(nav).toHaveAttribute("data-session-id", right.id);
    } finally {
        release();
    }
});

test("긴 이름·좁은 화면에서도 한 줄 위치·부모 탐색·폭별 초안과 숨긴 pane을 보존한다", async ({ page }) => {
    const { a, left, right } = await setup(page);
    const current = await apiCall<{ revision: number }>("GET", `/sessions/${left.id}`);
    const longTitle = "아주 긴 현재 세션 이름 ".repeat(12).trim();
    await apiCall("PATCH", `/sessions/${left.id}`, { expected_revision: current.revision, title: longTitle });
    await login(page);
    const wideInput = page.locator('[data-layout-mode="wide"] [data-leaf="left"]').getByLabel("메시지 입력").filter({ visible: true });
    await wideInput.fill("넓은 화면 초안");
    const wideNode = await wideInput.elementHandle();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-layout-mode="narrow"]')).toBeVisible();
    // 기존 sidebar가 열려 있으면 기존 toggle로 닫는다.
    await closeMobileSidebar(page);
    const nav = page.getByRole("navigation", { name: "현재 위치", exact: true });
    await expect(nav).toHaveAttribute("data-session-id", left.id);
    await expect(nav.locator('[aria-current="page"]')).toHaveAttribute("aria-label", `세션: ${longTitle} (${left.id})`);
    const narrowInput = page.locator('[data-layout-mode="narrow"] [data-leaf="left"]').getByLabel("메시지 입력").filter({ visible: true });
    await narrowInput.fill("좁은 화면 초안");
    await nav.getByRole("button", { name: `프로젝트: ${a.name} (${a.id}) 대화 목록으로`, exact: true }).click();
    await expect(nav.locator('[aria-current="page"]')).toHaveText(a.name);
    await activateMobileTab(page, "이전 제목");
    await expect(narrowInput).toHaveValue("좁은 화면 초안");
    const selectSession = async (id: string) => {
        await page.getByRole("button", { name: "사이드바", exact: true }).click();
        const drawer = page.getByTestId("mobile-drawer-left");
        await drawer.locator(`[data-testid="sidebar-session"][data-session="${id}"]`).getByRole("button").first().click();
        await expect(drawer).toHaveJSProperty("open", false);
    };
    await selectSession(right.id);
    await expect(nav).toHaveAttribute("data-session-id", right.id);
    await selectSession(left.id);
    await expect(narrowInput).toHaveValue("좁은 화면 초안");
    await page.setViewportSize({ width: 390, height: 430 });
    const bounds = await nav.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.height).toBeLessThan(50);
    await expect(narrowInput).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(wideInput).toHaveValue("넓은 화면 초안");
    expect(await wideNode!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(page.locator('[data-testid="pane"]:visible')).toHaveCount(2);
    await expect(nav).toHaveAttribute("data-session-id", left.id);
});
