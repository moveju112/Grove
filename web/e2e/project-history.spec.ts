import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, closeMobileSidebar, login, state } from "./helpers";
import type { Layout } from "../app/state/layout";

for (const width of [1400, 390]) for (const theme of ["light", "dark"] as const) {
    test(`${width}px ${theme}: 최근은 좌측에만 보이고 프로젝트는 기록 대신 마지막 대화·파일·분할로 돌아온다`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        const root = mkdtempSync(join(dirname(state().projA), "history-state-"));
        writeFileSync(join(root, "last.txt"), "마지막으로 열어 둔 파일\n");
        const a = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
        const b = await apiCall<{ id: string; name: string }>("POST", "/projects", {
            root_path: mkdtempSync(join(dirname(state().projA), "history-other-")),
        });
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "마지막 작업 대화" });
        await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "기록에서 열 대화" });
        const device = `history-${randomUUID()}`;
        const layout: Layout = { schema: 1, focused_leaf: "chat", root: {
            type: "split", direction: "row", ratio: 0.6, children: [
                { type: "leaf", id: "chat", active_tab: "chat-tab", tabs: [
                    { id: "chat-tab", kind: "session", project_id: a.id, resource_id: session.id, title: "마지막 작업 대화" },
                ] },
                { type: "leaf", id: "file", active_tab: "file-tab", tabs: [
                    { id: "file-tab", kind: "file", project_id: a.id, resource_id: "last.txt", filePath: "last.txt", title: "last.txt" },
                ] },
            ],
        } };
        await apiCall("PUT", `/layouts/${device}${width === 390 ? "-narrow" : ""}`, { expected_revision: 0, layout });
        await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
        await login(page);
        const nav = page.getByTestId("navigation-context");
        const choose = async (project: typeof a) => {
            if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
        };
        // 시작 시 다른 시험이 남긴 공유 대화가 열려도, 프로젝트 자체의 마지막 배치를 확인한다.
        await choose(a);
        await expect(nav).toHaveAttribute("data-session-id", session.id);
        await choose(b);
        const project = page.getByTestId("project-view").filter({ visible: true });
        await expect(project.getByTestId("composer")).toBeVisible();
        await expect(project.locator("li")).toHaveCount(0);
        if (width === 390) {
            await page.getByRole("button", { name: "열린 세션", exact: true }).click();
            await page.getByTestId("mobile-drawer-right").getByRole("button", { name: "새 대화 탭 닫기", exact: true }).click();
            await page.keyboard.press("Escape");
            await expect(page.getByTestId("mobile-drawer-right")).toHaveJSProperty("open", false);
        } else await page.getByRole("tab", { selected: true }).getByRole("button", { name: "탭 닫기", exact: true }).click();
        await expect(page.locator("main").getByRole("region", { name: "최근", exact: true })).toHaveCount(0);
        await choose(a);
        await expect(nav).toHaveAttribute("data-session-id", session.id);
        await expect(page.getByTestId("pane").filter({ visible: true })).toHaveCount(width === 390 ? 1 : 2);
        await expect(page.getByTestId("project-view").filter({ visible: true })).toHaveCount(0);
        await page.reload();
        await expect(nav).toHaveAttribute("data-session-id", session.id);
        if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
        const row = page.getByTestId("project-row").filter({ hasText: a.name });
        await row.getByRole("button", { name: "프로젝트 메뉴", exact: true }).click();
        await page.getByRole("dialog", { name: `${a.name} 메뉴`, exact: true }).getByRole("button", { name: "기록", exact: true }).click();
        const history = page.getByRole("dialog", { name: `${a.name} 기록`, exact: true });
        await expect(history.getByRole("button", { name: "기록에서 열 대화", exact: true })).toBeVisible();
        await expect(nav).toHaveAttribute("data-session-id", session.id);
        await page.screenshot({ path: info.outputPath(`history-${width}-${theme}.png`) });
        await history.getByRole("button", { name: "기록 닫기", exact: true }).click();
        await expect(row.getByRole("button", { name: "프로젝트 메뉴", exact: true })).toBeFocused();
        if (width === 390) await closeMobileSidebar(page);
        await expect(nav).toHaveAttribute("data-session-id", session.id);
        if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
        await expect(page.getByRole("region", { name: "최근", exact: true })).toHaveCount(1);
        if (width === 390) await closeMobileSidebar(page);
        await page.screenshot({ path: info.outputPath(`restored-${width}-${theme}.png`) });
    });
}
