import { type Locator, type Page, expect } from "@playwright/test";

/// 특정 대화 화면. 앞선 시험이 분할 배치를 남겨 대화 화면이 여러 개일 수 있어 항상 대화 ID로 고른다.
export function sessionView(page: Page, sessionId: string): Locator {
    return page.locator(`[data-testid="session-view"][data-session="${sessionId}"]`);
}

export function settingsGroupHeader(row: Locator): Locator {
    return row.locator("xpath=ancestor::*[@data-ui='settings-group'][1]").locator(":scope > header");
}

export async function openAddMenu(page: Page) {
    const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
    if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
    await page.getByRole("button", { name: "프로젝트·폴더 추가", exact: true }).click();
    const menu = page.getByRole("menu").filter({ visible: true });
    await expect(menu.getByRole("menuitem", { name: "프로젝트 추가", exact: true })).toBeVisible();
    return menu;
}

export async function openUsage(page: Page) {
    const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
    if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
    await page.getByRole("button", { name: "사용량", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "사용량", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveJSProperty("open", true);
    expect(await dialog.evaluate((node) => node.matches(":modal"))).toBe(true);
    await expect.poll(() => dialog.evaluate((node) => new DOMMatrixReadOnly(getComputedStyle(node).transform).isIdentity)).toBe(true);
    const panel = dialog.getByTestId("usage-panel");
    await expect(panel).toBeVisible();
    if (page.viewportSize()!.width <= 760) await expect(page.getByTestId("mobile-drawer-left")).toBeHidden();
    return panel;
}

export async function openAddProject(page: Page) {
    const menu = await openAddMenu(page);
    await menu.getByRole("menuitem", { name: "프로젝트 추가", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    await expect(dialog).toBeVisible();
    return dialog;
}

export async function startProjectConversation(view: Locator) {
    if (view.page().viewportSize()!.width > 760) {
        const back = view.page().getByTestId("navigation-context").getByRole("button", { name: /프로젝트 화면으로$/ });
        if (await back.isVisible()) await back.click();
        await view.getByLabel("메시지 입력", { exact: true }).click();
    }
    else await view.page().getByRole("banner").getByRole("button", { name: "새 대화", exact: true }).click();
    await expect(view.getByLabel("메시지 입력", { exact: true })).toBeFocused();
}

export async function splitNewConversation(pane: Locator, edge: "right" | "bottom") {
    const target = pane.page().locator(`[data-testid="pane"][data-leaf="${await pane.getAttribute("data-leaf")}"]`);
    await target.getByRole("button", { name: "새 대화 탭", exact: true }).click();
    const bounds = (await target.boundingBox())!;
    await target.getByRole("tab", { selected: true }).getByTestId("tab-title").dragTo(target, {
        targetPosition: edge === "right"
            ? { x: bounds.width - 12, y: bounds.height / 2 }
            : { x: bounds.width / 2, y: bounds.height - 12 },
    });
}

export async function splitRecentItem(row: Locator) {
    const pane = row.page().getByTestId("pane").and(row.page().locator('[data-focused="true"]')).filter({ visible: true });
    const bounds = (await pane.boundingBox())!;
    await row.getByRole("button").first().dragTo(pane, {
        targetPosition: { x: bounds.width - 12, y: bounds.height / 2 },
    });
}

// 승인 대기 시험은 기본 전체 권한에 기대지 않고 격리된 시험 프로젝트의 정책을 명시한다.
export async function requireToolApproval(projectId: string) {
    const settings = await apiCall<{ items: { key: string; layers: { project?: { revision: number } } }[] }>(
        "GET", `/settings/effective?project_id=${projectId}`);
    for (const [key, value] of [["tools.mode", "ask"], ["tools.full_access", false]] as const) {
        const permission = settings.items.find((item) => item.key === key)!;
        await apiCall("PUT", `/settings/project/${projectId}/${key}`, {
            expected_revision: permission.layers.project?.revision ?? 0, value,
        });
    }
}

/// 탭 패널 또는 상세 대화상자의 실제 사용자 진입점을 연다.
export async function openDetails(panel: Locator, tool?: string, scope: Locator | Page = panel.page()) {
    if (tool) await openTool(scope, tool);
    await expect(panel).toBeAttached();
    const disclosure = panel.getByRole("button", { name: "상세 설정", exact: true }).first();
    if (await disclosure.count() && await disclosure.getAttribute("aria-expanded") === "false") await disclosure.click();
    const tab = panel.locator("xpath=ancestor-or-self::*[@role='tabpanel' and ancestor::*[@data-ui='workbench']]").first();
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

/// 탭이 숨겨져 있으면 같은 pane의 패널 버튼으로 먼저 연다.
async function openToolDock(tab: Locator) {
    if (await tab.isVisible()) return;
    const workbench = tab.locator("xpath=ancestor::*[@data-ui='workbench'][1]");
    await focusToolPane(workbench);
    await workbench.locator("xpath=ancestor::*[@data-testid='pane'][1]").getByRole("button", { name: "도구 패널", exact: true }).click();
    await expect(tab).toBeVisible();
}

/// 데스크톱 탭 줄과 모바일 본문 헤더에서 같은 pane의 패널 버튼을 찾는다.
export function toolTrigger(scope: Locator | Page) {
    const bench = scope.locator('[data-ui="workbench"]').filter({ visible: true }).first();
    return bench.locator("xpath=ancestor::*[@data-testid='pane'][1]").getByRole("button", { name: "도구 패널", exact: true });
}

async function focusToolPane(bench: Locator) {
    const pane = bench.locator("xpath=ancestor::*[@data-testid='pane'][1]");
    const activeTab = pane.getByRole("tablist", { name: "열린 대화와 화면" }).getByRole("tab", { selected: true }).getByTestId("tab-title");
    if (await pane.getAttribute("data-focused") === "false" && await activeTab.isVisible()) await activeTab.focus();
}

/// 보이는 대화·프로젝트 화면의 도구 탭을 연다.
export async function openTool(scope: Locator | Page, name: string) {
    const bench = scope.locator('[data-ui="workbench"]').filter({ visible: true }).first();
    await focusToolPane(bench);
    const trigger = toolTrigger(scope);
    if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
    const tab = bench.getByRole("tab", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`) });
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
}

export async function openContext(view: Locator) {
    await view.getByRole("button", { name: "context 사용량", exact: true }).click();
    const panel = view.page().getByRole("dialog", { name: "context 사용량", exact: true });
    await expect(panel).toBeVisible();
    return panel;
}

/// 프로젝트 도구에서 파일을 별도 탭으로 연다.
export async function openProjectFiles(page: Page) {
    const head = page.getByTestId("project-view").filter({ visible: true }).first();
    await openTool(head, "파일");
    await page.getByRole("button", { name: "파일 탭으로 열기", exact: true }).filter({ visible: true }).click();
}

export async function openProjectTerminal(page: Page, projectName: string, terminalName: string) {
    const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
    if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
    await page.getByTestId("project-row").getByRole("button", { name: projectName, exact: true }).click();
    const projectScreen = page.getByTestId("navigation-context").getByRole("button", { name: /프로젝트 화면으로$/ });
    if (await projectScreen.isVisible()) await projectScreen.click();
    const project = page.getByTestId("project-view").filter({ visible: true }).first();
    const list = project.getByTestId("terminal-list");
    await openDetails(list, "터미널", project);
    await list.getByRole("button", { name: terminalName, exact: true }).click();
}

/// 현재 프로젝트 화면의 도구 패널에서 프로젝트 범위 설정을 연다.
export async function openProjectSettings(page: Page) {
    const pane = page.locator('[data-testid="pane"][data-focused="true"]').filter({ visible: true });
    const view = pane.getByTestId("project-view").filter({ visible: true });
    const back = page.getByTestId("navigation-context").getByRole("button", { name: /프로젝트 화면으로$/ }).filter({ visible: true });
    await expect(view.or(back).first()).toBeVisible();
    if (!await view.isVisible()) await back.click();
    await expect(view).toBeVisible();
    await openTool(view, "설정");
    await view.getByRole("button", { name: "프로젝트 설정", exact: true }).click();
    await expect(page.getByTestId("settings")).toBeVisible();
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
    return (await modelSettings(scope)).getByRole(label === "모델 프로필" ? "button" : label === "Fast" ? "switch" : "combobox", { name: label, exact: true });
}

export async function closeModelSettings(scope: Locator | Page) {
    const page = "page" in scope ? scope.page() : scope;
    const panel = page.getByTestId("model-settings").filter({ visible: true });
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(scope.getByRole("button", { name: "모델 설정", exact: true })).toBeFocused();
}

export async function expectComposerSetting(scope: Locator | Page, label: string, value: string) {
    const page = "page" in scope ? scope.page() : scope;
    const focused = await page.evaluateHandle(() => document.activeElement as HTMLElement);
    const control = await composerSetting(scope, label);
    if (label === "Fast") await expect(control).toBeChecked({ checked: value === "true" });
    else await expectChoice(control, value);
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
    if (["모델 프로필", "추론", "Fast"].includes(label)) {
        const control = await composerSetting(view, label);
        if (label === "Fast") await control.setChecked(String(value) === "true");
        else await selectChoice(control, String(value));
        await closeModelSettings(view);
        return;
    }
    await selectChoice(view.getByLabel(label, { exact: true }), String(value));
}

export async function runningSendMode(page: Page, value: "queue" | "steer" | "interrupt") {
    await openSettings(page, "local");
    await page.getByLabel("설정 검색", { exact: true }).fill("실행 중 보내기 방식");
    await selectChoice(page.getByTestId("setting-running-send").getByLabel("실행 중 보내기 방식", { exact: true }), value);
    await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
}

export async function composerCommand(view: Locator, command: string) {
    await expect(view.page().locator("[data-mobile-drawer][open]")).toHaveCount(0);
    const box = view.getByLabel("메시지 입력", { exact: true });
    const text = () => box.evaluate((node) => node instanceof HTMLTextAreaElement ? node.value : (node as HTMLElement).innerText);
    const draft = await text();
    await box.fill(command);
    await box.press("Control+Enter");
    await expect.poll(text).toBe("");
    await box.fill(draft);
}

export async function profileAction(row: Locator, label: string) {
    const menu = row.getByTestId("profile-heading").getByRole("button", { name: / 관리$/ });
    if (await menu.getAttribute("aria-expanded") !== "true") await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    const popup = row.page().locator(`[id=${JSON.stringify(await menu.getAttribute("aria-controls"))}]`);
    await popup.getByRole("button", { name: label, exact: true }).click();
}
import { readFileSync } from "node:fs";
import { ISSUANCE_PASSWORD, STATE } from "./global-setup";

export type E2EState = { work: string; token: string; projA: string; projB: string; fixturePort: number; cliDir?: string };

export function state(): E2EState {
    return JSON.parse(readFileSync(STATE, "utf8")) as E2EState;
}

const BASE = "http://127.0.0.1:17741";
let n = 0;

/// 시험 준비용 로컬 API 호출. UI 동작 검증은 브라우저로 한다.
export async function apiCall<T>(method: string, path: string, body?: unknown): Promise<T> {
    return apiCallAt<T>(BASE, state().token, method, path, body);
}

async function apiCallAt<T>(base: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(new URL("/api/v1" + path, base), {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": `e2e-${Date.now()}-${n++}` },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${t}`);
    return (t ? JSON.parse(t) : null) as T;
}

/// 시험용 링크는 격리 데몬에 미리 설정한 발급 비밀번호를 함께 보낸다.
export function issueTestPairing<T = { id: string; code: string }>(name: string, password: string, base = BASE, token = state().token) {
    return apiCallAt<T>(base, token, "POST", "/pairings", { name, password, issuance_password: ISSUANCE_PASSWORD });
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

export async function registerBrowser(page: Page, base = BASE, local = state().token, name = "E2E 테스트 브라우저") {
    const password = "test-only browser pairing password";
    const link = await issueTestPairing(name, password, base, local);
    const request = await apiCallAt<{ code: string }>(base, local, "POST", "/auth/pairing", { code: link.code, password, name });
    const { device_id: id } = await apiCallAt<{ device_id: string }>(base, local, "POST", `/pairings/${link.id}/requests/${request.code.split(".")[0]}`, {});
    const response = await page.request.post(new URL("/api/v1/auth/pairing/claim", base).href, { data: { code: request.code } });
    expect(response.status()).toBe(200);
    const { access_token: token } = await response.json() as { access_token: string };
    return { id, token };
}

export async function login(page: Page) {
    const device = await registerBrowser(page);
    await page.goto("/");
    await page.locator("html[data-hydrated=true]").waitFor({ state: "attached" });
    await finishSetup(page);
    await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
    return device;
}

export async function finishSetup(page: Page, allowDaemon = true) {
    const wizard = page.getByTestId("setup-wizard");
    const conn = page.getByTestId("conn");
    for (let step = 0; step < (allowDaemon ? 5 : 2); step++) {
        const next = wizard.getByRole("button", { name: /^(다음|설정 완료)$/ });
        await expect(next.or(conn).first()).toBeVisible({ timeout: 15_000 });
        if (await conn.isVisible()) return;
        if (!allowDaemon) await expect(wizard).toContainText("로컬 설정");
        await next.click();
    }
}

export async function openBots(page: Page) {
    await openSettings(page);
    await page.getByLabel("설정 검색").fill("봇");
    await expect(page.getByTestId("bots-panel")).toBeVisible();
}

export async function openSettings(page: Page, area: "local" | "daemon" = "daemon") {
    if (page.viewportSize()!.width <= 760) {
        const trigger = page.getByRole("button", { name: "사이드바", exact: true });
        if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
        const drawer = page.getByTestId("mobile-drawer-left");
        await drawer.getByRole("button", { name: "설정", exact: true }).click();
        await expect(drawer).toHaveJSProperty("open", false);
    } else await page.getByTestId("sidebar").or(page.getByTestId("sidebar-rail"))
        .getByRole("button", { name: "설정", exact: true }).click();
    await page.getByTestId("settings").getByRole("tab", { name: area === "local" ? "로컬 설정" : "데몬 설정", exact: true }).click();
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

/// 실제 Astryx 선택창이나 모델 하위 메뉴를 열어 값을 고른다.
export async function selectChoice(control: Locator, value: string) {
    control = control.and(control.page().locator("button"));
    if (await control.getAttribute("aria-haspopup") === "menu") {
        if (value === "" || value === "__role_disabled__") {
            if (await control.getAttribute("aria-expanded") !== "true") await control.click();
            const id = await control.getAttribute("aria-controls");
            await control.page().locator(`[id=${JSON.stringify(id)}]`).getByRole("menuitemradio")
                .and(control.page().locator(`[data-option-value=${JSON.stringify(value)}]`)).click();
            await expect(control).toHaveAttribute("data-selected-value", value);
            return;
        }
        const profileId = value.startsWith("[") ? (JSON.parse(value) as string[])[0]! : value;
        const choices = await modelChoices(control, profileId);
        await choices.and(control.page().locator(`[data-option-value=${JSON.stringify(value)}]`)).click();
        await expect(control).toHaveAttribute("data-selected-value", value);
        return;
    }
    control = control.and(control.page().getByRole("combobox"));
    await control.click();
    await expect(control).toHaveAttribute("aria-expanded", "true");
    const id = await control.getAttribute("aria-controls");
    const list = control.page().locator(`[id=${JSON.stringify(id)}]`);
    await list.getByRole("option").filter({ has: control.page().locator(`[data-option-value=${JSON.stringify(value)}]`) }).click();
    await expect(control).toHaveAttribute("data-selected-value", value);
}

export async function expectChoice(control: Locator, value: string) {
    await expect(control.and(control.page().locator("button"))).toHaveAttribute("data-selected-value", value);
}

async function modelChoices(control: Locator, profileId: string) {
    if (await control.getAttribute("aria-expanded") !== "true") await control.click();
    const menu = control.page().getByTestId(`model-profile-models-${profileId}`).filter({ visible: true });
    if (!await menu.isVisible()) {
        const id = await control.getAttribute("aria-controls");
        await control.page().locator(`[id=${JSON.stringify(id)}]`).locator(`[data-profile-id=${JSON.stringify(profileId)}]`).click();
    }
    await expect(menu).toBeVisible();
    return menu.getByRole("menuitemradio");
}

export async function choiceOptions(control: Locator) {
    control = control.and(control.page().locator("button"));
    if (await control.getAttribute("aria-haspopup") === "menu") {
        return modelChoices(control, (await control.getAttribute("data-selected-profile"))!);
    }
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
