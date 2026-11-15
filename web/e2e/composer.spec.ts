import { expect, test, type Locator } from "@playwright/test";
import { apiCall, composerOption, ensureProjects, login } from "./helpers";

// UI-019: Enter/Shift+Enter·Ctrl+Enter, 한글 IME 조합 중 Enter, 붙여넣기.
async function keyEnter(el: Locator, init: { keyCode?: number; isComposing?: boolean } = {}) {
    await el.evaluate((node, i) => {
        const e = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, isComposing: !!i.isComposing });
        if (i.keyCode) Object.defineProperty(e, "keyCode", { get: () => i.keyCode });
        node.dispatchEvent(e);
    }, init);
}

test("입력창 키: Enter 줄바꿈·Ctrl+Enter 보내기, Enter 보내기 설정과 한글 조합 중 Enter, 붙여넣기", async ({ page }) => {
    const { a } = await ensureProjects();
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "입력 키 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.evaluate(() => localStorage.removeItem("grove.device.prefs"));
    await page.reload();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /입력 키 대화/ }).first().click();
    const view = page.getByTestId("session-view");
    await composerOption(view, "보내기 방식", "save");
    const box = view.getByLabel("메시지 입력");
    const sent = view.getByTestId("msg-user");

    // 기본: Enter는 줄바꿈, Ctrl+Enter로 보낸다
    await box.fill("");
    await box.pressSequentially("첫 줄");
    await box.press("Enter");
    await box.pressSequentially("둘째 줄");
    await expect(box).toHaveValue("첫 줄\n둘째 줄");
    await expect(sent).toHaveCount(0);
    await box.press("Control+Enter");
    await expect(sent).toHaveCount(1);
    await expect(sent.last()).toContainText("둘째 줄");
    await expect(box).toHaveValue("");

    // Enter로 보내기 설정
    await page.evaluate(() => localStorage.setItem("grove.device.prefs", JSON.stringify({ enterToSend: true })));
    await page.reload();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /입력 키 대화/ }).first().click();
    await composerOption(view, "보내기 방식", "save");
    await expect(box).toHaveAttribute("enterkeyhint", "send");
    await box.fill("한글 조합");
    // 조합 중 Enter, 조합을 끝내는 Enter(keyCode 229)는 보내지 않는다
    await box.dispatchEvent("compositionstart");
    await keyEnter(box);
    await box.dispatchEvent("compositionend");
    await keyEnter(box, { isComposing: true });
    await keyEnter(box, { keyCode: 229 });
    await page.waitForTimeout(200);
    await expect(sent).toHaveCount(1);
    await box.press("Shift+Enter");
    await box.pressSequentially("끝");
    await expect(box).toHaveValue("한글 조합\n끝");
    await box.press("Enter");
    await expect(sent).toHaveCount(2);
    await expect(sent.last()).toContainText("한글 조합");

    // 붙여넣기: 여러 줄 평문이 그대로 들어간다
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() => navigator.clipboard.writeText("a\n\tb <b>x</b>"));
    await box.focus();
    await box.press("Control+V");
    await expect(box).toHaveValue("a\n\tb <b>x</b>");
    await page.evaluate(() => localStorage.removeItem("grove.device.prefs"));
});
