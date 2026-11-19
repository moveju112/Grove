import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Layout, Node, Split } from "../app/state/layout";
import { workspaceTabs, workspaceTabsKey } from "../app/state/workspaceTabs";
import { apiCall, login, state } from "./helpers";

async function openGrid(page: Page) {
    const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: mkdtempSync(join(dirname(state().projA), "split-width-")) });
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: "분할 영역 너비 확인" });
    const leaf = (i: number): Node => ({ type: "leaf", id: `pane-${i}`, active_tab: `chat-${i}`, tabs: [{
        id: `chat-${i}`, kind: "session", project_id: project.id, resource_id: session.id, title: "분할 영역 너비 확인",
    }] });
    const split = (direction: Split["direction"], ratio: number, first: Node, second: Node): Split =>
        ({ type: "split", direction, ratio, children: [first, second] });
    const row = (i: number) => split("row", 0.5, split("row", 0.5, leaf(i), leaf(i + 1)), split("row", 0.5, leaf(i + 2), leaf(i + 3)));
    const layout: Layout = { schema: 1, focused_leaf: "pane-0", root: split("column", 0.5, row(0), row(4)) };
    const device = `split-width-${randomUUID()}`;
    await apiCall("PUT", `/layouts/${device}`, { expected_revision: 0, layout });
    await apiCall("PUT", `/layouts/${workspaceTabsKey(project.id)}`, { expected_revision: 0, layout: workspaceTabs(layout) });
    await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
    await login(page);
    const panes = page.getByTestId("pane");
    await expect(panes.getByTestId("session-view")).toHaveCount(8);
    return panes;
}

test("두 줄로 나뉜 대화 영역은 창 너비와 사이드바 변경 뒤에도 화면 안에 맞는다", async ({ page }) => {
    const panes = await openGrid(page);

    const fits = () => page.getByRole("main").evaluate((main) => {
        const bounds = main.getBoundingClientRect();
        let appOverflow = 0;
        for (let node = main.parentElement; node; node = node.parentElement)
            appOverflow = Math.max(appOverflow, node.scrollWidth - node.clientWidth);
        const paneRight = Math.max(...Array.from(main.querySelectorAll('[data-testid="pane"]'), (pane) => pane.getBoundingClientRect().right));
        return { paneOverflow: Math.round(paneRight - bounds.right), appOverflow, workspaceRight: Math.round(bounds.right - innerWidth) };
    });
    const noOverflow = { paneOverflow: 0, appOverflow: 0, workspaceRight: 0 };
    await expect.poll(fits).toEqual(noOverflow);
    await page.setViewportSize({ width: 800, height: 700 });
    await expect.poll(fits).toEqual(noOverflow);
    // 좁은 탭 줄에서도 마지막 버튼은 스크롤로 접근할 수 있다.
    await panes.last().getByTestId("tab-title").focus();
    const tool = panes.last().getByRole("button", { name: "도구 패널", exact: true });
    await tool.focus();
    await expect(tool).toBeInViewport();
    await expect.poll(fits).toEqual(noOverflow);
    const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
    await sidebar.click();
    await expect(sidebar).toHaveAttribute("aria-expanded", "false");
    await expect.poll(fits).toEqual(noOverflow);
    await sidebar.click();
    await expect(sidebar).toHaveAttribute("aria-expanded", "true");

    // 한쪽 분할을 좁혀도 하위 영역의 최소 폭이 전체 배치를 바깥으로 밀어내지 않는다.
    const rootRowDivider = page.getByTestId("split-row").first().locator(':scope > [role="separator"]');
    for (let i = 0; i < 6; i++) await rootRowDivider.press("ArrowRight");
    await expect(rootRowDivider).toHaveAttribute("aria-valuenow", "80");
    await expect.poll(fits).toEqual(noOverflow);
});

test("오른쪽 위아래를 닫으면 남은 두 줄의 세 열이 각각 같은 너비가 된다", async ({ page }) => {
    const panes = await openGrid(page);
    await panes.nth(3).getByRole("button", { name: "탭 닫기", exact: true }).click();
    await expect(panes).toHaveCount(7);
    await panes.last().getByRole("button", { name: "탭 닫기", exact: true }).click();
    await expect(panes).toHaveCount(6);
    await expect.poll(() => panes.evaluateAll((nodes) => {
        const widths = nodes.map((node) => node.getBoundingClientRect().width);
        return Math.max(...widths) - Math.min(...widths);
    })).toBeLessThanOrEqual(1);
});
