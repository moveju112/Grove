import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, ensureProfile, login, script, sessionView, state } from "./helpers";
import { frames } from "./fixture";

type Memory = { id: string; body: string; revision: number; project_id: string | null; source: string; source_session_id: string | null };
async function memories(project?: string) {
    return (await apiCall<{ items: Memory[] }>("GET", `/memories${project ? `?project_id=${project}` : ""}`)).items;
}
async function cleanup(prefix: string, project?: string) {
    for (const memory of (await memories(project)).filter((m) => m.body.startsWith(prefix))) {
        await apiCall("POST", `/memories/${memory.id}/delete`, { expected_revision: memory.revision, confirmed: true });
    }
}
async function openGlobal(page: Page) {
    await login(page);
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").last().fill("장기 기억");
    return page.getByTestId("memories-panel").last();
}

test("직접 확인한 프로젝트·전역 기억의 출처와 다음 턴 입력을 보이고 새로고침 뒤에도 보존한다", async ({ page }) => {
    const prefix = `memory-scope-${Date.now()}`;
    const model = await ensureProfile();
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", {
        root_path: mkdtempSync(join(dirname(state().projA), "memories-")),
    });
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: prefix });
    try {
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
        await login(page);
        await page.locator(".recent").getByRole("button", { name: new RegExp(prefix) }).click();
        await sessionView(page, session.id).getByRole("button", { name: "대화 설정" }).click();
        await page.getByLabel("설정 검색").last().fill("장기 기억");
        const panel = page.getByTestId("memories-panel").last();
        await expect(panel).toContainText("임시 작업 결과를 자동 저장하지 않습니다");
        await expect(panel).toContainText("과거 모델 요청·대화 사본·백업");
        await expect(panel.getByLabel("기억 적용 범위")).toHaveValue("project");
        const local = `${prefix} explicit local preference`;
        const global = `${prefix} explicit global preference`;
        await panel.getByLabel("확인한 기억 내용").fill(local);
        await panel.getByRole("button", { name: "확인하고 기억 저장" }).click();
        await expect(panel.getByTestId("memory-row").filter({ hasText: local })).toContainText(`프로젝트 “${project.name}”`);
        await expect(panel.getByTestId("memory-row").filter({ hasText: local })).toContainText(session.id);
        await panel.getByLabel("기억 적용 범위").selectOption("global");
        await panel.getByLabel("확인한 기억 내용").fill(global);
        await panel.getByRole("button", { name: "확인하고 기억 저장" }).click();
        await expect(panel.getByTestId("memory-row").filter({ hasText: global })).toContainText("전역(모든 프로젝트)");
        expect((await memories()).some((m) => m.body === local)).toBe(false);
        expect((await memories(project.id)).filter((m) => m.body.startsWith(prefix))).toHaveLength(2);
        const usage = await apiCall<{ memory_input_tokens: number }>("GET", `/sessions/${session.id}/context?profile_id=${model}`);
        expect(usage.memory_input_tokens).toBeGreaterThan(0);
        await script({ frames: frames.text(["memory scope answer"]), marker: "memory scope question" });
        const accepted = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: "memory scope question", profile_id: model });
        type Turn = { status: string; definition: { memories: { sha256: string; body?: string }[] } };
        await expect.poll(async () => (await apiCall<Turn>("GET", `/turns/${accepted.turn.id}`)).status).toBe("completed");
        const turn = await apiCall<Turn>("GET", `/turns/${accepted.turn.id}`);
        expect(turn.definition.memories.some((m) => m.sha256 === createHash("sha256").update(local).digest("hex"))).toBe(true);
        expect(turn.definition.memories.every((m) => m.body === undefined)).toBe(true);
        await page.reload();
        await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
        await page.getByLabel("설정 검색").last().fill("장기 기억");
        await expect(page.getByTestId("memories-panel").last().getByTestId("memory-row").filter({ hasText: global })).toContainText("사용자 직접 입력");
    } finally {
        await cleanup(prefix, project.id);
    }
});

