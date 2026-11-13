import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, openDetails, state } from "./helpers";

/// 다른 시험과 저장소를 공유하지 않도록 새 프로젝트 폴더에 저장소를 만든다(모드는 기본값 그대로).
async function freshRepo(tag: string) {
    const root = join(dirname(state().projA), `mode-${tag}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    run("init", "-q", "-b", "main");
    run("config", "user.email", "e2e@example.invalid");
    run("config", "user.name", "E2E");
    writeFileSync(join(root, "a.txt"), "one\n");
    run("add", "a.txt");
    run("commit", "-q", "-m", "init");
    const p = await apiCall<{ id: string; name: string; workspace_mode: string }>("POST", "/projects", { root_path: root });
    return { root, run, p };
}

test("단일 모드는 워크스페이스를 만들지 않고, 프로젝트 모드는 워크스페이스별로 대화를 나누며, 남은 워크스페이스가 있으면 단일로 못 돌아간다", async ({ page }) => {
    const { run, p } = await freshRepo("ui");
    expect(p.workspace_mode).toBe("single");
    await login(page);
    await page.locator(".sidebar .projects").getByRole("button", { name: new RegExp(p.name) }).first().click();
    const view = page.locator(".project-view").filter({ has: page.locator(".view-head", { hasText: p.name }) });
    const panel = view.getByTestId("worktrees-panel");
    await openDetails(panel);

    // 단일 모드: 모드 전환만 보이고 워크스페이스를 만들 입력이 없다. 새 대화의 워크스페이스 선택도 없다.
    await expect(panel.getByTestId("workspace-mode")).toHaveAttribute("data-mode", "single");
    await expect(panel.getByLabel("worktree 이름")).toHaveCount(0);
    await expect(view.getByLabel("새 대화 워크스페이스")).toHaveCount(0);

    // 프로젝트 모드로 바꾸고 화면에서 워크스페이스를 만든다.
    await panel.getByRole("button", { name: "프로젝트 모드로 전환" }).click();
    await expect(panel.getByTestId("workspace-mode")).toHaveAttribute("data-mode", "project");
    await panel.getByLabel("worktree 이름").fill("feat");
    await panel.getByRole("button", { name: "만들기" }).click();
    await expect(panel.getByTestId("worktree-row")).toHaveCount(1);
    const { worktrees } = await apiCall<{ worktrees: { id: string; name: string }[] }>("GET", `/projects/${p.id}/worktrees`);
    const wt = worktrees[0]!;

    // 워크스페이스가 남아 있으면 단일 모드로 못 돌아가고 남은 수를 보여 준다. 모드·worktree는 그대로다.
    await panel.getByRole("button", { name: "단일 모드로 전환" }).click();
    await expect(panel.getByRole("alert")).toContainText("워크스페이스 1개");
    await expect(panel.getByTestId("workspace-mode")).toHaveAttribute("data-mode", "project");
    expect(run("worktree", "list").trim().split("\n")).toHaveLength(2);

    // 새 대화를 워크스페이스에서 시작하면 그 워크스페이스에 연결된다(보내면 대화 화면으로 바뀐다).
    await view.getByLabel("새 대화 워크스페이스").selectOption(wt.id);
    await view.getByLabel("메시지 입력").fill("워크스페이스 대화");
    await view.getByLabel("보내기 방식").selectOption("save");
    await view.getByLabel("메시지 입력").press("Control+Enter");
    await expect.poll(async () => (await apiCall<{ items: { title: string; worktree_id: string | null }[] }>("GET", `/projects/${p.id}/sessions?limit=30`))
        .items.find((s) => s.title === "워크스페이스 대화")?.worktree_id).toBe(wt.id);

    // 사이드바: 프로젝트 → 워크스페이스 → 대화
    const project = page.locator(`[data-testid="sidebar-project"][data-project-id="${p.id}"]`);
    await expect(project.getByTestId("sidebar-workspace")).toHaveCount(2);
    const feat = project.locator(`[data-testid="sidebar-workspace"][data-worktree="${wt.id}"]`);
    await expect(feat).toContainText("feat");
    await expect(feat.getByTestId("sidebar-session")).toContainText("워크스페이스 대화");
    await expect(project.locator('[data-testid="sidebar-workspace"][data-worktree=""]')).toContainText("프로젝트 폴더");
});
