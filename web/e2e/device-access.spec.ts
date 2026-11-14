import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login, openDetails } from "./helpers";

test("기기를 폐기하면 연결 중인 브라우저와 터미널이 차단되고 다른 기기의 공유 실행은 남는다", async ({ page, browser }) => {
    const { a } = await ensureProjects();
    await login(page);
    const device = await apiCall<{ id: string; token: string }>("POST", "/devices", { name: "폐기 회귀 기기" });
    const context = await browser.newContext();
    let terminalId: string | undefined;
    try {
        const other = await context.newPage();
        await other.goto("/");
        await other.locator("html[data-hydrated=true]").waitFor();
        await other.getByLabel("토큰").fill(device.token);
        await other.getByRole("button", { name: "로그인", exact: true }).click();
        await expect(other.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
        await other.getByRole("button", { name: a.name, exact: true }).first().click();
        const terminals = other.getByTestId("terminal-list");
        await openDetails(terminals);
        const before = await apiCall<{ terminals: { id: string }[] }>("GET", `/projects/${a.id}/terminals`);
        await terminals.getByRole("button", { name: "새 터미널" }).click();
        await expect(other.getByTestId("terminal-view")).toHaveAttribute("data-conn", "open");
        const list = await apiCall<{ terminals: { id: string; status: string }[] }>("GET", `/projects/${a.id}/terminals`);
        terminalId = list.terminals.find((terminal) => !before.terminals.some((previous) => previous.id === terminal.id))!.id;
        await apiCall("DELETE", `/devices/${device.id}`);
        await expect(other.getByLabel("토큰")).toBeVisible({ timeout: 15_000 });
        await expect(other.getByTestId("terminal-view")).toHaveCount(0);
        await expect(page.getByTestId("conn")).toHaveText("연결됨");
        await expect(other.getByTestId("auth-expired")).toContainText("로그인이 만료");
        const after = await apiCall<{ terminals: { id: string; status: string }[] }>("GET", `/projects/${a.id}/terminals`);
        expect(after.terminals.find((terminal) => terminal.id === terminalId)?.status).toBe("running");
        await other.reload();
        await expect(other.getByLabel("토큰")).toBeVisible();
    } finally {
        await context.close();
        if (terminalId) await apiCall("POST", `/terminals/${terminalId}/kill`, {});
        await apiCall("DELETE", `/devices/${device.id}`);
    }
});
