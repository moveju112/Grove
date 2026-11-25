import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { frames } from "./fixture";
import { apiCall, closeModelSettings, composerCommand, composerOption, composerSetting, ensureProfile, ensureProjects, expectChoice, expectComposerSetting, login, openProjectSettings, script, selectChoice, sessionView, startProjectConversation, state } from "./helpers";

type Effective = { items: { key: string; effective: unknown; layers: Record<string, { value: unknown; revision: number }> }[] };
const defaultsKey = "model.default_profile";
const summaryKey = "context.summary_profile";

async function setting(project: string, key: string, value: unknown) {
    const effective = await apiCall<Effective>("GET", `/settings/effective?project_id=${project}`);
    const scope = key === summaryKey ? "server" : "project";
    const revision = effective.items.find((item) => item.key === key)?.layers[scope]?.revision ?? 0;
    return apiCall("PUT", `/settings/${scope}/${scope === "server" ? "-" : project}/${key}`, { expected_revision: revision, value });
}
async function fixture() {
    await ensureProfile();
    const { a, b } = await ensureProjects();
    const prefix = `model-default-${randomUUID()}`;
    const create = (suffix: string) => apiCall<{ id: string }>("POST", "/model-profiles", {
        name: `${prefix}-${suffix}`, protocol: "openai", base_url: `http://127.0.0.1:${state().fixturePort}/v1`, model: `fixture-default-${suffix}`,
    });
    const primary = await create("a"), secondary = await create("b");
    const backups: { project: string; key: string; value: unknown }[] = [];
    for (const [project, key] of [[a.id, defaultsKey], [a.id, summaryKey], [b.id, defaultsKey],
        [a.id, "context.auto_compact_percent"], [a.id, "context.input_reserve_tokens"], [a.id, "context.auto_clear_minutes"]]) {
        const effective = await apiCall<Effective>("GET", `/settings/effective?project_id=${project}`);
        backups.push({ project: project!, key: key!, value: effective.items.find((item) => item.key === key)?.layers[key === summaryKey ? "server" : "project"]?.value ?? null });
    }
    const removed = new Set<string>();
    return { a, b, primary, secondary, prefix, removed, cleanup: async () => {
        for (const backup of backups) await setting(backup.project, backup.key, backup.value);
        for (const profile of [primary, secondary]) if (!removed.has(profile.id)) await apiCall("DELETE", `/model-profiles/${profile.id}`);
    } };
}
async function openSettings(page: Page, project: { id: string; name: string }) {
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
    await openProjectSettings(page);
}

test("다른 대화에서 모델만 바꿔도 새 대화에 사용할 최신 추론 강도는 유지된다", async ({ page, context }) => {
    test.setTimeout(45_000);
    const f = await fixture();
    const second = await context.newPage();
    try {
        await setting(f.a.id, defaultsKey, f.primary.id);
        const sessions = await Promise.all(["first", "second", "new"].map(async (role) => {
            const title = `${role} ${f.prefix}`;
            const session = await apiCall<{ id: string }>("POST", `/projects/${f.a.id}/sessions`, { title });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: f.a.id, resource_id: session.id });
            return { ...session, title };
        }));
        const open = async (target: Page, index: number) => {
            const session = sessions[index]!;
            await target.bringToFront();
            const sidebar = target.getByRole("button", { name: "사이드바", exact: true });
            if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
            await target.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: session.title, exact: true }).click();
            return sessionView(target, session.id);
        };
        await login(page);
        const firstView = await open(page, 0);
        await composerOption(firstView, "추론", "low");
        await second.goto("/");
        await expect(second.getByTestId("conn")).toHaveText("연결됨");
        const secondView = await open(second, 1);
        await expectComposerSetting(secondView, "추론", "low");

        await composerOption(firstView, "추론", "high");
        await composerCommand(secondView, `/model ${f.prefix}-b`);
        await expectComposerSetting(secondView, "모델 프로필", f.secondary.id);
        await expectComposerSetting(secondView, "추론", "low");
        await expectComposerSetting(firstView, "추론", "high");
        const newView = await open(second, 2);
        await expectComposerSetting(newView, "추론", "high");
        await second.reload();
        await expectComposerSetting(newView, "추론", "high");
    } finally { await second.close(); await f.cleanup(); }
});

