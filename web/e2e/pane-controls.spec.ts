import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { frames } from "./fixture";
import { apiCall, composerOption, ensureProfile, login, openTool, script, splitNewConversation, startProjectConversation, state, toolTrigger } from "./helpers";
import type { Layout } from "../app/state/layout";
import { workspaceTabs, workspaceTabsKey } from "../app/state/workspaceTabs";

async function setup(page: Page, direction: "row" | "column" = "column") {
    const root = mkdtempSync(join(dirname(state().projA), "pane-controls-"));
    const a = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    await ensureProfile();
    const title = `pane-controls-${randomUUID()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    const device = `panes-${randomUUID()}`;
    const layout: Layout = { schema: 1, focused_leaf: "left", root: {
        type: "split", direction, ratio: 0.35, children: [
            { type: "leaf", id: "left", active_tab: "session", tabs: [
                { id: "session", kind: "session", project_id: a.id, resource_id: s.id, title },
            ] },
            { type: "leaf", id: "right", active_tab: "project", tabs: [
                { id: "project", kind: "project", project_id: a.id, resource_id: a.id, title: a.name },
            ] },
        ],
    } };
    await apiCall("PUT", `/layouts/${device}`, { expected_revision: 0, layout });
    // 기기 배치와 공유 대화 목록을 함께 준비해 앞 시험의 탭이 여기로 이어지지 않게 한다.
    await apiCall("PUT", `/layouts/${workspaceTabsKey(a.id)}`, { expected_revision: 0, layout: workspaceTabs(layout) });
    await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
    await login(page);
    const left = page.locator('[data-leaf="left"]');
    const right = page.locator('[data-leaf="right"]');
    await expect(left.getByTestId("session-view")).toBeVisible();
    return { s, title, left, right, project: a };
}

test("탭이 넘쳐도 양쪽 영역의 본문 높이가 어긋나지 않고 아이콘으로 분할을 복원한다", async ({ page }, info) => {
    const { left, right } = await setup(page, "row");
    const list = left.getByRole("tablist", { name: "열린 대화와 화면" });
    const fits = () => list.evaluate((el) => el.scrollWidth <= el.clientWidth);
    const contentTop = async () => Promise.all([left, right].map((pane) =>
        pane.getByTestId("pane-viewport").evaluate((el) => el.getBoundingClientRect().top)));
    expect(await fits()).toBe(true);
    const before = await contentTop();
    expect(before[0]).toBe(before[1]);

    const plus = left.getByRole("button", { name: "새 대화 탭", exact: true });
    for (let i = 0; i < 6; i++) await plus.click();
    await expect.poll(fits).toBe(false);
    await expect.poll(() => list.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    expect(await contentTop()).toEqual(before);
    await page.screenshot({ path: info.outputPath("pane-tab-overflow.png"), animations: "disabled" });

    const expand = left.getByRole("button", { name: "영역 전체 보기", exact: true });
    await expect(expand.locator("svg")).toBeVisible();
    await expect(expand).toBeEmpty();
    await expand.press("Enter");
    await expect(right).toBeHidden();
    const restore = left.getByRole("button", { name: "분할 복원", exact: true });
    await expect(restore.locator("svg")).toBeVisible();
    await expect(restore).toBeEmpty();
    await restore.press("Enter");
    await expect(right).toBeVisible();
    expect(await contentTop()).toEqual(before);
});

test("도구 버튼은 각 영역의 탭 줄에서 해당 패널만 열고 미전송 입력을 보존한다", async ({ page }, info) => {
    const { left, right } = await setup(page);
    await left.getByLabel("메시지 입력").fill("왼쪽 입력");
    await right.getByLabel("메시지 입력").fill("오른쪽 입력");
    for (const pane of [left, right]) {
        await expect(pane.getByTestId("pane-tab-actions").getByRole("button", { name: "도구 패널", exact: true })).toHaveCount(1);
        await expect(pane.getByTestId("pane-body").getByRole("button", { name: "도구 패널", exact: true })).toHaveCount(0);
    }
    await openTool(right, "파일");
    await expect(toolTrigger(right)).toHaveAttribute("aria-expanded", "true");
    await expect(toolTrigger(left)).toHaveAttribute("aria-expanded", "false");
    await right.getByRole("button", { name: "도구 패널 닫기", exact: true }).click();
    await expect(toolTrigger(right)).toBeFocused();
    await openTool(left, "변경");
    await expect(toolTrigger(left)).toHaveAttribute("aria-expanded", "true");
    await expect(toolTrigger(right)).toHaveAttribute("aria-expanded", "false");
    await left.getByRole("button", { name: "도구 패널 닫기", exact: true }).click();
    await expect(left.getByTestId("tool-dock")).toHaveJSProperty("open", false);
    await expect(left.getByLabel("메시지 입력")).toHaveValue("왼쪽 입력");
    await expect(right.getByLabel("메시지 입력")).toHaveValue("오른쪽 입력");
    await page.setViewportSize({ width: 932, height: 700 });
    await expect(toolTrigger(left)).toBeVisible();
    await expect(toolTrigger(right)).toBeVisible();
    await page.screenshot({ path: info.outputPath("pane-tools-desktop.png"), animations: "disabled" });
});

test("전체 보기에서 Escape는 모달부터 닫고 다음에 분할을 복원한다", async ({ page }) => {
    const { left, right } = await setup(page);
    await left.getByLabel("메시지 입력").fill("left draft");
    await startProjectConversation(right);
    await right.getByLabel("메시지 입력").fill("right draft");
    await right.getByLabel("메시지 입력").evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(1, 4));
    const input = await right.getByLabel("메시지 입력").elementHandle();
    await left.getByRole("button", { name: "영역 전체 보기", exact: true }).click();
    await expect(right).toBeHidden();
    await expect(page.getByRole("separator").and(page.locator("[aria-valuenow]"))).toHaveCount(0);
    await expect(left.getByLabel("메시지 입력")).toHaveValue("left draft");
    await left.getByRole("button", { name: "분할 복원", exact: true }).click();
    await expect(right).toBeVisible();
    expect(await input!.evaluate((node: HTMLTextAreaElement) => ({ connected: node.isConnected, start: node.selectionStart, end: node.selectionEnd })))
        .toEqual({ connected: true, start: 1, end: 4 });
    await right.getByRole("button", { name: "영역 전체 보기", exact: true }).click();
    await expect(left).toBeHidden();
    await right.getByTestId("attachment-picker").locator('input[type="file"]').setInputFiles("../tests/fixtures/images/animated.gif");
    const previewButton = right.getByRole("button", { name: "animated.gif 미리보기", exact: true });
    await previewButton.click();
    const preview = page.getByRole("dialog", { name: "animated.gif 미리보기", exact: true });
    await expect(preview).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();
    await expect(left).toBeHidden();
    await expect(previewButton).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(left).toBeVisible();
    await expect(page.getByRole("separator").and(page.locator("[aria-valuenow]"))).toHaveAttribute("aria-valuenow", "35");
    await expect(page.getByTestId("split-column")).toBeVisible();
    await expect(right.getByLabel("메시지 입력")).toHaveValue("right draft");
});

test("숨긴 실행 pane을 닫아 합쳐도 승인·작업은 취소하지 않고 같은 탭에서 한 번만 이어진다", async ({ page }) => {
    const { s, title, left, right, project } = await setup(page);
    // 일반 작업은 기본 자동 허용이므로 승인 상태의 보존 검사는 프로젝트 제한을 명시한다.
    const projectId = project.id;
    await apiCall("PUT", `/settings/project/${projectId}/tools.full_access`, { expected_revision: 0, value: false });
    const mutations: string[] = [];
    page.on("request", (r) => {
        const path = new URL(r.url()).pathname;
        if (r.method() === "POST" && /\/(cancel|terminate|decision)$/.test(path)) mutations.push(path);
    });
    await script({ marker: title, frames: frames.tool("pane-shell", "shell", { command: "printf 'pane-controls fixture\\n'" }) });
    await composerOption(left, "도구", true);
    await composerOption(left, "보내기 방식", "model");
    await left.getByLabel("메시지 입력").fill(title);
    await left.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(left.getByTestId("approval")).toBeVisible();
    await left.getByLabel("메시지 입력").fill("keep after merge");
    await right.getByRole("button", { name: "영역 전체 보기", exact: true }).click();
    await expect(left).toBeHidden();
    const turns = await apiCall<{ id: string; status: string }[]>("GET", `/sessions/${s.id}/turns?limit=1`);
    try {
        expect(turns[0]?.status).toBe("awaiting_approval");
        await right.getByRole("button", { name: "분할 복원", exact: true }).click();
        await left.getByRole("button", { name: "영역 닫기", exact: true }).click();
        await expect(page.getByTestId("pane")).toHaveCount(1);
        await expect(right.getByTestId("approval")).toBeVisible();
        await expect(right.getByLabel("메시지 입력")).toHaveValue("keep after merge");
        expect(mutations).toEqual([]);
        await script({ marker: title, frames: frames.text(["pane result fixture"]) });
        await right.getByTestId("approval").getByRole("button", { name: "이번만 승인", exact: true }).click();
        await expect(right.getByTestId("msg-assistant").filter({ hasText: "pane result fixture" })).toHaveCount(1);
        const final = await apiCall<{ id: string; status: string }[]>("GET", `/sessions/${s.id}/turns?limit=5`);
        expect(final).toHaveLength(1);
        expect(final[0]).toMatchObject({ id: turns[0]!.id, status: "completed" });
        await right.getByRole("tab").filter({ hasText: title }).getByRole("button", { name: "탭 닫기" }).click();
        expect(mutations).toHaveLength(1);
    } finally {
        const current = await apiCall<{ id: string; status: string }[]>("GET", `/sessions/${s.id}/turns?limit=1`);
        if (current[0] && ["queued", "running", "awaiting_approval", "awaiting_input"].includes(current[0].status))
            await apiCall("POST", `/turns/${current[0].id}/cancel`, {});
        await apiCall("PUT", `/settings/project/${projectId}/tools.full_access`, { expected_revision: 1, value: null });
    }
});

test("영역 합치기는 입력·진행 중 첨부를 탭별로 유지하고 탭 닫기·새로고침은 미전송 입력을 버린다", async ({ page }) => {
    const { left, right, title, project, s } = await setup(page);
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: s.id });
    await left.getByLabel("메시지 입력").fill("합쳐도 유지할 입력");
    await right.getByLabel("메시지 입력").fill("다른 탭의 입력");
    let release!: () => void;
    const upload = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/v1/projects/${project.id}/attachments`, async (route) => {
        await upload;
        await route.continue();
    });
    try {
        await left.getByTestId("attachment-picker").locator('input[type="file"]').setInputFiles({
            name: "merge-note.txt", mimeType: "text/plain", buffer: Buffer.from("merge attachment"),
        });
        await expect(left.getByRole("button", { name: "merge-note.txt 첨부 제거", exact: true })).toBeDisabled();
        await left.getByRole("button", { name: "영역 닫기", exact: true }).click();
        await expect(right.getByLabel("메시지 입력")).toHaveValue("합쳐도 유지할 입력");
        release();
        await expect(right.getByRole("button", { name: "merge-note.txt 첨부 제거", exact: true })).toBeEnabled();
        await right.getByRole("tab").filter({ hasText: "새 대화" }).getByTestId("tab-title").click();
        await expect(right.getByLabel("메시지 입력")).toHaveValue("다른 탭의 입력");
        await expect(right.getByRole("button", { name: "merge-note.txt 첨부 제거", exact: true })).toHaveCount(0);
        await right.getByRole("tab").filter({ hasText: title }).getByTestId("tab-title").click();
        await expect(right.getByLabel("메시지 입력")).toHaveValue("합쳐도 유지할 입력");
        await expect(right.getByRole("button", { name: "merge-note.txt 첨부 제거", exact: true })).toBeEnabled();
        expect(await page.evaluate(() => [localStorage, sessionStorage].some((store) =>
            Object.values(store).some((value) => typeof value === "string" && value.includes("합쳐도 유지할 입력"))))).toBe(false);
        await right.getByRole("tab").filter({ hasText: title }).getByRole("button", { name: "탭 닫기", exact: true }).click();
        await expect(page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) })).toHaveCount(0);
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: s.id });
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
        await expect(right.getByLabel("메시지 입력")).toBeEmpty();
        await expect(right.getByRole("button", { name: "merge-note.txt 첨부 제거", exact: true })).toHaveCount(0);
        await right.getByLabel("메시지 입력").fill("새로고침 전 입력");
        await page.reload();
        await expect(right.getByLabel("메시지 입력")).toBeEmpty();
    } finally {
        release();
    }
});

