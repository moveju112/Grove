import { expect, test, type Page } from "@playwright/test";
import type { Message } from "../app/api/generated";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, openTool, script, sessionView } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function conversation(page: Page) {
    const { a } = await ensureProjects();
    const profile = await ensureProfile();
    const title = `비교 대화 ${crypto.randomUUID()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
    await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", false);
    const view = sessionView(page, session.id);
    await expect(view.getByLabel("메시지 입력", { exact: true })).toBeVisible();
    return { view, session, profile, title };
}

for (const theme of ["light", "dark"] as const) {
    test(`${theme}: 명령 목록을 검색해도 입력창은 움직이지 않고 키보드 선택을 따라간다`, async ({ page }, info) => {
        await page.addInitScript((theme) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme })), theme);
        const { view } = await conversation(page);
        const composer = view.getByTestId("composer");
        const input = view.getByLabel("메시지 입력", { exact: true });
        const original = (await composer.boundingBox())!;
        await input.fill("/");
        const list = view.getByRole("listbox", { name: "명령" });
        await expect(list).toBeVisible();
        const all = (await list.boundingBox())!;
        expect(Math.abs((await composer.boundingBox())!.y - original.y)).toBeLessThanOrEqual(1);
        expect(all.y + all.height).toBeLessThanOrEqual(original.y);
        await input.press("ArrowDown");
        const selected = list.getByRole("option", { selected: true });
        const commandGeometry = await selected.evaluate((node) => {
            const parents = [];
            for (let parent: HTMLElement | null = node as HTMLElement; parent; parent = parent.parentElement) {
                const style = getComputedStyle(parent);
                parents.push({ tag: parent.tagName, role: parent.getAttribute("role"), rect: parent.getBoundingClientRect().toJSON(), overflow: style.overflow, maxHeight: style.maxHeight });
                if (parents.length === 8) break;
            }
            return parents;
        });
        await expect(selected, JSON.stringify(commandGeometry)).toBeInViewport();
        await expect(input).toHaveAttribute("aria-activedescendant", (await selected.getAttribute("id"))!);
        await input.fill("/save");
        const filtered = (await list.boundingBox())!;
        expect(Math.abs(filtered.y + filtered.height - all.y - all.height)).toBeLessThanOrEqual(1);
        expect(Math.abs((await composer.boundingBox())!.y - original.y)).toBeLessThanOrEqual(1);
        await page.screenshot({ path: info.outputPath(`commands-${theme}-390.png`) });
        await input.press("Escape");
        await expect(list).toHaveCount(0);
        await expect(input).toHaveValue("/save");
        await expect(input).toBeFocused();
    });
}

test("메시지 시각은 말풍선 밖에 표시하고 응답 시간의 세부 수치는 열어서 확인한다", async ({ page }, info) => {
    const { view, session, profile, title } = await conversation(page);
    const message = await apiCall<Message>("POST", `/sessions/${session.id}/messages`, { text: "짧은 사용자 메시지" });
    const row = view.locator("[data-seq]").filter({ has: page.getByTestId("msg-user").filter({ hasText: "짧은 사용자 메시지" }) });
    const timestamp = row.locator("time");
    await expect(timestamp).toHaveAttribute("datetime", message.created_at);
    const bubble = (await row.getByTestId("msg-user").boundingBox())!;
    expect((await timestamp.boundingBox())!.y).toBeGreaterThanOrEqual(bubble.y + bubble.height);
    await script({ marker: title, frames: frames.text(["비교용 응답"]) });
    await apiCall("POST", `/sessions/${session.id}/turns`, { profile_id: profile, text: title });
    await expect(view.getByTestId("msg-assistant").last()).toContainText("비교용 응답");
    const timing = view.getByTestId("turn-timing");
    await expect(timing).toHaveAttribute("data-running", "false");
    await expect(timing).not.toContainText("공급자");
    await expect(timing).not.toContainText("화면 반영");
    await page.screenshot({ path: info.outputPath("conversation-390.png") });
    await timing.getByRole("button", { name: "요청 시간 상세", exact: true }).click();
    const detail = page.getByRole("dialog", { name: "요청 시간 상세" });
    await expect(detail).toContainText("공급자");
    await expect(detail).toContainText("총 경과");
    await detail.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(detail).toHaveCount(0);
});

test("답변 표는 열 폭을 내용 길이에 맞춰 나누고 긴 식별자는 셀 안에서 줄바꿈한다", async ({ page }, info) => {
    const { view, profile, session, title } = await conversation(page);
    const answer = [
        "| 범위 | 확인 결과 |",
        "|---|---|",
        "| 서버 | `grove.service` 실행 중. 응답 상태 `ready`, 현재 release는 `0.1.13-9a3e2437712e`로 게시한 압축본과 같아. |",
        `| CLI | \`${"/home/ubuntu/.local/bin/".repeat(4)}grove\`가 응답 |`,
    ].join("\n");
    await script({ marker: title, frames: frames.text([answer]) });
    await apiCall("POST", `/sessions/${session.id}/turns`, { profile_id: profile, text: title });
    const table = view.getByTestId("md-table").last();
    await expect(table).toContainText("grove.service");
    const [first, second] = await table.getByRole("columnheader").evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().width));
    expect(first! * 3).toBeLessThan(second!);
    const fit = await table.evaluate((area) => {
        const grid = area.querySelector("table")!;
        const cells = [...grid.querySelectorAll("td")];
        return {
            overflow: grid.getBoundingClientRect().width - area.clientWidth,
            clipped: cells.some((cell) => cell.scrollWidth > cell.clientWidth + 1),
            wrapped: cells.every((cell, i) => i % 2 === 0 || cell.getBoundingClientRect().height > parseFloat(getComputedStyle(cell).lineHeight) * 1.5),
        };
    });
    expect(fit.overflow).toBeLessThanOrEqual(1);
    expect(fit.clipped).toBe(false);
    expect(fit.wrapped).toBe(true);
    await page.screenshot({ path: info.outputPath("markdown-table-columns-390.png") });
});

