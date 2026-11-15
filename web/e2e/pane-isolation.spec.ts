import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { frames } from "./fixture";
import { apiCall, composerCommand, composerOption, ensureProfile, ensureProjects, login, openDetails, script, state } from "./helpers";

async function fixture() {
    const { a, b } = await ensureProjects();
    const primary = await ensureProfile();
    const prefix = `pane-isolation-${Date.now()}`;
    const secret = await apiCall<{ id: string }>("POST", "/secrets", { label: prefix, value: "sk-e2e-fixture-0000" });
    const secondary = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: prefix, protocol: "openai", base_url: `http://127.0.0.1:${state().fixturePort}/v1`,
        model: "fixture-isolated", secret_id: secret.id,
    });
    return { a, b, primary, secondary: secondary.id, prefix, cleanup: () => apiCall("DELETE", `/model-profiles/${secondary.id}`) };
}

async function session(project: string, title: string) {
    const s = await apiCall<{ id: string }>("POST", `/projects/${project}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: project, resource_id: s.id });
    return { ...s, title };
}

async function openPair(page: Page, first: { title: string }, second: { title: string }) {
    const recent = page.locator(".recent");
    await recent.getByTestId("recent-item").filter({ hasText: first.title }).getByRole("button", { name: new RegExp(first.title) }).click();
    await recent.getByTestId("recent-item").filter({ hasText: second.title }).getByRole("button", { name: "최근 항목 관리", exact: true }).click();
    await recent.getByTestId("recent-item").filter({ hasText: second.title }).getByRole("button", { name: "오른쪽에 열기", exact: true }).click();
    await expect(page.getByTestId("pane")).toHaveCount(2);
}

test("pane별 모델·effort·도구 선택은 초점·탭 전환·새로고침 뒤에도 섞이지 않는다", async ({ page }) => {
    const f = await fixture();
    try {
        const first = await session(f.a.id, `${f.prefix} first`);
        const second = await session(f.b.id, `${f.prefix} second`);
        const other = await session(f.b.id, `${f.prefix} other`);
        await login(page);
        await openPair(page, first, second);
        const left = page.locator(`[data-session="${first.id}"]`);
        const right = page.locator(`[data-session="${second.id}"]`);
        await left.getByLabel("모델 프로필").selectOption(f.primary);
        await left.getByLabel("추론", { exact: true }).selectOption("low");
        await composerOption(left, "도구", true);
        await right.getByLabel("모델 프로필").selectOption(f.secondary);
        await right.getByLabel("추론", { exact: true }).selectOption("high");
        await composerOption(right, "도구", false);
        await left.getByLabel("메시지 입력").click();
        await expect(right.getByLabel("모델 프로필")).toHaveValue(f.secondary);
        await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
        await page.locator(".recent").getByRole("button", { name: new RegExp(first.title) }).click();
        await expect(left.getByLabel("모델 프로필")).toHaveValue(f.primary);
        await expect(left.getByLabel("추론", { exact: true })).toHaveValue("low");
        await composerCommand(left, "/tools");
        await expect(left.getByRole("status").filter({ hasText: "도구 사용을 껐습니다" })).toBeVisible();
        await composerOption(left, "도구", true);
        await right.getByLabel("메시지 입력").click();
        await page.locator(".recent").getByRole("button", { name: new RegExp(other.title) }).click();
        await expect(page.locator(`[data-testid="session-view"][data-session="${other.id}"]`)).toBeVisible();
        const persisted = page.waitForResponse((r) => r.url().includes("/api/v1/layouts/") && r.request().method() === "PUT");
        await page.locator(".recent").getByRole("button", { name: new RegExp(second.title) }).click();
        await expect(right.getByLabel("모델 프로필")).toHaveValue(f.secondary);
        await expect(right.getByLabel("추론", { exact: true })).toHaveValue("high");
        await composerCommand(right, "/tools");
        await expect(right.getByRole("status").filter({ hasText: "도구 사용을 켰습니다" })).toBeVisible();
        await composerOption(right, "도구", false);
        await persisted;
        await page.reload();
        await expect(page.getByTestId("conn")).toHaveText("연결됨");
        await expect(left.getByLabel("모델 프로필")).toHaveValue(f.primary);
        await expect(right.getByLabel("모델 프로필")).toHaveValue(f.secondary);
    } finally { await f.cleanup(); }
});

test("같은 프로젝트의 분할 입력도 각 탭의 초안·모델 선택을 독립적으로 복원한다", async ({ page }) => {
    const f = await fixture();
    try {
        await apiCall("POST", "/recent/touch", { kind: "project", project_id: f.a.id, resource_id: f.a.id });
        await login(page);
        await page.locator(".sidebar .projects").getByRole("button", { name: f.a.name, exact: true }).click();
        const leftPane = page.getByTestId("pane").nth(0);
        const left = leftPane.locator(".project-view");
        await left.getByLabel("모델 프로필").selectOption(f.primary);
        await left.getByLabel("메시지 입력").fill("project left draft fixture");
        await leftPane.getByRole("button", { name: "오른쪽으로 분할", exact: true }).click();
        const rightPane = page.getByTestId("pane").nth(1);
        const right = rightPane.locator(".project-view");
        await expect(right.getByLabel("메시지 입력")).toHaveValue("");
        await right.getByLabel("모델 프로필").selectOption(f.secondary);
        await right.getByLabel("메시지 입력").fill("project right draft fixture");
        await page.locator(".sidebar .projects").getByRole("button", { name: f.b.name, exact: true }).click();
        const recentProject = page.locator(".recent .recent-title").filter({ hasText: f.a.name });
        await recentProject.click();
        await expect(right.getByLabel("메시지 입력")).toHaveValue("project right draft fixture");
        await expect(right.getByLabel("모델 프로필")).toHaveValue(f.secondary);
        await left.getByLabel("메시지 입력").click();
        await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
        await recentProject.click();
        await expect(left.getByLabel("메시지 입력")).toHaveValue("project left draft fixture");
        await expect(left.getByLabel("모델 프로필")).toHaveValue(f.primary);
        await expect(right.getByLabel("메시지 입력")).toHaveValue("project right draft fixture");
    } finally { await f.cleanup(); }
});

test("이전 공유 프로젝트 초안은 지우거나 다른 탭에 자동 배정하지 않고 사본 선택으로 복구한다", async ({ page }) => {
    const { a } = await ensureProjects();
    await page.addInitScript((id) => localStorage.setItem(`grove.draft.project:${id}#new`, JSON.stringify({
        text: "legacy shared project draft fixture", baseRevision: 0, updatedAt: 1,
    })), a.id);
    await login(page);
    await page.locator(".sidebar .projects").getByRole("button", { name: a.name, exact: true }).click();
    const project = page.locator(".project-view");
    await expect(project.getByLabel("메시지 입력")).toHaveValue("");
    await openDetails(project.getByTestId("draft-copies"));
    await project.getByTestId("draft-copy").filter({ hasText: "legacy shared project draft fixture" })
        .getByRole("button", { name: "이 사본 이어받기", exact: true }).click();
    await expect(project.getByLabel("메시지 입력")).toHaveValue("legacy shared project draft fixture");
});

