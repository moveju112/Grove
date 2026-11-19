import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, choiceOptions, closeModelSettings, composerOption, composerSetting, ensureProfile, ensureProjects, login, modelSettings, openDetails, openSettings, script, selectChoice, sessionView, state } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("작은 모델 선택기에서 공급자 모델을 골라 보내고 초안·프로필 설정은 보존한다", async ({ page }, info) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const name = `picker-${Date.now()}`;
    const profile = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: "연결 프로필 이름이 길어도 모델을 가리지 않음", protocol: "openai",
        base_url: `http://127.0.0.1:${state().fixturePort}/v1`, model: "fixture-picker-model",
    });
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: name });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    try {
        await login(page);
        await page.getByRole("button", { name: "사이드바", exact: true }).click();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name }).click();
        await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", false);
        const view = sessionView(page, session.id);
        const summary = view.getByTestId("model-summary");
        const picker = await composerSetting(view, "모델 프로필");
        await expect(picker).toBeVisible();
        expect((await picker.boundingBox())!.width).toBeLessThanOrEqual(390);
        await closeModelSettings(view);
        await expect(view.getByRole("button", { name: "입력 옵션", exact: true })).toHaveCount(0);
        for (const label of ["보내기 방식", "에이전트", "도구"]) await expect(view.getByTestId("composer").getByLabel(label, { exact: true })).toHaveCount(0);
        await view.getByLabel("메시지 입력").fill("모델을 바꿔도 남는 초안");
        await expect(view.getByLabel("메시지 입력")).toHaveValue("모델을 바꿔도 남는 초안");
        await composerOption(view, "보내기 방식", "save");
        await expect(summary).toHaveText("메시지만 저장");
        await composerOption(view, "모델 프로필", profile.id);
        await composerSetting(view, "모델 프로필");
        await expect(picker).toContainText(/^fixture-picker-model ·/);
        const modelChoice = JSON.stringify([profile.id, "fixture-model"]);
        await expect((await choiceOptions(picker)).and(page.locator(`[data-option-value=${JSON.stringify(modelChoice)}]`))).toHaveCount(1);
        await page.keyboard.press("Escape");
        await selectChoice(picker, modelChoice);
        await expect(picker).toContainText(/^fixture-model ·/);
        await closeModelSettings(view);
        await expect(summary).toHaveText("fixture-model");
        await expect(view.getByLabel("메시지 입력")).toHaveValue("모델을 바꿔도 남는 초안");
        await page.screenshot({ path: info.outputPath("model-picker-390.png") });
        await script({ marker: name, frames: frames.text(["선택한 모델 응답"]) });
        await view.getByLabel("메시지 입력").fill(name);
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(view.getByTestId("msg-assistant").last()).toContainText("선택한 모델 응답");
        await expect(view.getByTestId("turn-status")).toHaveCount(0);
        const bubble = view.getByTestId("msg-user").last();
        await expect(bubble.getByTestId("msg-copy")).toHaveCount(0);
        const copy = view.locator('[data-seq]:has([data-testid="msg-user"])').last().getByTestId("msg-copy");
        const bubbleBox = (await bubble.boundingBox())!;
        expect((await copy.boundingBox())!.y).toBeGreaterThanOrEqual(bubbleBox.y + bubbleBox.height);
        expect(bubbleBox.height).toBeLessThan(60);
        expect((await view.getByTestId("composer").boundingBox())!.height).toBeLessThanOrEqual(120);
        await page.screenshot({ path: info.outputPath("chat-390.png") });
        const requests = await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json() as { model: string; messages: unknown[] }[];
        expect(requests.filter((r) => JSON.stringify(r.messages).includes(name)).map((r) => r.model)).toEqual(["fixture-model"]);
        const saved = await apiCall<{ id: string; model: string }[]>("GET", "/model-profiles");
        expect(saved.find((p) => p.id === profile.id)!.model).toBe("fixture-picker-model");
    } finally {
        await apiCall("DELETE", `/model-profiles/${profile.id}`);
    }
});

test("모바일에서 모델 설정 바깥을 탭하면 닫히고 초안은 남는다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `picker-dismiss-${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.getByRole("button", { name: "사이드바", exact: true }).tap();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title }).tap();
    await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", false);
    const view = sessionView(page, session.id);
    const input = view.getByLabel("메시지 입력", { exact: true });
    const trigger = view.getByRole("button", { name: "모델 설정", exact: true });
    await input.tap();
    await expect(input).toBeFocused();
    await input.fill("보존할 초안");
    await expect(input).toHaveValue("보존할 초안");

    const panel = await modelSettings(view);
    await panel.getByText("모델", { exact: true }).tap();
    await expect(panel).toBeVisible();
    const chat = await view.locator('[data-ui="workbench-main"]').boundingBox();
    expect(chat).not.toBeNull();
    await page.touchscreen.tap(chat!.x + chat!.width / 2, chat!.y + 30);
    await expect(panel).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await modelSettings(view);
    await input.tap();
    await expect(panel).toBeHidden();
    await expect(input).toHaveValue("보존할 초안");
});

