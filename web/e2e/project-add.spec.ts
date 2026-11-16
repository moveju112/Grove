import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { apiCall, composerOption, ensureProjects, login, openAddProject, startProjectConversation, state } from "./helpers";

// PROJECT-001: 폴더를 생성하지 않고 기존 폴더만 등록한다.
test("프로젝트 추가에서 폴더를 둘러보고 없는 경로는 거부한 뒤 기존 폴더를 등록한다", async ({ page }) => {
    await ensureProjects();
    const base = dirname(state().projA);
    const root = mkdtempSync(join(base, "기존프로젝트-"));
    const name = basename(root);
    await login(page);
    const dialog = await openAddProject(page);
    await dialog.getByLabel("폴더 경로").fill(base);
    await dialog.getByRole("button", { name: "이 경로 열기" }).click();
    const dirs = dialog.getByRole("list", { name: "하위 폴더", exact: true });
    await dirs.getByRole("button", { name: `📁 ${name}`, exact: true }).click();
    await expect(dialog.getByLabel("폴더 경로")).toHaveValue(root);
    await dialog.getByRole("button", { name: "상위 폴더" }).click();
    await expect(dialog.getByLabel("폴더 경로")).toHaveValue(base);
    const missing = join(root, "없는폴더");
    await dialog.getByLabel("폴더 경로").fill(missing);
    await dialog.getByRole("button", { name: "이 폴더를 프로젝트로 추가", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("존재하지 않는 경로");
    expect(existsSync(missing)).toBe(false);
    await dialog.getByLabel("폴더 경로").fill(root);
    await dialog.getByRole("button", { name: "이 폴더를 프로젝트로 추가", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const view = page.getByTestId("project-view").filter({ visible: true });
    await expect(view.getByRole("heading", { level: 1, name, exact: true })).toBeAttached();
    await expect(page.getByTestId("sidebar").getByTestId("projects").getByRole("button", { name, exact: true })).toBeVisible();
    await startProjectConversation(view);
    await composerOption(view, "보내기 방식", "save");
    await view.getByLabel("메시지 입력").fill("새 프로젝트 첫 메시지");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const session = page.getByTestId("session-view");
    await expect(session.getByTestId("msg-user").filter({ hasText: "새 프로젝트 첫 메시지" })).toHaveCount(1);
    const projects = await apiCall<{ id: string; name: string }[]>("GET", "/projects");
    const project = projects.find((item) => item.name === name)!;
    const sessions = await apiCall<{ items: { id: string }[] }>("GET", `/projects/${project.id}/sessions`);
    expect(sessions.items).toHaveLength(1);
    await expect(session).toHaveAttribute("data-session", sessions.items[0]!.id);
});

for (const theme of ["light", "dark"] as const) {
    for (const viewport of [{ width: 1180, height: 800 }, { width: 390, height: 844 }, { width: 390, height: 430 }]) {
        test(`${theme} ${viewport.width}x${viewport.height}: 숨김 폴더를 기본 표시하고 긴 목록만 스크롤하며 하단 조작은 가리지 않는다`, async ({ page }, info) => {
            const root = mkdtempSync(join(dirname(state().projA), "many-folders-"));
            mkdirSync(join(root, ".hidden"));
            for (let i = 0; i < 80; i++) {
                mkdirSync(join(root, `folder-${String(i).padStart(3, "0")}`));
                writeFileSync(join(root, `file-${String(i).padStart(3, "0")}.txt`), "fixture");
            }
            await page.setViewportSize(viewport);
            await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
            await page.addInitScript((theme) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme })), theme);
            await login(page);
            const dialog = await openAddProject(page);
            await dialog.getByLabel("폴더 경로").fill(root);
            await dialog.getByRole("button", { name: "이 경로 열기" }).click();
            await expect(dialog.getByTestId("dir-current")).toContainText(root);
            const dirs = dialog.getByRole("list", { name: "하위 폴더", exact: true });
            await expect(dirs.getByRole("button")).toHaveCount(81);
            await expect(dirs.getByRole("button", { name: "📁 .hidden", exact: true })).toBeAttached();
            await expect(dirs.getByRole("button", { name: /file-000/ })).toHaveCount(0);
            await expect(dialog.getByLabel("숨김 폴더 표시", { exact: true })).toHaveCount(0);
            await expect(dialog.getByLabel("폴더가 없으면 마지막 폴더를 새로 만들기", { exact: true })).toHaveCount(0);
            const add = dialog.getByRole("button", { name: "이 폴더를 프로젝트로 추가", exact: true });
            const cancel = dialog.getByRole("button", { name: "취소", exact: true });
            const clone = dialog.getByRole("button", { name: "저장소에서 clone", exact: true });
            for (const button of [add, cancel, clone]) await expect(button).toBeInViewport({ ratio: 1 });
            const bounds = (await dialog.boundingBox())!;
            expect(bounds.y).toBeGreaterThanOrEqual(0);
            expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
            expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
            const content = dialog.getByRole("group", { name: "프로젝트 추가 내용", exact: true });
            const scroll = await content.evaluate((node) => ({ content: node.scrollHeight, viewport: node.clientHeight }));
            expect(scroll.content).toBeGreaterThan(scroll.viewport);
            const before = (await cancel.boundingBox())!.y;
            await content.evaluate((node) => { node.scrollTop = node.scrollHeight; });
            await expect(dirs.getByRole("button", { name: "📁 folder-079", exact: true })).toBeInViewport({ ratio: 1 });
            for (const button of [add, cancel, clone]) await expect(button).toBeInViewport({ ratio: 1 });
            expect(Math.abs((await cancel.boundingBox())!.y - before)).toBeLessThanOrEqual(1);
            await page.screenshot({ path: info.outputPath(`project-add-${theme}-${viewport.width}x${viewport.height}.png`) });
            await cancel.click();
            await expect(dialog).toHaveCount(0);
            await expect(page.getByRole("button", { name: "프로젝트·폴더 추가", exact: true })).toBeFocused();
        });
    }
}
