import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Layout, Tab } from "../app/state/layout";
import { apiCall, ensureProjects, login } from "./helpers";

test("최근에서 선택된 스플릿만 강조하고 재선택·모션 줄이기·전체 보기를 처리한다", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const { a } = await ensureProjects();
    const device = `reveal-${randomUUID()}`;
    const tabs = await Promise.all(["left", "right", "copy"].map(async (id): Promise<Tab> => {
        const title = `${device}-${id}`;
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id, title });
        return { id, kind: "session", project_id: a.id, resource_id: session.id, title };
    }));
    const [leftTab, rightTab, copy] = tabs as [Tab, Tab, Tab];
    const layout: Layout = { schema: 1, focused_leaf: "left", root: {
        type: "split", direction: "row", ratio: 0.5, children: [
            { type: "leaf", id: "left", active_tab: leftTab.id, tabs: [leftTab, copy] },
            { type: "leaf", id: "right", active_tab: copy.id + "-right", tabs: [rightTab, { ...copy, id: copy.id + "-right" }] },
        ],
    } };
    await apiCall("PUT", `/layouts/${device}`, { expected_revision: 0, layout });
    await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
    await login(page);

    const button = (tab: Tab) => page.getByTestId("recent-item").filter({ hasText: tab.title }).getByRole("button").first();
    const pane = (id: string) => page.getByTestId("pane").and(page.locator(`[data-leaf="${id}"]`));
    const reveal = page.getByTestId("recent-pane-reveal");
    await button(rightTab).click();
    await expect(pane("right").getByTestId("recent-pane-reveal")).toBeVisible();
    await expect(reveal).toHaveCount(1);
    await expect(reveal).toHaveCSS("animation-iteration-count", "2");
    await expect(reveal).toHaveCSS("animation-duration", "0.5s");
    await expect(reveal).not.toHaveCSS("animation-name", "none");

    // 오른쪽에는 같은 대화를 보이게 두고 왼쪽에서 그 대화를 열면 왼쪽 사본만 강조한다.
    await pane("right").getByRole("tab", { name: copy.title }).getByTestId("tab-title").click();
    await expect(reveal).toHaveCount(0);
    await button(leftTab).click();
    await button(copy).click();
    const leftReveal = pane("left").getByTestId("recent-pane-reveal");
    await expect(leftReveal).toBeVisible();
    await expect(reveal).toHaveCount(1);
    const firstReveal = await leftReveal.elementHandle();
    await button(copy).press("Enter");
    await expect.poll(() => firstReveal!.evaluate((node) => node.isConnected)).toBe(false);
    await expect(leftReveal).toBeVisible();
    await expect(reveal).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await button(copy).click();
    await expect(leftReveal).toBeVisible();
    await expect(leftReveal).toHaveCSS("animation-name", "none");
    await expect(leftReveal).toHaveCSS("opacity", "1");
    await expect(reveal).toHaveCount(0);

    await pane("left").getByRole("button", { name: "영역 전체 보기", exact: true }).click();
    await expect(pane("right")).toBeHidden();
    await button(leftTab).click();
    await expect(pane("left").getByRole("tab", { name: leftTab.title })).toHaveAttribute("aria-selected", "true");
    await expect(reveal).toHaveCount(0);
});