test("전송 중 영역을 합쳐도 중복 전송하지 않고 늦은 응답이 새 입력을 지우지 않는다", async ({ page }) => {
    const { left, right, s } = await setup(page);
    await composerOption(left, "보내기 방식", "save");
    await left.getByLabel("메시지 입력").fill("합치기 전에 보낸 메시지");
    let release!: () => void;
    const response = new Promise<void>((resolve) => { release = resolve; });
    let accepted!: () => void;
    const stored = new Promise<void>((resolve) => { accepted = resolve; });
    let requests = 0;
    await page.route(`**/api/v1/sessions/${s.id}/messages`, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        requests++;
        const result = await route.fetch();
        accepted();
        await response;
        await route.fulfill({ response: result });
    });
    try {
        await left.getByRole("button", { name: "보내기", exact: true }).click();
        await stored;
        await left.getByRole("button", { name: "영역 닫기", exact: true }).click();
        await expect(right.getByRole("button", { name: "보내는 중…", exact: true })).toBeDisabled();
        await right.getByLabel("메시지 입력").fill("응답 전에 새로 작성한 입력");
        release();
        await expect(right.getByRole("button", { name: "보내기", exact: true })).toBeEnabled();
        await expect(right.getByLabel("메시지 입력")).toHaveValue("응답 전에 새로 작성한 입력");
        await expect(right.getByTestId("send-unsure")).toHaveCount(0);
        expect(requests).toBe(1);
        const history = await apiCall<{ items: { role: string }[] }>("GET", `/sessions/${s.id}/messages`);
        expect(history.items.filter((message) => message.role === "user")).toHaveLength(1);
    } finally {
        release();
    }
});

