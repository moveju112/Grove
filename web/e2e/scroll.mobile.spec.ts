import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login, sessionView } from "./helpers";

for (const width of [360, 390]) test(`${width}px: 대화 끝에서 천천히 이전 메시지로 드래그해도 위치가 되돌아가지 않는다`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const { a } = await ensureProjects();
    const title = `mobile-scroll-${crypto.randomUUID()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    for (let i = 0; i < 60; i++) {
        await apiCall("POST", `/sessions/${session.id}/messages`, { text: `메시지 ${i}\n${"모바일에서 천천히 이전 대화를 읽는다.\n".repeat(i % 7 === 0 ? 12 : 2)}` });
    }
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title, exact: false }).click();
    const view = sessionView(page, session.id);
    const pane = page.getByTestId("pane-body").filter({ has: view });
    await expect(view.getByText("메시지 59", { exact: false })).toBeInViewport();
    const cdp = await page.context().newCDPSession(page);
    try {
        for (let drag = 0; drag < 3; drag++) {
            // 가상 목록의 위쪽 spacer가 실측 높이로 바뀌면 scrollTop도 보정된다.
            // 화면에 보이는 실제 메시지의 화면 좌표로 진행 거리와 역방향 움직임을 검사한다.
            const article = await pane.evaluate((node) => {
                const bounds = node.getBoundingClientRect();
                return [...node.querySelectorAll<HTMLElement>("[data-seq]")].find((message) => {
                    const rect = message.getBoundingClientRect();
                    return rect.bottom > bounds.top && rect.top < bounds.bottom;
                })?.dataset.seq;
            });
            expect(article).toBeTruthy();
            const row = pane.locator(`[data-seq=${JSON.stringify(article)}]`);
            const start = await row.evaluate((node) => node.getBoundingClientRect().top);
            const samples: number[] = [];
            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 190, y: 240 }] });
            for (let step = 1; step <= 24; step++) {
                await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 190, y: 240 + step * 8 }] });
                samples.push(await row.evaluate(async (node) => {
                    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                    return node.getBoundingClientRect().top;
                }));
            }
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            expect(samples.at(-1)! - start, JSON.stringify({ start, samples })).toBeGreaterThan(100);
            for (let step = 1; step < samples.length; step++) {
                expect(samples[step - 1]! - samples[step]!, JSON.stringify({ start, samples })).toBeLessThanOrEqual(2);
            }
        }
    } finally { await cdp.detach(); }
    await expect(page.locator("[data-mobile-drawer][open]")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`scroll-${width}.png`) });
    const readingTop = await pane.evaluate((node) => node.scrollTop);
    await apiCall("POST", `/sessions/${session.id}/messages`, { text: "읽던 위치를 유지할 새 메시지" });
    await expect(view.getByTestId("new-below")).toBeVisible();
    expect(Math.abs(await pane.evaluate((node) => node.scrollTop) - readingTop)).toBeLessThan(5);
    await view.getByTestId("new-below").click();
    await expect(view.getByText("읽던 위치를 유지할 새 메시지", { exact: true })).toBeInViewport();
    await apiCall("POST", `/sessions/${session.id}/messages`, { text: "맨 아래에서 자동으로 따라갈 메시지" });
    await expect(view.getByText("맨 아래에서 자동으로 따라갈 메시지", { exact: true })).toBeInViewport();
    await expect(view.getByTestId("new-below")).toHaveCount(0);
});
