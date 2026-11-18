import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiCall, ensureProjects, login, openProjectTerminal } from "./helpers";

test("터미널은 최근에 표시되지 않고 앱의 탭 닫기 단축키로 종료한다", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
    const { a } = await ensureProjects();
    const name = `terminal-shortcut-${randomUUID()}`;
    const terminal = await apiCall<{ id: string }>("POST", `/projects/${a.id}/terminals`, { name });
    await login(page);
    const recentRow = page.getByRole("region", { name: "최근", exact: true }).getByTestId("recent-item").filter({ hasText: name });
    await openProjectTerminal(page, a.name, name);
    const view = page.getByTestId("terminal-view");
    await expect(view).toHaveAttribute("data-conn", "open");
    await expect(recentRow).toHaveCount(0);
    await page.getByRole("button", { name: "새 대화 탭", exact: true }).click();
    await expect(view).toHaveCount(0);
    const rows = await apiCall<{ terminals: { id: string; status: string }[] }>("GET", `/projects/${a.id}/terminals`);
    expect(rows.terminals.find((row) => row.id === terminal.id)?.status).toBe("running");
    await page.getByRole("tab").getByTestId("tab-title").filter({ hasText: name }).click();
    await expect(view).toHaveAttribute("data-conn", "open");
    await page.keyboard.press("Control+w");
    await expect(view).toHaveCount(0);
    await expect(page.getByRole("tab").getByTestId("tab-title").filter({ hasText: name })).toHaveCount(0);
    await expect(recentRow).toHaveCount(0);
    const ended = await apiCall<{ terminals: { id: string; status: string }[] }>("GET", `/projects/${a.id}/terminals`);
    expect(ended.terminals.find((row) => row.id === terminal.id)?.status).toBe("exited");
});

test("종료 실패 시 탭을 유지하고 재시도 중 중복 종료를 보내지 않는다", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
    const { a } = await ensureProjects();
    const name = `terminal-close-error-${randomUUID()}`;
    const terminal = await apiCall<{ id: string }>("POST", `/projects/${a.id}/terminals`, { name });
    await login(page);
    await openProjectTerminal(page, a.name, name);
    const view = page.getByTestId("terminal-view");
    await expect(view).toHaveAttribute("data-conn", "open");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let kills = 0;
    const path = `**/api/v1/terminals/${terminal.id}/kill`;
    await page.route(path, async (route) => {
        kills++;
        if (kills === 1) return route.fulfill({ status: 409, json: { error: { code: "fixture_close", message: "종료 시험 오류", retryable: false } } });
        const response = await route.fetch();
        await gate;
        await route.fulfill({ response });
    });
    try {
        const close = page.getByRole("tab", { selected: true }).getByRole("button", { name: "탭 닫기", exact: true });
        await close.click();
        await expect(page.getByTestId("tab-close-error")).toContainText("종료 시험 오류");
        await expect(view).toHaveAttribute("data-conn", "open");
        await close.click();
        await expect(close).toBeDisabled();
        await expect(close).toHaveAttribute("aria-busy", "true");
        await page.keyboard.press("Control+w");
        await page.keyboard.press("Control+w");
        await expect.poll(() => kills).toBe(2);
        await expect(view).toBeVisible();
        release();
        await expect(view).toHaveCount(0);
        await expect(page.getByTestId("tab-close-error")).toHaveCount(0);
        expect(kills).toBe(2);
    } finally {
        release();
        await page.unroute(path);
        await apiCall("POST", `/terminals/${terminal.id}/kill`);
    }
});

for (const width of [390, 1400]) {
    test.describe(`${width}px 터미널`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760 });

        test("캡처·상태 헤더 없이 터미널을 쓰고 탭을 닫으면 종료한다", async ({ page }, info) => {
            const { a } = await ensureProjects();
            const name = `terminal-${randomUUID()}`;
            const terminal = await apiCall<{ id: string }>("POST", `/projects/${a.id}/terminals`, { name });
            const captures: string[] = [];
            page.on("request", (request) => {
                if (new URL(request.url()).pathname === `/api/v1/terminals/${terminal.id}/capture`) captures.push(request.url());
            });
            await login(page);
            await openProjectTerminal(page, a.name, name);
            const view = page.getByTestId("terminal-view");
            await expect(view).toHaveAttribute("data-conn", "open");
            await expect(view.getByRole("button", { name: "화면 텍스트 캡처", exact: true })).toHaveCount(0);
            await expect(view.getByTestId("terminal-capture")).toHaveCount(0);
            await expect(view.getByTestId("terminal-status")).toHaveCount(0);
            await expect(view.getByRole("button", { name: "종료", exact: true })).toHaveCount(0);
            await expect(view.locator("strong")).toHaveCount(0);
            await view.locator(".xterm").click();
            await page.keyboard.type("stty -echo; printf '\\033[2J\\033[Hold\\r\\033[2K\\033[31m");
            await page.keyboard.insertText("한글 출력");
            await page.keyboard.type("\\033[m\\n'; printf 'terminal-%s\\n' \"$((41+1))\"");
            await page.keyboard.press("Enter");
            await expect(view.locator(".xterm-rows")).toContainText("한글 출력");
            await expect(view.locator(".xterm-rows")).toContainText("terminal-42");
            await page.screenshot({ path: info.outputPath(`terminal-${width}.png`) });
            await page.reload();
            await expect(view).toHaveAttribute("data-conn", "open");
            await expect(view.locator(".xterm-rows")).toContainText("terminal-42");
            if (width < 760) {
                await page.getByRole("banner").getByRole("button", { name: "열린 세션", exact: true }).click();
                await page.getByRole("button", { name: `${name} 탭 닫기`, exact: true }).click();
            } else {
                await page.getByRole("tab", { selected: true }).getByRole("button", { name: "탭 닫기", exact: true }).click();
            }
            await expect(view).toHaveCount(0);
            const rows = await apiCall<{ terminals: { id: string; status: string }[] }>("GET", `/projects/${a.id}/terminals`);
            expect(rows.terminals.find((row) => row.id === terminal.id)?.status).toBe("exited");
            if (width < 760) {
                await page.getByRole("button", { name: "열린 세션 닫기", exact: true }).click();
            }
            await openProjectTerminal(page, a.name, name);
            await expect(view).toHaveAttribute("data-conn", "readonly");
            await expect(view.locator(".xterm-rows")).toContainText("terminal-42");
            await expect(view.getByRole("button", { name: "화면 텍스트 캡처", exact: true })).toHaveCount(0);
            await expect(view.getByTestId("terminal-capture")).toHaveCount(0);
            expect(captures).toEqual([]);
        });
    });
}
