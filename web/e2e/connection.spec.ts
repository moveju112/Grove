import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login } from "./helpers";

// UI-027: 연결 중·연결됨·서버 연결 끊김(재시도 시간)·네트워크 오프라인·재연결·인증 만료 표시.
test("이벤트 연결이 끊기면 재시도 시간을 보이고, 지금 재연결과 네트워크 복구로 다시 붙는다", async ({ page }) => {
    const { a } = await ensureProjects();
    for (const title of ["연결 상태 대화", "연결 상태 둘째"]) {
        const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    }
    await login(page);
    const conn = page.getByTestId("conn");
    await expect(conn).toHaveText("연결됨");

    // 서버 연결 실패: 이벤트 요청을 끊는다. 대화를 열면 구독이 바뀌어 다시 연결하다 실패한다.
    let block = true;
    await page.route("**/api/v1/events?**", (r) => (block ? r.abort("connectionrefused") : r.continue()));
    await page.locator(".recent").getByRole("button", { name: /연결 상태 대화/ }).first().click();
    await expect(conn).toContainText(/서버 연결 끊김 · \d+초 후 재시도/);
    await expect(conn).toHaveClass(/offline/);
    block = false;
    await conn.getByRole("button", { name: "지금 재연결" }).click();
    await expect(conn).toHaveText("연결됨");

    // 네트워크 오프라인: 브라우저가 오프라인이면 네트워크 없음으로 보이고, 복구 이벤트로 바로 다시 붙는다.
    block = true;
    await page.context().setOffline(true);
    // 다른 대화를 열어 구독을 바꾸면 다시 연결하다 실패한다
    await page.locator(".recent").getByRole("button", { name: /연결 상태 둘째/ }).first().click();
    await expect(conn).toContainText("오프라인 · 네트워크 없음");
    block = false;
    await page.context().setOffline(false);
    await expect(conn).toHaveText("연결됨", { timeout: 10_000 });
});

test("refresh가 거부되면 재시도를 멈추고 로그인 화면에서 만료를 안내한다", async ({ page }) => {
    await ensureProjects();
    await login(page);
    await expect(page.getByTestId("conn")).toHaveText("연결됨");
    // access token이 만료되고 refresh도 거부되는 상황
    await page.route("**/api/v1/events?**", (r) => r.fulfill({ status: 401, contentType: "application/json", body: '{"error":{"code":"unauthorized","message":"expired"}}' }));
    await page.route("**/api/v1/auth/refresh", (r) => r.fulfill({ status: 401, contentType: "application/json", body: '{"error":{"code":"unauthorized","message":"expired"}}' }));
    let events = 0;
    page.on("request", (r) => {
        if (r.url().includes("/api/v1/events?")) events += 1;
    });
    // 구독을 바꿔 다시 연결하게 한다
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.route("**/api/v1/**", (r) => (r.request().url().includes("/auth/") || r.request().url().includes("/events?") ? r.fallback() : r.fulfill({ status: 401, body: "" })));
    await expect(page.getByRole("form", { name: "로그인" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("auth-expired")).toContainText("로그인이 만료");
    const n = events;
    await page.waitForTimeout(1500);
    expect(events, "만료 뒤에는 이벤트 재연결을 반복하지 않는다").toBe(n);
});
