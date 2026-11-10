import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login } from "./helpers";

// UI-008·009: 위를 읽는 중에는 새 메시지가 와도 위치를 지키고 알림만 띄우며, 이전 페이지를 붙여도 읽던 위치를 유지한다.
test("과거 메시지를 읽는 동안 자동 스크롤하지 않고, 이전 페이지를 불러와도 읽던 메시지가 그 자리에 남는다", async ({ page }) => {
    test.setTimeout(60_000);
    const { a } = await ensureProjects();
    const title = `스크롤 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    for (let i = 0; i < 160; i++) await apiCall("POST", `/sessions/${s.id}/messages`, { text: `줄 ${i}` });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    const body = page.locator(".pane-body").filter({ has: view });
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
    await expect(view.getByText("줄 0", { exact: true })).toHaveCount(1);
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
