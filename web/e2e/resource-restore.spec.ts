import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { apiCall, ensureProjects, login, state } from "./helpers";

for (const operation of ["rename", "delete"] as const) {
    test(`파일 ${operation} 뒤 최근 항목은 다른 대상을 추측하거나 재생성하지 않고 편집 사본만 복구한다`, async ({ page }) => {
        const { a } = await ensureProjects();
        const project = await apiCall<{ root_path: string }>("GET", `/projects/${a.id}`);
        const folder = mkdtempSync(join(project.root_path, "restore-"));
        const path = join(folder, "source.txt");
        const moved = join(folder, "moved.txt");
        const relative = `${basename(folder)}/source.txt`;
        writeFileSync(path, "original disk fixture");
        await apiCall("POST", "/recent/touch", { kind: "file", project_id: a.id, resource_id: relative, title: relative });
        await login(page);
        const recent = page.locator(".recent").getByRole("button", { name: new RegExp(relative) });
        await recent.click();
        const view = page.getByTestId("files-view");
        await expect(view.getByLabel("파일 내용")).toHaveValue("original disk fixture");
        await view.getByLabel("파일 내용").fill("my unsaved recovery fixture");
        if (operation === "rename") renameSync(path, moved);
        else unlinkSync(path);
        await page.locator(".tabbar .tab.on").getByRole("button", { name: "탭 닫기", exact: true }).click();
        let saves = 0;
        page.on("request", (r) => { if (r.method() === "PUT" && r.url().includes(`/projects/${a.id}/files/content`)) saves++; });
        await recent.click();
        await expect(view.getByRole("alert")).toContainText("파일을 열 수 없습니다");
        const recovery = view.getByLabel("복구용 편집 사본");
        await expect(recovery).toHaveValue("my unsaved recovery fixture");
        await expect(recovery).toHaveJSProperty("readOnly", true);
        await expect(view.getByRole("button", { name: "저장", exact: true })).toHaveCount(0);
        await view.getByRole("button", { name: "파일 다시 확인", exact: true }).click();
        await expect(recovery).toHaveValue("my unsaved recovery fixture");
        expect(saves).toBe(0);
        expect(existsSync(path)).toBe(false);
        if (operation === "rename") expect(readFileSync(moved, "utf8")).toBe("original disk fixture");
        // 사용자가 원래 경로를 복구한 뒤 명시적으로 확인·저장해야 파일이 바뀐다.
        writeFileSync(path, "original disk fixture");
        await view.getByRole("button", { name: "파일 다시 확인", exact: true }).click();
        await expect(view.getByLabel("파일 내용")).toHaveValue("my unsaved recovery fixture");
        expect(readFileSync(path, "utf8")).toBe("original disk fixture");
        await view.getByRole("button", { name: "저장", exact: true }).click();
        await expect(view.getByRole("status")).toHaveText("저장됨");
        expect(readFileSync(path, "utf8")).toBe("my unsaved recovery fixture");
    });
}

test("접근 불가 프로젝트를 최근 항목에서 열어도 새 위치를 추측하거나 작업을 자동 시작하지 않는다", async ({ page }) => {
    const folder = mkdtempSync(join(dirname(state().projA), "missing-project-"));
    const root = join(folder, "root");
    mkdirSync(root);
    const title = basename(folder);
    const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root, name: title });
    await apiCall("POST", "/recent/touch", { kind: "project", project_id: project.id, resource_id: project.id });
    renameSync(root, join(folder, "moved"));
    let starts = 0;
    page.on("request", (r) => { if (r.method() === "POST" && new RegExp(`/projects/${project.id}/(sessions|terminals)$`).test(r.url())) starts++; });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).click();
    await expect(page.getByTestId("project-missing")).toContainText("프로젝트 경로에 접근할 수 없습니다");
    await expect(page.getByLabel("메시지 입력")).toBeDisabled();
    expect(starts).toBe(0);
    expect(existsSync(root)).toBe(false);
});

