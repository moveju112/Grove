import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProfile, login, sessionView, state } from "./helpers";

type Effective = { items: { key: string; layers: Record<string, { revision: number }> }[] };
type Definition = { id: string; body: string; revision: number; enabled: boolean };
async function setting(scope: "server" | "project" | "session", id: string, key: string, value: unknown) {
    const suffix = scope === "server" ? "" : `?${scope === "project" ? "project_id" : "session_id"}=${id}`;
    const effective = await apiCall<Effective>("GET", `/settings/effective${suffix}`);
    const item = effective.items.find((item) => item.key === key)!;
    await apiCall("PUT", `/settings/${scope}/${id}/${key}`, { expected_revision: item.layers[scope]!.revision, value });
}
async function project() {
    const root = mkdtempSync(join(state().projA, "agent-overview-"));
    return apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
}
async function openProject(page: Page, item: { id: string; name: string }) {
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: item.name, exact: true }).click();
    await page.getByRole("button", { name: "프로젝트 작업", exact: true }).click();
    await page.getByRole("button", { name: "프로젝트 설정", exact: true }).click();
    await page.getByLabel("설정 검색", { exact: true }).fill("에이전트·워크플로우 편집");
    const panel = page.getByTestId("agent-overview");
    await expect(panel.getByRole("heading", { name: /등록된 역할/ })).toBeVisible();
    return panel;
}

test("실제 설정 개요에서 override·비활성 지침을 읽고 기존 편집으로 이동·저장·reload한다", async ({ page }) => {
    const item = await project();
    const profile = await ensureProfile();
    await setting("project", item.id, "model.default_profile", profile);
    const original = await apiCall<Definition>("GET", "/definitions/agent/worker");
    await apiCall("PUT", "/definitions/agent/worker", { expected_revision: original.revision, body: "overview 적용 지침", enabled: false });
    try {
        const panel = await openProject(page, item);
        const writes: string[] = [];
        page.on("request", (request) => {
            if (!["GET", "HEAD"].includes(request.method()) && /\/(definitions|settings|model-profiles|secrets|sessions\/[^/]+\/turns|agent-runs|templates)(\/|\?|$)/.test(new URL(request.url()).pathname)) writes.push(request.url());
        });
        const worker = panel.getByRole("article", { name: "역할 worker", exact: true });
        await expect(worker).toContainText("기본 내장 · override 수정됨 (body) · 비활성 · 비활성");
        await worker.getByRole("button", { name: "비활성 정의 지침 (실행에 사용 안 함)", exact: true }).click();
        await expect(worker.getByLabel("worker 지침", { exact: true })).toHaveText("overview 적용 지침");
        await page.keyboard.press("Escape");
        await expect(panel).toContainText("다음 요청 기본값: fixture · fixture-model");
        await expect(panel).toContainText("출처: 이 프로젝트");
        await expect(panel).toContainText("대화 대상 없음 · 상속 모델 확인 불가");
        await expect(panel).toContainText("연결·실행 미확인");
        await expect(panel).toContainText("자동 재실행하지 않습니다");
        expect(writes).toEqual([]);
        await worker.getByRole("button", { name: "worker 기존 편집 열기", exact: true }).click();
        const editor = page.getByLabel("정의 본문", { exact: true });
        await expect(editor).toHaveValue("overview 적용 지침");
        expect(writes).toEqual([]);
        await editor.fill("overview 기존 편집 저장 지침");
        await page.locator(".def-editor").getByRole("button", { name: "저장", exact: true }).click();
        await page.reload();
        await page.getByLabel("설정 검색", { exact: true }).fill("에이전트·워크플로우 편집");
        await panel.getByRole("article", { name: "역할 worker", exact: true }).getByRole("button", { name: "비활성 정의 지침 (실행에 사용 안 함)", exact: true }).click();
        await expect(panel.getByLabel("worker 지침", { exact: true })).toHaveText("overview 기존 편집 저장 지침");
        await expect(page.getByTestId("settings-origin")).toContainText(item.name);
        expect((await apiCall<{ items: unknown[] }>("GET", `/projects/${item.id}/sessions`)).items).toHaveLength(0);
    } finally {
        const current = await apiCall<Definition>("GET", "/definitions/agent/worker");
        await apiCall("PUT", "/definitions/agent/worker", { expected_revision: current.revision, body: original.body, enabled: original.enabled });
    }
});

