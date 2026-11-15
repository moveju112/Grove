import { type Locator, type Page, expect } from "@playwright/test";

/// 특정 대화 화면. 앞선 시험이 분할 배치를 남겨 대화 화면이 여러 개일 수 있어 항상 대화 ID로 고른다.
export function sessionView(page: Page, sessionId: string): Locator {
    return page.locator(`[data-testid="session-view"][data-session="${sessionId}"]`);
}

/// 탭 패널 또는 상세 대화상자의 실제 사용자 진입점을 연다.
export async function openDetails(panel: Locator) {
    await expect(panel).toBeAttached();
    const disclosure = panel.locator("xpath=self::details | ./details | .//details[contains(concat(' ', normalize-space(@class), ' '), ' profile-details ')]").first();
    if (await disclosure.count() && await disclosure.getAttribute("open") === null) {
        await disclosure.locator(":scope > summary").click();
    }
    const tab = panel.locator("xpath=ancestor-or-self::*[@role='tabpanel']").first();
    if (await tab.count()) {
        const button = panel.page().locator(`[role=tab][aria-controls="${await tab.getAttribute("id")}"]`);
        await openToolDock(button);
        await button.click();
    }
    const popup = panel.locator("xpath=ancestor-or-self::*[@popover and not(@role='tooltip')] | ./*[@popover and not(@role='tooltip')]").first();
    if (await popup.count() && !(await popup.isVisible())) {
        await panel.page().locator(`[popovertarget="${await popup.getAttribute("id")}"]`).click();
    }
    const trigger = panel.locator(":scope > button[aria-haspopup=dialog], :scope > div > button[aria-haspopup=dialog]");
    if (await trigger.count() && !(await panel.getByRole("dialog").count())) {
        await trigger.click();
        await expect(panel.getByRole("dialog")).toBeVisible();
    }
    await expect(panel).toBeVisible();
}

/// 도구 탭은 헤더의 "도구 패널" 버튼 뒤에 있다. 탭이 숨겨져 있으면 같은 작업 영역의 버튼으로 먼저 연다.
async function openToolDock(tab: Locator) {
    if (await tab.isVisible()) return;
    const workbench = tab.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' workbench ')][1]");
    await workbench.locator(".view-head").getByRole("button", { name: "도구 패널", exact: true }).click();
    await expect(tab).toBeVisible();
}

/// 보이는 대화·프로젝트 화면의 도구 탭을 연다.
export async function openTool(scope: Locator | Page, name: string) {
    // has 안의 locator는 바깥 요소 기준으로 다시 찾으므로 page에서 만든다.
    const page = "page" in scope ? (scope as Locator).page() : scope as Page;
    const bench = scope.locator(".workbench").filter({ has: page.locator(".view-head").filter({ visible: true }) }).first();
    const tab = bench.getByRole("tab", { name, exact: true, includeHidden: true });
    await openToolDock(tab);
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
}

/// 프로젝트 파일을 별도 탭으로 연다(프로젝트 작업 메뉴).
export async function openProjectFiles(page: Page) {
    const head = page.locator(".project-view .view-head").filter({ visible: true }).first();
    await head.getByRole("button", { name: "프로젝트 작업", exact: true }).click();
    await page.getByRole("button", { name: "파일 탭으로 열기", exact: true }).filter({ visible: true }).click();
}

export async function inputOptions(view: Locator) {
    const trigger = view.getByRole("button", { name: "초안·스킬", exact: true });
    const expanded = await trigger.evaluate((button) => document.getElementById(button.getAttribute("popovertarget")!)!.matches(":popover-open"));
    if (!expanded) await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

export async function composerOption(view: Locator, label: string, value: string | boolean) {
    if (label === "보내기 방식" || label === "도구") {
        const command = label === "도구" ? `/tools ${value ? "on" : "off"}` : `/save ${value === "save" ? "on" : "off"}`;
        await composerCommand(view, command);
        return;
    }
    await view.getByLabel(label, { exact: true }).selectOption(String(value));
}

export async function composerCommand(view: Locator, command: string) {
    const box = view.getByLabel("메시지 입력", { exact: true });
    const text = await box.inputValue();
    await box.fill(command);
    await box.press("Control+Enter");
    await expect(box).toHaveValue("");
    await box.fill(text);
}

export async function profileAction(row: Locator, label: string) {
    const menu = row.locator(".profile-heading").getByRole("button", { name: / 관리$/ });
    if (await menu.getAttribute("aria-expanded") !== "true") await menu.click();
    await row.getByRole("button", { name: label, exact: true }).click();
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
    await openSettings(page);
    await page.getByLabel("설정 검색").fill("봇");
    await expect(page.getByTestId("bots-panel")).toBeVisible();
}

export async function openSettings(page: Page) {
    if (page.viewportSize()!.width <= 760) {
        const trigger = page.getByRole("button", { name: "사이드바", exact: true });
        if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
        const drawer = page.getByRole("dialog", { name: "탐색 메뉴", exact: true });
        await drawer.getByRole("button", { name: "설정", exact: true }).click();
        await expect(drawer).not.toBeVisible();
    } else await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
}

/// 선택 값으로 실제 옵션을 고른다. 전환 중인 화면의 native select와 Astryx Selector를 함께 지원한다.
export async function selectChoice(control: Locator, value: string) {
    control = control.and(control.page().getByRole("combobox"));
    const native = await control.evaluate((node) => node instanceof HTMLSelectElement);
    if (native) {
        await control.selectOption(value);
        return;
    }
    await control.click();
    await expect(control).toHaveAttribute("aria-expanded", "true");
    const id = await control.getAttribute("aria-controls");
    const list = control.page().locator(`[id=${JSON.stringify(id)}]`);
    await list.getByRole("option").filter({ has: control.page().locator(`[data-option-value=${JSON.stringify(value)}]`) }).click();
    await expect(control).toHaveAttribute("data-selected-value", value);
}

/// 시험이 만든 모델 프로필을 지운다(공유 시험 서버에서 기본 프로필이 바뀌지 않게).
export async function removeProfiles(match: (name: string) => boolean): Promise<void> {
    const list = await apiCall<{ id: string; name: string }[]>("GET", "/model-profiles");
    for (const p of list.filter((x) => match(x.name))) await apiCall("DELETE", `/model-profiles/${p.id}`);
}
