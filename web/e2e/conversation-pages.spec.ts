import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { apiCall, ensureProjects, login, state } from "./helpers";

test("도구 기록이 많아도 대화를 열 때 최근 질문과 답변을 함께 보여 준다", async ({ page }) => {
    const { a } = await ensureProjects();
    const title = `도구 기록이 긴 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", `/sessions/${s.id}/messages`, { text: "앞서 나눈 질문" });
    await apiCall("POST", `/sessions/${s.id}/messages`, { text: "작업을 시작한 질문" });
    // 격리된 DB에 모델 호출 없이 긴 내부 도구 이력을 만든다.
    const db = new DatabaseSync(join(state().work, "data", "grove.db"));
    try {
        db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
        const add = db.prepare("INSERT INTO messages (id, session_id, seq, role, content, created_at) VALUES (?,?,?,?,?,?)");
        const now = new Date().toISOString();
        for (let seq = 3; seq <= 512; seq++) add.run(`${s.id}-${seq}`, s.id, seq, "tool", '{"output":"숨긴 로그"}', now);
        add.run(`${s.id}-513`, s.id, 513, "assistant", '{"text":"마지막 작업 답변"}', now);
        db.prepare("UPDATE sessions SET last_message_seq=513 WHERE id=?").run(s.id);
        db.exec("COMMIT");
    } finally { db.close(); }
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    const reads = messageReads(page, s.id);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.locator(`[data-testid=session-view][data-session="${s.id}"]`);
    for (const text of ["마지막 작업 답변", "작업을 시작한 질문", "앞서 나눈 질문"]) {
        await expect(view.getByText(text, { exact: true })).toBeInViewport();
    }
    await expect(view.getByRole("button", { name: "이전 메시지", exact: true })).toHaveCount(0);
    expect(reads).toEqual([]);
});

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

// 오래된 검색 결과는 100개씩 거슬러 올라가지 않고 목적지 주변과 사이 구간을 병렬로 읽는다.
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
    const reads = messageReads(page, long.id);
    const row = page.getByTestId("project-row").filter({ hasText: project.name });
    await row.getByRole("button", { name: "프로젝트 메뉴", exact: true }).click();
    await page.getByRole("dialog", { name: `${project.name} 메뉴`, exact: true }).getByRole("button", { name: "기록", exact: true }).click();
    const history = page.getByRole("dialog", { name: `${project.name} 기록`, exact: true });
    await history.getByLabel("대화 검색").fill(word);
    await history.getByTestId("search-hit").getByRole("button", { name: "아주 긴 대화", exact: true }).click();
    const view = page.getByTestId("session-view").filter({ visible: true });
    const target = view.locator('[data-seq][data-highlighted="true"]');
    await expect(target).toHaveCount(1, { timeout: 15_000 });
    await expect(target).toContainText(word);
    await expect(target).toBeInViewport();
    // 100개씩이면 6번 순차 요청. 목적지 문맥 1번 + 500개 창 2번 이내로 끝난다.
    expect(reads.length).toBeLessThanOrEqual(3);
});
