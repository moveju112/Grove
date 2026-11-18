import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, script, state } from "./helpers";

for (const width of [390, 1280]) {
    test.describe(`${width}px 예약된 후속 답변`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
        test("대화를 닫아도 완료 후 같은 대화에 한 번 답하고 출처와 본문을 구분한다", async ({ page }, info) => {
            await page.emulateMedia({ reducedMotion: "reduce" });
            const { a } = await ensureProjects();
            const profile = await ensureProfile();
            const title = `report-${width}-${Date.now()}`;
            const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
            const sid = session.id;
            const prompt = `${title} 작업의 실제 완료 여부를 확인하고 보고해줘`;
            await script({ marker: title, frames: frames.text(["완료되면 다시 보고할게."]) });
            await script({ marker: title, frames: frames.text(["작업이 완료됐어. 결과 확인도 끝났어."]) });
            const original = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${sid}/turns`, {
                text: `${title} 작업 완료 후 보고해줘`, profile_id: profile, tools: true,
            });
            const job = await apiCall<{ id: string }>("POST", `/turns/${original.turn.id}/continuations`, {
                action: "external", request_id: title, prompt,
            });
            await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${original.turn.id}`)).status).toBe("completed");
            // No page/session is open when the external completion arrives.
            const signal = { status: "completed", detail: "internal-observation-only" };
            await apiCall("POST", `/continuations/${job.id}/complete`, signal);
            await expect.poll(async () => (await apiCall<{ id: string; status: string }[]>("GET", `/sessions/${sid}/turns`))
                .filter((turn) => turn.status === "completed").length).toBe(2);
            await apiCall("POST", `/continuations/${job.id}/complete`, signal);
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: sid });
            await login(page);
            if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
            const view = page.getByTestId("session-view");
            const report = view.getByTestId("msg-user").filter({ hasText: prompt });
            await expect(report).toHaveCount(1);
            await expect(report.getByTestId("msg-who")).toHaveText("예약된 후속 확인");
            await expect(view.getByTestId("msg-assistant").filter({ hasText: "작업이 완료됐어." })).toHaveCount(1);
            await expect(view).not.toContainText("internal-observation-only");
            await expect(view).not.toContainText("신뢰할 수 없는 관찰 데이터");
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
            await page.screenshot({ path: info.outputPath(`continuations-${width}.png`), animations: "disabled" });
            await page.reload();
            await expect(report.getByTestId("msg-who")).toHaveText("예약된 후속 확인");
            expect(await apiCall<unknown[]>("GET", `/sessions/${sid}/turns`)).toHaveLength(2);
            const observed = await fetch(`http://127.0.0.1:${state().fixturePort}/requests`).then((r) => r.json()) as { messages: unknown }[];
            expect(observed.some((request) => JSON.stringify(request.messages).includes("internal-observation-only"))).toBe(true);
        });
    });
}
