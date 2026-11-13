import { type Locator, type Page, expect } from "@playwright/test";

/// 특정 대화 화면. 앞선 시험이 분할 배치를 남겨 대화 화면이 여러 개일 수 있어 항상 대화 ID로 고른다.
export function sessionView(page: Page, sessionId: string): Locator {
    return page.locator(`[data-testid="session-view"][data-session="${sessionId}"]`);
}

/// `<details>`가 닫혀 있을 때만 연다(이미 열려 있으면 그대로). summary를 무조건 누르면 열린 패널이 닫힌다.
export async function openDetails(details: Locator) {
    if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) await details.locator("summary").first().click();
    await expect(details).toHaveAttribute("open", "");
}
import { readFileSync } from "node:fs";
import { STATE } from "./global-setup";

export type E2EState = { token: string; projA: string; projB: string; fixturePort: number; cliDir?: string };

export function state(): E2EState {
    return JSON.parse(readFileSync(STATE, "utf8")) as E2EState;
}

const BASE = "http://127.0.0.1:17741";
let n = 0;

/// 시험 준비용 API 호출(소유자 토큰). UI 동작 검증은 브라우저로 한다.
export async function apiCall<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(BASE + "/api/v1" + path, {
        method,
        headers: { authorization: `Bearer ${state().token}`, "content-type": "application/json", "idempotency-key": `e2e-${Date.now()}-${n++}` },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${t}`);
    return (t ? JSON.parse(t) : null) as T;
}

/// 프로젝트를 워크스페이스(worktree)를 쓰는 프로젝트 모드로 바꾼다. 새 프로젝트는 단일 모드다.
export async function useWorkspaces(projectId: string): Promise<void> {
    const p = await apiCall<{ revision: number }>("GET", `/projects/${projectId}`);
    await apiCall("PATCH", `/projects/${projectId}`, { expected_revision: p.revision, workspace_mode: "project" });
}

/// 바이너리/텍스트 원문 GET(검증용).
export async function apiText(path: string): Promise<string> {
    const r = await fetch(BASE + "/api/v1" + path, { headers: { authorization: `Bearer ${state().token}` } });
    if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
    return r.text();
}

export async function script(step: { frames: string[]; delayMs?: number; hang?: boolean; marker?: string }) {
    await fetch(`http://127.0.0.1:${state().fixturePort}/script`, { method: "POST", body: JSON.stringify(step) });
}

export async function ensureProjects(): Promise<{ a: { id: string; name: string }; b: { id: string; name: string } }> {
    const s = state();
    const list = await apiCall<{ id: string; root_path: string; name: string }[]>("GET", "/projects");
    const find = async (root: string) => list.find((p) => p.root_path === root) ?? (await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root }));
    return { a: await find(s.projA), b: await find(s.projB) };
}

export async function ensureProfile(): Promise<string> {
    const list = await apiCall<{ id: string; name: string }[]>("GET", "/model-profiles");
    const f = list.find((p) => p.name === "fixture");
    if (f) return f.id;
    const sec = await apiCall<{ id: string }>("POST", "/secrets", { label: "fixture", value: "sk-e2e-fixture-0000" });
    const p = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: "fixture",
        protocol: "openai",
        base_url: `http://127.0.0.1:${state().fixturePort}/v1`,
        model: "fixture-model",
        secret_id: sec.id,
    });
    return p.id;
}

export async function login(page: Page) {
    await page.goto("/");
    await page.locator("html[data-hydrated=true]").waitFor({ state: "attached" });
    await page.getByLabel("토큰").fill(state().token);
    await page.getByRole("button", { name: "로그인" }).click();
    await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
}

export async function openBots(page: Page) {
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("봇");
    await expect(page.getByTestId("bots-panel")).toBeVisible();
}

/// 시험이 만든 모델 프로필을 지운다(공유 시험 서버에서 기본 프로필이 바뀌지 않게).
export async function removeProfiles(match: (name: string) => boolean): Promise<void> {
    const list = await apiCall<{ id: string; name: string }[]>("GET", "/model-profiles");
    for (const p of list.filter((x) => match(x.name))) await apiCall("DELETE", `/model-profiles/${p.id}`);
}
