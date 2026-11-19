import { expect, test } from "@playwright/test";
import { apiCall, ensureProfile, ensureProjects, login, script, sessionView } from "./helpers";
import { frames } from "./fixture";
import { projectLayoutKey } from "../app/state/projectLayout";
import { workspaceTabsKey } from "../app/state/workspaceTabs";

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
