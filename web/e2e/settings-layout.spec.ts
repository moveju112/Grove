import { expect, test } from "@playwright/test";
import { login, openSettings, selectChoice } from "./helpers";

for (const width of [320, 390, 1280]) {
    test.describe(`${width}px 설정`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760 });
        for (const theme of ["light", "dark"] as const) {
            test(`${theme}: 메뉴·입력 정렬과 테마 저장`, async ({ page }, info) => {
                await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
                await login(page);
                await openSettings(page, "local");
                await page.evaluate(() => document.fonts.ready);
                const settings = page.getByTestId("settings");
                const areas = settings.getByRole("tablist", { name: "설정 구분", exact: true });
                const local = areas.getByRole("tab", { name: "로컬 설정", exact: true });
                const daemon = areas.getByRole("tab", { name: "데몬 설정", exact: true });
                await expect(areas).toBeInViewport({ ratio: 1 });
                for (const tab of [local, daemon]) {
                    const box = (await tab.boundingBox())!;
                    expect(box.height).toBeGreaterThanOrEqual(48);
                    expect(box.width).toBeGreaterThanOrEqual(((await areas.boundingBox())!.width - 16) / 2);
                }
                const contrast = await local.evaluate((node) => {
                    const context = document.createElement("canvas").getContext("2d")!;
                    const luminance = (color: string) => {
                        context.fillStyle = color;
                        context.fillRect(0, 0, 1, 1);
                        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((channel) => {
                            const value = channel / 255;
                            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
                        }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
                    };
                    const style = getComputedStyle(node);
                    const values = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
                    return (values[0]! + 0.05) / (values[1]! + 0.05);
                });
                expect(contrast).toBeGreaterThanOrEqual(4.5);
                await local.focus();
                await page.keyboard.press("ArrowRight");
                await expect(daemon).toBeFocused();
                await page.keyboard.press("Enter");
                await expect(daemon).toHaveAttribute("aria-selected", "true");
                await page.keyboard.press("ArrowLeft");
                await expect(local).toBeFocused();
                await page.keyboard.press("Enter");
                await expect(local).toHaveAttribute("aria-selected", "true");
                const search = settings.getByLabel("설정 검색");
                const inputBox = await search.boundingBox();
                expect(inputBox!.height).toBeLessThanOrEqual(40);
                expect(inputBox!.width).toBeGreaterThanOrEqual(150);
                if (width < 760) {
                    const menu = settings.getByTestId("settings-menu");
                    const shown = await menu.evaluate((node) => {
                        const bounds = node.getBoundingClientRect();
                        return [...node.querySelectorAll("button")].filter((button) => {
                            const rect = button.getBoundingClientRect();
                            return rect.width > 0 && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
                        }).length;
                    });
                    expect(shown, "설정 메뉴는 한 화면에 최소 두 항목이 온전히 보여야 한다").toBeGreaterThanOrEqual(2);
                }
                for (const [area, name] of [["daemon", "모델·키"], ["daemon", "대화·컨텍스트"], ["daemon", "워크플로우·메모리"], ["daemon", "위임 에이전트"],
                    ["daemon", "도구·권한"], ["daemon", "실행·한도"],
                    ["local", "화면·입력"], ["local", "알림"], ["local", "단축키"], ["local", "기기·연결"], ["daemon", "기기·연결"], ["daemon", "서버·데이터"]] as const) {
                    await settings.getByRole("tab", { name: area === "local" ? "로컬 설정" : "데몬 설정", exact: true }).click();
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
                                !node.closest('[data-testid="settings-menu"]') && node.getBoundingClientRect().right > edge + 1)
                                .slice(0, 12).map((node) => ({ tag: node.tagName, class: node.className, width: node.getBoundingClientRect().width })),
                        };
                    });
                    await page.screenshot({ path: info.outputPath(`menu-${name}.png`) });
                    expect(layout.fits, `${name}: ${JSON.stringify(layout)}`).toBe(true);
                    expect(await settings.getByTestId("settings-body").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
                }
                await settings.getByRole("tab", { name: "데몬 설정", exact: true }).click();
                await settings.getByRole("button", { name: "모델·키", exact: true }).click();
                await expect(settings.getByTestId("setting-model.default_profile")).toBeVisible();
                await expect(settings.getByTestId("settings-area-reset")).toHaveCount(0);
                await expect(settings.getByRole("button", { name: /기본값 복원|이 범위 값 지우기|^저장$/ })).toHaveCount(0);
                if (width < 760) {
                    const menuBox = await settings.getByTestId("settings-menu").boundingBox();
                    const bodyBox = await settings.getByTestId("settings-body").boundingBox();
                    expect(menuBox!.y).toBeGreaterThanOrEqual(inputBox!.y + inputBox!.height);
                    expect(menuBox!.height).toBeLessThanOrEqual(44);
                    expect(bodyBox!.y).toBeGreaterThan(menuBox!.y + menuBox!.height);
                    expect(bodyBox!.y - menuBox!.y - menuBox!.height).toBeLessThanOrEqual(32);
                }
                await page.screenshot({ path: info.outputPath("models.png") });
                await settings.getByRole("tab", { name: "로컬 설정", exact: true }).click();
                await settings.getByRole("button", { name: "화면·입력", exact: true }).click();
                await selectChoice(settings.getByRole("combobox", { name: "테마", exact: true }), theme);
                await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
                await page.screenshot({ path: info.outputPath("display.png") });
                await settings.getByRole("slider", { name: "글자 크기", exact: true }).focus();
                await page.keyboard.press("End");
                await expect(settings.getByRole("slider", { name: "글자 크기", exact: true })).toHaveAttribute("aria-valuenow", "20");
                expect(await settings.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
                await page.reload();
                await openSettings(page, "local");
                await search.fill("테마");
                await expect(settings.getByRole("combobox", { name: "테마", exact: true })).toHaveAttribute("data-selected-value", theme);
            });
        }
    });
}
