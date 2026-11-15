import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, openDetails, state, useWorkspaces } from "./helpers";

type P = { id: string; name: string; root_path: string; revision: number; archived_at: string | null };

// PROJECT-009: 프로젝트 보관 → 보관됨 목록에서 복원 검사·복원, 제거한 worktree의 복원 검사·복원.
test("프로젝트를 보관했다가 복원하고, 제거한 worktree를 브랜치에서 다시 만든다", async ({ page }) => {
    const root = join(dirname(state().projA), `recov-${Date.now().toString(36)}`);
    const p = await apiCall<P>("POST", "/projects", { root_path: root, create: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: p.root_path });
    git("init", "-q", "-b", "main");
    writeFileSync(join(p.root_path, "a.txt"), "one\n");
    git("add", "a.txt");
    git("-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-q", "-m", "init");
    await useWorkspaces(p.id);
    const wt = await apiCall<{ id: string }>("POST", `/projects/${p.id}/worktrees`, { name: "again" });
    await apiCall("DELETE", `/worktrees/${wt.id}`);
    try {
        await login(page);
        page.on("dialog", (d) => void d.accept());
        const side = page.getByTestId("sidebar").getByTestId("projects");
        const row = side.getByTestId("project-row").filter({ hasText: p.name });

        // 제거한 worktree: 검사 결과를 본 뒤 복원
        await row.getByRole("button", { name: new RegExp(p.name) }).first().click();
        const panel = page.getByTestId("project-view").filter({ has: page.getByRole("heading", { name: p.name, exact: true }) }).getByTestId("worktrees-panel");
        await openDetails(panel, "워크스페이스");
        const removed = panel.getByTestId("worktree-removed").filter({ hasText: "again" });
        await removed.getByRole("button", { name: "복원 검사" }).click();
        await expect(removed).toContainText("브랜치로");
        await removed.getByRole("button", { name: "복원" }).click();
        await expect(panel.getByTestId("worktree-row").filter({ hasText: "again" })).toHaveAttribute("data-status", "active");
        await expect(panel.getByTestId("worktree-removed")).toHaveCount(0);

        // 보관하면 목록에서 빠지고, 보관됨에서 검사 뒤 복원하면 돌아온다
        await row.getByRole("button", { name: "프로젝트 메뉴" }).click();
        await page.getByRole("dialog", { name: `${p.name} 메뉴` }).getByRole("button", { name: "보관" }).click();
        await expect(row).toHaveCount(0);
        await side.getByRole("button", { name: "프로젝트 목록 옵션", exact: true }).click();
        await side.getByRole("button", { name: "보관됨" }).click();
        const archived = side.getByTestId("archived-project").filter({ hasText: p.name });
        await archived.getByRole("button", { name: "복원 검사" }).click();
        await archived.getByRole("button", { name: "복원" }).click();
        await expect(row).toHaveCount(1);
        await expect(archived).toHaveCount(0);
    } finally {
        const cur = await apiCall<P>("GET", `/projects/${p.id}`);
        const list = await apiCall<{ worktrees: { id: string; status: string }[] }>("GET", `/projects/${p.id}/worktrees`);
        for (const w of list.worktrees.filter((x) => x.status === "active")) await apiCall("DELETE", `/worktrees/${w.id}?force=true`);
        if (!cur.archived_at) await apiCall("PATCH", `/projects/${p.id}`, { expected_revision: cur.revision, archived: true });
    }
});
