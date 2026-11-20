import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProfile, login, openDetails, openProjectSettings, requireToolApproval, script, sessionView, state } from "./helpers";
import { frames } from "./fixture";

async function setup(page: Page) {
    const root = mkdtempSync(join(state().projA, "exec-cwd-"));
    for (const dir of ["work", "next"]) mkdirSync(join(root, dir));
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    await requireToolApproval(project.id);
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: project.name });
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
    return { root, project, session };
}

type Call = {
    id: string;
    revision: number;
    target: { cwd: string };
    result: { stdout?: string; stdout_tail?: string; background?: boolean; task_id?: string };
};
type Turn = { status: string; step: number; tool_calls: Call[] };
type Task = { id: string; cwd: string; status: string; stdout_tail: string };

test("기본 작업 위치 설정은 없고 cwd를 생략한 모델 셸은 실행 root, 명시한 cwd는 그 위치에서 실행한다", async ({ page }) => {
    const { root, session } = await setup(page);
    await openProjectSettings(page);
    await page.getByLabel("설정 검색", { exact: true }).fill("명령 실행");
    await expect(page.getByTestId("exec-settings").getByTestId("setting-exec.shell")).toBeVisible();
    await expect(page.getByTestId("settings").getByTestId("setting-exec.default_cwd")).toHaveCount(0);
    const profile = await ensureProfile();
    for (const background of [false, true]) {
        for (const explicit of [false, true]) {
            const release = `release-${explicit}`;
            await script({ frames: frames.tool("cwd", "shell", {
                command: background ? `while [ ! -f '${release}' ]; do sleep 0.02; done; pwd -P` : "pwd -P",
                ...(background ? { background: true, timeout_ms: 10000 } : {}),
                ...(explicit ? { cwd: "work" } : {}),
            }) });
            await script({ frames: frames.text(["끝"]) });
            const { turn } = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`,
                { text: "run", profile_id: profile, tools: true });
            await expect.poll(async () => (await apiCall<Turn>("GET", `/turns/${turn.id}`)).status).toBe("awaiting_approval");
            const pending = (await apiCall<Turn>("GET", `/turns/${turn.id}`)).tool_calls[0]!;
            expect(pending.target.cwd).toBe(explicit ? "work" : ".");
            await apiCall("POST", `/tool-calls/${pending.id}/decision`, { decision: "approve", expected_revision: pending.revision });
            if (background) {
                // 작업 결과를 보지 못한 첫 final은 보류된다. 그 경계를 확인한 뒤 완료 응답과 해제 표식을 준다.
                await expect.poll(() => apiCall<Turn>("GET", `/turns/${turn.id}`)).toMatchObject({ status: "running", step: 2 });
                await script({ frames: frames.text(["작업 결과 확인"]) });
                writeFileSync(join(root, explicit ? "work" : ".", release), "release");
            }
            await expect.poll(() => apiCall<Turn>("GET", `/turns/${turn.id}`)).toMatchObject({ status: "completed" });
            const done = (await apiCall<Turn>("GET", `/turns/${turn.id}`)).tool_calls[0]!;
            expect(done.target).toEqual(pending.target);
            const result = done.result.background
                ? await apiCall<Task>("GET", `/tasks/${done.result.task_id}/wait?timeout_ms=10000`)
                : done.result;
            expect("stdout" in result ? result.stdout : result.stdout_tail).toBe(`${explicit ? join(root, "work") : root}\n`);
        }
    }
});

test("작업 접수 응답을 잃어도 같은 키는 중복 실행하지 않고 실행 root를 유지한다", async ({ page }) => {
    const { root, project, session } = await setup(page);
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
    await page.reload();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(project.name) }).click();
    const panel = sessionView(page, session.id).getByTestId("tasks-panel");
    await openDetails(panel, "작업");
    const keys: string[] = [];
    await page.route(`**/api/v1/sessions/${session.id}/tasks`, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        keys.push(route.request().headers()["idempotency-key"] ?? "");
        if (keys.length !== 1) return route.fallback();
        const accepted = await route.fetch();
        expect(accepted.status()).toBe(201);
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
    expect(ended.cwd).toBe(".");
    expect(ended.stdout_tail).toBe(`${root}\n`);
    expect(readFileSync(join(root, "counter"), "utf8")).toBe("once");
});
