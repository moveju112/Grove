import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { frames } from "./fixture";
import { splitRecentItem, apiCall, composerCommand, composerOption, ensureProfile, ensureProjects, expectChoice, expectComposerSetting, login, requireToolApproval, script, selectChoice, splitNewConversation, startProjectConversation, state } from "./helpers";

async function fixture() {
    const { a, b } = await ensureProjects();
    await requireToolApproval(a.id);
    await requireToolApproval(b.id);
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
    const recent = page.getByRole("region", { name: "최근", exact: true });
    await recent.getByTestId("recent-item").filter({ hasText: first.title }).getByRole("button", { name: new RegExp(first.title) }).click();
    await splitRecentItem(recent.getByTestId("recent-item").filter({ hasText: second.title }));
    await expect(page.getByTestId("pane")).toHaveCount(2);
}

test("pane별 모델·effort·도구 선택은 초점·탭 전환·새로고침 뒤에도 섞이지 않는다", async ({ page }) => {
    const f = await fixture();
    try {
        const first = await session(f.a.id, `${f.prefix} first`);
        const second = await session(f.a.id, `${f.prefix} second`);
        const other = await session(f.a.id, `${f.prefix} other`);
        await login(page);
        await openPair(page, first, second);
        const left = page.locator(`[data-session="${first.id}"]`);
        const right = page.locator(`[data-session="${second.id}"]`);
        await composerOption(left, "모델 프로필", f.primary);
        await composerOption(left, "추론", "low");
        await composerOption(left, "도구", true);
        await composerOption(right, "모델 프로필", f.secondary);
        await composerOption(right, "추론", "high");
        await composerOption(right, "도구", false);
        await left.getByLabel("메시지 입력").click();
        await expectComposerSetting(right, "모델 프로필", f.secondary);
        await page.getByTestId("sidebar").getByRole("button", { name: "설정", exact: true }).click();
        await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`^${first.title}`) }).click();
        await expectComposerSetting(left, "모델 프로필", f.primary);
        await expectComposerSetting(left, "추론", "low");
        await composerCommand(left, "/tools");
        await expect(left.getByRole("status").filter({ hasText: "도구 사용을 껐습니다" })).toBeVisible();
        await composerOption(left, "도구", true);
        await right.getByLabel("메시지 입력").click();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(other.title) }).click();
        await expect(page.locator(`[data-testid="session-view"][data-session="${other.id}"]`)).toBeVisible();
        const persisted = page.waitForResponse((r) => r.url().includes("/api/v1/layouts/") && r.request().method() === "PUT");
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`^${second.title}`) }).click();
        await expectComposerSetting(right, "모델 프로필", f.secondary);
        await expectComposerSetting(right, "추론", "high");
        await composerCommand(right, "/tools");
        await expect(right.getByRole("status").filter({ hasText: "도구 사용을 켰습니다" })).toBeVisible();
        await composerOption(right, "도구", false);
        await persisted;
        await page.reload();
        await expect(page.getByTestId("conn")).toHaveText("연결됨");
        await expectComposerSetting(left, "모델 프로필", f.primary);
        await expectComposerSetting(right, "모델 프로필", f.secondary);
    } finally { await f.cleanup(); }
});

test("같은 프로젝트의 분할 모델 선택과 미전송 입력은 탐색·설정 전환 뒤에도 독립적으로 유지한다", async ({ page }) => {
    const f = await fixture();
    try {
        await apiCall("POST", "/recent/touch", { kind: "project", project_id: f.a.id, resource_id: f.a.id });
        await login(page);
        await page.getByTestId("sidebar").getByTestId("projects").getByRole("button", { name: f.a.name, exact: true }).click();
        const leftPane = page.getByTestId("pane").filter({ visible: true }).nth(0);
        const left = leftPane.getByTestId("project-view");
        await startProjectConversation(left);
        await composerOption(left, "모델 프로필", f.primary);
        await left.getByLabel("메시지 입력").fill("project left draft fixture");
        await splitNewConversation(leftPane, "right");
        const rightPane = page.getByTestId("pane").filter({ visible: true }).nth(1);
        const right = rightPane.getByTestId("project-view");
        await startProjectConversation(right);
        await expect(right.getByLabel("메시지 입력")).toHaveValue("");
        await composerOption(right, "모델 프로필", f.secondary);
        await right.getByLabel("메시지 입력").fill("project right draft fixture");
        await page.getByTestId("sidebar").getByTestId("projects").getByRole("button", { name: f.b.name, exact: true }).click();
        const recentProject = page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: f.a.name, exact: false }).first();
        await recentProject.click();
        await expect(right.getByLabel("메시지 입력")).toHaveValue("project right draft fixture");
        await expectComposerSetting(right, "모델 프로필", f.secondary);
        await startProjectConversation(left);
        await left.getByLabel("메시지 입력").click();
        await page.getByTestId("sidebar").getByRole("button", { name: "설정", exact: true }).click();
        await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
        await recentProject.click();
        await expect(left.getByLabel("메시지 입력")).toHaveValue("project left draft fixture");
        await expectComposerSetting(left, "모델 프로필", f.primary);
        await expect(right.getByLabel("메시지 입력")).toHaveValue("project right draft fixture");
    } finally { await f.cleanup(); }
});

