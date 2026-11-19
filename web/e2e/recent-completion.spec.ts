import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiCall, ensureProfile, ensureProjects, login, script, sessionView } from "./helpers";
import { frames } from "./fixture";

type Recent = { resource_id: string; status: string; completed_turn_id: string | null; completion_unread: boolean };
const recentState = async (id: string) => (await apiCall<{ items: Recent[] }>("GET", "/recent?limit=200")).items.find((item) => item.resource_id === id)!;

async function setup(page: Page, theme: string, title = `최근 완료 ${theme} ${randomUUID().slice(0, 6)}`) {
    await page.addInitScript((theme) => {
        localStorage.setItem("grove.device.prefs", JSON.stringify({ theme }));
        const state = window as unknown as { __recentHidden: boolean };
        state.__recentHidden = false;
        Object.defineProperty(document, "visibilityState", { get: () => state.__recentHidden ? "hidden" : "visible" });
    }, theme);
    const { a } = await ensureProjects();
    const profile = await ensureProfile();
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    return { session, profile, title };
}

async function reply(session: string, profile: string, marker: string, delayMs = 350) {
    await script({ marker, frames: frames.text([`${marker} 답변`]), delayMs });
    return apiCall<{ turn: { id: string } }>("POST", `/sessions/${session}/turns`, { text: marker, profile_id: profile, tools: false });
}

async function expectStatusBackground(row: Locator, token: string) {
    const color = await row.evaluate((node, token) => {
        const sample = node.appendChild(document.createElement("span"));
        sample.style.color = `var(${token})`;
        const color = getComputedStyle(sample).color;
        sample.remove();
        return color;
    }, token);
    await expect(row).toHaveCSS("background-color", color);
}

test("390px: 실행 중 파란 배경을 쓰고 모션 설정에 관계없이 시간과 제목을 유지한다", async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const { session, profile, title } = await setup(page, "light");
    await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await expect(page.getByTestId("mobile-drawer-left")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    const recent = page.getByRole("region", { name: "최근", exact: true });
    const row = recent.locator(`[data-testid="recent-item"][data-session="${session.id}"]`);
    const button = row.getByRole("button", { name: new RegExp(title) });
    const label = button.getByText(title);
    const time = row.getByTestId("recent-time");
    const geometry = async () => Promise.all([button.locator("[data-grove-button-content]"), time].map(async (node) => {
        const { x, width } = (await node.boundingBox())!;
        return { x, width };
    }));
    await expect(time).toHaveText("0m");
    await expect(row).not.toHaveAttribute("data-recent-state");
    const idleBackground = await row.evaluate((node) => getComputedStyle(node).backgroundColor);
    const idle = await geometry();

    const marker = `motion-${randomUUID()}`;
    await script({ marker, frames: frames.text([marker]).slice(0, 1), hang: true });
    const { turn } = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: marker, profile_id: profile, tools: false });
    try {
        await expect(row).toHaveAttribute("data-recent-state", "running");
        await expectStatusBackground(row, "--split-bg");
        await expect(time.locator("svg")).toHaveCount(0);
        await expect(button).toHaveAccessibleDescription("실행 중");
        await expect(label).toHaveCSS("font-weight", "400");
        await expect(time).toHaveText("0m");
        expect(await geometry()).toEqual(idle);
        await page.screenshot({ path: info.outputPath("recent-running-blue-390.png") });

        await page.emulateMedia({ reducedMotion: "reduce" });
        await expectStatusBackground(row, "--split-bg");
        await expect(time.locator("svg")).toHaveCount(0);
        expect(await geometry()).toEqual(idle);
    } finally {
        await apiCall("POST", `/turns/${turn.id}/cancel`);
    }
    await expect(row).not.toHaveAttribute("data-recent-state", "running");
    await expect(row).toHaveCSS("background-color", idleBackground);
});

