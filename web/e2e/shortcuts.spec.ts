import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, openSettings, selectChoice, state } from "./helpers";
import { emptyLayout, MAX_TABS, type Layout } from "../app/state/layout";
import { projectLayoutKey } from "../app/state/projectLayout";
import { workspaceTabs, workspaceTabsKey } from "../app/state/workspaceTabs";

const shortcutProjects = new WeakMap<Page, string>();
test.afterEach(async ({ page }) => {
    const id = shortcutProjects.get(page);
    if (!id) return;
    await page.close();
    const path = `/layouts/${workspaceTabsKey(id)}`;
    const { revision } = await apiCall<{ revision: number }>("GET", path);
    await apiCall("PUT", path, { expected_revision: revision, layout: workspaceTabs(emptyLayout()) });
});

async function setup(page: Page, installed = true) {
    const root = mkdtempSync(join(dirname(state().projA), "shortcuts-"));
    const a = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `shortcut-${randomUUID()}` });
    const device = `shortcuts-${randomUUID()}`;
    const layout: Layout = { schema: 1, focused_leaf: "main", root: {
        type: "leaf", id: "main", active_tab: "session", tabs: [
            { id: "session", kind: "session", project_id: a.id, resource_id: session.id, title: "기존 세션" },
        ],
    } };
    const base = `${device}${page.viewportSize()!.width <= 760 ? "-narrow" : ""}`;
    await apiCall("PUT", `/layouts/${projectLayoutKey(base, a.id)}`, { expected_revision: 0, layout });
    await apiCall("PUT", `/layouts/${workspaceTabsKey(a.id)}`, { expected_revision: 0, layout: workspaceTabs(layout) });
    shortcutProjects.set(page, a.id);
    await page.addInitScript(({ device, installed }) => {
        localStorage.setItem("grove.device.id", device);
        if (installed) {
            const original = window.matchMedia.bind(window);
            window.matchMedia = (query) => {
                const result = original(query);
                if (query.includes("display-mode: standalone")) Object.defineProperty(result, "matches", { value: true });
                return result;
            };
        }
    }, { device, installed });
    await login(page);
    await expect(page.getByTestId("session-view")).toBeVisible();
    return { project: a, session };
}

async function openShortcuts(page: Page) {
    await openSettings(page, "local");
    const settings = page.getByTestId("settings");
    await expect(settings.getByTestId("shortcut-settings")).toHaveCount(0);
    await settings.getByTestId("settings-menu").getByRole("button", { name: "단축키", exact: true }).click();
    await expect(settings.getByTestId("shortcut-settings")).toBeVisible();
    await expect(settings.getByTestId("settings-body").getByRole("combobox", { name: "테마", exact: true })).toHaveCount(0);
}

test("PWA 단축키는 새 초안·탭 이동·화면 닫기를 수행하며 취소·삭제하지 않는다", async ({ page }) => {
    const { project, session } = await setup(page);
    const mutations: string[] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" || request.method() === "DELETE") mutations.push(new URL(request.url()).pathname);
    });
    await page.getByLabel("메시지 입력", { exact: true }).fill("기존 입력 보존");
    await page.keyboard.press("Control+t");
    await expect(page.getByRole("tab", { name: /새 대화/ })).toHaveCount(1);
    await expect(page.getByTestId("project-view").getByLabel("메시지 입력")).toBeFocused();
    await page.getByTestId("project-view").getByLabel("메시지 입력").fill("새 초안");
    await page.keyboard.press("Control+t");
    await expect(page.getByRole("tab", { name: /새 대화/ })).toHaveCount(2);
    await expect(page.getByTestId("project-view").getByLabel("메시지 입력")).toHaveValue("");
    await page.keyboard.press("Control+Shift+Tab");
    await expect(page.getByTestId("project-view").getByLabel("메시지 입력")).toHaveValue("새 초안");
    await page.keyboard.press("Control+1");
    await expect(page.getByTestId("session-view")).toBeVisible();
    await expect(page.getByLabel("메시지 입력", { exact: true })).toHaveValue("기존 입력 보존");
    await page.keyboard.press("Control+9");
    await expect(page.getByTestId("project-view").getByLabel("메시지 입력")).toHaveValue("");
    await page.keyboard.press("Control+Tab");
    await expect(page.getByTestId("session-view")).toBeVisible();
    await page.keyboard.press("Control+w");
    await expect(page.getByTestId("session-view")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /새 대화/ })).toHaveCount(2);
    expect(await apiCall("GET", `/sessions/${session.id}`)).toMatchObject({ id: session.id });
    const sessions = await apiCall<{ items: { id: string }[] }>("GET", `/projects/${project.id}/sessions?limit=200`);
    expect(sessions.items.some((item) => item.id === session.id)).toBe(true);
    expect(mutations.every((path) => path === "/api/v1/recent/touch"), mutations.join(", ")).toBe(true);
    const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
    await page.keyboard.press("Control+b");
    await expect(sidebar).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Control+b");
    await expect(sidebar).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Control+,");
    await expect(page.getByTestId("settings")).toBeVisible();
    await page.keyboard.press("Control+t");
    await expect(page.getByRole("tab", { name: /새 대화/, includeHidden: true })).toHaveCount(2);
});

