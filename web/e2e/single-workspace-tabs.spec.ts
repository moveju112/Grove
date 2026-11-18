import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, sessionView, state } from "./helpers";
import type { Layout } from "../app/state/layout";
import { workspaceTabs, workspaceTabsKey } from "../app/state/workspaceTabs";

for (const theme of ["light", "dark"] as const) {
    test(`${theme}: 단일 모드는 프로젝트 한 행만 표시하고 많은 대화 탭은 겹치지 않고 스크롤된다`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        const root = mkdtempSync(join(dirname(state().projA), "single-tabs-"));
        const project = await apiCall<{ id: string; name: string; workspace_mode: string }>("POST", "/projects", { root_path: root });
        expect(project.workspace_mode).toBe("single");
        // 프로젝트 목록이 화면보다 길어도 하단 최근 영역의 여섯 행을 압축하지 않는다.
        for (let i = 0; i < 24; i++) {
            await apiCall("POST", "/projects", { root_path: mkdtempSync(join(dirname(state().projA), "sidebar-overflow-")) });
        }
        const tabs: Layout["root"] & { type: "leaf" } = { type: "leaf", id: "tabs", active_tab: "session-9", tabs: [] };
        for (let i = 0; i < 10; i++) {
            const title = i % 2 ? `아주 긴 대화 제목이 닫기 버튼을 가리거나 옆 탭을 침범하면 안 돼요 ${i}` : `대화 ${i}`;
            const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
            tabs.tabs.push({ id: `session-${i}`, kind: "session", project_id: project.id, resource_id: session.id, title });
        }
        const device = `single-tabs-${randomUUID()}`;
        const layout: Layout = { schema: 1, focused_leaf: "tabs", root: tabs };
        await apiCall("PUT", `/layouts/${device}`, { expected_revision: 0, layout });
        await apiCall("PUT", `/layouts/${workspaceTabsKey(project.id)}`, { expected_revision: 0, layout: workspaceTabs(layout) });
        await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
        await login(page);
        const tree = page.locator(`[data-testid="sidebar-project"][data-project-id="${project.id}"]`);
        await expect(tree.getByTestId("project-row")).toHaveCount(1);
        await expect(tree.getByTestId("sidebar-session")).toHaveCount(0);
        await expect(tree.getByTestId("sidebar-workspace")).toHaveCount(0);
        await expect(tree.getByTestId("sidebar-project-tools")).toHaveCount(0);
        const strip = page.getByRole("tablist", { name: "열린 대화와 화면" });
        const recent = page.getByRole("region", { name: "최근", exact: true });
        const recentScroll = recent.getByTestId("recent-scroll");
        const checkDock = async () => {
            await expect.poll(() => recent.evaluate((node) => {
                const sidebar = node.closest('[data-testid="sidebar"]')!;
                const usage = node.nextElementSibling?.getBoundingClientRect();
                const bottom = node.getBoundingClientRect().bottom;
                const gapAboveUsage = usage ? Math.abs(bottom - usage.top) : 0;
                const gapBelowUsage = Math.abs((usage?.bottom ?? bottom) - sidebar.getBoundingClientRect().bottom);
                return Math.max(gapAboveUsage, gapBelowUsage);
            })).toBeLessThanOrEqual(12);
            const geometry = await recentScroll.evaluate((node) => {
                node.scrollTop = 0;
                const edge = node.getBoundingClientRect();
                const rows = [...node.querySelectorAll('[data-testid="recent-item"]')].map((row) => row.getBoundingClientRect());
                return {
                    scrolls: node.scrollHeight > node.clientHeight,
                    height: edge.height,
                    rows: rows.slice(0, 6).map((box) => ({ top: box.top - edge.top, height: box.height })),
                    containers: [node, node.parentElement!, node.parentElement!.parentElement!].map((el) => {
                        const s = getComputedStyle(el);
                        return { height: el.getBoundingClientRect().height, flexShrink: s.flexShrink, flexBasis: s.flexBasis, maxHeight: s.maxHeight };
                    }),
                    visible: rows.filter((box) => box.top >= edge.top - 1 && box.bottom <= edge.bottom + 1).length,
                };
            });
            expect(geometry.scrolls).toBe(true);
            expect(geometry.height).toBe(144);
            expect(geometry.rows).toEqual(Array.from({ length: 6 }, (_, i) => ({ top: i * 24, height: 24 })));
            expect(geometry.visible, JSON.stringify(geometry)).toBe(6);
        };
        const checkSelected = async () => {
            const selected = strip.getByRole("tab", { selected: true });
            await expect(selected).toHaveCount(1);
            const appearance = await selected.evaluate((node) => {
                const s = getComputedStyle(node);
                const lum = (color: string) => {
                    const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((c) => {
                        const v = c / 255;
                        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
                    });
                    return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
                };
                const fg = lum(s.borderBottomColor), bg = lum(s.backgroundColor);
                return { width: parseFloat(s.borderBottomWidth), contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) };
            });
            expect(appearance.width).toBeGreaterThanOrEqual(2);
            expect(appearance.contrast).toBeGreaterThanOrEqual(3);
        };
        await expect(strip.getByRole("tab")).toHaveCount(10);
        await expect(sessionView(page, tabs.tabs[9]!.resource_id!)).toBeVisible();
        await checkSelected();
        for (const width of [1400, 1024]) {
            await page.setViewportSize({ width, height: 900 });
            await expect.poll(() => strip.evaluate((node) => {
                const active = node.querySelector<HTMLElement>('[aria-selected="true"]')!;
                const box = active.getBoundingClientRect();
                const edge = node.getBoundingClientRect();
                return box.left >= edge.left - 1 && box.right <= edge.right + 1;
            })).toBe(true);
            const boxes = await strip.getByRole("tab").evaluateAll((nodes) => nodes.map((node) => {
                const box = node.getBoundingClientRect();
                const title = node.querySelector('[data-testid="tab-title"]')!.getBoundingClientRect();
                const close = node.querySelector('[aria-label="탭 닫기"]')!.getBoundingClientRect();
                const text = node.querySelector('[data-testid="tab-title"] span')!.getBoundingClientRect();
                return { width: box.width, height: box.height, fits: title.right <= close.left + 1 && close.right <= box.right + 1 && text.right <= close.left + 1 };
            }));
            expect(boxes.every((b) => b.width >= 128 && b.width <= 208 && b.height <= 36 && b.fits), JSON.stringify(boxes)).toBe(true);
            expect(await strip.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await checkDock();
            await page.screenshot({ path: info.outputPath(`tabs-${theme}-${width}.png`) });
        }
        const first = strip.getByTestId("tab-title").first();
        await first.click();
        await expect(strip.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
        await checkSelected();
        await expect(sessionView(page, tabs.tabs[0]!.resource_id!)).toBeVisible();
        await strip.getByRole("tab").first().getByRole("button", { name: "탭 닫기" }).click();
        await expect(strip.getByRole("tab")).toHaveCount(9);
        // 닫힌 대화도 프로젝트의 기존 목록에서 다시 열 수 있고, 새로고침은 열린 탭을 유지한다.
        const sessions = await apiCall<{ items: { id: string }[] }>("GET", `/projects/${project.id}/sessions`);
        expect(sessions.items.some((s) => s.id === tabs.tabs[0]!.resource_id)).toBe(true);
        await page.reload();
        await expect(strip.getByRole("tab")).toHaveCount(9);
        await expect(tree.getByTestId("sidebar-session")).toHaveCount(0);
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(strip).toBeHidden();
        await page.getByRole("button", { name: "사이드바", exact: true }).click();
        await expect(tree.getByTestId("project-row")).toBeVisible();
        await expect(tree.getByTestId("sidebar-session")).toHaveCount(0);
        await tree.scrollIntoViewIfNeeded();
        await checkDock();
        await recentScroll.evaluate((node) => { node.scrollTop = node.scrollHeight; });
        await expect.poll(() => recentScroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
        await page.screenshot({ path: info.outputPath(`single-sidebar-${theme}-390.png`) });
        await page.setViewportSize({ width: 390, height: 430 });
        await checkDock();
    });
}
