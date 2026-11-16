import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login, sessionView } from "./helpers";
import type { Message, MessagePage } from "../app/api/generated";

for (const width of [390, 1400]) {
    test.describe(`${width}px CLI 도구 요약`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760 });
        test("21번의 shell 호출을 짧게 묶고 상세와 새로고침에서 기록을 보존한다", async ({ page }, info) => {
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
            // 활동 메시지의 표시만 주입한다. CLI 실행·인증 경계를 검증하는 시험은 아니다.
            const data = await apiCall<MessagePage>("GET", `/sessions/${session.id}/messages?limit=100`);
            await page.route(`**/sessions/${session.id}/messages?*`, (route) =>
                route.fulfill({ json: { ...data, items: [message] } }));
            await login(page);
            if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
            const summary = sessionView(page, session.id).getByTestId("msg-cli-activity");
            await expect(summary).toContainText("CLI 도구 21회 · shell 21회");
            expect((await summary.innerText()).match(/shell/g)).toHaveLength(1);
            await page.screenshot({ path: info.outputPath("cli-summary.png"), fullPage: true });
            await summary.getByRole("button").click();
            const detail = summary.getByRole("dialog", { name: "CLI 도구 활동", exact: true });
            await expect(detail).toBeVisible();
            expect(JSON.parse(await detail.locator("pre").innerText())).toEqual(items);
            await page.keyboard.press("Escape");
            await page.reload();
            await expect(summary).toContainText("CLI 도구 21회 · shell 21회");
        });
    });
}
