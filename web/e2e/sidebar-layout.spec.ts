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
                // 연결된 계정이 없으면 사용 한도 영역과 빈 막대를 표시하지 않는다.
                await page.route("**/api/v1/usage/accounts", (route) => route.fulfill({ json: { accounts: [] } }));
                await login(page);
                await page.evaluate(() => document.fonts.ready);
                expect(await page.evaluate(() => [...document.fonts].some((font) => font.family === "Pretendard" && font.status === "loaded"))).toBe(true);
                const toggle = page.getByRole("button", { name: "사이드바", exact: true });
                if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
                const side = page.getByRole("complementary", { name: "탐색" });
                await expect(side.getByText("최근 항목 없음", { exact: true })).toBeVisible();
                const recentScroll = side.getByTestId("recent-scroll");
                const emptyRecentHeight = (await recentScroll.boundingBox())!.height;
                expect(emptyRecentHeight).toBe(144);
                await expect(side.getByTestId("bots-panel")).toHaveCount(0);
                await expect(side.getByLabel("최근 검색·필터")).toHaveCount(0);
                await expect(side.getByRole("combobox", { name: "프로젝트 정렬", exact: true })).toBeHidden();
                await expect(side.getByTestId("sidebar-usage")).toHaveCount(0);
                await expect(side.getByText("프로젝트를 추가하세요.")).toHaveCount(0);
                const projectHead = await side.getByRole("heading", { name: "프로젝트", exact: true }).boundingBox();
                const recentHead = await side.getByRole("heading", { name: "최근", exact: true }).boundingBox();
                const ranges = await side.getByRole("group", { name: "시간 범위" }).boundingBox();
                expect(projectHead!.x).toBe(recentHead!.x);
                expect(Math.abs(recentHead!.y + recentHead!.height / 2 - ranges!.y - ranges!.height / 2)).toBeLessThan(2);
                const navigation = width < 760 ? page.getByTestId("mobile-drawer-left") : side;
                const add = navigation.getByRole("button", { name: "프로젝트·폴더 추가", exact: true });
                await expect(add).toHaveCount(1);
                if (width < 760) {
                    await expect(side.getByRole("button", { name: "프로젝트·폴더 추가", exact: true })).toHaveCount(0);
                    await expect(side.getByRole("button", { name: "설정", exact: true })).toHaveCount(0);
                    await expect(side.getByRole("button", { name: "사용량", exact: true })).toHaveCount(0);
                    const usage = navigation.getByTestId("mobile-drawer-header").getByRole("button", { name: "사용량", exact: true });
                    await expect(usage).toBeVisible();
                    await expect(usage).toHaveText("");
                } else {
                    const settings = side.getByRole("button", { name: "설정", exact: true });
                    const usage = side.getByRole("button", { name: "사용량", exact: true });
                    const options = side.getByRole("button", { name: "프로젝트 목록 옵션", exact: true });
                    await expect(page.getByRole("banner").getByRole("button", { name: "설정", exact: true })).toHaveCount(0);
                    await expect(usage).toHaveText("");
                    const [plus, more, meter, gear, collapse] = await Promise.all(
                        [add, options, usage, settings, toggle].map((button) => button.boundingBox()),
                    );
                    expect(plus!.x).toBeGreaterThan(projectHead!.x);
                    expect(plus!.x + plus!.width).toBeLessThanOrEqual(more!.x);
                    expect(Math.abs(plus!.y + plus!.height / 2 - more!.y - more!.height / 2)).toBeLessThan(2);
                    expect(meter!.y).toBe(gear!.y);
                    expect(gear!.y).toBe(collapse!.y);
                    expect(meter!.x).toBeLessThan(gear!.x);
                    expect(gear!.x).toBeLessThan(collapse!.x);

                    await usage.click();
                    const dialog = page.getByRole("dialog", { name: "사용량", exact: true });
                    await expect(dialog).toBeVisible();
                    await page.keyboard.press("Escape");
                    await expect(dialog).toBeHidden();
                    await expect(usage).toBeFocused();
                }
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
                expect(bounds!.height).toBe(24);
                expect((await recentScroll.boundingBox())!.height).toBe(emptyRecentHeight);
                await expect(row.getByRole("button", { name: "최근에서 숨기기", exact: true })).toBeVisible();
                await expect(row.getByRole("button")).toHaveCount(2);
                await page.screenshot({ path: info.outputPath("populated.png") });
            });
        }
    });
}
