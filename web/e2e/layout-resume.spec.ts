import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiCall, ensureProjects, login, openSettings, startProjectConversation } from "./helpers";
import type { Layout } from "../app/state/layout";
import { projectLayoutKey } from "../app/state/projectLayout";

async function seed(page: import("@playwright/test").Page) {
    const { a } = await ensureProjects();
    const device = `layout-${randomUUID()}`;
    const layout: Layout = { schema: 1, focused_leaf: "right", root: {
        type: "split", direction: "row", ratio: 0.4, children: [
            { type: "leaf", id: "left", active_tab: "a", tabs: [
                { id: "a", kind: "project", project_id: a.id, resource_id: a.id, title: "A" },
            ] },
            { type: "leaf", id: "right", active_tab: "b", tabs: [
                { id: "b", kind: "project", project_id: a.id, resource_id: a.id, title: "A 사본" },
            ] },
        ],
    } };
    await apiCall("PUT", `/layouts/${device}`, { expected_revision: 0, layout });
    await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
    const projectDevice = projectLayoutKey(device, a.id);
    await apiCall("PUT", `/layouts/${projectDevice}`, { expected_revision: 0, layout });
    return { device, projectDevice, layout, a };
}

test("서버에 아직 저장하지 못한 탭·분할 방향·비율·활성 pane을 새로고침 뒤 복원한다", async ({ page }) => {
    const { device, projectDevice, a } = await seed(page);
    const title = `복원할 대화 ${device}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    // 변경 요청은 서버 접수 전에 끊는다. 서버 배치는 계속 이전 버전이다.
    await page.route(`**/api/v1/layouts/${projectDevice}`, (route) =>
        route.request().method() === "PUT" ? route.abort("failed") : route.continue());
    await login(page);
    const divider = page.getByRole("separator").and(page.locator("[aria-valuenow]"));
    await divider.press("ArrowRight");
    await divider.dblclick();
    await page.getByTestId("pane").first().getByRole("tablist").getByRole("tab").click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
    await expect(page.getByTestId("pane").first().getByRole("tablist").getByRole("tab", { selected: true })).toContainText(title);
    await expect(page.getByTestId("pane").first()).toHaveAttribute("data-focused", "true");
    await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(`grove.layout.${key}`)!).layout.focused_leaf, projectDevice)).toBe("left");
    await page.reload();
    await expect(page.getByTestId("split-column")).toBeVisible();
    await expect(page.getByRole("separator").and(page.locator("[aria-valuenow]"))).toHaveAttribute("aria-valuenow", "45");
    await expect(page.getByTestId("pane").first()).toHaveAttribute("data-focused", "true");
    await expect(page.getByTestId("pane").first().getByRole("tablist").getByRole("tab", { selected: true })).toContainText(title);
    await page.getByTestId("pane").first().getByTestId("tab-title").filter({ hasText: "새 대화" }).click();
    await startProjectConversation(page.getByTestId("pane").first().getByTestId("project-view"));
    await expect(page.getByTestId("pane").first().getByLabel("메시지 입력")).toBeEnabled();
    const server = await apiCall<{ revision: number; layout: Layout }>("GET", `/layouts/${projectDevice}`);
    expect(server.revision).toBe(1);
    expect(server.layout.root.type === "split" && server.layout.root.direction).toBe("row");
    expect(server.layout.root.type === "split" && server.layout.root.children[0].type === "leaf"
        && server.layout.root.children[0].tabs[0]?.project_id).toBe(a.id);
});

test("저장 응답이 유실돼도 알림 없이 같은 요청 키로 결과를 확인한다", async ({ page }) => {
    const { projectDevice } = await seed(page);
    const attempts: { key: string; body: unknown }[] = [];
    let lost = false;
    await page.route(`**/api/v1/layouts/${projectDevice}`, async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        attempts.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() });
        if (!lost) {
            lost = true;
            await route.fetch();
            await route.abort("failed");
        } else await route.continue();
    });
    await login(page);
    await page.getByRole("separator").and(page.locator("[aria-valuenow]")).press("ArrowRight");
    await expect.poll(() => attempts.length).toBeGreaterThanOrEqual(1);
    // 연결 문제는 연결 토스트 하나로만 알린다. 배치 저장 알림을 따로 띄우지 않는다.
    await expect(page.getByText("배치를 서버에 저장하지 못했습니다")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("separator").and(page.locator("[aria-valuenow]"))).toHaveAttribute("aria-valuenow", "45");
    await expect.poll(() => attempts.length).toBe(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect.poll(async () => {
        const copy = await page.evaluate((key) => JSON.parse(localStorage.getItem(`grove.layout.${key}`)!), projectDevice);
        return copy.dirty;
    }).toBe(false);
    const server = await apiCall<{ revision: number }>("GET", `/layouts/${projectDevice}`);
    expect(server.revision).toBe(2);
});

test("좁은 화면을 다녀와도 미반영 넓은 화면 배치와 각 기기의 revision을 섞지 않는다", async ({ page }) => {
    const { device, projectDevice } = await seed(page);
    await page.route(`**/api/v1/layouts/${projectDevice}`, (route) =>
        route.request().method() === "PUT" ? route.abort("failed") : route.continue());
    await login(page);
    await page.getByRole("separator").and(page.locator("[aria-valuenow]")).press("ArrowLeft");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-testid="pane"]:visible')).toHaveCount(1);
    const before = await page.evaluate((key) => JSON.parse(localStorage.getItem(`grove.layout.${key}-narrow`)!), device);
    await openSettings(page);
    await expect(page.getByRole("dialog", { name: "설정", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.locator('[data-testid="pane"]:visible')).toHaveCount(2);
    await expect(page.getByRole("separator").and(page.locator("[aria-valuenow]"))).toHaveAttribute("aria-valuenow", "35");
    const narrow = await page.evaluate((key) => JSON.parse(localStorage.getItem(`grove.layout.${key}-narrow`)!), device);
    expect(narrow).toEqual(before);
});
