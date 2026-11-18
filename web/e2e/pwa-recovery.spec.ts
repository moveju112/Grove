import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, closeMobileSidebar, composerOption, ensureProjects, login, openAddProject, openDetails, openTool, sessionView, startProjectConversation, state, useWorkspaces } from "./helpers";

for (const width of [1400, 390]) {
    test.describe(`PWA 생성 진입 ${width}px`, () => {
        test.use({ viewport: { width, height: 900 } });
        test("offline에서도 로컬 선택·초안·프로젝트 경로·취소를 유지하고 생성은 명시적인 재전송만 허용한다", async ({ page }) => {
            const { a } = await ensureProjects();
            await login(page);
            const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
            if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
            await page.getByTestId("project-row").getByRole("button", { name: a.name, exact: true }).click();
            if (width === 390) await closeMobileSidebar(page);
            const project = page.getByTestId("project-view").filter({ visible: true });
            await startProjectConversation(project);
            await composerOption(project, "보내기 방식", "save");
            const text = `PWA 생성 초안 ${width} ${Date.now()}`;
            await project.getByLabel("메시지 입력").fill(text);
            await openTool(project, "터미널");
            await page.getByRole("button", { name: "도구 패널 닫기", exact: true }).click();
            const mutations: string[] = [];
            page.on("request", (request) => {
                if (request.method() !== "GET" && /\/api\/v1\/projects(?:$|\/[^/]+\/(?:sessions|terminals|worktrees)$)/.test(request.url())) mutations.push(request.url());
            });
            try {
                await page.context().setOffline(true);
                await expect(page.getByTestId("offline-banner")).toBeVisible();
                await test.step("오프라인에서 기존 초안 입력에 복귀", async () => {
                    const entry = width <= 760 ? page.getByRole("banner").getByRole("button", { name: "새 대화", exact: true }) : project.getByLabel("메시지 입력", { exact: true });
                    await expect.poll(() => entry.evaluate((node) => {
                        const bounds = node.getBoundingClientRect();
                        const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
                        return node.contains(hit) ? true : hit?.outerHTML.slice(0, 500);
                    })).toBe(true);
                    await startProjectConversation(project);
                });
                await expect(project.getByLabel("메시지 입력")).toBeEnabled();
                await expect(project.getByLabel("메시지 입력")).toHaveValue(text);
                await project.getByLabel("메시지 입력").fill(text + " · 오프라인 수정");
                await expect(project.getByRole("button", { name: "보내기", exact: true })).toBeDisabled();
                await openTool(project, "터미널");
                await expect(project.getByRole("button", { name: "새 터미널", exact: true })).toBeDisabled();
                await expect(project.getByRole("button", { name: "새 터미널", exact: true })).toHaveAttribute("title", /오프라인/);
                await page.getByRole("button", { name: "도구 패널 닫기", exact: true }).click();
                const add = await openAddProject(page);
                await expect(add.getByTestId("project-add-blocked")).toContainText("오프라인");
                await add.getByLabel("폴더 경로").fill("/fixture/not-sent");
                await expect(add.getByRole("button", { name: "이 폴더를 프로젝트로 추가" })).toBeDisabled();
                await add.getByRole("button", { name: "저장소에서 clone", exact: true }).click();
                const clone = page.getByRole("dialog", { name: "저장소에서 clone", exact: true });
                await clone.getByLabel("clone할 저장소").fill("fixture/not-sent");
                await clone.getByLabel("clone 대상 폴더").fill("/fixture/not-sent");
                await expect(clone.getByRole("button", { name: "clone 후 프로젝트로 추가" })).toBeDisabled();
                await clone.getByRole("button", { name: "닫기", exact: true }).click();
                await add.getByRole("button", { name: "취소", exact: true }).click();
                await expect(add).toHaveCount(0);
                if (width === 390) await closeMobileSidebar(page);
                expect(mutations).toEqual([]);
            } finally {
                await page.context().setOffline(false);
            }
            await expect(project.getByRole("button", { name: "보내기", exact: true })).toBeEnabled();
            await expect(project.getByLabel("메시지 입력")).toHaveValue(text + " · 오프라인 수정");
            expect(mutations).toEqual([]);
            await project.getByRole("button", { name: "보내기", exact: true }).click();
            await expect(page.getByTestId("session-view").getByTestId("msg-user")).toContainText(text + " · 오프라인 수정");
            expect(mutations.filter((url) => url.endsWith("/sessions"))).toHaveLength(1);
        });
    });
}

test("대화 생성 뒤 offline 전환은 원래 생성·전송 키로만 확인하고 중복 대화를 만들지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: a.name, exact: true }).click();
    const project = page.getByTestId("project-view").filter({ visible: true });
    await startProjectConversation(project);
    await composerOption(project, "보내기 방식", "save");
    const text = `PWA 단계 사이 차단 ${Date.now()}`;
    await project.getByLabel("메시지 입력").fill(text);
    const keys: string[] = [];
    await page.route(`**/api/v1/projects/${a.id}/sessions`, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        keys.push(route.request().headers()["idempotency-key"]!);
        const response = await route.fetch();
        if (keys.length === 1) await page.evaluate(() => {
            Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
            window.dispatchEvent(new Event("offline"));
        });
        await route.fulfill({ response });
    });
    try {
        await project.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(project.getByTestId("send-unsure")).toBeVisible();
        await expect(project.getByRole("button", { name: "같은 요청 확인", exact: true })).toBeDisabled();
        const before = await apiCall<{ items: { title: string }[] }>("GET", `/projects/${a.id}/sessions?q=${encodeURIComponent(text)}`);
        expect(before.items.filter((session) => session.title === text)).toHaveLength(1);
        await page.evaluate(() => { Reflect.deleteProperty(navigator, "onLine"); window.dispatchEvent(new Event("online")); });
        await expect(project.getByRole("button", { name: "같은 요청 확인", exact: true })).toBeEnabled();
        expect(keys).toHaveLength(1);
        await project.getByRole("button", { name: "같은 요청 확인", exact: true }).click();
        await expect(page.getByTestId("session-view").getByTestId("msg-user")).toContainText(text);
        expect(keys).toHaveLength(2);
        expect(keys[1]).toBe(keys[0]);
        const after = await apiCall<{ items: { title: string }[] }>("GET", `/projects/${a.id}/sessions?q=${encodeURIComponent(text)}`);
        expect(after.items.filter((session) => session.title === text)).toHaveLength(1);
    } finally {
        await page.evaluate(() => { Reflect.deleteProperty(navigator, "onLine"); });
    }
});

