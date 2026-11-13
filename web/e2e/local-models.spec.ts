import { expect, test, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { apiCall, composerOption, ensureProjects, login, openDetails, sessionView } from "./helpers";
import { frames } from "./fixture";

type Profile = { id: string; name: string; model: string; revision: number; base_url: string; secret_id: string | null };
const SECRET = "synthetic-local-http-key";

// 독립 loopback 서버: 목록 오류/경합은 실제 HTTP에서 재현하고 생성 요청은 별도로 센다.
async function localFixture() {
    let mode: "good" | "empty" | "invalid" | "denied" = "good";
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    let gate: Promise<void> | undefined;
    const calls: { path: string; authenticated: boolean; model?: string }[] = [];
    const server = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const authenticated = request.headers.authorization === `Bearer ${SECRET}`;
        calls.push({ path: request.url!, authenticated, ...(body ? { model: (JSON.parse(body) as { model: string }).model } : {}) });
        response.setHeader("content-type", "application/json");
        if (request.method === "GET" && request.url === "/v1/models") {
            const snapshot = mode;
            if (gate) { entered!(); await gate; }
            if (snapshot === "denied") {
                response.statusCode = 401;
                response.end(JSON.stringify({ error: { message: `invalid key: ${SECRET}` } }));
            } else response.end(JSON.stringify(snapshot === "invalid" ? { models: ["not-openai"] }
                : { data: snapshot === "empty" ? [] : [{ id: "local-chosen" }, { id: "local-other" }] }));
        } else if (request.method === "POST" && request.url === "/v1/chat/completions") {
            response.setHeader("content-type", "text/event-stream");
            response.end(frames.text(["isolated local reply"]).map((frame) => `data: ${frame}\n\n`).join(""));
        } else {
            response.statusCode = 404;
            response.end(JSON.stringify({ error: { message: "unsupported local endpoint" } }));
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    return {
        base: `http://127.0.0.1:${address.port}/v1`, calls,
        setMode(next: typeof mode) { mode = next; },
        hold() {
            gate = new Promise<void>((resolve) => { release = resolve; });
            return new Promise<void>((resolve) => { entered = resolve; });
        },
        resume() { release?.(); gate = undefined; },
        async close() {
            release?.();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        },
    };
}

async function settings(page: Page) {
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("프로필");
    await openDetails(page.getByTestId("local-model-connection"));
    return page.getByRole("form", { name: "로컬 HTTP 모델 연결", exact: true });
}

async function fillLocal(page: Page, name: string, base: string, secret = "") {
    const form = await settings(page);
    await expect(form.getByLabel("로컬 endpoint")).toHaveValue("");
    await form.getByLabel("로컬 연결 이름").fill(name);
    await form.getByLabel("로컬 endpoint").fill(base);
    await form.getByLabel("로컬 수동 모델 ID").fill("manual-kept");
    await form.getByLabel("로컬 인증 비밀").selectOption(secret);
    return form;
}

test("명시 로컬 endpoint 저장·응답 유실 확인·실제 상태·명시 모델 선택 후 재연결에도 초안을 보존해 한 번만 대화한다", async ({ page, browser }) => {
    const fixture = await localFixture();
    const name = `zz local HTTP ${Date.now()}`;
    let profile: Profile | undefined;
    const context = await browser.newContext();
    try {
        await login(page);
        const form = await fillLocal(page, name, fixture.base);
        await expect(page.getByTestId("local-model-connection")).toContainText("이 브라우저·휴대폰이 아니라 Grove 서버");
        const keys: string[] = [];
        let lose = true;
        await page.route("**/api/v1/model-profiles", async (route) => {
            if (route.request().method() !== "POST") return route.fallback();
            keys.push(route.request().headers()["idempotency-key"] ?? "");
            if (lose) { await route.fetch(); return route.abort("connectionreset"); }
            return route.fallback();
        });
        await form.getByRole("button", { name: "로컬 연결 저장", exact: true }).click();
        const local = page.getByTestId("local-model-connection");
        await expect(local.getByRole("alert")).toContainText("입력은 보존");
        await expect(form.getByLabel("로컬 endpoint")).toHaveValue(fixture.base);
        await expect(form.getByLabel("로컬 수동 모델 ID")).toHaveValue("manual-kept");
        expect(keys).toHaveLength(1);
        expect(fixture.calls).toHaveLength(0);
        lose = false;
        await form.getByRole("button", { name: "같은 연결 저장 요청 확인" }).click();
        await expect(local.getByRole("status")).toContainText("로컬 프로필 저장됨");
        expect(keys).toHaveLength(2);
        expect(keys[0]).toBeTruthy();
        expect(keys[1]).toBe(keys[0]);
        const profiles = (await apiCall<Profile[]>("GET", "/model-profiles")).filter((p) => p.name === name);
        expect(profiles).toHaveLength(1);
        profile = profiles[0]!;
        expect(profile.secret_id).toBeNull();
        const row = page.getByTestId("model-profile").filter({ hasText: name });
        const model = row.locator(":scope > code");
        await expect(row.getByTestId("profile-check")).toContainText("연결 확인 안 함");
        await row.getByRole("button", { name: "연결 확인", exact: true }).click();
        await expect(row.getByTestId("profile-check")).toContainText("연결됨");
        await expect(row.getByTestId("profile-check")).toContainText("이 모델 없음");
        await row.getByRole("button", { name: "모델 목록 새로고침" }).click();
        const select = row.getByLabel(`${name} 공급자 모델`);
        await expect(select).toBeEnabled();
        await expect(model).toHaveText("manual-kept");
        expect(fixture.calls.every((call) => call.path === "/v1/models" && !call.authenticated)).toBe(true);
        await select.selectOption("local-chosen");
        await expect(model).toHaveText("local-chosen");
        await expect(row.getByTestId("profile-check")).toContainText("연결 확인 안 함");
        await expect(select).toBeDisabled();
        await row.getByRole("button", { name: "연결 확인", exact: true }).click();
        await expect(row.getByTestId("profile-check")).toContainText("모델 확인됨");
        const { a } = await ensureProjects();
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: name });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
        const app = await context.newPage();
        await login(app);
        await app.locator(".recent").getByRole("button", { name: new RegExp(name) }).click();
        const view = sessionView(app, session.id);
        await composerOption(view, "보내기 방식", "model");
        await view.getByLabel("모델 프로필").selectOption(profile.id);
        const draft = view.getByLabel("메시지 입력");
        await draft.fill("local draft survives reconnect");
        await context.setOffline(true);
        // 이미 열린 SSE는 즉시 끊기지 않을 수 있다. 실제 offline UI와 전송 차단을 확인한다.
        await expect(app.getByTestId("offline-banner")).toBeVisible();
        await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeDisabled();
        await expect(draft).toHaveValue("local draft survives reconnect");
        await expect(view.getByLabel("모델 프로필")).toHaveValue(profile.id);
        await context.setOffline(false);
        await app.reload();
        await expect(app.getByTestId("conn")).toHaveText("연결됨", { timeout: 10_000 });
        await expect(draft).toHaveValue("local draft survives reconnect");
        await expect(view.getByLabel("모델 프로필")).toHaveValue(profile.id);
        const turns: string[] = [];
        let lostTurn = true;
        await app.route(`**/api/v1/sessions/${session.id}/turns`, async (route) => {
            if (route.request().method() !== "POST") return route.fallback();
            turns.push(route.request().headers()["idempotency-key"] ?? "");
            if (lostTurn) { await route.fetch(); return route.abort("connectionreset"); }
            return route.fallback();
        });
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(view.getByTestId("send-unsure")).toBeVisible();
        await expect(view.getByTestId("msg-assistant").last()).toContainText("isolated local reply");
        await expect(draft).toHaveValue("local draft survives reconnect");
        expect(turns).toHaveLength(1);
        lostTurn = false;
        await view.getByRole("button", { name: "같은 요청 확인", exact: true }).click();
        await expect(draft).toHaveValue("");
        expect(turns).toHaveLength(2);
        expect(turns[1]).toBe(turns[0]);
        await expect(view.getByTestId("turn-status")).toHaveCount(0);
        expect(fixture.calls.filter((call) => call.path === "/v1/chat/completions")).toEqual([
            { path: "/v1/chat/completions", authenticated: false, model: "local-chosen" },
        ]);
        const messages = await apiCall<{ items: { role: string }[] }>("GET", `/sessions/${session.id}/messages`);
        expect(messages.items.filter((message) => message.role === "user")).toHaveLength(1);
    } finally {
        await context.close();
        // 응답 유실 직후 실패한 경우에도 이름으로 확인한 자기 프로필만 정리한다.
        const owned = profile ? [profile] : (await apiCall<Profile[]>("GET", "/model-profiles")).filter((p) => p.name === name);
        for (const item of owned) await apiCall("DELETE", `/model-profiles/${item.id}`);
        await fixture.close();
    }
});

