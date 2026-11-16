import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login, openAddMenu } from "./helpers";

type Folder = { id: string; name: string; revision: number; project_count: number };
type Project = { id: string; root_path: string; folder_id?: string };

async function showSidebar(page: import("@playwright/test").Page) {
    const button = page.getByRole("button", { name: "사이드바", exact: true });
    if (await button.getAttribute("aria-expanded") !== "true") await button.click();
}

for (const width of [390, 1280]) {
    test.describe(`${width}px 정리용 폴더`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });

        test("전역 +로 폴더를 만들고 프로젝트를 옮겨 재접속·이름 변경·삭제 후에도 파일과 대화를 유지한다", async ({ page }, info) => {
            const { a } = await ensureProjects();
            const before = await apiCall<Project>("GET", `/projects/${a.id}`);
            const history = await apiCall<{ items: { id: string }[] }>("GET", `/projects/${a.id}/sessions`);
            const name = `정리용 ${width} ${Date.now()}`;
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
            await row.getByRole("button", { name: "프로젝트 메뉴", exact: true }).click();
            const move = page.getByRole("dialog", { name: `${a.name} 메뉴`, exact: true }).getByRole("combobox", { name: "폴더 이동", exact: true });
            await move.click();
            const choices = page.locator(`[id=${JSON.stringify(await move.getAttribute("aria-controls"))}]`);
            await choices.getByRole("option").filter({ has: page.locator(`[data-option-value=${JSON.stringify(folder.id)}]`) }).click();
            await expect(section.getByTestId("project-row").filter({ hasText: a.name })).toBeVisible();
            expect((await apiCall<Project>("GET", `/projects/${a.id}`)).root_path).toBe(before.root_path);
            await page.reload();
            await expect(page.getByTestId("conn")).toHaveText("연결됨");
            await showSidebar(page);
            await expect(section.getByTestId("project-row").filter({ hasText: a.name })).toBeVisible();
            await expect.poll(async () => Math.round((await page.getByTestId("sidebar").boundingBox())!.x)).toBe(0);
            await page.screenshot({ path: info.outputPath(`project-folders-${width}.png`) });
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
