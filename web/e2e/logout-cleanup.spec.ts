import { expect, test, type Page } from "@playwright/test";
import { apiCall, ensureProjects, login } from "./helpers";

// UI-032: 로그아웃하면 이 기기에 남긴 대화 사본·배치를 지우고, 만료면 다시 로그인해 이어 쓰도록 남긴다.
const keys = (page: Page) => page.evaluate(() => Object.keys(localStorage).sort());

async function typeDraft(page: Page, title: string, text: string) {
    const { a } = await ensureProjects();
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    await page.getByTestId("session-view").getByLabel("메시지 입력").fill(text);
    expect((await keys(page)).some((k) => k.startsWith("grove.draft."))).toBe(false);
}

test("로그아웃하면 기기 내 대화 사본·배치를 지우고 기기 설정은 남긴다", async ({ page }) => {
    await typeDraft(page, `정리 대화 ${Date.now()}`, "민감한 초안 내용");
    await page.evaluate(() => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme: "soft" })));
    expect((await keys(page)).some((k) => k.startsWith("grove.layout."))).toBe(true);
    await page.getByTestId("sidebar").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("로그아웃");
    await page.getByRole("button", { name: "이 브라우저에서 로그아웃" }).click();
    await expect(page.getByRole("form", { name: "로그인" })).toBeVisible();
    await expect(page.getByTestId("auth-expired")).toHaveCount(0);
    const left = await keys(page);
    expect(left.filter((k) => k.startsWith("grove.draft.") || k.startsWith("grove.layout.") || k === "grove.composer.options")).toEqual([]);
    expect(left).toContain("grove.device.prefs");
    expect(left).toContain("grove.device.id");
    // 화면에도 이전 대화 내용이 남지 않는다
    await expect(page.getByText("민감한 초안 내용")).toHaveCount(0);
    await page.evaluate(() => localStorage.removeItem("grove.device.prefs"));
});

test("인증 만료 뒤 다시 로그인해도 미전송 입력은 저장하거나 복원하지 않는다", async ({ page }) => {
    const title = `만료 대화 ${Date.now()}`;
    await typeDraft(page, title, "만료돼도 남을 초안");
    await page.route("**/api/v1/auth/refresh", (r) => r.fulfill({ status: 401, body: "" }));
    await page.route("**/api/v1/**", (r) => (r.request().url().includes("/auth/") ? r.fallback() : r.fulfill({ status: 401, body: "" })));
    await page.getByTestId("sidebar").getByRole("button", { name: "설정", exact: true }).click();
    await expect(page.getByTestId("auth-expired")).toBeVisible({ timeout: 10_000 });
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("grove.scroll.")))).toEqual([]);
    expect((await keys(page)).some((k) => k.startsWith("grove.draft."))).toBe(false);
    await page.unrouteAll();
    // 가짜 만료를 걷어 내면 refresh 쿠키로 다시 로그인된다
    await page.reload();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    await expect(page.getByTestId("session-view").getByLabel("메시지 입력")).toHaveValue("");
});