test("Ctrl+Shift+T는 현재 프로젝트에 새 터미널을 열고 바로 입력할 수 있다", async ({ page }) => {
    const { project } = await setup(page);
    await page.getByLabel("메시지 입력", { exact: true }).fill("터미널을 닫고 돌아올 초안");
    const before = await apiCall<{ terminals: { id: string; status: string }[] }>("GET", `/projects/${project.id}/terminals`);
    const previous = new Set(before.terminals.map((terminal) => terminal.id));
    const recentRow = page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: "터미널", exact: true });
    const terminalTouches: unknown[] = [];
    page.on("request", (request) => {
        if (request.method() !== "POST" || !request.url().endsWith("/recent/touch")) return;
        const body = request.postDataJSON();
        if (body?.kind === "terminal") terminalTouches.push(body);
    });
    try {
        await page.keyboard.press("Control+Shift+t");
        const view = page.getByTestId("terminal-view");
        await expect(view).toHaveAttribute("data-conn", "open");
        await expect(view.locator("textarea.xterm-helper-textarea")).toBeFocused();
        await page.keyboard.type("printf '\\nshortcut-%s\\n' \"$((40+2))\"");
        await page.keyboard.press("Enter");
        await expect(view.locator(".xterm-rows")).toContainText("shortcut-42");
        await expect(page.getByTestId("loading-bar")).toHaveCount(0);
        await page.keyboard.press("Control+Shift+t");
        await expect(page.getByRole("tab")).toHaveCount(3);
        await expect(view).toHaveAttribute("data-conn", "open");
        await expect(view.locator("textarea.xterm-helper-textarea")).toBeFocused();
        const created = await apiCall<{ terminals: { id: string; status: string }[] }>("GET", `/projects/${project.id}/terminals`);
        expect(created.terminals.filter((terminal) => !previous.has(terminal.id))).toHaveLength(2);
        await expect(recentRow).toHaveCount(0);
        await page.keyboard.press("Control+w");
        await expect(page.getByRole("tab")).toHaveCount(2);
        await expect(view).toHaveAttribute("data-conn", "open");
        await page.keyboard.press("Control+w");
        await expect(view).toHaveCount(0);
        await expect(recentRow).toHaveCount(0);
        expect(terminalTouches).toEqual([]);
        await expect(page.getByLabel("메시지 입력", { exact: true })).toHaveValue("터미널을 닫고 돌아올 초안");
        const ended = await apiCall<{ terminals: { id: string; status: string }[] }>("GET", `/projects/${project.id}/terminals`);
        expect(ended.terminals.filter((terminal) => !previous.has(terminal.id)).every((terminal) => terminal.status === "exited")).toBe(true);
    } finally {
        const rows = await apiCall<{ terminals: { id: string; status: string }[] }>("GET", `/projects/${project.id}/terminals`);
        for (const terminal of rows.terminals.filter((terminal) => !previous.has(terminal.id) && terminal.status === "running"))
            await apiCall("POST", `/terminals/${terminal.id}/kill`);
    }
});

test("터미널을 여는 동안 연속 단축키는 중복 생성하지 않는다", async ({ page }) => {
    const { project } = await setup(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let requests = 0;
    let terminalId: string | undefined;
    const path = `**/api/v1/projects/${project.id}/terminals`;
    await page.route(path, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        requests++;
        const response = await route.fetch();
        terminalId = (await response.json()).id;
        await gate;
        await route.fulfill({ response });
    });
    try {
        await page.keyboard.press("Control+Shift+t");
        await expect.poll(() => requests).toBe(1);
        await expect(page.getByTestId("loading-bar")).toBeVisible();
        await page.keyboard.press("Control+Shift+t");
        await page.keyboard.press("Control+Shift+t");
        expect(requests).toBe(1);
        release();
        await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-conn", "open");
        await expect(page.getByTestId("loading-bar")).toHaveCount(0);
        expect(requests).toBe(1);
    } finally {
        release();
        await page.unroute(path);
        if (terminalId) await apiCall("POST", `/terminals/${terminalId}/kill`);
    }
});

