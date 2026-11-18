import { expect, test, type CDPSession, type Locator, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, sessionView, state } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

type Project = { id: string; name: string; revision: number; folder_id?: string };
const row = (page: Page, project: Project) => page.locator(`[data-testid="project-row"][data-project-order-id="${project.id}"]`);
const order = (page: Page, projects: Project[]) => page.getByTestId("project-row").evaluateAll(
    (nodes, ids) => nodes.map((node) => node.getAttribute("data-project-order-id")).filter((id) => ids.includes(id!)), projects.map((p) => p.id));
const create = async (count: number) => {
    const projects: Project[] = [];
    const tag = crypto.randomUUID().slice(0, 8);
    for (let i = 0; i < count; i++) projects.push(await apiCall<Project>("POST", "/projects", {
        root_path: mkdtempSync(join(dirname(state().projA), `000-touch-${tag}-${String(i).padStart(2, "0")}-`)),
    }));
    return projects;
};
async function showSidebar(page: Page) {
    await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", true);
    await expect(page.getByTestId("mobile-drawer-left")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
}
async function hold(cdp: CDPSession, source: Locator) {
    await source.scrollIntoViewIfNeeded();
    const box = (await source.boundingBox())!;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 70, y: box.y + box.height / 2 }] });
    await expect(source).toHaveAttribute("data-order-dragging", "true");
}
async function move(cdp: CDPSession, target: Locator, after = false) {
    const box = (await target.boundingBox())!;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + 70, y: box.y + (after ? box.height - 4 : 4) }] });
    await expect(target).toHaveAttribute("data-order-drop", after ? "after" : "before");
}

for (const theme of ["light", "dark"] as const) {
    test(`${theme}: 길게 눌러 프로젝트를 위·아래로 옮기고 놓아도 대화·초안을 유지하며 새로고침 후 순서를 복원한다`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript((theme) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme })), theme);
        const projects = await create(3);
        const [a, b, c] = projects as [Project, Project, Project];
        const title = `터치 정렬 ${theme}`;
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
        await login(page);
        await showSidebar(page);
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
        const input = sessionView(page, session.id).getByLabel("메시지 입력", { exact: true });
        await input.fill("정렬 후에도 유지할 초안");
        const original = (await input.elementHandle())!;
        await showSidebar(page);
        const cdp = await page.context().newCDPSession(page);
        try {
            await hold(cdp, row(page, c));
            await move(cdp, row(page, a));
            await page.screenshot({ path: info.outputPath(`project-lift-${theme}-390.png`) });
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await expect.poll(() => order(page, projects)).toEqual([c.id, a.id, b.id]);
            await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", true);
            await expect(page.getByTestId("navigation-context")).toHaveAttribute("data-project-id", a.id);
            expect(await original.evaluate((node: HTMLTextAreaElement) => node.isConnected && node.value === "정렬 후에도 유지할 초안")).toBe(true);
            await hold(cdp, row(page, c));
            await move(cdp, row(page, b), true);
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await expect.poll(() => order(page, projects)).toEqual([a.id, b.id, c.id]);
            await hold(cdp, row(page, b));
            await move(cdp, row(page, a));
            await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
            await expect(row(page, b)).not.toHaveAttribute("data-order-dragging");
            await expect.poll(() => order(page, projects)).toEqual([a.id, b.id, c.id]);
            await hold(cdp, row(page, b));
            await move(cdp, row(page, a));
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await expect.poll(() => order(page, projects)).toEqual([b.id, a.id, c.id]);
            await page.screenshot({ path: info.outputPath(`project-order-${theme}-390.png`) });
        } finally {
            await cdp.detach();
        }
        await page.getByRole("button", { name: "탐색 메뉴 닫기", exact: true }).click();
        await expect(input).toHaveValue("정렬 후에도 유지할 초안");
        await page.reload();
        await showSidebar(page);
        await expect.poll(() => order(page, projects)).toEqual([b.id, a.id, c.id]);
        await row(page, c).getByRole("button", { name: c.name, exact: true }).tap();
        await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", false);
        await expect(page.getByTestId("navigation-context")).toHaveAttribute("data-project-id", c.id);
    });
}

test("길게 누르기 전에는 세로 스크롤하고, 들어 올린 뒤에는 목록 가장자리에서 자동 스크롤한다", async ({ page }) => {
    const projects = await create(22);
    await login(page);
    await showSidebar(page);
    const viewport = page.getByTestId("sidebar-scroll");
    await viewport.evaluate((node) => { node.scrollTop = 0; });
    const cdp = await page.context().newCDPSession(page);
    try {
        const source = row(page, projects[4]!);
        await source.scrollIntoViewIfNeeded();
        const box = (await source.boundingBox())!;
        const before = await viewport.evaluate((node) => node.scrollTop);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 70, y: box.y + 16 }] });
        for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove", touchPoints: [{ x: box.x + 70, y: box.y + 16 - i * 12 }],
        });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(before);
        await expect(page.locator('[data-order-dragging="true"]')).toHaveCount(0);
        expect(await page.evaluate(() => localStorage.getItem("grove.layout.projectOrder"))).toBeNull();
        await viewport.evaluate((node) => { node.scrollTop = 0; });
        await hold(cdp, row(page, projects[0]!));
        const edge = (await viewport.boundingBox())!;
        const scrollingFrom = await viewport.evaluate((node) => node.scrollTop);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: edge.x + 90, y: edge.y + edge.height - 8 }] });
        await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(scrollingFrom + 48);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
        await expect(page.locator('[data-order-dragging="true"]')).toHaveCount(0);
        expect(await page.evaluate(() => localStorage.getItem("grove.layout.projectOrder"))).toBeNull();
    } finally {
        await cdp.detach();
    }
});

test("다른 폴더의 프로젝트 행·목록 밖 드롭과 Escape 취소는 프로젝트 소속과 순서를 바꾸지 않는다", async ({ page }) => {
    const projects = await create(2);
    const [a, b] = projects as [Project, Project];
    const origin = await apiCall<{ id: string }>("POST", "/project-folders", { name: "터치 정렬 원본" });
    const folder = await apiCall<{ id: string }>("POST", "/project-folders", { name: "터치 정렬 대상" });
    await apiCall("PATCH", `/projects/${a.id}`, { expected_revision: a.revision, folder_id: origin.id });
    await apiCall("PATCH", `/projects/${b.id}`, { expected_revision: b.revision, folder_id: folder.id });
    await login(page);
    await showSidebar(page);
    const cdp = await page.context().newCDPSession(page);
    try {
        await row(page, b).scrollIntoViewIfNeeded();
        const target = (await row(page, b).boundingBox())!;
        await hold(cdp, row(page, a));
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: target.x + 70, y: target.y + 4 }] });
        await expect(row(page, b)).not.toHaveAttribute("data-order-drop");
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await hold(cdp, row(page, a));
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 380, y: 400 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await hold(cdp, row(page, a));
        await page.keyboard.press("Escape");
        await expect(row(page, a)).not.toHaveAttribute("data-order-dragging");
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", true);
        expect(await page.evaluate(() => localStorage.getItem("grove.layout.projectOrder"))).toBeNull();
        expect((await apiCall<Project>("GET", `/projects/${a.id}`)).folder_id).toBe(origin.id);
        expect((await apiCall<Project>("GET", `/projects/${b.id}`)).folder_id).toBe(folder.id);
    } finally {
        await cdp.detach();
    }
});
