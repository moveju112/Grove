import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiCall, ensureProfile, ensureProjects, login, script, sessionView } from "./helpers";
import { frames } from "./fixture";

type Recent = { resource_id: string; status: string; completed_turn_id: string | null; completion_unread: boolean };
const recentState = async (id: string) => (await apiCall<{ items: Recent[] }>("GET", "/recent?limit=200")).items.find((item) => item.resource_id === id)!;

async function setup(page: Page, theme: string) {
    await page.addInitScript((theme) => {
        localStorage.setItem("grove.device.prefs", JSON.stringify({ theme }));
        const state = window as unknown as { __recentHidden: boolean };
        state.__recentHidden = false;
        Object.defineProperty(document, "visibilityState", { get: () => state.__recentHidden ? "hidden" : "visible" });
    }, theme);
    const { a } = await ensureProjects();
    const profile = await ensureProfile();
    const title = `최근 완료 ${theme} ${randomUUID().slice(0, 6)}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    return { session, profile, title };
}

async function reply(session: string, profile: string, marker: string, delayMs = 350) {
    await script({ marker, frames: frames.text([`${marker} 답변`]), delayMs });
    return apiCall<{ turn: { id: string } }>("POST", `/sessions/${session}/turns`, { text: marker, profile_id: profile, tools: false });
}

for (const width of [390, 1280]) {
    test.describe(`${width}px 최근 상태`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760 });
        for (const theme of ["light", "dark"] as const) {
            test(`${theme}: 실행은 회전 표시하고 클릭·현재 화면·백그라운드 복귀로 완료를 확인한다`, async ({ page }, info) => {
                await page.emulateMedia({ colorScheme: theme, reducedMotion: "no-preference" });
                const { session, profile, title } = await setup(page, theme);
                if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
                const recent = page.getByRole("region", { name: "최근", exact: true, includeHidden: true });
                const row = recent.locator(`[data-testid="recent-item"][data-session="${session.id}"]`);
                await reply(session.id, profile, `다른 화면에서 완료 ${width} ${theme}`);
                await expect(row.getByRole("progressbar", { name: "실행 중", exact: true })).toBeVisible();
                await expect(row.getByTestId("recent-completed")).toHaveCount(0);
                await page.screenshot({ path: info.outputPath(`recent-running-${width}-${theme}.png`) });
                await expect(row.getByTestId("recent-completed")).toBeVisible();
                await expect(row.locator('[role="progressbar"]')).toHaveCount(0);
                expect((await recentState(session.id)).completion_unread).toBe(true);
                await page.screenshot({ path: info.outputPath(`recent-completed-${width}-${theme}.png`) });
                await row.getByRole("button", { name: new RegExp(title) }).click();
                const view = sessionView(page, session.id);
                await expect(view).toBeVisible();
                await expect.poll(async () => (await recentState(session.id)).completion_unread).toBe(false);
                await expect(row.getByTestId("recent-completed")).toHaveCount(0);

                // 다시 누르거나 탭을 바꾸지 않아도 보고 있는 세션의 새 완료를 확인한다.
                await reply(session.id, profile, `현재 화면에서 완료 ${width} ${theme}`);
                await expect(row.locator('[role="progressbar"]')).toHaveCount(1);
                await expect(view.getByTestId("msg-assistant")).toHaveCount(2);
                await expect.poll(async () => (await recentState(session.id)).completion_unread).toBe(false);
                await expect(row.getByTestId("recent-completed")).toHaveCount(0);

                // 화면이 숨겨진 동안의 완료는 남기고, 복귀하면 자동으로 확인한다.
                await page.evaluate(() => {
                    (window as unknown as { __recentHidden: boolean }).__recentHidden = true;
                    document.dispatchEvent(new Event("visibilitychange"));
                });
                await reply(session.id, profile, `백그라운드에서 완료 ${width} ${theme}`, 50);
                await expect(view.getByTestId("msg-assistant")).toHaveCount(3);
                await expect(row.getByTestId("recent-completed")).toHaveCount(1);
                expect((await recentState(session.id)).completion_unread).toBe(true);
                await page.evaluate(() => {
                    (window as unknown as { __recentHidden: boolean }).__recentHidden = false;
                    document.dispatchEvent(new Event("visibilitychange"));
                });
                await expect.poll(async () => (await recentState(session.id)).completion_unread).toBe(false);
                await expect(row.getByTestId("recent-completed")).toHaveCount(0);
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