test("모바일 도구의 탭·닫기는 화면 안에 있고 패널을 닫아도 입력 초안이 남는다", async ({ page }, info) => {
    const { view } = await conversation(page);
    const composer = view.getByLabel("메시지 입력", { exact: true });
    await composer.fill("대화 초안 보존");
    await openTool(view, "Goal");
    const tools = view.getByRole("dialog", { name: "대화 도구", exact: true, includeHidden: true });
    await expect(tools).toBeInViewport({ ratio: 1 });
    expect((await tools.boundingBox())!.height).toBeGreaterThanOrEqual(844 - 2);
    const draft = view.getByTestId("goals-panel").getByLabel("새 Goal", { exact: true });
    await draft.fill("패널 초안 보존");
    const close = view.getByRole("button", { name: "도구 패널 닫기", exact: true });
    const bounds = (await close.boundingBox())!;
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: info.outputPath("tools-390.png") });
    const surface = await tools.evaluate((node) => ({ width: node.clientWidth, content: node.scrollWidth, right: node.getBoundingClientRect().right, modal: node.matches(":modal") }));
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, content: document.documentElement.scrollWidth }));
    expect(surface.content).toBeLessThanOrEqual(surface.width + 1);
    expect(viewport.content).toBeLessThanOrEqual(viewport.width);
    const tabs = tools.getByRole("tablist", { name: "대화 도구", exact: true });
    await tabs.getByRole("tab", { selected: true }).press("End");
    await expect(tabs.getByRole("tab", { name: "원격 감시", exact: true })).toBeInViewport();
    await tabs.getByRole("tab", { name: "Goal", exact: true }).click();
    await expect(draft).toHaveValue("패널 초안 보존");
    await close.click();
    await expect(tools).toBeHidden();
    await expect(view.getByRole("button", { name: "도구 패널", exact: true })).toBeFocused();
    await openTool(view, "Goal");
    await expect(draft).toHaveValue("패널 초안 보존");
    await page.setViewportSize({ width: 1280, height: 844 });
    await expect(draft).toHaveValue("패널 초안 보존");
    await expect.poll(() => tools.evaluate((node) => ({
        modal: node.matches(":modal"), compact: matchMedia("(max-width: 760px)").matches, width: innerWidth,
    }))).toEqual({ modal: false, compact: false, width: 1280 });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(draft).toHaveValue("패널 초안 보존");
    await expect.poll(() => tools.evaluate((node) => node.matches(":modal"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(tools).toBeHidden();
    await expect(composer).toHaveValue("대화 초안 보존");
});
