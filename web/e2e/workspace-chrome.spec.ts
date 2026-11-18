import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Layout } from "../app/state/layout";
import { apiCall, ensureProfile, ensureProjects, login, openSettings, openTool, sessionView } from "./helpers";

for (const theme of ["light", "dark"] as const) {
    test(`${theme}: 탭과 프로젝트 제목은 단정하게 유지하고 설정은 작업을 유지하는 별도 창에서 연다`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        const { a } = await ensureProjects();
        await ensureProfile();
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "상단 탭 디자인 확인" });
        const second = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "제목이 길어도 닫기 버튼과 겹치지 않는 대화 ".repeat(5) });
        const device = `workspace-chrome-${randomUUID()}`;
        const layout: Layout = { schema: 1, focused_leaf: "work", root: {
            type: "leaf", id: "work", active_tab: "chat", tabs: [
                { id: "chat", kind: "session", project_id: a.id, resource_id: session.id, title: "상단 탭 디자인 확인" },
                { id: "project", kind: "project", project_id: a.id, resource_id: a.id, title: a.name },
                { id: "second", kind: "session", project_id: a.id, resource_id: second.id, title: "제목이 길어도 닫기 버튼과 겹치지 않는 대화 ".repeat(5) },
                { id: "legacy-settings", kind: "settings", title: "설정" },
            ],
        } };
        await apiCall("PUT", `/layouts/${device}`, { expected_revision: 0, layout });
        const narrow = structuredClone(layout);
        if (narrow.root.type === "leaf") {
            narrow.root.tabs.forEach((tab) => { tab.id += "-narrow"; });
            narrow.root.active_tab = "chat-narrow";
        }
        await apiCall("PUT", `/layouts/${device}-narrow`, { expected_revision: 0, layout: narrow });
        await page.addInitScript(({ device, theme }) => {
            localStorage.setItem("grove.device.id", device);
            localStorage.setItem("grove.device.prefs", JSON.stringify({ theme }));
        }, { device, theme });
        await page.setViewportSize({ width: 1180, height: 800 });
        await login(page);
        const nav = page.getByRole("navigation", { name: "현재 위치", exact: true });
        await expect(nav).toHaveAttribute("data-project-id", a.id);
        await expect(nav.getByRole("button")).toHaveText(a.name);
        await expect(nav).not.toContainText("127.0.0.1");
        const tabs = page.getByRole("tablist", { name: "열린 대화와 화면" });
        await expect(tabs.getByRole("tab")).toHaveCount(3);
        await expect(tabs).not.toContainText("설정");
        await expect(page.getByRole("combobox", { name: "탭 이동", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "오른쪽으로 분할", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "아래로 분할", exact: true })).toHaveCount(0);
        const split = page.getByRole("group", { name: "화면 분할", exact: true });
        await expect(split).toHaveCount(0);
        const tools = page.getByTestId("pane-tab-actions").getByRole("button", { name: "도구 패널", exact: true });
        await tools.click();
        await expect(tools).toHaveAttribute("aria-expanded", "true");
        await page.getByRole("button", { name: "도구 패널 닫기", exact: true }).click();
        await expect(tools).toHaveAttribute("aria-expanded", "false");
        await expect(tools).toBeFocused();
        const view = sessionView(page, session.id);
        await view.getByLabel("메시지 입력").fill("설정을 열고 닫아도 보존되는 초안");
        const input = await view.getByLabel("메시지 입력").elementHandle();
        await page.screenshot({ path: info.outputPath(`workspace-tabs-${theme}.png`) });
        await page.getByTestId("sidebar").getByRole("button", { name: "설정", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "설정", exact: true });
        await expect(dialog.getByTestId("settings")).toBeVisible();
        await expect(tabs.getByRole("tab")).toHaveCount(3);
        await page.screenshot({ path: info.outputPath(`settings-window-${theme}.png`) });
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        expect(await input!.evaluate((node) => node.isConnected)).toBe(true);
        await expect(view.getByLabel("메시지 입력")).toHaveValue("설정을 열고 닫아도 보존되는 초안");
        await expect(page.getByTestId("sidebar").getByRole("button", { name: "설정", exact: true })).toBeFocused();

        await openTool(view, "대화");
        await view.getByRole("button", { name: "대화 설정", exact: true }).click();
        await expect(page.getByTestId("settings-origin")).toContainText("상단 탭 디자인 확인");
        await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
        await expect(tabs.getByRole("tab")).toHaveCount(3);

        await page.setViewportSize({ width: 390, height: 844 });
        await expect(tabs).toBeHidden();
        await expect(split).toBeHidden();
        await expect(nav.getByRole("button")).toHaveText(a.name);
        const narrowInput = sessionView(page, session.id).getByLabel("메시지 입력").filter({ visible: true });
        await narrowInput.fill("모바일에서도 보존되는 초안");
        await openSettings(page, "local");
        await expect(page.getByRole("dialog", { name: "설정", exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`settings-window-${theme}-390.png`) });
        await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
        await expect(narrowInput).toHaveValue("모바일에서도 보존되는 초안");
        await page.screenshot({ path: info.outputPath(`workspace-header-${theme}-390.png`) });
    });
}
