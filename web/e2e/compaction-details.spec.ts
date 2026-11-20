import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProfile, login, openContext, openDetails, script, sessionView, state } from "./helpers";
import { frames } from "./fixture";
import { conversationPagePath } from "../app/state/conversationPages";

type Effective = { items: { key: string; layers: Record<string, { value: unknown; revision: number }> }[] };

async function project() {
    return apiCall<{ id: string }>("POST", "/projects", { root_path: mkdtempSync(join(state().projA, "cmp-details-")) });
}

test("실제 압축의 생성 당시 모델·비용을 보존하고 페이지 밖 원문으로 이동한다", async ({ page }) => {
    const a = await project();
    const normal = await ensureProfile();
    const summary = await apiCall<{ id: string; revision: number }>("POST", "/model-profiles", {
        name: "CMP-011 생성 당시", protocol: "openai", model: "summary-fixture",
        base_url: `http://127.0.0.1:${state().fixturePort}/v1`,
        options: { pricing: { currency: "EUR", version: "fixture-v1", input_per_mtok: 2, output_per_mtok: 4 } },
    });
    const previous = (await apiCall<Effective>("GET", "/settings/effective")).items.find((item) => item.key === "context.summary_profile")!.layers.server!;
    try {
        const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "CMP-011 압축 상세" });
        await apiCall("PUT", "/settings/server/-/context.summary_profile", { expected_revision: previous.revision, value: summary.id });
        for (let i = 0; i < 115; i++) await apiCall("POST", `/sessions/${s.id}/messages`, { text: `보존 원문 ${i}` });
        for (const text of ["첫 질문", "최근 질문"]) {
            await script({ frames: frames.text(["긴 답변 ".repeat(50)]) });
            const t = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${s.id}/turns`, { profile_id: normal, text, tools: false });
            await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${t.turn.id}`)).status).toBe("completed");
        }
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
        await login(page);
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /CMP-011 압축 상세/ }).first().click();
        const view = sessionView(page, s.id);
        const response = frames.text(["첫 대화의 짧은 요약"]);
        response.splice(response.length - 1, 0, JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } }));
        await script({ frames: response, marker: "You compress a conversation" });
        const applied = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/sessions/${s.id}/compact`));
        const refreshed = page.waitForResponse(async (r) => r.request().method() === "GET" && r.url().endsWith(conversationPagePath(s.id))
            && (await r.json()).items.some((m: { content: { type?: string } }) => m.content.type === "compaction"));
        const context = await openContext(view);
        await context.getByRole("button", { name: "압축", exact: true }).click();
        expect((await applied).status()).toBe(201);
        await refreshed;
        // 긴 대화는 화면 밖 행을 렌더링하지 않는다. 기존 feed 탐색으로 마지막 기록을 연다.
        await view.getByRole("feed").focus();
        await page.keyboard.press("End");
        const note = view.getByTestId("msg-compaction");
        await expect(note).toHaveCount(1);
        await openDetails(note);
        await expect(note.getByTestId("compaction-model")).toContainText("CMP-011 생성 당시 · openai · 모델 summary-fixture");
        await expect(note.getByTestId("compaction-cost")).toContainText("0.000034 EUR");
        await expect(note).toContainText("fixture-v1");
        await expect(note).toContainText("모델 context를 복원하지 않습니다");
        await apiCall("PUT", `/model-profiles/${summary.id}`, { expected_revision: summary.revision, name: "수정 후", model: "edited-model", options: {} });
        await apiCall("DELETE", `/model-profiles/${summary.id}`);
        await page.reload();
        await view.getByRole("feed").focus();
        await page.keyboard.press("End");
        await openDetails(note);
        await expect(note.getByTestId("compaction-model")).toContainText("CMP-011 생성 당시");
        await expect(note.getByTestId("compaction-cost")).toContainText("0.000034 EUR");
        await note.getByRole("button", { name: "원문 처음으로" }).click();
        const target = view.locator('[data-seq][data-highlighted="true"]');
        await expect(target).toContainText("보존 원문 0");
        await expect(target).toBeInViewport();
    } finally {
        const current = (await apiCall<Effective>("GET", "/settings/effective")).items.find((item) => item.key === "context.summary_profile")!.layers.server!;
        await apiCall("PUT", "/settings/server/-/context.summary_profile", { expected_revision: current.revision, value: previous.value });
        // 삭제는 멱등이 아니므로 아직 남은 시험 소유 프로필만 정리한다.
        const profiles = await apiCall<{ id: string }[]>("GET", "/model-profiles");
        if (profiles.some((p) => p.id === summary.id)) await apiCall("DELETE", `/model-profiles/${summary.id}`);
    }
});

test("usage·가격 누락과 원문 조회 실패를 성공·0 비용으로 표시하지 않는다", async ({ page }) => {
    const a = await project();
    const pid = await ensureProfile();
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "CMP-011 누락" });
    for (const text of ["앞 질문", "뒤 질문"]) {
        await script({ frames: frames.text(["충분히 긴 답 ".repeat(50)]) });
        const t = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${s.id}/turns`, { profile_id: pid, text, tools: false });
        await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${t.turn.id}`)).status).toBe("completed");
    }
    await script({ frames: frames.text(["요약"]), marker: "You compress a conversation" });
    await apiCall("POST", `/sessions/${s.id}/compact`, { profile_id: pid });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /CMP-011 누락/ }).first().click();
    const note = sessionView(page, s.id).getByTestId("msg-compaction");
    await openDetails(note);
    await expect(note.getByTestId("compaction-cost")).toContainText("추정 불가: 사용량 미보고 또는 0(구분 불가) · 가격 미기록");
    await page.route(`**/api/v1/sessions/${s.id}/messages?limit=1&*`, (route) => route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ items: [], has_more_before: false, has_more_after: false, timeline_revision: 0, rewind_boundary_seq: null }),
    }));
    await note.getByRole("button", { name: "원문 끝으로" }).click();
    await expect(note.getByRole("alert")).toContainText("보존된 원문을 찾을 수 없어 이동할 수 없습니다");
    await page.unroute(`**/api/v1/sessions/${s.id}/messages?limit=1&*`);
    await page.route(`**/api/v1/sessions/${s.id}/messages?limit=1&*`, (route) => route.fulfill({
        status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "forbidden", message: "fixture 접근 거절" } }),
    }));
    await openDetails(note);
    await note.getByRole("button", { name: "원문 처음으로" }).click();
    await expect(note.getByRole("alert")).toContainText("원문 조회 실패: fixture 접근 거절");
});

test("자동 압축 성공과 적용 거절을 구분하고 legacy 기록을 소급하지 않는다", async ({ page }) => {
    const a = await project();
    const p = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: "CMP-011 자동", protocol: "openai", model: "auto-summary-fixture",
        base_url: `http://127.0.0.1:${state().fixturePort}/v1`, options: { context_window: 20 },
    });
    try {
        const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "CMP-011 자동 기록" });
        for (const [key, value] of [["auto_compact_percent", 1], ["compact_min_tokens", 0]] as const) {
            await apiCall("PUT", `/settings/project/${a.id}/context.${key}`, { expected_revision: 0, value });
        }
        for (let i = 0; i < 3; i++) {
            if (i > 0) await script({ marker: "You compress a conversation", frames: frames.text([i === 1 ? "짧은 자동 요약" : "너무 긴 후보 ".repeat(1000)]) });
            await script({ frames: frames.text(["정상 답 ".repeat(50)]) });
            const t = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${s.id}/turns`, { profile_id: p.id, text: `질문 ${i}`, tools: false });
            await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${t.turn.id}`)).status).toBe("completed");
        }
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
        await login(page);
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /CMP-011 자동 기록/ }).first().click();
        const view = sessionView(page, s.id);
        const note = view.getByTestId("msg-compaction");
        await expect(note).toHaveCount(1);
        await expect(note).toContainText("자동 압축");
        await openDetails(note);
        await expect(note.getByTestId("compaction-model")).toContainText("auto-summary-fixture");
        await expect(view).toContainText("자동 압축 실패(적용하지 않음");
        await expect(view).toContainText("요약(");
        // 과거 서버의 note 형태로 읽어도 현재 프로필을 과거 실행값으로 보충하지 않는다.
        await page.route(`**/api/v1${conversationPagePath(s.id)}`, async (route) => {
            const response = await route.fetch();
            const data = await response.json();
            for (const message of data.items) {
                if (message.content.type === "compaction") {
                    for (const key of ["generation", "pricing", "estimated_cost", "cost_status"]) delete message.content[key];
                }
            }
            await route.fulfill({ response, json: data });
        });
        await page.reload();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /CMP-011 자동 기록/ }).first().click();
        await openDetails(note);
        await expect(note.getByTestId("compaction-model")).toContainText("생성 당시 모델 정보 미기록");
        await expect(note.getByTestId("compaction-cost")).toContainText("생성 당시 가격 기준 미기록");
    } finally {
        await apiCall("DELETE", `/model-profiles/${p.id}`);
    }
});