test("대화 범위를 보존하고 다른 프로젝트 선택·reload 후에도 정책·모델을 혼동하지 않는다", async ({ page }) => {
    const a = await project();
    const b = await project();
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "overview scoped session" });
    const other = await apiCall<{ id: string }>("POST", `/projects/${b.id}/sessions`, { title: "overview other session" });
    await setting("project", a.id, "agents.delegation", "off");
    await setting("session", session.id, "agents.delegation", "auto");
    await setting("project", b.id, "agents.delegation", "off");
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: b.id, resource_id: other.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: /overview scoped session/ }).click();
    await sessionView(page, session.id).getByRole("button", { name: "대화 작업", exact: true }).click();
    await sessionView(page, session.id).getByRole("button", { name: "대화 설정", exact: true }).click();
    await page.getByLabel("설정 검색", { exact: true }).fill("에이전트·워크플로우 편집");
    const panel = page.getByTestId("agent-overview");
    await expect(panel).toContainText("agents.delegation: off · 금지 · 출처: 이 프로젝트");
    await expect(panel).toContainText("활성 턴 없음 · 상속 모델 아직 미정");
    await expect(panel).toContainText("미설정 · 선택 필요");
    await expect(panel.getByRole("article", { name: "역할 worker", exact: true })).toContainText("위임 금지");
    await page.locator(".recent li").filter({ hasText: "overview other session" }).getByRole("button", { name: "최근 항목 관리", exact: true }).click();
    await page.locator(".recent li").filter({ hasText: "overview other session" }).getByRole("button", { name: "오른쪽에 열기", exact: true }).click();
    await expect(page.getByTestId("pane")).toHaveCount(2);
    await expect(sessionView(page, other.id)).toBeVisible();
    await page.getByTestId("project-row").getByRole("button", { name: b.name, exact: true }).click();
    await panel.getByRole("button", { name: "개요 다시 조회", exact: true }).click();
    await expect(panel).toContainText("agents.delegation: off · 금지 · 출처: 이 프로젝트");
    await expect(page.getByTestId("settings-origin")).toContainText("overview scoped session");
    await page.reload();
    await page.getByLabel("설정 검색", { exact: true }).fill("에이전트·워크플로우 편집");
    await expect(panel).toContainText("agents.delegation: off · 금지 · 출처: 이 프로젝트");
    await expect(panel.getByTestId("overview-target")).toContainText("이 대화 기준");
    expect(await apiCall<unknown[]>("GET", `/sessions/${session.id}/turns`)).toHaveLength(0);
    expect(await apiCall<unknown[]>("GET", `/sessions/${other.id}/turns`)).toHaveLength(0);
});

