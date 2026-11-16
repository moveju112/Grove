import { expect, test } from "@playwright/test";
import { apiCall, ensureProfile, ensureProjects, login, sessionView } from "./helpers";

for (const width of [390, 1280]) {
    for (const theme of ["light", "dark"] as const) {
        test(`${width}px ${theme}: 입력에 초점을 둬도 테두리를 강조하지 않고 버튼의 키보드 초점은 유지한다`, async ({ page }, info) => {
            await page.setViewportSize({ width, height: 844 });
            await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
            await page.addInitScript((theme) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme })), theme);
            const { a } = await ensureProjects();
            await ensureProfile();
            const title = `입력 초점 ${width} ${theme}`;
            const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
            await login(page);
            if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title, exact: false }).first().click();
            const view = sessionView(page, session.id);
            const input = view.getByRole("textbox", { name: "메시지 입력", exact: true });
            const composer = view.getByTestId("composer");
            const attach = composer.getByRole("button", { name: "파일 첨부", exact: true });
            const frame = () => composer.evaluate((node) => {
                const style = getComputedStyle(node);
                return { outline: style.outlineWidth, border: style.borderColor, width: style.borderWidth, shadow: style.boxShadow };
            });
            await page.getByRole("banner").getByRole("button", { name: width < 760 ? "열린 세션" : "설정", exact: true }).focus();
            const normal = await frame();
            for (const mode of ["pointer", "keyboard"]) {
                if (mode === "pointer") await input.click();
                else {
                    await attach.focus();
                    await page.keyboard.press("Shift+Tab");
                }
                await expect(input).toBeFocused();
                await input.fill("보존할 초안");
                expect(await frame()).toEqual(normal);
                const decoration = await input.evaluate((node) => [node, node.parentElement!].map((element) => {
                    const style = getComputedStyle(element);
                    return { outline: style.outlineStyle, border: parseFloat(style.borderBottomWidth) };
                }));
                expect(decoration).toEqual([{ outline: "none", border: 0 }, { outline: "none", border: 0 }]);
                await page.keyboard.press("Tab");
                await expect(attach).toBeFocused();
                const indicated = await attach.evaluate((node) => {
                    const style = getComputedStyle(node);
                    return parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== "none" || style.boxShadow !== "none";
                });
                expect(indicated).toBe(true);
            }
            await input.click();
            await expect(input).toHaveValue("보존할 초안");
            await page.screenshot({ path: info.outputPath(`composer-focus-${width}-${theme}.png`) });
        });
    }
}
