import { expect, test } from "@playwright/test";
import { login, openSettings } from "./helpers";

for (const width of [1280, 390]) for (const theme of ["light", "dark"] as const) {
    test(`${width}px ${theme}: 기억·hook·MCP의 별도 관리는 없고 CLI 원본 설정 조회는 유지한다`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        const retired: string[] = [];
        page.on("request", (request) => {
            if (/\/api\/v1\/(?:memories(?:[/?]|$)|hooks(?:[?]|$|\/executions)|mcp\/servers)/.test(request.url())) {
                retired.push(request.method() + " " + new URL(request.url()).pathname);
            }
        });
        await login(page);
        await openSettings(page);
        const settings = page.getByTestId("settings");
        for (const text of ["장기 기억", "hook 설정", "MCP 서버"]) {
            await settings.getByLabel("설정 검색", { exact: true }).fill(text);
            await expect(settings.getByTestId("settings-body")).toContainText("검색 결과 0개");
        }
        for (const id of ["memories-panel", "hooks-settings", "mcp-servers"]) {
            await expect(settings.getByTestId(id)).toHaveCount(0);
        }
        await settings.getByLabel("설정 검색", { exact: true }).fill("원본 Claude/Codex 설정");
        await expect(settings.getByTestId("source-settings")).toBeVisible();
        await page.screenshot({ path: info.outputPath(`native-settings-${width}-${theme}.png`) });
        expect(retired).toEqual([]);
    });
}
