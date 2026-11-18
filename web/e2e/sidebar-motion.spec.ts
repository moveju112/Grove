import { expect, test } from "@playwright/test";
import { login } from "./helpers";

for (const theme of ["light", "dark"] as const) {
    for (const reducedMotion of ["no-preference", "reduce"] as const) {
        test(`${theme} ${reducedMotion}: 좌측 탐색을 양방향으로 전환하고 상태와 접근성을 유지한다`, async ({ page }, info) => {
            await page.emulateMedia({ colorScheme: theme, reducedMotion });
            await page.addInitScript((theme) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme })), theme);
            await login(page);
            const sidebar = page.getByTestId("sidebar");
            const toggle = page.getByRole("button", { name: "사이드바", exact: true });
            const create = page.getByRole("button", { name: "프로젝트·폴더 추가", exact: true });
            await expect(sidebar).toHaveCSS("width", "280px");
            await expect(sidebar.getByRole("button", { name: "사이드바", exact: true })).toBeVisible();
            await expect(page.getByRole("banner").getByRole("button", { name: "사이드바", exact: true })).toHaveCount(0);
            await expect(create).toBeVisible();
            const original = await sidebar.elementHandle();
            const options = sidebar.getByRole("button", { name: "프로젝트 목록 옵션", exact: true });
            await options.click();
            await page.getByRole("button", { name: "보관됨", exact: true }).click();
            await page.keyboard.press("Escape");
            await expect(options).toBeFocused();
            await expect(sidebar.getByRole("group", { name: "보관된 프로젝트", exact: true })).toBeVisible();

            for (const open of [false, true]) {
                const positions = await toggle.evaluate(async (button) => {
                    const header = document.querySelector('[role="banner"]')!;
                    const sample = () => header.getBoundingClientRect().left;
                    const points = [sample()];
                    (button as HTMLButtonElement).click();
                    for (let i = 0; i < 12; i++) {
                        await new Promise(requestAnimationFrame);
                        points.push(sample());
                    }
                    return points;
                });
                await expect(toggle).toHaveAttribute("aria-expanded", String(open));
                await expect(toggle).toHaveCount(1);
                await expect(sidebar.getByRole("button", { name: "사이드바", exact: true })).toHaveCount(open ? 1 : 0);
                await expect(page.getByRole("banner").getByRole("button", { name: "사이드바", exact: true })).toHaveCount(0);
                await expect(sidebar).toHaveCSS("width", open ? "280px" : "0px");
                if (reducedMotion === "no-preference") {
                    expect(positions.some((left) => left > 49 && left < 279), JSON.stringify(positions)).toBe(true);
                } else {
                    expect(positions.slice(1).every((left) => Math.abs(left - (open ? 280 : 48)) < 1), JSON.stringify(positions)).toBe(true);
                }
                await expect.poll(() => page.getByRole("banner").evaluate((node) => Math.round(node.getBoundingClientRect().left))).toBe(open ? 280 : 48);
                expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
                await expect(sidebar).toHaveJSProperty("inert", !open);
                if (open) await expect(create).toBeVisible();
                else await expect(create).toBeHidden();
                await expect(page.getByRole("complementary", { name: "탐색", exact: true })).toHaveCount(open ? 1 : 0);
                await expect(toggle).toBeFocused();
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
                const rail = page.getByRole("navigation", { name: "빠른 탐색", exact: true });
                await expect(rail).toHaveCount(open ? 0 : 1);
                if (!open) {
                    await expect(rail).toHaveCSS("width", "48px");
                    await expect(rail.getByRole("button")).toHaveCount(3);
                    await expect(rail.getByRole("button", { name: "사이드바", exact: true })).toBeVisible();
                    await expect(rail.getByRole("button", { name: "프로젝트·폴더 추가", exact: true })).toHaveCount(0);
                    await expect(rail.getByRole("button", { name: "사용량", exact: true })).toBeVisible();
                    await expect(rail.getByRole("button", { name: "설정", exact: true })).toBeVisible();
                    const settings = rail.getByRole("button", { name: "설정", exact: true });
                    await settings.click();
                    const dialog = page.getByRole("dialog", { name: "설정", exact: true });
                    await expect(dialog).toBeVisible();
                    await page.keyboard.press("Escape");
                    await expect(dialog).toBeHidden();
                    await expect(settings).toBeFocused();
                    await page.screenshot({ path: info.outputPath(`rail-${theme}-${reducedMotion}.png`) });
                }
            }
            await expect(sidebar.getByRole("group", { name: "보관된 프로젝트", exact: true })).toBeVisible();

            // 전환 중 반대 방향으로 조작해도 마지막 요청 상태에 도달한다.
            await page.evaluate(async () => {
                for (let i = 0; i < 4; i++) {
                    document.querySelector<HTMLButtonElement>('button[aria-label="사이드바"]')!.click();
                    await new Promise(requestAnimationFrame);
                }
            });
            await expect(toggle).toHaveAttribute("aria-expanded", "true");
            await expect.poll(() => page.getByRole("banner").evaluate((node) => Math.round(node.getBoundingClientRect().left))).toBe(280);
            await expect(sidebar).toHaveJSProperty("inert", false);
            await toggle.focus();
            await page.keyboard.press("Enter");
            await expect(sidebar).toHaveJSProperty("inert", true);
            await page.keyboard.press("Tab");
            await expect(page.getByRole("navigation", { name: "빠른 탐색", exact: true }).getByRole("button", { name: "사용량", exact: true })).toBeFocused();
            expect(await sidebar.evaluate((node) => node.contains(document.activeElement))).toBe(false);
            await toggle.click();
            await expect(sidebar).toHaveCSS("width", "280px");
            await expect.poll(() => page.getByRole("banner").evaluate((node) => Math.round(node.getBoundingClientRect().left))).toBe(280);
            await page.screenshot({ path: info.outputPath(`sidebar-${theme}-${reducedMotion}.png`) });
            await page.setViewportSize({ width: 390, height: 844 });
            await toggle.click();
            await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", true);
            await expect(page.getByTestId("mobile-drawer-left")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
            await expect(sidebar).toHaveJSProperty("inert", false);
            await expect(page.getByTestId("sidebar-rail")).toHaveCount(0);
            await expect(create).toBeVisible();
            await page.screenshot({ path: info.outputPath(`sidebar-${theme}-${reducedMotion}-390.png`) });
            await page.getByRole("button", { name: "탐색 메뉴 닫기", exact: true }).click();
            await expect(create).toBeHidden();
        });
    }
}
