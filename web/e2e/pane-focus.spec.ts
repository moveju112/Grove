import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiCall, composerOption, ensureProfile, ensureProjects, login } from "./helpers";
import type { Layout } from "../app/state/layout";

test("키보드로 들어간 pane이 열기·붙여넣기 첨부·입력의 대상이 되고 다른 pane에는 섞이지 않는다", async ({ page }) => {
    const { a, b } = await ensureProjects();
    await ensureProfile();
    const left = await apiCall<{ id: string; title: string }>("POST", `/projects/${a.id}/sessions`, { title: `focus-left-${randomUUID()}` });
    const right = await apiCall<{ id: string; title: string }>("POST", `/projects/${b.id}/sessions`, { title: `focus-right-${randomUUID()}` });
    const opened = await apiCall<{ id: string; title: string }>("POST", `/projects/${a.id}/sessions`, { title: `focus-open-${randomUUID()}` });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: opened.id, title: opened.title });
    const device = `focus-${randomUUID()}`;
    const layout: Layout = { schema: 1, focused_leaf: "left", root: {
        type: "split", direction: "row", ratio: 0.5, children: [
            { type: "leaf", id: "left", active_tab: "l", tabs: [{ id: "l", kind: "session", project_id: a.id, resource_id: left.id, title: left.title }] },
            { type: "leaf", id: "right", active_tab: "r", tabs: [{ id: "r", kind: "session", project_id: b.id, resource_id: right.id, title: right.title }] },
        ],
    } };
    await apiCall("PUT", `/layouts/${device}`, { expected_revision: 0, layout });
    await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
    await login(page);
    const leftPane = page.locator('[data-leaf="left"]');
    const rightPane = page.locator('[data-leaf="right"]');
    await expect(leftPane.getByTestId("session-view")).toBeVisible();
    await expect(leftPane).toHaveAttribute("data-focused", "true");

    // 키보드 포커스만으로 오른쪽 pane에 들어간다(pointer 없음).
    await rightPane.getByLabel("메시지 입력").focus();
    await expect(rightPane).toHaveAttribute("data-focused", "true");
    await expect(leftPane).toHaveAttribute("data-focused", "false");
    await page.keyboard.type("오른쪽 입력");
    await expect(rightPane.getByLabel("메시지 입력")).toHaveValue("오른쪽 입력");
    await expect(leftPane.getByLabel("메시지 입력")).toHaveValue("");

    // 붙여넣은 파일은 포커스한 pane의 입력에만 첨부된다.
    await composerOption(rightPane, "보내기 방식", "save");
    await rightPane.getByLabel("메시지 입력").evaluate((node) => {
        const data = new DataTransfer();
        data.items.add(new File(["clip"], "clip.txt", { type: "text/plain" }));
        node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(rightPane.getByTestId("attachment-card")).toContainText("clip.txt");
    await expect(leftPane.getByTestId("attachment-card")).toHaveCount(0);

    // 사이드바에서 연 항목은 마지막으로 포커스한 pane에 열린다.
    await page.getByTestId("recent-item").filter({ hasText: opened.title }).getByRole("button").first().click();
    await expect(rightPane.locator(`[data-testid=session-view][data-session="${opened.id}"]`)).toBeVisible();
    await expect(leftPane.locator(`[data-testid=session-view][data-session="${left.id}"]`)).toBeVisible();
});
