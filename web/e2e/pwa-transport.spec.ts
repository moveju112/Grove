import { expect, test, type Locator, type Page } from "@playwright/test";
import { apiCall, ensureProjects, login, openDetails } from "./helpers";

// 보조키는 좁은 터치 화면에 표시된다. 실제 입력 UI와 같은 조건에서 검사한다.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function paste(textarea: Locator, value: string) {
    await textarea.evaluate((element, text) => {
        const data = new DataTransfer();
        data.setData("text/plain", text);
        element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    }, value);
}

async function openTerminal(page: Page) {
    const { a } = await ensureProjects();
    const name = `PWA transport ${Date.now()}`;
    const terminal = await apiCall<{ id: string }>("POST", `/projects/${a.id}/terminals`, { name });
    await login(page);
    await test.step("배치 복원 완료 뒤 프로젝트 열기", async () => {
        // SSE 연결만으로는 폭별 배치 복원이 끝난 것이 아니다. 준비 전 탐색 클릭은 탭을 열지 못한다.
        await expect(page.getByRole("button", { name: "만들기", exact: true })).toBeEnabled();
        const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
        if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
        await page.getByTestId("project-row").getByRole("button", { name: a.name, exact: true }).click();
    });
    const list = page.getByTestId("terminal-list");
    await expect(list).toBeVisible();
    await openDetails(list);
    await list.getByRole("button", { name, exact: true }).click();
    const view = page.getByTestId("terminal-view");
    await expect(view).toHaveAttribute("data-conn", "open");
    return { id: terminal.id, projectId: a.id, view };
}

function terminalFrames(page: Page) {
    const frames: { type: string; data?: string }[] = [];
    page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
        frames.push(JSON.parse(String(payload)));
    }));
    return frames;
}

test("열린 실제 PTY는 offline 직전 입력·paste·보조키·observer resize를 버리고 연결 복구 후 재생하지 않는다", async ({ page }) => {
    const frames = terminalFrames(page);
    const { id, projectId, view } = await openTerminal(page);
    try {
        const textarea = view.locator("textarea.xterm-helper-textarea");
        await view.locator(".xterm").click();
        const program = "import os,tty; tty.setraw(0); print(\"PWA-\"+\"READY\",flush=True); data=b\"\"; exec(\"while True:\\n data+=os.read(0,4096)\\n print(\\\"\\\\r\\\\nHEX:\\\"+data.hex(),flush=True)\")";
        await page.keyboard.type(`python3 -u -c '${program}'`);
        await page.keyboard.press("Enter");
        await expect(view.locator(".xterm-rows")).toContainText("PWA-READY");
        const keys = view.getByRole("group", { name: "보조 키" });
        await keys.getByRole("button", { name: "Ctrl", exact: true }).click();
        await expect(keys.getByRole("button", { name: "Ctrl", exact: true })).toHaveAttribute("aria-pressed", "true");
        const before = frames.length;
        // 실제 socket은 열어 두고 navigator의 관측값만 먼저 바꿔 이벤트/React보다 빠른 paste를 재현한다.
        await textarea.evaluate((element) => {
            Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
            const data = new DataTransfer();
            data.setData("text/plain", "discard-before-offline-event");
            element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
        });
        await expect(view.getByTestId("terminal-blocked")).toContainText("오프라인");
        await page.evaluate(() => window.dispatchEvent(new Event("offline")));
        await expect(keys.getByRole("button", { name: "Ctrl", exact: true })).toHaveAttribute("aria-pressed", "false");
        await expect(keys.getByRole("button", { name: "Tab", exact: true })).toBeDisabled();
        await page.keyboard.type("discard-physical-keyboard");
        await paste(textarea, "discard\nmultiline");
        // 폭별 배치를 바꾸지 않고 실제 ResizeObserver만 자극한다.
        await page.setViewportSize({ width: 430, height: 780 });
        await expect(view.locator(".xterm")).toBeVisible();
        expect(frames.slice(before)).toEqual([]);
        await expect(view).toHaveAttribute("data-conn", "open");
        expect((await apiCall<{ terminals: { id: string; status: string }[] }>("GET", `/projects/${projectId}/terminals`)).terminals.find((t) => t.id === id)?.status).toBe("running");
        await page.evaluate(() => {
            Reflect.deleteProperty(navigator, "onLine");
            window.dispatchEvent(new Event("online"));
        });
        await expect(view.getByTestId("terminal-blocked")).toHaveCount(0);
        expect(frames.slice(before).filter((frame) => frame.type === "input")).toEqual([]);
        await view.locator(".xterm").click();
        await page.keyboard.type("z");
        await expect(view.locator(".xterm-rows")).toContainText("HEX:7a");
        expect(frames.slice(before).filter((frame) => frame.type === "input")).toEqual([{ type: "input", data: "z" }]);
    } finally {
        await apiCall("POST", `/terminals/${id}/kill`);
    }
});

test("ticket 발급 뒤 protocol이 바뀌어도 초기 resize·입력 활성화·observer resize를 보내지 않고 PTY는 유지한다", async ({ page }) => {
    const frames = terminalFrames(page);
    await page.route("**/api/v1/terminals/*/ticket", async (route) => {
        const response = await route.fetch();
        await page.route("**/api/v1/health", (health) => health.fulfill({
            status: 200, contentType: "application/json", body: '{"protocol":2}',
        }));
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(page.getByTestId("protocol-banner")).toContainText("protocol 2");
        await route.fulfill({ response });
    });
    const { id, projectId, view } = await openTerminal(page);
    try {
        await expect(view.getByTestId("terminal-blocked")).toContainText("protocol 2");
        await expect(view.getByRole("button", { name: "Tab", exact: true })).toBeDisabled();
        await page.setViewportSize({ width: 450, height: 760 });
        await paste(view.locator("textarea.xterm-helper-textarea"), "discard");
        expect(frames).toEqual([]);
        await expect(view).toHaveAttribute("data-conn", "open");
        expect((await apiCall<{ terminals: { id: string; status: string }[] }>("GET", `/projects/${projectId}/terminals`)).terminals.find((t) => t.id === id)?.status).toBe("running");
    } finally {
        await apiCall("POST", `/terminals/${id}/kill`);
    }
});
