import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login } from "./helpers";

async function sessions() {
    const { a, b } = await ensureProjects();
    const prefix = `recent-navigation-${Date.now()}`;
    const first = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `${prefix} first` });
    const second = await apiCall<{ id: string }>("POST", `/projects/${b.id}/sessions`, { title: `${prefix} second` });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: first.id });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: b.id, resource_id: second.id });
    return { prefix, first, second };
}

test("고정 항목을 먼저 표시하고 고정 해제하면 최근 접근순으로 돌아가며 새로고침 뒤에도 유지된다", async ({ page }) => {
    const { prefix } = await sessions();
    await login(page);
    const recent = page.locator(".recent");
    const search = recent.getByLabel("최근 항목 검색");
    await expect(search).toBeHidden();
    await recent.getByLabel("최근 검색·필터", { exact: true }).click();
    await search.fill(prefix);
    const items = recent.getByTestId("recent-item");
    const first = items.filter({ hasText: `${prefix} first` });
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText(`${prefix} second`);
    await expect(first.getByRole("button", { name: "고정", exact: true })).toBeHidden();
    await first.getByLabel("최근 항목 관리", { exact: true }).focus();
    await page.keyboard.press("Enter");
    await first.getByRole("button", { name: "고정", exact: true }).click();
    await expect(first.getByRole("button", { name: "고정 해제", exact: true })).toBeVisible();
    await expect(items.first()).toContainText(`${prefix} first`);
    await page.reload();
    await expect(page.getByTestId("conn")).toHaveText("연결됨");
    await recent.getByLabel("최근 검색·필터", { exact: true }).click();
    await search.fill(prefix);
    await expect(items.first()).toContainText(`${prefix} first`);
    await recent.getByLabel("최근 필터", { exact: true }).selectOption("pinned");
    await expect(items).toHaveCount(1);
    await recent.getByLabel("최근 검색·필터", { exact: true }).click();
    await expect(recent.getByLabel("최근 검색·필터", { exact: true })).toContainText("고정");
    await expect(search).toBeHidden();
    await first.getByLabel("최근 항목 관리", { exact: true }).click();
    await first.getByRole("button", { name: "고정 해제", exact: true }).click();
    await expect(items).toHaveCount(0);
    await recent.getByLabel("최근 검색·필터", { exact: true }).click();
    await recent.getByLabel("최근 필터", { exact: true }).selectOption("all");
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText(`${prefix} second`);
});

test("최근 항목은 다른 pane의 열린 탭으로 이동하고 명시적인 분할만 새 사본을 만든다", async ({ page }) => {
    const { prefix, first, second } = await sessions();
    await login(page);
    const recent = page.locator(".recent");
    const firstItem = recent.getByTestId("recent-item").filter({ hasText: `${prefix} first` });
    const secondItem = recent.getByTestId("recent-item").filter({ hasText: `${prefix} second` });
    const touched = (id: string, seen: boolean) => page.waitForResponse((r) =>
        r.url().endsWith("/api/v1/recent/touch") && r.request().method() === "POST"
        && r.request().postDataJSON().resource_id === id && (r.request().postDataJSON().view_state !== undefined) === seen);
    const firstSeen = touched(first.id, true);
    await firstItem.getByRole("button", { name: new RegExp(`${prefix} first`) }).click();
    await firstSeen;
    const firstView = page.locator(`[data-testid=session-view][data-session="${first.id}"]`);
    const secondView = page.locator(`[data-testid=session-view][data-session="${second.id}"]`);
    await firstView.getByLabel("메시지 입력").fill("first pane draft fixture");
    const secondSeen = touched(second.id, true);
    await secondItem.getByLabel("최근 항목 관리", { exact: true }).click();
    await secondItem.getByRole("button", { name: "오른쪽에 열기", exact: true }).click();
    await secondSeen;
    await expect(page.getByTestId("pane")).toHaveCount(2);
    await secondView.getByLabel("메시지 입력").fill("second pane draft fixture");
    const access = touched(first.id, false);
    await firstItem.getByRole("button", { name: new RegExp(`${prefix} first`) }).click();
    await access;
    await expect(recent.getByTestId("recent-item").first()).toContainText(`${prefix} first`);
    await expect(firstView).toHaveCount(1);
    await expect(firstView.getByLabel("메시지 입력")).toHaveValue("first pane draft fixture");
    await expect(secondView.getByLabel("메시지 입력")).toHaveValue("second pane draft fixture");
    await expect(page.locator(".pane.focused").filter({ has: firstView })).toHaveCount(1);
    await expect(page.locator(".tabbar .tab")).toHaveCount(2);
    await firstItem.getByLabel("최근 항목 관리", { exact: true }).click();
    await firstItem.getByRole("button", { name: "오른쪽에 열기", exact: true }).click();
    await expect(page.getByTestId("pane")).toHaveCount(3);
    await expect(firstView).toHaveCount(2);
    const copy = page.locator(".pane.focused").getByLabel("메시지 입력");
    await copy.fill("explicit copy draft fixture");
    await firstItem.getByRole("button", { name: new RegExp(`${prefix} first`) }).click();
    await expect(page.locator(".pane.focused").getByLabel("메시지 입력")).toHaveValue("explicit copy draft fixture");
    await expect(firstView).toHaveCount(2);
    await expect(page.locator(".tabbar .tab")).toHaveCount(3);
});
