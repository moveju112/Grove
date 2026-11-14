import { expect, test } from "@playwright/test";
import { apiCall, composerOption, ensureProjects, login } from "./helpers";

for (const width of [390, 1400]) {
    for (const theme of ["light", "dark"] as const) {
        test.describe(`${width}px Astryx ${theme}`, () => {
            test.use({ viewport: { width, height: 960 }, isMobile: width < 760, hasTouch: width < 760 });
            test("새싹·폰트·홈·설정·대화를 같은 테마로 유지한다", async ({ page }, info) => {
                await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
                const errors: string[] = [];
                page.on("pageerror", (error) => errors.push(error.message));
                await page.goto("/");
                await expect(page.locator(".login-mark svg path")).toHaveCount(3);
                await expect(page.locator(".login-mark svg path").first()).toHaveAttribute("d", "M12 21v-9");
                await expect(page.locator(".login-mark")).toHaveCSS("color", theme === "dark" ? "rgb(95, 191, 138)" : "rgb(47, 125, 85)");
                const help = page.getByRole("button", { name: "보관 방식 도움말", exact: true });
                await page.locator("html[data-hydrated=true]").waitFor({ state: "attached" });
                await help.click();
                await expect(page.getByRole("tooltip")).toContainText("토큰은 이 브라우저에 저장하지 않습니다.");
                await page.keyboard.press("Escape");
                await page.screenshot({ path: info.outputPath("login.png"), fullPage: true });
                const { a } = await ensureProjects();
                const title = `디자인 확인 ${width} ${theme}`;
                const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
                await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
                await login(page);
                await page.evaluate(() => document.fonts.ready);
                expect(await page.evaluate(() => [...document.fonts].some((font) => font.family === "Pretendard" && font.status === "loaded"))).toBe(true);
                const home = page.locator(".home-recent");
                await expect(home.getByRole("heading", { name: "최근" })).toBeVisible();
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
                await page.screenshot({ path: info.outputPath("home.png"), fullPage: true });
                const item = home.getByTestId("home-recent-item").filter({ hasText: title });
                await item.getByRole("button", { name: "최근 항목 관리", exact: true }).click();
                await item.getByRole("button", { name: "고정", exact: true }).click();
                await expect(item.getByRole("button", { name: "최근 항목 관리", exact: true })).toHaveAttribute("aria-expanded", "false");
                await home.getByRole("button", { name: new RegExp(title) }).click();
                const view = page.getByTestId("session-view");
                await composerOption(view, "보내기 방식", "save");
                await view.getByLabel("메시지 입력").fill("기존 대화 입력과 저장을 유지한다.");
                await view.getByRole("button", { name: "보내기", exact: true }).click();
                await expect(view.getByTestId("msg-user")).toContainText("기존 대화 입력과 저장");
                // 도구 탭은 열기 전까지 화면 높이를 차지하지 않는다.
                await expect(view.locator(".tool-dock")).toBeHidden();
                await expect(view.locator(".view-head").getByRole("button", { name: "도구 패널", exact: true })).toBeVisible();
                await page.screenshot({ path: info.outputPath("conversation.png"), fullPage: true });
                await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
                await page.getByRole("button", { name: "화면·입력", exact: true }).click();
                await page.getByRole("switch", { name: "Enter로 보내기", exact: true }).check();
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
                await page.screenshot({ path: info.outputPath("settings.png"), fullPage: true });
                await page.reload();
                await page.getByLabel("설정 검색").fill("Enter로 보내기");
                await expect(page.getByRole("switch", { name: "Enter로 보내기", exact: true })).toBeChecked();
                expect(errors).toEqual([]);
            });
        });
    }
}
