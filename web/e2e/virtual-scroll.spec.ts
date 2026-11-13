import { expect, test } from "@playwright/test";
import { apiCall, ensureProfile, ensureProjects, login, script } from "./helpers";
import { frames } from "./fixture";

test("긴 대화의 이전 페이지를 계속 불러와도 렌더링한 메시지 수는 viewport 크기에 머문다", async ({ page }) => {
    const { a } = await ensureProjects();
    const title = `virtual-${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    for (let i = 0; i < 450; i++) {
        await apiCall("POST", `/sessions/${session.id}/messages`, { text: `${title} line ${i}${i % 9 === 0 ? "\nvariable height fixture".repeat(12) : ""}` });
    }
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).click();
    const view = page.getByTestId("session-view");
    await expect(view.getByText(`${title} line 449`, { exact: true })).toBeInViewport();
    await expect.poll(() => view.locator(".msg-row").count()).toBeLessThan(80);
    for (let i = 0; i < 4; i++) {
        const response = page.waitForResponse((r) => r.url().includes(`/sessions/${session.id}/messages?`) && r.url().includes("before_seq="));
        await view.getByRole("button", { name: "이전 메시지", exact: true }).click();
        await response;
        await expect.poll(() => view.locator(".msg-row").count()).toBeLessThan(80);
    }
    await expect(view.getByRole("button", { name: "이전 메시지", exact: true })).toHaveCount(0);
    const body = page.locator(".pane-body").filter({ has: view });
    await body.evaluate((el) => { el.scrollTop = 0; });
    await expect(view.getByText(`${title} line 0`, { exact: false })).toBeInViewport();
    await expect.poll(() => view.locator(".msg-row").count()).toBeLessThan(80);
    await view.getByRole("feed", { name: "불러온 대화 메시지" }).focus();
    await page.keyboard.press("End");
    await expect(view.locator('[data-virtual-seq="450"]')).toBeFocused();
    await expect(view.getByText(`${title} line 449`, { exact: true })).toBeInViewport();
    await page.keyboard.press("ArrowUp");
    await expect(view.locator('[data-virtual-seq="449"]')).toBeFocused();
});

test("생각 과정을 본문에 표시한 상태는 화면 밖으로 나가도 유지되고 폭이 바뀌어도 읽던 위치를 지킨다", async ({ page }) => {
    const { a } = await ensureProjects();
    const profile = await ensureProfile();
    const title = `virtual-details-${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await script({ frames: frames.reasoning("가변 높이의 긴 생각 과정과 줄바꿈을 확인한다. ".repeat(100), "가상 스크롤의 답") });
    const accepted = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: "reasoning fixture", profile_id: profile });
    await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${accepted.turn.id}`)).status).toBe("completed");
    for (let i = 0; i < 160; i++) await apiCall("POST", `/sessions/${session.id}/messages`, { text: `details filler ${i}` });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("대화 표시");
    await page.getByLabel("생각 과정 표시").selectOption("expanded");
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).click();
    const view = page.getByTestId("session-view");
    const feed = view.getByRole("feed", { name: "불러온 대화 메시지" });
    await view.getByRole("button", { name: "이전 메시지", exact: true }).click();
    await expect(view.getByRole("button", { name: "이전 메시지", exact: true })).toHaveCount(0);
    await feed.focus();
    await page.keyboard.press("Home");
    const reasoning = view.getByTestId("msg-reasoning");
    await expect(reasoning.getByText("가변 높이의 긴 생각 과정과 줄바꿈을 확인한다.", { exact: false })).toBeVisible();
    await feed.focus();
    await page.keyboard.press("End");
    await expect(view.getByText("details filler 159", { exact: true })).toBeInViewport();
    await expect(reasoning).toHaveCount(0);
    await page.keyboard.press("Home");
    await expect(reasoning.getByText("가변 높이의 긴 생각 과정과 줄바꿈을 확인한다.", { exact: false })).toBeVisible();
    const body = page.locator(".pane-body").filter({ has: view });
    const article = reasoning.locator("xpath=ancestor::*[@data-virtual-id]");
    await body.evaluate((el) => { el.scrollTop += 250; });
    await expect(article).toBeInViewport();
    const before = (await article.boundingBox())!;
    await page.setViewportSize({ width: 1000, height: page.viewportSize()!.height });
    await expect.poll(async () => (await article.boundingBox())!.height).toBeGreaterThan(before.height);
    await expect.poll(async () => Math.abs((await article.boundingBox())!.y - before.y)).toBeLessThan(3);
    await expect.poll(() => view.locator(".msg-row").count()).toBeLessThan(80);
});
