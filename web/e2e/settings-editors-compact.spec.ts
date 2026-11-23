import { expect, test } from "@playwright/test";
import { login, openSettings } from "./helpers";

for (const width of [390, 1400]) {
    test.describe(`${width}px 편집 설정`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
        test("역할 설명을 펼친 채 편집 목록과 초안을 유지한다", async ({ page }, info) => {
            await page.emulateMedia({ reducedMotion: "reduce" });
            await login(page);
            await openSettings(page);
            await page.getByLabel("설정 검색", { exact: true }).fill("위임 에이전트");
            const overview = page.getByTestId("agent-overview");
            await expect(overview.getByRole("button", { name: "역할 상세", exact: true })).toHaveCount(0);
            const roles = overview.getByRole("heading", { name: /등록된 역할/ });
            const list = page.getByTestId("definition-list");
            const worker = list.getByTestId("definition-worker").getByRole("button", { name: /^Worker / }).and(page.locator("[aria-pressed]"));
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
            await expect(roles).toBeVisible();
            await expect(overview.getByRole("heading", { name: "모델 연결", exact: true })).toHaveCount(0);
            await expect(overview.getByRole("heading", { name: "위임 실행 규칙", exact: true })).toHaveCount(0);
            await expect(body).toHaveValue(original);
            await page.getByLabel("설정 검색", { exact: true }).fill("");
            await page.getByTestId("settings").getByRole("button", { name: "워크플로우·메모리", exact: true }).click();
            await expect(page.getByRole("heading", { name: "워크플로우 정의", exact: true })).toBeVisible();
            await expect(list.getByRole("button")).not.toHaveCount(0);
            await page.screenshot({ path: info.outputPath("workflows-compact.png"), fullPage: true });
        });
    });
}
