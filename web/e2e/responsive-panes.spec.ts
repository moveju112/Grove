import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Layout } from "../app/state/layout";
import { frames } from "./fixture";
import { activateMobileTab, apiCall, closeMobileSidebar, ensureProfile, ensureProjects, login, openSettings, requireToolApproval, script, startProjectConversation } from "./helpers";

async function setup(page: Page) {
    const { a } = await ensureProjects();
    await requireToolApproval(a.id);
    const profile = await ensureProfile();
    const device = `responsive-${randomUUID()}`;
    const title = device;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    for (let i = 0; i < 45; i++) {
        await apiCall("POST", `/sessions/${session.id}/messages`, { text: `reading ${i}\n${"variable width content ".repeat(12)}` });
    }
    const layout: Layout = { schema: 1, focused_leaf: "reading", root: {
        type: "split", direction: "row", ratio: 0.6, children: [
            { type: "leaf", id: "reading", active_tab: "reading-tab", tabs: [
                { id: "reading-tab", kind: "session", project_id: a.id, resource_id: session.id, title },
            ] },
            { type: "leaf", id: "writing", active_tab: "writing-tab", tabs: [
                { id: "writing-tab", kind: "project", project_id: a.id, resource_id: a.id, title: a.name },
            ] },
        ],
    } };
    await apiCall("PUT", `/layouts/${device}`, { expected_revision: 0, layout });
    const narrow = structuredClone(layout);
    if (narrow.root.type === "split") for (const child of narrow.root.children) {
        if (child.type === "leaf") {
            child.tabs.forEach((tab) => { tab.id += "-narrow"; });
            child.active_tab += "-narrow";
        }
    }
    await apiCall("PUT", `/layouts/${device}-narrow`, { expected_revision: 0, layout: narrow });
    await page.addInitScript((id) => localStorage.setItem("grove.device.id", id), device);
    await login(page);
    await expect(page.locator('[data-leaf="reading"]:visible').getByLabel("메시지 입력")).toBeEnabled();
    await startProjectConversation(page.locator('[data-leaf="writing"]:visible'));
    return { session, title, profile, project: a };
}

test("폭·가로세로·키보드 높이 전환 뒤에도 배치별 입력 DOM·선택·읽던 메시지를 보존한다", async ({ page }) => {
    const { title, project } = await setup(page);
    const wide = page.locator('[data-layout-mode="wide"]');
    const reading = wide.locator('[data-leaf="reading"]');
    const writing = wide.locator('[data-leaf="writing"]');
    await reading.getByLabel("메시지 입력").fill("wide reading draft");
    await writing.getByLabel("메시지 입력").fill("wide writing draft");
    await writing.getByLabel("메시지 입력").evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 7));
    const input = await writing.getByLabel("메시지 입력").elementHandle();
    const body = reading.getByTestId("pane-body");
    await reading.getByRole("feed").focus();
    await page.keyboard.press("Home");
    // 폭 변화로 짧아져도 같은 메시지의 읽던 부분이 viewport 안에 남는 위치를 사용한다.
    await body.evaluate((el) => { el.scrollTop += 50; });
    const before = await body.evaluate((el) => {
        const bounds = el.getBoundingClientRect();
        const node = [...el.querySelectorAll<HTMLElement>("[data-virtual-seq]")].find((row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > bounds.top && rect.top < bounds.bottom;
        })!;
        return { seq: node.dataset.virtualSeq, offset: node.getBoundingClientRect().top - bounds.top };
    });
    const anchor = reading.locator(`[data-virtual-seq="${before.seq}"]`);
    await expect.poll(() => page.evaluate(() => {
        const saved = JSON.parse(sessionStorage.getItem("grove.scroll.reading-tab") ?? "null");
        return saved && { seq: String(saved.anchorSeq), offset: saved.offset };
    })).toEqual(before);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-testid="pane"]:visible')).toHaveCount(1);
    expect(await input!.evaluate((node) => node.isConnected)).toBe(true);
    await closeMobileSidebar(page);
    const narrowInput = page.locator('[data-leaf="reading"]:visible').getByLabel("메시지 입력");
    await expect(narrowInput).toBeVisible();
    await narrowInput.fill("narrow reading draft");
    const narrow = await narrowInput.elementHandle();
    await activateMobileTab(page, project.name);
    await startProjectConversation(page.locator('[data-leaf="writing"]:visible'));
    await page.locator('[data-leaf="writing"]:visible').getByLabel("메시지 입력").fill("narrow writing draft");
    await expect(page.locator('[data-testid="pane"]:visible')).toHaveCount(1);
    await activateMobileTab(page, title);
    await expect(narrowInput).toHaveValue("narrow reading draft");
    expect(await narrow!.evaluate((node) => node.isConnected)).toBe(true);
    await narrowInput.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(1, 6));
    await page.setViewportSize({ width: 390, height: 430 });
    await expect(narrowInput).toHaveValue("narrow reading draft");
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator('[data-testid="pane"]:visible')).toHaveCount(2);
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(reading.getByLabel("메시지 입력")).toHaveValue("wide reading draft");
    await expect(writing.getByLabel("메시지 입력")).toHaveValue("wide writing draft");
    expect(await input!.evaluate((node: HTMLTextAreaElement) => ({ connected: node.isConnected, start: node.selectionStart, end: node.selectionEnd })))
        .toEqual({ connected: true, start: 2, end: 7 });
    await expect.poll(async () => Math.abs(await anchor.evaluate((node) => node.getBoundingClientRect().top - node.closest('[data-testid="pane-body"]')!.getBoundingClientRect().top) - before.offset)).toBeLessThan(3);
    await expect(page.getByRole("separator").and(page.locator("[aria-valuenow]"))).toHaveAttribute("aria-valuenow", "60");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(narrowInput).toBeVisible();
    expect(await narrow!.evaluate((node: HTMLTextAreaElement) => ({ connected: node.isConnected, start: node.selectionStart, end: node.selectionEnd, value: node.value })))
        .toEqual({ connected: true, start: 1, end: 6, value: "narrow reading draft" });
});

