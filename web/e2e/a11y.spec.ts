import { expect, test, type Page } from "@playwright/test";
import { audit } from "./a11y-audit";
import { frames } from "./fixture";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, script, selectChoice } from "./helpers";

// UI-029: 주요 화면의 이름 없는 조작 요소·글자 대비를 테마별로 점검하고, 키보드로 주요 흐름을 조작할 수 있는지 본다.
async function screens(page: Page, title: string) {
    const { a } = await ensureProjects();
    await ensureProfile();
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    return { a, s };
}

for (const theme of ["light", "dark", "soft"] as const) {
    test(`주요 화면에 이름 없는 조작 요소와 대비 부족 글자가 없다(${theme})`, async ({ page }) => {
        const title = `접근성 대화 ${theme} ${Date.now()}`;
        await screens(page, title);
        await login(page);
        await page.evaluate((t) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme: t })), theme);
        await page.reload();
        const problems: string[] = [];
        const check = async (where: string) => {
            const r = await audit(page);
            problems.push(...r.unnamed.map((x) => `${where} 이름 없음: ${x}`), ...r.contrast.map((x) => `${where} 대비: ${x}`));
        };
        await check("작업 공간");
        // 대화: 답·도구 결과·승인 카드·질문 카드가 있는 상태
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
        const view = page.getByTestId("session-view");
        await script({ frames: frames.tool("w1", "write", { path: `a11y-${theme}.txt`, content: "x" }) });
        await composerOption(view, "도구", true);
        await composerOption(view, "보내기 방식", "model");
        await view.getByLabel("메시지 입력").fill("파일 만들어");
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(view.getByTestId("approval")).toBeVisible({ timeout: 15_000 });
        await check("승인 대기 대화");
        await script({ frames: frames.tool("q1", "ask_user", { question: "어느 쪽?", options: [{ label: "A", description: "설명" }, { label: "B" }] }) });
        await view.getByTestId("approval").getByRole("button", { name: "승인" }).first().click();
        await expect(view.getByTestId("question")).toBeVisible({ timeout: 15_000 });
        await check("질문 대기 대화");
        await script({ frames: frames.text(["## 끝\n\n`코드`와 [링크](https://example.com)\n\n```js\nx\n```"]) });
        await selectChoice(view.getByTestId("question").getByLabel("답변 선택"), "A");
        await view.getByTestId("question").getByRole("button", { name: "답하기" }).click();
        await expect(view.getByTestId("msg-assistant").last()).toContainText("끝", { timeout: 15_000 });
        await composerOption(view, "도구", false);
        await check("완료된 대화");
        await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
        await check("설정");
        await page.evaluate(() => localStorage.removeItem("grove.device.prefs"));
        expect(problems, problems.join("\n")).toEqual([]);
    });
}

test("키보드만으로 대화를 열고 보내며, 초점이 보인다", async ({ page }) => {
    const title = `키보드 대화 ${Date.now()}`;
    await screens(page, title);
    await login(page);
    const item = page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first();
    await item.focus();
    // 초점 표시(:focus-visible 외곽선)
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(item).toBeFocused();
    const outline = await item.evaluate((e) => getComputedStyle(e).outlineStyle);
    expect(outline).not.toBe("none");
    await page.keyboard.press("Enter");
    const view = page.getByTestId("session-view");
    await expect(view).toBeVisible();
    const box = view.getByLabel("메시지 입력");
    await box.focus();
    await composerOption(view, "보내기 방식", "save");
    await box.focus();
    await page.keyboard.type("키보드로 쓴 글");
    await page.keyboard.press("Control+Enter");
    await expect(view.getByTestId("msg-user").filter({ hasText: "키보드로 쓴 글" })).toHaveCount(1);
});
