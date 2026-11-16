import { expect, test } from "@playwright/test";
import { login, openSettings } from "./helpers";

for (const width of [390, 1400]) {
    test.describe(`${width}px 편집 설정`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
        test("역할 설명을 접고 편집 목록과 초안을 유지한다", async ({ page }, info) => {
            await page.emulateMedia({ reducedMotion: "reduce" });
            await login(page);
            await openSettings(page);
            await page.getByLabel("설정 검색", { exact: true }).fill("에이전트·워크플로우 편집");
            const overview = page.getByTestId("agent-overview");
            const details = overview.getByRole("button", { name: "모델·실행 정보", exact: true });
            await expect(details).toHaveAttribute("aria-expanded", "false");
            await expect(overview.getByRole("heading", { name: "모델 연결", exact: true })).toBeHidden();
            const list = page.getByTestId("definition-list");
            const worker = list.getByRole("button", { name: /^Worker/ });
            await expect(worker).toBeVisible();
            const labelOffset = await worker.evaluate((node) => {
                const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                while (walker.nextNode()) {
                    if (walker.currentNode.textContent?.trim() !== "Worker") continue;
                    const range = document.createRange();
                    range.selectNodeContents(walker.currentNode);
                    return range.getBoundingClientRect().left - node.getBoundingClientRect().left;
                }
                throw new Error("Worker label missing");
            });
            expect(labelOffset).toBeLessThan(32);
            expect(await list.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
            await page.screenshot({ path: info.outputPath("editors-compact.png"), fullPage: true });
            await worker.click();
            const body = page.getByTestId("definition-editor").getByLabel("정의 본문", { exact: true });
            const original = await body.inputValue();
            await details.click();
            await expect(details).toHaveAttribute("aria-expanded", "true");
            await expect(overview.getByRole("heading", { name: "모델 연결", exact: true })).toBeVisible();
            await details.click();
            await expect(overview.getByRole("heading", { name: "모델 연결", exact: true })).toBeHidden();
            await expect(body).toHaveValue(original);
            await page.getByTestId("settings").getByRole("button", { name: "워크플로우", exact: true }).click();
            await expect(list.getByRole("button")).not.toHaveCount(0);
            await page.screenshot({ path: info.outputPath("workflows-compact.png"), fullPage: true });
        });
    });
}
