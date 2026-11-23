import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, state } from "./helpers";

for (const width of [390, 1280]) test(`${width}px 재실행 시 도착한 최근 목록을 먼저 표시하고 후속 변경까지 반영한다`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 844 });
    const root = mkdtempSync(join(dirname(state().projA), "recent-restart-"));
    const project = await apiCall<{ id: string; revision: number }>("POST", "/projects", { root_path: root });
    await login(page);
    await page.close();
    const { id, title } = await apiCall<{ id: string; title: string }>("POST", `/projects/${project.id}/sessions`, { title: "앱을 닫은 동안 생긴 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: id });

    const reopened = await context.newPage();
    await reopened.setViewportSize({ width, height: 844 });
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let releaseNext!: () => void;
    const next = new Promise<void>((resolve) => { releaseNext = resolve; });
    let firstCaptured = false;
    await reopened.route((url) => url.pathname === "/api/v1/recent" && url.searchParams.has("since"), async (route) => {
        const response = await route.fetch();
        if (!firstCaptured) {
            firstCaptured = true;
            await first;
        } else await next;
        await route.fulfill({ response });
    });
    try {
        await reopened.goto("/");
        await expect(reopened.getByTestId("conn")).toHaveText("연결됨");
        await expect.poll(() => firstCaptured).toBe(true);
        if (width === 390) await reopened.getByRole("button", { name: "사이드바", exact: true }).click();
        const renamed = "다시 켠 뒤 변경된 이름";
        await apiCall("PATCH", `/projects/${project.id}`, { expected_revision: project.revision, name: renamed });
        await expect(reopened.locator(`[data-project-order-id="${project.id}"]`).filter({ hasText: renamed })).toBeVisible();
        const row = reopened.locator(`[data-testid="recent-item"][data-session="${id}"]`).getByRole("button", { name: title, exact: true });
        releaseFirst();
        await expect(row).toBeVisible();
        releaseNext();
        await expect(row).toHaveAttribute("title", new RegExp(renamed));
    } finally {
        releaseFirst();
        releaseNext();
        await reopened.unrouteAll({ behavior: "wait" });
        await reopened.close();
    }
});
