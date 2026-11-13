import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, openDetails, state } from "./helpers";
import type { GitContext, GitContextState } from "../app/api/gitContext";
import { contextLabel } from "../app/components/git-context/model";

async function repository(name: string) {
    const root = mkdtempSync(join(dirname(state().projA), `git-context-${name}-`));
    const run = (...args: string[]) => execFileSync("git", args, {
        cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
    run("init", "-q", "-b", "main");
    run("config", "user.name", "Fixture");
    run("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(root, "file.txt"), "base\n");
    run("add", "file.txt");
    run("commit", "-qm", "base");
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    return { root, run, project };
}

async function select(page: Page, project: { name: string }) {
    await page.locator(".sidebar .projects").getByRole("button", { name: project.name, exact: true }).click();
    await openDetails(page.locator(".git-wrap"));
    await expect(page.getByTestId("git-context")).toContainText("Git 위치");
}

test("실제 Git 위치·권한·detached·dirty를 조회하고 index와 입력·미확정 요청을 보존한다", async ({ page }) => {
    const { root, run, project } = await repository("actual");
    const before = readFileSync(join(root, ".git/index"));
    await apiCall("PUT", `/settings/project/${project.id}/tools.mode`, { expected_revision: 0, value: "read_only" });
    await login(page);
    await select(page, project);
    const overview = page.getByTestId("git-context");
    const panel = page.getByTestId("git-panel");
    await expect(overview).toContainText(run("rev-parse", "HEAD"));
    await expect(overview).toContainText("주 worktree");
    await expect(overview).toContainText("origin 없음");
    await expect(overview).toContainText("모델 도구 정책: read_only");
    await expect(overview).toContainText("직접 Git API는 인증된 기기에 열려 있습니다");
    await expect(overview.locator("tr").filter({ has: page.getByRole("cell", { name: "commit", exact: true }) })).toContainText("stage된 변경이 없습니다");
    expect(readFileSync(join(root, ".git/index"))).toEqual(before);
    expect(await overview.innerText()).not.toContain(root);
    await panel.getByLabel("커밋 메시지").fill("보존할 커밋 초안");
    await panel.getByLabel("stash 메시지").fill("보존할 stash 초안");
    run("switch", "--detach", "-q");
    await panel.getByRole("button", { name: "새로고침", exact: true }).click();
    await expect(overview).toContainText("detached HEAD");
    await expect(overview.locator("tr").filter({ has: page.getByRole("cell", { name: "push", exact: true }) })).toContainText("현재 브랜치가 없습니다");
    writeFileSync(join(root, "file.txt"), "pending edit\n");
    await panel.getByRole("button", { name: "새로고침", exact: true }).click();
    await expect(panel).toContainText("작업 트리 변경 (1)");
    let lose = true;
    const requests: { key: string; body: unknown }[] = [];
    await page.route(`**/projects/${project.id}/git/stage`, async (route) => {
        requests.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() });
        if (lose) { await route.fetch(); return route.abort("connectionreset"); }
        return route.fallback();
    });
    await panel.getByRole("button", { name: "올리기", exact: true }).click();
    await expect(panel.getByTestId("git-unsure")).toBeVisible();
    await overview.getByRole("button", { name: "개요 다시 확인" }).click();
    await expect(overview).toContainText("메시지·fingerprint");
    await expect(panel.getByTestId("git-unsure")).toBeVisible();
    await expect(panel.getByLabel("커밋 메시지")).toHaveValue("보존할 커밋 초안");
    await expect(panel.getByLabel("stash 메시지")).toHaveValue("보존할 stash 초안");
    lose = false;
    const replay = page.waitForResponse((response) => response.url().endsWith(`/projects/${project.id}/git/stage`) && response.request().method() === "POST");
    await panel.getByRole("button", { name: "같은 Git 요청 확인", exact: true }).click();
    expect((await replay).headers()["idempotent-replayed"]).toBe("true");
    await expect(panel.getByTestId("git-unsure")).toHaveCount(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(run("show", ":file.txt")).toBe("pending edit");
});

test("GitHub 표시 fixture는 오류·없음·stale을 성공과 구분하고 다른 HEAD 결과를 숨긴다", async ({ page }) => {
    const { project } = await repository("github-display");
    let status: GitContextState = "ok";
    let mismatch = false;
    // GitHub 표시 계약만 대체한다. 로컬 위치·권한은 실제 API, gh argv/HEAD 검증은 Rust 격리 fixture가 담당한다.
    await page.route(`**/projects/${project.id}/git/context`, async (route) => {
        const response = await route.fetch();
        const data = await response.json() as GitContext;
        data.github = {
            repository: "fixture/repository", remote: "origin", head: mismatch ? "0".repeat(40) : data.location!.head,
            pr: { status, items: [{ number: 42, state: "open", draft: false }] },
            ci: { status: status === "ok" ? "success" : status, count: 2 },
        };
        await route.fulfill({ response, json: data });
    });
    await login(page);
    await select(page, project);
    const overview = page.getByTestId("git-context");
    await expect(overview).toContainText("#42 open");
    await expect(overview).toContainText("CI: 성공");
    for (const next of ["none", "unsupported", "missing", "unauthenticated", "denied", "timeout", "unknown", "stale"] as const) {
        status = next;
        await overview.getByRole("button", { name: "개요 다시 확인" }).click();
        await expect(overview).toContainText(`PR: ${contextLabel[next]}`);
        await expect(overview).not.toContainText("#42");
        await expect(overview).not.toContainText("CI: 성공");
    }
    status = "ok";
    mismatch = true;
    await overview.getByRole("button", { name: "개요 다시 확인" }).click();
    await expect(overview).toContainText(`PR: ${contextLabel.stale}`);
    await expect(overview).not.toContainText("#42");
    await expect(overview).not.toContainText("CI: 성공");
});

test("늦은 응답은 새 조회와 다른 프로젝트를 덮지 않고 재접속은 최신 HEAD를 다시 읽는다", async ({ page, context }) => {
    const a = await repository("late-a");
    const b = await repository("late-b");
    let hold = false;
    let release = () => {};
    let started = () => {};
    let requestStarted = Promise.resolve();
    let responseDone = Promise.resolve();
    const arm = () => {
        hold = true;
        requestStarted = new Promise<void>((resolve) => { started = resolve; });
        responseDone = new Promise<void>((resolve) => {
            release = resolve;
        });
    };
    await page.route(`**/projects/${a.project.id}/git/context`, async (route) => {
        const response = await route.fetch();
        const data = await response.json() as GitContext;
        if (hold) {
            hold = false;
            started();
            await responseDone;
            data.github = {
                repository: "fixture/repository", remote: "origin", head: data.location!.head,
                pr: { status: "ok", items: [{ number: 999, state: "open", draft: false }] }, ci: { status: "failure", count: 1 },
            };
        }
        await route.fulfill({ response, json: data });
    });
    await login(page);
    await select(page, a.project);
    const overview = page.getByTestId("git-context");
    await expect(overview).toContainText(a.run("rev-parse", "HEAD"));
    arm();
    await overview.getByRole("button", { name: "개요 다시 확인" }).click();
    await requestStarted;
    await overview.getByRole("button", { name: "개요 다시 확인" }).click();
    await expect(overview).toContainText("origin 없음");
    const late = page.waitForResponse((response) => response.url().endsWith(`/projects/${a.project.id}/git/context`));
    release();
    await late;
    await expect(overview).not.toContainText("#999");
    arm();
    await overview.getByRole("button", { name: "개요 다시 확인" }).click();
    await requestStarted;
    await select(page, b.project);
    await expect(overview).toContainText(`프로젝트 ${b.project.id}`);
    const oldProject = page.waitForResponse((response) => response.url().endsWith(`/projects/${a.project.id}/git/context`));
    release();
    await oldProject;
    await expect(overview).toContainText(`프로젝트 ${b.project.id}`);
    await expect(overview).not.toContainText("#999");
    await context.setOffline(true);
    await expect(overview).toContainText("오프라인");
    await expect(overview).not.toContainText("HEAD");
    b.run("commit", "--allow-empty", "-qm", "while offline");
    const newHead = b.run("rev-parse", "HEAD");
    await context.setOffline(false);
    await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
    await expect(overview).toContainText(newHead);
    await expect(overview).toContainText("origin 없음");
    await expect(overview).not.toContainText("#999");
});
