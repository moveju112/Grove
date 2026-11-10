import { expect, test } from "@playwright/test";
import { dirname, basename } from "node:path";
import { apiCall, ensureProjects, login } from "./helpers";

// PROJECT-001: 서버 폴더를 둘러보고 새 폴더로 프로젝트를 만든다.
test("프로젝트 추가 대화상자에서 폴더를 둘러보고 새 폴더로 프로젝트를 만든다", async ({ page }) => {
    const { a } = await ensureProjects();
    const list = await apiCall<{ id: string; root_path: string }[]>("GET", "/projects");
    const root = list.find((p) => p.id === a.id)?.root_path;
    if (!root) throw new Error("e2e 프로젝트 A가 없습니다");
    const base = dirname(root);
    const existing = basename(root);
    await login(page);
    await page.getByRole("button", { name: "+ 프로젝트" }).click();
    const dlg = page.getByRole("dialog", { name: "프로젝트 추가" });
    await expect(dlg).toBeVisible();
    // 홈 폴더에서 시작한 뒤 입력한 경로로 이동
    await dlg.getByLabel("폴더 경로").fill(base);
    await dlg.getByRole("button", { name: "이 경로 열기" }).click();
    const dirs = dlg.getByRole("list", { name: "하위 폴더" });
    await expect(dirs.getByRole("button", { name: new RegExp(existing) })).toBeVisible();
    // 하위 폴더로 들어갔다가 상위로
    await dirs.getByRole("button", { name: new RegExp(existing) }).click();
    await expect(dlg.getByLabel("폴더 경로")).toHaveValue(new RegExp(`${existing}$`));
    await dlg.getByRole("button", { name: "상위 폴더" }).click();
    await expect(dlg.getByLabel("폴더 경로")).toHaveValue(base);
    // 없는 폴더: 새로 만들기 없이 추가하면 오류, 선택하면 만들어 등록
    const name = `새폴더-${Date.now()}`;
    await dlg.getByLabel("폴더 경로").fill(`${base}/${name}`);
    await dlg.getByRole("button", { name: "이 폴더를 프로젝트로 추가" }).click();
    await expect(dlg.getByRole("alert")).toContainText("존재하지 않는 경로");
    await dlg.getByLabel("폴더가 없으면 마지막 폴더를 새로 만들기").check();
    await dlg.getByRole("button", { name: "이 폴더를 프로젝트로 추가" }).click();
    await expect(dlg).toHaveCount(0);
    await expect(page.locator(".view-head h1").filter({ hasText: name })).toBeVisible();
    await expect(page.locator(".sidebar .projects").getByRole("button", { name: new RegExp(name) })).toBeVisible();
});
