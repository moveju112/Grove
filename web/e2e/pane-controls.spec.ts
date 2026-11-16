import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { frames } from "./fixture";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, script, startProjectConversation } from "./helpers";
import type { Layout } from "../app/state/layout";

async function setup(page: Page) {
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `pane-controls-${randomUUID()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    const device = `panes-${randomUUID()}`;
    const layout: Layout = { schema: 1, focused_leaf: "left", root: {
        type: "split", direction: "column", ratio: 0.35, children: [
            { type: "leaf", id: "left", active_tab: "session", tabs: [
                { id: "session", kind: "session", project_id: a.id, resource_id: s.id, title },
            ] },
            { type: "leaf", id: "right", active_tab: "project", tabs: [
                { id: "project", kind: "project", project_id: a.id, resource_id: a.id, title: a.name },
            ] },
        ],
    } };
    await apiCall("PUT", `/layouts/${device}`, { expected_revision: 0, layout });
    await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
    await login(page);
    const left = page.locator('[data-leaf="left"]');
    const right = page.locator('[data-leaf="right"]');
    await expect(left.getByTestId("session-view")).toBeVisible();
    return { s, title, left, right, project: a };
}

test("전체 보기·버튼과 Escape 복원은 pane을 재생성하지 않고 초안·선택·분할 비율을 유지한다", async ({ page }) => {
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

test("묶인 분할 버튼은 키보드와 클릭으로 각각 오른쪽·아래에 영역을 만든다", async ({ page }) => {
    const { left } = await setup(page);
    const group = left.getByRole("group", { name: "화면 분할", exact: true });
    await group.getByRole("button", { name: "오른쪽으로 분할", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("pane")).toHaveCount(3);
    await expect(page.getByTestId("split-row")).toHaveCount(1);
    await group.getByRole("button", { name: "아래로 분할", exact: true }).click();
    await expect(page.getByTestId("pane")).toHaveCount(4);
    await expect(page.getByTestId("split-column")).toHaveCount(2);
});