test("이전 공유 프로젝트 초안은 사용하지 않으며 복원 메뉴도 제공하지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    await page.addInitScript((id) => localStorage.setItem(`grove.draft.project:${id}#new`, JSON.stringify({
        text: "legacy shared project draft fixture", baseRevision: 0, updatedAt: 1,
    })), a.id);
    await login(page);
    await page.getByTestId("sidebar").getByTestId("projects").getByRole("button", { name: a.name, exact: true }).click();
    const project = page.getByTestId("project-view");
    await startProjectConversation(project);
    await expect(project.getByLabel("메시지 입력")).toHaveValue("");
    await expect(project.getByTestId("draft-copies")).toHaveCount(0);
    await expect(project.getByRole("button", { name: "초안", exact: true })).toHaveCount(0);
});

test("모델을 바꾼 같은 글은 원래 저장 요청을 확인한 뒤에도 새 입력으로 보존한다", async ({ page }) => {
    const f = await fixture();
    try {
        const s = await session(f.a.id, `${f.prefix} changed intent`);
        await login(page);
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(s.title) }).click();
        const view = page.locator(`[data-session="${s.id}"]`);
        await composerOption(view, "모델 프로필", f.primary);
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
        await composerOption(view, "모델 프로필", f.secondary);
        await view.getByRole("button", { name: "원래 요청 결과 확인", exact: true }).click();
        await expect(view.getByTestId("send-unsure")).toHaveCount(0);
        await expect(view.getByLabel("메시지 입력")).toHaveValue("same text with a different model intent");
        await expectComposerSetting(view, "모델 프로필", f.secondary);
        expect(sent).toHaveLength(2);
        expect(sent[1]).toEqual(sent[0]);
        await page.getByTestId("sidebar").getByRole("button", { name: "설정", exact: true }).click();
        await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(s.title) }).click();
        await expect(view.getByLabel("메시지 입력")).toHaveValue("same text with a different model intent");
        await expectComposerSetting(view, "모델 프로필", f.secondary);
    } finally { await f.cleanup(); }
});

test("다른 프로젝트를 선택한 뒤 승인해도 cwd·파일 변경·stream·모델은 원래 대화에 귀속된다", async ({ page }) => {
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
        const show = async (target: { title: string }) => {
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(target.title) }).click();
        };
        const left = page.locator(`[data-testid="session-view"][data-session="${first.id}"]`);
        const right = page.locator(`[data-testid="session-view"][data-session="${second.id}"]`);
        for (const [target, view, model] of [[first, left, f.primary], [second, right, f.secondary]] as const) {
            await show(target);
            await composerOption(view, "모델 프로필", model);
            await composerOption(view, "보내기 방식", "model");
            await composerOption(view, "도구", true);
        }
        await show(first);
        await script({ frames: frames.tool("pane-a-shell", "shell", { command: `printf '%s\\n' "$PWD"; printf 'a-after' > '${name}'` }) });
        await left.getByLabel("메시지 입력").fill(`${f.prefix} prompt a`);
        await left.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(left.getByTestId("approval")).toBeVisible();
        await show(second);
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
        await show(first);
        await left.getByTestId("approval").getByRole("button", { name: "이번만 승인", exact: true }).click();
        await expect.poll(() => held).toBe(true);
        await show(second);
        release();
        await expect.poll(async () => (await apiCall<{ status: string }[]>("GET", `/sessions/${first.id}/turns?limit=1`))[0]?.status).toBe("completed");
        await expect(right).not.toContainText("pane a complete");
        await show(first);
        await expect(left.getByTestId("msg-assistant").filter({ hasText: "pane a complete" })).toHaveCount(1);
        expect(JSON.stringify(await apiCall("GET", `/tool-calls/${call.id}`))).toContain(a.root_path);
        await expect(left.getByTestId("msg-tool")).toHaveCount(0);
        expect(readFileSync(join(a.root_path, name), "utf8")).toBe("a-after");
        expect(readFileSync(join(b.root_path, name), "utf8")).toBe("b-before");
        await show(second);
        await expect(right.getByTestId("approval")).toBeVisible();
        await script({ frames: frames.text(["pane b complete"]) });
        await right.getByTestId("approval").getByRole("button", { name: "이번만 승인", exact: true }).click();
        await expect(right.getByTestId("msg-assistant").filter({ hasText: "pane b complete" })).toHaveCount(1);
        expect(JSON.stringify(await apiCall("GET", `/tool-calls?session_id=${second.id}`))).toContain(b.root_path);
        await expect(right.getByTestId("msg-tool")).toHaveCount(0);
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
