import { expect, test } from "@playwright/test";
import { ensureProjects, login } from "./helpers";

for (const width of [390, 1280]) {
    for (const reducedMotion of ["no-preference", "reduce"] as const) {
        test.describe(`${width}px ${reducedMotion}`, () => {
            test.use({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390, reducedMotion });

            test("프로젝트 메뉴와 라벨 입력이 행을 밀지 않고 닫으면 트리거로 초점이 돌아온다", async ({ page }, info) => {
                const { a, b } = await ensureProjects();
                await login(page);
                await page.evaluate(() => document.fonts.ready);
                if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
                const projects = page.getByTestId("sidebar").getByTestId("projects");
                const row = projects.getByTestId("project-row").filter({ hasText: a.name });
                const next = projects.getByTestId("project-row").filter({ hasText: b.name });
                const trigger = row.getByRole("button", { name: "프로젝트 메뉴", exact: true });
                const before = (await row.boundingBox())!;
                const nextBefore = (await next.boundingBox())!;
                await trigger.click();
                const menu = page.getByRole("dialog", { name: `${a.name} 메뉴`, exact: true });
                await expect(menu).toBeVisible();
                await expect(menu.getByRole("button", { name: /오른쪽에 열기|아래에 열기|왼쪽에 열기|맨 위에 고정|고정 해제/ })).toHaveCount(0);
                await expect(menu.getByRole("button", { name: "+ 새 라벨", exact: true })).toBeHidden();
                await expect.poll(async () => (await row.boundingBox())!.height).toBe(before.height);
                expect((await row.boundingBox())!.width).toBe(before.width);
                expect((await next.boundingBox())!.y).toBe(nextBefore.y);
                const bounds = (await menu.boundingBox())!;
                expect(bounds.x).toBeGreaterThanOrEqual(0);
                expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
                await page.screenshot({ path: info.outputPath(`project-menu-${width}-${reducedMotion}.png`), animations: "disabled" });

                const labelTrigger = menu.getByRole("button", { name: "Label", exact: true });
                await labelTrigger.click();
                await expect(labelTrigger).toHaveAttribute("aria-expanded", "true");
                const labels = page.getByRole("dialog", { name: "Label", exact: true });
                await expect(labels).toBeVisible();
                const labelBounds = (await labels.boundingBox())!;
                expect(labelBounds.x).toBeGreaterThanOrEqual(0);
                expect(labelBounds.x + labelBounds.width).toBeLessThanOrEqual(width);
                await page.screenshot({ path: info.outputPath(`project-labels-${width}-${reducedMotion}.png`), animations: "disabled" });
                await labels.getByRole("button", { name: "+ 새 라벨", exact: true }).click();
                await menu.getByLabel("새 라벨 이름").fill("아직 만들지 않은 라벨");
                expect((await row.boundingBox())!.height).toBe(before.height);
                expect((await next.boundingBox())!.y).toBe(nextBefore.y);
                await menu.getByRole("button", { name: "취소", exact: true }).click();
                await expect(menu).toBeVisible();
                await page.keyboard.press("Escape");
                await expect(labels).toBeHidden();
                await expect(labelTrigger).toBeFocused();
                await expect(menu).toBeVisible();
                await page.keyboard.press("Enter");
                await expect(labels).toBeVisible();
                await page.keyboard.press("Escape");
                await page.keyboard.press("Escape");
                await expect(menu).toBeHidden();
                await expect(trigger).toBeFocused();

                await trigger.click();
                await expect(menu).toBeVisible();
                await projects.getByRole("heading", { name: "프로젝트", exact: true }).click();
                await expect(menu).toBeHidden();
                await trigger.click();
                await menu.getByRole("button", { name: "닫기", exact: true }).click();
                await expect(menu).toBeHidden();
                await expect(trigger).toBeFocused();
            });
        });
    }
}
