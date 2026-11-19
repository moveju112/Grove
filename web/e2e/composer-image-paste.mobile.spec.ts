import { expect, test } from "@playwright/test";
import { apiCall, composerOption, ensureProjects, login, sessionView } from "./helpers";

test.use({ userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/157.0.0.0 Mobile Safari/537.36" });

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
    await input.evaluate((element) => {
        const png = atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=");
        const data = new DataTransfer();
        data.items.add(new File([Uint8Array.from(png, (c) => c.charCodeAt(0))], "screenshot.png", { type: "image/png" }));
        element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    });
    await expect(view.getByTestId("attachment-selection").getByRole("img", { name: "screenshot.png" })).toBeVisible();
    await expect(input.locator("img")).toHaveCount(0);
    await expect.poll(() => input.innerText()).toBe(draft);
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-user").last().getByRole("img", { name: "screenshot.png" })).toBeVisible();
    await expect.poll(() => input.innerText()).toBe("");
});