test("오류·역순 응답·재접속에서 이전값을 숨기고 실제 대상의 최신값으로 복구한다", async ({ page, context }) => {
    const item = await project();
    const panel = await openProject(page, item);
    await page.route("**/api/v1/agent-overview?*", (route) => route.fulfill({
        status: 503, json: { error: { code: "fixture_unavailable", message: "fixture failure" } },
    }));
    await panel.getByRole("button", { name: "개요 다시 조회", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("개요를 읽지 못했습니다");
    await expect(panel.getByRole("heading", { name: /등록된 역할/ })).toHaveCount(0);
    await page.unroute("**/api/v1/agent-overview?*");
    await panel.getByRole("button", { name: "개요 다시 조회", exact: true }).click();
    await expect(panel.getByRole("heading", { name: /등록된 역할/ })).toBeVisible();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let captured!: () => void;
    const snapshot = new Promise<void>((resolve) => { captured = resolve; });
    let first = true;
    await page.route("**/api/v1/agent-overview?*", async (route) => {
        if (!first) return route.continue();
        first = false;
        const old = await route.fetch();
        captured();
        await gate;
        await route.fulfill({ response: old });
    });
    try {
        await panel.getByRole("button", { name: "개요 다시 조회", exact: true }).click();
        await snapshot;
        await expect(panel.getByRole("heading", { name: /등록된 역할/ })).toHaveCount(0);
        await setting("project", item.id, "agents.delegation", "auto");
        await expect(panel).toContainText("agents.delegation: auto · 자동");
        const late = page.waitForResponse((response) => response.url().includes("/agent-overview?") && response.status() === 200);
        release();
        await late;
        await expect(panel).toContainText("agents.delegation: auto · 자동");
    } finally { release(); await page.unroute("**/api/v1/agent-overview?*"); }
    await context.setOffline(true);
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    await expect(panel.getByRole("status")).toContainText("연결 확인 중");
    await expect(panel.getByRole("heading", { name: /등록된 역할/ })).toHaveCount(0);
    await setting("project", item.id, "agents.delegation", "off");
    await context.setOffline(false);
    await expect(panel).toContainText("agents.delegation: off · 금지", { timeout: 15_000 });
    await expect(panel.getByRole("article", { name: "역할 worker", exact: true })).toContainText("위임 금지");
});

test("사용자 정의·모델 비활성·민감정보 가림과 인증 거부를 실제 API에서 확인한다", async ({ page, request }) => {
    const item = await project();
    const secret = await apiCall<{ id: string }>("POST", "/secrets", { label: "overview fixture", value: "overview-private-secret-value" });
    const custom = await apiCall<Definition>("POST", "/definitions/agent", {
        id: "overview-private-role", name: "개요 사용자 역할", body: "안전한 지침\noverview-private-secret-value\n/home/fixture-personal/private\nAuthorization: fixture-private-header",
    });
    const profile = await apiCall<{ id: string; revision: number }>("POST", "/model-profiles", {
        name: "overview disabled model", protocol: "openai", base_url: "http://127.0.0.1:17742/v1", model: "fixture-model", secret_id: secret.id,
    });
    try {
        await setting("project", item.id, "model.default_profile", profile.id);
        await apiCall("PUT", `/model-profiles/${profile.id}`, { expected_revision: profile.revision, enabled: false });
        const panel = await openProject(page, item);
        await expect(panel).toContainText("overview disabled model · fixture-model (비활성 · 선택 필요)");
        const role = panel.getByRole("article", { name: `역할 ${custom.id}`, exact: true });
        await expect(role).toContainText("사용자 정의");
        await role.getByRole("button", { name: "현재 적용 지침", exact: true }).click();
        await expect(role.getByLabel(`${custom.id} 지침`, { exact: true })).toContainText("안전한 지침");
        await expect(role).toContainText("[redacted]");
        await page.keyboard.press("Escape");
        for (const value of ["overview-private-secret-value", "/home/fixture-personal", "fixture-private-header"]) await expect(panel).not.toContainText(value);
        expect((await request.get(`http://127.0.0.1:17741/api/v1/agent-overview?project_id=${item.id}`)).status()).toBe(401);
        const original = await apiCall("GET", `/agent-overview?project_id=${item.id}`);
        await page.route("**/api/v1/agent-overview?*", (route) => route.fulfill({
            status: 403, json: { error: { code: "forbidden", message: "fixture denied" } },
        }));
        await panel.getByRole("button", { name: "개요 다시 조회", exact: true }).click();
        await expect(panel.getByRole("alert")).toContainText("인증·조회 대상");
        await expect(panel.getByRole("article")).toHaveCount(0);
        await page.unroute("**/api/v1/agent-overview?*");
        await panel.getByRole("button", { name: "개요 다시 조회", exact: true }).click();
        await expect(role).toContainText("사용자 정의");
        expect(await apiCall("GET", `/agent-overview?project_id=${item.id}`)).toEqual(original);
    } finally {
        await apiCall("DELETE", `/definitions/agent/${custom.id}?expected_revision=${custom.revision}`);
        await setting("project", item.id, "model.default_profile", null);
        await apiCall("DELETE", `/model-profiles/${profile.id}`);
        await apiCall("DELETE", `/secrets/${secret.id}`);
    }
});

test("닫힌 개요의 늦은 응답은 다시 연 개요의 최신값을 덮어쓰지 않는다", async ({ page }) => {
    const item = await project();
    const panel = await openProject(page, item);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let captured!: () => void;
    const snapshot = new Promise<void>((resolve) => { captured = resolve; });
    let first = true;
    await page.route("**/api/v1/agent-overview?*", async (route) => {
        if (!first) return route.continue();
        first = false;
        const old = await route.fetch();
        captured();
        await gate;
        await route.fulfill({ response: old });
    });
    try {
        await panel.getByRole("button", { name: "개요 다시 조회", exact: true }).click();
        await snapshot;
        await page.getByLabel("설정 검색", { exact: true }).fill("테마");
        await expect(panel).toHaveCount(0);
        await setting("project", item.id, "agents.delegation", "auto");
        await page.getByLabel("설정 검색", { exact: true }).fill("에이전트·워크플로우 편집");
        await expect(panel).toContainText("agents.delegation: auto · 자동");
        const late = page.waitForResponse((response) => response.url().includes("/agent-overview?") && response.status() === 200);
        release();
        await late;
        await expect(panel).toContainText("agents.delegation: auto · 자동");
    } finally { release(); }
});