test("390px: 스크롤되는 최근 목록에서 완료는 초록 배경을 쓰고 확인하면 기본색으로 돌아간다", async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    const { a } = await ensureProjects();
    for (const title of ["프로젝트 목록 정리", "키보드 단축키 검토", "메시지 입력창 조정", "최종 답변 하단 표시 수정", "모바일 화면 점검", "분할 대화 묶음 표시 개선"]) {
        const item = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: item.id });
    }
    const { session, profile, title } = await setup(page, "dark", "Forgejo 배포 구성");
    await page.getByRole("button", { name: "사이드바", exact: true }).click();
    const drawer = page.getByTestId("mobile-drawer-left");
    await expect(drawer).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    const recent = drawer.getByRole("region", { name: "최근", exact: true });
    const scroll = recent.getByTestId("recent-scroll");
    await expect.poll(() => scroll.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
    const row = recent.locator(`[data-testid="recent-item"][data-session="${session.id}"]`);
    const button = row.getByRole("button", { name: title, exact: true });
    const label = button.getByText(title);
    const clock = row.getByTestId("recent-time").locator("time");
    const closeButton = row.getByRole("button", { name: "최근에서 숨기기", exact: true });
    await page.evaluate(() => document.fonts.ready);
    await expect(clock).toHaveText("0m");
    await expect(label).toHaveCSS("font-weight", "400");
    const idleBackground = await row.evaluate((node) => getComputedStyle(node).backgroundColor);
    const idleTime = (await clock.boundingBox())!;
    const idleClose = (await closeButton.boundingBox())!;
    await reply(session.id, profile, `최근 제목 강조 ${session.id}`);
    await expect(row).toHaveAttribute("data-recent-state", "completed");
    await expectStatusBackground(row, "--ok-weak");
    await expect(button).toHaveAccessibleDescription("완료 · 확인 안 함");
    await expect(row.getByTestId("recent-time").locator("svg")).toHaveCount(0);
    await expect(label).toHaveCSS("font-weight", "700");
    const time = (await clock.boundingBox())!;
    const close = (await closeButton.boundingBox())!;
    const visibleRight = await scroll.evaluate((el) => el.getBoundingClientRect().left + el.clientLeft + el.clientWidth);
    expect(time.x).toBeCloseTo(idleTime.x, 0);
    expect(close.x).toBeCloseTo(idleClose.x, 0);
    expect(close.x + close.width).toBeLessThanOrEqual(visibleRight + 0.5);
    await recent.screenshot({ path: info.outputPath("recent-completed-green-dark-390.png"), animations: "disabled", scale: "device" });
    await button.click();
    await expect(sessionView(page, session.id)).toBeVisible();
    await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await expect(label).toHaveCSS("font-weight", "400");
    await expect(row).not.toHaveAttribute("data-recent-state");
    await expect(row).toHaveCSS("background-color", idleBackground);
});

for (const width of [390, 1280]) {
    test.describe(`${width}px 최근 상태`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760 });
        for (const theme of ["light", "dark"] as const) {
            test(`${theme}: 실행·완료를 배경으로 표시하고 클릭·현재 화면·백그라운드 복귀로 완료를 확인한다`, async ({ page }, info) => {
                await page.emulateMedia({ colorScheme: theme, reducedMotion: "no-preference" });
                const { session, profile, title } = await setup(page, theme);
                if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
                const recent = page.getByRole("region", { name: "최근", exact: true, includeHidden: true });
                const row = recent.locator(`[data-testid="recent-item"][data-session="${session.id}"]`);
                await reply(session.id, profile, `다른 화면에서 완료 ${width} ${theme}`, 600);
                await expect(row).toHaveAttribute("data-recent-state", "running");
                await page.screenshot({ path: info.outputPath(`recent-running-${width}-${theme}.png`) });
                await expect(row).toHaveAttribute("data-recent-state", "completed");
                expect((await recentState(session.id)).completion_unread).toBe(true);
                await page.screenshot({ path: info.outputPath(`recent-completed-${width}-${theme}.png`) });
                await row.getByRole("button", { name: new RegExp(title) }).click();
                const view = sessionView(page, session.id);
                await expect(view).toBeVisible();
                await expect.poll(async () => (await recentState(session.id)).completion_unread).toBe(false);
                await expect(row).not.toHaveAttribute("data-recent-state");

                // 다시 누르거나 탭을 바꾸지 않아도 보고 있는 세션의 새 완료를 확인한다.
                await reply(session.id, profile, `현재 화면에서 완료 ${width} ${theme}`);
                await expect(view.getByTestId("msg-assistant")).toHaveCount(2);
                await expect.poll(async () => (await recentState(session.id)).completion_unread).toBe(false);
                await expect(row).not.toHaveAttribute("data-recent-state");

                // 화면이 숨겨진 동안의 완료는 남기고, 복귀하면 자동으로 확인한다.
                await page.evaluate(() => {
                    (window as unknown as { __recentHidden: boolean }).__recentHidden = true;
                    document.dispatchEvent(new Event("visibilitychange"));
                });
                const background = await reply(session.id, profile, `백그라운드에서 완료 ${width} ${theme}`, 50);
                // 숨겨진 페이지는 조회 구독을 멈추므로 완료는 서버에서, 화면 반영은 복귀 후 확인한다.
                await expect.poll(() => recentState(session.id)).toMatchObject({
                    completed_turn_id: background.turn.id, completion_unread: true,
                });
                await page.evaluate(() => {
                    (window as unknown as { __recentHidden: boolean }).__recentHidden = false;
                    document.dispatchEvent(new Event("visibilitychange"));
                });
                await expect(view.getByTestId("msg-assistant")).toHaveCount(3);
                await expect.poll(async () => (await recentState(session.id)).completion_unread).toBe(false);
                await expect(row).not.toHaveAttribute("data-recent-state");
                await page.reload();
                await expect(sessionView(page, session.id)).toBeVisible();
                expect((await recentState(session.id)).completion_unread).toBe(false);
            });
        }
    });
}

