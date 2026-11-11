import { expect, test } from "@playwright/test";
import { unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, ensureProjects, login, openDetails, sessionView, state } from "./helpers";

test("누락·손상된 작업 로그를 빈 출력과 구분하고 다른 스트림을 정상 조회한다", async ({ page }) => {
    const { a } = await ensureProjects();
    const title = `로그 상태 ${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    const task = await apiCall<{ id: string }>("POST", `/sessions/${session.id}/tasks`, { command: "printf trusted; printf problem >&2" });
    const ended = await apiCall<{ status: string }>("GET", `/tasks/${task.id}/wait?timeout_ms=10000`);
    expect(ended.status).toBe("completed");
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).click();
    const panel = sessionView(page, session.id).getByTestId("tasks-panel");
    await openDetails(panel);
    await panel.getByRole("button", { name: "출력", exact: true }).click();
    await expect(panel.getByTestId("task-output")).toHaveText("trusted");
    // globalSetup이 소유한 시험 서버의 해당 로그만 바꾼다.
    const logs = join(dirname(state().projA), "data", "tasks");
    unlinkSync(join(logs, `${task.id}.err`));
    await panel.getByRole("button", { name: "stderr", exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText("로그 원문이 없습니다.");
    await expect(panel.getByTestId("task-output")).toHaveText("");
    await panel.getByRole("button", { name: "stdout", exact: true }).click();
    await expect(panel.getByTestId("task-output")).toHaveText("trusted");
    await expect(panel.getByRole("alert")).toHaveCount(0);
    writeFileSync(join(logs, `${task.id}.out`), "tainted");
    await panel.getByRole("button", { name: "새로고침", exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText("작업 로그 원문을 사용할 수 없습니다");
    await expect(panel.getByTestId("task-output")).toHaveText("");
});