test("배치에 남은 없는 프로젝트 ID는 오류로 표시하고 다른 프로젝트에 입력을 보내지 않는다", async ({ page }) => {
    const missing = randomUUID();
    await page.addInitScript((id) => localStorage.setItem(`grove.draft.project:${id}#new`, JSON.stringify({
        text: "missing project draft fixture", baseRevision: 0, updatedAt: 1,
    })), missing);
    await page.route("**/api/v1/layouts/*", (route) => route.request().method() === "GET" ? route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ revision: 0, layout: { schema: 1, focused_leaf: "missing-leaf", root: {
            type: "leaf", id: "missing-leaf", active_tab: "missing-tab", tabs: [
                { id: "missing-tab", kind: "project", project_id: missing, resource_id: missing, title: "missing project fixture" },
            ],
        } } }),
    }) : route.continue());
    await login(page);
    await expect(page.getByRole("heading", { name: "프로젝트를 열 수 없습니다", exact: true })).toBeVisible();
    await expect(page.getByLabel("메시지 입력")).toBeDisabled();
    await expect(page.getByLabel("메시지 입력")).toHaveValue("missing project draft fixture");
    await expect(page.getByRole("button", { name: "프로젝트 다시 확인", exact: true })).toBeVisible();
    const checked = page.waitForResponse((r) => r.url().endsWith(`/projects/${missing}`) && r.request().method() === "GET");
    await page.getByRole("button", { name: "프로젝트 다시 확인", exact: true }).click();
    expect((await checked).status()).toBe(404);
    await expect(page.getByLabel("메시지 입력")).toHaveValue("missing project draft fixture");
});

for (const status of ["exited", "deleted"] as const) {
    test(`${status} 터미널을 최근 항목에서 열어도 새 프로세스나 접속 티켓을 만들지 않는다`, async ({ page }) => {
        const { a } = await ensureProjects();
        const name = `restore-terminal-${status}-${Date.now()}`;
        const terminal = await apiCall<{ id: string }>("POST", `/projects/${a.id}/terminals`, { name });
        const killed = await apiCall<{ status: string }>("POST", `/terminals/${terminal.id}/kill`, {});
        expect(killed.status).toBe("exited");
        await apiCall("POST", "/recent/touch", { kind: "terminal", project_id: a.id, resource_id: terminal.id, title: name });
        if (status === "deleted") await apiCall("DELETE", `/terminals/${terminal.id}`, {});
        let mutations = 0;
        page.on("request", (r) => {
            if (r.method() === "POST" && (r.url().endsWith(`/projects/${a.id}/terminals`) || r.url().endsWith(`/terminals/${terminal.id}/ticket`))) mutations++;
        });
        await login(page);
        await page.locator(".recent").getByRole("button", { name: new RegExp(name) }).click();
        const view = page.getByTestId("terminal-view");
        await expect(view).toHaveAttribute("data-conn", status === "exited" ? "readonly" : "missing");
        await expect(view.getByTestId("terminal-status")).toContainText(status === "exited" ? "종료됨" : "터미널 없음");
        await expect(view.getByRole("button", { name: "종료", exact: true })).toHaveCount(0);
        if (status === "deleted") {
            const checked = page.waitForResponse((r) => r.url().endsWith(`/projects/${a.id}/terminals`) && r.request().method() === "GET");
            await view.getByRole("button", { name: "터미널 다시 확인", exact: true }).click();
            await checked;
            await expect(view).toHaveAttribute("data-conn", "missing");
        }
        expect(mutations).toBe(0);
    });
}

test("터미널을 닫으면 진행 중인 접속 준비를 취소하고 늦은 티켓으로 연결하지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    const name = `terminal-close-${Date.now()}`;
    const terminal = await apiCall<{ id: string }>("POST", `/projects/${a.id}/terminals`, { name });
    let deliver!: () => void;
    const gate = new Promise<void>((resolve) => { deliver = resolve; });
    let accepted = false;
    let sockets = 0;
    page.on("websocket", (socket) => { if (new URL(socket.url()).pathname.startsWith("/api/v1/terminal-ws/")) sockets++; });
    await page.route(`**/api/v1/terminals/${terminal.id}/ticket`, async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        accepted = true;
        await gate;
        if (!route.request().failure()) await route.fulfill({ response });
    });
    try {
        await apiCall("POST", "/recent/touch", { kind: "terminal", project_id: a.id, resource_id: terminal.id, title: name });
        await login(page);
        await page.locator(".recent").getByRole("button", { name: new RegExp(name) }).click();
        await expect.poll(() => accepted).toBe(true);
        const cancelled = page.waitForEvent("requestfailed", (r) => r.url().endsWith(`/terminals/${terminal.id}/ticket`));
        await page.locator(".tabbar .tab.on").getByRole("button", { name: "탭 닫기", exact: true }).click();
        // 중단 이벤트도 보류한 route를 해제한 뒤 관측한다. 응답과 취소를 서로 기다리게 하지 않는다.
        deliver();
        await cancelled;
        await expect(page.getByTestId("terminal-view")).toHaveCount(0);
        expect(sockets).toBe(0);
    } finally {
        deliver();
        try { await apiCall("POST", `/terminals/${terminal.id}/kill`, {}); }
        finally { await page.unrouteAll({ behavior: "wait" }); }
    }
});
