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
    await page.getByTestId("bots-panel").getByTestId("bot").filter({ hasText: bot.name }).getByRole("button", { name: bot.name, exact: false }).first().click();
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

// 클래스나 flex 속성 대신 실제 글자 상자를 비교해 중첩된 inline 요소의 기준선 차이도 잡는다.
async function expectAlignedLabel(scope: Locator, detail: string) {
    await expect(scope).toContainText(detail);
    const metrics = await scope.evaluate((node, suffix) => {
        const name = node.querySelector('[data-testid="assistant-name"]')!;
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let detailText: Text | null = null;
        while (walker.nextNode()) {
            if (walker.currentNode.textContent?.includes(suffix)) {
                detailText = walker.currentNode as Text;
                break;
            }
        }
        const glyph = (text: Node, offset: number) => {
            const range = document.createRange();
            range.setStart(text, offset);
            range.setEnd(text, offset + 1);
            const box = range.getBoundingClientRect();
            return { top: box.top, height: box.height };
        };
        return {
            name: glyph(name.firstChild!, 0),
            detail: glyph(detailText!, detailText!.textContent!.indexOf(suffix)),
        };
    }, detail);
    expect(Math.abs(metrics.name.top - metrics.detail.top), JSON.stringify(metrics)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(metrics.name.height - metrics.detail.height), JSON.stringify(metrics)).toBeLessThanOrEqual(0.5);
}

for (const width of [390, 1400]) {
    for (const image of [false, true]) {
        test(`${width}px에서 사진 ${image ? "있음" : "없음"}: 이름·작업 상태·모델 정보의 글자 높이가 같다`, async ({ page }, info) => {
            await page.setViewportSize({ width, height: 844 });
            const bot = await makeBot(`어시스턴트${width === 390 ? "가" : "나"}${image ? "유" : "무"}`, image);
            const view = await openBot(page, bot);
            // 기기별 사용자 글꼴처럼 x-height가 다른 글꼴에서도 기준선이 같아야 한다.
            await view.evaluate((node) => {
                (node as HTMLElement).style.fontFamily = "serif";
                (node as HTMLElement).style.setProperty("--font-family-body", "serif");
            });
            await composerOption(view, "보내기 방식", "model");
            for (const [index, delta, status] of [
                [0, { content: "" }, "작업 중…"],
                [1, { reasoning_content: "확인하는 중" }, "작업 중…"],
                [2, { content: "답변하는 중" }, "응답 중…"],
            ] as const) {
                const marker = `identity-align-${bot.id}-${index}`;
                await script({ frames: [JSON.stringify({ choices: [{ delta }] })], hang: true, marker });
                await view.getByLabel("메시지 입력").fill(marker);
                await view.getByRole("button", { name: "보내기", exact: true }).click();
                const partial = view.getByTestId("partial");
                await expect(partial).toBeVisible();
                await expectAlignedLabel(partial, status);
                await partial.evaluate((node) => {
                    const label = document.getElementById(node.getAttribute("aria-labelledby")!)!;
                    label.style.fontSize = "1.25em";
                });
                await expectAlignedLabel(partial, status);
                if (width === 390 && index === 0) await page.screenshot({ path: info.outputPath("assistant-label-mobile.png") });
                page.once("dialog", (dialog) => dialog.accept());
                await view.getByRole("button", { name: "취소", exact: true }).click();
                await expect(partial).toHaveCount(0);
            }
            const marker = `identity-align-done-${bot.id}`;
            await answer(view, marker);
            const label = view.getByTestId("msg-assistant").filter({ hasText: marker }).getByTestId("msg-who");
            await expectAlignedLabel(label, "모델");
            await label.evaluate((node) => { (node as HTMLElement).style.fontSize = "1.25em"; });
            await expectAlignedLabel(label, "모델");
        });
    }
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
