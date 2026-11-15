import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login } from "./helpers";

// UI-008·009: 위를 읽는 중에는 새 메시지가 와도 위치를 지키고 알림만 띄우며, 이전 페이지를 붙여도 읽던 위치를 유지한다.
test("과거 메시지를 읽는 동안 자동 스크롤하지 않고, 이전 페이지를 불러와도 읽던 메시지가 그 자리에 남는다", async ({ page }) => {
    const { a } = await ensureProjects();
    const title = `스크롤 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    for (let i = 0; i < 160; i++) await apiCall("POST", `/sessions/${s.id}/messages`, { text: `줄 ${i}` });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    const body = page.getByTestId("pane-body").filter({ has: view });
    // 처음엔 맨 아래
    await expect(view.getByText("줄 159", { exact: true })).toBeInViewport();

    // 위로 올라가 읽는 중 새 메시지
    await body.evaluate((el) => (el.scrollTop = 0));
    await expect(view.getByRole("button", { name: "이전 메시지" })).toBeInViewport();
    const anchor = view.getByText("줄 60", { exact: true });
    await anchor.scrollIntoViewIfNeeded();
    const top = await body.evaluate((el) => el.scrollTop);
    await apiCall("POST", `/sessions/${s.id}/messages`, { text: "새로 온 글" });
    await expect(view.getByTestId("new-below")).toBeVisible();
    expect(Math.abs((await body.evaluate((el) => el.scrollTop)) - top)).toBeLessThan(5);
    await expect(anchor).toBeInViewport();

    // 이전 페이지: 읽던 메시지(줄 60)가 그대로 화면에 남는다
    const before = await anchor.boundingBox();
    await body.evaluate((el) => (el.scrollTop = 0));
    const first = view.getByText("줄 60", { exact: true });
    await first.scrollIntoViewIfNeeded();
    const y0 = (await first.boundingBox())!.y;
    await view.getByRole("button", { name: "이전 메시지" }).click();
    await expect(view.getByRole("button", { name: "이전 메시지", exact: true })).toHaveCount(0);
    await expect.poll(async () => Math.abs((await first.boundingBox())!.y - y0)).toBeLessThan(60);
    expect(before).not.toBeNull();

    // 알림을 누르면 맨 아래로, 알림은 사라짐
    await view.getByTestId("new-below").click();
    await expect(view.getByText("새로 온 글", { exact: true })).toBeInViewport();
    await expect(view.getByTestId("new-below")).toHaveCount(0);
    // 맨 아래에 있으면 새 글을 따라간다
    await apiCall("POST", `/sessions/${s.id}/messages`, { text: "따라갈 글" });
    await expect(view.getByText("따라갈 글", { exact: true })).toBeInViewport();
    await expect(view.getByTestId("new-below")).toHaveCount(0);
});

test("다른 탭을 다녀와도 이전 페이지의 읽던 메시지와 화면 내 위치를 복원한다", async ({ page }) => {
    const { a } = await ensureProjects();
    const prefix = `position-${Date.now()}`;
    const reading = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `${prefix} reading` });
    const other = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `${prefix} other` });
    for (let i = 0; i < 180; i++) await apiCall("POST", `/sessions/${reading.id}/messages`, { text: `${prefix} line ${i}` });
    await apiCall("POST", `/sessions/${other.id}/messages`, { text: "other tab fixture" });
    for (const session of [other, reading]) await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`${prefix} reading`) }).click();
    const view = page.locator(`[data-testid=session-view][data-session="${reading.id}"]`);
    await view.getByRole("button", { name: "이전 메시지", exact: true }).click();
    await expect(view.getByRole("button", { name: "이전 메시지", exact: true })).toHaveCount(0);
    await view.getByRole("feed", { name: "불러온 대화 메시지" }).focus();
    await page.keyboard.press("Home");
    for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowDown");
    const target = view.getByText(`${prefix} line 20`, { exact: true });
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeInViewport();
    const y = (await target.boundingBox())!.y;
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`${prefix} other`) }).click();
    await expect(page.getByText("other tab fixture", { exact: true })).toBeVisible();
    await page.getByRole("tablist").getByTestId("tab-title").filter({ hasText: `${prefix} reading` }).click();
    await expect(target).toBeInViewport();
    await expect.poll(async () => Math.abs((await target.boundingBox())!.y - y)).toBeLessThan(8);
    await page.getByRole("tab", { selected: true }).getByRole("button", { name: "탭 닫기", exact: true }).click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`${prefix} reading`) }).click();
    await expect(target).toBeInViewport();
    await expect.poll(async () => Math.abs((await target.boundingBox())!.y - y)).toBeLessThan(8);
});

test("앱을 닫았다 다시 열어도(탭 저장소 없음) 대화의 마지막 읽던 위치를 복원한다", async ({ page, browser }) => {
    const { a } = await ensureProjects();
    const prefix = `restart-${Date.now()}`;
    const reading = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `${prefix} reading` });
    for (let i = 0; i < 120; i++) await apiCall("POST", `/sessions/${reading.id}/messages`, { text: `${prefix} line ${i}` });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: reading.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`${prefix} reading`) }).click();
    const view = page.locator(`[data-testid=session-view][data-session="${reading.id}"]`);
    // 첫 페이지는 최근 100개(line 20~119)다. 가상 스크롤이라 화면 밖 메시지는 DOM에 없으므로
    // 키보드로 불러온 첫 메시지(line 20)에서 다섯 칸 내려가 읽던 위치를 만든다.
    const target = view.getByText(`${prefix} line 25`, { exact: true });
    await view.getByRole("feed", { name: "불러온 대화 메시지" }).focus();
    await page.keyboard.press("Home");
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeInViewport();
    await expect.poll(() => page.evaluate((id) => localStorage.getItem(`grove.scroll.session.${id}`), reading.id)).toContain("\"atBottom\":false");
    // 기기 저장소(localStorage·cookie)만 남기고 탭 저장소(sessionStorage)는 버린 새 창 = 앱 종료·process death 뒤 재시작.
    const restarted = await browser.newContext({ storageState: await page.context().storageState() });
    try {
        const again = await restarted.newPage();
        await again.goto("/");
        const token = again.getByLabel("토큰");
        await expect(again.getByTestId("conn").or(token)).toBeVisible();
        if (await token.isVisible()) await login(again);
        await expect(again.getByTestId("conn")).toHaveText("연결됨");
        await again.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`${prefix} reading`) }).click();
        await expect(again.locator(`[data-testid=session-view][data-session="${reading.id}"]`).getByText(`${prefix} line 25`, { exact: true })).toBeInViewport();
        // 직접 로그아웃하면 읽던 위치 사본도 지운다.
        await again.getByRole("button", { name: "설정", exact: true }).first().click();
        await again.getByLabel("설정 검색", { exact: true }).fill("로그아웃");
        await again.getByRole("button", { name: "이 브라우저에서 로그아웃" }).click();
        await expect.poll(() => again.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("grove.scroll.")))).toEqual([]);
    } finally {
        await restarted.close();
    }
});
