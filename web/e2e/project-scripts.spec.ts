import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProjects, login, openDetails } from "./helpers";
import type { ProjectScript } from "../app/state/projectScripts";

async function setup(page: Page) {
    const { a, b } = await ensureProjects();
    const project = await apiCall<{ root_path: string }>("GET", `/projects/${a.id}`);
    const other = await apiCall<{ root_path: string }>("GET", `/projects/${b.id}`);
    const name = `script-${randomUUID()}`;
    const counter = `${name}.counter`;
    const command = `printf '%s\\n' "$PWD"; printf x >> '${counter}'`;
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: a.name, exact: true }).click();
    const panel = page.getByTestId("project-scripts");
    await openDetails(panel);
    return { a, name, counter, command, root: project.root_path, other: other.root_path, panel };
}
async function add(page: Page, panel: import("@playwright/test").Locator, name: string, command: string) {
    await panel.getByRole("button", { name: "script 추가", exact: true }).click();
    await panel.getByLabel("script 이름", { exact: true }).fill(name);
    await panel.getByLabel("script 명령", { exact: true }).fill(command);
    await panel.getByRole("button", { name: "script 저장", exact: true }).click();
    const row = panel.getByTestId("script-row").filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await expect(panel.getByLabel("script 이름", { exact: true })).toHaveCount(0);
    return row;
}

test("script 저장·확인 취소는 실행하지 않고 확인 후 원래 프로젝트의 작업·로그로 연결된다", async ({ page }) => {
    const f = await setup(page);
    let row = await add(page, f.panel, f.name, f.command);
    expect(existsSync(join(f.root, f.counter))).toBe(false);
    await page.reload();
    await openDetails(f.panel);
    row = f.panel.getByTestId("script-row").filter({ hasText: f.name });
    await row.getByRole("button", { name: "실행 확인", exact: true }).click();
    const review = page.getByRole("dialog", { name: "script 실행 확인", exact: true });
    await expect(review).toContainText(f.root);
    await expect(review).toContainText(f.command);
    await expect(review).toContainText("셸:");
    await review.getByRole("button", { name: "취소", exact: true }).click();
    expect(existsSync(join(f.root, f.counter))).toBe(false);
    await row.getByRole("button", { name: "실행 확인", exact: true }).click();
    await review.getByRole("button", { name: "이 명령 실행", exact: true }).click();
    const tasks = page.getByTestId("session-view").getByTestId("tasks-panel");
    await openDetails(tasks);
    const task = tasks.getByTestId("task-row");
    await expect(task).toHaveAttribute("data-status", "completed");
    await expect(task).toContainText(`script · ${f.name} · r1`);
    await task.getByRole("button", { name: "출력", exact: true }).click();
    await expect(task.getByTestId("task-output")).toContainText(f.root);
    expect(readFileSync(join(f.root, f.counter), "utf8")).toBe("x");
    expect(existsSync(join(f.other, f.counter))).toBe(false);
    await page.reload();
    await openDetails(tasks);
    await expect(tasks.getByTestId("task-row")).toContainText(`script · ${f.name} · r1`);
});

// PROJECT-010: 초기 설정 script 지정은 실행하지 않고, 확인 뒤 실행·실패·재시도를 위치별 상태로 보인다.
test("초기 설정 script를 지정하고 실패한 설정을 다시 실행해 성공 상태와 시도 횟수를 본다", async ({ page }) => {
    const f = await setup(page);
    const marker = `${f.name}.ok`;
    const row = await add(page, f.panel, f.name, `test -f '${marker}' || { touch '${marker}'; exit 3; }`);
    try {
        await row.getByRole("button", { name: "초기 설정으로 지정", exact: true }).click();
        const group = f.panel.getByTestId("project-setup");
        await expect(group).toContainText(f.name);
        const target = group.getByTestId("setup-target").first();
        await expect(target).toHaveAttribute("data-status", "not_run");
        expect(existsSync(join(f.root, marker))).toBe(false);
        await target.getByRole("button", { name: "실행 확인", exact: true }).click();
        const review = page.getByRole("dialog", { name: "script 실행 확인", exact: true });
        await expect(review).toContainText("초기 설정 실행 확인");
        await expect(review).toContainText("프로젝트 폴더");
        // 실행하면 그 위치의 작업 대화가 열린다. 프로젝트로 돌아와 상태를 본다.
        const back = async () => {
            await expect(page.getByTestId("session-view")).toBeVisible();
            await page.getByTestId("project-row").getByRole("button", { name: f.a.name, exact: true }).click();
            await openDetails(f.panel);
        };
        await review.getByRole("button", { name: "이 명령 실행", exact: true }).click();
        await back();
        await expect(target).toHaveAttribute("data-status", "failed");
        await expect(target).toContainText("종료 코드 3");
        await expect(target).toContainText("시도 1회");
        await target.getByRole("button", { name: "다시 실행 확인", exact: true }).click();
        await review.getByRole("button", { name: "이 명령 실행", exact: true }).click();
        await back();
        await expect(target).toHaveAttribute("data-status", "completed");
        await expect(target).toContainText("시도 2회");
        await row.getByRole("button", { name: "초기 설정 지정 해제", exact: true }).click();
        await expect(group).toContainText("지정 안 함");
    } finally {
        const p = await apiCall<{ revision: number; setup_script_id: string | null }>("GET", `/projects/${f.a.id}`);
        if (p.setup_script_id) await apiCall("PATCH", `/projects/${f.a.id}`, { expected_revision: p.revision, setup_script_id: null });
    }
});

