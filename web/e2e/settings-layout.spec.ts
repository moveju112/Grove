import { expect, test } from "@playwright/test";
import { login, openSettings, selectChoice } from "./helpers";

for (const width of [320, 390, 1280]) {
    test.describe(`${width}px 설정`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760 });
        for (const theme of ["light", "dark"] as const) {
            test(`${theme}: 메뉴·입력 정렬과 테마 저장`, async ({ page }, info) => {
                await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
                await login(page);
                await openSettings(page);
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
                    const cards = await settings.locator('[data-ui="settings-group"]').evaluateAll((nodes) => nodes
                        .filter((node) => node.getBoundingClientRect().height > 0)
                        .map((node) => {
                            const style = getComputedStyle(node);
                            return {
                                title: node.querySelector("h2")?.textContent,
                                edges: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map(parseFloat),
                                radius: parseFloat(style.borderTopLeftRadius),
                            };
                        }));
                    expect(cards.length).toBeGreaterThan(0);
                    for (const card of cards) {
                        expect(card.edges.every((edge) => edge >= 1), `${card.title}: 설정 영역은 네 면이 구분돼야 한다`).toBe(true);
                        expect(card.radius).toBeGreaterThanOrEqual(8);
                    }
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
                await expect(settings.getByTestId("settings-area-reset").getByRole("button", { name: /기본값 복원/ })).toBeVisible();
                await expect(settings.getByTestId("settings-area-reset").getByRole("combobox")).toHaveCount(0);
                if (width < 760) {
                    const menuBox = await settings.locator(".settings-menu").boundingBox();
                    const bodyBox = await settings.locator(".settings-body").boundingBox();
                    expect(menuBox!.y).toBeGreaterThanOrEqual(inputBox!.y + inputBox!.height);
                    expect(menuBox!.height).toBeLessThanOrEqual(44);
                    expect(bodyBox!.y).toBeGreaterThan(menuBox!.y + menuBox!.height);
                    expect(bodyBox!.y - menuBox!.y - menuBox!.height).toBeLessThanOrEqual(32);
                }
                await page.screenshot({ path: info.outputPath("models.png") });
                await settings.getByRole("button", { name: "화면·입력", exact: true }).click();
                await selectChoice(settings.getByRole("combobox", { name: "테마", exact: true }), theme);
                await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
                await page.screenshot({ path: info.outputPath("display.png") });
                await settings.getByRole("slider", { name: "글자 크기", exact: true }).focus();
                await page.keyboard.press("End");
                await expect(settings.getByRole("slider", { name: "글자 크기", exact: true })).toHaveAttribute("aria-valuenow", "20");
                expect(await settings.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
                await page.reload();
                await search.fill("테마");
                await expect(settings.getByRole("combobox", { name: "테마", exact: true })).toHaveAttribute("data-selected-value", theme);
            });
        }
    });
}
