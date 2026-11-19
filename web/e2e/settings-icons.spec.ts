import { expect, test, type Locator } from "@playwright/test";
import { apiCall, ensureProjects, login, openProjectSettings, openTool, sessionView } from "./helpers";

async function iconOnly(button: Locator) {
    await expect(button).toHaveText("");
    await expect(button.locator("svg")).toBeVisible();
    await button.click({ trial: true });
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(32);
    expect(box.height).toBeGreaterThanOrEqual(32);
    await button.focus();
    await button.press("Enter");
}

for (const width of [390, 1400]) {
    test.describe(`${width}px 설정 아이콘`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760 });
        test("전체·대화 설정 아이콘과 프로젝트 도구 패널이 설정 대상을 유지한다", async ({ page }, info) => {
            const { a } = await ensureProjects();
            const title = `대화 설정 아이콘 ${width}`;
            const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
            await login(page);
            if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            const global = width < 760 ? page.getByTestId("mobile-drawer-left").getByRole("button", { name: "설정", exact: true })
                : page.getByTestId("sidebar").getByRole("button", { name: "설정", exact: true });
            await iconOnly(global);
            await expect(page.getByTestId("settings")).toBeVisible();
            await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
            if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByTestId("project-row").getByRole("button", { name: a.name, exact: true }).click();
            await openProjectSettings(page);
            await expect(page.getByTestId("settings-origin")).toContainText(a.name);
            await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
            if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
            const view = sessionView(page, session.id);
            await openTool(view, "대화");
            const settings = view.getByRole("button", { name: "대화 설정", exact: true });
            await page.screenshot({ path: info.outputPath("session-settings-icon.png"), fullPage: true });
            await iconOnly(settings);
            await expect(page.getByTestId("settings-origin")).toContainText(title);
            await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
            await expect(view).toBeVisible();
        });
    });
}
