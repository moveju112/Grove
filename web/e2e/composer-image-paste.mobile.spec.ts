import { expect, test } from "@playwright/test";
import { apiCall, composerOption, ensureProjects, login, sessionView } from "./helpers";

test.use({ userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/157.0.0.0 Mobile Safari/537.36" });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

test("Android 입력은 붙여넣은 사진만 첨부하고 본문은 평문으로 보존한다", async ({ page }) => {
    const { a } = await ensureProjects();
    const title = "Android 사진 붙여넣기";
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
    if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title, exact: true }).first().click();
    const view = sessionView(page, session.id);
    await composerOption(view, "보내기 방식", "save");
    const input = view.getByRole("textbox", { name: "메시지 입력", exact: true });
    await expect(input).toHaveAttribute("contenteditable", "true");
    await input.tap();
    await expect(input).toBeFocused();
    await expect(input).toHaveCSS("outline-style", "none");
    await input.fill("첫 줄");
    await input.press("End");
    await input.press("Enter");
    await input.pressSequentially("둘째 줄");
    await expect.poll(() => input.innerText()).toBe("첫 줄\n둘째 줄");

    await input.evaluate((element) => {
        const data = new DataTransfer();
        data.setData("text/plain", " <b>평문</b>");
        data.setData("text/html", " <b>서식</b>");
        element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    });
    const draft = "첫 줄\n둘째 줄 <b>평문</b>";
    await expect.poll(() => input.innerText()).toBe(draft);
    await expect(input.locator("b")).toHaveCount(0);

    // Android Chrome의 commitContent와 같은 파일형 paste payload를 보낸다.
    await input.evaluate((element, png) => {
        const data = new DataTransfer();
        data.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "screenshot.png", { type: "image/png" }));
        element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    }, png);
    await expect(view.getByTestId("attachment-selection").getByRole("img", { name: "screenshot.png" })).toBeVisible();
    await expect(input.locator("img")).toHaveCount(0);
    await expect.poll(() => input.innerText()).toBe(draft);
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-user").last().getByRole("img", { name: "screenshot.png" })).toBeVisible();
    await expect.poll(() => input.innerText()).toBe("");
});

test("키보드 이벤트 없이 첨부 메뉴에서 실제 브라우저 클립보드 사진을 읽는다", async ({ page }, testInfo) => {
    const { a } = await ensureProjects();
    const title = "클립보드 첨부 버튼";
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await login(page);
    const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
    if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title, exact: true }).first().click();
    const view = sessionView(page, session.id);
    const input = view.getByRole("textbox", { name: "메시지 입력", exact: true });
    await input.tap();
    await input.fill("보존할 본문");
    await expect.poll(() => input.innerText()).toBe("보존할 본문");
    const trigger = view.getByRole("button", { name: "파일 첨부", exact: true });
    const paste = page.getByRole("button", { name: "클립보드 사진 붙여넣기", exact: true });

    await page.evaluate(() => navigator.clipboard.writeText("첨부하지 않을 텍스트"));
    await trigger.tap();
    await expect(page.getByRole("button", { name: "파일 선택", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("clipboard-390.png"), animations: "disabled" });
    await paste.tap();
    const issue = view.getByRole("status").filter({ hasText: "붙여넣을 사진을 찾지 못했습니다" });
    await expect(issue).toContainText("항목 1개 · 형식 text/plain");
    await expect(issue).not.toContainText("첨부하지 않을 텍스트");
    await expect(view.getByTestId("attachment-selection")).toHaveCount(0);
    await expect.poll(() => input.innerText()).toBe("보존할 본문");

    await page.evaluate(() => Object.defineProperty(navigator.clipboard, "read", {
        configurable: true, value: async () => [],
    }));
    await trigger.tap();
    await paste.tap();
    await expect(issue).toContainText("항목 0개 · 형식 없음");
    await page.evaluate(() => Reflect.deleteProperty(navigator.clipboard, "read"));

    await page.evaluate(async (png) => {
        const blob = new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: "image/png" });
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    }, png);
    await trigger.tap();
    await paste.tap();
    const image = view.getByTestId("attachment-selection").getByRole("img", { name: "clipboard.png", exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => input.innerText()).toBe("보존할 본문");

    await trigger.tap();
    const chooserEvent = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "파일 선택", exact: true }).tap();
    expect(await chooserEvent).toBeTruthy();
});
