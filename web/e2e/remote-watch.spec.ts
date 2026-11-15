import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login, openDetails, openTool } from "./helpers";

// EXEC-014~017: 대화에서 원격 job 감시를 등록하고, 원격 성공·알림 저장/전달/열람과 감시 취소(원격 작업은 계속)를 구분해 보여 준다.
test("원격 작업 감시는 원격 성공과 알림 단계를 따로 보여 주고 취소는 조회만 멈춘다", async ({ page }) => {
    let state = "running";
    const hits: string[] = [];
    const server = createServer((req, res) => {
        hits.push(`${req.method} ${req.url}`);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ job: { state } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
        const { a } = await ensureProjects();
        const title = `원격 감시 ${Date.now()}`;
        const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
        await login(page);
        await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
        const panel = page.getByTestId("session-view").getByTestId("remote-watches");
        await openTool(page.getByTestId("session-view"), "원격 감시");
        await openDetails(panel);
        const add = async (name: string, path: string) => {
            await panel.getByLabel("감시 이름").fill(name);
            await panel.getByLabel("상태 URL").fill(`http://127.0.0.1:${port}${path}`);
            await panel.getByLabel("상태 위치(JSON pointer)").fill("/job/state");
            await panel.getByRole("button", { name: "감시 시작" }).click();
        };
        await add("배포", "/deploy");
        const deploy = panel.getByTestId("remote-watch").filter({ hasText: "배포" });
        await expect(deploy).toContainText("원격 상태 running · 확인 1회", { timeout: 10_000 });
        await expect(deploy).toContainText("감시 중");

        state = "success";
        await deploy.getByRole("button", { name: "지금 확인" }).click();
        await expect(deploy).toHaveAttribute("data-status", "succeeded", { timeout: 10_000 });
        await expect(deploy).toContainText("원격 성공");
        await expect(page.getByTestId("session-view").getByTestId("msg-remote-watch")).toContainText("원격 작업 배포: 원격 성공 · 원격 상태 success");
        // 알림함을 제거한 화면은 서버 기록을 자동으로 전달·열람 확정하지 않는다.
        await expect(deploy.getByTestId("remote-watch-notice")).toContainText("알림 저장됨 · 앱 전달 미확인 · 미열람", { timeout: 10_000 });
        await expect(page.getByTestId("notifications")).toHaveCount(0);

        // 감시 취소는 이 서버의 조회만 멈춘다
        state = "running";
        await add("빌드", "/build");
        const build = panel.getByTestId("remote-watch").filter({ hasText: "빌드" });
        await expect(build).toContainText("확인 1회", { timeout: 10_000 });
        await build.getByRole("button", { name: "감시 취소(원격 작업은 계속)" }).click();
        await expect(build).toHaveAttribute("data-status", "cancelled");
        const before = hits.length;
        await page.waitForTimeout(1500);
        expect(hits.length).toBe(before);
        expect(hits.every((h) => h.startsWith("GET "))).toBe(true);
    } finally {
        server.close();
    }
});