test("이미 읽은 메시지 위치가 그대로여도 뒤늦게 도착한 완료 상태를 확인한다", async ({ page }) => {
    const { session, profile, title } = await setup(page, "light");
    await page.getByRole("region", { name: "최근", exact: true }).getByTestId("recent-item")
        .getByRole("button", { name: new RegExp(title) }).click();
    const view = sessionView(page, session.id);
    const reads: { view_state?: { last_seen_seq: number }; seen_completed_turn_id?: string }[] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith("/recent/touch")
            && request.postDataJSON().resource_id === session.id) reads.push(request.postDataJSON());
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/v1/sessions/${session.id}/turns?*`, async (route) => {
        const response = await route.fetch();
        const turns = await response.json() as { status: string }[];
        if (turns[0]?.status === "completed") await held;
        await route.fulfill({ response });
    });
    try {
        const accepted = await reply(session.id, profile, "완료 상태 전달 지연", 150);
        await expect(view.getByTestId("msg-assistant")).toHaveCount(1);
        const state = await apiCall<{ last_message_seq: number }>("GET", `/sessions/${session.id}`);
        await expect.poll(() => reads.some((read) => read.view_state?.last_seen_seq === state.last_message_seq && !read.seen_completed_turn_id)).toBe(true);
        expect((await recentState(session.id)).completion_unread).toBe(true);
        release();
        await expect.poll(() => reads.some((read) => read.view_state?.last_seen_seq === state.last_message_seq
            && read.seen_completed_turn_id === accepted.turn.id)).toBe(true);
        await expect.poll(async () => (await recentState(session.id)).completion_unread).toBe(false);
    } finally {
        release();
        await page.unroute(`**/api/v1/sessions/${session.id}/turns?*`);
    }
});

test("1280px: 상단 탭도 실행 중·완료를 표시하고 보고 있는 탭은 완료 표시를 지운다", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const { session, profile, title } = await setup(page, "light");
    const { a } = await ensureProjects();
    const otherTitle = `다른 탭 ${randomUUID().slice(0, 6)}`;
    const other = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: otherTitle });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: other.id });
    const recent = page.getByRole("region", { name: "최근", exact: true });
    await recent.locator(`[data-testid="recent-item"][data-session="${session.id}"]`).getByRole("button", { name: new RegExp(title) }).click();
    await expect(sessionView(page, session.id)).toBeVisible();
    await recent.locator(`[data-testid="recent-item"][data-session="${other.id}"]`).getByRole("button", { name: new RegExp(otherTitle) }).click();
    await expect(sessionView(page, other.id)).toBeVisible();

    const tab = page.getByRole("tab").filter({ has: page.getByTestId("tab-title").filter({ hasText: title }) });
    const otherTab = page.getByRole("tab").filter({ has: page.getByTestId("tab-title").filter({ hasText: otherTitle }) });
    await expect(tab).toHaveAttribute("aria-selected", "false");

    await reply(session.id, profile, `탭 완료 ${session.id}`);
    await expect(tab.getByTestId("tab-running")).toBeVisible();
    await expect(tab.getByTestId("tab-completed")).toBeVisible();
    await expect(tab.getByTestId("tab-running")).toHaveCount(0);
    await expect(tab.getByTestId("tab-title")).toHaveAccessibleDescription("완료 · 확인 안 함");
    expect((await recentState(session.id)).completion_unread).toBe(true);

    await tab.getByTestId("tab-title").click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(tab.getByTestId("tab-completed")).toHaveCount(0);
    await expect.poll(async () => (await recentState(session.id)).completion_unread).toBe(false);

    // 보고 있는 탭에서 끝난 답변은 완료 표시를 남기지 않는다.
    await reply(other.id, profile, `보는 중 완료 ${other.id}`);
    await otherTab.getByTestId("tab-title").click();
    await expect.poll(async () => (await recentState(other.id)).status).toBe("completed");
    await expect.poll(async () => (await recentState(other.id)).completion_unread).toBe(false);
    await expect(otherTab.getByTestId("tab-completed")).toHaveCount(0);
});