for (const phase of ["session", "task"] as const) test(`${phase} 응답 유실 뒤 새로고침해도 원래 키를 확인해 script를 한 번만 실행한다`, async ({ page }) => {
    const f = await setup(page);
    const row = await add(page, f.panel, f.name, f.command);
    const scripts = await apiCall<{ scripts: ProjectScript[] }>("GET", `/projects/${f.a.id}/scripts`);
    const script = scripts.scripts.find((script) => script.name === f.name)!;
    const attempts: { key: string; body: unknown }[] = [];
    const pattern = phase === "session" ? `**/api/v1/projects/${f.a.id}/sessions` : `**/api/v1/sessions/*/scripts/${script.id}/run`;
    await page.route(pattern, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        attempts.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() });
        if (attempts.length === 1) { await route.fetch(); await route.abort("failed"); }
        else await route.continue();
    });
    await row.getByRole("button", { name: "실행 확인", exact: true }).click();
    await page.getByRole("dialog", { name: "script 실행 확인", exact: true }).getByRole("button", { name: "이 명령 실행", exact: true }).click();
    await expect(f.panel.getByTestId("script-run-pending")).toHaveCount(1);
    await expect(f.panel.getByRole("button", { name: "원래 실행 요청 결과 확인", exact: true })).toBeEnabled();
    await page.reload();
    await openDetails(f.panel);
    await expect(f.panel.getByTestId("script-run-pending")).toHaveCount(1);
    expect(attempts).toHaveLength(1);
    await f.panel.getByRole("button", { name: "원래 실행 요청 결과 확인", exact: true }).click();
    const tasks = page.getByTestId("session-view").getByTestId("tasks-panel");
    await openDetails(tasks);
    await expect(tasks.getByTestId("task-row")).toHaveCount(1);
    await expect(tasks.getByTestId("task-row")).toHaveAttribute("data-status", "completed");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(readFileSync(join(f.root, f.counter), "utf8")).toBe("x");
    expect(await page.evaluate((project) => Object.keys(localStorage).filter((key) => key.startsWith(`grove.script.run.${project}.`)), f.a.id)).toEqual([]);
});

test("확인 중 정의가 바뀌면 보던 명령을 유지하고 실행을 거절한 뒤 새로 확인한다", async ({ page }) => {
    const f = await setup(page);
    const row = await add(page, f.panel, f.name, f.command);
    const scripts = await apiCall<{ scripts: ProjectScript[] }>("GET", `/projects/${f.a.id}/scripts`);
    const script = scripts.scripts.find((script) => script.name === f.name)!;
    await row.getByRole("button", { name: "실행 확인", exact: true }).click();
    const review = page.getByRole("dialog", { name: "script 실행 확인", exact: true });
    const changed = `printf y >> '${f.counter}'`;
    await apiCall("PUT", `/projects/${f.a.id}/scripts/${script.id}`, { expected_revision: 1, name: f.name, command: changed });
    await expect(review).toContainText(f.command);
    await expect(review).not.toContainText(changed);
    await review.getByRole("button", { name: "이 명령 실행", exact: true }).click();
    await expect(f.panel.getByRole("alert")).toContainText("다시 확인");
    expect(existsSync(join(f.root, f.counter))).toBe(false);
    await expect(row).toContainText("revision 2");
    await row.getByRole("button", { name: "실행 확인", exact: true }).click();
    await expect(review).toContainText(changed);
    await review.getByRole("button", { name: "이 명령 실행", exact: true }).click();
    const tasks = page.getByTestId("session-view").getByTestId("tasks-panel");
    await openDetails(tasks);
    await expect(tasks.getByTestId("task-row")).toHaveAttribute("data-status", "completed");
    expect(readFileSync(join(f.root, f.counter), "utf8")).toBe("y");
});

test("동시 script 편집 충돌은 내 입력을 남기고 최신 값으로 명시적으로 돌아간다", async ({ page }) => {
    const f = await setup(page);
    const row = await add(page, f.panel, f.name, f.command);
    const scripts = await apiCall<{ scripts: ProjectScript[] }>("GET", `/projects/${f.a.id}/scripts`);
    const script = scripts.scripts.find((script) => script.name === f.name)!;
    await row.getByRole("button", { name: "편집", exact: true }).click();
    await f.panel.getByLabel("script 명령", { exact: true }).fill("my unsaved command");
    await apiCall("PUT", `/projects/${f.a.id}/scripts/${script.id}`, { expected_revision: 1, name: f.name, command: "remote command" });
    await f.panel.getByRole("button", { name: "script 저장", exact: true }).click();
    await expect(f.panel.getByRole("alert")).toBeVisible();
    await expect(f.panel.getByLabel("script 명령", { exact: true })).toHaveValue("my unsaved command");
    await f.panel.getByRole("button", { name: "최신 값으로 편집", exact: true }).click();
    await expect(f.panel.getByLabel("script 명령", { exact: true })).toHaveValue("remote command");
    expect(existsSync(join(f.root, f.counter))).toBe(false);
});
