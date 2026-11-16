import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiCall, ensureProfile, ensureProjects, login } from "./helpers";
import { leaves, type Layout } from "../app/state/layout";
import { projectLayoutKey } from "../app/state/projectLayout";

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
    const saved = async () => (await apiCall<{ layout: Layout }>("GET", `/layouts/${projectLayoutKey(device, a.id)}`)).layout;
    await expect.poll(saved).not.toBeNull();
    return { one, two, three, left, right, saved };
}

async function dropAt(page: Page, source: Locator, pane: Locator, fx: number, fy: number) {
    const box = (await pane.boundingBox())!;
    await source.dragTo(pane, { targetPosition: { x: box.width * fx, y: box.height * fy } });
}

const tabIds = (l: Layout) => leaves(l.root).map((leaf) => leaf.tabs.map((t) => t.id));

test("옆 분할의 탭 이름과 탭 줄 빈 곳은 새 분할 없이 탭을 옮기고 순서를 바꾼다", async ({ page }) => {
    const { one, two, left, right, saved } = await setup(page);
    const title = (t: { title: string }) => page.getByTestId("tab-title").filter({ hasText: t.title });
    await left.getByLabel("메시지 입력").fill("탭 줄로 옮겨도 남는 초안");

    const dragOver = async (source: Locator, target: Locator, x?: number) => {
        const from = (await source.boundingBox())!;
        const to = (await target.boundingBox())!;
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 5 });
        await page.mouse.move(to.x + (x ?? to.width / 2), to.y + to.height / 2, { steps: 10 });
        await page.mouse.move(to.x + (x ?? to.width / 2), to.y + to.height / 2);
        await expect(page.locator('[data-testid="drop-zone"]:not([data-zone="center"])')).toHaveCount(0);
        await page.mouse.up();
    };

    await dragOver(title(one), right.getByTestId("tab-title"));
    await expect.poll(async () => tabIds(await saved())).toEqual([["two"], ["one", "project"]]);
    await expect(page.getByTestId("pane")).toHaveCount(2);
    await expect(right.getByLabel("메시지 입력")).toHaveValue("탭 줄로 옮겨도 남는 초안");

    const list = left.getByRole("tablist");
    const listBox = (await list.boundingBox())!;
    const lastTab = (await left.getByRole("tab").last().boundingBox())!;
    expect(listBox.x + listBox.width - 2).toBeGreaterThan(lastTab.x + lastTab.width);
    await dragOver(title(one), list, listBox.width - 2);
    await expect.poll(async () => tabIds(await saved())).toEqual([["two", "one"], ["project"]]);
    await expect(page.getByTestId("pane")).toHaveCount(2);
    await expect(left.getByLabel("메시지 입력")).toHaveValue("탭 줄로 옮겨도 남는 초안");

    await dragOver(title(one), title(two));
    await expect.poll(async () => tabIds(await saved())).toEqual([["one", "two"], ["project"]]);
});

test("탭은 키보드·drag로 순서를 바꾸거나 다른 영역·새 분할로 옮겨도 같은 탭과 초안을 유지한다", async ({ page }) => {
    const { one, two, left, right, saved } = await setup(page);
    const title = (t: { title: string }) => page.getByTestId("tab-title").filter({ hasText: t.title });
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

    // 같은 영역의 아래 가장자리로 끌어 현재 탭을 새 영역으로 옮긴다.
    await dropAt(page, title(one), right, 0.5, 0.92);
    await expect(page.getByTestId("pane")).toHaveCount(3);
    await expect.poll(async () => tabIds(await saved())).toEqual([["two"], ["project"], ["one"]]);
    await expect(page.locator(`[data-testid=session-view][data-session="${one.id}"]`).getByLabel("메시지 입력")).toHaveValue("옮겨도 남는 초안");
    await expect(page.getByRole("combobox", { name: "탭 이동", exact: true })).toHaveCount(0);
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
