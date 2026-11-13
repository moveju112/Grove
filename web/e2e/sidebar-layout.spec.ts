import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login } from "./helpers";

for (const width of [390, 1280]) {
    test.describe(`${width}px 사이드바`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760 });
        for (const theme of ["light", "dark"] as const) {
            test(`${theme}: 빈 화면과 목록의 정렬·노출량`, async ({ page }, info) => {
                await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
                await page.route("**/api/v1/projects", (route) => route.fulfill({ json: [] }));
                await page.route("**/api/v1/recent?*", (route) => route.fulfill({ json: { items: [], total: 0, next_offset: null } }));
                await page.route("**/api/v1/usage/capacity", (route) => route.fulfill({ json: {
                    limits: { max_active: 4 }, server: { running: 0, waiting: 0 },
                } }));
                await page.route("**/api/v1/usage?*", (route) => route.fulfill({ json: {
                    rows: [], total: { input_tokens: 0, output_tokens: 0 }, pricing_versions: [],
                } }));
                await login(page);
                await page.evaluate(() => document.fonts.ready);
                expect(await page.evaluate(() => [...document.fonts].some((font) => font.family === "Pretendard" && font.status === "loaded"))).toBe(true);
                const toggle = page.getByRole("button", { name: "사이드바", exact: true });
                if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
                const side = page.getByRole("complementary", { name: "탐색" });
                await expect(side.locator(".recent-empty")).toBeVisible();
                await expect(side.getByTestId("bots-panel")).toHaveCount(0);
                await expect(side.getByLabel("최근 검색·필터")).toHaveCount(0);
                await expect(side.getByLabel("프로젝트 정렬")).toBeHidden();
                await expect(side.getByTestId("sidebar-usage")).toHaveCount(0);
                await expect(side.getByText("프로젝트를 추가하세요.")).toHaveCount(0);
                const projectHead = await side.locator(".side-section-head h2").boundingBox();
                const recentHead = await side.locator(".recent-head h2").boundingBox();
                const ranges = await side.getByRole("group", { name: "시간 범위" }).boundingBox();
                expect(projectHead!.x).toBe(recentHead!.x);
                expect(Math.abs(recentHead!.y + recentHead!.height / 2 - ranges!.y - ranges!.height / 2)).toBeLessThan(2);
                const icons = await side.locator(".side-nav > details > summary .icon").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().x));
                expect(icons.every((x) => x === projectHead!.x)).toBe(true);
                expect(await side.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
                await page.screenshot({ path: info.outputPath("empty.png") });

                await page.unroute("**/api/v1/projects");
                await page.unroute("**/api/v1/recent?*");
                const { a } = await ensureProjects();
                for (const title of ["사이드바 정렬 확인", "아주 긴 대화 제목도 목록 너비를 넘어가지 않도록 확인하는 대화"]) {
                    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
                    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
                }
                await page.reload();
                if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
                const row = side.getByTestId("recent-item").filter({ hasText: "아주 긴 대화 제목" }).first();
                await expect(row).toBeVisible();
                expect(await side.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
                const bounds = await row.boundingBox();
                expect(bounds!.height).toBeGreaterThanOrEqual(32);
                expect(bounds!.height).toBeLessThanOrEqual(40);
                await row.getByLabel("최근 항목 관리").click();
                await expect(row.getByRole("button", { name: "고정", exact: true })).toBeVisible();
                await row.getByLabel("최근 항목 관리").click();
                await page.screenshot({ path: info.outputPath("populated.png") });
            });
        }
    });
}
