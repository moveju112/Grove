import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, closeMobileSidebar, login, state } from "./helpers";

type Project = { id: string; name: string; root_path: string; icon: string | null; revision: number };

async function setup(page: Page) {
    const root = mkdtempSync(join(dirname(state().projA), "rename-project-"));
    const project = await apiCall<Project>("POST", "/projects", { root_path: root, name: "이름 변경 전", icon: "🌿" });
    await login(page);
    if (page.viewportSize()!.width <= 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await page.locator(`[data-project-id="${project.id}"]`).getByTestId("project-row")
        .getByRole("button", { name: project.name, exact: true }).click();
    if (page.viewportSize()!.width <= 760) await closeMobileSidebar(page);
    await expect(page.getByTestId("project-view").getByLabel("메시지 입력", { exact: true })).toBeVisible();
    return project;
}

async function openRename(page: Page, id: string) {
    const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
    if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
    const row = page.locator(`[data-testid="sidebar-project"][data-project-id="${id}"]`).getByTestId("project-row");
    await row.getByRole("button", { name: "프로젝트 메뉴", exact: true }).click();
    await page.getByRole("button", { name: "이름 변경", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "프로젝트 이름 변경", exact: true });
    await expect(dialog.getByLabel("프로젝트 이름", { exact: true })).toBeFocused();
    return { dialog, row };
}

for (const width of [390, 1280]) {
    test.describe(`${width}px 프로젝트 이름 변경`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760 });
        test("목록 메뉴에서 이름만 바꾸고 폴더·아이콘·미전송 입력을 유지한다", async ({ page }, info) => {
            const project = await setup(page);
            const input = page.getByTestId("project-view").getByLabel("메시지 입력", { exact: true });
            await input.fill("이름을 바꿔도 남는 입력");
            const { dialog, row } = await openRename(page, project.id);
            await dialog.getByLabel("프로젝트 이름", { exact: true }).fill("  새 프로젝트 이름  ");
            await page.screenshot({ path: info.outputPath("project-rename.png"), animations: "disabled" });
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await dialog.getByRole("button", { name: "저장", exact: true }).click();
            await expect(dialog).toHaveCount(0);
            await expect(row.getByRole("button", { name: "새 프로젝트 이름", exact: true })).toBeVisible();
            await expect(page.getByTestId("navigation-context")).toContainText("새 프로젝트 이름");
            expect(await apiCall<Project>("GET", `/projects/${project.id}`)).toMatchObject({
                name: "새 프로젝트 이름", root_path: project.root_path, icon: project.icon, revision: project.revision + 1,
            });
            if (width < 760) await closeMobileSidebar(page);
            await expect(input).toHaveValue("이름을 바꿔도 남는 입력");
            await page.reload();
            await expect(page.getByTestId("conn")).toHaveText("연결됨");
            await expect(page.getByTestId("navigation-context")).toContainText("새 프로젝트 이름");
        });
    });
}

test("빈 이름은 저장하지 않고 취소하면 기존 이름과 메뉴 초점을 유지한다", async ({ page }) => {
    const project = await setup(page);
    const { dialog, row } = await openRename(page, project.id);
    await dialog.getByLabel("프로젝트 이름", { exact: true }).fill("   ");
    await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row.getByRole("button", { name: "프로젝트 메뉴", exact: true })).toBeFocused();
    expect(await apiCall<Project>("GET", `/projects/${project.id}`)).toMatchObject({
        name: project.name, revision: project.revision,
    });
});

test("다른 기기의 변경과 충돌하면 입력을 보존하고 명시적으로 다시 저장할 때만 반영한다", async ({ page }) => {
    const project = await setup(page);
    const { dialog } = await openRename(page, project.id);
    await dialog.getByLabel("프로젝트 이름", { exact: true }).fill("충돌 뒤 저장할 이름");
    await apiCall("PATCH", `/projects/${project.id}`, { expected_revision: project.revision, icon: "🌳" });
    await dialog.getByRole("button", { name: "저장", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("다른 곳에서 프로젝트 정보가 바뀌었어요");
    await expect(dialog.getByLabel("프로젝트 이름", { exact: true })).toHaveValue("충돌 뒤 저장할 이름");
    expect(await apiCall<Project>("GET", `/projects/${project.id}`)).toMatchObject({ name: project.name, icon: "🌳" });
    await dialog.getByRole("button", { name: "저장", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await apiCall<Project>("GET", `/projects/${project.id}`)).toMatchObject({
        name: "충돌 뒤 저장할 이름", icon: "🌳", revision: project.revision + 2,
    });
});

test("저장 응답을 잃으면 변경·닫기를 막고 같은 본문과 키로 결과만 확인한다", async ({ page }) => {
    const project = await setup(page);
    const requests: { key: string; body: unknown }[] = [];
    await page.route(`**/api/v1/projects/${project.id}`, async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        requests.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() });
        const response = await route.fetch();
        if (requests.length === 1) await route.abort("failed");
        else await route.fulfill({ response });
    });
    const { dialog } = await openRename(page, project.id);
    const input = dialog.getByLabel("프로젝트 이름", { exact: true });
    await input.fill("응답 유실 뒤 확인한 이름");
    await dialog.getByRole("button", { name: "저장", exact: true }).click();
    await expect(dialog.getByRole("status").filter({ hasText: "저장 결과를 확인하지 못했어요" })).toBeVisible();
    await expect(input).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "같은 요청 결과 확인", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.key).toBeTruthy();
    expect(requests[1]).toEqual(requests[0]);
    expect(await apiCall<Project>("GET", `/projects/${project.id}`)).toMatchObject({
        name: "응답 유실 뒤 확인한 이름", revision: project.revision + 1,
    });
});
