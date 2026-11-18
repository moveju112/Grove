import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login, openDetails } from "./helpers";

test("기기를 폐기하면 연결 중인 브라우저와 터미널이 차단되고 다른 기기의 공유 실행은 남는다", async ({ page, browser }) => {
    const { a } = await ensureProjects();
    await login(page);
    const context = await browser.newContext();
    let device: { id: string } | undefined;
    let terminalId: string | undefined;
    try {
        const other = await context.newPage();
        device = await login(other);
        await other.getByRole("button", { name: a.name, exact: true }).first().click();
        const terminals = other.getByTestId("terminal-list");
        await openDetails(terminals, "터미널");
        const before = await apiCall<{ terminals: { id: string }[] }>("GET", `/projects/${a.id}/terminals`);
        await terminals.getByRole("button", { name: "새 터미널" }).click();
        await expect(other.getByTestId("terminal-view")).toHaveAttribute("data-conn", "open");
        const list = await apiCall<{ terminals: { id: string; status: string }[] }>("GET", `/projects/${a.id}/terminals`);
        terminalId = list.terminals.find((terminal) => !before.terminals.some((previous) => previous.id === terminal.id))!.id;
        await apiCall("DELETE", `/devices/${device.id}`);
        await expect(other.getByRole("button", { name: "페어링 링크·QR로 등록" })).toBeVisible({ timeout: 15_000 });
        await expect(other.getByTestId("terminal-view")).toHaveCount(0);
        await expect(page.getByTestId("conn")).toHaveText("연결됨");
        await expect(other.getByTestId("auth-expired")).toContainText("로그인이 만료");
        const after = await apiCall<{ terminals: { id: string; status: string }[] }>("GET", `/projects/${a.id}/terminals`);
        expect(after.terminals.find((terminal) => terminal.id === terminalId)?.status).toBe("running");
        await other.reload();
        await expect(other.getByRole("button", { name: "페어링 링크·QR로 등록" })).toBeVisible();
    } finally {
        await context.close();
        if (terminalId) await apiCall("POST", `/terminals/${terminalId}/kill`, {});
        if (device) await apiCall("DELETE", `/devices/${device.id}`);
    }
});
