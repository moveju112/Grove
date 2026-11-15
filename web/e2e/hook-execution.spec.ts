import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiCall, login } from "./helpers";
import type { Hook } from "../app/api/hooks";
import type { ToolCallRow } from "../app/api/generated";

type Fixture = { root: string; project: string; hook: Hook; session: string; call: ToolCallRow };
const active = ["pending_approval", "approved", "running"];
const longCommand = "printf x >> effects; sleep 120 & echo $! > child.pid; printf ready > ready; wait";
const read = (root: string, name: string) => readFileSync(join(root, name), "utf8");
const getCall = (id: string) => apiCall<ToolCallRow>("GET", `/tool-calls/${id}`);
const callsIn = (session: string) => apiCall<ToolCallRow[]>("GET", `/tool-calls?session_id=${session}`);

async function withFixture(command: string, run: (fixture: Fixture) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), "hook-execution-"));
    let hook: Hook | undefined;
    let project: string | undefined;
    try {
        project = (await apiCall<{ id: string }>("POST", "/projects", { root_path: root })).id;
        hook = await apiCall<Hook>("POST", `/hooks?project_id=${project}`, {
            name: `hook-execution-${Date.now()}`, event: "SessionStart", matcher: "*", command, enabled: true,
        });
        const session = (await apiCall<{ id: string }>("POST", `/projects/${project}/sessions`, { title: hook.name })).id;
        const calls = (await callsIn(session)).filter((c) => c.name === "hook");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.status).toBe("pending_approval");
        expect(existsSync(join(root, "effects"))).toBe(false);
        await run({ root, project, hook, session, call: calls[0]! });
    } finally {
        if (hook) {
            const calls = await apiCall<ToolCallRow[]>("GET", `/hooks/executions?project_id=${project}`);
            for (const call of calls.filter((c) => active.includes(c.status))) {
                await apiCall("POST", `/tool-calls/${call.id}/cancel`, {});
                await expect.poll(async () => active.includes((await getCall(call.id)).status)).toBe(false);
            }
            await apiCall("DELETE", `/hooks/${hook.id}?project_id=${project}&expected_revision=${hook.revision}`);
        }
        // 이 시험이 할당한 fixture만, 소유 실행의 종료 확인 뒤 회수한다.
        rmSync(root, { recursive: true });
    }
}