test("숨긴 배치의 승인 대기는 유지하고 그동안 도착한 메시지는 읽음 처리하지 않는다", async ({ page }) => {
    const { session, title, profile, project } = await setup(page);
    await script({ marker: title, frames: frames.tool("responsive-shell", "shell", { command: "printf 'responsive fixture\\n'" }) });
    const accepted = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`,
        { text: title, profile_id: profile, tools: true });
    const view = page.locator('[data-leaf="reading"]:visible');
    await expect(view.getByTestId("approval")).toBeVisible();
    await page.clock.install();
    await page.setViewportSize({ width: 390, height: 844 });
    await closeMobileSidebar(page);
    await activateMobileTab(page, project.name);
    await startProjectConversation(page.locator('[data-leaf="writing"]:visible'));
    const touches: number[] = [];
    page.on("request", (request) => {
        if (request.method() !== "POST" || !request.url().endsWith("/recent/touch")) return;
        const data = request.postDataJSON();
        if (data.resource_id === session.id) touches.push(data.view_state?.last_seen_seq ?? 0);
    });
    await expect.poll(async () => {
        const turns = await apiCall<{ status: string }>("GET", `/turns/${accepted.turn.id}`);
        return turns.status;
    }).toBe("awaiting_approval");
    await page.setViewportSize({ width: 390, height: 430 });
    await expect(page.locator('[data-leaf="writing"]:visible').getByLabel("메시지 입력")).toBeEnabled();
    await script({ marker: title, frames: frames.text(["completed after responsive fixture"]) });
    const calls = await apiCall<{ id: string; revision: number; status: string }[]>("GET", `/tool-calls?session_id=${session.id}&limit=200`);
    const call = calls.find((c) => c.status === "pending_approval")!;
    await apiCall("POST", `/tool-calls/${call.id}/decision`, { decision: "approve", expected_revision: call.revision });
    await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${accepted.turn.id}`)).status).toBe("completed");
    // 서버 확정 메시지의 cache 반영까지 기다려 숨겨진 화면의 읽음 갱신도 관찰한다.
    const final = await apiCall<{ last_message_seq: number }>("GET", `/sessions/${session.id}`);
    await expect(page.locator('[data-leaf="reading"]').getByTestId("msg-assistant").filter({ hasText: "completed after responsive fixture" }).first()).toHaveCount(1);
    await page.clock.runFor(500);
    expect(touches.filter((seq) => seq >= final.last_message_seq)).toEqual([]);
    await activateMobileTab(page, title);
    const turns = await apiCall<unknown[]>("GET", `/sessions/${session.id}/turns?limit=5`);
    expect(turns).toHaveLength(1);
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "completed after responsive fixture" })).toHaveCount(1);
});

test("로그아웃은 숨긴 배치까지 폐기하고 늦은 저장이 기기 사본을 다시 만들지 않는다", async ({ page }) => {
    await setup(page);
    await page.getByRole("separator").and(page.locator("[aria-valuenow]")).press("ArrowRight");
    await page.locator('[data-layout-mode="wide"] [data-leaf="writing"]').getByLabel("메시지 입력").fill("private wide draft");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-testid="pane"]:visible')).toHaveCount(1);
    await closeMobileSidebar(page);
    await page.locator('[data-layout-mode="narrow"] [data-leaf="reading"]').getByLabel("메시지 입력").fill("private narrow draft");
    const wideInput = await page.locator('[data-layout-mode="wide"] [data-leaf="writing"]').getByLabel("메시지 입력").elementHandle();
    const narrowInput = await page.locator('[data-layout-mode="narrow"] [data-leaf="reading"]').getByLabel("메시지 입력").elementHandle();
    await openSettings(page, "local");
    await page.getByLabel("설정 검색").fill("로그아웃");
    await page.getByRole("button", { name: "이 브라우저에서 로그아웃" }).click();
    await expect(page.getByRole("form", { name: "로그인" })).toBeVisible();
    expect(await wideInput!.evaluate((node) => node.isConnected)).toBe(false);
    expect(await narrowInput!.evaluate((node) => node.isConnected)).toBe(false);
    await page.clock.install();
    await page.clock.runFor(1000);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => /^grove\.(draft|layout)\./.test(key)))).toEqual([]);
    await expect(page.locator('[data-layout-mode]')).toHaveCount(0);
});
