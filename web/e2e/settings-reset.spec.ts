import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { apiCall, login, state } from "./helpers";

type Item = { key: string; effective: unknown; source: string; layers: Record<string, { value: unknown; revision: number }> };
type Effective = { items: Item[] };
const dialog = (page: Page) => page.getByRole("dialog", { name: "기본값 복원 확인", exact: true });
async function effective(project?: string) {
    return apiCall<Effective>("GET", `/settings/effective${project ? `?project_id=${project}` : ""}`);
}
async function setting(scope: "server" | "project", id: string, key: string, value: unknown) {
    const current = (await effective(scope === "project" ? id : undefined)).items.find((item) => item.key === key)!;
    return apiCall("PUT", `/settings/${scope}/${id}/${key}`, { expected_revision: current.layers[scope]?.revision ?? 0, value });
}
async function setup(page: Page) {
    const root = mkdtempSync(join(state().projA, "settings-reset-"));
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    await setting("project", project.id, "output.language", "fixture-project");
    await setting("project", project.id, "output.style", "detailed");
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
    await page.getByRole("button", { name: "프로젝트 설정", exact: true }).click();
    return project;
}

test("항목 복원은 실제 상속값과 고정된 프로젝트를 확인하고 취소·실패 때 미저장 입력을 남긴다", async ({ page }) => {
    const parent = (await effective()).items.find((item) => item.key === "output.language")!.layers.server!.value;
    try {
        await setting("server", "-", "output.language", "fixture-parent");
        const project = await setup(page);
        await page.getByLabel("설정 검색", { exact: true }).fill("응답 언어");
        const row = page.getByTestId("setting-output.language");
        await row.getByLabel("응답 언어", { exact: true }).fill("unsaved-local-input");
        await row.getByRole("button", { name: "이 범위 값 지우기", exact: true }).click();
        await expect(dialog(page).getByTestId("reset-target")).toContainText(project.name);
        const comparison = dialog(page).getByTestId("reset-output.language");
        await expect(comparison).toContainText("fixture-project");
        await expect(comparison).toContainText("fixture-parent");
        await expect(dialog(page)).toContainText("unsaved-local-input");
        await dialog(page).getByRole("button", { name: "복원 창 닫기", exact: true }).click();
        await expect(row.getByLabel("응답 언어", { exact: true })).toHaveValue("unsaved-local-input");
        expect((await effective(project.id)).items.find((item) => item.key === "output.language")!.layers.project!.value).toBe("fixture-project");
        await row.getByRole("button", { name: "이 범위 값 지우기", exact: true }).click();
        await setting("server", "-", "output.language", "changed-parent");
        await dialog(page).getByRole("button", { name: "확인한 범위 복원", exact: true }).click();
        await expect(dialog(page).getByRole("alert")).toContainText("다시 비교");
        expect((await effective(project.id)).items.find((item) => item.key === "output.language")!.layers.project!.value).toBe("fixture-project");
        await dialog(page).getByRole("button", { name: "변경된 값 다시 비교", exact: true }).click();
        await expect(comparison).toContainText("changed-parent");
        await dialog(page).getByRole("button", { name: "확인한 범위 복원", exact: true }).click();
        await expect(dialog(page).getByRole("status")).toContainText("복원 저장됨");
        await dialog(page).getByRole("button", { name: "복원 창 닫기", exact: true }).click();
        await expect(row.getByLabel("응답 언어", { exact: true })).toHaveValue("changed-parent");
        await page.reload();
        await page.getByLabel("설정 검색", { exact: true }).fill("응답 언어");
        await expect(row.getByLabel("응답 언어", { exact: true })).toHaveValue("changed-parent");
    } finally { await setting("server", "-", "output.language", parent); }
});

test("영역 복원은 접힌 고급 항목까지 한 범위만 처리하고 서버 값·미저장 입력을 덮어쓰지 않는다", async ({ page }) => {
    const project = await setup(page);
    await setting("project", project.id, "exec.max_memory_mb", 1024);
    const serverBefore = await effective();
    const language = page.getByTestId("setting-output.language");
    await language.getByLabel("응답 언어", { exact: true }).fill("area-unsaved");
    await expect(page.getByTestId("setting-exec.max_memory_mb")).toHaveCount(0);
    const area = page.getByTestId("settings-area-reset");
    await expect(area.getByLabel("영역 복원 범위", { exact: true })).toHaveValue("project");
    await area.getByRole("button", { name: "이 영역의 범위별 설정 복원", exact: true }).click();
    await expect(dialog(page).getByTestId("reset-exec.max_memory_mb")).toContainText("1024");
    await expect(dialog(page).getByTestId("reset-target")).toContainText(project.name);
    await dialog(page).getByRole("button", { name: "확인한 범위 복원", exact: true }).click();
    await expect(dialog(page).getByRole("status")).toContainText("3개 override");
    await dialog(page).getByRole("button", { name: "복원 창 닫기", exact: true }).click();
    await expect(language.getByLabel("응답 언어", { exact: true })).toHaveValue("area-unsaved");
    const current = await effective(project.id);
    for (const key of ["output.language", "output.style", "exec.max_memory_mb"]) {
        expect(current.items.find((item) => item.key === key)!.layers.project!.value).toBeNull();
    }
    expect(await effective()).toEqual(serverBefore);
});

