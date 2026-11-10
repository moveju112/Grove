import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, script } from "./helpers";

type Session = { id: string; revision: number; last_message_seq: number };
type Message = { id: string; seq: number };

test("메시지 ID로 되감으면 화면·검색이 갱신되고 새로고침 후에도 유지된다", async ({ page }) => {
    const { a } = await ensureProjects();
    const title = `되감기 대화 ${Date.now()}`;
    const s = await apiCall<Session>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", `/sessions/${s.id}/messages`, { text: "남길 메시지" });
    const needle = `RemoveRewind${Date.now()}`;
    await apiCall("POST", `/sessions/${s.id}/messages`, { text: needle });
    await apiCall("POST", `/sessions/${s.id}/messages`, { text: "뒤의 메시지" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    const search = page.getByTestId("search-panel");
    await search.locator("summary").click();
    await search.getByLabel("대화 검색어").fill(needle);
    await expect(search.getByTestId("search-hit")).toHaveCount(1);
    const row = view.locator(".msg-row").filter({ has: page.getByTestId("msg-user").filter({ hasText: needle }) });
    page.once("dialog", (d) => d.dismiss());
    await row.getByRole("button", { name: "이 메시지 이전으로 되감기" }).click();
    await expect(view.getByText("뒤의 메시지", { exact: true })).toBeVisible();
    page.once("dialog", async (d) => {
        expect(d.message()).toContain("파일·Git 변경과 실행 기록은 되돌리지 않습니다");
        await d.accept();
    });
    await row.getByRole("button", { name: "이 메시지 이전으로 되감기" }).click();
    await expect(view.getByTestId("msg-rewind")).toContainText("2개를 제외");
    await expect(view.getByTestId("msg-user")).toHaveCount(1);
    await expect(view.getByText("남길 메시지", { exact: true })).toBeVisible();
    await expect(search.getByTestId("search-total")).toHaveText("0개");
    await page.reload();
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    await expect(view.getByTestId("msg-rewind")).toBeVisible();
    await expect(view.getByTestId("msg-user")).toHaveCount(1);
});

test("다른 기기에서 되감은 뒤 늦게 도착한 이전 페이지가 메시지를 되살리지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    const title = `페이지 되감기 ${Date.now()}`;
    const s = await apiCall<Session>("POST", `/projects/${a.id}/sessions`, { title });
    const all: Message[] = [];
    for (let i = 0; i < 125; i++) all.push(await apiCall<Message>("POST", `/sessions/${s.id}/messages`, { text: `원문 ${i}` }));
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    await expect(view.getByText("원문 124", { exact: true })).toBeVisible();
    let release!: () => void;
    let fetched!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    const intercepted = new Promise<void>((r) => (fetched = r));
    await page.route(`**/api/v1/sessions/${s.id}/messages?limit=100&before_seq=*`, async (route) => {
        const old = await route.fetch();
        fetched();
        await pending;
        await route.fulfill({ response: old });
    });
    await view.getByRole("button", { name: "이전 메시지", exact: true }).click();
    await intercepted;
    const cur = await apiCall<Session>("GET", `/sessions/${s.id}`);
    await apiCall("POST", `/sessions/${s.id}/rewind`, {
        message_id: all[5]!.id, expected_revision: cur.revision, expected_last_message_seq: cur.last_message_seq,
    });
    await expect(view.getByTestId("msg-rewind")).toBeVisible();
    await expect(view.getByText("원문 124", { exact: true })).toHaveCount(0);
    const response = page.waitForResponse((r) => r.url().includes(`sessions/${s.id}/messages?limit=100&before_seq=`));
    release();
    await response;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(view.getByTestId("msg-user")).toHaveCount(5);
    await expect(view.getByRole("button", { name: "이전 메시지", exact: true })).toHaveCount(0);
    await expect(view.getByText("원문 24", { exact: true })).toHaveCount(0);
});

test("압축된 구간은 되감기를 막고 복구 가능한 범위와 파일 변경 분리를 설명한다", async ({ page }) => {
    const { a } = await ensureProjects();
    const profile = await ensureProfile();
    const title = `압축 되감기 ${Date.now()}`;
    const s = await apiCall<Session>("POST", `/projects/${a.id}/sessions`, { title });
    for (const text of ["압축 대상 질문", "압축 이후 질문"]) {
        await script({ frames: frames.text([`${text} 답`]) });
        const v = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${s.id}/turns`, { text, profile_id: profile });
        await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${v.turn.id}`)).status).toBe("completed");
    }
    await script({ marker: "You compress a conversation", frames: frames.text(["앞선 질문의 요약"]) });
    await apiCall("POST", `/sessions/${s.id}/compact`, { profile_id: profile });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    await expect(view.getByTestId("rewind-limit")).toContainText("seq 2까지");
    await expect(view.getByTestId("rewind-limit")).toContainText("파일·Git 변경은 별도");
    const rows = view.locator(".msg-row").filter({ has: page.getByTestId("msg-user") });
    await expect(rows.nth(0).getByRole("button", { name: "이 메시지 이전으로 되감기" })).toBeDisabled();
    await expect(rows.nth(1).getByRole("button", { name: "이 메시지 이전으로 되감기" })).toBeEnabled();
    page.once("dialog", (d) => d.accept());
    await rows.nth(1).getByRole("button", { name: "이 메시지 이전으로 되감기" }).click();
    await expect(view.getByTestId("msg-rewind")).toBeVisible();
    await expect(view.getByTestId("msg-compaction")).toContainText("앞선 질문의 요약");
    await expect(view.getByTestId("rewind-limit")).toBeVisible();
});
