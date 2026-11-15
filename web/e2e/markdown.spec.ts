import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, script, state } from "./helpers";

// UI-010·011, SEC-020: 모델 답의 Markdown은 표시하되 HTML·스크립트·위험 링크는 실행되지 않는다.
test("모델 답의 Markdown을 표시하고 HTML·스크립트·javascript 링크는 실행하지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "마크다운 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
        dialogs.push(d.message());
        void d.dismiss();
    });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /마크다운 대화/ }).first().click();
    const view = page.getByTestId("session-view");
    const answer = [
        "## 결과",
        "",
        "**굵게** 와 `코드` 그리고 [문서](https://example.com/doc)",
        "",
        "- 목록 하나",
        "- 목록 둘",
        "",
        "1. 순서 하나",
        "2. 순서 둘",
        "",
        "| 항목 | 값 |",
        "|---|---|",
        "| a | 1 |",
        "",
        "```js",
        "const x = '<b>';",
        "```",
        "",
        "<img src=x onerror=alert(1)> <script>alert(2)</script> [위험](javascript:alert(3))",
    ].join("\n");
    await script({ frames: frames.text([answer]) });
    await composerOption(view, "보내기 방식", "model");
    await view.getByLabel("메시지 입력").fill("마크다운으로 답해");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const msg = view.getByTestId("msg-assistant").last();
    await expect(msg.locator("h4")).toHaveText("결과", { timeout: 15_000 });
    await expect(msg.locator("strong")).toHaveText("굵게");
    await expect(msg.locator("ul").getByRole("listitem")).toHaveText(["목록 하나", "목록 둘"]);
    await expect(msg.locator("ol").getByRole("listitem")).toHaveText(["순서 하나", "순서 둘"]);
    await expect(msg.locator("table td").first()).toHaveText("a");
    await expect(msg.getByRole("link", { name: "문서" })).toHaveAttribute("href", "https://example.com/doc");
    await expect(msg.getByRole("link", { name: "문서" })).toHaveAttribute("rel", /noopener/);
    // 외부 링크는 실제 목적지 host를 함께 보인다(UI-031)
    await expect(msg.getByRole("link", { name: "문서" }).getByTestId("link-dest")).toHaveText("↗ example.com");
    await expect(msg.getByTestId("md-code")).toContainText("const x = '<b>';");
    // 위험한 입력은 글자로만
    await expect(msg).toContainText("<script>alert(2)</script>");
    await expect(msg.locator("img")).toHaveCount(0);
    await expect(msg.locator("script")).toHaveCount(0);
    await expect(msg.getByRole("link", { name: "위험" })).toHaveCount(0);
    // 코드 복사
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await msg.getByTestId("md-code").getByRole("button", { name: "복사" }).click();
    await expect(msg.getByTestId("md-code").getByRole("button", { name: "복사됨" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("const x = '<b>';");
    await page.waitForTimeout(300);
    expect(dialogs, "스크립트가 실행되면 alert가 뜬다").toEqual([]);
    // 메시지 복사는 표시된 글이 아니라 저장된 Markdown 원문을 복사한다(UI-011)
    await msg.getByTestId("msg-copy").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(answer);
});

test("답 안의 파일:줄 참조를 누르면 오른쪽에 그 파일을 열고 해당 줄을 선택한다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    writeFileSync(join(state().projA, "ref-target.md"), "첫째 줄\n둘째 줄\n찾는 줄입니다\n넷째 줄\n");
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "파일 참조 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /파일 참조 대화/ }).first().click();
    const view = page.getByTestId("session-view");
    await script({ frames: frames.text(["수정할 곳은 `ref-target.md:3` 이고 `/etc/passwd`는 링크가 아니다."]) });
    await composerOption(view, "보내기 방식", "model");
    await view.getByLabel("메시지 입력").fill("어디 고쳐?");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const msg = view.getByTestId("msg-assistant").last();
    await expect(msg.getByTestId("file-ref")).toHaveCount(1, { timeout: 15_000 });
    await msg.getByTestId("file-ref").click();
    await expect(page.getByTestId("pane")).toHaveCount(2);
    const files = page.getByTestId("files-view");
    const area = files.getByLabel("파일 내용");
    await expect(area).toHaveValue(/찾는 줄입니다/);
    const sel = await area.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
    expect(sel).toBe("찾는 줄입니다");
});
