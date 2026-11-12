import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiCall, ensureProfile, ensureProjects, login } from "./helpers";
import { leaves, type Layout } from "../app/state/layout";

async function setup(page: Page) {
    const { a } = await ensureProjects();
    await ensureProfile();
    const make = (title: string) => apiCall<{ id: string; title: string }>("POST", `/projects/${a.id}/sessions`, { title });
    const [one, two, three] = await Promise.all([make(`dnd-one-${randomUUID()}`), make(`dnd-two-${randomUUID()}`), make(`dnd-recent-${randomUUID()}`)]);
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: three.id, title: three.title });
    const device = `dnd-${randomUUID()}`;
    const layout: Layout = { schema: 1, focused_leaf: "left", root: {
        type: "split", direction: "row", ratio: 0.5, children: [
            { type: "leaf", id: "left", active_tab: "one", tabs: [
                { id: "one", kind: "session", project_id: a.id, resource_id: one.id, title: one.title },
                { id: "two", kind: "session", project_id: a.id, resource_id: two.id, title: two.title },
            ] },
            { type: "leaf", id: "right", active_tab: "project", tabs: [{ id: "project", kind: "project", project_id: a.id, resource_id: a.id, title: a.name }] },
        ],
    } };
    await apiCall("PUT", `/layouts/${device}`, { expected_revision: 0, layout });
    await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
    await login(page);
    const left = page.locator('[data-leaf="left"]');
    const right = page.locator('[data-leaf="right"]');
    await expect(left.getByTestId("session-view")).toBeVisible();
    const saved = async () => (await apiCall<{ layout: Layout }>("GET", `/layouts/${device}`)).layout;
    return { one, two, three, left, right, saved };
}

async function dropAt(page: Page, source: Locator, pane: Locator, fx: number, fy: number) {
    const box = (await pane.boundingBox())!;
    await source.dragTo(pane, { targetPosition: { x: box.width * fx, y: box.height * fy } });
}

const tabIds = (l: Layout) => leaves(l.root).map((leaf) => leaf.tabs.map((t) => t.id));

test("탭은 키보드·메뉴·drag로 순서를 바꾸거나 다른 영역·새 분할로 옮겨도 같은 탭과 초안을 유지한다", async ({ page }) => {
    const { one, two, left, right, saved } = await setup(page);
    const title = (t: { title: string }) => page.locator(".tab-title", { hasText: t.title });
    await left.getByLabel("메시지 입력").fill("옮겨도 남는 초안");

    // 키보드: 두 번째 탭을 앞으로.
    await title(two).focus();
    await page.keyboard.press("Alt+Shift+ArrowLeft");
    await expect.poll(async () => tabIds(await saved())).toEqual([["two", "one"], ["project"]]);

    // drag: 첫 탭을 오른쪽 영역의 오른쪽 가장자리로 → 새 분할.
    await dropAt(page, title(one), right, 0.92, 0.5);
    const moved = page.locator(`[data-testid=session-view][data-session="${one.id}"]`);
    await expect(moved).toBeVisible();
    await expect(moved.getByLabel("메시지 입력")).toHaveValue("옮겨도 남는 초안");
    await expect(page.getByTestId("pane")).toHaveCount(3);
    await expect.poll(async () => tabIds(await saved())).toEqual([["two"], ["project"], ["one"]]);

    // drag: 가운데로 놓으면 그 영역의 탭이 된다(빈 영역은 닫힘).
    await dropAt(page, title(one), right, 0.5, 0.6);
    await expect(page.getByTestId("pane")).toHaveCount(2);
    await expect.poll(async () => tabIds(await saved())).toEqual([["two"], ["project", "one"]]);

    // 메뉴: 현재 탭을 아래 새 영역으로.
    await right.getByLabel("탭 이동").selectOption({ label: "아래 새 영역으로" });
    await expect(page.getByTestId("pane")).toHaveCount(3);
    await expect.poll(async () => tabIds(await saved())).toEqual([["two"], ["project"], ["one"]]);
    await expect(page.locator(`[data-testid=session-view][data-session="${one.id}"]`).getByLabel("메시지 입력")).toHaveValue("옮겨도 남는 초안");
    // 영역의 유일한 탭은 자기 영역 분할 메뉴를 제공하지 않는다.
    await expect(left.getByLabel("탭 이동").locator("option", { hasText: "새 영역으로" })).toHaveCount(0);
});

test("최근 항목을 영역 가장자리로 끌면 새 분할에 열고 잘못된 외부 drag 데이터는 무시한다", async ({ page }) => {
    const { three, right, saved } = await setup(page);
    const item = page.getByTestId("recent-item").filter({ hasText: three.title }).getByRole("button").first();
    await dropAt(page, item, right, 0.5, 0.92);
    await expect(page.locator(`[data-testid=session-view][data-session="${three.id}"]`)).toBeVisible();
    await expect(page.getByTestId("pane")).toHaveCount(3);
    await expect.poll(async () => (await saved()).root).toMatchObject({ children: [{}, { type: "split", direction: "column" }] });

    // 다른 페이지가 흉내낸 데이터: 형식이 틀리면 탭을 만들지 않는다.
    const before = tabIds(await saved());
    await right.evaluate((pane) => {
        const data = new DataTransfer();
        data.setData("application/x-grove-open", JSON.stringify({ kind: "settings", project_id: "../../x", resource_id: "a/b", title: "x" }));
        pane.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
        pane.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    await expect(page.getByTestId("drop-zone")).toHaveCount(0);
    expect(tabIds(await saved())).toEqual(before);
});
