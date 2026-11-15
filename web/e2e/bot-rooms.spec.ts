import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, openBots, script, selectChoice } from "./helpers";
import type { BotConnections, BotRoom } from "../app/api/generated";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("봇 작업 메뉴에서 그룹을 만들고 멘션한 봇만 답하며 다시 열어도 이력이 남는다", async ({ page }, info) => {
    const { a } = await ensureProjects();
    const profile = await ensureProfile();
    const tag = Date.now().toString(36);
    const bots = [];
    for (const name of [`설계 ${tag}`, `검토 ${tag}`]) bots.push(await apiCall<{ id: string; name: string }>("POST", "/bots", {
        name, project_id: a.id, profile_id: profile,
    }));
    await login(page);
    await openBots(page);
    const panel = page.getByTestId("bots-panel");
    await panel.getByRole("button", { name: "봇 작업", exact: true }).click();
    await panel.getByRole("button", { name: "그룹 만들기", exact: true }).click();
    const form = panel.getByTestId("bot-room-editor");
    await form.getByLabel("그룹 이름", { exact: true }).fill(`협업 ${tag}`);
    await selectChoice(form.getByLabel("그룹 프로젝트", { exact: true }), a.id);
    await selectChoice(form.getByLabel("참여 봇 1", { exact: true }), bots[0]!.id);
    await selectChoice(form.getByLabel("참여 봇 2", { exact: true }), bots[1]!.id);
    const creationKeys: string[] = [];
    await page.route("**/api/v1/bot-rooms", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        creationKeys.push(route.request().headers()["idempotency-key"]!);
        const response = await route.fetch();
        if (creationKeys.length === 1) await route.abort("connectionfailed");
        else await route.fulfill({ response });
    });
    await form.getByRole("button", { name: "그룹 만들기", exact: true }).click();
    await expect(form.getByRole("button", { name: "같은 그룹 요청 확인", exact: true })).toBeVisible();
    await expect(form.getByLabel("그룹 이름", { exact: true })).toBeDisabled();
    await form.getByRole("button", { name: "같은 그룹 요청 확인", exact: true }).click();
    expect(creationKeys).toHaveLength(2);
    expect(creationKeys[0]).toBe(creationKeys[1]);
    const view = page.getByTestId("session-view").filter({ visible: true });
    await expect(view.getByTestId("bot-room-chip")).toBeVisible();
    await script({ frames: frames.text(["선택한 봇의 답변"]), delayMs: 0 });
    await composerOption(view, "보내기 방식", "model");
    await view.getByLabel("메시지 입력", { exact: true }).fill(`@{${bots[1]!.name}} 검토해줘`);
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const reply = view.getByTestId("msg-assistant").last();
    await expect(reply).toContainText("선택한 봇의 답변");
    await expect(reply).toContainText(bots[1]!.name);
    await expect(view.getByTestId("msg-assistant")).toHaveCount(1);
    const rooms = await apiCall<BotRoom[]>("GET", "/bot-rooms");
    expect(rooms.filter((r) => r.name === `협업 ${tag}`)).toHaveLength(1);
    const room = rooms.find((r) => r.name === `협업 ${tag}`)!;
    const turns = await apiCall<{ definition: { bot: { id: string } } }[]>("GET", `/sessions/${room.session_id}/turns`);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.definition.bot.id).toBe(bots[1]!.id);
    await page.screenshot({ path: info.outputPath("bot-room-390.png"), fullPage: true });
    await page.reload();
    await expect(page.locator(`[data-session="${room.session_id}"]`).getByTestId("msg-assistant")).toContainText("선택한 봇의 답변");
});

test("봇 관리에서 외부 연결을 선택하고 저장한 허용 목록을 다시 읽는다", async ({ page }) => {
    const { a } = await ensureProjects();
    const tag = Date.now().toString(36);
    const name = `연결 봇 ${tag}`;
    const bot = await apiCall<{ id: string }>("POST", "/bots", { name, project_id: a.id });
    const server = await apiCall<{ id: string }>("POST", "/mcp/servers", {
        name: `mail-${tag}`, config: { transport: "stdio", command: "fixture-not-executed" },
    });
    await login(page);
    await openBots(page);
    const row = page.getByTestId("bot").filter({ hasText: name });
    await row.getByRole("button", { name: `${name} 관리`, exact: true }).click();
    await page.getByRole("group", { name: `${name} 관리`, exact: true }).getByRole("button", { name: "외부 연결", exact: true }).click();
    const panel = page.getByTestId("bot-connections");
    await selectChoice(panel.getByLabel(`mail-${tag} · 비활성`, { exact: true }), "true");
    const keys: string[] = [];
    await page.route(`**/api/v1/bots/${bot.id}/connections`, async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        keys.push(route.request().headers()["idempotency-key"]!);
        const response = await route.fetch();
        if (keys.length === 1) await route.abort("connectionfailed");
        else await route.fulfill({ response });
    });
    await panel.getByRole("button", { name: "연결 저장", exact: true }).click();
    await expect(panel.getByRole("button", { name: "같은 연결 요청 확인", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "같은 연결 요청 확인", exact: true }).click();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    await expect(panel.getByRole("button", { name: "연결 저장", exact: true })).toHaveCount(0);
    const view = await apiCall<BotConnections>("GET", `/bots/${bot.id}/connections`);
    expect(view.servers.find((s) => s.id === server.id)?.selected).toBe(true);
    await page.reload();
    await openBots(page);
    await row.getByRole("button", { name: `${name} 관리`, exact: true }).click();
    await page.getByRole("group", { name: `${name} 관리`, exact: true }).getByRole("button", { name: "외부 연결", exact: true }).click();
    await expect(page.getByTestId("bot-connections").getByRole("combobox", { name: `mail-${tag} · 비활성`, exact: true })).toHaveText("사용");
});
