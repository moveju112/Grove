import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, script, state } from "./helpers";

type Effective = { items: { key: string; effective: unknown; layers: Record<string, { value: unknown; revision: number }> }[] };
const defaultsKey = "model.default_profile";
const summaryKey = "context.summary_profile";

async function setting(project: string, key: string, value: unknown) {
    const effective = await apiCall<Effective>("GET", `/settings/effective?project_id=${project}`);
    const revision = effective.items.find((item) => item.key === key)?.layers.project?.revision ?? 0;
    return apiCall("PUT", `/settings/project/${project}/${key}`, { expected_revision: revision, value });
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
        backups.push({ project: project!, key: key!, value: effective.items.find((item) => item.key === key)?.layers.project?.value ?? null });
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
    await page.getByRole("button", { name: "프로젝트 설정", exact: true }).click();
}

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
        await expect(page.getByLabel("모델 프로필", { exact: true })).toHaveValue(f.primary.id);
        await script({ marker: f.prefix, frames: frames.text(["default model fixture complete"]) });
        await page.getByLabel("메시지 입력").fill(f.prefix);
        await page.getByRole("button", { name: "보내기", exact: true }).click();
        const view = page.getByTestId("session-view");
        await expect(view.getByTestId("msg-assistant")).toContainText("default model fixture complete");
        const requests = await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json() as { model: string; messages: unknown[] }[];
        expect(requests.filter((request) => JSON.stringify(request.messages).includes(f.prefix)).map((request) => request.model)).toEqual(["fixture-default-a"]);
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem("grove.composer.options")!).profileId)).toBe(f.secondary.id);
        await setting(f.a.id, defaultsKey, f.secondary.id);
        await expect(view.getByLabel("모델 프로필", { exact: true })).toHaveValue(f.primary.id);
        await page.reload();
        await expect(view.getByLabel("모델 프로필", { exact: true })).toHaveValue(f.primary.id);
        await projects.getByRole("button", { name: f.b.name, exact: true }).click();
        await expect(page.getByLabel("모델 프로필", { exact: true })).toHaveValue(f.secondary.id);
    } finally { await f.cleanup(); }
});

test("기본/요약 모델은 이름·전송 대상으로 고르고 revision 충돌에서 선택을 보존한다", async ({ page }) => {
    const f = await fixture();
    try {
        await openSettings(page, f.a);
        const search = page.getByLabel("설정 검색");
        await search.fill("기본 모델 프로필");
        const row = page.getByTestId(`setting-${defaultsKey}`);
        await row.getByLabel("기본 모델 프로필", { exact: true }).selectOption(f.primary.id);
        await expect(row).toContainText("전송 대상:");
        await row.getByRole("button", { name: "저장", exact: true }).click();
        await expect(row.getByRole("status")).toContainText("저장됨");
        await row.getByLabel("기본 모델 프로필", { exact: true }).selectOption(f.secondary.id);
        await setting(f.a.id, defaultsKey, f.primary.id);
        await row.getByRole("button", { name: "저장", exact: true }).click();
        await expect(row.getByRole("status")).toContainText("내 수정은 보존");
        await expect(row.getByLabel("기본 모델 프로필", { exact: true })).toHaveValue(f.secondary.id);
        await row.getByRole("button", { name: "내 수정으로 덮어쓰기", exact: true }).click();
        await expect(row.getByRole("status")).toContainText("저장됨");
        await search.fill("압축 요약 모델");
        const summary = page.getByTestId(`setting-${summaryKey}`);
        await summary.getByLabel("압축 요약 모델", { exact: true }).selectOption(f.primary.id);
        await summary.getByRole("button", { name: "저장", exact: true }).click();
        await expect(summary.getByRole("status")).toContainText("저장됨");
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
            await control.getByRole("button", { name: "저장", exact: true }).click();
            await expect(control.getByRole("status")).toContainText("저장됨");
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
        await summary.getByRole("button", { name: "이 범위 값 지우기", exact: true }).click();
        await page.getByRole("dialog", { name: "기본값 복원 확인", exact: true }).getByRole("button", { name: "확인한 범위 복원", exact: true }).click();
        await page.getByRole("dialog", { name: "기본값 복원 확인", exact: true }).getByRole("button", { name: "복원 창 닫기", exact: true }).click();
        await expect(summary.getByLabel("압축 요약 모델", { exact: true })).toHaveValue("");
    } finally { await f.cleanup(); }
});

test("선택한 프로필이 삭제돼도 다른 공급자로 보내지 않고 입력·선택을 복원한다", async ({ page }) => {
    const f = await fixture();
    try {
        await setting(f.a.id, defaultsKey, "");
        await page.addInitScript((profileId) => localStorage.setItem("grove.composer.options", JSON.stringify({
            mode: "model", profileId, agentId: null, tools: false,
        })), f.primary.id);
        await login(page);
        await page.getByTestId("project-row").getByRole("button", { name: f.a.name, exact: true }).click();
        const area = page.getByLabel("메시지 입력");
        await expect(page.getByLabel("모델 프로필", { exact: true })).toHaveValue(f.primary.id);
        await area.fill(`${f.prefix} never send implicitly`);
        await apiCall("DELETE", `/model-profiles/${f.primary.id}`);
        f.removed.add(f.primary.id);
        await expect(page.getByTestId("profile-missing")).toBeVisible();
        await expect(page.getByLabel("모델 프로필", { exact: true })).toHaveValue(f.primary.id);
        await expect(page.getByRole("button", { name: "보내기", exact: true })).toBeDisabled();
        await page.reload();
        await expect(page.getByTestId("profile-missing")).toBeVisible();
        await expect(area).toHaveValue(`${f.prefix} never send implicitly`);
        const mutations: string[] = [];
        page.on("request", (request) => {
            if (request.method() === "POST" && /\/(sessions|turns)$/.test(new URL(request.url()).pathname)) mutations.push(request.url());
        });
        await area.press("Control+Enter");
        expect(mutations).toEqual([]);
        await page.getByLabel("모델 프로필", { exact: true }).selectOption(f.secondary.id);
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
        await page.getByLabel("메시지 입력").fill("keep while defaults unavailable");
        await expect(page.getByText("모델 선택 정보를 불러오지 못했습니다.", { exact: false })).toBeVisible();
        await expect(page.getByRole("button", { name: "보내기", exact: true })).toBeDisabled();
        await page.unrouteAll();
        await page.getByRole("button", { name: "모델 설정 다시 확인", exact: true }).click();
        await expect(page.getByLabel("모델 프로필", { exact: true })).toHaveValue(f.primary.id);
        await expect(page.getByLabel("메시지 입력")).toHaveValue("keep while defaults unavailable");
        await expect(page.getByRole("button", { name: "보내기", exact: true })).toBeEnabled();
    } finally { await page.unrouteAll(); await f.cleanup(); }
});