test("모델을 바꾼 같은 글은 원래 저장 요청을 확인한 뒤에도 새 입력으로 보존한다", async ({ page }) => {
    const f = await fixture();
    try {
        const s = await session(f.a.id, `${f.prefix} changed intent`);
        await login(page);
        await page.locator(".recent").getByRole("button", { name: new RegExp(s.title) }).click();
        const view = page.locator(`[data-session="${s.id}"]`);
        await view.getByLabel("모델 프로필").selectOption(f.primary);
        await composerOption(view, "보내기 방식", "save");
        await view.getByLabel("메시지 입력").fill("same text with a different model intent");
        const sent: { key: string; body: string | null }[] = [];
        await page.route(`**/api/v1/sessions/${s.id}/messages`, async (route) => {
            if (route.request().method() !== "POST") return route.continue();
            sent.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData() });
            const response = await route.fetch();
            expect(response.status()).toBe(201);
            if (sent.length === 1) await route.abort("connectionreset");
            else await route.fulfill({ response });
        });
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(view.getByTestId("send-unsure")).toBeVisible();
        await composerOption(view, "보내기 방식", "model");
        await view.getByLabel("모델 프로필").selectOption(f.secondary);
        await view.getByRole("button", { name: "원래 요청 결과 확인", exact: true }).click();
        await expect(view.getByTestId("send-unsure")).toHaveCount(0);
        await expect(view.getByLabel("메시지 입력")).toHaveValue("same text with a different model intent");
        await expect(view.getByLabel("모델 프로필")).toHaveValue(f.secondary);
        expect(sent).toHaveLength(2);
        expect(sent[1]).toEqual(sent[0]);
        await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
        await page.locator(".recent").getByRole("button", { name: new RegExp(s.title) }).click();
        await expect(view.getByLabel("메시지 입력")).toHaveValue("same text with a different model intent");
        await expect(view.getByLabel("모델 프로필")).toHaveValue(f.secondary);
    } finally { await f.cleanup(); }
});

