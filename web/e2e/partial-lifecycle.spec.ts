import { expect, test, type Page } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, script, sessionView } from "./helpers";

async function openSession(page: Page, title: string) {
    const { a } = await ensureProjects();
    const profile = await ensureProfile();
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
    if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    return { profile, session, view: sessionView(page, session.id) };
}

for (const width of [390, 1400]) {
    test.describe(`${width}px 임시 응답 수명`, () => {
        test.use({ viewport: { width, height: 844 } });

        test("partial 삭제 신호를 놓쳐도 완료된 응답을 중복 표시하지 않고 다음 턴만 표시한다", async ({ page }, info) => {
            // 실제 서버 SSE에서 비영속 삭제 frame만 유실시킨다. 확정 메시지·턴은 실제 API를 쓴다.
            await page.addInitScript(() => {
                const original = window.fetch.bind(window);
                window.fetch = async (...args) => {
                    const response = await original(...args);
                    if (!String(args[0]).includes("/api/v1/events?") || !response.body) return response;
                    let buffer = "";
                    const body = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, string>({
                        transform(chunk, controller) {
                            buffer += chunk;
                            let end: number;
                            while ((end = buffer.indexOf("\n\n")) >= 0) {
                                const frame = buffer.slice(0, end);
                                buffer = buffer.slice(end + 2);
                                if (frame.startsWith("event: partial\n")) {
                                    const data = frame.split("\n").find((line) => line.startsWith("data: "))!;
                                    if (JSON.parse(data.slice(6)).snapshot === null) {
                                        const root = document.documentElement;
                                        root.dataset.droppedPartials = String(Number(root.dataset.droppedPartials ?? 0) + 1);
                                        continue;
                                    }
                                }
                                controller.enqueue(frame + "\n\n");
                            }
                        },
                        flush(controller) { if (buffer) controller.enqueue(buffer); },
                    })).pipeThrough(new TextEncoderStream());
                    return new Response(body, { status: response.status, headers: response.headers });
                };
            });
            const { profile, session, view } = await openSession(page, `삭제 신호 ${width}`);
            const question = `first-partial-${width}`;
            await script({ frames: frames.text(["첫 진행 설명", " · 완료 답변"]), delayMs: 500, marker: question });
            const first = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: question, profile_id: profile });
            await expect(view.getByTestId("partial")).toContainText("첫 진행 설명");
            await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${first.turn.id}`)).status).toBe("completed");
            await expect.poll(() => page.evaluate(() => Number(document.documentElement.dataset.droppedPartials ?? 0))).toBeGreaterThan(0);
            await expect(view.getByTestId("msg-assistant")).toHaveCount(1);
            await expect(view.getByTestId("msg-assistant")).toContainText("첫 진행 설명 · 완료 답변");
            await expect(view.getByTestId("partial")).toHaveCount(0);
            await script({ frames: frames.text(["두 번째 진행 설명"]).slice(0, 1), hang: true, marker: `next-partial-${width}` });
            const next = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: `next-partial-${width}`, profile_id: profile });
            try {
                await expect(view.getByTestId("partial")).toContainText("두 번째 진행 설명");
                await expect(view.getByTestId("partial")).not.toContainText("첫 진행 설명");
                await expect(view.getByTestId("msg-user")).toHaveCount(2);
                await expect(view.getByTestId("msg-assistant")).toHaveCount(1);
                await page.screenshot({ path: info.outputPath("next-turn.png"), animations: "disabled" });
            } finally {
                await apiCall("POST", `/turns/${next.turn.id}/cancel`);
            }
            await expect(view.getByTestId("partial")).toHaveCount(0);
        });

        test("응답 중 끊겨 서버에서 완료되어도 재접속만으로 올바른 이력에 복귀한다", async ({ page }, info) => {
            const { profile, session, view } = await openSession(page, `재연결 ${width}`);
            const question = `offline-partial-${width}`;
            await script({ frames: frames.text(["연결 전 진행 설명", " · 연결 밖 완료 답변"]), delayMs: 700, marker: question });
            const accepted = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: question, profile_id: profile });
            await expect(view.getByTestId("partial")).toContainText("연결 전 진행 설명");
            try {
                await page.context().setOffline(true);
                await expect(page.getByTestId("offline-banner")).toBeVisible();
                await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${accepted.turn.id}`)).status).toBe("completed");
            } finally {
                await page.context().setOffline(false);
            }
            await expect(page.getByTestId("conn")).toHaveText("연결됨");
            await expect(view.getByTestId("msg-assistant")).toHaveCount(1);
            await expect(view.getByTestId("msg-assistant")).toContainText("연결 전 진행 설명 · 연결 밖 완료 답변");
            await expect(view.getByTestId("partial")).toHaveCount(0);
            await expect(view.getByTestId("msg-user")).toHaveCount(1);
            expect(await apiCall<unknown[]>("GET", `/sessions/${session.id}/turns`)).toHaveLength(1);
            await page.screenshot({ path: info.outputPath("reconnected.png"), animations: "disabled" });
        });
    });
}