async function showHooks(page: Page) {
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").last().fill("hook");
    await expect(page.getByTestId("hook-executions").last()).toBeVisible();
}
function card(page: Page, id: string) {
    return page.getByTestId("hook-executions").last().locator(`[data-call-id="${id}"]`);
}
async function reconnect(page: Page) {
    await page.goto("/");
    await expect(page.getByTestId("conn")).toHaveText("연결됨");
    await showHooks(page);
}
async function assertSingleEffect(f: Fixture) {
    expect((await callsIn(f.session)).filter((c) => c.name === "hook").map((c) => c.id)).toEqual([f.call.id]);
    expect(read(f.root, "effects")).toBe("x");
}
function childAlive(pid: number) {
    try {
        return !readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.startsWith("Z");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}
async function readyChild(f: Fixture) {
    await expect.poll(() => {
        try { return read(f.root, "ready"); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
            throw error;
        }
    }).toBe("ready");
    const pid = Number(read(f.root, "child.pid").trim());
    expect(pid).toBeGreaterThan(0);
    expect(childAlive(pid)).toBe(true);
    return pid;
}
async function cancelInBrowser(page: Page, f: Fixture, pid: number) {
    await card(page, f.call.id).getByRole("button", { name: "hook 실행 취소", exact: true }).click();
    await expect(card(page, f.call.id)).toContainText("취소됨");
    expect((await getCall(f.call.id)).status).toBe("cancelled");
    await expect.poll(() => childAlive(pid)).toBe(false);
    await assertSingleEffect(f);
}

test("SessionStart는 승인 후 한 번 실행하고 기록을 복원하며 거부는 실행하지 않는다", async ({ page }) => {
    await withFixture("printf x >> effects; printf hook-local-fixture", async (f) => {
        await login(page);
        await showHooks(page);
        const view = card(page, f.call.id);
        await expect(view).toContainText("승인 대기");
        await view.getByRole("button", { name: "승인 계획", exact: true }).click();
        await expect(view).toContainText('"hook_revision": 1');
        await expect(view).toContainText('"environment"');
        await expect(view).toContainText('"limits"');
        await expect(view).toContainText("hook-local-fixture");
        expect((await getCall(f.call.id)).status).toBe("pending_approval");
        await view.getByRole("dialog", { name: "승인 계획", exact: true }).getByRole("button", { name: "닫기", exact: true }).click();
        await expect(view.getByRole("dialog", { name: "승인 계획", exact: true })).toHaveCount(0);
        await view.getByRole("button", { name: "이번만 승인", exact: true }).click();
        await expect(view).toContainText("실행 완료");
        await expect(view).toContainText('"stdout": "hook-local-fixture"');
        await assertSingleEffect(f);
        await page.reload();
        await showHooks(page);
        await expect(card(page, f.call.id)).toContainText("실행 완료");
        await assertSingleEffect(f);
        const deniedSession = await apiCall<{ id: string }>("POST", `/projects/${f.project}/sessions`, { title: "deny fixture" });
        const denied = (await callsIn(deniedSession.id)).find((c) => c.name === "hook")!;
        await page.getByRole("button", { name: "hook 실행 상태 새로고침", exact: true }).last().click();
        await card(page, denied.id).getByRole("button", { name: "거부", exact: true }).click();
        await expect(card(page, denied.id)).toContainText("거부됨");
        expect((await getCall(denied.id)).status).toBe("denied");
        await assertSingleEffect(f);
    });
});

test("브라우저 탭 종료는 hook 취소가 아니며 재연결 후 명시적 취소가 자손을 회수한다", async ({ page, context }) => {
    await withFixture(longCommand, async (f) => {
        await login(page);
        await showHooks(page);
        await card(page, f.call.id).getByRole("button", { name: "이번만 승인", exact: true }).click();
        const pid = await readyChild(f);
        await expect(card(page, f.call.id)).toContainText("실행 중");
        await page.close();
        expect((await getCall(f.call.id)).status).toBe("running");
        expect(childAlive(pid)).toBe(true);
        const next = await context.newPage();
        await reconnect(next);
        await expect(card(next, f.call.id)).toContainText("실행 중");
        await cancelInBrowser(next, f, pid);
        await next.reload();
        await showHooks(next);
        await expect(card(next, f.call.id)).toContainText("취소됨");
        await assertSingleEffect(f);
    });
});

test("실제 승인 응답 transport abort 뒤 상태 확인·reload는 명령을 반복하지 않는다", async ({ page }) => {
    await withFixture(longCommand, async (f) => {
        await login(page);
        await showHooks(page);
        const decisions: { key: string | undefined; body: unknown }[] = [];
        await page.route(`**/api/v1/tool-calls/${f.call.id}/decision`, async (route) => {
            decisions.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
            const response = await route.fetch();
            expect(response.ok()).toBe(true);
            await route.abort("connectionfailed");
        });
        await card(page, f.call.id).getByRole("button", { name: "이번만 승인", exact: true }).click();
        const pid = await readyChild(f);
        await page.getByRole("button", { name: "hook 실행 상태 새로고침", exact: true }).last().click();
        await expect(card(page, f.call.id)).toContainText("실행 중");
        await expect(card(page, f.call.id).getByRole("button", { name: "이번만 승인", exact: true })).toHaveCount(0);
        await page.reload();
        await showHooks(page);
        await expect(card(page, f.call.id)).toContainText("실행 중");
        expect(decisions).toHaveLength(1);
        expect(decisions[0]!.key).toBeTruthy();
        expect(decisions[0]!.body).toEqual({ decision: "approve", expected_revision: f.call.revision });
        await assertSingleEffect(f);
        await cancelInBrowser(page, f, pid);
        expect(decisions).toHaveLength(1);
    });
});
