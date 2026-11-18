import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiCall, ensureProjects, login, openProjectTerminal, openSettings, selectChoice } from "./helpers";

async function openTerminal(page: Page, split = false) {
    const { a } = await ensureProjects();
    const name = `clipboard-${randomUUID()}`;
    const terminal = await apiCall<{ id: string }>("POST", `/projects/${a.id}/terminals`, { name });
    if (split) {
        const device = `clipboard-${randomUUID()}`;
        await apiCall("PUT", `/layouts/${device}`, { expected_revision: 0, layout: {
            schema: 1, focused_leaf: "terminal", root: { type: "split", direction: "row", ratio: 0.5, children: [
                { type: "leaf", id: "terminal", active_tab: "term", tabs: [
                    { id: "term", kind: "terminal", project_id: a.id, resource_id: terminal.id, title: name },
                ] },
                { type: "leaf", id: "other", active_tab: "project", tabs: [
                    { id: "project", kind: "project", project_id: a.id, resource_id: a.id, title: a.name },
                ] },
            ] },
        } });
        await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
    }
    await login(page);
    if (split) await page.getByTestId("project-row").getByRole("button", { name: a.name, exact: true }).click();
    else await openProjectTerminal(page, a.name, name);
    const view = page.getByTestId("terminal-view");
    await expect(view).toHaveAttribute("data-conn", "open");
    return { view, id: terminal.id };
}

async function captureInput(page: Page, view: Locator, mouseReporting = false) {
    await view.locator(".xterm").click();
    const mouse = mouseReporting ? "\\x1b[?1000h" : "";
    const program = `import os,tty; tty.setraw(0); print("${mouse}\\x1b[?2004hINPUT-"+"READY",flush=True); data=b""; exec("while True:\\n data+=os.read(0,4096)\\n print(\\\"\\\\r\\\\nHEX:\\\"+data.hex(),flush=True)")`;
    await page.keyboard.type(`python3 -u -c '${program}'`);
    await page.keyboard.press("Enter");
    const output = view.locator(".xterm-rows");
    await expect(output).toContainText("INPUT-READY");
    let bytes = "";
    return async (text: string) => {
        bytes += Buffer.from(text).toString("hex");
        await expect(output).toContainText(`HEX:${bytes}`);
    };
}

async function selectOutput(page: Page, view: Locator) {
    await view.locator(".xterm").click();
    await page.keyboard.type("stty -echo; printf '\\033[2J\\033[Hcopy-%s\\n' \"$((40+2))\"");
    await page.keyboard.press("Enter");
    const text = view.locator(".xterm-rows > div").first().locator("span").filter({ hasText: "copy-42" });
    await expect(text).toHaveText("copy-42");
    const box = (await text.boundingBox())!;
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 1, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
}

async function expectContextMenuBlocked(screen: Locator, shift = false) {
    await screen.evaluate((element) => {
        element.removeAttribute("data-context-prevented");
        window.addEventListener("contextmenu", (event) => {
            // 터미널의 캡처 리스너까지 실행된 뒤 기본 메뉴의 취소 여부를 읽는다.
            setTimeout(() => element.setAttribute("data-context-prevented", String(event.defaultPrevented)), 0);
        }, { capture: true, once: true });
    });
    await screen.click({ button: "right", modifiers: shift ? ["Shift"] : [] });
    await expect(screen).toHaveAttribute("data-context-prevented", "true");
}

test("실제 드래그 선택을 자동 복사하고 우클릭 붙여넣기는 PTY에 한 번만 전달한다", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const { view, id } = await openTerminal(page);
    try {
        await page.evaluate(() => navigator.clipboard.writeText("before selection"));
        await selectOutput(page, view);
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("copy-42");
        const received = await captureInput(page, view, true);
        await page.evaluate(() => navigator.clipboard.writeText("붙임"));
        await expectContextMenuBlocked(view.locator(".xterm"));
        await received("\x1b[200~붙임\x1b[201~");
        await page.keyboard.type("z");
        await received("z");
    } finally {
        await apiCall("POST", `/terminals/${id}/kill`);
    }
});

test("Shift 우클릭과 읽기 전용 우클릭은 메뉴를 막고 클립보드를 읽지 않는다", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator.clipboard, "readText", {
        value: () => {
            document.body.dataset.terminalClipboardRead = "true";
            return Promise.resolve("unexpected-paste");
        },
    }));
    const { view, id } = await openTerminal(page);
    const screen = view.locator(".xterm");
    let running = true;
    try {
        await expectContextMenuBlocked(screen, true);
        await expect(page.locator("body")).not.toHaveAttribute("data-terminal-clipboard-read", "true");

        await apiCall("POST", `/terminals/${id}/kill`);
        running = false;
        await expect(view).toHaveAttribute("data-conn", "readonly");
        await expectContextMenuBlocked(screen);
        await expect(page.locator("body")).not.toHaveAttribute("data-terminal-clipboard-read", "true");
    } finally {
        if (running) await apiCall("POST", `/terminals/${id}/kill`);
    }
});