test("프로젝트 기본값은 새 입력창에만 적용하고 기기 선택·다른 프로젝트·기존 탭을 바꾸지 않는다", async ({ page }) => {
    const f = await fixture();
    try {
        await setting(f.a.id, defaultsKey, f.primary.id);
        await setting(f.b.id, defaultsKey, "");
        await page.addInitScript((profileId) => localStorage.setItem("grove.composer.options", JSON.stringify({
            mode: "model", profileId, agentId: null, tools: false,
        })), f.secondary.id);
        await login(page);
        const projects = page.getByTestId("project-row");
        await projects.getByRole("button", { name: f.a.name, exact: true }).click();
        await startProjectConversation(page.getByTestId("project-view").filter({ visible: true }));
        await expectComposerSetting(page, "모델 프로필", f.primary.id);
        await script({ marker: f.prefix, frames: frames.text(["default model fixture complete"]) });
        await page.getByLabel("메시지 입력").fill(f.prefix);
        await page.getByRole("button", { name: "보내기", exact: true }).click();
        const view = page.getByTestId("session-view");
        await expect(view.getByTestId("msg-assistant")).toContainText("default model fixture complete");
        const requests = await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json() as { model: string; messages: unknown[] }[];
        expect(requests.filter((request) => JSON.stringify(request.messages).includes(f.prefix)).map((request) => request.model)).toEqual(["fixture-default-a"]);
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem("grove.composer.options")!).profileId)).toBe(f.secondary.id);
        await setting(f.a.id, defaultsKey, f.secondary.id);
        await expectComposerSetting(view, "모델 프로필", f.primary.id);
        await page.reload();
        await expectComposerSetting(view, "모델 프로필", f.primary.id);
        await projects.getByRole("button", { name: f.b.name, exact: true }).click();
        await startProjectConversation(page.getByTestId("project-view").filter({ visible: true }));
        await expectComposerSetting(page, "모델 프로필", f.secondary.id);
    } finally { await f.cleanup(); }
});

test("폰에서 보낸 모델을 기존 PC 탭에 복원하고 다음 메시지도 그 모델로 보낸다", async ({ page, browser, baseURL }) => {
    test.setTimeout(45_000);
    const f = await fixture();
    const phone = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
        await setting(f.a.id, defaultsKey, f.secondary.id);
        const title = `handoff ${f.prefix}`;
        const session = await apiCall<{ id: string }>("POST", `/projects/${f.a.id}/sessions`, { title });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: f.a.id, resource_id: session.id });
        const open = async (target: Page) => {
            await login(target);
            const sidebar = target.getByRole("button", { name: "사이드바", exact: true });
            if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
            await target.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title, exact: true }).click();
            return sessionView(target, session.id);
        };
        const desktop = await open(page);
        await expect(desktop.getByTestId("model-summary")).toHaveText("fixture-default-b");
        const mobile = await open(await phone.newPage());
        const choice = JSON.stringify([f.primary.id, "fixture-model"]);
        await selectChoice(await composerSetting(mobile, "모델 프로필"), choice);
        await mobile.getByLabel("메시지 입력").tap();
        for (const [view, marker] of [[mobile, "phone"], [desktop, "pc"]] as const) {
            if (marker === "pc") {
                await page.reload();
                await expect(view.getByTestId("model-summary")).toHaveText("fixture-model");
            }
            const text = `${title} ${marker}`;
            await script({ marker: text, frames: frames.text([`답변 ${marker}`]) });
            await view.getByLabel("메시지 입력").fill(text);
            await view.getByRole("button", { name: "보내기", exact: true }).click();
            await expect(view.getByTestId("msg-assistant").last()).toContainText(`답변 ${marker}`);
        }
        const turns = await apiCall<{ profile_id: string; definition: { model_selection: { model: string } } }[]>("GET", `/sessions/${session.id}/turns`);
        expect(turns.map(t => [t.profile_id, t.definition.model_selection.model])).toEqual([
            [f.primary.id, "fixture-model"], [f.primary.id, "fixture-model"],
        ]);
        await expect(desktop.getByTestId("turn-status")).toHaveCount(0);
        await composerCommand(desktop, `/model ${f.prefix}-b`);
        await expect(desktop.getByTestId("model-summary")).toHaveText("fixture-default-b");
        await page.reload();
        await expect(desktop.getByTestId("model-summary")).toHaveText("fixture-default-b");
    } finally { await phone.close(); await f.cleanup(); }
});

