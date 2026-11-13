import { expect, test } from "@playwright/test";
import { login } from "./helpers";

for (const width of [320, 390, 1280]) {
    test.describe(`${width}px 설정`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760 });
        for (const theme of ["light", "dark"] as const) {
            test(`${theme}: 메뉴·입력 정렬과 테마 저장`, async ({ page }, info) => {
                await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
                await login(page);
                await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
                await page.evaluate(() => document.fonts.ready);
                const settings = page.locator(".settings");
                const search = settings.getByLabel("설정 검색");
                const inputBox = await search.boundingBox();
                expect(inputBox!.height).toBeLessThanOrEqual(40);
                expect(inputBox!.width).toBeGreaterThanOrEqual(150);
                for (const name of ["모델·키", "에이전트·워크플로우", "화면·입력", "기기·연결", "서버·데이터"]) {
                    const button = settings.getByRole("button", { name, exact: true });
                    await button.click();
                    await expect(button).toHaveAttribute("aria-current", "page");
                    expect((await button.boundingBox())!.height).toBeLessThanOrEqual(40);
                    const layout = await settings.evaluate((el) => {
                        const edge = el.getBoundingClientRect().right;
                        return {
                            fits: el.scrollWidth <= el.clientWidth + 1,
                            width: el.clientWidth,
                            scroll: el.scrollWidth,
                            spill: Array.from(el.querySelectorAll<HTMLElement>("*")).filter((node) =>
                                node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === "visible")
                                .slice(-12).map((node) => ({ tag: node.tagName, class: node.className, width: node.clientWidth, scroll: node.scrollWidth })),
                            overflow: Array.from(el.querySelectorAll("*")).filter((node) =>
                                !node.closest(".settings-menu") && node.getBoundingClientRect().right > edge + 1)
                                .slice(0, 12).map((node) => ({ tag: node.tagName, class: node.className, width: node.getBoundingClientRect().width })),
                        };
                    });
                    await page.screenshot({ path: info.outputPath(`menu-${name}.png`) });
                    expect(layout.fits, `${name}: ${JSON.stringify(layout)}`).toBe(true);
                    expect(await settings.locator(".settings-body").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
                }
                await settings.getByRole("button", { name: "모델·키", exact: true }).click();
                await expect(settings.getByTestId("setting-model.default_profile")).toBeVisible();
                await expect(settings.getByTestId("settings-area-reset").getByRole("button")).toBeHidden();
                if (width < 760) {
                    const menuBox = await settings.locator(".settings-menu").boundingBox();
                    const bodyBox = await settings.locator(".settings-body").boundingBox();
                    expect(menuBox!.y).toBeGreaterThanOrEqual(inputBox!.y + inputBox!.height);
                    expect(bodyBox!.y).toBeGreaterThan(menuBox!.y + menuBox!.height);
                }
                await page.screenshot({ path: info.outputPath("models.png") });
                await settings.getByRole("button", { name: "화면·입력", exact: true }).click();
                await settings.getByLabel("테마", { exact: true }).selectOption(theme);
                await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
                await page.screenshot({ path: info.outputPath("display.png") });
                await settings.getByLabel("글자 크기", { exact: true }).focus();
                await page.keyboard.press("End");
                await expect(settings.getByLabel("글자 크기", { exact: true })).toHaveValue("20");
                expect(await settings.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
                await page.reload();
                await search.fill("테마");
                await expect(settings.getByLabel("테마", { exact: true })).toHaveValue(theme);
            });
        }
    });
}
