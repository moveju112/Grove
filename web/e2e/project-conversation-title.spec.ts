import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Layout } from "../app/state/layout";
import { apiCall, login, state } from "./helpers";

for (const width of [390, 1280]) {
    test.describe(`새 대화 제목 ${width}px`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760 });

        test("프로젝트를 처음 열어도 새 대화로 표시하고 본문의 프로젝트명은 반복하지 않는다", async ({ page }, info) => {
            const device = `project-title-${randomUUID()}`;
            const project = await apiCall<{ id: string; name: string }>("POST", "/projects", {
                name: `처음 여는 프로젝트 ${width}`,
                root_path: mkdtempSync(join(dirname(state().projA), "project-title-")),
            });
            await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
            await login(page);
            const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
            if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
            await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
            const view = page.getByTestId("project-view").filter({ visible: true });
            await expect(view.getByLabel("메시지 입력", { exact: true })).toBeVisible();
            await expect(view.getByRole("heading", { name: project.name, exact: true })).toHaveCount(0);
            await expect(page.getByTestId("navigation-context").locator('[aria-current="page"]')).toHaveText(project.name);
            if (width < 760) {
                await page.getByRole("button", { name: "열린 세션", exact: true }).click();
                const tab = page.getByTestId("mobile-open-tab");
                await expect(tab.getByRole("button", { name: "새 대화", exact: true })).toBeVisible();
                await expect(tab.getByRole("button", { name: "새 대화 탭 닫기", exact: true })).toBeVisible();
                const drawer = page.getByTestId("mobile-drawer-right");
                const bottomGap = await tab.evaluate((row) =>
                    row.closest("dialog")!.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom);
                expect(bottomGap).toBeGreaterThanOrEqual(0);
                expect(bottomGap).toBeLessThanOrEqual(16);
                await drawer.screenshot({ path: info.outputPath("new-conversation-drawer-390.png") });
                await tab.getByRole("button", { name: "새 대화", exact: true }).click();
            } else {
                await expect(page.getByTestId("tab-title").filter({ visible: true })).toHaveText(["새 대화"]);
                await page.getByRole("button", { name: "새 대화 탭", exact: true }).click();
                await expect(page.getByTestId("tab-title").filter({ visible: true })).toHaveText(["새 대화", "새 대화"]);
            }
            await expect(page.getByRole("heading", { name: project.name, exact: true })).toHaveCount(0);
            expect((await apiCall<{ items: unknown[] }>("GET", `/projects/${project.id}/sessions`)).items).toEqual([]);
            await page.screenshot({ path: info.outputPath("new-conversation-title.png") });
        });

        test("프로젝트명이 저장된 예전 탭도 새 대화로 표시하고 기존 대화 제목은 유지한다", async ({ page }) => {
            const device = `legacy-title-${randomUUID()}`;
            const project = await apiCall<{ id: string; name: string }>("POST", "/projects", {
                name: `저장된 프로젝트 ${width}`,
                root_path: mkdtempSync(join(dirname(state().projA), "legacy-title-")),
            });
            const titles = ["보존할 대화 제목", ...Array.from({ length: width < 760 ? 11 : 0 }, (_, i) => `열린 대화 ${i + 1}`)];
            const tabs = await Promise.all(titles.map(async (title, i) => {
                const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title });
                return { id: `old-session-${i}`, kind: "session" as const, project_id: project.id, resource_id: session.id, title };
            }));
            const layout: Layout = { schema: 1, focused_leaf: "saved", root: {
                type: "leaf", id: "saved", active_tab: "old-project", tabs: [
                    { id: "old-project", kind: "project", project_id: project.id, resource_id: project.id, title: project.name },
                    ...tabs,
                ],
            } };
            await apiCall("PUT", `/layouts/${width < 760 ? `${device}-narrow` : device}`, { expected_revision: 0, layout });
            await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
            await login(page);
            const view = page.getByTestId("project-view").filter({ visible: true });
            await expect(view.getByLabel("메시지 입력", { exact: true })).toBeVisible();
            await expect(view.getByRole("heading", { name: project.name, exact: true })).toHaveCount(0);
            if (width < 760) {
                await page.setViewportSize({ width, height: 390 });
                await page.getByRole("button", { name: "열린 세션", exact: true }).click();
                const drawer = page.getByTestId("mobile-drawer-right");
                const draft = drawer.getByRole("button", { name: "새 대화", exact: true });
                const sessions = drawer.getByRole("group", { name: "현재 프로젝트 세션" });
                await expect(sessions.getByRole("button", { name: "보존할 대화 제목", exact: true })).toBeInViewport();
                await expect(draft).toBeInViewport({ ratio: 1 });
                const initialTop = await draft.evaluate((button) => button.getBoundingClientRect().top);
                await sessions.evaluate((list) => { list.scrollTop = list.scrollHeight; });
                await expect(sessions.getByRole("button", { name: titles.at(-1)!, exact: true })).toBeInViewport();
                await expect(sessions.getByRole("button", { name: "보존할 대화 제목", exact: true })).not.toBeInViewport();
                expect(await draft.evaluate((button) => button.getBoundingClientRect().top)).toBe(initialTop);
            } else {
                await expect(page.getByTestId("tab-title").filter({ visible: true })).toHaveText(["새 대화", "보존할 대화 제목"]);
            }
        });
    });
}
