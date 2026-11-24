import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login, sessionView } from "./helpers";
import type { Message, MessagePage } from "../app/api/generated";

for (const width of [390, 1400]) {
    test.describe(`${width}px 대화의 작업 기록`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760 });
        test("저장된 CLI 활동과 백그라운드 명령은 새로고침해도 보이지 않는다", async ({ page }) => {
            const { a } = await ensureProjects();
            const title = `CLI 도구 요약 ${width}`;
            const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
            const items = Array.from({ length: 21 }, (_, index) => ({
                kind: "command", name: "shell", input: `command-${index}`, status: "completed", exit_code: 0,
            }));
            const message: Message = {
                id: `cli-activity-${width}`, session_id: session.id, seq: 1, role: "note",
                content: { type: "cli_activity", items }, turn_id: null, created_at: new Date().toISOString(),
            };
            const task: Message = {
                ...message, id: `task-result-${width}`, seq: 2,
                content: { type: "task_result", command: "fixture-bg-command", status: "completed", stdout_tail: "fixture-bg-output" },
            };
            const cliActivity = items.map(({ kind, name, status }) => ({ kind, name, status }));
            const activityOnly: Message = {
                ...message, id: `activity-only-${width}`, seq: 3, role: "assistant", content: { cli_activity: cliActivity },
            };
            const answer: Message = {
                ...message, id: `answer-${width}`, seq: 4, role: "assistant",
                content: { text: "작업을 마쳤어.", cli_activity: cliActivity },
            };
            // 저장돼 있던 기록을 새 화면이 표시하지 않는지 확인한다.
            const data = await apiCall<MessagePage>("GET", `/sessions/${session.id}/messages?limit=100`);
            await page.route(`**/sessions/${session.id}/messages?*`, (route) =>
                route.fulfill({ json: { ...data, items: [message, task, activityOnly, answer] } }));
            await login(page);
            if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
            const view = sessionView(page, session.id);
            for (const reload of [false, true]) {
                if (reload) await page.reload();
                await expect(view.getByTestId("msg-assistant")).toContainText("작업을 마쳤어.");
                await expect(view).not.toContainText(/도구 활동|명령 실행|command-20|fixture-bg-command|fixture-bg-output/);
                await expect(view.locator("[data-seq='1'], [data-seq='2'], [data-seq='3']")).toHaveCount(0);
            }
        });
    });
}
