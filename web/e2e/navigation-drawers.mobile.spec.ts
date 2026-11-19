import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, ensureProfile, ensureProjects, login, script, sessionView, state } from "./helpers";
import { frames } from "./fixture";

async function swipe(page: Page, x: number, y: number, toX: number, toY = y) {
    const cdp = await page.context().newCDPSession(page);
    try {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        for (let step = 1; step <= 8; step++) {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (toX - x) * step / 8, y: y + (toY - y) * step / 8 }] });
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally { await cdp.detach(); }
}

for (const theme of ["light", "dark"] as const) {
    test(`${theme}: 양쪽 가장자리 스와이프로 메뉴·현재 프로젝트 세션을 열고 초안을 유지한다`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.addInitScript((theme) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme })), theme);
        // 다른 시험에서 프로젝트 모드를 바꿔도 단일 모드 탐색을 독립적으로 확인한다.
        const createProject = () => apiCall<{ id: string; name: string }>("POST", "/projects", {
            root_path: mkdtempSync(join(dirname(state().projA), "000-drawers-")),
        });
        const a = await createProject();
        const b = await createProject();
        const first = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `첫 대화 ${theme}` });
        const second = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `둘째 대화 ${theme}` });
        for (const session of [first, second]) {
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
        }
        await apiCall("POST", `/projects/${b.id}/sessions`, { title: `다른 프로젝트 ${theme}` });
        await login(page);
        await swipe(page, 10, 400, 230);
        const left = page.getByTestId("mobile-drawer-left");
        await expect(left).toBeVisible();
        await expect(left).toHaveAccessibleName("탐색 메뉴");
        await expect(left).toHaveJSProperty("open", true);
        await expect(left).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
        await expect(left.getByRole("button", { name: "설정", exact: true })).toBeVisible();
        const header = left.getByTestId("mobile-drawer-header");
        await expect(header.getByRole("button")).toHaveCount(4);
        for (const [index, name] of ["프로젝트·폴더 추가", "사용량", "설정", "탐색 메뉴 닫기"].entries()) {
            await expect(header.getByRole("button").nth(index)).toHaveAccessibleName(name);
        }
        const controls = await header.getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
            const box = button.getBoundingClientRect();
            return { x: box.x, y: box.y, right: box.right, width: box.width, height: box.height };
        }));
        for (const [index, box] of controls.entries()) {
            expect(box.width).toBeGreaterThanOrEqual(32);
            expect(box.height).toBeGreaterThanOrEqual(32);
            expect(box.y).toBe(controls[0]!.y);
            if (index > 0) expect(controls[index - 1]!.right).toBeLessThanOrEqual(box.x);
        }
        await header.getByRole("button", { name: "프로젝트·폴더 추가", exact: true }).click();
        await expect(page.getByRole("menuitem", { name: "프로젝트 추가", exact: true })).toBeVisible();
        await expect(page.getByRole("menuitem", { name: "폴더 추가", exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.locator("[popover]:popover-open")).toHaveCount(0);
        await expect(header.getByRole("button", { name: "프로젝트·폴더 추가", exact: true })).toBeFocused();
        const project = left.locator(`[data-testid="sidebar-project"][data-project-id="${a.id}"]`);
        await expect(project.getByTestId("sidebar-session")).toHaveCount(0);
        await expect(project.getByTestId("project-row")).toBeVisible();
        expect((await project.getByTestId("project-row").boundingBox())!.height).toBeLessThanOrEqual(36);
        const horizontalScroll = await left.getByTestId("sidebar-scroll").evaluate((node) => {
            const previous = node.scrollLeft;
            node.scrollLeft = 100;
            const horizontalScroll = node.scrollLeft;
            node.scrollLeft = previous;
            const bounds = node.getBoundingClientRect();
            return { horizontalScroll, width: node.clientWidth, scroll: node.scrollWidth,
                overflow: [...node.querySelectorAll<HTMLElement>("*")].filter((child) => child.getBoundingClientRect().right > bounds.right + 1)
                    .slice(0, 6).map((child) => ({ tag: child.tagName, testId: child.dataset.testid, role: child.getAttribute("role"), rect: child.getBoundingClientRect().toJSON() })) };
        });
        expect(horizontalScroll.horizontalScroll, JSON.stringify(horizontalScroll)).toBe(0);
        await page.screenshot({ path: info.outputPath(`left-${theme}-390.png`) });
        await swipe(page, 240, 400, 10);
        await expect(left).toHaveJSProperty("open", false);
        await page.getByRole("button", { name: "사이드바", exact: true }).click();
        await left.getByRole("button", { name: `첫 대화 ${theme}`, exact: false }).first().click();
        await expect(left).toHaveJSProperty("open", false);
        await sessionView(page, first.id).getByLabel("메시지 입력").fill("첫 대화의 보존할 초안");
        await page.getByRole("button", { name: "사이드바", exact: true }).click();
        await left.getByRole("button", { name: `둘째 대화 ${theme}`, exact: false }).first().click();
        await expect(left).toHaveJSProperty("open", false);
        await expect(sessionView(page, second.id)).toBeVisible();
        await expect(page.getByRole("tablist").filter({ visible: true })).toHaveCount(0);
        // 가장자리 버튼 없이 채팅 본문 중앙에서 왼쪽으로 밀어도 오른쪽 서랍이 열린다.
        await swipe(page, 280, 400, 40);
        const right = page.getByTestId("mobile-drawer-right");
        await expect(right).toBeVisible();
        await expect(right).toHaveAccessibleName("열린 세션");
        await expect(right).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
        await expect(right.getByRole("button", { name: `첫 대화 ${theme}`, exact: true })).toBeVisible();
        await expect(right.getByRole("button", { name: `둘째 대화 ${theme}`, exact: true })).toBeVisible();
        await expect(right.getByText(`다른 프로젝트 ${theme}`)).toHaveCount(0);
        await page.screenshot({ path: info.outputPath(`right-${theme}-390.png`) });
        await swipe(page, 120, 400, 380);
        await expect(right).toHaveJSProperty("open", false);
        await page.getByRole("button", { name: "열린 세션", exact: true }).click();
        await right.getByRole("button", { name: `첫 대화 ${theme}`, exact: true }).click();
        await expect(right).toHaveJSProperty("open", false);
        // 열린 탭을 오가는 동안 입력은 메모리에 남고, 서랍을 열고 닫아도 유지된다.
        await expect(sessionView(page, first.id).getByLabel("메시지 입력")).toHaveValue("첫 대화의 보존할 초안");
        await swipe(page, 110, 400, 350);
        await expect(left).toBeVisible();
        await swipe(page, 240, 400, 10);
        await expect(left).toHaveJSProperty("open", false);
        await expect(sessionView(page, first.id).getByLabel("메시지 입력")).toHaveValue("첫 대화의 보존할 초안");
        await swipe(page, 10, 400, 12, 200);
        await expect(left).toHaveJSProperty("open", false);
        await page.getByRole("button", { name: "열린 세션", exact: true }).click();
        await page.keyboard.press("Escape");
        await expect(right).toHaveJSProperty("open", false);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.getByRole("button", { name: "사이드바", exact: true }).click();
        await left.getByRole("button", { name: "탐색 메뉴 닫기", exact: true }).click();
        await expect(left).toHaveJSProperty("open", false);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
}

test("본문 스와이프는 입력·선택·코드의 가로 스크롤과 세로 스크롤을 가로채지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    const profile = await ensureProfile();
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `스와이프 예외 ${crypto.randomUUID()}` });
    const prompt = `swipe-exceptions-${session.id}`;
    await apiCall("POST", `/sessions/${session.id}/messages`, { text: "세로 스크롤을 보존할 본문\n".repeat(40) });
    await script({ marker: prompt, frames: frames.text([`선택해 복사할 본문입니다.\n\n\`\`\`text\n${"horizontal-scroll ".repeat(80)}\n\`\`\``]) });
    const turn = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: prompt, profile_id: profile, tools: false });
    await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${turn.turn.id}`)).status).toBe("completed");
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /스와이프 예외/ }).first().click();
    await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", false);
    const view = sessionView(page, session.id);
    const drawers = page.locator("[data-mobile-drawer][open]");
    const input = view.getByLabel("메시지 입력", { exact: true });
    await input.fill("스와이프로 보내거나 지우지 않을 초안");
    const box = (await input.boundingBox())!;
    await swipe(page, box.x + 60, box.y + box.height / 2, box.x + 220);
    await expect(drawers).toHaveCount(0);
    await expect(input).toHaveValue("스와이프로 보내거나 지우지 않을 초안");
    const code = view.getByTestId("md-code").getByRole("group");
    await code.scrollIntoViewIfNeeded();
    const area = (await code.boundingBox())!;
    expect(area.x + area.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await code.evaluate((node) => node.scrollWidth)).toBeGreaterThan(area.width);
    await swipe(page, area.x + area.width - 30, area.y + area.height / 2, area.x + 30);
    await expect.poll(() => code.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    await expect(drawers).toHaveCount(0);
    await expect(view, "코드를 가로 스크롤해도 현재 대화를 유지한다").toBeVisible();
    const paragraph = view.getByTestId("msg-assistant").getByTestId("markdown").locator(":scope > p").first();
    await paragraph.scrollIntoViewIfNeeded();
    await paragraph.evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = document.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
    });
    await expect(paragraph).toBeInViewport({ ratio: 1 });
    const text = (await paragraph.boundingBox())!;
    await swipe(page, text.x + 40, text.y + text.height / 2, text.x + 250);
    await expect(drawers).toHaveCount(0);
    await expect(view, "텍스트 선택 중 가로 이동해도 현재 대화를 유지한다").toBeVisible();
    await page.evaluate(() => document.getSelection()?.removeAllRanges());
    const pane = page.getByTestId("pane-body").filter({ has: view });
    await pane.evaluate((node) => { node.scrollTop = 0; });
    await swipe(page, 200, 350, 200, 150);
    await expect.poll(() => pane.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await expect(drawers).toHaveCount(0);
    await expect(input).toHaveValue("스와이프로 보내거나 지우지 않을 초안");
});

test("최근 시간 범위는 느린 재조회 중에도 목록·높이를 유지하고 방문한 범위는 재요청하지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    await apiCall("POST", `/projects/${a.id}/sessions`, { title: "필터 전환 중 남아 있는 대화" });
    await login(page);
    await page.getByRole("button", { name: "사이드바", exact: true }).click();
    const recent = page.getByTestId("sidebar").getByRole("region", { name: "최근", exact: true });
    await expect(recent.getByTestId("recent-item").first()).toBeVisible();
    const original = await recent.getByTestId("recent-item").allTextContents();
    const height = (await recent.boundingBox())!.height;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const requests: string[] = [];
    await page.route("**/api/v1/recent?*", async (route) => {
        requests.push(route.request().url());
        const response = await route.fetch();
        await gate;
        await route.fulfill({ response });
    });
    try {
        await recent.getByRole("button", { name: "최근 30분 범위", exact: true }).click();
        await expect(recent.getByTestId("recent-list")).toHaveAttribute("aria-busy", "true");
        expect(await recent.getByTestId("recent-item").allTextContents()).toEqual(original);
        expect((await recent.boundingBox())!.height).toBe(height);
        await expect(recent.getByText("최근 항목 없음", { exact: true })).toHaveCount(0);
        release();
        await expect(recent.getByTestId("recent-list")).toHaveAttribute("aria-busy", "false");
        const fetched = requests.length;
        await recent.getByRole("button", { name: "최근 4시간 범위", exact: true }).click();
        await recent.getByRole("button", { name: "최근 30분 범위", exact: true }).click();
        await expect(recent.getByTestId("recent-list")).toHaveAttribute("aria-busy", "false");
        expect(requests).toHaveLength(fetched);
    } finally { release(); }
});
