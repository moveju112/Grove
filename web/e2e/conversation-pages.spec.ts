import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, ensureProjects, login, state } from "./helpers";

function messageReads(page: Page, sessionId: string) {
    const urls: string[] = [];
    page.on("request", (request) => {
        const url = request.url();
        if (url.includes(`/sessions/${sessionId}/messages?`) && /before_seq|after_seq/.test(url)) urls.push(url);
    });
    return urls;
}

// 첫 응답 전에 '이전 메시지'를 연달아 눌러도 같은 페이지를 한 번만 요청하고 중복으로 붙이지 않는다.
test("이전 메시지를 연달아 눌러도 요청과 행이 한 번만 생긴다", async ({ page }) => {
    const { a } = await ensureProjects();
    const prefix = `double-${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: prefix });
    for (let i = 0; i < 130; i++) await apiCall("POST", `/sessions/${s.id}/messages`, { text: `${prefix} line ${i}` });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    const reads = messageReads(page, s.id);
    // 첫 응답을 늦춰 두 번째 입력이 응답 전에 도착하게 한다.
    await page.route(`**/sessions/${s.id}/messages?*before_seq*`, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        await route.continue();
    });
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(prefix) }).first().click();
    const view = page.locator(`[data-testid=session-view][data-session="${s.id}"]`);
    const more = view.getByRole("button", { name: "이전 메시지", exact: true });
    await more.click();
    await more.click({ force: true }).catch(() => undefined);
    await more.evaluate((el: HTMLButtonElement) => el.click()).catch(() => undefined);
    await expect(more).toHaveCount(0);
    await view.getByRole("feed", { name: "불러온 대화 메시지" }).focus();
    await page.keyboard.press("Home");
    await expect(view.getByText(`${prefix} line 0`, { exact: true })).toHaveCount(1);
    expect(reads).toHaveLength(1);
});

// 오래된 검색 결과는 목적지 양쪽 창만 읽는다. 배치 읽기가 완료되기 전 최신 본문 요청도 시작한다.
test("오래된 검색 결과로 이동할 때 목적지 주변을 바로 읽는다", async ({ page }) => {
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", {
        root_path: mkdtempSync(join(dirname(state().projA), "conversation-pages-")),
    });
    const word = `deep${Date.now()}`;
    const long = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: "아주 긴 대화" });
    for (let i = 0; i < 620; i++) {
        await apiCall("POST", `/sessions/${long.id}/messages`, { text: i === 5 ? `여기에 ${word} 가 있다` : `채움 ${i}` });
    }
    await login(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/v1/layouts/workspace-tabs-${project.id}`, async (route) => {
        if (route.request().method() === "GET") await held;
        await route.continue();
    });
    const reads = messageReads(page, long.id);
    const row = page.getByTestId("project-row").filter({ hasText: project.name });
    await row.getByRole("button", { name: "프로젝트 메뉴", exact: true }).click();
    await page.getByRole("dialog", { name: `${project.name} 메뉴`, exact: true }).getByRole("button", { name: "기록", exact: true }).click();
    const history = page.getByRole("dialog", { name: `${project.name} 기록`, exact: true });
    await history.getByLabel("대화 검색").fill(word);
    try {
        const latest = page.waitForResponse((r) => r.url().endsWith(`/sessions/${long.id}/messages?limit=100`) && r.ok());
        await history.getByTestId("search-hit").getByRole("button", { name: "아주 긴 대화", exact: true }).click();
        await latest;
    } finally { release(); }
    const view = page.getByTestId("session-view").filter({ visible: true });
    const target = view.locator('[data-seq][data-highlighted="true"]');
    await expect(target).toHaveCount(1, { timeout: 15_000 });
    await expect(target).toContainText(word);
    await expect(target).toBeInViewport();
    expect(reads.map((url) => new URL(url).search)).toEqual(["?limit=51&before_seq=7", "?limit=50&after_seq=6"]);
    const next = view.getByRole("button", { name: "이후 메시지", exact: true });
    await next.click();
    await expect.poll(() => reads.length).toBe(3);
    expect(new URL(reads[2]!).searchParams.get("after_seq")).toBe("56");
    await view.getByRole("button", { name: "최신 메시지로" }).click();
    await expect(view.getByText("채움 619", { exact: true })).toBeInViewport();
    await page.unrouteAll({ behavior: "wait" });
});
