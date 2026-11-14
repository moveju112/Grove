import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, ensureProjects, login, openDetails, sessionView, state } from "./helpers";

test("메시지 작성 시각으로 회상하고 페이지 밖의 원문 메시지로 이동한다", async ({ page }) => {
    const { a } = await ensureProjects();
    const word = `recall-source-${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `회상 원문 ${word}` });
    const original = await apiCall<{ id: string }>("POST", `/sessions/${session.id}/messages`, { text: `오래된 원문 ${word}` });
    execFileSync("python3", ["-c", `
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute("UPDATE messages SET created_at='2000-01-01T00:00:00Z' WHERE id=?",(sys.argv[2],))
c.commit()
c.close()
`, join(dirname(state().projA), "data", "grove.db"), original.id]);
    for (let i = 0; i < 135; i++) {
        await apiCall("POST", `/sessions/${session.id}/messages`, { text: i < 30 ? `${word} 최근 근거 ${i}` : `회상 채움 ${i}` });
    }
    await login(page);
    const panel = page.getByTestId("search-panel");
    await openDetails(panel);
    await panel.getByLabel("검색 방식").selectOption("recall");
    await panel.getByLabel("대화 검색어").fill(word);
    await expect(panel.getByTestId("search-total")).toHaveText("31개");
    await expect(panel.getByTestId("search-hit")).toHaveCount(30);
    await panel.getByLabel("검색 기간").selectOption("1");
    await expect(panel.getByTestId("search-total")).toHaveText("30개");
    await expect(panel.getByRole("button", { name: "다음 회상 결과" })).toBeDisabled();
    await panel.getByLabel("검색 기간").selectOption("0");
    await expect(panel.getByTestId("search-total")).toHaveText("31개");
    await panel.getByRole("button", { name: "다음 회상 결과" }).click();
    await expect(panel.getByTestId("search-hit")).toHaveCount(1);
    const hit = panel.getByTestId("search-hit");
    await expect(hit).toContainText(`오래된 원문 ${word}`);
    await expect(hit).toContainText("원문 #1");
    await hit.getByRole("button").click();
    const target = sessionView(page, session.id).locator(".msg-row.focus-hit");
    await expect(target).toContainText(`오래된 원문 ${word}`);
    await expect(target).toBeInViewport();
});

test("보관 포함 회상에서도 대화 영구 삭제 뒤에는 서버와 화면 cache에서 결과가 사라진다", async ({ page }) => {
    const { a } = await ensureProjects();
    const word = `recall-delete-${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: word });
    await apiCall("POST", `/sessions/${session.id}/messages`, { text: `${word} 원문` });
    await login(page);
    const panel = page.getByTestId("search-panel");
    await openDetails(panel);
    await panel.getByLabel("검색 방식").selectOption("recall");
    await panel.getByLabel("대화 검색어").fill(word);
    await panel.getByRole("checkbox", { name: "보관된 대화·프로젝트 포함" }).check();
    await expect(panel.getByTestId("search-hit")).toHaveCount(1);
    const before = await apiCall<{ revision: number }>("GET", `/sessions/${session.id}`);
    await apiCall("PATCH", `/sessions/${session.id}`, { expected_revision: before.revision, archived: true });
    await expect(panel.getByTestId("search-hit")).toContainText("보관");
    const archived = await apiCall<{ revision: number; title: string }>("GET", `/sessions/${session.id}`);
    await apiCall("POST", `/sessions/${session.id}/delete`, { expected_revision: archived.revision, confirm_title: archived.title });
    expect((await apiCall<{ total: number }>("GET", `/recall?q=${word}&include_archived=true`)).total).toBe(0);
    await expect(panel.getByTestId("search-hit")).toHaveCount(0);
    await expect(panel.getByTestId("search-total")).toHaveText("0개");
});

test("이전 서버가 회상 기능을 알리지 않으면 미지원 선택지를 노출하지 않는다", async ({ page }) => {
    await page.route("**/api/v1/events**", (route) => route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "x-grove-protocol": "1" },
        body: `event: hello\ndata: ${JSON.stringify({ cursor: 0, protocol: 1, capabilities: ["trash_v1"] })}\n\n`,
    }));
    await page.goto("/");
    await page.locator("html[data-hydrated=true]").waitFor({ state: "attached" });
    await page.getByLabel("토큰").fill(state().token);
    await page.getByRole("button", { name: "로그인" }).click();
    const panel = page.getByTestId("search-panel");
    await openDetails(panel);
    await expect(panel.getByLabel("대화 검색어")).toBeVisible();
    await expect(panel.getByLabel("검색 방식")).toHaveCount(0);
});

test("프로젝트 보관 이벤트도 회상 cache를 갱신하고 명시적으로 보관 포함을 선택할 수 있다", async ({ page }) => {
    const word = `recall-project-${Date.now()}`;
    const project = await apiCall<{ id: string; revision: number }>("POST", "/projects", {
        root_path: mkdtempSync(join(dirname(state().projA), "recall-project-")),
    });
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: word });
    await apiCall("POST", `/sessions/${session.id}/messages`, { text: `${word} 원문` });
    await login(page);
    const panel = page.getByTestId("search-panel");
    await openDetails(panel);
    await panel.getByLabel("검색 방식").selectOption("recall");
    await panel.getByLabel("대화 검색어").fill(word);
    await expect(panel.getByTestId("search-hit")).toHaveCount(1);
    const archived = await apiCall<{ revision: number }>("PATCH", `/projects/${project.id}`, { expected_revision: project.revision, archived: true });
    try {
        await expect(panel.getByTestId("search-hit")).toHaveCount(0);
        await panel.getByRole("checkbox", { name: "보관된 대화·프로젝트 포함" }).check();
        await expect(panel.getByTestId("search-hit")).toHaveCount(1);
    } finally {
        await apiCall("PATCH", `/projects/${project.id}`, { expected_revision: archived.revision, archived: false });
    }
});
