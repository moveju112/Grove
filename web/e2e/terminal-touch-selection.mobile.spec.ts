import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiCall, ensureProjects, login, openProjectTerminal } from "./helpers";

async function touch(page: Page, steps: { type: "touchStart" | "touchMove" | "touchEnd"; x?: number; y?: number; waitMs?: number }[]) {
    const cdp = await page.context().newCDPSession(page);
    try {
        for (const step of steps) {
            await cdp.send("Input.dispatchTouchEvent", { type: step.type, touchPoints: step.type === "touchEnd" ? [] : [{ x: step.x!, y: step.y! }] });
            if (step.waitMs) await page.waitForTimeout(step.waitMs);
        }
    } finally { await cdp.detach(); }
}

test("길게 눌러 끌면 터미널 출력을 선택·복사하고 클립보드를 붙여넣지 않는다", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.addInitScript(() => {
        const read = navigator.clipboard.readText.bind(navigator.clipboard);
        Object.defineProperty(navigator.clipboard, "readText", {
            value: () => { document.body.dataset.terminalClipboardRead = "true"; return read(); },
        });
    });
    const { a } = await ensureProjects();
    const name = `touch-${randomUUID()}`;
    const terminal = await apiCall<{ id: string }>("POST", `/projects/${a.id}/terminals`, { name });
    try {
        await login(page);
        await openProjectTerminal(page, a.name, name);
        const view = page.getByTestId("terminal-view").filter({ visible: true });
        await expect(view).toHaveAttribute("data-conn", "open");
        await view.locator(".xterm").click();
        await page.keyboard.type("stty -echo; printf '\\033[2J\\033[Hcopy-%s next\\n' \"$((40+2))\"");
        await page.keyboard.press("Enter");
        const text = view.locator(".xterm-rows > div").first().locator("span").filter({ hasText: "copy-42" });
        await expect(text).toBeVisible();
        const box = (await text.boundingBox())!;
        await page.evaluate(() => navigator.clipboard.writeText("PASTE-ME"));

        // 길게 누르기만 하면 손가락 아래 단어를 선택해 복사한다.
        const y = box.y + box.height / 2;
        await touch(page, [{ type: "touchStart", x: box.x + 3, y, waitMs: 700 }, { type: "touchEnd" }]);
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("copy-42");

        // 길게 누른 뒤 끌면 범위를 넓힌다.
        await page.evaluate(() => navigator.clipboard.writeText("PASTE-ME"));
        await touch(page, [
            { type: "touchStart", x: box.x + 3, y, waitMs: 700 },
            { type: "touchMove", x: box.x + box.width / 2, y },
            { type: "touchMove", x: box.x + box.width * 1.6, y },
            { type: "touchEnd" },
        ]);
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("copy-42 next");

        // 브라우저가 길게 누르기로 보내는 터치 contextmenu도 붙여넣기로 처리하지 않는다.
        await view.locator(".xterm").evaluate((element) => {
            delete document.body.dataset.terminalClipboardRead;
            element.dispatchEvent(new PointerEvent("contextmenu", { pointerType: "touch", bubbles: true, cancelable: true }));
        });
        await page.waitForTimeout(300);
        await expect(page.locator("body")).not.toHaveAttribute("data-terminal-clipboard-read", "true");
        await expect(view.locator(".xterm-rows")).not.toContainText("PASTE-ME");
    } finally {
        await apiCall("POST", `/terminals/${terminal.id}/kill`);
    }
});
