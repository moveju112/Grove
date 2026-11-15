import { type Locator, type Page, expect } from "@playwright/test";

/// 특정 대화 화면. 앞선 시험이 분할 배치를 남겨 대화 화면이 여러 개일 수 있어 항상 대화 ID로 고른다.
export function sessionView(page: Page, sessionId: string): Locator {
    return page.locator(`[data-testid="session-view"][data-session="${sessionId}"]`);
}

/// 탭 패널 또는 상세 대화상자의 실제 사용자 진입점을 연다.
export async function openDetails(panel: Locator, tool?: string, scope: Locator | Page = panel.page()) {
    if (tool === "대화 검색") await panel.page().getByRole("button", { name: "대화 검색", exact: true }).click();
    else if (tool) await openTool(scope, tool);
    await expect(panel).toBeAttached();
    const disclosure = panel.getByRole("button", { name: "상세 설정", exact: true }).first();
    if (await disclosure.count() && await disclosure.getAttribute("aria-expanded") === "false") await disclosure.click();
    const tab = panel.locator("xpath=ancestor-or-self::*[@role='tabpanel']").first();
    if (await tab.count()) {
        const button = panel.page().locator(`[role=tab][aria-controls="${await tab.getAttribute("id")}"]`);
        await openToolDock(button);
        await button.click();
    }
    const popup = panel.locator("xpath=ancestor-or-self::*[@popover and not(@role='tooltip')] | ./*[@popover and not(@role='tooltip')]").first();
    if (await popup.count() && !(await popup.isVisible())) {
        await panel.page().getByRole("button").and(panel.page().locator(`[aria-controls="${await popup.getAttribute("id")}"]`)).click();
    }
    const trigger = panel.locator('button[aria-haspopup="dialog"]:not([aria-controls])').filter({ visible: true }).first();
    if (await trigger.count() && !(await panel.getByRole("dialog").count())) {
        await trigger.click();
        await expect(panel.getByRole("dialog")).toBeVisible();
    }
    await expect(panel).toBeVisible();
}

/// 도구 탭은 헤더의 "도구 패널" 버튼 뒤에 있다. 탭이 숨겨져 있으면 같은 작업 영역의 버튼으로 먼저 연다.
async function openToolDock(tab: Locator) {
    if (await tab.isVisible()) return;
    const workbench = tab.locator("xpath=ancestor::*[@data-ui='workbench'][1]");
    await workbench.getByRole("button", { name: "도구 패널", exact: true }).click();
    await expect(tab).toBeVisible();
}

