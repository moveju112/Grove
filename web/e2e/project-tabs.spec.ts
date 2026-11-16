import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Layout } from "../app/state/layout";
import { activateMobileTab, apiCall, ensureProjects, login } from "./helpers";

for (const width of [1400, 390]) for (const theme of ["light", "dark"] as const) {
    test(`${width}px ${theme}: 프로젝트별 탭·분할·초안을 전환하고 새로고침 뒤에도 따로 복원한다`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        const { a, b } = await ensureProjects();
        const device = `projects-${randomUUID()}`;
        const sessions = await Promise.all([a, a, b].map((p, i) =>
            apiCall<{ id: string }>("POST", `/projects/${p.id}/sessions`, { title: `${device}-${i}` })));
        const tabs = sessions.map((s, i) => ({
            id: `chat-${i}`, kind: "session" as const, project_id: i === 2 ? b.id : a.id, resource_id: s.id, title: `${device}-${i}`,
        }));
        const layout: Layout = { schema: 1, focused_leaf: "right", root: {
            type: "split", direction: "row", ratio: 0.6, children: [
                { type: "leaf", id: "left", tabs: [tabs[0]!, tabs[2]!], active_tab: tabs[0]!.id },
                { type: "leaf", id: "right", tabs: [tabs[1]!], active_tab: tabs[1]!.id },
            ],
        } };
        await apiCall("PUT", `/layouts/${device}${width === 390 ? "-narrow" : ""}`, { expected_revision: 0, layout });
        await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
        await login(page);
        const panes = page.getByTestId("pane").filter({ visible: true });
        const view = (i: number) => page.getByTestId("session-view").filter({ visible: true })
            .and(page.locator(`[data-session="${sessions[i]!.id}"]`));
        const choose = async (project: typeof a) => {
            if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
            if (width === 390) await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", false);
        };
        const checkTabs = async (names: string[]) => {
            if (width === 390) {
                await page.getByRole("button", { name: "열린 세션", exact: true }).click();
                await expect(page.getByTestId("mobile-open-tab")).toHaveCount(names.length);
                for (const name of names) await expect(page.getByTestId("mobile-open-tab").getByRole("button", { name, exact: true })).toBeVisible();
                await page.keyboard.press("Escape");
                await expect(page.getByTestId("mobile-drawer-right")).toHaveJSProperty("open", false);
            } else {
                const tabs = page.getByRole("tablist", { name: "열린 대화와 화면" }).getByRole("tab");
                await expect(tabs).toHaveCount(names.length);
                for (const name of names) await expect(tabs.filter({ hasText: name })).toBeVisible();
            }
        };
        const closeTab = async (title: string) => {
            if (width === 390) {
                await page.getByRole("button", { name: "열린 세션", exact: true }).click();
                await page.getByRole("button", { name: `${title} 탭 닫기`, exact: true }).click();
                await page.keyboard.press("Escape");
                await expect(page.getByTestId("mobile-drawer-right")).toHaveJSProperty("open", false);
            } else {
                await page.getByRole("tablist", { name: "열린 대화와 화면" }).getByRole("tab")
                    .filter({ hasText: title }).getByRole("button", { name: "탭 닫기" }).click();
            }
        };
        await expect(view(1)).toBeVisible();
        await expect(panes).toHaveCount(width === 390 ? 1 : 2);
        await checkTabs([tabs[0]!.title, tabs[1]!.title]);
        await view(1).getByLabel("메시지 입력").fill("Ubuntu second draft");
        await expect(view(1).getByLabel("메시지 입력")).toHaveValue("Ubuntu second draft");
        const originalInput = await view(1).getByLabel("메시지 입력").elementHandle();
        await view(1).getByLabel("메시지 입력").evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 8));
        if (width === 390) await activateMobileTab(page, tabs[0]!.title);
        expect(await originalInput!.evaluate((node: HTMLTextAreaElement) => node.value)).toBe("Ubuntu second draft");
        await view(0).getByLabel("메시지 입력").fill("Ubuntu first draft");
        await choose(b);
        await expect(view(2)).toBeVisible();
        await expect(panes).toHaveCount(1);
        await checkTabs([tabs[2]!.title]);
        await view(2).getByLabel("메시지 입력").fill("collector draft");
        expect(await originalInput!.evaluate((node) => node.isConnected)).toBe(true);
        expect(await originalInput!.evaluate((node: HTMLTextAreaElement) => node.value)).toBe("Ubuntu second draft");
        await choose(a);
        await expect(view(0).getByLabel("메시지 입력")).toHaveValue("Ubuntu first draft");
        await expect(panes).toHaveCount(width === 390 ? 1 : 2);
        await checkTabs([tabs[0]!.title, tabs[1]!.title]);
        expect(await originalInput!.evaluate((node: HTMLTextAreaElement) => node.value)).toBe("Ubuntu second draft");
        if (width === 390) await activateMobileTab(page, tabs[1]!.title);
        await expect(view(1).getByLabel("메시지 입력")).toHaveValue("Ubuntu second draft");
        expect(await originalInput!.evaluate((node: HTMLTextAreaElement) => ({ connected: node.isConnected, start: node.selectionStart, end: node.selectionEnd })))
            .toEqual({ connected: true, start: 2, end: 8 });
        await page.screenshot({ path: info.outputPath(`project-tabs-${width}-${theme}.png`) });
        await choose(b);
        await page.reload();
        await expect(view(2).getByLabel("메시지 입력")).toHaveValue("collector draft");
        await checkTabs([tabs[2]!.title]);
        await choose(a);
        await expect(panes).toHaveCount(width === 390 ? 1 : 2);
        await checkTabs([tabs[0]!.title, tabs[1]!.title]);
        if (width === 390) await activateMobileTab(page, tabs[1]!.title);
        await expect(view(1).getByLabel("메시지 입력")).toHaveValue("Ubuntu second draft");
        // 닫은 탭은 원본 공용 배치에 남아 있어도 프로젝트 복원 때 되살리지 않는다.
        await closeTab(tabs[1]!.title);
        await choose(b);
        await choose(a);
        await page.reload();
        await checkTabs([tabs[0]!.title]);
        await expect(view(0).getByLabel("메시지 입력")).toHaveValue("Ubuntu first draft");
        await expect(panes).toHaveCount(1);
        // 다른 프로젝트 항목을 현재 pane에 놓아도 탭이 섞이지 않는다.
        await dropOtherProject(page, { kind: "session", project_id: b.id, resource_id: sessions[2]!.id, title: tabs[2]!.title });
        await expect(view(2)).toBeVisible();
        await checkTabs([tabs[2]!.title]);
        await closeTab(tabs[2]!.title);
        await choose(a);
        await choose(b);
        // 빈 프로젝트를 선택하면 대화 목록만 연다. 닫은 세션은 복원하지 않는다.
        await checkTabs([b.name]);
        await closeTab(b.name);
        await page.reload();
        await checkTabs([]);
        await dropOtherProject(page, { kind: "session", project_id: a.id, resource_id: sessions[0]!.id, title: tabs[0]!.title });
        await expect(view(0).getByLabel("메시지 입력")).toHaveValue("Ubuntu first draft");
        await checkTabs([tabs[0]!.title]);
    });
}

async function dropOtherProject(page: Page, target: Record<string, string>) {
    const dataTransfer = await page.evaluateHandle((value) => {
        const transfer = new DataTransfer();
        transfer.setData("application/x-grove-open", JSON.stringify(value));
        return transfer;
    }, target);
    await page.getByTestId("pane").filter({ visible: true }).first().dispatchEvent("drop", { dataTransfer });
    await dataTransfer.dispose();
}
