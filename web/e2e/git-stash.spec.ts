import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, state } from "./helpers";

async function openGit(page: Page) {
    const root = mkdtempSync(join(dirname(state().projA), "git-stash-"));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    run("init", "-q", "-b", "main");
    run("config", "user.email", "e2e@example.invalid");
    run("config", "user.name", "E2E");
    writeFileSync(join(root, "a.txt"), "base\n");
    run("add", "a.txt");
    run("commit", "-qm", "base");
    writeFileSync(join(root, "a.txt"), "saved edit\n");
    writeFileSync(join(root, "untracked.txt"), "keep\n");
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    await login(page);
    await page.locator(".sidebar .projects").getByRole("button", { name: project.name, exact: true }).click();
    await page.locator(".git-wrap").locator("summary").first().click();
    const panel = page.getByTestId("git-panel");
    await expect(panel).toContainText("작업 트리 변경 (2)");
    return { root, run, project, panel };
}

test("stash 저장·목록·명시적 pop, untracked 보존", async ({ page }) => {
    const { root, run, panel } = await openGit(page);
    await panel.getByLabel("stash 메시지").fill("화면에서 보관");
    await panel.getByRole("button", { name: "stash 저장", exact: true }).click();
    await expect(panel.getByRole("button", { name: "stash pop", exact: true })).toBeVisible();
    await expect(panel).toContainText("화면에서 보관");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("base\n");
    await panel.getByRole("button", { name: "stash pop", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "stash pop 확인" });
    await expect(dialog).toContainText("a.txt");
    await expect(dialog).toContainText(run("rev-parse", "stash@{0}").trim());
    await dialog.getByRole("button", { name: "확인하고 stash pop", exact: true }).click();
    await expect(panel.getByRole("button", { name: "stash pop", exact: true })).toHaveCount(0);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("saved edit\n");
    expect(readFileSync(join(root, "untracked.txt"), "utf8")).toBe("keep\n");
    expect(run("stash", "list")).toBe("");
});

test("discard는 취소·stale 거부 후 새 확인으로만 실행한다", async ({ page }) => {
    const { root, panel } = await openGit(page);
    await expect(panel.getByRole("button", { name: "변경 버리기", exact: true })).toHaveCount(1);
    await panel.getByRole("button", { name: "변경 버리기", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "파일 변경 버리기 확인" });
    await expect(dialog).toContainText("a.txt");
    await expect(dialog).toContainText("1 file changed");
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("saved edit\n");
    await panel.getByRole("button", { name: "변경 버리기", exact: true }).click();
    await expect(dialog).toBeVisible();
    writeFileSync(join(root, "a.txt"), "later unaccepted\n");
    await dialog.getByRole("button", { name: "확인하고 변경 버리기", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("상태가 바뀌었습니다");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("later unaccepted\n");
    await panel.getByRole("button", { name: "변경 버리기", exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "확인하고 변경 버리기", exact: true }).click();
    await expect(panel).toContainText("작업 트리 변경 (1)");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("base\n");
    expect(readFileSync(join(root, "untracked.txt"), "utf8")).toBe("keep\n");
});

test("pop 충돌은 stash와 실제 충돌 파일을 보존한다", async ({ page }) => {
    const { root, run, panel } = await openGit(page);
    await panel.getByRole("button", { name: "stash 저장", exact: true }).click();
    await expect(panel.getByRole("button", { name: "stash pop", exact: true })).toBeVisible();
    const oid = run("rev-parse", "stash@{0}").trim();
    writeFileSync(join(root, "a.txt"), "diverged\n");
    run("commit", "-qam", "diverge");
    await panel.getByRole("button", { name: "stash pop", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "확인하고 stash pop", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("stash를 보존했습니다");
    expect(run("rev-parse", "stash@{0}").trim()).toBe(oid);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toContain("<<<<<<<");
});

test("pop 확인 이후 stash 목록만 바뀌어도 실행을 거부한다", async ({ page }) => {
    const { root, run, panel } = await openGit(page);
    await panel.getByRole("button", { name: "stash 저장", exact: true }).click();
    await expect(panel.getByRole("button", { name: "stash pop", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "stash pop", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    writeFileSync(join(root, "a.txt"), "second stash\n");
    run("stash", "push", "-m", "second");
    await page.getByRole("dialog").getByRole("button", { name: "확인하고 stash pop", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("상태가 바뀌었습니다");
    expect(run("stash", "list").trim().split("\n")).toHaveLength(2);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("base\n");
});

test("pop 응답 유실의 재확인은 원래 키·대상으로 재생하고 새 편집을 보존한다", async ({ page }) => {
    const { root, run, project, panel } = await openGit(page);
    await panel.getByRole("button", { name: "stash 저장", exact: true }).click();
    await expect(panel.getByRole("button", { name: "stash pop", exact: true })).toBeVisible();
    const requests: { key: string; body: unknown }[] = [];
    let lose = true;
    await page.route(`**/api/v1/projects/${project.id}/git/confirm`, async (route) => {
        requests.push({ key: route.request().headers()["idempotency-key"] ?? "", body: route.request().postDataJSON() });
        if (lose) { await route.fetch(); return route.abort("connectionreset"); }
        return route.fallback();
    });
    await panel.getByRole("button", { name: "stash pop", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "확인하고 stash pop", exact: true }).click();
    await expect(panel.getByTestId("git-unsure")).toBeVisible();
    expect(run("stash", "list")).toBe("");
    writeFileSync(join(root, "a.txt"), "new later edit\n");
    lose = false;
    await panel.getByRole("button", { name: "같은 Git 요청 확인", exact: true }).click();
    await expect(panel.getByTestId("git-unsure")).toHaveCount(0);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.key).toBeTruthy();
    expect(requests[1]).toEqual(requests[0]);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("new later edit\n");
});