test("기본/요약 모델은 이름·전송 대상으로 고르고 revision 충돌에서 선택을 보존한다", async ({ page }) => {
    const f = await fixture();
    try {
        await openSettings(page, f.a);
        const search = page.getByLabel("설정 검색");
        await search.fill("기본 모델 프로필");
        const row = page.getByTestId(`setting-${defaultsKey}`);
        await selectChoice(row.getByLabel("기본 모델 프로필", { exact: true }), f.primary.id);
        await expect(row).toContainText("전송 대상:");
        await expect(row.getByRole("status").filter({ hasText: /\S/ })).toContainText("저장됨");
        await page.route(`**/api/v1/settings/project/${f.a.id}/${defaultsKey}`, async (route) => {
            await setting(f.a.id, defaultsKey, f.primary.id);
            await route.continue();
        }, { times: 1 });
        await selectChoice(row.getByLabel("기본 모델 프로필", { exact: true }), f.secondary.id);
        await expect(row.getByRole("status").filter({ hasText: /\S/ })).toContainText("내 입력은 보존");
        await expectChoice(row.getByLabel("기본 모델 프로필", { exact: true }), f.secondary.id);
        await row.getByRole("button", { name: "내 수정 적용", exact: true }).click();
        await expect(row.getByRole("status").filter({ hasText: /\S/ })).toContainText("저장됨");
        await search.fill("압축 요약 모델");
        const summary = page.getByTestId(`setting-${summaryKey}`);
        await selectChoice(summary.getByLabel("압축 요약 모델", { exact: true }), f.primary.id);
        await expect(page.getByTestId("workflow-context-compressor")).toContainText("저장됨");
        const effective = await apiCall<Effective>("GET", `/settings/effective?project_id=${f.a.id}`);
        expect(effective.items.find((item) => item.key === summaryKey)?.effective).toBe(f.primary.id);
        const session = await apiCall<{ id: string }>("POST", `/projects/${f.a.id}/sessions`, { title: `${f.prefix} context` });
        for (let i = 0; i < 3; i++) await apiCall("POST", `/sessions/${session.id}/messages`, { text: `${f.prefix} summary ${i}` });
        const baseline = await apiCall<{ reserve_tokens: number }>("GET", `/sessions/${session.id}/context?profile_id=${f.secondary.id}`);
        const previousReserve = effective.items.find((item) => item.key === "context.input_reserve_tokens")!.effective as number;
        for (const [key, query, value] of [
            ["context.auto_compact_percent", "자동 압축 기준", "50"],
            ["context.input_reserve_tokens", "입력 여유분", "500"],
            ["context.auto_clear_minutes", "idle 뒤 모델 context", "10"],
        ]) {
            await search.fill(query!);
            const control = page.getByTestId(`setting-${key}`);
            await control.getByRole("spinbutton").fill(value!);
            await control.getByRole("spinbutton").blur();
            await expect(control.getByRole("status").filter({ hasText: /\S/ })).toContainText("저장됨");
        }
        const usage = await apiCall<{ reserve_tokens: number; auto_clear_minutes: number }>("GET", `/sessions/${session.id}/context?profile_id=${f.secondary.id}`);
        expect(usage.reserve_tokens - baseline.reserve_tokens).toBe(500 - previousReserve);
        expect(usage.auto_clear_minutes).toBe(10);
        await script({ marker: f.prefix, frames: frames.text(["selected summary model fixture"]) });
        const compacted = await apiCall<{ compacted: boolean; message: { content: { profile_id: string; summary: string } } }>(
            "POST", `/sessions/${session.id}/compact`, { profile_id: f.secondary.id });
        expect(compacted.compacted).toBe(true);
        expect(compacted.message.content).toMatchObject({ profile_id: f.primary.id, summary: "selected summary model fixture" });
        const requests = await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json() as { model: string; messages: unknown[] }[];
        expect(requests.filter((request) => JSON.stringify(request.messages).includes(f.prefix)).map((request) => request.model)).toEqual(["fixture-default-a"]);
        await search.fill("압축 요약 모델");
        await selectChoice(summary.getByLabel("압축 요약 모델", { exact: true }), "");
        await expect(page.getByTestId("workflow-context-compressor")).toContainText("저장됨");
        await expectChoice(summary.getByLabel("압축 요약 모델", { exact: true }), "");
    } finally { await f.cleanup(); }
});

