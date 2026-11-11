import { expect, test, type Page } from "@playwright/test";
import { apiCall, ensureProfile, ensureProjects, login, script, sessionView, state } from "./helpers";
import { frames } from "./fixture";

async function open(page: Page, title: string) {
    const { a } = await ensureProjects();
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    const view = sessionView(page, session.id);
    await view.getByLabel("보내기 방식").selectOption("model");
    return { session, view };
}

test("응답 유실 뒤 실행 중 화면으로 바뀌어도 새 followup 대신 원래 요청을 같은 키로 확인한다", async ({ page }) => {
    const profile = await ensureProfile();
    const text = `uncertain running ${Date.now()}`;
    const { session, view } = await open(page, text);
    await view.getByLabel("모델 프로필").selectOption(profile);
    const turns: string[] = [];
    const followups: string[] = [];
    let lost = true;
    let original: string | undefined;
    await page.route(`**/api/v1/sessions/${session.id}/turns`, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        turns.push(route.request().headers()["idempotency-key"] ?? "");
        if (lost) {
            const committed = await route.fetch();
            original = (await committed.json() as { turn: { id: string } }).turn.id;
            return route.abort("connectionreset");
        }
        return route.fallback();
    });
    await page.route(`**/api/v1/sessions/${session.id}/followups`, async (route) => {
        if (route.request().method() === "POST") followups.push(route.request().headers()["idempotency-key"] ?? "");
        return route.fallback();
    });
    try {
        await script({ frames: [], hang: true, marker: text });
        await view.getByLabel("메시지 입력").fill(text);
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(view.getByTestId("send-unsure")).toBeVisible();
        await expect(view.getByLabel("실행 중 보내기 방식")).toBeVisible();
        await expect.poll(async () => JSON.stringify(await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json())).toContain(text);
        await expect(view.getByLabel("메시지 입력")).toHaveValue(text);
        lost = false;
        await view.getByRole("button", { name: "같은 요청 확인", exact: true }).click();
        await expect(view.getByLabel("메시지 입력")).toHaveValue("");
        expect(turns).toHaveLength(2);
        expect(turns[0]).toBeTruthy();
        expect(turns[1]).toBe(turns[0]);
        expect(followups).toHaveLength(0);
        const messages = await apiCall<{ items: { role: string; content: { text?: string } }[] }>("GET", `/sessions/${session.id}/messages`);
        expect(messages.items.filter((message) => message.role === "user" && message.content.text === text)).toHaveLength(1);
    } finally {
        if (original) await apiCall("POST", `/turns/${original}/cancel`);
        const queued = await apiCall<{ items: { id: string }[] }>("GET", `/sessions/${session.id}/followups`);
        for (const item of queued.items) await apiCall("DELETE", `/sessions/${session.id}/followups/${item.id}`);
    }
});

test("followup 응답 유실 뒤 실행이 종료돼도 같은 전송 위치와 키로 확인한다", async ({ page }) => {
    const profile = await ensureProfile();
    const title = `followup recovery ${Date.now()}`;
    const { session, view } = await open(page, title);
    await view.getByLabel("모델 프로필").selectOption(profile);
    const keys: string[] = [];
    const turnRequests: string[] = [];
    let lost = true;
    let original: string | undefined;
    await page.route(`**/api/v1/sessions/${session.id}/turns`, async (route) => {
        if (route.request().method() === "POST") turnRequests.push(route.request().headers()["idempotency-key"] ?? "");
        return route.fallback();
    });
    await page.route(`**/api/v1/sessions/${session.id}/followups`, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        keys.push(route.request().headers()["idempotency-key"] ?? "");
        if (lost) {
            await route.fetch();
            return route.abort("connectionreset");
        }
        return route.fallback();
    });
    try {
        await script({ frames: [], hang: true, marker: title });
        const response = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/sessions/${session.id}/turns`));
        await view.getByLabel("메시지 입력").fill(title);
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        original = ((await (await response).json()) as { turn: { id: string } }).turn.id;
        await expect.poll(async () => JSON.stringify(await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json())).toContain(title);
        await expect(view.getByLabel("실행 중 보내기 방식")).toBeVisible();
        await view.getByLabel("메시지 입력").fill("queued once");
        await view.getByRole("button", { name: "대기열에 추가", exact: true }).click();
        await expect(view.getByTestId("send-unsure")).toBeVisible();
        await apiCall("POST", `/turns/${original}/cancel`);
        original = undefined;
        await expect(view.getByTestId("turn-status")).toHaveCount(0);
        await expect(view.getByLabel("실행 중 보내기 방식")).toHaveCount(0);
        lost = false;
        await view.getByRole("button", { name: "같은 요청 확인", exact: true }).click();
        await expect(view.getByLabel("메시지 입력")).toHaveValue("");
        expect(keys).toHaveLength(2);
        expect(keys[0]).toBeTruthy();
        expect(keys[1]).toBe(keys[0]);
        expect(turnRequests).toHaveLength(1);
        const queued = await apiCall<{ items: { text: string }[] }>("GET", `/sessions/${session.id}/followups`);
        expect(queued.items.filter((item) => item.text === "queued once")).toHaveLength(1);
    } finally {
        if (original) await apiCall("POST", `/turns/${original}/cancel`);
        const queued = await apiCall<{ items: { id: string }[] }>("GET", `/sessions/${session.id}/followups`);
        for (const item of queued.items) await apiCall("DELETE", `/sessions/${session.id}/followups/${item.id}`);
    }
});

test("기본값으로 보낸 모델은 사용 선택으로 고정되고 다른 모델의 등록이 전송 대상을 바꾸지 않는다", async ({ page }) => {
    const suffix = `${Date.now()}`;
    const base_url = `http://127.0.0.1:${state().fixturePort}/v1`;
    const preferred = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: `000 recovery preferred ${suffix}`, protocol: "openai", base_url, model: "fixture-model",
    });
    let added: string | undefined;
    try {
        const { view } = await open(page, `pin default ${suffix}`);
        await expect(view.getByLabel("모델 프로필")).toHaveValue(preferred.id);
        await script({ frames: frames.text(["pinned first reply"]) });
        await view.getByLabel("메시지 입력").fill("use visible default");
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(view.getByTestId("msg-assistant").last()).toContainText("pinned first reply");
        await expect(view.getByTestId("turn-status")).toHaveCount(0);
        const name = `000 earlier ${suffix}`;
        const other = await apiCall<{ id: string }>("POST", "/model-profiles", {
            name, protocol: "openai", base_url, model: "other-model",
        });
        added = other.id;
        await expect(view.getByLabel("모델 프로필").getByRole("option", { name: new RegExp(name) })).toHaveCount(1);
        await expect(view.getByLabel("모델 프로필")).toHaveValue(preferred.id);
    } finally {
        if (added) await apiCall("DELETE", `/model-profiles/${added}`);
        await apiCall("DELETE", `/model-profiles/${preferred.id}`);
    }
});
