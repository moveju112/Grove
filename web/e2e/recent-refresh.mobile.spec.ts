import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiCall, closeMobileSidebar, ensureProjects, login } from "./helpers";

test("모바일에서 최근 목록은 선조회하고, 실시간 이벤트 없이도 복귀·서랍 열기에 갱신한다", async ({ page }) => {
    const { a } = await ensureProjects();
    const addRecent = async (label: string) => {
        const title = `${label} ${randomUUID().slice(0, 6)}`;
        const { id } = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: id });
        return title;
    };
    const first = await addRecent("기존 항목");
    await page.addInitScript(() => {
        localStorage.setItem("grove.device.prefs", JSON.stringify({ initialSetupComplete: true, recentWindow: "30m" }));
        const state = window as Window & { recentHidden?: boolean; recentStreams?: number };
        Object.defineProperty(document, "visibilityState", { get: () => state.recentHidden ? "hidden" : "visible" });
        Object.defineProperty(document, "hidden", { get: () => !!state.recentHidden });
        const original = window.fetch.bind(window);
        window.fetch = (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            if (!url.startsWith("/api/v1/events?")) return original(input, init);
            state.recentStreams = (state.recentStreams ?? 0) + 1;
            // hello 뒤에는 이벤트가 오지 않는 연결을 재현한다. 목록 응답은 실제 데몬에서 받는다.
            return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) {
                controller.enqueue(new TextEncoder().encode('event: hello\ndata: {"cursor":0}\n\n'));
                init?.signal?.addEventListener("abort", () => controller.error(new DOMException("closed", "AbortError")), { once: true });
            } }), { headers: { "Content-Type": "text/event-stream" } }));
        };
    });
    const isList = (url: string) => /\/api\/v1\/recent\?/.test(url) && new URL(url).searchParams.has("since");
    const warmed = page.waitForResponse((r) => r.ok() && isList(r.url()));
    await login(page);
    const trigger = page.getByRole("button", { name: "사이드바", exact: true });
    expect(new URL((await warmed).url()).searchParams.get("limit")).toBe("30");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    const drawer = page.getByTestId("mobile-drawer-left");
    const row = (title: string) => drawer.getByRole("button", { name: title, exact: true });
    await expect(row(first)).toBeVisible();
    await expect(drawer.getByTestId("recent-list")).toHaveAttribute("aria-busy", "false");

    const setHidden = (hidden: boolean) => page.evaluate((hidden) => {
        (window as Window & { recentHidden?: boolean }).recentHidden = hidden;
        document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
    const streamCount = () => page.evaluate(() => (window as Window & { recentStreams?: number }).recentStreams);
    const streams = await streamCount();
    const clock = await page.evaluate(() => Date.now());
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let requests = 0;
    await page.route((url) => isList(url.href), async (route) => {
        requests++;
        await held;
        await route.continue();
    });
    try {
        await setHidden(true);
        const resumed = await addRecent("백그라운드 중 생성");
        await page.clock.setFixedTime(clock + 2_000);
        await setHidden(false);
        await expect.poll(() => requests, { timeout: 2_000 }).toBe(1);
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
        await expect(row(first)).toBeVisible();
        await expect(row(resumed)).toHaveCount(0);
        release();
        await expect(row(resumed)).toBeVisible({ timeout: 2_000 });
        expect(requests).toBe(1);
        expect(await streamCount()).toBe(streams);

        await closeMobileSidebar(page);
        const opened = await addRecent("닫힌 동안 생성");
        await page.clock.setFixedTime(clock + 4_000);
        await trigger.click();
        await expect(row(opened)).toBeVisible({ timeout: 2_000 });
        expect(requests).toBe(2);
        expect(await streamCount()).toBe(streams);
    } finally { release(); }
});
