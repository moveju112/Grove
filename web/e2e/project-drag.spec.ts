import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Layout } from "../app/state/layout";
import { apiCall, closeMobileSidebar, ensureProjects, login, state } from "./helpers";

for (const theme of ["light", "dark"] as const) {
    test(`${theme}: 프로젝트 순서 드래그와 프로젝트별 분할은 탭·입력 DOM·초안·기기별 배치를 유지한다`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        const { a, b } = await ensureProjects();
        const c = await apiCall<{ id: string; name: string }>("POST", "/projects", {
            root_path: mkdtempSync(join(dirname(state().projA), "z-order-")),
        });
        const device = `project-drag-${randomUUID()}`;
        const sessions = await Promise.all([a, b].map((p, i) =>
            apiCall<{ id: string; title: string }>("POST", `/projects/${p.id}/sessions`, { title: `${device}-${i}` })));
        const seed: Layout = { schema: 1, focused_leaf: "a", root: {
            type: "split", direction: "row", ratio: 0.5, children: [a, b].map((p, i) => ({
                type: "leaf", id: i ? "b" : "a", active_tab: `t${i}`,
                tabs: [{ id: `t${i}`, kind: "session", project_id: p.id, resource_id: sessions[i]!.id, title: sessions[i]!.title }],
            })) as [Layout["root"], Layout["root"]],
        } };
        await apiCall("PUT", `/layouts/${device}`, { expected_revision: 0, layout: seed });
        const narrow = structuredClone(seed);
        if (narrow.root.type === "split") for (const leaf of narrow.root.children) {
            if (leaf.type === "leaf") {
                leaf.tabs.forEach((tab) => { tab.id += "-narrow"; });
                leaf.active_tab += "-narrow";
            }
        }
        await apiCall("PUT", `/layouts/${device}-narrow`, { expected_revision: 0, layout: narrow });
        await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
        await login(page);
        const row = (p: { name: string }) => page.getByTestId("project-row").filter({ has: page.getByRole("button", { name: p.name, exact: true }) });
        const button = (p: { name: string }) => row(p).getByRole("button", { name: p.name, exact: true });
        const panel = (p: { id: string }) => page.locator(`[data-project-pane="${p.id}"]`).filter({ visible: true });
        const view = (i: number) => page.locator(`[data-testid="session-view"][data-session="${sessions[i]!.id}"]`).filter({ visible: true });
        const order = async () => (await page.getByTestId("project-row").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-project"))))
            .filter((name) => [a.name, b.name, c.name].includes(name!));

        await button(c).dragTo(row(a), { targetPosition: { x: 80, y: 4 } });
        await expect.poll(order).toEqual([c.name, a.name, b.name]);
        await button(c).dragTo(row(b), { targetPosition: { x: 80, y: 28 } });
        await expect.poll(order).toEqual([a.name, b.name, c.name]);
        await button(c).dragTo(row(b), { targetPosition: { x: 80, y: 4 } });
        await expect.poll(order).toEqual([a.name, c.name, b.name]);
        await button(c).focus();
        await page.keyboard.press("Alt+Shift+ArrowUp");
        await expect.poll(order).toEqual([c.name, a.name, b.name]);
        await page.keyboard.press("Alt+Shift+ArrowDown");
        await expect.poll(order).toEqual([a.name, c.name, b.name]);
        await page.reload();
        await expect.poll(order).toEqual([a.name, c.name, b.name]);
        await button(b).click();
        await view(1).getByLabel("메시지 입력").fill("collector project draft");
        const bInput = await view(1).getByLabel("메시지 입력").elementHandle();
        await button(a).click();
        await view(0).getByLabel("메시지 입력").fill("Ubuntu project draft");
        await view(0).getByLabel("메시지 입력").evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 8));
        const aInput = await view(0).getByLabel("메시지 입력").elementHandle();

        const bounds = (await panel(a).boundingBox())!;
        await button(b).dragTo(panel(a).getByTestId("pane"), { targetPosition: { x: bounds.width - 12, y: bounds.height / 2 } });
        await expect(panel(a)).toBeVisible();
        await expect(panel(b)).toBeVisible();
        await expect(page.getByTestId("pane").filter({ visible: true })).toHaveCount(2);
        expect(await aInput!.evaluate((node: HTMLTextAreaElement) => ({ connected: node.isConnected, value: node.value, start: node.selectionStart, end: node.selectionEnd })))
            .toEqual({ connected: true, value: "Ubuntu project draft", start: 2, end: 8 });
        expect(await bInput!.evaluate((node: HTMLTextAreaElement) => node.isConnected && node.value === "collector project draft")).toBe(true);
        await expect(panel(a).getByRole("tablist", { name: "열린 대화와 화면" }).getByRole("tab")).toHaveCount(1);
        await expect(panel(a).getByRole("tablist", { name: "열린 대화와 화면" })).toContainText(sessions[0]!.title);
        await expect(panel(b).getByRole("tablist", { name: "열린 대화와 화면" })).toContainText(sessions[1]!.title);
        await view(0).getByLabel("메시지 입력").focus();
        await expect(page.getByTestId("navigation-context")).toHaveAttribute("data-project-id", a.id);
        await view(1).getByLabel("메시지 입력").focus();
        await expect(page.getByTestId("navigation-context")).toHaveAttribute("data-project-id", b.id);
        const linked = page.getByRole("listitem", { name: "분할로 함께 연 대화", exact: true });
        await expect(linked).toContainText(sessions[0]!.title);
        await expect(linked).toContainText(sessions[1]!.title);
        const divider = page.getByTestId("project-divider");
        await divider.press("ArrowRight");
        await expect(divider).toHaveAttribute("aria-valuenow", "55");
        await divider.dblclick();
        await expect(divider).toHaveAttribute("data-direction", "column");
        await page.reload();
        await expect(divider).toHaveAttribute("aria-valuenow", "55");
        await expect(divider).toHaveAttribute("data-direction", "column");
        // 작성 중 입력은 영속 초안으로 저장하지 않는다. 복원된 배치에서 새로 입력한 값의 화면 전환 보존을 확인한다.
        await expect(view(0).getByLabel("메시지 입력")).toHaveValue("");
        await expect(view(1).getByLabel("메시지 입력")).toHaveValue("");
        await view(1).getByLabel("메시지 입력").fill("collector project draft");
        await view(0).getByLabel("메시지 입력").fill("Ubuntu project draft");
        const top = (await panel(a).boundingBox())!, bottom = (await panel(b).boundingBox())!;
        expect(bottom.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
        await page.screenshot({ path: info.outputPath(`project-split-${theme}-1400.png`) });

        await page.setViewportSize({ width: 390, height: 844 });
        await closeMobileSidebar(page);
        await expect(page.getByTestId("pane").filter({ visible: true })).toHaveCount(1);
        await expect(divider).toHaveCount(0);
        await expect(view(0)).toBeVisible();
        await page.screenshot({ path: info.outputPath(`project-split-${theme}-390.png`) });
        await page.getByRole("button", { name: "열린 세션", exact: true }).click();
        await expect(page.getByTestId("mobile-open-tab")).toHaveCount(1);
        await expect(page.getByTestId("mobile-open-tab")).toContainText(sessions[0]!.title);
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("mobile-drawer-right")).toHaveJSProperty("open", false);
        await page.setViewportSize({ width: 1400, height: 900 });
        await expect(panel(a)).toBeVisible();
        await expect(panel(b)).toBeVisible();
        await panel(b).getByRole("button", { name: "프로젝트 분할 닫기", exact: true }).click();
        await expect(panel(a)).toBeVisible();
        await expect(panel(b)).toHaveCount(0);
        await button(b).click();
        await expect(view(1).getByLabel("메시지 입력")).toHaveValue("collector project draft");
        await button(a).click();
        await expect(view(0).getByLabel("메시지 입력")).toHaveValue("Ubuntu project draft");
        const projectLayout = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("grove.layout.p-"))
            .map(([, value]) => JSON.parse(value).layout as Layout));
        expect(projectLayout.every((layout) => {
            const ids = new Set<string>();
            const walk = (node: Layout["root"]) => node.type === "leaf" ? node.tabs.forEach((tab) => { if (tab.project_id) ids.add(tab.project_id); })
                : node.children.forEach(walk);
            walk(layout.root);
            return ids.size <= 1;
        })).toBe(true);
    });
}
