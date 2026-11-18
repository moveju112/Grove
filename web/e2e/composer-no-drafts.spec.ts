import { expect, test } from "@playwright/test";
import { apiCall, closeModelSettings, composerOption, ensureProjects, login, modelSettings, startProjectConversation } from "./helpers";

for (const width of [390, 1280]) {
    test.describe(`${width}px 초안 없는 입력창`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });
        test("이전 초안을 읽지 않고 미전송 글·첨부를 저장하지 않으며 모델 설정은 이름으로 연다", async ({ page }, info) => {
            const { a } = await ensureProjects();
            const legacyKey = `grove.draft.project:${a.id}#closed-tab`;
            await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({ text: "old draft", baseRevision: 0, updatedAt: 1 })), { key: legacyKey });
            const draftRequests: string[] = [];
            page.on("request", (r) => { if (r.url().includes("/drafts/")) draftRequests.push(r.url()); });
            await login(page);
            if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByTestId("project-row").getByRole("button", { name: a.name, exact: true }).click();
            const view = page.getByTestId("project-view").filter({ visible: true });
            await startProjectConversation(view);
            await expect(view.getByLabel("메시지 입력")).toHaveValue("");
            await expect(view.getByRole("button", { name: /초안|다른 입력 사본/ })).toHaveCount(0);
            await composerOption(view, "보내기 방식", "save");
            await view.getByLabel("메시지 입력").fill("not persisted composer input");
            await view.getByTestId("attachment-picker").locator('input[type="file"]').setInputFiles({
                name: "not-persisted.txt", mimeType: "text/plain", buffer: Buffer.from("unsubmitted attachment"),
            });
            await expect(view.getByLabel("선택한 첨부파일")).toContainText("not-persisted.txt");
            const values = await page.evaluate(() => JSON.stringify(Object.values(localStorage)));
            expect(values).not.toContain("not persisted composer input");
            expect(values).not.toContain("not-persisted.txt");
            expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("grove.send.")))).toEqual([]);
            const trigger = view.getByRole("button", { name: "모델 설정", exact: true });
            await expect(trigger.locator("svg")).toHaveCount(0);
            await modelSettings(view);
            await closeModelSettings(view);
            await page.screenshot({ path: info.outputPath("composer-no-drafts.png") });
            await page.reload();
            await expect(page.getByTestId("conn")).toHaveText("연결됨");
            await startProjectConversation(view);
            await expect(view.getByLabel("메시지 입력")).toHaveValue("");
            await expect(view.getByLabel("선택한 첨부파일")).toHaveCount(0);
            expect(draftRequests).toEqual([]);
            const sessions = await apiCall<{ items: unknown[] }>("GET", `/projects/${a.id}/sessions?q=not%20persisted%20composer%20input`);
            expect(sessions.items).toEqual([]);
        });
    });
}
