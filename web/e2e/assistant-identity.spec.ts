import { expect, test, type Locator, type Page } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, openBots, script, sessionView } from "./helpers";

// UI-013 통합 인수 시험. SessionView의 실제 assistant 항목 연결 전에는 통과하지 않는다.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function makeBot(name: string, image: boolean) {
    const { a } = await ensureProjects();
    const profile = await ensureProfile();
    const bot = await apiCall<{ id: string }>("POST", "/bots", { name, project_id: a.id, profile_id: profile });
    if (image) await apiCall("PUT", `/bots/${bot.id}/avatar`, { data_base64: PNG });
    const home = await apiCall<{ home_session_id: string }>("POST", `/bots/${bot.id}/home`);
    return { id: bot.id, sessionId: home.home_session_id, name };
}

async function openBot(page: Page, bot: { name: string; sessionId: string }) {
    await login(page);
    await openBots(page);
    await page.getByTestId("bots-panel").getByTestId("bot").filter({ hasText: bot.name }).locator(".bot-open").click();
    const view = sessionView(page, bot.sessionId);
    await expect(view).toBeVisible();
    return view;
}

async function answer(view: Locator, marker: string) {
    await script({ frames: frames.text([marker]), marker });
    await composerOption(view, "보내기 방식", "model");
    await view.getByLabel("메시지 입력").fill(marker);
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const message = view.getByTestId("msg-assistant").filter({ hasText: marker });
    await expect(message).toBeVisible({ timeout: 15_000 });
    return message.getByTestId("assistant-identity");
}

test("실제 assistant는 설정된 이름을 HTML이 아닌 텍스트와 기본 아이콘으로 표시한다", async ({ page }) => {
    const name = `<b>도우미</b> ${Date.now().toString(36)}`;
    const bot = await makeBot(name, false);
    const view = await openBot(page, bot);
    const identity = await answer(view, `identity-default-${bot.id}`);
    await expect(identity.getByTestId("assistant-name")).toHaveText(name);
    await expect(identity.locator("b")).toHaveCount(0);
    await expect(identity.getByTestId("assistant-default-icon")).toBeVisible();
    await expect(identity.locator("img")).toHaveCount(0);
    await expect(identity.getByTestId("assistant-default-icon")).toHaveAttribute("aria-hidden", "true");
    await expect(view.getByTestId("msg-user").getByTestId("assistant-identity")).toHaveCount(0);
    // 설정 변경은 기존 메시지에도 반영된다. 삭제 후 같은 사진을 다시 설정해도 복구한다.
    await apiCall("PUT", `/bots/${bot.id}/avatar`, { data_base64: PNG });
    await expect(identity.locator("img")).toBeVisible();
    await expect(identity.getByTestId("assistant-default-icon")).toHaveCount(0);
    await apiCall("DELETE", `/bots/${bot.id}/avatar`);
    await expect(identity.getByTestId("assistant-default-icon")).toBeVisible();
    await expect(identity.locator("img")).toHaveCount(0);
    await apiCall("PUT", `/bots/${bot.id}/avatar`, { data_base64: PNG });
    await expect(identity.locator("img")).toBeVisible();
});

test("같은 origin의 인증된 사진과 긴 이름을 좁은 화면에서도 보존하고 새로고침한다", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const name = `${"긴도우미이름".repeat(5)} ${Date.now().toString(36)}`;
    const bot = await makeBot(name, true);
    const view = await openBot(page, bot);
    const marker = `identity-photo-${bot.id}`;
    const identity = await answer(view, marker);
    const photo = identity.locator("img");
    await expect(photo).toBeVisible();
    await expect(photo).toHaveAttribute("src", /^blob:http:\/\/127\.0\.0\.1:17741\//);
    await expect(photo).toHaveAttribute("alt", "");
    await expect(photo).toHaveAttribute("aria-hidden", "true");
    await expect(identity.getByTestId("assistant-default-icon")).toHaveCount(0);
    await expect(identity.getByTestId("assistant-name")).toHaveText(name);
    expect(await identity.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return box.left >= 0 && box.right <= document.documentElement.clientWidth && node.scrollWidth <= node.clientWidth + 1;
    })).toBe(true);
    await page.reload();
    const restored = sessionView(page, bot.sessionId).getByTestId("msg-assistant").filter({ hasText: marker }).getByTestId("assistant-identity");
    await expect(restored.getByTestId("assistant-name")).toHaveText(name);
    await expect(restored.locator("img")).toBeVisible();
});

test("PNG 디코딩 실패는 기본 아이콘으로 돌아가고 같은 사진을 재시도하지 않는다", async ({ page }) => {
    const bot = await makeBot(`사진실패 ${Date.now().toString(36)}`, true);
    let requests = 0;
    await page.route(`**/api/v1/bots/${bot.id}/avatar`, async (route) => {
        requests++;
        await route.fulfill({ status: 200, contentType: "image/png", body: "not a PNG" });
    });
    const view = await openBot(page, bot);
    const identity = await answer(view, `identity-failed-${bot.id}`);
    await expect(identity.getByTestId("assistant-default-icon")).toBeVisible();
    await expect(identity.locator("img")).toHaveCount(0);
    await expect(identity.getByTestId("assistant-name")).toHaveText(bot.name);
    expect(requests).toBeGreaterThan(0);
    const previous = requests;
    // 새 응답의 같은 URL도 실패 한 번으로 끝나야 한다. fetch 반복·img error 재시도 루프를 만들지 않는다.
    const again = await answer(view, `identity-failed-again-${bot.id}`);
    await expect(again.getByTestId("assistant-default-icon")).toBeVisible();
    await expect(again.locator("img")).toHaveCount(0);
    expect(requests).toBe(previous);
});
