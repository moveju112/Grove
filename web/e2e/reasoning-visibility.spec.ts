import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProjects, login, openDetails, sessionView, state } from "./helpers";

test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "전용 CLI fixture로 실행: GROVE_E2E_FAKE_CLI=1");

for (const theme of ["light", "dark"] as const) {
    test(`390px ${theme}: 추론은 숨기고 진행 설명은 턴이 끝나면 접는다`, async ({ page }, info) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        const { a } = await ensureProjects();
        const profile = await apiCall<{ id: string }>("POST", "/agent-backends/codex_cli/connect");
        const title = `진행 설명 구분 ${theme}`;
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
        await login(page);
        const toggle = page.getByRole("button", { name: "사이드바", exact: true });
        if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
        const view = sessionView(page, session.id);
        const accepted = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, {
            profile_id: profile.id, text: "fixture-response-boundaries", tools: false,
        });
        const progress = "심볼릭 링크인지, 실제로 어느 파일을 가리키는지 확인할게.";
        const final = "맞아. 확인 결과 심볼릭 링크야.";
        const summary = "링크 대상을 확인한다.";
        try {
            await expect(view.getByTestId("partial")).toBeVisible();
            const pid = Number(readFileSync(join(state().cliDir!, "last-pid"), "utf8"));
            await expect.poll(() => existsSync(join(state().cliDir!, `response-ready-${pid}`))).toBe(true);
            const live = view.getByTestId("partial");
            await expect(live.getByTestId("progress-step")).toHaveText([progress]);
            await expect(live).not.toContainText(summary);
            await expect(live.getByTestId("partial-answer")).toHaveCount(0);
            await page.screenshot({ path: info.outputPath("progress-streaming.png"), animations: "disabled" });

            // 답변 시작과 턴 완료를 분리해 최종 답변이 시작되는 순간의 표시를 확인한다.
            writeFileSync(join(state().cliDir!, `response-release-${pid}`), "");
            await expect.poll(() => existsSync(join(state().cliDir!, `response-answer-ready-${pid}`))).toBe(true);
            await expect(live.getByTestId("partial-answer")).toContainText(final);
            await expect(live.getByTestId("partial-answer")).not.toContainText(progress);
            await expect(live.getByTestId("progress-step")).toHaveText([progress]);
            await expect(live).not.toContainText(summary);

            writeFileSync(join(state().cliDir!, `response-finish-${pid}`), "");
            const answer = view.getByTestId("msg-assistant");
            await expect(answer).toHaveCount(1);
            await expect(answer.getByTestId("msg-answer")).toContainText(final);
            await expect(live).toHaveCount(0);
            const messages = await apiCall<{ items: { role: string; content: { response_parts?: string[]; reasoning?: string } }[] }>("GET", `/sessions/${session.id}/messages`);
            const saved = messages.items.filter((m) => m.role === "assistant").at(-1)!.content;
            expect(saved.response_parts).toEqual([progress, final]);
            expect(saved.reasoning).toContain(summary);

            // 접힌 버튼의 글자도 답변과 같은 왼쪽 기준선에서 시작한다.
            const details = answer.getByTestId("msg-progress");
            await expect(details.getByRole("button")).toBeVisible();
            const progressStart = await details.getByRole("button").evaluate((node) => {
                const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                const range = document.createRange();
                range.selectNodeContents(walker.nextNode()!);
                return range.getBoundingClientRect().x;
            });
            const answerStart = (await answer.getByTestId("msg-answer").boundingBox())!.x;
            expect(progressStart).toBeCloseTo(answerStart, 0);
            await openDetails(details);
            const dialog = page.getByRole("dialog", { name: "진행 설명" });
            await expect(dialog.getByTestId("progress-step")).toHaveText([progress]);
            await expect(dialog).not.toContainText(summary);
            await page.keyboard.press("Escape");
            await page.reload();
            await expect(answer.getByTestId("msg-answer")).toContainText(final);
            await expect(details).toBeVisible();
            await expect(answer).not.toContainText(summary);
            await page.screenshot({ path: info.outputPath("answer-complete.png"), animations: "disabled" });
            const bounds = await view.evaluate((el) => {
                const pane = el.closest<HTMLElement>('[data-testid="pane-body"]')!;
                return { width: pane.clientWidth, scroll: pane.scrollWidth };
            });
            expect(bounds.scroll, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.width + 1);
        } finally {
            const turn = await apiCall<{ status: string }>("GET", `/turns/${accepted.turn.id}`);
            if (["queued", "running", "awaiting_approval"].includes(turn.status)) {
                await apiCall("POST", `/turns/${accepted.turn.id}/cancel`);
            }
        }
    });
}
