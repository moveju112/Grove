import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, composerOption, ensureProjects, login, openDetails, selectChoice, sessionView, state } from "./helpers";

test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "전용 CLI fixture로 실행: GROVE_E2E_FAKE_CLI=1");

for (const theme of ["light", "dark"] as const) {
    for (const mode of ["collapsed", "expanded", "hidden"] as const) {
        test(`390px ${theme}: ${mode} 추론·진행 설명을 답변과 구분하고 답변 시작 시 접는다`, async ({ page }, info) => {
            await page.setViewportSize({ width: 390, height: 844 });
            await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
            const { a } = await ensureProjects();
            const profile = await apiCall<{ id: string }>("POST", "/agent-backends/codex_cli/connect");
            const title = `추론 구분 ${theme} ${mode}`;
            const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
            await login(page);
            await page.evaluate(({ theme, mode }) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme, reasoning: mode })), { theme, mode });
            await page.reload();
            const toggle = page.getByRole("button", { name: "사이드바", exact: true });
            if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
            const view = sessionView(page, session.id);
            try {
                await composerOption(view, "모델 프로필", profile.id);
                await composerOption(view, "보내기 방식", "model");
                await composerOption(view, "도구", false);
                await view.getByLabel("메시지 입력").fill("fixture-response-boundaries");
                await view.getByRole("button", { name: "보내기", exact: true }).click();
                await expect(view.getByTestId("partial")).toBeVisible();
                const pid = Number(readFileSync(join(state().cliDir!, "last-pid"), "utf8"));
                await expect.poll(() => existsSync(join(state().cliDir!, `response-ready-${pid}`))).toBe(true);
                const reasoning = view.getByTestId("partial-reasoning");
                if (mode === "hidden") {
                    await expect(reasoning).toHaveCount(0);
                    await expect(view.getByTestId("partial-progress")).toHaveCount(0);
                } else {
                    // 300자·3줄 및 2,000자 꼬리 제한 없이 시작부터 끝까지 본문에 표시한다.
                    const text = "링크 대상을 확인한다.\n" + "추론 내용을 생략하지 않고 표시한다.\n".repeat(120);
                    await expect(reasoning.getByText(text, { exact: true })).toBeAttached();
                    expect((await reasoning.boundingBox())!.height).toBeGreaterThan(300);
                    await expect(view.getByTestId("partial-progress")).toContainText("심볼릭 링크인지");
                }
                await expect(view.getByTestId("partial-answer")).toHaveCount(0);

                // 최종 답변이 생기는 순간을 완료 이벤트와 분리해 확인한다.
                writeFileSync(join(state().cliDir!, `response-release-${pid}`), "");
                await expect.poll(() => existsSync(join(state().cliDir!, `response-answer-ready-${pid}`))).toBe(true);
                await expect(view.getByTestId("partial-answer")).toContainText("맞아. 확인 결과 심볼릭 링크야.");
                await expect(view.getByTestId("partial-answer")).not.toContainText("심볼릭 링크인지");
                if (mode === "collapsed") {
                    await expect(reasoning.getByRole("button")).toBeVisible();
                    await expect(reasoning.getByText(/링크 대상을 확인한다/)).toHaveCount(0);
                    await expect(view.getByTestId("partial-progress").getByRole("button")).toBeVisible();
                } else if (mode === "expanded") {
                    await expect(reasoning).toContainText("링크 대상을 확인한다");
                    await expect(view.getByTestId("partial-progress")).toContainText("심볼릭 링크인지");
                }
                await page.screenshot({ path: info.outputPath("answer-streaming.png"), animations: "disabled" });
                writeFileSync(join(state().cliDir!, `response-finish-${pid}`), "");
                const answer = view.getByTestId("msg-assistant").last();
                await expect(answer.getByTestId("msg-answer")).toContainText("맞아. 확인 결과 심볼릭 링크야.");
                await expect(view.getByTestId("partial")).toHaveCount(0);
                const messages = await apiCall<{ items: { role: string; content: { text?: string; response_parts?: string[]; reasoning?: string } }[] }>("GET", `/sessions/${session.id}/messages`);
                const saved = messages.items.slice().reverse().find((m) => m.role === "assistant")!.content;
                expect(saved.response_parts).toEqual(["심볼릭 링크인지, 실제로 어느 파일을 가리키는지 확인할게.", "맞아. 확인 결과 심볼릭 링크야."]);
                expect(saved.reasoning).not.toContain("심볼릭 링크인지");
                if (mode === "collapsed") {
                    await openDetails(answer.getByTestId("msg-progress"));
                    await expect(answer.getByRole("dialog")).toContainText("심볼릭 링크인지");
                    await page.keyboard.press("Escape");
                }
                await page.reload();
                await expect(answer.getByTestId("msg-answer")).toContainText("맞아. 확인 결과 심볼릭 링크야.");
                await expect(answer.getByTestId("msg-progress")).toHaveCount(mode === "hidden" ? 0 : 1);
                await page.screenshot({ path: info.outputPath("answer-complete.png"), animations: "disabled" });
                const bounds = await view.evaluate((el) => {
                    // 입력창은 본문 여백까지 덮으므로 실제 스크롤 영역에서 가로 넘침을 잰다.
                    const pane = el.closest<HTMLElement>('[data-testid="pane-body"]')!;
                    return { width: pane.clientWidth, scroll: pane.scrollWidth };
                });
                expect(bounds.scroll, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.width + 1);
            } finally {
                const turns = await apiCall<{ id: string; status: string }[]>("GET", `/sessions/${session.id}/turns`);
                for (const turn of turns.filter((turn) => ["queued", "running", "awaiting_approval"].includes(turn.status))) {
                    await apiCall("POST", `/turns/${turn.id}/cancel`);
                }
                await page.evaluate(() => localStorage.removeItem("grove.device.prefs"));
            }
        });
    }
}