/// 보이는 대화·프로젝트 화면의 도구 탭을 연다.
export async function openTool(scope: Locator | Page, name: string) {
    const bench = scope.locator('[data-ui="workbench"]').filter({ visible: true }).first();
    const trigger = bench.getByRole("button", { name: "도구 패널", exact: true });
    if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
    const tab = bench.getByRole("tab", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`) });
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
}

/// 프로젝트 파일을 별도 탭으로 연다(프로젝트 작업 메뉴).
export async function openProjectFiles(page: Page) {
    const head = page.getByTestId("project-view").filter({ visible: true }).first();
    await head.getByRole("button", { name: "프로젝트 작업", exact: true }).click();
    await page.getByRole("button", { name: "파일 탭으로 열기", exact: true }).filter({ visible: true }).click();
}

export async function inputOptions(view: Locator) {
    const trigger = view.getByRole("button", { name: "초안·스킬", exact: true });
    if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

export async function modelSettings(scope: Locator | Page) {
    const page = "page" in scope ? scope.page() : scope;
    await page.bringToFront();
    const trigger = scope.getByRole("button", { name: "모델 설정", exact: true });
    if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
    const panel = page.getByTestId("model-settings").filter({ visible: true });
    await expect(panel).toBeVisible();
    return panel;
}

export async function composerSetting(scope: Locator | Page, label: string) {
    return (await modelSettings(scope)).getByRole("combobox", { name: label, exact: true });
}

export async function closeModelSettings(scope: Locator | Page) {
    const page = "page" in scope ? scope.page() : scope;
    const panel = page.getByTestId("model-settings").filter({ visible: true });
    await panel.getByRole("button", { name: "모델 설정 닫기", exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(scope.getByRole("button", { name: "모델 설정", exact: true })).toBeFocused();
}

export async function expectComposerSetting(scope: Locator | Page, label: string, value: string) {
    const page = "page" in scope ? scope.page() : scope;
    const focused = await page.evaluateHandle(() => document.activeElement as HTMLElement);
    await expectChoice(await composerSetting(scope, label), value);
    await closeModelSettings(scope);
    // 조회용 단언이 다른 pane을 활성화한 채 남기지 않는다.
    await focused.evaluate((node) => node.focus());
    await focused.dispose();
}

export async function composerOption(view: Locator, label: string, value: string | boolean) {
    if (label === "보내기 방식" || label === "도구") {
        const command = label === "도구" ? `/tools ${value ? "on" : "off"}` : `/save ${value === "save" ? "on" : "off"}`;
        await composerCommand(view, command);
        return;
    }
    if (label === "실행 중 보내기 방식") {
        await inputOptions(view);
        await selectChoice(view.getByLabel(label, { exact: true }), String(value));
        await view.getByRole("button", { name: "초안·스킬", exact: true }).click();
        return;
    }
    if (["모델 프로필", "추론", "Fast"].includes(label)) {
        await selectChoice(await composerSetting(view, label), String(value));
        await closeModelSettings(view);
        return;
    }
    await selectChoice(view.getByLabel(label, { exact: true }), String(value));
}

export async function composerCommand(view: Locator, command: string) {
    await expect(view.page().locator("[data-mobile-drawer][open]")).toHaveCount(0);
    const box = view.getByLabel("메시지 입력", { exact: true });
    const text = await box.inputValue();
    await box.fill(command);
    await box.press("Control+Enter");
    await expect(box).toHaveValue("");
    await box.fill(text);
}

export async function profileAction(row: Locator, label: string) {
    const menu = row.getByTestId("profile-heading").getByRole("button", { name: / 관리$/ });
    if (await menu.getAttribute("aria-expanded") !== "true") await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    const popup = row.page().locator(`[id=${JSON.stringify(await menu.getAttribute("aria-controls"))}]`);
    await popup.getByRole("button", { name: label, exact: true }).click();
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
        const drawer = page.getByTestId("mobile-drawer-left");
        await drawer.getByRole("button", { name: "설정", exact: true }).click();
        await expect(drawer).toHaveJSProperty("open", false);
    } else await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
}

export async function activateMobileTab(page: Page, title: string) {
    await page.getByRole("button", { name: "열린 세션", exact: true }).click();
    const drawer = page.getByTestId("mobile-drawer-right");
    await drawer.getByRole("button", { name: title, exact: true }).click();
    await expect(drawer).toHaveJSProperty("open", false);
}

export async function closeMobileSidebar(page: Page) {
    if (await page.getByRole("button", { name: "사이드바", exact: true }).getAttribute("aria-expanded") === "true") {
        const drawer = page.getByTestId("mobile-drawer-left");
        await drawer.getByRole("button", { name: "탐색 메뉴 닫기", exact: true }).click();
        await expect(drawer).toHaveJSProperty("open", false);
    }
    if (page.viewportSize()!.width <= 760) await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", false);
}

/// 실제 Astryx 선택창을 열어 값에 해당하는 옵션을 고른다.
export async function selectChoice(control: Locator, value: string) {
    control = control.and(control.page().getByRole("combobox"));
    await control.click();
    await expect(control).toHaveAttribute("aria-expanded", "true");
    const id = await control.getAttribute("aria-controls");
    const list = control.page().locator(`[id=${JSON.stringify(id)}]`);
    await list.getByRole("option").filter({ has: control.page().locator(`[data-option-value=${JSON.stringify(value)}]`) }).click();
    await expect(control).toHaveAttribute("data-selected-value", value);
}

export async function expectChoice(control: Locator, value: string) {
    await expect(control.and(control.page().getByRole("combobox"))).toHaveAttribute("data-selected-value", value);
}

export async function choiceOptions(control: Locator) {
    control = control.and(control.page().getByRole("combobox"));
    if (await control.getAttribute("aria-expanded") !== "true") await control.click();
    await expect(control).toHaveAttribute("aria-expanded", "true");
    return control.page().locator(`[id=${JSON.stringify(await control.getAttribute("aria-controls"))}]`).getByRole("option");
}

/// 시험이 만든 모델 프로필을 지운다(공유 시험 서버에서 기본 프로필이 바뀌지 않게).
export async function removeProfiles(match: (name: string) => boolean): Promise<void> {
    const list = await apiCall<{ id: string; name: string }[]>("GET", "/model-profiles");
    for (const p of list.filter((x) => match(x.name))) await apiCall("DELETE", `/model-profiles/${p.id}`);
}