test("기억 편집 충돌에서 초안을 보존하고 실제 응답 유실 뒤 같은 요청으로 한 번만 수정한다", async ({ page }) => {
    const prefix = `memory-edit-${Date.now()}`;
    const created = await apiCall<{ id: string }>("POST", "/memories", { body: `${prefix} initial`, confirmed: true });
    try {
        const panel = await openGlobal(page);
        const row = panel.getByTestId("memory-row").filter({ hasText: prefix });
        await row.getByRole("button", { name: "기억 수정" }).click();
        await panel.getByLabel("확인한 기억 내용").fill(`${prefix} local draft`);
        await apiCall("PUT", `/memories/${created.id}`, { expected_revision: 1, body: `${prefix} remote`, confirmed: true });
        await expect(panel).toContainText("다른 기기에서 먼저 바뀌었습니다");
        await panel.getByRole("button", { name: "확인하고 기억 저장" }).click();
        await expect(panel.getByRole("alert")).toBeVisible();
        await expect(panel.getByLabel("확인한 기억 내용")).toHaveValue(`${prefix} local draft`);
        await panel.getByRole("button", { name: "최신 기억 사용" }).click();
        await expect(panel.getByLabel("확인한 기억 내용")).toHaveValue(`${prefix} remote`);
        await panel.getByLabel("확인한 기억 내용").fill(`${prefix} recovered`);
        const sent: { key: string | undefined; body: unknown }[] = [];
        await page.route(`**/api/v1/memories/${created.id}`, async (route) => {
            if (route.request().method() !== "PUT") return route.continue();
            sent.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
            if (sent.length === 1) { await route.fetch(); await route.abort(); }
            else await route.continue();
        });
        await panel.getByRole("button", { name: "확인하고 기억 저장" }).click();
        await expect(panel.getByRole("group", { name: "기억 결과 재확인" })).toBeVisible();
        await expect(panel.getByLabel("확인한 기억 내용")).toHaveValue(`${prefix} recovered`);
        await panel.getByRole("button", { name: "같은 기억 요청 확인" }).click();
        await expect(panel.getByRole("group", { name: "기억 결과 재확인" })).toHaveCount(0);
        await expect(row).toContainText(`${prefix} recovered`);
        expect(sent).toHaveLength(2);
        expect(sent[0]!.key).toBeTruthy();
        expect(sent[1]).toEqual(sent[0]);
        expect((await memories()).find((m) => m.id === created.id)?.revision).toBe(3);
    } finally {
        await cleanup(prefix);
    }
});

test("기억 추가 응답 유실은 같은 키로 복구하고 삭제 전 변경된 revision은 다시 확인한다", async ({ page }) => {
    const prefix = `memory-recovery-${Date.now()}`;
    try {
        const panel = await openGlobal(page);
        const sent: string[] = [];
        await page.route("**/api/v1/memories", async (route) => {
            if (route.request().method() !== "POST") return route.continue();
            sent.push(route.request().headers()["idempotency-key"]!);
            if (sent.length === 1) { await route.fetch(); await route.abort(); }
            else await route.continue();
        });
        await panel.getByLabel("확인한 기억 내용").fill(`${prefix} initial`);
        await panel.getByRole("button", { name: "확인하고 기억 저장" }).click();
        await expect(panel.getByRole("group", { name: "기억 결과 재확인" })).toBeVisible();
        await panel.getByRole("button", { name: "같은 기억 요청 확인" }).click();
        await expect(panel.getByLabel("확인한 기억 내용")).toHaveValue("");
        expect(sent).toHaveLength(2);
        expect(sent[1]).toBe(sent[0]);
        const memory = (await memories()).find((m) => m.body.startsWith(prefix))!;
        const row = panel.getByTestId("memory-row").filter({ hasText: prefix });
        await row.getByRole("button", { name: "기억 삭제 확인" }).click();
        await apiCall("PUT", `/memories/${memory.id}`, { expected_revision: 1, body: `${prefix} changed before delete`, confirmed: true });
        await panel.getByRole("button", { name: "이 기억 삭제", exact: true }).click();
        await expect(panel.getByRole("alert")).toBeVisible();
        expect((await memories()).some((m) => m.id === memory.id)).toBe(true);
        await panel.getByRole("button", { name: "삭제 취소" }).click();
        await row.getByRole("button", { name: "기억 삭제 확인" }).click();
        await expect(panel.getByRole("group", { name: "기억 삭제 확인" })).toContainText("changed before delete");
        await panel.getByRole("button", { name: "이 기억 삭제", exact: true }).click();
        await expect(row).toHaveCount(0);
        expect((await memories()).some((m) => m.id === memory.id)).toBe(false);
    } finally {
        await cleanup(prefix);
    }
});

test("이전 서버에서는 지원하지 않는 장기 기억 편집·자동 저장 옵션을 보이지 않는다", async ({ page }) => {
    await page.route("**/api/v1/events**", (route) => route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "x-grove-protocol": "1" },
        body: `event: hello\ndata: ${JSON.stringify({ cursor: 0, protocol: 1, capabilities: ["trash_v1"] })}\n\n`,
    }));
    await page.goto("/");
    await page.locator("html[data-hydrated=true]").waitFor({ state: "attached" });
    await page.getByLabel("토큰").fill(state().token);
    await page.getByRole("button", { name: "로그인" }).click();
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").last().fill("장기 기억");
    await expect(page.getByTestId("memories-panel")).toHaveCount(0);
    await expect(page.locator(".settings-body").last()).toContainText("검색 결과 0개");
});
