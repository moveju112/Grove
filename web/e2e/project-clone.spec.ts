import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, state } from "./helpers";

type P = { id: string; name: string; root_path: string; revision: number };

// PROJECT-012: 경로 입력 제안과 원격 저장소 clone 뒤 프로젝트 등록.
test("경로 제안으로 폴더를 고르고, 원격 저장소를 clone해 프로젝트로 추가한다", async ({ page }) => {
    const base = join(dirname(state().projA), `clone-${Date.now().toString(36)}`);
    const work = join(base, "work");
    mkdirSync(work, { recursive: true });
    mkdirSync(join(base, "zeta-suggest"));
    const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd });
    run(work, "init", "-q", "-b", "main");
    writeFileSync(join(work, "README"), "cloned\n");
    run(work, "add", "README");
    run(work, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-q", "-m", "init");
    const repoName = `rep${Date.now().toString(36)}`;
    run(base, "clone", "-q", "--bare", work, `${repoName}.git`);
    const target = join(base, "into");
    let created: P | null = null;
    try {
        await login(page);
        await page.getByRole("button", { name: "+ 프로젝트" }).click();
        const dialog = page.getByRole("dialog", { name: "프로젝트 추가" });
        // 경로 제안: 입력한 접두어에 맞는 하위 폴더를 고르면 그 폴더로 이동한다
        await dialog.getByLabel("폴더 경로").fill(join(base, "zeta-s"));
        const suggest = dialog.getByRole("list", { name: "경로 제안" });
        await suggest.getByRole("button", { name: join(base, "zeta-suggest") }).click();
        await expect(dialog.getByTestId("dir-current")).toContainText(join(base, "zeta-suggest"));

        // clone: 대상 폴더 아래 저장소 이름으로 받고 프로젝트로 등록한다
        await dialog.locator("summary", { hasText: "저장소에서 clone" }).click();
        const box = dialog.getByRole("group", { name: "저장소 clone" });
        await box.getByLabel("clone할 저장소").fill(`file://${join(base, `${repoName}.git`)}`);
        await expect(box.getByLabel("clone 방식")).toHaveCount(0);
        await box.getByLabel("clone 대상 폴더").fill(target);
        await box.getByRole("button", { name: "clone 후 프로젝트로 추가" }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.locator(".sidebar .projects").getByTestId("project-row").filter({ hasText: repoName })).toHaveCount(1);
        expect(existsSync(join(target, repoName, "README"))).toBe(true);

        // 같은 대상에 다시 받으면 기존 폴더를 지키고 이유를 보인다
        await page.getByRole("button", { name: "+ 프로젝트" }).click();
        await dialog.locator("summary", { hasText: "저장소에서 clone" }).click();
        await box.getByLabel("clone할 저장소").fill(`file://${join(base, `${repoName}.git`)}`);
        await box.getByLabel("clone 대상 폴더").fill(target);
        await box.getByRole("button", { name: "clone 후 프로젝트로 추가" }).click();
        await expect(box.getByRole("alert")).toContainText("이미 있는 경로");
        // owner/name이면 방식을 고르게 한다
        await box.getByLabel("clone할 저장소").fill("octo/hello");
        await expect(box.getByLabel("clone 방식")).toHaveValue("https");
    } finally {
        const list = await apiCall<P[]>("GET", "/projects");
        created = list.find((p) => p.root_path.endsWith(`/${repoName}`)) ?? null;
        if (created) await apiCall("PATCH", `/projects/${created.id}`, { expected_revision: created.revision, archived: true });
    }
});