test("여러 줄 확인을 끄면 새로고침 후에도 유지하고 설정에서 다시 켤 수 있다", async ({ page, context }, info) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const { view, id } = await openTerminal(page);
    try {
        const received = await captureInput(page, view);
        await page.evaluate(() => navigator.clipboard.writeText("a\nb"));
        await view.locator(".xterm").click({ button: "right" });
        const dialog = page.getByRole("dialog", { name: "여러 줄 붙여넣기", exact: true });
        await expect(dialog).toBeVisible();
        expect((await view.locator(".xterm-rows").textContent())!.split("INPUT-READY").at(-1)).not.toContain("HEX:");
        await dialog.getByRole("checkbox", { name: "다시 묻지 않기", exact: true }).check();
        await page.screenshot({ path: info.outputPath("terminal-paste-confirm.png"), animations: "disabled" });
        await dialog.getByRole("button", { name: "붙여넣기", exact: true }).click();
        await received("\x1b[200~a\rb\x1b[201~");
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem("grove.device.prefs")!).confirmTerminalPaste)).toBe(false);
        await page.evaluate(() => navigator.clipboard.writeText("c\nd"));
        await view.locator(".xterm").click({ button: "right" });
        await received("\x1b[200~c\rd\x1b[201~");
        await expect(dialog).toHaveCount(0);
        await page.reload();
        await expect(view).toHaveAttribute("data-conn", "open");
        await page.evaluate(() => navigator.clipboard.writeText("e\nf"));
        await view.locator(".xterm").click({ button: "right" });
        await received("\x1b[200~e\rf\x1b[201~");
        await expect(dialog).toHaveCount(0);
        await openSettings(page, "local");
        await page.getByLabel("설정 검색", { exact: true }).fill("터미널 여러 줄 붙여넣기 확인");
        const setting = page.getByRole("combobox", { name: "터미널 여러 줄 붙여넣기 확인", exact: true });
        await expect(setting).toHaveAttribute("data-selected-value", "false");
        await selectChoice(setting, "true");
        await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
        await page.evaluate(() => navigator.clipboard.writeText("g\nh"));
        await view.locator(".xterm").click({ button: "right" });
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await view.locator(".xterm").click();
        await page.keyboard.type("z");
        await received("z");
    } finally {
        await apiCall("POST", `/terminals/${id}/kill`);
    }
});

test("클립보드 읽기 거부는 안내하고 기존 키보드 붙여넣기는 유지한다", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator.clipboard, "readText", {
        value: () => Promise.reject(new DOMException("fixture denied", "NotAllowedError")),
    }));
    const { view, id } = await openTerminal(page);
    try {
        const received = await captureInput(page, view);
        await view.locator(".xterm").click({ button: "right" });
        await expect(view.getByRole("alert")).toContainText("클립보드를 읽지 못했어요");
        await view.locator("textarea.xterm-helper-textarea").evaluate((element) => {
            const data = new DataTransfer();
            data.setData("text/plain", "keyboard");
            element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
        });
        await received("\x1b[200~keyboard\x1b[201~");
        await page.keyboard.type("z");
        await received("z");
    } finally {
        await apiCall("POST", `/terminals/${id}/kill`);
    }
});

test("다른 pane으로 이동했다 돌아와도 늦은 클립보드 읽기를 재생하지 않는다", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator.clipboard, "readText", {
        value: () => new Promise<string>((resolve) => {
            (window as Window & { finishClipboard?: (text: string) => void }).finishClipboard = resolve;
        }),
    }));
    const { view, id } = await openTerminal(page, true);
    try {
        const received = await captureInput(page, view);
        await view.locator(".xterm").click({ button: "right" });
        await page.waitForFunction(() => typeof (window as Window & { finishClipboard?: unknown }).finishClipboard === "function");
        await page.locator('[data-leaf="other"]').getByLabel("메시지 입력", { exact: true }).click();
        await expect(page.locator('[data-leaf="other"]')).toHaveAttribute("data-focused", "true");
        await view.locator(".xterm").click();
        await expect(page.locator('[data-leaf="terminal"]')).toHaveAttribute("data-focused", "true");
        await page.evaluate(() => (window as Window & { finishClipboard?: (text: string) => void }).finishClipboard!("STALE"));
        await page.keyboard.type("z");
        await received("z");
    } finally {
        await apiCall("POST", `/terminals/${id}/kill`);
    }
});
