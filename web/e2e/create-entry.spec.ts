import { expect, test, type Locator, type Page } from "@playwright/test";
import { dirname, join } from "node:path";
import { apiCall, composerOption, ensureProjects, login, openDetails, state } from "./helpers";

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
    await openDetails(project.locator(".sidebar-project-tools"));
    await project.getByRole("button", { name: "새 대화", exact: true }).click();
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test.describe(`공통 생성 진입 ${viewport.width}px`, () => {
        test.use({ viewport });

        test("머리글·사이드바·프로젝트 입력창은 초안을 재사용하고 전송할 때만 한 대화를 만든다", async ({ page }) => {
            const { a, b } = await ensureProjects();
            await login(page);
            // 전역 설정에는 프로젝트 맥락이 없다.
            await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
            const entry = page.getByRole("button", { name: "만들기", exact: true });
            await entry.focus();
            await page.keyboard.press("Enter");
            const dialog = page.getByRole("dialog", { name: "만들기", exact: true });
            await expect(dialog.getByRole("list", { name: "대화 프로젝트 선택" })).toBeVisible();
            await dialog.getByRole("button", { name: "취소", exact: true }).focus();
            await page.keyboard.press("Tab");
            const focusState = await dialog.evaluate((node) => ({
                open: (node as HTMLDialogElement).open, modal: node.matches(":modal"),
                activeTag: document.activeElement?.tagName, activeLabel: document.activeElement?.getAttribute("aria-label"),
            }));
            expect(await dialog.evaluate((node) => node.contains(document.activeElement)), JSON.stringify(focusState)).toBe(true);
            const firstProject = dialog.getByRole("button", { name: a.name, exact: true });
            await expect(firstProject).toBeFocused();
            await page.keyboard.press("Shift+Tab");
            await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeFocused();
            expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
            await page.keyboard.press("Escape");
            await expect(dialog).toHaveCount(0);
            await expect(entry).toBeFocused();
            await entry.click();
            await dialog.getByRole("button", { name: "취소", exact: true }).click();
            await expect(dialog).toHaveCount(0);
            await expect(entry).toBeFocused();
            await entry.click();
            await dialog.getByRole("button", { name: "프로젝트 추가", exact: true }).click();
            const addDialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
            await expect(addDialog.getByLabel("폴더 경로")).toBeFocused();
            await addDialog.getByRole("button", { name: "취소", exact: true }).click();
            await expect(addDialog).toHaveCount(0);
            await expect(entry).toBeFocused();

            const created: string[] = [];
            page.on("request", (request) => {
                if (request.method() === "POST" && /\/api\/v1\/projects\/[^/]+\/sessions$/.test(request.url())) created.push(request.url());
            });
            await entry.click();
            await dialog.getByRole("button", { name: a.name, exact: true }).click();
            let project = page.locator(".project-view:visible");
            await expect(project.getByLabel("메시지 입력")).toBeFocused();
            await project.getByLabel("메시지 입력").fill("보존할 입력");
            // 현재 맥락에서는 프로젝트 선택을 반복하지 않는다.
            await entry.click();
            await expect(dialog.getByRole("list", { name: "대화 프로젝트 선택" })).toHaveCount(0);
            await expect(dialog).toContainText(`현재 프로젝트: ${a.name}`);
            // 폭별 배치가 달라도 시작할 때의 프로젝트 맥락은 바뀌지 않는다.
            await page.setViewportSize({ width: viewport.width === 390 ? 1440 : 390, height: viewport.height });
            await expect(dialog).toContainText(`현재 프로젝트: ${a.name}`);
            await page.setViewportSize(viewport);
            await twice(dialog.getByRole("button", { name: "이 프로젝트에서 새 대화" }));
            await expect(project.getByLabel("메시지 입력")).toHaveValue("보존할 입력");
            await startChat(page, a.id);
            await expect(project.getByLabel("메시지 입력")).toHaveValue("보존할 입력");
            expect(created).toHaveLength(0);

            for (const [index, target] of [a, b, a].entries()) {
                if (index === 1) {
                    await startChat(page, target.id);
                } else if (index === 2) {
                    await showSidebar(page);
                    await page.locator(`[data-testid="sidebar-project"][data-project-id="${target.id}"]`)
                        .getByTestId("project-row").getByRole("button").first().click();
                }
                project = page.locator(".project-view:visible");
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
            const project = page.locator(".project-view:visible");
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
            await page.getByRole("button", { name: "만들기", exact: true }).click();
            await page.getByRole("dialog", { name: "만들기", exact: true }).getByRole("button", { name: "프로젝트 추가", exact: true }).click();
            const dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
            const path = join(dirname(state().projA), `create-entry-${viewport.width}-${Date.now()}`);
            await dialog.getByLabel("폴더 경로").fill(path);
            await dialog.getByLabel("폴더가 없으면 마지막 폴더를 새로 만들기").check();
            await dialog.getByRole("button", { name: "저장소에서 clone", exact: true }).click();
            await dialog.getByLabel("clone할 저장소").fill("owner/repo");
            await dialog.getByLabel("clone 대상 폴더").fill(dirname(path));
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
            await expect(dialog.getByRole("button", { name: "clone 후 프로젝트로 추가", exact: true })).toBeDisabled();
            await page.keyboard.press("Escape");
            await expect(dialog).toBeVisible();
            await twice(retry);
            await expect(dialog).toHaveCount(0);
            await expect(page.locator(".project-view:visible").getByLabel("메시지 입력")).toBeFocused();
            expect(keys).toHaveLength(2);
            expect(keys[1]).toBe(keys[0]);
            const projects = await apiCall<{ id: string; root_path: string }[]>("GET", "/projects");
            const added = projects.filter((project) => project.root_path === path);
            expect(added).toHaveLength(1);
            expect((await apiCall<SessionPage>("GET", `/projects/${added[0]!.id}/sessions`)).items).toHaveLength(0);
        });
    });
}
