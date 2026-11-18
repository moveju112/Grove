import { expect, test, type Locator, type Page } from "@playwright/test";
import { apiCall, ensureProjects, login, openAddMenu } from "./helpers";

type Folder = { id: string; name: string; revision: number; project_count: number };
type Project = { id: string; root_path: string; folder_id?: string };

async function showSidebar(page: Page) {
    const button = page.getByRole("button", { name: "사이드바", exact: true });
    if (await button.getAttribute("aria-expanded") !== "true") await button.click();
    await expect.poll(async () => Math.round((await page.getByTestId("sidebar").boundingBox())!.x)).toBe(0);
}

async function dragProject(page: Page, source: Locator, target: Locator, touch: boolean, screenshot?: string) {
    if (!touch) return source.dragTo(target);
    const cdp = await page.context().newCDPSession(page);
    try {
        await source.scrollIntoViewIfNeeded();
        const from = (await source.boundingBox())!;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x + 55, y: from.y + from.height / 2 }] });
        await expect(source.locator("..")).toHaveAttribute("data-order-dragging", "true");
        const to = (await target.boundingBox())!;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: to.x + 55, y: to.y + to.height / 2 }] });
        await expect(target).toHaveAttribute("data-folder-drop", "true");
        if (screenshot) await page.screenshot({ path: screenshot });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally { await cdp.detach(); }
}

for (const width of [390, 1280]) {
    test.describe(`${width}px 정리용 폴더`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390, reducedMotion: "reduce" });

        test("전역 +로 폴더를 만들고 프로젝트를 옮겨 재접속·이름 변경·삭제 후에도 파일과 대화를 유지한다", async ({ page }, info) => {
            const { a } = await ensureProjects();
            const before = await apiCall<Project>("GET", `/projects/${a.id}`);
            const history = await apiCall<{ items: { id: string }[] }>("GET", `/projects/${a.id}/sessions`);
            const name = `정리용 ${width} ${Date.now()}`;
            const other = await apiCall<Folder>("POST", "/project-folders", { name: `${name} 대상` });
            await login(page);
            const menu = await openAddMenu(page);
            await expect(menu.getByRole("menuitem", { name: /새 대화/ })).toHaveCount(0);
            await menu.getByRole("menuitem", { name: "폴더 추가", exact: true }).click();
            const dialog = page.getByRole("dialog", { name: "폴더 추가", exact: true });
            await dialog.getByLabel("폴더 이름").fill(name);
            await dialog.getByRole("button", { name: "추가", exact: true }).click();
            await expect(dialog).toHaveCount(0);
            const folder = (await apiCall<Folder[]>("GET", "/project-folders")).find((folder) => folder.name === name)!;
            const section = page.locator(`[data-testid="project-folder"][data-folder-id="${folder.id}"]`);
            await expect(section).toBeVisible();
            const row = page.getByTestId("project-row").filter({ hasText: a.name });
            const source = row.getByRole("button", { name: a.name, exact: true });
            const folderHeader = section.locator("[data-project-folder-drop]");
            await row.getByRole("button", { name: "프로젝트 메뉴", exact: true }).click();
            const projectMenu = page.getByRole("dialog", { name: `${a.name} 메뉴`, exact: true });
            await expect(projectMenu).toBeVisible();
            await expect(projectMenu.getByText(/폴더/)).toHaveCount(0);
            await projectMenu.getByRole("button", { name: "닫기", exact: true }).click();
            const folderToggle = section.getByRole("button", { name, exact: true });
            await folderToggle.click();
            await expect(folderToggle).toHaveAttribute("aria-expanded", "false");
            await dragProject(page, source, folderHeader, width === 390, info.outputPath("project-folder-drop-390.png"));
            await expect.poll(async () => (await apiCall<Project>("GET", `/projects/${a.id}`)).folder_id).toBe(folder.id);
            await folderToggle.click();
            await expect(section.getByTestId("project-row").filter({ hasText: a.name })).toBeVisible();
            expect((await apiCall<Project>("GET", `/projects/${a.id}`)).root_path).toBe(before.root_path);
            await page.reload();
            await expect(page.getByTestId("conn")).toHaveText("연결됨");
            await showSidebar(page);
            await expect(section.getByTestId("project-row").filter({ hasText: a.name })).toBeVisible();
            await page.screenshot({ path: info.outputPath(`project-folders-${width}.png`) });
            const otherSection = page.locator(`[data-testid="project-folder"][data-folder-id="${other.id}"]`);
            await dragProject(page, source, otherSection.locator("[data-project-folder-drop]"), width === 390);
            await expect(otherSection.getByTestId("project-row").filter({ hasText: a.name })).toBeVisible();
            await dragProject(page, source, page.getByTestId("project-list-heading"), width === 390);
            await expect(otherSection.getByTestId("project-row")).toHaveCount(0);
            expect((await apiCall<Project>("GET", `/projects/${a.id}`)).folder_id).toBeUndefined();
            await dragProject(page, source, folderHeader, width === 390);
            await expect(section.getByTestId("project-row").filter({ hasText: a.name })).toBeVisible();
            await section.getByRole("button", { name, exact: true }).click();
            await expect(section.getByTestId("project-row")).toBeHidden();
            await section.getByRole("button", { name, exact: true }).click();
            await section.getByRole("button", { name: `${name} 폴더 메뉴`, exact: true }).click();
            await page.getByRole("dialog", { name: `${name} 폴더 메뉴`, exact: true }).getByRole("button", { name: "이름 변경", exact: true }).click();
            const rename = page.getByRole("dialog", { name: "폴더 이름 변경", exact: true });
            const renamed = `${name} 변경`;
            await rename.getByRole("textbox", { name: "폴더 이름", exact: true }).fill(renamed);
            await rename.getByRole("button", { name: "저장", exact: true }).click();
            await expect(rename).toHaveCount(0);
            await expect(section.getByRole("button", { name: renamed, exact: true })).toBeVisible();
            await test.step("이름을 바꾼 폴더의 삭제 메뉴 열기", async () => {
                await section.getByRole("button", { name: `${renamed} 폴더 메뉴`, exact: true }).click();
                await expect(page.getByRole("dialog", { name: `${renamed} 폴더 메뉴`, exact: true })).toBeVisible();
            });
            page.once("dialog", async (dialog) => {
                expect(dialog.message()).toContain("프로젝트·대화·실제 파일은 그대로");
                await dialog.accept();
            });
            await test.step("정리용 폴더만 삭제", async () => {
                await page.getByRole("dialog", { name: `${renamed} 폴더 메뉴`, exact: true }).getByRole("button", { name: "폴더 삭제", exact: true }).click();
            });
            await expect(section).toHaveCount(0);
            await expect(page.getByTestId("project-row").filter({ hasText: a.name })).toBeVisible();
            const after = await apiCall<Project>("GET", `/projects/${a.id}`);
            expect(after.folder_id).toBeUndefined();
            expect(after.root_path).toBe(before.root_path);
            expect((await apiCall<{ items: { id: string }[] }>("GET", `/projects/${a.id}/sessions`)).items.map((session) => session.id))
                .toEqual(history.items.map((session) => session.id));
        });
    });
}

