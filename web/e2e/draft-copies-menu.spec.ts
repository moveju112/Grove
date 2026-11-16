import { expect, test } from "@playwright/test";
import { ensureProjects, inputOptions, login, openDetails, startProjectConversation } from "./helpers";

for (const mobile of [false, true]) {
    test(`이전 입력 사본은 ${mobile ? "390px" : "desktop"} 기본 입력창에 표시하지 않고 초안 메뉴에서 복구한다`, async ({ page }, info) => {
        await page.setViewportSize({ width: mobile ? 390 : 1280, height: 844 });
        const { a } = await ensureProjects();
        const text = "보존해야 하는 이전 탭 초안";
        const key = `grove.draft.project:${a.id}#closed-tab`;
        await page.addInitScript(({ key, text }) => {
            localStorage.setItem(key, JSON.stringify({ text, baseRevision: 0, updatedAt: 1 }));
        }, { key, text });
        await login(page);
        if (mobile) await page.getByRole("button", { name: "사이드바", exact: true }).click();
        await page.getByTestId("project-row").getByRole("button", { name: a.name, exact: true }).click();
        if (mobile) await expect(page.getByTestId("mobile-drawer-left")).toBeHidden();
        const view = page.getByTestId("project-view").filter({ visible: true });
        await startProjectConversation(view);
        await expect(view.getByLabel("메시지 입력")).toHaveValue("");
        await expect(page.getByText("다른 입력 사본 1개", { exact: true })).toBeHidden();
        expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).text, key)).toBe(text);
        await page.screenshot({ path: info.outputPath(`project-draft-${mobile ? "390" : "desktop"}.png`) });
        await inputOptions(view);
        await openDetails(view.getByTestId("draft-copies"));
        await view.getByTestId("draft-copy").getByRole("button", { name: "이 사본 이어받기", exact: true }).click();
        await page.keyboard.press("Escape");
        await expect(view.getByLabel("메시지 입력")).toHaveValue(text);
    });
}
