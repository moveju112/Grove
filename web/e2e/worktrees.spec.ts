import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, openDetails, sessionView, state } from "./helpers";

/// 다른 시험과 저장소를 공유하지 않도록 새 프로젝트 폴더에 저장소를 만든다.
async function freshRepo(tag: string) {
    const root = join(dirname(state().projA), `wt-${tag}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    run("init", "-q", "-b", "main");
    run("config", "user.email", "e2e@example.invalid");
    run("config", "user.name", "E2E");
    writeFileSync(join(root, "a.txt"), "one\n");
    run("add", "a.txt");
    run("commit", "-q", "-m", "init");
    const p = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    return { root, run, p };
}

test("서버가 worktree 기능을 알리지 않으면 화면에서 숨긴다(기능 협상)", async ({ page }) => {
    const { p } = await freshRepo("cap");
    // 오래된 서버를 흉내 낸다: 이벤트 hello의 기능 목록에서 worktrees_v1을 뺀다.
    await page.route("**/api/v1/events**", (route) =>
        route.fulfill({
            status: 200,
            headers: { "content-type": "text/event-stream", "x-grove-protocol": "1" },
            body: `event: hello\ndata: ${JSON.stringify({ cursor: 0, protocol: 1, capabilities: ["trash_v1"] })}\n\n`,
        }),
    );
    // 가짜 stream은 hello 뒤 바로 끝나므로 연결 상태 대신 화면이 열리는지로 로그인 완료를 본다.
    await page.goto("/");
    await page.locator("html[data-hydrated=true]").waitFor({ state: "attached" });
    await page.getByLabel("토큰").fill(state().token);
    await page.getByRole("button", { name: "로그인" }).click();
    await page.locator(".sidebar .projects").getByRole("button", { name: new RegExp(p.name) }).first().click();
    await expect(page.getByTestId("trash-panel")).toBeVisible();
    await expect(page.getByTestId("worktrees-panel")).toHaveCount(0);
});

test("worktree를 변경 처리 선택 후 만들고, 대화를 그 위치에서 실행·복귀하고, 제거한다", async ({ page }) => {
    const { root, run, p } = await freshRepo("ui");
    writeFileSync(join(root, "a.txt"), "one\nwip\n");
    await login(page);
    await page.locator(".sidebar .projects").getByRole("button", { name: new RegExp(p.name) }).first().click();
    const panel = page.getByTestId("worktrees-panel");
    await openDetails(panel);
    await panel.getByLabel("worktree 이름").fill("feat");
    await panel.getByRole("button", { name: "만들기" }).click();
    // 커밋하지 않은 변경이 있으면 두고 갈지·복사해 갈지 묻는다(GIT-009).
    const choice = panel.getByRole("group", { name: "커밋하지 않은 변경 처리" });
    await expect(choice).toContainText("1개");
    await choice.getByRole("button", { name: "복사해 가기" }).click();
    const row = panel.getByTestId("worktree-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("grove/feat");
    await expect(row).toContainText("변경 1개");
    const list = await apiCall<{ worktrees: { id: string; path: string }[] }>("GET", `/projects/${p.id}/worktrees`);
    const wt = list.worktrees[0]!;
    expect(readFileSync(join(wt.path, "a.txt"), "utf8")).toBe("one\nwip\n");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\nwip\n");

    // 대화를 worktree로 옮기고 백그라운드 작업이 그 경로에서 실행되는지 확인한다(GIT-008).
    const sess = await apiCall<{ id: string }>("POST", `/projects/${p.id}/sessions`, { title: "wt 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: p.id, resource_id: sess.id });
    await page.locator(".recent").getByRole("button", { name: /wt 대화/ }).first().click();
    const view = sessionView(page, sess.id);
    const where = view.getByLabel("작업 위치");
    await expect(where).toHaveValue("");
    await where.selectOption(wt.id);
    await expect(where).toHaveValue(wt.id);
    const tasks = view.getByTestId("tasks-panel");
    await openDetails(tasks);
    await tasks.getByLabel("백그라운드 명령").fill("touch made-here.txt");
    await tasks.getByRole("button", { name: "실행", exact: true }).click();
    await expect(tasks.getByTestId("task-row").first()).toHaveAttribute("data-status", "completed");
    expect(existsSync(join(wt.path, "made-here.txt"))).toBe(true);
    expect(existsSync(join(root, "made-here.txt"))).toBe(false);

    // 대화가 들어가 있는 동안 제거 버튼은 막혀 있다. 복귀하면 제거할 수 있다(GIT-010).
    await page.locator(".sidebar .projects").getByRole("button", { name: new RegExp(p.name) }).first().click();
    await openDetails(panel);
    await expect(row).toContainText("대화 1개");
    await expect(row.getByRole("button", { name: "제거" })).toBeDisabled();
    await page.locator(".recent").getByRole("button", { name: /wt 대화/ }).first().click();
    await where.selectOption("");
    await expect(where).toHaveValue("");
    await page.locator(".sidebar .projects").getByRole("button", { name: new RegExp(p.name) }).first().click();
    await openDetails(panel);
    await expect(row.getByRole("button", { name: "제거" })).toBeEnabled();
    // 변경이 있는 worktree는 서버가 센 변경 개수로 다시 확인받은 뒤에만 강제 제거한다.
    const asked: string[] = [];
    const answer = (accept: boolean[]) => {
        let i = 0;
        const h = (d: import("@playwright/test").Dialog) => {
            asked.push(d.message());
            void (accept[i++] ? d.accept() : d.dismiss());
            if (i >= accept.length) page.off("dialog", h);
        };
        page.on("dialog", h);
    };
    answer([true, false]);
    await row.getByRole("button", { name: "제거" }).click();
    await expect.poll(() => asked.length).toBe(2);
    expect(asked[1]).toContain("변경 2개가 사라집니다");
    await expect(row.getByRole("button", { name: "제거" })).toBeEnabled();
    expect(existsSync(wt.path)).toBe(true);
    answer([true, true]);
    await row.getByRole("button", { name: "제거" }).click();
    await expect(panel.getByTestId("worktree-row")).toHaveCount(0);
    expect(existsSync(wt.path)).toBe(false);
    expect(run("branch", "--list", "grove/feat")).toContain("grove/feat");
});
