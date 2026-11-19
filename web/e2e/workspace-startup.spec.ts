import { expect, test } from "@playwright/test";
import { apiCall, ensureProfile, ensureProjects, login, script, sessionView } from "./helpers";
import { frames } from "./fixture";
import { projectLayoutKey } from "../app/state/projectLayout";
import { workspaceTabsKey } from "../app/state/workspaceTabs";
import type { Layout, Tab } from "../app/state/layout";

test.use({ viewport: { width: 390, height: 844 } });

test("재실행 중 서버 위치와 도구 조회가 늦어도 최신 답변을 먼저 표시하고 모든 조회를 마친다", async ({ page }, info) => {
    const { a } = await ensureProjects();
    const title = `시작 복원 ${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    const old = "종료 전에 읽은 내용";
    const fresh = "종료 중 저장된 최신 답변";
    const profile = await ensureProfile();
    await apiCall("POST", `/sessions/${session.id}/messages`, { text: old });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
    if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
    const recent = page.getByRole("region", { name: "최근", exact: true });
    await recent.getByRole("button", { name: new RegExp(title) }).click();
    await expect(sessionView(page, session.id)).toContainText(old);
    const base = await page.evaluate(() => `${localStorage.getItem("grove.device.id")}-narrow`);
    const device = projectLayoutKey(base, a.id);
    const shared = workspaceTabsKey(a.id);
    await expect.poll(async () => JSON.stringify((await apiCall<{ layout: unknown }>("GET", `/layouts/${shared}`)).layout)).toContain(session.id);

    // 새 문서에는 메모리/이벤트 연결이 없다. 같은 기기의 저장소만 남긴다.
    await page.goto("about:blank");
    const question = `restore-fixture-${session.id}`;
    await script({ frames: frames.text([fresh]), marker: question });
    const accepted = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: question, profile_id: profile });
    await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${accepted.turn.id}`)).status).toBe("completed");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Set<string>();
    const finished = new Set<string>();
    for (const key of ["workspace-resume", device, shared, "tool-calls"]) {
        const path = key === "tool-calls" ? `**/api/v1/tool-calls?session_id=${session.id}*` : `**/api/v1/layouts/${key}`;
        await page.route(path, async (route) => {
            if (route.request().method() !== "GET") return route.continue();
            started.add(key);
            await gate;
            await route.continue();
        });
        page.on("response", (response) => {
            const url = new URL(response.url());
            if (url.pathname.endsWith(`/${key}`) && response.ok()) finished.add(key);
        });
    }
    try {
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await expect.poll(() => started.size).toBe(4);
        await expect(sessionView(page, session.id).getByTestId("msg-assistant").last()).toContainText(fresh);
        expect(finished.size).toBe(0);
        const elapsed = await page.evaluate(() => Math.round(performance.now()));
        info.annotations.push({ type: "latest-message-ms", description: String(elapsed) });
        console.log(JSON.stringify({ scenario: "cold document latest answer while other reads are held", latestAnswerMs: elapsed }));
        release();
        await expect.poll(() => finished.size).toBe(4);
        await expect(sessionView(page, session.id)).toContainText(fresh);
    } finally {
        release();
        await page.unrouteAll({ behavior: "wait" });
    }
});

for (const typing of [true, false]) {
    test(`재개 위치보다 공유 배치가 늦을 때 ${typing ? "현재 대화와 입력을 지킨다" : "조작이 없으면 서버 대화를 복원한다"}`, async ({ page }) => {
        const { a } = await ensureProjects();
        const makeTab = async (title: string): Promise<Tab> => {
            const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `${title} ${Date.now()}` });
            return { id: `tab-${session.id}`, kind: "session", project_id: a.id, resource_id: session.id, title };
        };
        const first = await makeTab("기기에 열려 있던 대화");
        const second = await makeTab("서버에서 이어갈 대화");
        const layout = (tabs: Tab[], selected: Tab): Layout => ({ schema: 1, focused_leaf: "resume-test",
            root: { type: "leaf", id: "resume-test", active_tab: selected.id, tabs } });
        const local = layout([first], first);
        const remote = layout([first, second], second);
        await login(page);
        const base = await page.evaluate(() => `${localStorage.getItem("grove.device.id")}-narrow`);
        const device = projectLayoutKey(base, a.id);
        const shared = workspaceTabsKey(a.id);
        const put = async (key: string, value: Layout) => {
            const { revision } = await apiCall<{ revision: number }>("GET", `/layouts/${key}`);
            await apiCall("PUT", `/layouts/${key}`, { expected_revision: revision, layout: value });
        };
        await page.evaluate(({ base, id, device, local }) => {
            localStorage.setItem(`grove.layout.selected.${base}`, id);
            localStorage.setItem(`grove.layout.${device}`, JSON.stringify(local));
        }, { base, id: a.id, device, local });
        await page.goto("about:blank");
        await put(device, local);
        await put(shared, remote);

        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        await page.route(`**/api/v1/layouts/${shared}`, async (route) => {
            if (route.request().method() === "GET") await gate;
            await route.continue();
        });
        try {
            const resume = page.waitForResponse((r) => r.url().endsWith("/layouts/workspace-resume") && r.ok());
            await page.goto("/", { waitUntil: "domcontentloaded" });
            expect((await (await resume).json()).layout).toEqual(remote);
            const input = sessionView(page, first.resource_id!).getByLabel("메시지 입력");
            await expect(input).toBeVisible();
            const draft = "공유 배치 응답을 기다리는 사이에 쓴 초안";
            if (typing) await input.fill(draft);
            release();
            // 공유 대화 조회·병합 자체는 생략하지 않고 기기 배치에 새 탭을 반영한다.
            await expect.poll(() => page.evaluate((key) => localStorage.getItem(`grove.layout.${key}`), device)).toContain(second.resource_id!);
            if (typing) {
                await expect(input).toHaveValue(draft);
                await expect(sessionView(page, second.resource_id!)).toBeHidden();
            } else await expect(sessionView(page, second.resource_id!)).toBeVisible();
        } finally {
            release();
            await page.unrouteAll({ behavior: "wait" });
        }
    });
}