test("로컬 목록의 오류·빈 목록·늦은 응답은 수동 선택을 바꾸지 않고 키를 가리며 재조회로 복구한다", async ({ page }) => {
    const fixture = await localFixture();
    const name = `zz local recovery ${Date.now()}`;
    const secret = await apiCall<{ id: string }>("POST", "/secrets", { label: name, value: SECRET });
    let profile: Profile | undefined;
    try {
        await login(page);
        const form = await fillLocal(page, name, fixture.base, secret.id);
        await form.getByRole("button", { name: "로컬 연결 저장", exact: true }).click();
        const row = page.getByTestId("model-profile").filter({ hasText: name });
        const model = row.locator(":scope > code");
        await expect(row).toBeVisible();
        profile = (await apiCall<Profile[]>("GET", "/model-profiles")).find((p) => p.name === name)!;
        const select = row.getByLabel(`${name} 공급자 모델`);
        const refresh = row.getByRole("button", { name: "모델 목록 새로고침" });
        await refresh.click();
        await expect(select).toBeEnabled();
        fixture.setMode("invalid");
        await refresh.click();
        await expect(row.getByRole("alert")).toContainText("마지막 조회 목록은 보존");
        await expect(select).toBeDisabled();
        await expect(model).toHaveText("manual-kept");
        await row.getByRole("button", { name: "연결 확인", exact: true }).click();
        await expect(row.getByTestId("profile-check")).toContainText("catalog_invalid");
        fixture.setMode("denied");
        await refresh.click();
        await expect(row.getByRole("alert")).toContainText("[redacted]");
        await row.getByRole("button", { name: "연결 확인", exact: true }).click();
        await expect(row.getByTestId("profile-check")).toContainText("auth_failed");
        expect(await row.innerText()).not.toContain(SECRET);
        fixture.setMode("empty");
        await refresh.click();
        await expect(row).toContainText("조회된 모델이 없습니다");
        await expect(model).toHaveText("manual-kept");
        page.once("dialog", (dialog) => void dialog.accept("manual-after-empty"));
        await row.getByRole("button", { name: "모델 변경", exact: true }).click();
        await expect(model).toHaveText("manual-after-empty");
        profile = (await apiCall<Profile[]>("GET", "/model-profiles")).find((p) => p.id === profile!.id)!;
        fixture.setMode("good");
        const entered = fixture.hold();
        await refresh.click();
        await entered;
        profile = await apiCall<Profile>("PUT", `/model-profiles/${profile.id}`, { expected_revision: profile.revision, model: "manual-after-change" });
        await expect(model).toHaveText("manual-after-change");
        fixture.resume();
        await expect(select).toBeDisabled();
        await expect(row.getByRole("status")).toContainText("프로필이 바뀌었습니다");
        await refresh.click();
        await expect(select).toBeEnabled();
        await expect(select.getByRole("option", { name: /local-chosen/ })).toHaveCount(1);
        await expect(model).toHaveText("manual-after-change");
        await select.selectOption("local-other");
        await expect(model).toHaveText("local-other");
        await row.getByRole("button", { name: "연결 확인", exact: true }).click();
        await expect(row.getByTestId("profile-check")).toContainText("연결됨");
        expect(fixture.calls.length).toBeGreaterThan(0);
        expect(fixture.calls.every((call) => call.path === "/v1/models" && call.authenticated)).toBe(true);
    } finally {
        fixture.resume();
        const owned = profile ? [profile] : (await apiCall<Profile[]>("GET", "/model-profiles")).filter((p) => p.name === name);
        for (const item of owned) await apiCall("DELETE", `/model-profiles/${item.id}`);
        await apiCall("DELETE", `/secrets/${secret.id}`);
        await fixture.close();
    }
});