test("폴더 생성 응답 유실 뒤 입력·닫기를 잠그고 같은 요청만 확인한다", async ({ page }) => {
    await ensureProjects();
    await login(page);
    const menu = await openAddMenu(page);
    await menu.getByRole("menuitem", { name: "폴더 추가", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "폴더 추가", exact: true });
    const name = `재확인 ${Date.now()}`;
    await dialog.getByLabel("폴더 이름").fill(name);
    const requests: { key: string; body: string | null }[] = [];
    await page.route("**/api/v1/project-folders", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        requests.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData() });
        const response = await route.fetch();
        if (requests.length === 1) await route.abort("connectionreset");
        else await route.fulfill({ response });
    });
    await dialog.getByRole("button", { name: "추가", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "같은 요청 결과 확인", exact: true })).toBeVisible();
    await expect(dialog.getByLabel("폴더 이름")).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "같은 요청 결과 확인", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect((await apiCall<Folder[]>("GET", "/project-folders")).filter((folder) => folder.name === name)).toHaveLength(1);
});

test("드롭 응답이 유실되면 같은 요청으로 이동 결과를 확인한다", async ({ page }) => {
    const { a } = await ensureProjects();
    const folder = await apiCall<Folder>("POST", "/project-folders", { name: `이동 재확인 ${Date.now()}` });
    const section = page.locator(`[data-testid="project-folder"][data-folder-id="${folder.id}"]`);
    const requests: { key: string; body: string | null }[] = [];
    await page.route(`**/api/v1/projects/${a.id}`, async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        requests.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData() });
        const response = await route.fetch();
        if (requests.length === 1) await route.abort("connectionreset");
        else await route.fulfill({ response });
    });
    await login(page);
    const source = page.getByTestId("project-row").getByRole("button", { name: a.name, exact: true });
    await source.dragTo(section.locator("[data-project-folder-drop]"));
    const retry = page.getByRole("button", { name: "같은 요청 결과 확인", exact: true });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(section.getByTestId("project-row")).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    await source.dragTo(page.getByTestId("project-list-heading"));
    await expect(section.getByTestId("project-row")).toHaveCount(0);
});
