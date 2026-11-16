import { expect, test, type Locator } from "@playwright/test";
import { ensureProfile, ensureProjects, login, startProjectConversation } from "./helpers";

async function expectIconsUnclipped(scope: Locator) {
    await expect.poll(() => scope.locator("button svg").evaluateAll((icons) => {
        const clipped: { button: string; iconWidth: number; availableWidth: number }[] = [];
        for (const icon of icons) {
            const bounds = icon.getBoundingClientRect();
            if (!bounds.width || !bounds.height || getComputedStyle(icon).visibility !== "visible") continue;
            const button = icon.closest("button")!;
            for (let parent = icon.parentElement; parent; parent = parent.parentElement) {
                const style = getComputedStyle(parent);
                const box = parent.getBoundingClientRect();
                const clipsX = ["hidden", "clip"].includes(style.overflowX);
                const clipsY = ["hidden", "clip"].includes(style.overflowY);
                if (clipsX && (bounds.left < box.left - 0.5 || bounds.right > box.right + 0.5)
                    || clipsY && (bounds.top < box.top - 0.5 || bounds.bottom > box.bottom + 0.5)) {
                    clipped.push({ button: button.getAttribute("aria-label") ?? "", iconWidth: bounds.width, availableWidth: box.width });
                    break;
                }
                if (parent === button) break;
            }
        }
        return clipped;
    })).toEqual([]);
}

for (const width of [390, 1280]) {
    for (const theme of ["light", "dark", "soft"] as const) {
        test.describe(`${width}px ${theme}`, () => {
            test.use({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });
            test("헤더·탐색·입력창의 버튼 아이콘이 잘리지 않는다", async ({ page }, info) => {
                await page.addInitScript((theme) => {
                    localStorage.setItem("grove.device.prefs", JSON.stringify({ theme }));
                }, theme);
                const { a } = await ensureProjects();
                await ensureProfile();
                await login(page);
                await expectIconsUnclipped(page.getByRole("banner"));
                if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
                const sidebar = page.getByTestId("sidebar");
                await expectIconsUnclipped(sidebar);
                await page.getByTestId("project-row").getByRole("button", { name: a.name, exact: true }).click();
                if (width === 390) await expect(page.getByTestId("mobile-drawer-left")).toBeHidden();
                const view = page.getByTestId("project-view").filter({ visible: true });
                await startProjectConversation(view);
                await view.getByLabel("메시지 입력").fill("아이콘 잘림 확인");
                await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeEnabled();
                await expectIconsUnclipped(view);
                await page.screenshot({ path: info.outputPath(`icons-${width}-${theme}.png`) });
            });
        });
    }
}