test("다른 pane을 선택한 뒤 승인해도 cwd·파일 변경·stream·모델은 원래 대화에 귀속된다", async ({ page }) => {
    const f = await fixture();
    const ids: string[] = [];
    let release = () => {};
    try {
        const first = await session(f.a.id, `${f.prefix} execution first`);
        const second = await session(f.b.id, `${f.prefix} execution second`);
        ids.push(first.id, second.id);
        const a = await apiCall<{ root_path: string }>("GET", `/projects/${f.a.id}`);
        const b = await apiCall<{ root_path: string }>("GET", `/projects/${f.b.id}`);
        const name = `${f.prefix}.txt`;
        writeFileSync(join(a.root_path, name), "a-before");
        writeFileSync(join(b.root_path, name), "b-before");
        await login(page);
        await openPair(page, first, second);
        const left = page.locator(`[data-testid="session-view"][data-session="${first.id}"]`);
        const right = page.locator(`[data-testid="session-view"][data-session="${second.id}"]`);
        for (const [view, model] of [[left, f.primary], [right, f.secondary]] as const) {
            await view.getByLabel("모델 프로필").selectOption(model);
            await composerOption(view, "보내기 방식", "model");
            await composerOption(view, "도구", true);
        }
        await script({ frames: frames.tool("pane-a-shell", "shell", { command: `printf '%s\\n' "$PWD"; printf 'a-after' > '${name}'` }) });
        await left.getByLabel("메시지 입력").fill(`${f.prefix} prompt a`);
        await left.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(left.getByTestId("approval")).toBeVisible();
        await script({ frames: frames.tool("pane-b-shell", "shell", { command: `printf '%s\\n' "$PWD"; printf 'b-after' > '${name}'` }) });
        await right.getByLabel("메시지 입력").fill(`${f.prefix} prompt b`);
        await right.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(right.getByTestId("approval")).toBeVisible();
        const calls = await apiCall<{ id: string; status: string }[]>("GET", `/tool-calls?session_id=${first.id}&limit=200`);
        const call = calls.find((c) => c.status === "pending_approval")!;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let held = false;
        await page.route(`**/api/v1/tool-calls/${call.id}/decision`, async (route) => { held = true; await gate; await route.continue(); });
        await script({ frames: frames.text(["pane a ", "complete"]), delayMs: 400 });
        await left.getByTestId("approval").getByRole("button", { name: "이번만 승인", exact: true }).click();
        await expect.poll(() => held).toBe(true);
        await right.getByLabel("메시지 입력").click();
        release();
        await expect(left.getByTestId("partial")).toContainText("pane a");
        await expect(right).not.toContainText("pane a complete");
        await expect(left.getByTestId("msg-assistant").filter({ hasText: "pane a complete" })).toHaveCount(1);
        await openDetails(left.getByTestId("msg-tool"));
        await expect(left.getByTestId("msg-tool")).toContainText(a.root_path);
        await page.keyboard.press("Escape");
        expect(readFileSync(join(a.root_path, name), "utf8")).toBe("a-after");
        expect(readFileSync(join(b.root_path, name), "utf8")).toBe("b-before");
        await expect(right.getByTestId("approval")).toBeVisible();
        await script({ frames: frames.text(["pane b complete"]) });
        await right.getByTestId("approval").getByRole("button", { name: "이번만 승인", exact: true }).click();
        await expect(right.getByTestId("msg-assistant").filter({ hasText: "pane b complete" })).toHaveCount(1);
        await openDetails(right.getByTestId("msg-tool"));
        await expect(right.getByTestId("msg-tool")).toContainText(b.root_path);
        await page.keyboard.press("Escape");
        expect(readFileSync(join(a.root_path, name), "utf8")).toBe("a-after");
        expect(readFileSync(join(b.root_path, name), "utf8")).toBe("b-after");
        const requests = await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json() as { model: string; messages: unknown[] }[];
        const owned = (text: string) => requests.filter((r) => JSON.stringify(r.messages).includes(text));
        expect(owned(`${f.prefix} prompt a`).map((r) => r.model)).toEqual(["fixture-model", "fixture-model"]);
        expect(owned(`${f.prefix} prompt b`).map((r) => r.model)).toEqual(["fixture-isolated", "fixture-isolated"]);
    } finally {
        release();
        await page.unrouteAll({ behavior: "wait" });
        for (const id of ids) {
            const turns = await apiCall<{ id: string; status: string }[]>("GET", `/sessions/${id}/turns?limit=5`);
            for (const turn of turns) if (["queued", "running", "awaiting_approval", "awaiting_input"].includes(turn.status)) await apiCall("POST", `/turns/${turn.id}/cancel`, {});
        }
        await f.cleanup();
    }
});