test("분할 버튼 없이 새 대화 탭을 오른쪽·아래로 드래그해 독립된 영역을 연다", async ({ page }) => {
    const { left, s } = await setup(page);
    await expect(page.getByRole("group", { name: "화면 분할", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "오른쪽으로 분할", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "아래로 분할", exact: true })).toHaveCount(0);
    const sessionsBefore = await page.getByTestId("session-view").count();
    await splitNewConversation(left, "right");
    await expect(page.getByTestId("pane")).toHaveCount(3);
    await expect(page.getByTestId("split-row")).toHaveCount(1);
    const first = page.locator('[data-testid="pane"][data-focused="true"]');
    await expect(first.getByTestId("project-view")).toBeVisible();
    await expect(first.getByLabel("메시지 입력")).toBeEmpty();
    await first.getByLabel("메시지 입력").fill("오른쪽 새 대화");
    const firstId = await first.getAttribute("data-leaf");
    await splitNewConversation(left, "bottom");
    await expect(page.getByTestId("pane")).toHaveCount(4);
    await expect(page.getByTestId("split-column")).toHaveCount(2);
    await expect(page.locator('[data-testid="pane"][data-focused="true"]').getByLabel("메시지 입력")).toBeEmpty();
    await expect(page.locator(`[data-leaf="${firstId}"]`).getByLabel("메시지 입력")).toHaveValue("오른쪽 새 대화");
    await expect(left.locator(`[data-session="${s.id}"]`)).toBeVisible();
    await expect(page.getByTestId("session-view")).toHaveCount(sessionsBefore);
});

