import { expect, test, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { frames } from "./fixture";
import { apiCall, apiText, composerCommand, composerOption, ensureProfile, ensureProjects, login, openDetails, requireToolApproval, script, selectChoice, sessionView, state } from "./helpers";

type CloseMode = "tab" | "context" | "browser";
type Turn = { id: string; status: string; error?: { code: string } };
type Task = { id: string; status: string };

// runner 소유 browser를 닫지 않는다. context·browser 재생성 때는 기기에 저장된 인증·배치만 넘긴다.
async function client(runner: Browser, mode: CloseMode) {
    let browser = await runner.browserType().launch({ channel: "chrome" });
    let context = await browser.newContext({ baseURL: "http://127.0.0.1:17741", viewport: { width: 1400, height: 900 } });
    let page = await context.newPage();
    return {
        get page() { return page; },
        async detach() {
            const storageState = await context.storageState();
            if (mode === "tab") await page.close();
            else if (mode === "context") await context.close();
            else await browser.close();
            return async () => {
                if (mode === "browser") browser = await runner.browserType().launch({ channel: "chrome" });
                if (mode !== "tab") context = await browser.newContext({
                    baseURL: "http://127.0.0.1:17741", viewport: { width: 1400, height: 900 }, storageState,
                });
                page = await context.newPage();
                await page.goto("/");
                await expect(page.getByTestId("conn")).toHaveText("연결됨");
                return page;
            };
        },
        async close() { await browser.close(); },
    };
}

async function conversation(page: Page) {
    await ensureProfile();
    const { a } = await ensureProjects();
    await requireToolApproval(a.id);
    const title = `tab-close-${randomUUID()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = sessionView(page, session.id);
    await composerOption(view, "보내기 방식", "model");
    await composerCommand(view, "/model fixture");
    return { project: a, title, sid: session.id, view };
}

async function cleanup(sid: string) {
    const tasks = await apiCall<{ tasks: Task[] }>("GET", `/sessions/${sid}/tasks`);
    for (const task of tasks.tasks.filter((t) => t.status === "running")) await apiCall("POST", `/tasks/${task.id}/cancel`);
    const turns = await apiCall<Turn[]>("GET", `/sessions/${sid}/turns`);
    for (const turn of turns.filter((t) => ["running", "queued", "awaiting_approval"].includes(t.status))) {
        await apiCall("POST", `/turns/${turn.id}/cancel`);
    }
}

for (const mode of ["tab", "context", "browser"] as const) {
    test(`${mode} 종료 뒤 진행 중 partial을 복원하고 사용자 취소는 유지한다`, async ({ browser }) => {
        const c = await client(browser, mode);
        let sid: string | undefined;
        try {
            const setup = await conversation(c.page);
            sid = setup.sid;
            const { view, title } = setup;
            await script({ frames: frames.text(["닫아도 진행 중"]).slice(0, 1), hang: true, marker: title });
            await view.getByLabel("메시지 입력").fill(title);
            await view.getByRole("button", { name: "보내기", exact: true }).click();
            await expect(view.getByTestId("partial")).toContainText("닫아도 진행 중");
            const [turn] = await apiCall<Turn[]>("GET", `/sessions/${sid}/turns`);
            expect(turn).toBeDefined();
            const reopen = await c.detach();
            expect((await apiCall<Turn>("GET", `/turns/${turn!.id}`)).status).toBe("running");
            const page = await reopen();
            const restored = sessionView(page, sid);
            await expect(restored.getByTestId("partial")).toContainText("닫아도 진행 중");
            await restored.getByRole("button", { name: "취소", exact: true }).click();
            await expect.poll(async () => (await apiCall<Turn>("GET", `/turns/${turn!.id}`)).status).toBe("cancelled");
            expect((await apiCall<Turn>("GET", `/turns/${turn!.id}`)).error?.code).toBe("user_stop");
            await expect(restored.getByTestId("partial")).toHaveCount(0);
            expect(await apiCall<Turn[]>("GET", `/sessions/${sid}/turns`)).toHaveLength(1);
        } finally {
            if (sid) await cleanup(sid);
            await c.close();
        }
    });

    for (const background of [false, true]) {
        test(`${mode} 종료 동안 ${background ? "백그라운드" : "장시간 foreground"} 셸과 PTY가 완료하고 다시 연결된다`, async ({ browser }) => {
            const c = await client(browser, mode);
            let sid: string | undefined;
            let terminalId: string | undefined;
            try {
                const setup = await conversation(c.page);
                sid = setup.sid;
                const { view, project, title } = setup;
                const prefix = randomUUID();
                const root = state().projA;
                const gate = `${prefix}-release`;
                await composerOption(view, "도구", true);
                await script({ frames: frames.tool("shell-close", "shell", {
                    command: `printf x >> ${prefix}-shell-count; touch ${prefix}-shell-started; while [ ! -f ${gate} ]; do sleep 0.02; done; printf 'offline shell result'`,
                    background, timeout_ms: 20000,
                }), marker: title });
                if (background) await script({ frames: frames.text(["결과 대기"]), marker: title });
                await script({ frames: frames.text(["셸 완료 확인"]), marker: title });
                await view.getByLabel("메시지 입력").fill(title);
                await view.getByRole("button", { name: "보내기", exact: true }).click();
                await view.getByTestId("approval").getByRole("button", { name: "이번만 승인", exact: true }).click();
                await expect.poll(() => existsSync(join(root, `${prefix}-shell-started`))).toBe(true);
                if (background) await expect(view.getByTestId("msg-completion-deferred")).toBeVisible();
                const [turn] = await apiCall<Turn[]>("GET", `/sessions/${sid}/turns`);
                expect(turn?.status).toBe(background ? "running" : "awaiting_approval");

                const terminalName = `pty-${prefix}`;
                const terminal = await apiCall<{ id: string }>("POST", `/projects/${project.id}/terminals`, { name: terminalName });
                terminalId = terminal.id;
                await c.page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
                await c.page.getByTestId("navigation-context").getByRole("button", { name: /프로젝트 화면으로$/ }).click();
                const terminals = c.page.getByTestId("terminal-list");
                await openDetails(terminals, "터미널");
                await terminals.getByRole("button", { name: terminalName, exact: true }).click();
                const terminalView = c.page.getByTestId("terminal-view");
                await expect(terminalView).toHaveAttribute("data-conn", "open");
                await terminalView.locator(".xterm").click();
                await c.page.keyboard.type(`stty -echo; printf x >> ${prefix}-pty-count; printf '\\nready-%s\\n' "$((40+2))"; while [ ! -f ${gate} ]; do sleep 0.02; done; printf '\\noffline-pty-%s\\n' "$((40+2))"`);
                await c.page.keyboard.press("Enter");
                await expect(terminalView.locator(".xterm-rows")).toContainText("ready-42");
                const reopen = await c.detach();
                expect((await apiCall<Turn>("GET", `/turns/${turn!.id}`)).status).toBe(background ? "running" : "awaiting_approval");
                if (background) {
                    const tasks = await apiCall<{ tasks: Task[] }>("GET", `/sessions/${sid}/tasks`);
                    expect(tasks.tasks).toHaveLength(1);
                    expect(tasks.tasks[0]!.status).toBe("running");
                }
                // 페이지가 없는 동안 실제 셸과 PTY의 gate를 해제한다.
                writeFileSync(join(root, gate), "go");
                await expect.poll(async () => (await apiCall<Turn>("GET", `/turns/${turn!.id}`)).status).toBe("completed");
                await expect.poll(() => apiText(`/terminals/${terminalId}/screen`)).toContain("offline-pty-42");
                const page = await reopen();
                const restoredTerminal = page.getByTestId("terminal-view");
                await expect(restoredTerminal).toHaveAttribute("data-conn", "open");
                await expect(restoredTerminal.locator(".xterm-rows")).toContainText("offline-pty-42");
                await restoredTerminal.locator(".xterm").click();
                await page.keyboard.type("printf '\\nreconnected-%s\\n' \"$((40+3))\"");
                await page.keyboard.press("Enter");
                await expect(restoredTerminal.locator(".xterm-rows")).toContainText("reconnected-43");
                await page.getByRole("tab", { selected: true }).getByRole("button", { name: "탭 닫기", exact: true }).click();
                await expect(restoredTerminal).toHaveCount(0);
                const list = await apiCall<{ terminals: { id: string; status: string; reason: string }[] }>("GET", `/projects/${project.id}/terminals`);
                expect(list.terminals.find((t) => t.id === terminalId)).toMatchObject({ status: "exited", reason: "사용자가 종료함" });

                await page.getByRole("tab").getByRole("button", { name: new RegExp(title) }).click();
                const restored = sessionView(page, sid);
                await expect(restored.getByTestId("msg-assistant").last()).toContainText("셸 완료 확인");
                if (background) {
                    const messages = await apiCall<{ items: { content: { type?: string; stdout_tail?: string } }[] }>("GET", `/sessions/${sid}/messages`);
                    expect(messages.items.find((m) => m.content.type === "task_result")?.content.stdout_tail?.trim()).toBe("offline shell result");
                    await expect(restored).not.toContainText("offline shell result");
                }
                expect(await apiCall<Turn[]>("GET", `/sessions/${sid}/turns`)).toHaveLength(1);
                // 복원이 프로세스 재실행이 아닌지 실제 side effect로 확인한다.
                expect(readFileSync(join(root, `${prefix}-shell-count`), "utf8")).toBe("x");
                expect(readFileSync(join(root, `${prefix}-pty-count`), "utf8")).toBe("x");
            } finally {
                if (sid) await cleanup(sid);
                if (terminalId) await apiCall("POST", `/terminals/${terminalId}/kill`);
                await c.close();
            }
        });
    }
}
