import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProfile, login, openDetails, script, sessionView, state } from "./helpers";
import { frames } from "./fixture";

async function setup(page: Page) {
    const root = mkdtempSync(join(state().projA, "exec-cwd-"));
    for (const dir of ["work", "next"]) mkdirSync(join(root, dir));
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: project.name });
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
    await page.getByRole("button", { name: "프로젝트 설정", exact: true }).click();
    await page.getByLabel("설정 검색", { exact: true }).fill("셸·자원");
    const panel = page.getByTestId("exec-settings");
    const row = panel.getByTestId("setting-exec.default_cwd");
    const save = async (value: string) => {
        await row.getByLabel("기본 작업 위치", { exact: true }).fill(value);
        const response = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/exec.default_cwd"));
        await row.getByRole("button", { name: "저장", exact: true }).click();
        expect((await response).ok()).toBe(true);
        await expect(row.getByRole("status")).toContainText("저장됨");
    };
    return { root, project, session, panel, save };
}

type Call = {
    id: string;
    revision: number;
    target: { cwd: string };
    result: { stdout?: string; stdout_tail?: string; background?: boolean; task_id?: string };
};
type Turn = { status: string; tool_calls: Call[] };
type Task = { id: string; cwd: string; status: string; stdout_tail: string };

test("설정 화면에서 바꾼 cwd는 다음 모델 셸에만 적용되고 명시한 점은 root를 유지한다", async ({ page }) => {
    const { root, session, panel, save } = await setup(page);
    const profile = await ensureProfile();
    await expect(panel).toContainText("실제 실행 root(worktree 포함)");
    for (const background of [false, true]) {
        await save("work");
        for (const explicit of [false, true]) {
            await script({ frames: frames.tool("cwd", "shell", {
                command: "pwd -P",
                ...(background ? { background: true } : {}),
                ...(explicit ? { cwd: "." } : {}),
            }) });
            await script({ frames: frames.text(["끝"]) });
            const { turn } = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`,
                { text: "run", profile_id: profile, tools: true });
            await expect.poll(async () => (await apiCall<Turn>("GET", `/turns/${turn.id}`)).status).toBe("awaiting_approval");
            const pending = (await apiCall<Turn>("GET", `/turns/${turn.id}`)).tool_calls[0]!;
            expect(pending.target.cwd).toBe(explicit ? "." : "work");
            if (!explicit) await save("next");
            await apiCall("POST", `/tool-calls/${pending.id}/decision`, { decision: "approve", expected_revision: pending.revision });
            await expect.poll(async () => (await apiCall<Turn>("GET", `/turns/${turn.id}`)).status).toBe("completed");
            const done = (await apiCall<Turn>("GET", `/turns/${turn.id}`)).tool_calls[0]!;
            expect(done.target).toEqual(pending.target);
            const result = done.result.background
                ? await apiCall<Task>("GET", `/tasks/${done.result.task_id}/wait?timeout_ms=10000`)
                : done.result;
            expect("stdout" in result ? result.stdout : result.stdout_tail).toBe(`${explicit ? root : join(root, "work")}\n`);
        }
    }
});

test("작업 접수 응답을 잃어도 같은 키는 바뀐 기본 cwd를 적용하거나 중복 실행하지 않는다", async ({ page }) => {
    const { root, project, session, save } = await setup(page);
    await save("work");
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
    await page.reload();
    await page.locator(".recent").getByRole("button", { name: new RegExp(project.name) }).click();
    const panel = sessionView(page, session.id).getByTestId("tasks-panel");
    await openDetails(panel);
    await expect(panel).toContainText("접수 때 고정한 실제 cwd");
    const keys: string[] = [];
    await page.route(`**/api/v1/sessions/${session.id}/tasks`, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        keys.push(route.request().headers()["idempotency-key"] ?? "");
        if (keys.length !== 1) return route.fallback();
        const accepted = await route.fetch();
        expect(accepted.status()).toBe(201);
        await apiCall("PUT", `/settings/project/${project.id}/exec.default_cwd`, { expected_revision: 1, value: "next" });
        await route.abort("connectionreset");
    });
    await panel.getByLabel("백그라운드 명령").fill("pwd -P; printf once >> counter");
    await panel.getByRole("button", { name: "실행", exact: true }).click();
    const retry = panel.getByRole("button", { name: "같은 요청 결과 확인", exact: true });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(retry).toHaveCount(0);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    const list = await apiCall<{ tasks: Task[] }>("GET", `/sessions/${session.id}/tasks`);
    expect(list.tasks).toHaveLength(1);
    const ended = await apiCall<Task>("GET", `/tasks/${list.tasks[0]!.id}/wait?timeout_ms=10000`);
    expect(ended.status).toBe("completed");
    expect(ended.cwd).toBe("work");
    expect(ended.stdout_tail).toBe(`${join(root, "work")}\n`);
    expect(readFileSync(join(root, "work/counter"), "utf8")).toBe("once");
    await expect(panel.getByTestId("task-cwd")).toHaveText("실행 위치: work");
});
