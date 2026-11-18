import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiCall, ensureProjects, login, openDetails, openTool } from "./helpers";

// 공통 설정을 바꾸지 않고 이 파일만 모바일 viewport·터치 입력으로 실행한다.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function paste(textarea: Locator, text: string) {
    await textarea.evaluate((element, value) => {
        const data = new DataTransfer();
        data.setData("text/plain", value);
        element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    }, text);
}

async function compose(textarea: Locator, text: string) {
    await textarea.evaluate((element, value) => {
        const input = element as HTMLTextAreaElement;
        input.value = "";
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        for (const data of ["ㅎ", "하", value]) {
            input.value = data;
            input.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data }));
            input.dispatchEvent(new InputEvent("input", { bubbles: true, data, inputType: "insertText", isComposing: true }));
        }
        input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: value }));
        input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    }, text);
}

async function openTerminal(page: Page) {
    const { a } = await ensureProjects();
    const name = `input-${randomUUID()}`;
    const terminal = await apiCall<{ id: string }>("POST", `/projects/${a.id}/terminals`, { name });
    await login(page);
    // 좁은 화면은 사이드바가 닫힌 상태로 시작한다.
    const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
    if (await sidebar.getAttribute("aria-expanded") === "false") await sidebar.click();
    await page.getByTestId("project-row").getByRole("button", { name: a.name, exact: true }).click();
    const list = page.getByTestId("terminal-list");
    await openTool(page, "터미널");
    await openDetails(list);
    await list.getByRole("button", { name, exact: true }).click();
    const view = page.getByTestId("terminal-view");
    await expect(view).toHaveAttribute("data-conn", "open");
    return { view, id: terminal.id };
}

test("모바일 보조키·한글 확정·붙여넣기를 실제 PTY 바이트로 한 번씩 전달한다", async ({ page }, info) => {
    const { view, id } = await openTerminal(page);
    try {
        const textarea = view.locator("textarea.xterm-helper-textarea");
        await view.locator(".xterm").click();
        // raw PTY에서 입력 누적 바이트를 출력한다. shell의 에코나 로컬 WS mock을 검사하지 않는다.
        const program = "import os,tty; tty.setraw(0); print(\"\\x1b[?2004hINPUT-\"+\"READY\",flush=True); data=b\"\"; exec(\"while True:\\n data+=os.read(0,4096)\\n print(\\\"\\\\r\\\\nHEX:\\\"+data.hex(),flush=True)\")";
        await page.keyboard.type(`python3 -u -c '${program}'`);
        await page.keyboard.press("Enter");
        const output = view.locator(".xterm-rows");
        await expect(output).toContainText("INPUT-READY");
        let bytes = "";
        const received = async (hex: string) => {
            bytes += hex;
            await expect(output).toContainText(`HEX:${bytes}`);
        };
        const keys = view.getByRole("group", { name: "보조 키" });
        await keys.getByRole("button", { name: "Ctrl", exact: true }).tap();
        await expect(keys.getByRole("button", { name: "Ctrl", exact: true })).toHaveAttribute("aria-pressed", "true");
        await page.keyboard.type("c");
        await received("03");
        await page.keyboard.type("c");
        await received("63");
        await expect(keys.getByRole("button", { name: "Ctrl", exact: true })).toHaveAttribute("aria-pressed", "false");
        await keys.getByRole("button", { name: "Esc", exact: true }).tap();
        await received("1b");
        await keys.getByRole("button", { name: "Tab", exact: true }).tap();
        await received("09");
        await keys.getByRole("button", { name: "Alt", exact: true }).tap();
        await page.keyboard.type("x");
        await received("1b78");
        for (const [name, hex] of [["위 화살표", "1b5b41"], ["아래 화살표", "1b5b42"], ["왼쪽 화살표", "1b5b44"], ["오른쪽 화살표", "1b5b43"]] as const) {
            await keys.getByRole("button", { name, exact: true }).tap();
            await received(hex);
        }
        await compose(textarea, "한글");
        await received("ed959ceab880");
        await paste(textarea, "붙임");
        await received("1b5b3230307eebb699ec9e841b5b3230317e");
        await paste(textarea, "reject\nthis");
        const confirmation = page.getByRole("dialog", { name: "여러 줄 붙여넣기", exact: true });
        await expect(confirmation).toBeVisible();
        await confirmation.getByRole("checkbox", { name: "다시 묻지 않기", exact: true }).check();
        await page.screenshot({ path: info.outputPath("terminal-paste-confirm-390.png"), animations: "disabled" });
        await confirmation.getByRole("button", { name: "취소", exact: true }).click();
        await paste(textarea, "a\nb");
        await expect(confirmation).toBeVisible();
        await expect(confirmation.getByRole("checkbox", { name: "다시 묻지 않기", exact: true })).not.toBeChecked();
        await confirmation.getByRole("button", { name: "붙여넣기", exact: true }).click();
        await received("1b5b3230307e610d621b5b3230317e");
        // 다음 입력의 누적 값이 취소한 paste 및 중복 조합 문자열의 부재도 확인한다.
        await page.keyboard.press("Control+C");
        await received("03");
        await keys.getByRole("button", { name: "Alt", exact: true }).tap();
        await page.reload();
        await expect(view).toHaveAttribute("data-conn", "open");
        await view.locator(".xterm").click();
        await page.keyboard.type("z");
        await received("7a");
    } finally {
        await apiCall("POST", `/terminals/${id}/kill`);
    }
});