test("오프라인 cold start는 미전송 입력을 저장하지 않고 명시적인 온라인 복구를 안내한다", async ({ page }) => {
    const { a } = await ensureProjects();
    const title = `Cold start ${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = sessionView(page, session.id);
    const privateText = "인증 전에는 보이면 안 되는 기존 초안";
    await view.getByLabel("메시지 입력").fill(privateText);
    const drafts = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage)
        .filter((key) => key.startsWith("grove.draft.")).map((key) => [key, localStorage.getItem(key)])));
    expect(await drafts()).toEqual({});
    const before = await drafts();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    // 시험 소유 쿠키만 제거해, 다른 사용자/인증 없는 브라우저의 재시작을 재현한다.
    await page.context().clearCookies();
    const mutations: string[] = [];
    page.on("request", (request) => {
        if (request.url().includes("/api/") && request.method() !== "GET") mutations.push(request.url());
    });
    try {
        await page.context().setOffline(true);
        await page.reload();
        await expect(page.getByTestId("auth-recovery")).toBeVisible();
        await expect(page.getByTestId("auth-recovery")).toContainText("대화 기록에서 결과를 확인");
        await expect(page.locator("body")).not.toContainText(privateText);
        await expect(page.getByLabel("메시지 입력")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "연결·로그인 다시 확인" })).toBeDisabled();
        expect(await drafts()).toEqual(before);
        expect(mutations).toEqual([]);
    } finally {
        await page.context().setOffline(false);
    }
    await expect(page.getByRole("button", { name: "연결·로그인 다시 확인" })).toBeEnabled();
    await expect(page.getByTestId("auth-recovery")).toBeVisible();
    expect(mutations).toEqual([]);
    await page.getByRole("button", { name: "연결·로그인 다시 확인" }).click();
    await expect(page.getByRole("button", { name: "페어링 링크·QR로 등록" })).toBeVisible();
    expect(mutations.map((url) => new URL(url).pathname)).toEqual(["/api/v1/auth/refresh"]);
    expect(await drafts()).toEqual(before);
    await login(page);
    await expect(page.getByTestId("conn")).toHaveText("연결됨");
    await expect(sessionView(page, session.id).getByLabel("메시지 입력")).toHaveValue("");
    expect(mutations.some((url) => /\/sessions\/[^/]+\/(turns|messages|followups)/.test(url))).toBe(false);
});

test("cold start의 protocol 불일치는 로그인·페어링·refresh를 전송하지 않는다", async ({ page }) => {
    const mutations: string[] = [];
    await page.route("**/api/v1/health", (route) => route.fulfill({
        status: 200, contentType: "application/json", body: '{"protocol":2,"version":"fixture-next"}',
    }));
    page.on("request", (request) => {
        if (request.url().includes("/api/") && request.method() !== "GET") mutations.push(request.url());
    });
    await page.goto("/");
    await expect(page.getByTestId("protocol-banner")).toContainText("protocol 2");
    await expect(page.getByTestId("auth-recovery")).toBeVisible();
    await expect(page.getByRole("button", { name: "연결·로그인 다시 확인" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "페어링 링크·QR로 등록" })).toHaveCount(0);
    expect(mutations).toEqual([]);
});

test("실제 프로젝트의 worktree 생성은 offline·protocol 불일치에서 이유를 보이고 복구 후 자동 실행하지 않는다", async ({ page }) => {
    const root = mkdtempSync(join(dirname(state().projA), "pwa-worktree-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    await useWorkspaces(project.id);
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
    const panel = page.getByTestId("worktrees-panel");
    await openTool(page, "워크스페이스");
    await openDetails(panel);
    await panel.getByLabel("worktree 이름").fill("blocked-offline");
    const create = panel.getByRole("button", { name: "만들기", exact: true });
    await expect(create).toBeEnabled();
    const mutations: string[] = [];
    page.on("request", (request) => {
        if (request.method() !== "GET" && request.url().includes(`/projects/${project.id}/worktrees`)) mutations.push(request.url());
    });
    try {
        await page.context().setOffline(true);
        await expect(create).toBeDisabled();
        await expect(create).toHaveAttribute("title", /오프라인/);
        await panel.getByLabel("worktree 이름").fill("offline-local-edit");
        expect(mutations).toEqual([]);
    } finally {
        await page.context().setOffline(false);
    }
    await expect(create).toBeEnabled();
    await expect(panel.getByLabel("worktree 이름")).toHaveValue("offline-local-edit");
    expect(mutations).toEqual([]);
    await page.route("**/api/v1/health", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"protocol":2}' }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(create).toBeDisabled();
    await expect(create).toHaveAttribute("title", /protocol 2/);
    expect(mutations).toEqual([]);
});