test("선택한 프로필이 삭제돼도 다른 공급자로 보내지 않고 선택은 유지하되 미전송 입력은 복원하지 않는다", async ({ page }) => {
    const f = await fixture();
    try {
        await setting(f.a.id, defaultsKey, "");
        await page.addInitScript((profileId) => localStorage.setItem("grove.composer.options", JSON.stringify({
            mode: "model", profileId, agentId: null, tools: false,
        })), f.primary.id);
        await login(page);
        await page.getByTestId("project-row").getByRole("button", { name: f.a.name, exact: true }).click();
        await startProjectConversation(page.getByTestId("project-view").filter({ visible: true }));
        const area = page.getByLabel("메시지 입력");
        await expectComposerSetting(page, "모델 프로필", f.primary.id);
        await area.fill(`${f.prefix} never send implicitly`);
        await apiCall("DELETE", `/model-profiles/${f.primary.id}`);
        f.removed.add(f.primary.id);
        await expect(page.getByTestId("profile-missing")).toBeVisible();
        await expectComposerSetting(page, "모델 프로필", f.primary.id);
        await expect(page.getByRole("button", { name: "보내기", exact: true })).toBeDisabled();
        const draftTab = page.getByRole("tab", { selected: true }).getByTestId("tab-title").filter({ visible: true });
        const draftTitle = (await draftTab.innerText()).trim();
        await page.reload();
        await page.getByRole("tab").getByRole("button", { name: draftTitle, exact: true }).click();
        await startProjectConversation(page.getByTestId("project-view").filter({ visible: true }));
        await expect(page.getByTestId("profile-missing")).toBeVisible();
        await expect(area).toHaveValue("");
        await area.fill(`${f.prefix} never send implicitly`);
        const mutations: string[] = [];
        page.on("request", (request) => {
            if (request.method() === "POST" && /\/(sessions|turns)$/.test(new URL(request.url()).pathname)) mutations.push(request.url());
        });
        await area.press("Control+Enter");
        expect(mutations).toEqual([]);
        await selectChoice(await composerSetting(page, "모델 프로필"), f.secondary.id);
        await closeModelSettings(page);
        await expect(page.getByTestId("profile-missing")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "보내기", exact: true })).toBeEnabled();
    } finally { await f.cleanup(); }
});

test("기본값 조회 실패는 임의 모델로 보내지 않고 재확인 후 같은 입력을 이어 쓴다", async ({ page }) => {
    const f = await fixture();
    try {
        await setting(f.a.id, defaultsKey, f.primary.id);
        await page.route(`**/api/v1/settings/effective?project_id=${f.a.id}`, (route) => route.fulfill({
            status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "fixture_unavailable", message: "fixture unavailable", retryable: true } }),
        }));
        await login(page);
        await page.getByTestId("project-row").getByRole("button", { name: f.a.name, exact: true }).click();
        await startProjectConversation(page.getByTestId("project-view").filter({ visible: true }));
        await page.getByLabel("메시지 입력").fill("keep while defaults unavailable");
        await expect(page.getByText("모델 선택 정보를 불러오지 못했습니다.", { exact: false })).toBeVisible();
        await expect(page.getByRole("button", { name: "보내기", exact: true })).toBeDisabled();
        await page.unrouteAll();
        await page.getByRole("button", { name: "모델 설정 다시 확인", exact: true }).click();
        await expectComposerSetting(page, "모델 프로필", f.primary.id);
        await expect(page.getByLabel("메시지 입력")).toHaveValue("keep while defaults unavailable");
        await expect(page.getByRole("button", { name: "보내기", exact: true })).toBeEnabled();
    } finally { await page.unrouteAll(); await f.cleanup(); }
});
