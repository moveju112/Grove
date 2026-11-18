import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { apiCall, login, openSettings, openProjectSettings, selectChoice, state } from "./helpers";

type Effective = { items: { key: string; effective: unknown; layers: Record<string, { value: unknown; revision: number }> }[] };
async function projectSettings(page: Page, width: number) {
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: mkdtempSync(join(state().projA, "autosave-")) });
    await login(page);
    if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
    await openProjectSettings(page);
    return project;
}
async function effective(id: string, key: string) {
    return (await apiCall<Effective>("GET", `/settings/effective?project_id=${id}`)).items.find((item) => item.key === key)!;
}

for (const width of [390, 1280]) {
    test.describe(`${width}px 설정 자동 저장`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
        test("선택은 즉시 저장하고 입력은 blur 때만 저장하며 복원·저장 버튼은 없다", async ({ page }, info) => {
            const project = await projectSettings(page, width);
            const settings = page.getByTestId("settings");
            await settings.getByLabel("설정 검색").fill("출력 스타일");
            const style = settings.getByTestId("setting-output.style");
            await selectChoice(style.getByLabel("출력 스타일", { exact: true }), "detailed");
            await expect(style).toContainText("저장됨");
            expect((await effective(project.id, "output.style")).effective).toBe("detailed");
            await settings.getByLabel("설정 검색").fill("요청당 시간 예산");
            const row = settings.getByTestId("setting-runs.budget.max_minutes");
            const input = row.getByLabel("요청당 시간 예산(분)", { exact: true });
            await input.fill("15");
            expect((await effective(project.id, "runs.budget.max_minutes")).layers.project!.value).toBeNull();
            await input.press("Tab");
            await expect(row).toContainText("저장됨");
            expect((await effective(project.id, "runs.budget.max_minutes")).effective).toBe(15);
            await expect(settings.getByRole("button", { name: /저장|기본값.*복원|이 범위 값 지우기/ })).toHaveCount(0);
            await page.screenshot({ path: info.outputPath("settings-autosave.png") });
            await input.fill("25");
            await page.keyboard.press("Escape");
            await expect(settings).toHaveCount(0);
            await expect.poll(async () => (await effective(project.id, "runs.budget.max_minutes")).effective).toBe(25);
        });

        test("글자 크기 직접 입력은 blur 때 저장하고 미완성·범위 밖 값은 적용하지 않는다", async ({ page }, info) => {
            await login(page);
            await openSettings(page, "local");
            await page.getByLabel("설정 검색").fill("글자 크기");
            const field = page.getByLabel("글자 크기 입력(px)", { exact: true });
            await expect(field).toHaveAttribute("type", "number");
            const before = await page.locator("html").evaluate((element) => element.style.getPropertyValue("--font-size"));
            await field.fill("15");
            await expect(field).toHaveAttribute("type", "number");
            expect(await page.locator("html").evaluate((element) => element.style.getPropertyValue("--font-size"))).toBe(before);
            await field.blur();
            await expect(page.locator("html")).toHaveCSS("--font-size", "15px");
            await field.fill("");
            await field.blur();
            await expect(page.getByRole("alert")).toContainText("12~20px");
            await expect(page.locator("html")).toHaveCSS("--font-size", "15px");
            await field.fill("99");
            await field.blur();
            await expect(page.locator("html")).toHaveCSS("--font-size", "15px");
            await field.fill("17");
            await field.blur();
            await expect(page.locator("html")).toHaveCSS("--font-size", "17px");
            await expect(page.getByRole("button", { name: /기본값.*복원|전체 복원|^저장$/ })).toHaveCount(0);
            await page.screenshot({ path: info.outputPath("font-autosave.png") });
            await page.reload();
            await openSettings(page, "local");
            await page.getByLabel("설정 검색").fill("글자 크기");
            await expect(field).toHaveValue("17");
        });
    });
}

test("느린 저장 응답이 새 입력을 지우지 않고 후속 blur는 다음 revision으로 한 번만 저장한다", async ({ page }) => {
    const project = await projectSettings(page, 1280);
    await page.getByLabel("설정 검색").fill("요청당 시간 예산");
    const row = page.getByTestId("setting-runs.budget.max_minutes");
    const input = row.getByLabel("요청당 시간 예산(분)", { exact: true });
    const requests: { value: number; expected_revision: number }[] = [];
    let release!: () => void;
    let received!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const seen = new Promise<void>((resolve) => { received = resolve; });
    await page.route(`**/api/v1/settings/project/${project.id}/runs.budget.max_minutes`, async (route) => {
        requests.push(route.request().postDataJSON());
        const response = await route.fetch();
        if (requests.length === 1) { received(); await held; }
        await route.fulfill({ response });
    });
    try {
        await input.fill("10");
        await input.blur();
        await seen;
        await input.fill("20");
        await input.blur();
        expect(requests).toEqual([{ value: 10, expected_revision: 0 }]);
        release();
        await expect(row).toContainText("저장됨");
        await expect(input).toHaveValue("20");
        await expect.poll(async () => (await effective(project.id, "runs.budget.max_minutes")).effective).toBe(20);
        expect(requests).toEqual([{ value: 10, expected_revision: 0 }, { value: 20, expected_revision: 1 }]);
        await input.focus(); await input.blur();
        expect(requests).toHaveLength(2);
    } finally { release(); }
});

test("설정을 닫은 뒤 저장이 실패해도 다시 열면 입력과 오류가 남는다", async ({ page }) => {
    const project = await projectSettings(page, 1280);
    const search = page.getByLabel("설정 검색");
    await search.fill("요청당 시간 예산");
    const row = page.getByTestId("setting-runs.budget.max_minutes");
    const input = row.getByLabel("요청당 시간 예산(분)", { exact: true });
    let failed!: () => void;
    const seen = new Promise<void>((resolve) => { failed = resolve; });
    await page.route(`**/api/v1/settings/project/${project.id}/runs.budget.max_minutes`, async (route) => {
        await route.fulfill({ status: 422, json: { error: { code: "invalid_input", message: "fixture validation failure", retryable: false } } });
        failed();
    });
    await input.fill("30");
    await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
    await seen;
    await openProjectSettings(page);
    await search.fill("요청당 시간 예산");
    await expect(input).toHaveValue("30");
    await expect(row).toContainText("저장 실패(기존 값 유지)");
    expect((await effective(project.id, "runs.budget.max_minutes")).layers.project!.value).toBeNull();
});
