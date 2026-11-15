import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiCall, ensureProfile, ensureProjects, login, openDetails } from "./helpers";
import type { Layout } from "../app/state/layout";

// RECENT-001: 원본 최근 탭의 시간 범위·숨김 후 재표시·분할 묶음·경과 시간 흐름을 유지한다.
test("시간 범위 밖 항목은 기본 4시간에서 빠지고 넓은 범위·전체·고정에서는 보이며 선택을 기억한다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const old = await apiCall<{ id: string; title: string }>("POST", `/projects/${a.id}/sessions`, { title: `range-old-${randomUUID()}` });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: old.id });
    // 이 기기 시계를 5시간 뒤로 두면 방금 연 항목은 4시간 범위 밖, 12시간 범위 안이다.
    await page.clock.install({ time: new Date(Date.now() + 5 * 3_600_000) });
    await login(page);
    const recent = page.getByRole("region", { name: "최근", exact: true });
    const ranges = recent.getByRole("group", { name: "시간 범위" });
    await expect(ranges.getByRole("button", { name: "최근 4시간 범위" })).toHaveAttribute("aria-pressed", "true");
    const row = recent.getByTestId("recent-item").filter({ hasText: old.title });
    await expect(row).toHaveCount(0);
    await ranges.getByRole("button", { name: "최근 12시간 범위" }).click();
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("recent-time")).toHaveText(/5시간 전/);
    await page.reload();
    await expect(recent.getByRole("group", { name: "시간 범위" }).getByRole("button", { name: "최근 12시간 범위" })).toHaveAttribute("aria-pressed", "true");
    await expect(row).toHaveCount(1);
    // 고정 항목은 범위와 무관하게 보인다.
    await row.getByRole("button", { name: "최근 항목 관리", exact: true }).click();
    await page.getByRole("dialog", { name: "최근 항목 관리", exact: true }).getByRole("button", { name: "고정", exact: true }).click();
    await ranges.getByRole("button", { name: "최근 30분 범위" }).click();
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "최근 항목 관리", exact: true }).click();
    await page.getByRole("dialog", { name: "최근 항목 관리", exact: true }).getByRole("button", { name: "고정 해제", exact: true }).click();
    await expect(row).toHaveCount(0);
    await ranges.getByRole("button", { name: "최근 전체 범위" }).click();
    await expect(row).toHaveCount(1);
});

test("다른 기기가 먼저 고정해도 이 기기의 숨김은 오류 없이 그 필드만 다시 적용하고 고정을 유지한다(RECENT-006)", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const s = await apiCall<{ id: string; title: string }>("POST", `/projects/${a.id}/sessions`, { title: `devices-${randomUUID()}` });
    const touched = await apiCall<{ id: string; revision: number }>("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    const recent = page.getByRole("region", { name: "최근", exact: true });
    const row = recent.getByTestId("recent-item").filter({ hasText: s.title });
    await expect(row).toHaveCount(1);
    const sent: unknown[] = [];
    await page.route(`**/api/v1/recent/${touched.id}`, async (route) => {
        sent.push(route.request().postDataJSON());
        // 이 기기의 첫 요청이 서버에 닿기 직전에 다른 기기가 고정한다.
        if (sent.length === 1) {
            const current = (await apiCall<{ items: { id: string; revision: number }[] }>("GET", "/recent?limit=200&filter=all")).items.find((i) => i.id === touched.id)!;
            await apiCall("PATCH", `/recent/${touched.id}`, { expected_revision: current.revision, pinned: true });
        }
        await route.continue();
    });
    await row.getByRole("button", { name: "최근 항목 관리", exact: true }).click();
    await page.getByRole("dialog", { name: "최근 항목 관리", exact: true }).getByRole("button", { name: "최근에서 숨기기" }).click();
    await expect(row).toHaveCount(0);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ hidden: true });
    expect(sent[1]).not.toHaveProperty("pinned");
    await expect(recent.getByRole("alert")).toHaveCount(0);
    const hidden = (await apiCall<{ items: { id: string; pinned: boolean; hidden: boolean }[] }>("GET", "/recent?limit=200&filter=hidden")).items.find((i) => i.id === touched.id)!;
    expect(hidden).toMatchObject({ pinned: true, hidden: true });
});

test("숨긴 대화는 새 메시지가 오면 다시 보이고, 분할로 함께 연 대화는 한 묶음으로 보인다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const make = async (title: string) => {
        const s = await apiCall<{ id: string; title: string }>("POST", `/projects/${a.id}/sessions`, { title });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
        return s;
    };
    const one = await make(`linked-one-${randomUUID()}`);
    const two = await make(`linked-two-${randomUUID()}`);
    const hidden = await make(`revive-${randomUUID()}`);
    const device = `recent-${randomUUID()}`;
    const layout: Layout = { schema: 1, focused_leaf: "l", root: { type: "split", direction: "row", ratio: 0.5, children: [
        { type: "leaf", id: "l", active_tab: "t1", tabs: [{ id: "t1", kind: "session", project_id: a.id, resource_id: one.id, title: one.title }] },
        { type: "leaf", id: "r", active_tab: "t2", tabs: [{ id: "t2", kind: "session", project_id: a.id, resource_id: two.id, title: two.title }] },
    ] } };
    await apiCall("PUT", `/layouts/${device}`, { expected_revision: 0, layout });
    await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
    await login(page);
    const recent = page.getByRole("region", { name: "최근", exact: true });
    const group = recent.getByTestId("recent-split-group");
    await expect(group.getByTestId("recent-item")).toHaveCount(2);
    await expect(group).toContainText(one.title);
    await expect(group).toContainText(two.title);

    const row = recent.getByTestId("recent-item").filter({ hasText: hidden.title });
    await row.getByRole("button", { name: "최근 항목 관리", exact: true }).click();
    await page.getByRole("dialog", { name: "최근 항목 관리", exact: true }).getByRole("button", { name: "최근에서 숨기기" }).click();
    await expect(row).toHaveCount(0);
    await apiCall("POST", `/sessions/${hidden.id}/messages`, { text: "다시 보여 줘" });
    await expect(row).toHaveCount(1);
});