test("탭 한도에서는 단축키로 보이지 않는 터미널 프로세스를 만들지 않는다", async ({ page }) => {
    const { project } = await setup(page);
    let creates = 0;
    page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === `/api/v1/projects/${project.id}/terminals`) creates++;
    });
    for (let index = 1; index < MAX_TABS; index++) await page.keyboard.press("Control+t");
    await expect(page.getByRole("tab")).toHaveCount(MAX_TABS);
    await page.keyboard.press("Control+Shift+t");
    await expect(page.getByTestId("tab-close-error")).toContainText("열린 탭이 많아요");
    expect(creates).toBe(0);
    await expect(page.getByTestId("terminal-view")).toHaveCount(0);
});

test("설정에서 조합 변경·중복 차단·해제·복원·재시작 후 보존을 지원한다", async ({ page }) => {
    await setup(page);
    await openShortcuts(page);
    const settings = page.getByTestId("shortcut-settings");
    const input = settings.getByLabel("새 세션 탭 단축키", { exact: true });
    await expect(input).toHaveValue("Ctrl+T");
    await input.fill("Ctrl+W");
    await input.press("Tab");
    await expect(settings.getByRole("alert")).toContainText("이미 쓰는 조합");
    await input.fill("Ctrl+Shift+K");
    await input.press("Tab");
    await expect(settings.getByRole("alert")).toHaveCount(0);
    await expect(settings.getByRole("combobox", { name: "단축키 프리셋" })).toHaveAttribute("data-selected-value", "custom");
    await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
    await page.keyboard.press("Control+Shift+k");
    await expect(page.getByRole("tab", { name: /새 대화/ })).toHaveCount(1);
    await page.reload();
    await expect(page.getByTestId("conn")).toHaveText("연결됨");
    await openShortcuts(page);
    await expect(input).toHaveValue("Ctrl+Shift+K");
    await input.fill("");
    await input.press("Tab");
    await expect(input).toHaveValue("");
    await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
    await page.keyboard.press("Control+Shift+k");
    await expect(page.getByRole("tab", { name: /새 대화/ })).toHaveCount(1);
    await openShortcuts(page);
    await selectChoice(settings.getByRole("combobox", { name: "단축키 프리셋" }), "off");
    await expect(input).toBeDisabled();
    await selectChoice(settings.getByRole("combobox", { name: "단축키 프리셋" }), "default");
    await expect(input).toHaveValue("Ctrl+T");
    await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
    await page.keyboard.press("Control+t");
    await expect(page.getByRole("tab", { name: /새 대화/ })).toHaveCount(2);
});

test("일반 브라우저 탭의 예약키는 앱이 가로채지 않는다", async ({ page }) => {
    await setup(page, false);
    const intercepted = await page.evaluate(() => ["KeyT", "KeyW", "Tab", "KeyB", "Shift+KeyT"].map((binding) => {
        const code = binding.replace("Shift+", "");
        const event = new KeyboardEvent("keydown", { code, key: code === "Tab" ? "Tab" : code.slice(3).toLowerCase(),
            ctrlKey: true, shiftKey: binding.startsWith("Shift+"), bubbles: true, cancelable: true });
        document.body.dispatchEvent(event);
        return event.defaultPrevented;
    }));
    expect(intercepted).toEqual([false, false, false, false, false]);
    await expect(page.getByTestId("session-view")).toBeVisible();
    await expect(page.getByRole("tab", { name: /새 대화/ })).toHaveCount(0);
});

test("390px 설정에서 단축키를 편집할 수 있고 가로로 넘치지 않는다", async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page, false);
    await openShortcuts(page);
    const input = page.getByTestId("shortcut-settings").getByLabel("새 세션 탭 단축키");
    await expect(input).toHaveValue("Ctrl+T");
    await expect(page.getByTestId("shortcut-settings").getByLabel("새 터미널 탭 단축키")).toHaveValue("Ctrl+Shift+T");
    await input.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("shortcuts-mobile.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByTestId("settings-menu").getByRole("button", { name: "화면·입력", exact: true }).click();
    await expect(input).toHaveCount(0);
    await page.getByLabel("설정 검색").fill("키보드 단축키");
    await expect(input).toHaveValue("Ctrl+T");
    await page.getByRole("tab", { name: "데몬 설정", exact: true }).click();
    await expect(page.getByTestId("settings-menu").getByRole("button", { name: "단축키", exact: true })).toHaveCount(0);
    await expect(input).toHaveCount(0);
});
