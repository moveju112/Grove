import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login } from "./helpers";
import type { Hook } from "../app/api/hooks";
import type { ToolCallRow } from "../app/api/generated";

test("실제 SessionStart hook은 저장·발생만으로 실행하지 않고 승인 후 receipt를 남긴다", async ({ page }) => {
    const { a } = await ensureProjects();
    const hook = await apiCall<Hook>("POST", `/hooks?project_id=${a.id}`, {
        name: `hook-execution-${Date.now()}`, event: "SessionStart", matcher: "*",
        command: "printf hook-local-fixture", enabled: true,
    });
    let session: { id: string } | undefined;
    try {
        session = await apiCall("POST", `/projects/${a.id}/sessions`, { title: hook.name });
        const calls = await apiCall<ToolCallRow[]>("GET", `/tool-calls?session_id=${session!.id}`);
        const call = calls.find((c) => c.name === "hook")!;
        expect(call.status).toBe("pending_approval");
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session!.id });
        await login(page);
        await page.locator(".recent").getByRole("button", { name: hook.name }).click();
        await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
        await page.getByLabel("설정 검색").last().fill("hook");
        const view = page.getByTestId("hook-executions").last().locator(`[data-call-id="${call.id}"]`);
        await expect(view).toContainText("승인 대기");
        await view.getByRole("button", { name: "이번만 승인", exact: true }).click();
        await expect.poll(async () => (await apiCall<ToolCallRow>("GET", `/tool-calls/${call.id}`)).status).toBe("succeeded");
        const done = await apiCall<ToolCallRow>("GET", `/tool-calls/${call.id}`);
        expect(JSON.stringify(done.result)).toContain("hook-local-fixture");
        await page.reload();
        expect((await apiCall<ToolCallRow[]>("GET", `/tool-calls?session_id=${session!.id}`)).filter((c) => c.name === "hook")).toHaveLength(1);
    } finally {
        if (session) {
            const calls = await apiCall<ToolCallRow[]>("GET", `/tool-calls?session_id=${session.id}`);
            for (const call of calls.filter((c) => ["pending_approval", "approved", "running"].includes(c.status))) {
                await apiCall("POST", `/tool-calls/${call.id}/cancel`, {});
            }
        }
        await apiCall("DELETE", `/hooks/${hook.id}?project_id=${a.id}&expected_revision=${hook.revision}`);
    }
});
