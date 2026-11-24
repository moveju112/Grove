import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, closeMobileSidebar, composerOption, ensureProjects, login, openAddMenu, openAddProject, openSettings, startProjectConversation, state, useWorkspaces } from "./helpers";

type SessionPage = { items: { id: string; title: string }[] };

async function twice(button: Locator) {
    await button.evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
}

async function showSidebar(page: Page) {
    const toggle = page.getByRole("button", { name: "사이드바", exact: true });
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}

async function startChat(page: Page, projectId: string) {
    await showSidebar(page);
    const project = page.locator(`[data-testid="sidebar-project"][data-project-id="${projectId}"]`);
    await project.getByTestId("project-row").getByRole("button").first().click();
    if (page.viewportSize()!.width <= 760) await closeMobileSidebar(page);
    await startProjectConversation(page.getByTestId("project-view").filter({ visible: true }));
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test.describe(`공통 생성 진입 ${viewport.width}px`, () => {
        test.use({ viewport });

        test("전역 +는 프로젝트·폴더만 추가하고 프로젝트 +는 초안을 재사용해 전송할 때만 대화를 만든다", async ({ page }) => {
            const { a, b } = await ensureProjects();
            await useWorkspaces(a.id);
            await useWorkspaces(b.id);
            await login(page);
            // 설정 창은 작업공간에 탭을 만들지 않는다.
            await openSettings(page);
            await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
            const menu = await openAddMenu(page);
            const entry = page.getByRole("button", { name: "프로젝트·폴더 추가", exact: true });
            await expect(menu.getByRole("menuitem", { name: "폴더 추가", exact: true })).toBeVisible();
            await expect(menu.getByRole("menuitem", { name: /새 대화/ })).toHaveCount(0);
            await page.keyboard.press("Escape");
            await expect(menu).toBeHidden();
            await expect(entry).toBeFocused();
            const addDialog = await openAddProject(page);
            await expect(addDialog.getByLabel("폴더 경로")).toBeFocused();
            await addDialog.getByRole("button", { name: "취소", exact: true }).click();
            await expect(addDialog).toHaveCount(0);
            await expect(entry).toBeFocused();

            const created: string[] = [];
            page.on("request", (request) => {
                if (request.method() === "POST" && /\/api\/v1\/projects\/[^/]+\/sessions$/.test(request.url())) created.push(request.url());
            });
            await page.locator(`[data-testid="sidebar-project"][data-project-id="${a.id}"]`)
                .getByTestId("project-row").getByRole("button").first().click();
            if (viewport.width <= 760) await closeMobileSidebar(page);
            let project = page.getByTestId("project-view").filter({ visible: true });
            // 프로젝트 전환은 이전에 열었던 탭으로 복귀할 수 있다.
            await startProjectConversation(project);
            await expect(project.getByTestId("composer")).toBeVisible();
            await startProjectConversation(project);
            await expect(project.getByLabel("메시지 입력")).toBeFocused();
            await project.getByLabel("메시지 입력").fill("보존할 입력");
            await startChat(page, a.id);
            await expect(project.getByLabel("메시지 입력")).toHaveValue("보존할 입력");
            await expect(project.getByLabel("메시지 입력")).toBeFocused();
            expect(created).toHaveLength(0);

            for (const [index, target] of [a, b, a].entries()) {
                if (index === 1) {
                    await startChat(page, target.id);
                } else if (index === 2) {
                    await showSidebar(page);
                    await page.locator(`[data-testid="sidebar-project"][data-project-id="${target.id}"]`)
                        .getByTestId("project-row").getByRole("button").first().click();
                    if (viewport.width <= 760) await closeMobileSidebar(page);
                    await startProjectConversation(page.getByTestId("project-view").filter({ visible: true }));
                }
                project = page.getByTestId("project-view").filter({ visible: true });
                const text = `생성 진입 ${viewport.width} ${index} ${Date.now()}`;
                await composerOption(project, "보내기 방식", "save");
                await project.getByLabel("메시지 입력").fill(text);
                await twice(project.getByRole("button", { name: "보내기", exact: true }));
                await expect(page.getByTestId("session-view").filter({ hasText: text }).getByTestId("msg-user").filter({ hasText: text })).toHaveCount(1);
                const sessions = await apiCall<SessionPage>("GET", `/projects/${target.id}/sessions?q=${encodeURIComponent(text)}`);
                expect(sessions.items.filter((session) => session.title === text)).toHaveLength(1);
            }
            expect(created).toHaveLength(3);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        });

        test("세션 생성 응답 유실 뒤 같은 키로 확인하고 대화·메시지를 중복 생성하지 않는다", async ({ page }) => {
            const { a } = await ensureProjects();
            await useWorkspaces(a.id);
            await login(page);
            await startChat(page, a.id);
            const keys: string[] = [];
            await page.route(`**/api/v1/projects/${a.id}/sessions`, async (route) => {
                if (route.request().method() !== "POST") return route.continue();
                keys.push(route.request().headers()["idempotency-key"]!);
                const response = await route.fetch();
                if (keys.length === 1) await route.abort("failed");
                else await route.fulfill({ response });
            });
            const text = `생성 응답 유실 ${viewport.width} ${Date.now()}`;
            const project = page.getByTestId("project-view").filter({ visible: true });
            await composerOption(project, "보내기 방식", "save");
            await project.getByLabel("메시지 입력").fill(text);
            await twice(project.getByRole("button", { name: "보내기", exact: true }));
            await expect(project.getByTestId("send-unsure")).toBeVisible();
            const before = await apiCall<SessionPage>("GET", `/projects/${a.id}/sessions?q=${encodeURIComponent(text)}`);
            expect(before.items.filter((session) => session.title === text)).toHaveLength(1);
            await twice(project.getByRole("button", { name: "같은 요청 확인", exact: true }));
            await expect(page.getByTestId("session-view").filter({ hasText: text }).getByTestId("msg-user").filter({ hasText: text })).toHaveCount(1);
            expect(keys).toHaveLength(2);
            expect(keys[0]).toBeTruthy();
            expect(keys[1]).toBe(keys[0]);
            const after = await apiCall<SessionPage>("GET", `/projects/${a.id}/sessions?q=${encodeURIComponent(text)}`);
            expect(after.items.filter((session) => session.title === text)).toHaveLength(1);
        });

        test("폴더 등록 응답 유실 중 다른 생성·닫기를 막고 원래 요청만 확인한다", async ({ page }) => {
            await ensureProjects();
            await login(page);
            const dialog = await openAddProject(page);
            const path = join(dirname(state().projA), `create-entry-${viewport.width}-${Date.now()}`);
            mkdirSync(path);
            await dialog.getByLabel("폴더 경로").fill(path);
            await dialog.getByRole("button", { name: "저장소에서 clone", exact: true }).click();
            const clone = page.getByRole("dialog", { name: "저장소에서 clone", exact: true });
            await clone.getByLabel("clone할 저장소").fill("owner/repo");
            await clone.getByLabel("clone 대상 폴더").fill(dirname(path));
            await clone.getByRole("button", { name: "닫기", exact: true }).click();
            const keys: string[] = [];
            await page.route("**/api/v1/projects", async (route) => {
                if (route.request().method() !== "POST") return route.continue();
                keys.push(route.request().headers()["idempotency-key"]!);
                const response = await route.fetch();
                if (keys.length === 1) await route.abort("failed");
                else await route.fulfill({ response });
            });
            await twice(dialog.getByRole("button", { name: "이 폴더를 프로젝트로 추가", exact: true }));
            const retry = dialog.getByRole("button", { name: "같은 생성 요청 결과 확인", exact: true });
            await expect(retry).toBeVisible();
            await expect(dialog.getByRole("button", { name: "저장소에서 clone", exact: true })).toBeDisabled();
            await page.keyboard.press("Escape");
            await expect(dialog).toBeVisible();
            await twice(retry);
            await expect(dialog).toHaveCount(0);
            await expect(page.getByTestId("project-view").filter({ visible: true }).getByTestId("composer")).toBeVisible();
            await expect(page.getByTestId("project-view").filter({ visible: true }).getByTestId("composer")).toHaveCount(1);
            expect(keys).toHaveLength(2);
            expect(keys[1]).toBe(keys[0]);
            const projects = await apiCall<{ id: string; root_path: string }[]>("GET", "/projects");
            const added = projects.filter((project) => project.root_path === path);
            expect(added).toHaveLength(1);
            expect((await apiCall<SessionPage>("GET", `/projects/${added[0]!.id}/sessions`)).items).toHaveLength(0);
        });
    });
}
