import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, openDetails, openSettings, script, sessionView } from "./helpers";

for (const width of [390, 1400]) {
    for (const theme of ["light", "dark", "soft"] as const) {
        test.describe(`${width}px ${theme} 글꼴`, () => {
            test.use({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });

            test("로그인·대화·설명창·설정의 글꼴과 대체 글꼴을 통일하고 코드는 고정폭을 유지한다", async ({ page }, info) => {
                await page.emulateMedia({ reducedMotion: "reduce" });
                await page.addInitScript((theme) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme })), theme);
                await page.goto("/");
                await page.locator("html[data-hydrated=true]").waitFor({ state: "attached" });
                await page.evaluate(() => document.fonts.ready);
                const family = await page.locator("body").evaluate((node) => getComputedStyle(node).fontFamily);
                expect(family).toMatch(/^"?Pretendard"?,/);
                await page.getByRole("button", { name: "페어링 링크·QR로 등록" }).click();
                await expect(page.getByRole("textbox", { name: "페어링 링크" })).toHaveCSS("font-family", family);
                await expect(page.getByRole("button", { name: "연결", exact: true })).toHaveCSS("font-family", family);
                await expect(page.locator('link[rel="preload"][as="font"]')).toHaveAttribute("href", "/fonts/PretendardVariable.woff2");
                expect(await page.evaluate(() => [...document.fonts].some((font) => font.family === "Pretendard" && font.status === "loaded"))).toBe(true);

                const { a } = await ensureProjects();
                const profile = await ensureProfile();
                const title = `font-${randomUUID()}`;
                const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
                await script({ marker: title, frames: [
                    JSON.stringify({ choices: [{ delta: { content: "일반 본문과 설명창의 글꼴을 확인해요. `project` 코드는 고정폭이에요." } }] }),
                    ...frames.tool("font-check", "shell", { command: "printf 'typography fixture'" }),
                ] });
                await script({ marker: title, frames: frames.text(["같은 글꼴로 확인했어요."]) });
                const turn = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, {
                    text: title, profile_id: profile, tools: true,
                });
                await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${turn.turn.id}`)).status).toBe("completed");
                await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
                await login(page);
                if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
                await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
                const view = sessionView(page, session.id);
                await expect(view.getByLabel("메시지 입력", { exact: true })).toHaveCSS("font-family", family);
                await expect(view.getByTestId("msg-answer").last().locator("p")).toHaveCSS("font-family", family);
                await openDetails(view.getByTestId("msg-progress").first());
                const dialog = page.getByRole("dialog", { name: "진행 설명", exact: true });
                await expect(dialog.locator("p").first()).toHaveCSS("font-family", family);
                await expect(dialog.getByRole("heading")).toHaveCSS("font-family", family);
                const codeFamily = await dialog.locator("code").evaluate((node) => getComputedStyle(node).fontFamily);
                expect(codeFamily).toMatch(/monospace/);
                expect(codeFamily).not.toBe(family);
                await page.screenshot({ path: info.outputPath(`font-dialog-${width}-${theme}.png`), animations: "disabled" });
                await page.keyboard.press("Escape");
                await openSettings(page, "local");
                await expect(page.getByLabel("설정 검색", { exact: true })).toHaveCSS("font-family", family);
                await expect(page.getByRole("dialog", { name: "설정", exact: true }).getByRole("heading", { name: "설정", exact: true })).toHaveCSS("font-family", family);
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            });
        });
    }
}

test("폰트를 불러오지 못해도 로그인 입력과 버튼은 같은 대체 글꼴로 읽을 수 있다", async ({ page }) => {
    await page.route("**/fonts/PretendardVariable.woff2", (route) => route.abort());
    await page.goto("/");
    await page.locator("html[data-hydrated=true]").waitFor({ state: "attached" });
    await page.evaluate(() => document.fonts.ready);
    const family = await page.locator("body").evaluate((node) => getComputedStyle(node).fontFamily);
    await page.getByRole("button", { name: "페어링 링크·QR로 등록" }).click();
    await expect(page.getByRole("textbox", { name: "페어링 링크" })).toHaveCSS("font-family", family);
    await expect(page.getByRole("button", { name: "연결", exact: true })).toHaveCSS("font-family", family);
    expect(await page.evaluate(() => [...document.fonts].some((font) => font.family === "Pretendard" && font.status === "loaded"))).toBe(false);
});
