import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, openDetails, openTool, state, useWorkspaces } from "./helpers";

async function openWorktrees(page: Page) {
    const root = mkdtempSync(join(dirname(state().projA), "worktree-recovery-"));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    run("init", "-q", "-b", "main");
    run("config", "user.email", "fixture@example.invalid");
    run("config", "user.name", "Fixture");
    writeFileSync(join(root, "a.txt"), "base\n");
    run("add", "a.txt");
    run("commit", "-qm", "base");
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    await useWorkspaces(project.id);
    await login(page);
    await page.getByTestId("sidebar").getByTestId("projects").getByRole("button", { name: project.name, exact: true }).click();
    const panel = page.getByTestId("worktrees-panel");
    await openTool(page, "워크스페이스");
    await openDetails(panel);
    return { root, run, project, panel };
}

for (const failure of ["transport", "result_unknown"] as const) {
    test(`worktree 생성 ${failure} 뒤 같은 요청을 확인하고 새 이름 초안과 단일 생성을 보존한다`, async ({ page }) => {
        const { run, project, panel } = await openWorktrees(page);
        const requests: { key: string; body: unknown }[] = [];
        let lose = true;
        await page.route(`**/api/v1/projects/${project.id}/worktrees`, async (route) => {
            if (route.request().method() !== "POST") return route.fallback();
            requests.push({ key: route.request().headers()["idempotency-key"] ?? "", body: route.request().postDataJSON() });
            if (!lose) return route.fallback();
            await route.fetch();
            if (failure === "transport") return route.abort("connectionreset");
            // UI 계약 시험: 실제 생성은 실행하되 최종 결과를 확정할 수 없다는 HTTP 응답을 전달한다.
            return route.fulfill({ status: 409, json: { error: { code: "result_unknown", message: "fixture: 결과 확정 실패", retryable: false } } });
        });
        await panel.getByLabel("worktree 이름").fill("original");
        await panel.locator("form").evaluate((form) => {
            form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
            form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        });
        const recovery = panel.getByRole("group", { name: "worktree 결과 재확인" });
        await expect(recovery).toContainText("grove/original");
        await panel.getByLabel("worktree 이름").fill("next-draft");
        await expect(panel.getByRole("button", { name: "만들기", exact: true })).toBeDisabled();
        expect(requests).toHaveLength(1);
        lose = false;
        const replay = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/projects/${project.id}/worktrees`));
        await recovery.getByRole("button", { name: "같은 요청 결과 확인", exact: true }).click();
        const response = await replay;
        expect(response.status()).toBe(201);
        expect(response.headers()["idempotent-replayed"]).toBe("true");
        await expect(recovery).toHaveCount(0);
        await expect(panel.getByLabel("worktree 이름")).toHaveValue("next-draft");
        await expect(panel.getByTestId("worktree-row")).toHaveCount(1);
        expect(requests).toHaveLength(2);
        expect(requests[0]!.key).toBeTruthy();
        expect(requests[1]).toEqual(requests[0]);
        expect(run("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2);
    });
}

test("제거 응답 유실 뒤 같은 요청은 새로 생긴 폴더를 지우지 않고 원래 결과만 재생한다", async ({ page }) => {
    const { project, panel } = await openWorktrees(page);
    const w = await apiCall<{ id: string; path: string }>("POST", `/projects/${project.id}/worktrees`, { name: "remove" });
    const row = panel.getByTestId("worktree-row");
    await expect(row).toHaveCount(1);
    const keys: string[] = [];
    let lose = true;
    await page.route(`**/api/v1/worktrees/${w.id}`, async (route) => {
        keys.push(route.request().headers()["idempotency-key"] ?? "");
        if (lose) { await route.fetch(); return route.abort("connectionreset"); }
        return route.fallback();
    });
    page.once("dialog", (dialog) => void dialog.accept());
    await row.getByRole("button", { name: "제거", exact: true }).click();
    const recovery = panel.getByRole("group", { name: "worktree 결과 재확인" });
    await expect(recovery).toBeVisible();
    expect(existsSync(w.path)).toBe(false);
    mkdirSync(w.path);
    writeFileSync(join(w.path, "new.txt"), "not owned by the old request\n");
    lose = false;
    const replay = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().endsWith(`/worktrees/${w.id}`));
    await recovery.getByRole("button", { name: "같은 요청 결과 확인", exact: true }).click();
    const response = await replay;
    expect(response.status()).toBe(200);
    expect(response.headers()["idempotent-replayed"]).toBe("true");
    await expect(recovery).toHaveCount(0);
    expect(readFileSync(join(w.path, "new.txt"), "utf8")).toBe("not owned by the old request\n");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
});

test("부분 생성의 소유권과 파일을 보존하고 사용자 검토로 현재 상태를 사용한다", async ({ page }) => {
    const { root, project, panel } = await openWorktrees(page);
    const hook = join(root, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await panel.getByLabel("worktree 이름").fill("partial");
    await panel.getByRole("button", { name: "만들기", exact: true }).click();
    const row = panel.getByTestId("worktree-row");
    await expect(row).toHaveAttribute("data-status", "unknown");
    await expect(row).toContainText("생성 결과 미확정");
    await expect(row.getByRole("button", { name: "merge", exact: true })).toHaveCount(0);
    const list = await apiCall<{ worktrees: { id: string; path: string }[]; unowned: unknown[] }>("GET", `/projects/${project.id}/worktrees`);
    const w = list.worktrees[0]!;
    expect(list.unowned).toEqual([]);
    writeFileSync(join(w.path, "kept.txt"), "reviewed current work\n");
    unlinkSync(hook);
    await expect(apiCall("POST", `/projects/${project.id}/sessions`, { worktree_id: w.id })).rejects.toThrow("410");
    page.once("dialog", (dialog) => void dialog.accept());
    await row.getByRole("button", { name: "확인한 현재 상태 사용", exact: true }).click();
    await expect(row).toHaveAttribute("data-status", "active");
    await expect(row.getByRole("button", { name: "merge", exact: true })).toBeVisible();
    expect(readFileSync(join(w.path, "kept.txt"), "utf8")).toBe("reviewed current work\n");
    const session = await apiCall<{ worktree_id: string }>("POST", `/projects/${project.id}/sessions`, { worktree_id: w.id });
    expect(session.worktree_id).toBe(w.id);
});

test("큰 저장소 확인을 거쳐도 이미 고른 carry 선택과 원래 폴더의 변경을 보존한다", async ({ page }) => {
    const { root, run, project, panel } = await openWorktrees(page);
    const many = join(root, "many");
    mkdirSync(many);
    for (let i = 0; i < 20_001; i++) writeFileSync(join(many, `${i}.txt`), "");
    run("add", "many");
    run("commit", "-qm", "large fixture");
    writeFileSync(join(root, "a.txt"), "carried original work\n");
    const bodies: unknown[] = [];
    await page.route(`**/api/v1/projects/${project.id}/worktrees`, (route) => {
        if (route.request().method() === "POST") bodies.push(route.request().postDataJSON());
        return route.fallback();
    });
    await panel.getByLabel("worktree 이름").fill("large-carry");
    await panel.getByRole("button", { name: "만들기", exact: true }).click();
    await panel.getByRole("group", { name: "커밋하지 않은 변경 처리" }).getByRole("button", { name: "복사해 가기", exact: true }).click();
    const large = panel.getByRole("group", { name: "큰 저장소 확인" });
    await expect(large).toContainText("grove/large-carry");
    await panel.getByLabel("worktree 이름").fill("next-large-draft");
    await large.getByRole("button", { name: "그래도 만들기", exact: true }).click();
    await expect(panel.getByTestId("worktree-row")).toHaveAttribute("data-status", "active");
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toEqual({ name: "large-carry", carry: "carry", confirm_large: true });
    const list = await apiCall<{ worktrees: { path: string }[] }>("GET", `/projects/${project.id}/worktrees`);
    expect(readFileSync(join(list.worktrees[0]!.path, "a.txt"), "utf8")).toBe("carried original work\n");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("carried original work\n");
    await expect(panel.getByLabel("worktree 이름")).toHaveValue("next-large-draft");
});

test("큰 저장소 확인 중 생긴 변경을 leave로 골라도 큰 저장소 승인을 잃지 않는다", async ({ page }) => {
    const { root, run, project, panel } = await openWorktrees(page);
    const many = join(root, "many");
    mkdirSync(many);
    for (let i = 0; i < 20_001; i++) writeFileSync(join(many, `${i}.txt`), "");
    run("add", "many");
    run("commit", "-qm", "large fixture");
    const bodies: unknown[] = [];
    await page.route(`**/api/v1/projects/${project.id}/worktrees`, (route) => {
        if (route.request().method() === "POST") bodies.push(route.request().postDataJSON());
        return route.fallback();
    });
    await panel.getByLabel("worktree 이름").fill("large-leave");
    await panel.getByRole("button", { name: "만들기", exact: true }).click();
    const large = panel.getByRole("group", { name: "큰 저장소 확인" });
    await expect(large).toBeVisible();
    writeFileSync(join(root, "a.txt"), "new original work\n");
    await large.getByRole("button", { name: "그래도 만들기", exact: true }).click();
    await panel.getByRole("group", { name: "커밋하지 않은 변경 처리" }).getByRole("button", { name: "두고 가기(변경 없이 시작)", exact: true }).click();
    await expect(panel.getByTestId("worktree-row")).toHaveAttribute("data-status", "active");
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toEqual({ name: "large-leave", confirm_large: true, carry: "leave" });
    const list = await apiCall<{ worktrees: { path: string }[] }>("GET", `/projects/${project.id}/worktrees`);
    expect(readFileSync(join(list.worktrees[0]!.path, "a.txt"), "utf8")).toBe("base\n");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("new original work\n");
});
