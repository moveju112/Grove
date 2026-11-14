import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`${reducedMotion}: 제목·서랍·사용량의 움직임과 최종 상태를 유지한다`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion });
        await page.clock.install();
        let running = 1;
        await page.route("**/api/v1/usage?*", (route) => route.fulfill({ json: {
            rows: [], total: { input_tokens: 0, output_tokens: 0 }, pricing_versions: [],
        } }));
        await page.route("**/api/v1/usage/capacity", (route) => route.fulfill({ json: {
            limits: { max_active: 4 }, server: { running, waiting: 1 },
        } }));

        await page.goto("/");
        await expect(page.getByRole("heading", { name: "Grove", exact: true })).toBeVisible();
        const letters = page.locator(".reveal-text > span");
        await expect(letters).toHaveCount(5);
        await expect(letters.first()).toHaveCSS("animation-duration", reducedMotion === "reduce" ? "0s" : "0.2s");
        await page.clock.runFor(500);
        for (const letter of await letters.all()) {
            await expect(letter).toHaveCSS("opacity", "1");
            await expect.poll(() => letter.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).isIdentity)).toBe(true);
        }

        await login(page);
        const toggle = page.getByRole("button", { name: "사이드바", exact: true });
        const side = page.getByRole("complementary", { name: "탐색" });
        const meter = side.locator(".side-meter-track > i");
        for (let i = 0; i < 2; i++) {
            await toggle.click();
            await expect(toggle).toHaveAttribute("aria-expanded", "true");
            await expect(side).toHaveCSS("animation-duration", reducedMotion === "reduce" ? "0s" : "0.28s");
            await expect(side).toHaveCSS("animation-timing-function", "cubic-bezier(0.22, 1, 0.36, 1)");
            await page.clock.runFor(300);
            await expect(side).toBeVisible();
            await expect(meter).toHaveCSS("transform", "matrix(0.25, 0, 0, 1, 0, 0)");
            await expect(meter).toHaveCSS("transition-duration", reducedMotion === "reduce" ? "0s" : "0.2s");
            const ratio = await meter.evaluate((el) => el.getBoundingClientRect().width / el.parentElement!.getBoundingClientRect().width);
            expect(ratio).toBeCloseTo(0.25, 2);
            await toggle.click();
            await expect(toggle).toHaveAttribute("aria-expanded", "false");
            await expect(side).toHaveCount(0);
        }

        await toggle.click();
        for (const [next, scale] of [[8, 1], [0, 0]] as const) {
            running = next;
            await page.clock.fastForward(60_000);
            await expect(side.locator(".side-meter-value")).toHaveText(`${next}/4`);
            await page.clock.runFor(300);
            await expect(meter).toHaveCSS("transform", `matrix(${scale}, 0, 0, 1, 0, 0)`);
            const ratio = await meter.evaluate((el) => el.getBoundingClientRect().width / el.parentElement!.getBoundingClientRect().width);
            expect(ratio).toBeCloseTo(scale, 2);
        }
    });
}