for (const theme of ["light", "dark"] as const) {
    test(`${theme}: 모델 설정은 상세·도움말로 정리하고 고정 검색창 위로 본문이 비치지 않는다`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript((theme) => {
            localStorage.setItem("grove.device.prefs", JSON.stringify({ theme }));
        }, theme);
        const profiles: { id: string; name: string }[] = [];
        try {
            for (let i = 0; i < 8; i++) profiles.push(await apiCall("POST", "/model-profiles", {
                name: `간결한 모델 ${i}`, protocol: "codex_cli", base_url: "", model: "default",
            }));
            await login(page);
            await openSettings(page);
            await page.getByLabel("설정 검색").fill("모델 프로필");
            const settings = page.getByTestId("settings");
            const row = settings.getByTestId("model-profile").filter({ hasText: profiles[0]!.name });
            const nextRow = settings.getByTestId("model-profile").filter({ hasText: profiles[1]!.name });
            expect(await page.evaluate(async () => {
                await document.fonts.ready;
                return [...document.fonts].some((font) => font.family === "Pretendard" && font.status === "loaded");
            })).toBe(true);
            expect(await row.evaluate((node) => getComputedStyle(node).fontFamily)).toContain("Pretendard");
            const card = await row.evaluate((node) => {
                const style = getComputedStyle(node);
                return {
                    edges: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map(parseFloat),
                    radius: parseFloat(style.borderTopLeftRadius),
                    padding: parseFloat(style.paddingLeft),
                    background: style.backgroundColor,
                    surround: getComputedStyle(node.parentElement!.parentElement!).backgroundColor,
                };
            });
            expect(card.edges.every((edge) => edge >= 1), "모델별 카드는 네 면 모두 경계가 있어야 한다").toBe(true);
            expect(card.radius).toBeGreaterThanOrEqual(8);
            expect(card.padding).toBeGreaterThanOrEqual(12);
            expect(card.background).not.toBe(card.surround);
            const rowBox = (await row.boundingBox())!;
            const nextBox = (await nextRow.boundingBox())!;
            expect(nextBox.y - rowBox.y - rowBox.height, "카드 사이에는 별도 여백이 있어야 한다").toBeGreaterThanOrEqual(12);
            await expect(row.getByTestId("model-capabilities")).toBeHidden();
            await expect(row.getByText("CLI fallback 미지원")).toBeHidden();
            await expect(settings.getByRole("form", { name: "모델 프로필 추가", exact: true })).toBeHidden();
            await row.getByRole("button", { name: `${profiles[0]!.name} 연결 정보` }).click();
            await expect(page.getByRole("tooltip")).toContainText("서버 CLI 계정");
            await page.keyboard.press("Escape");
            await openDetails(row);
            await row.getByRole("button", { name: "모델 기능 설정", exact: true }).click();
            const context = row.getByLabel("context token 수", { exact: true });
            await context.fill("12345");
            await row.getByRole("button", { name: "상세 설정", exact: true }).click();
            await row.getByRole("button", { name: "상세 설정", exact: true }).click();
            await expect(context).toHaveValue("12345");
            await expect(row.getByRole("status").filter({ hasText: "저장됨" })).toBeVisible();
            await page.screenshot({ path: info.outputPath(`profiles-${theme}-390.png`) });
            const pane = settings.getByTestId("settings-scroll");
            await pane.evaluate((node) => { node.scrollTop = 300; });
            await expect.poll(() => pane.evaluate((node) => node.scrollTop)).toBe(300);
            const paneBox = (await pane.boundingBox())!;
            const covered = await page.evaluate(({ x, y }) =>
                Boolean(document.elementFromPoint(x, y)?.closest('[aria-label="설정 메뉴"]')),
            { x: paneBox.x + paneBox.width / 2, y: paneBox.y + 2 });
            expect(covered, "검색창 위쪽도 고정 탐색 영역의 불투명 배경으로 덮여야 한다").toBe(true);
            expect(await settings.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
            await page.screenshot({ path: info.outputPath(`sticky-search-${theme}-390.png`) });
        } finally {
            for (const profile of profiles) await apiCall("DELETE", `/model-profiles/${profile.id}`);
        }
    });
}
