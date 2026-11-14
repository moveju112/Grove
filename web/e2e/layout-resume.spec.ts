import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiCall, ensureProjects, login } from "./helpers";
import type { Layout } from "../app/state/layout";

async function seed(page: import("@playwright/test").Page) {
    const { a, b } = await ensureProjects();
    const device = `layout-${randomUUID()}`;
    const layout: Layout = { schema: 1, focused_leaf: "right", root: {
        type: "split", direction: "row", ratio: 0.4, children: [
            { type: "leaf", id: "left", active_tab: "a", tabs: [
                { id: "a", kind: "project", project_id: a.id, resource_id: a.id, title: "A" },
            ] },
            { type: "leaf", id: "right", active_tab: "b", tabs: [
                { id: "b", kind: "project", project_id: b.id, resource_id: b.id, title: "B" },
            ] },
        ],
    } };
    await apiCall("PUT", `/layouts/${device}`, { expected_revision: 0, layout });
    await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
    return { device, layout, a, b };
}

test("서버에 아직 저장하지 못한 탭·분할 방향·비율·활성 pane을 새로고침 뒤 복원한다", async ({ page }) => {
    const { device, a } = await seed(page);
    // 변경 요청은 서버 접수 전에 끊는다. 서버 배치는 계속 이전 버전이다.
    await page.route(`**/api/v1/layouts/${device}`, (route) =>
        route.request().method() === "PUT" ? route.abort("failed") : route.continue());
    await login(page);
    const divider = page.getByRole("separator");
    await divider.press("ArrowRight");
    await divider.dblclick();
    await page.getByTestId("pane").first().locator(".tabbar").getByRole("tab").click();
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await expect(page.getByTestId("pane").first().locator(".tabbar").getByRole("tab", { selected: true })).toContainText("설정");
    await page.reload();
    await expect(page.getByTestId("split-column")).toBeVisible();
    await expect(page.getByRole("separator")).toHaveAttribute("aria-valuenow", "45");
    await expect(page.getByTestId("pane").first()).toHaveClass(/focused/);
    await expect(page.getByTestId("pane").first().locator(".tabbar").getByRole("tab", { selected: true })).toContainText("설정");
    await page.getByTestId("pane").first().locator(".tab-title").filter({ hasText: "대화 목록" }).click();
    await expect(page.getByTestId("pane").first().getByLabel("메시지 입력")).toBeEnabled();
    const server = await apiCall<{ revision: number; layout: Layout }>("GET", `/layouts/${device}`);
    expect(server.revision).toBe(1);
    expect(server.layout.root.type === "split" && server.layout.root.direction).toBe("row");
    expect(server.layout.root.type === "split" && server.layout.root.children[0].type === "leaf"
        && server.layout.root.children[0].tabs[0]?.project_id).toBe(a.id);
});

test("저장 응답이 유실돼도 새로고침 후 같은 요청 키로 결과를 확인한다", async ({ page }) => {
    const { device } = await seed(page);
    const attempts: { key: string; body: unknown }[] = [];
    let lost = false;
    await page.route(`**/api/v1/layouts/${device}`, async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        attempts.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() });
        if (!lost) {
            lost = true;
            await route.fetch();
            await route.abort("failed");
        } else await route.continue();
    });
    await login(page);
    await page.getByRole("separator").press("ArrowRight");
    await expect(page.getByRole("status").filter({ hasText: "배치를 서버에 저장하지 못했습니다" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("separator")).toHaveAttribute("aria-valuenow", "45");
    await expect.poll(() => attempts.length).toBe(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect.poll(async () => {
        const copy = await page.evaluate((key) => JSON.parse(localStorage.getItem(`grove.layout.${key}`)!), device);
        return copy.dirty;
    }).toBe(false);
    const server = await apiCall<{ revision: number }>("GET", `/layouts/${device}`);
    expect(server.revision).toBe(2);
});

test("좁은 화면을 다녀와도 미반영 넓은 화면 배치와 각 기기의 revision을 섞지 않는다", async ({ page }) => {
    const { device } = await seed(page);
    await page.route(`**/api/v1/layouts/${device}`, (route) =>
        route.request().method() === "PUT" ? route.abort("failed") : route.continue());
    await login(page);
    await page.getByRole("separator").press("ArrowLeft");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-testid="pane"]:visible')).toHaveCount(1);
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    // 좁은 화면의 단일 탭 줄은 숨기므로 현재 탭은 상단 바의 현재 위치로 확인한다.
    await expect(page.getByTestId("navigation-context").locator('[aria-current="page"]')).toHaveText("설정");
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.locator('[data-testid="pane"]:visible')).toHaveCount(2);
    await expect(page.getByRole("separator")).toHaveAttribute("aria-valuenow", "35");
    const narrow = await page.evaluate((key) => JSON.parse(localStorage.getItem(`grove.layout.${key}-narrow`)!), device);
    expect(narrow.layout.root.tabs[0].kind).toBe("settings");
    expect(narrow.revision).toBeLessThan(2);
});