test("복원 응답 유실은 같은 본문·키로 결과를 확인하고 이후 설정을 다시 지우지 않는다", async ({ page }) => {
    const project = await setup(page);
    await page.getByLabel("설정 검색", { exact: true }).fill("응답 언어");
    const row = page.getByTestId("setting-output.language");
    const requests: { key: string; body: unknown }[] = [];
    await page.route("**/api/v1/settings/reset", async (route) => {
        requests.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() });
        if (requests.length === 1) { await route.fetch(); await route.abort("failed"); }
        else await route.continue();
    });
    await row.getByRole("button", { name: "이 범위 값 지우기", exact: true }).click();
    await dialog(page).getByRole("button", { name: "확인한 범위 복원", exact: true }).click();
    await expect(dialog(page).getByRole("button", { name: "원래 복원 요청 결과 확인", exact: true })).toBeVisible();
    await setting("project", project.id, "output.language", "new-after-reset");
    await dialog(page).getByRole("button", { name: "원래 복원 요청 결과 확인", exact: true }).click();
    await expect(dialog(page).getByRole("status")).toContainText("복원 저장됨");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect((await effective(project.id)).items.find((item) => item.key === "output.language")!.effective).toBe("new-after-reset");
});

test("기기 기본값 복원은 선택 필드의 동시 변경을 확인하고 대화·배치 사본을 지우지 않는다", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색", { exact: true }).fill("테마");
    const theme = page.getByTestId("setting-theme");
    await theme.getByLabel("테마", { exact: true }).selectOption("dark");
    const deviceId = await page.evaluate(() => localStorage.getItem("grove.device.id"));
    await page.evaluate(() => {
        localStorage.setItem("grove.draft.reset-test", "owned-fixture-draft");
        localStorage.setItem("grove.layout.reset-test", "owned-fixture-layout");
    });
    await theme.getByRole("button", { name: "테마 기본값 복원", exact: true }).click();
    await expect(dialog(page).getByTestId("reset-target")).toContainText("이 기기");
    await page.evaluate(() => {
        const value = JSON.parse(localStorage.getItem("grove.device.prefs")!);
        localStorage.setItem("grove.device.prefs", JSON.stringify({ ...value, theme: "soft" }));
        window.dispatchEvent(new Event("grove-prefs"));
    });
    await dialog(page).getByRole("button", { name: "확인한 범위 복원", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("다시 비교");
    await dialog(page).getByRole("button", { name: "변경된 값 다시 비교", exact: true }).click();
    await dialog(page).getByRole("button", { name: "확인한 범위 복원", exact: true }).click();
    await expect(dialog(page).getByRole("status")).toContainText("복원 저장됨");
    await dialog(page).getByRole("button", { name: "복원 창 닫기", exact: true }).click();
    await expect(theme.getByLabel("테마", { exact: true })).toHaveValue("system");
    await page.evaluate(() => {
        const value = JSON.parse(localStorage.getItem("grove.device.prefs")!);
        localStorage.setItem("grove.device.prefs", JSON.stringify({ ...value, fontSize: 20, answerOnly: true, enterToSend: true }));
        window.dispatchEvent(new Event("grove-prefs"));
    });
    await page.getByRole("button", { name: "이 기기 화면·입력 전체 복원", exact: true }).click();
    await expect(dialog(page).getByTestId("reset-fontSize")).toContainText("20");
    await dialog(page).getByRole("button", { name: "확인한 범위 복원", exact: true }).click();
    await expect(dialog(page).getByRole("status")).toContainText("복원 저장됨");
    await dialog(page).getByRole("button", { name: "복원 창 닫기", exact: true }).click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("grove.device.prefs")!))).toEqual({
        theme: "system", fontSize: 15, enterToSend: false, reasoning: "collapsed", answerOnly: false, expandTools: false,
    });
    expect(await page.evaluate(() => ({
        device: localStorage.getItem("grove.device.id"), draft: localStorage.getItem("grove.draft.reset-test"), layout: localStorage.getItem("grove.layout.reset-test"),
    }))).toEqual({ device: deviceId, draft: "owned-fixture-draft", layout: "owned-fixture-layout" });
});
