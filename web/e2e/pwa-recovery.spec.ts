import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login, sessionView, state } from "./helpers";

test("오프라인 cold start는 인증 전 초안을 숨기고 삭제 없이 명시적인 온라인 복구를 안내한다", async ({ page }) => {
    const { a } = await ensureProjects();
    const title = `Cold start ${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    const view = sessionView(page, session.id);
    const privateText = "인증 전에는 보이면 안 되는 기존 초안";
    await view.getByLabel("메시지 입력").fill(privateText);
    const drafts = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage)
        .filter((key) => key.startsWith("grove.draft.")).map((key) => [key, localStorage.getItem(key)])));
    await expect.poll(async () => JSON.stringify(await drafts())).toContain(privateText);
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
        await expect(page.getByTestId("auth-recovery")).toContainText("기존 초안을 삭제하지 않았습니다");
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
    await expect(page.getByLabel("토큰")).toBeVisible();
    expect(mutations.map((url) => new URL(url).pathname)).toEqual(["/api/v1/auth/refresh"]);
    expect(await drafts()).toEqual(before);
    await page.getByLabel("토큰").fill(state().token);
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(page.getByTestId("conn")).toHaveText("연결됨");
    await expect(sessionView(page, session.id).getByLabel("메시지 입력")).toHaveValue(privateText);
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
    await expect(page.getByLabel("토큰")).toHaveCount(0);
    expect(mutations).toEqual([]);
});
