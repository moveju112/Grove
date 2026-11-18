import { expect, test, type Page } from "@playwright/test";
import { apiCall, ensureProjects, login, openTool, sessionView } from "./helpers";

test("다른 기기의 설정 변경이 도착해도 편집 시작 revision을 보존하고 명시적으로 충돌을 해결한다", async ({ page, browser, baseURL }) => {
    const { a } = await ensureProjects();
    const title = `다중 기기 설정 ${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    const context = await browser.newContext({ baseURL });
    try {
        const other = await context.newPage();
        const open = async (p: Page) => {
            await login(p);
            await p.getByTestId("project-row").getByRole("button", { name: a.name, exact: true }).click();
            await p.getByTestId("project-view").getByRole("button", { name: new RegExp(`${title}$`) }).click();
            await openTool(sessionView(p, session.id), "대화");
            await sessionView(p, session.id).getByRole("button", { name: "대화 설정" }).click();
            await p.getByLabel("설정 검색").last().fill("요청당 시간 예산");
            return p.getByTestId("setting-runs.budget.max_minutes").last();
        };
        const first = await open(page);
        const second = await open(other);
        await first.getByLabel("요청당 시간 예산(분)", { exact: true }).fill("10");
        await second.getByLabel("요청당 시간 예산(분)", { exact: true }).fill("20");
        await second.getByLabel("요청당 시간 예산(분)", { exact: true }).blur();
        await expect(second).toContainText("저장됨");
        // SSE 재조회가 끝난 뒤 저장해야 최신 revision으로 바뀌는 결함을 재현한다.
        await expect.poll(async () => (await apiCall<{ items: { key: string; effective: unknown }[] }>("GET", `/settings/effective?session_id=${session.id}`)).items.find((item) => item.key === "runs.budget.max_minutes")?.effective).toBe(20);
        await expect(first.getByLabel("요청당 시간 예산(분)", { exact: true })).toHaveValue("10");
        const conflict = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes(`/settings/session/${session.id}/runs.budget.max_minutes`));
        await first.getByLabel("요청당 시간 예산(분)", { exact: true }).blur();
        expect((await conflict).status()).toBe(409);
        await expect(first).toContainText("내 입력은 보존했어요");
        await expect(first.getByLabel("요청당 시간 예산(분)", { exact: true })).toHaveValue("10");
        await first.getByRole("button", { name: "내 수정 적용", exact: true }).click();
        await expect(first).toContainText("저장됨");
        await expect(second.getByLabel("요청당 시간 예산(분)", { exact: true })).toHaveValue("10");

        // 충돌한 초안을 버리고 최신 값을 선택하는 경로도 같은 두 기기로 확인한다.
        await second.getByLabel("요청당 시간 예산(분)", { exact: true }).fill("30");
        await first.getByLabel("요청당 시간 예산(분)", { exact: true }).fill("40");
        await first.getByLabel("요청당 시간 예산(분)", { exact: true }).blur();
        await expect(first).toContainText("저장됨");
        await second.getByLabel("요청당 시간 예산(분)", { exact: true }).blur();
        await expect(second).toContainText("내 입력은 보존했어요");
        await second.getByRole("button", { name: "최신 값 사용", exact: true }).click();
        await expect(second.getByLabel("요청당 시간 예산(분)", { exact: true })).toHaveValue("40");
        await expect(second.getByRole("button", { name: "저장", exact: true })).toHaveCount(0);
    } finally {
        await context.close();
    }
});