test("오른쪽 끝에 탭을 드래그하면 2~5개 영역의 표시 폭이 같아진다", async ({ page }) => {
    await page.setViewportSize({ width: 1640, height: 900 });
    const { left, right } = await setup(page);
    const bottom = (await right.boundingBox())!;
    const row = page.getByTestId("split-row").first();
    const panes = row.getByTestId("pane");
    await splitNewConversation(left, "right");
    for (let count = 2; count <= 5; count++) {
        await expect(panes).toHaveCount(count);
        const widths = await panes.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
        expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
        if (count < 5) await splitNewConversation(panes.last(), "right");
    }
    expect(await right.boundingBox()).toEqual(bottom);
});

test("탭 옆 +는 새 대화를 추가하고 첫 전송은 그 탭만 새 세션으로 바꾼다", async ({ page }, info) => {
    const { left, s, project } = await setup(page);
    const plus = left.getByRole("button", { name: "새 대화 탭", exact: true });
    const tab = await left.getByRole("tab").last().boundingBox();
    const button = await plus.boundingBox();
    expect(button!.x - (tab!.x + tab!.width)).toBeGreaterThanOrEqual(0);
    expect(button!.x - (tab!.x + tab!.width)).toBeLessThanOrEqual(8);
    const before = await apiCall<{ items: { id: string }[] }>("GET", `/projects/${project.id}/sessions`);
    await plus.click();
    await expect(left.getByRole("tab")).toHaveCount(2);
    await expect(left.getByRole("tab", { selected: true })).toHaveText("새 대화");
    await expect(left.getByLabel("메시지 입력")).toBeEmpty();
    await plus.click();
    await expect(left.getByRole("tab")).toHaveCount(3);
    await expect(left.getByLabel("메시지 입력")).toBeEmpty();
    const opened = await apiCall<{ items: { id: string }[] }>("GET", `/projects/${project.id}/sessions`);
    expect(opened.items).toHaveLength(before.items.length);
    await page.reload();
    await expect(left.getByRole("tab")).toHaveCount(3);
    await expect(left.getByRole("tab", { selected: true })).toHaveText("새 대화");
    await expect(left.getByLabel("메시지 입력")).toBeEmpty();
    await composerOption(left, "보내기 방식", "save");
    await left.getByLabel("메시지 입력").fill("탭에서 만든 새 세션");
    await left.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(left.getByTestId("msg-user")).toContainText("탭에서 만든 새 세션");
    await expect(left.getByRole("tab")).toHaveCount(3);
    const createdId = await left.getByTestId("session-view").getAttribute("data-session");
    expect(createdId).not.toBe(s.id);
    const after = await apiCall<{ items: { id: string }[] }>("GET", `/projects/${project.id}/sessions`);
    expect(after.items).toHaveLength(before.items.length + 1);
    await page.screenshot({ path: info.outputPath("new-session-tabs.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
    await expect(page.getByTestId("mobile-drawer-left")).toBeHidden();
    await expect(page.getByTestId("project-view").filter({ visible: true }).getByLabel("메시지 입력")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "열린 대화와 화면" })).toBeHidden();
    await expect(page.getByRole("button", { name: "새 대화 탭", exact: true })).toBeHidden();
    await expect(page.getByRole("banner").getByRole("button", { name: "새 대화", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("new-session-mobile-390.png") });
});
