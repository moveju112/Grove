import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Layout } from "../app/state/layout";
import { workspaceTabsKey } from "../app/state/workspaceTabs";
import { apiCall, login, sessionView, state } from "./helpers";

test("폰에서 열어 둔 대화 다섯 개를 PC가 시작할 때 이어가고 닫기는 열린 기기들에 반영된다", async ({ page, browser, baseURL }, info) => {
    const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: mkdtempSync(join(dirname(state().projA), "handoff-")) });
    const sessions = await Promise.all(Array.from({ length: 5 }, async (_, i) => {
        const title = `기기 전환 대화 ${i + 1}`;
        const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
        return { ...session, title };
    }));
    const phone = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
        const mobile = await phone.newPage();
        await login(mobile);
        for (const { id, title } of sessions) {
            const sidebar = mobile.getByRole("button", { name: "사이드바", exact: true });
            if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
            await mobile.getByTestId("mobile-drawer-left").getByRole("region", { name: "최근", exact: true })
                .getByRole("button", { name: new RegExp(title) }).click();
            await expect(sessionView(mobile, id)).toBeVisible();
        }
        const active = sessions.at(-1)!;
        await expect.poll(async () => {
            const { layout } = await apiCall<{ layout: Layout | null }>("GET", `/layouts/${workspaceTabsKey(project.id)}`);
            return layout?.root.type === "leaf" ? layout.root.tabs.length : 0;
        }).toBe(5);
        await login(page);
        await expect(sessionView(page, active.id)).toBeVisible();
        await expect(page.getByRole("tablist").getByRole("tab")).toHaveCount(5);
        const closed = sessions[0]!;
        await page.getByRole("tablist").getByRole("tab").filter({ hasText: closed.title })
            .getByRole("button", { name: "탭 닫기", exact: true }).click();
        await expect(page.getByRole("tablist").getByRole("tab")).toHaveCount(4);
        await mobile.getByRole("button", { name: "열린 세션", exact: true }).click();
        const drawer = mobile.getByTestId("mobile-drawer-right");
        await expect(drawer.getByRole("button", { name: closed.title, exact: true })).toHaveCount(0);
        for (const { title } of sessions.slice(1)) await expect(drawer.getByRole("button", { name: title, exact: true })).toBeVisible();
        await mobile.screenshot({ path: info.outputPath("shared-tabs-390.png") });
    } finally {
        await phone.close();
    }
});
