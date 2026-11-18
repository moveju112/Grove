import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login, sessionView, useWorkspaces } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

for (const theme of ["light", "dark"] as const) {
    test(`${theme}: 키보드가 표시 영역만 줄이거나 밀어도 상단바와 입력창을 함께 유지한다`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        // 데스크톱 Chrome은 OS 키보드를 띄우지 않는다. layout viewport는 유지한 채
        // 브라우저가 보고하는 visual viewport의 높이·이동·확대만 바꾼다.
        await page.addInitScript(() => {
            const viewport = window.visualViewport!;
            let geometry = { height: 844, offsetTop: 0, scale: 1 };
            for (const key of ["height", "offsetTop", "scale"] as const) {
                Object.defineProperty(viewport, key, { get: () => geometry[key] });
            }
            window.addEventListener("test-visual-viewport", (event) => {
                const { type, ...next } = (event as CustomEvent<typeof geometry & { type: string }>).detail;
                geometry = next;
                viewport.dispatchEvent(new Event(type));
            });
        });
        const { a } = await ensureProjects();
        await useWorkspaces(a.id);
        const title = `keyboard-${theme}-${crypto.randomUUID()}`;
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
        for (let i = 0; i < 12; i++) await apiCall("POST", `/sessions/${session.id}/messages`, {
            text: `키보드와 함께 읽을 메시지 ${i}\n${"대화 본문은 내부에서 스크롤한다. ".repeat(12)}`,
        });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
        await login(page);
        await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /interactive-widget=resizes-content/);
        await page.getByRole("button", { name: "사이드바", exact: true }).click();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title }).click();
        const view = sessionView(page, session.id);
        const input = view.getByLabel("메시지 입력", { exact: true });
        await input.fill("키보드를 열고 닫아도 보존할 초안\n두 번째 줄");
        const update = (height: number, offsetTop = 0, scale = 1, type = "resize") => page.evaluate((detail) => {
            window.dispatchEvent(new CustomEvent("test-visual-viewport", { detail }));
        }, { height, offsetTop, scale, type });
        const check = async (height: number, top: number) => {
            await expect.poll(() => view.evaluate((node, { height, top }) => {
                const header = document.querySelector('[role="banner"]')!.getBoundingClientRect();
                const composer = node.querySelector('[data-testid="composer"]')!.getBoundingClientRect();
                const pane = node.closest('[data-testid="pane-body"]')!.getBoundingClientRect();
                return {
                    headerVisible: Math.abs(header.top - top) <= 1 && header.bottom < composer.top,
                    inputVisible: composer.top >= header.bottom && composer.bottom <= top + height + 1,
                    bottomAligned: Math.abs(pane.bottom - top - height) <= 1,
                };
            }, { height, top })).toEqual({ headerVisible: true, inputVisible: true, bottomAligned: true });
            await expect(input).toHaveValue("키보드를 열고 닫아도 보존할 초안\n두 번째 줄");
            await expect(input).toBeFocused();
        };
        await check(844, 0);
        await update(460);
        expect(await page.evaluate(() => innerHeight)).toBe(844);
        await check(460, 0);
        await update(460, 180, 1, "scroll");
        await check(460, 180);
        await page.screenshot({ path: info.outputPath(`keyboard-${theme}-390.png`), clip: { x: 0, y: 180, width: 390, height: 460 } });
        await update(844);
        await check(844, 0);
        // 확대는 키보드로 오인해 앱 배치를 축소하지 않는다.
        await update(422, 40, 2);
        await check(844, 0);
        await update(844);
        await check(844, 0);
        // 브라우저가 layout viewport도 줄이는 경우와 가로 회전도 처리한다.
        await page.setViewportSize({ width: 700, height: 390 });
        await update(310);
        await check(310, 0);
        await page.setViewportSize({ width: 390, height: 844 });
        await update(844);
        await check(844, 0);
    });
}

test("visualViewport가 없는 환경도 창 높이에 맞춰 표시한다", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(window, "visualViewport", { value: undefined }));
    await login(page);
    for (const height of [460, 844]) {
        await page.setViewportSize({ width: 390, height });
        await expect.poll(() => page.getByTestId("workspace").evaluate((node) => {
            const box = node.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom, viewport: innerHeight };
        })).toEqual({ top: 0, bottom: height, viewport: height });
    }
});
