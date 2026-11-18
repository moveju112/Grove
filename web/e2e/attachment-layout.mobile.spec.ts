import { expect, test, type Locator } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, composerOption, ensureProjects, login, openBots, openProjectFiles, startProjectConversation } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function expectInlineActions(row: Locator) {
    await expect.poll(() => row.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const buttons = [...node.querySelectorAll<HTMLButtonElement>('button[aria-haspopup], button[aria-label$="첨부 제거"]')]
            .filter((button) => button.getBoundingClientRect().width > 0);
        return {
            compact: box.height <= 56,
            // Astryx의 투명한 44px 터치 확장은 행 밖으로 나올 수 있다. 실제 행·버튼·페이지는 화면 안에 남아야 한다.
            noOverflow: box.left >= 0 && box.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth
                && buttons.every((button) => {
                    const action = button.getBoundingClientRect();
                    return action.left >= box.left && action.right <= box.right + 1;
                }),
            inline: buttons.length > 0 && buttons.every((button) => {
                const action = button.getBoundingClientRect();
                return Math.abs((action.top + action.bottom - box.top - box.bottom) / 2) <= 2;
            }),
            touchTargets: buttons.every((button) => {
                const action = button.getBoundingClientRect();
                return action.width >= 32 && action.height >= 32
                    && document.elementFromPoint(action.left + action.width / 2, action.top + action.height / 2)?.closest("button") === button;
            }),
        };
    })).toEqual({ compact: true, noOverflow: true, inline: true, touchTargets: true });
}

for (const theme of ["light", "dark"] as const) {
    test(`${theme}: 여러 이미지는 큰 썸네일만 가로로 나열하고 누르면 미리 본다`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript((theme) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme })), theme);
        const { b } = await ensureProjects();
        const session = await apiCall<{ id: string }>("POST", `/projects/${b.id}/sessions`, { title: `첨부 배치 ${theme}` });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: b.id, resource_id: session.id });
        await login(page);
        await page.getByRole("button", { name: "사이드바", exact: true }).click();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`첨부 배치 ${theme}`) }).click();
        const view = page.getByTestId("session-view");
        await composerOption(view, "보내기 방식", "save");
        const names = Array.from({ length: 8 }, (_, i) => `Screenshot_20261116_202906_Samsung Browser_아주_긴_이미지_파일명_${i}.png`);
        const image = await page.evaluate(() => {
            const canvas = document.createElement("canvas");
            canvas.width = 1080; canvas.height = 2340;
            const context = canvas.getContext("2d")!;
            context.fillStyle = "#5fbf8a"; context.fillRect(0, 0, 1080, 2340);
            return canvas.toDataURL("image/png").split(",")[1]!;
        });
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let completed = 0, finishUploads!: () => void;
        const uploaded = new Promise<void>((resolve) => { finishUploads = resolve; });
        await page.route(`**/api/v1/projects/${b.id}/attachments`, async (route) => {
            await held;
            const response = await route.fetch();
            expect(response.ok()).toBe(true);
            await route.fulfill({ response });
            if (++completed === names.length) finishUploads();
        });
        const selection = view.getByTestId("attachment-selection");
        const strip = selection.getByRole("list", { name: "선택한 이미지", exact: true });
        try {
            await view.getByTestId("attachment-picker").locator('input[type="file"]').setInputFiles(
                names.map((name) => ({ name, mimeType: "image/png", buffer: Buffer.from(image, "base64") })));
            const thumbnail = selection.getByRole("img", { name: names[0]!, exact: true });
            await expect(thumbnail).toBeVisible();
            await expect.poll(() => thumbnail.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth === 1080)).toBe(true);
            await expect(strip.getByRole("listitem")).toHaveCount(8);
            await expect(strip).toHaveText("");
        } finally { release(); }
        await uploaded;
        await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeEnabled();
        for (const width of [360, 390]) {
            await page.setViewportSize({ width, height: 844 });
            await expect.poll(() => strip.getByRole("img").evaluateAll((images) => {
                const boxes = images.map((node) => node.getBoundingClientRect());
                return boxes.every((box) => box.width === 80 && box.height === 80 && box.top === boxes[0]!.top)
                    && document.documentElement.scrollWidth <= innerWidth;
            })).toBe(true);
            await expect(strip).toHaveText("");
        }
        await expect(view.getByRole("button", { name: /첨부 작업|원문 다운로드/ })).toHaveCount(0);
        const cdp = await page.context().newCDPSession(page);
        try {
            const edge = (await strip.boundingBox())!;
            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: edge.x + edge.width - 20, y: edge.y + 48 }] });
            for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", {
                type: "touchMove", touchPoints: [{ x: edge.x + edge.width - 20 - i * 25, y: edge.y + 48 }],
            });
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } finally { await cdp.detach(); }
        await expect.poll(() => strip.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
        await expect(page.locator("[data-mobile-drawer][open]")).toHaveCount(0);
        await strip.evaluate((node) => { node.scrollLeft = 0; });
        await page.screenshot({ path: info.outputPath(`attachment-${theme}-390.png`) });
        const trigger = view.getByRole("button", { name: `${names[0]} 미리보기`, exact: true });
        await trigger.click();
        const preview = page.getByRole("dialog", { name: `${names[0]} 미리보기`, exact: true });
        await expect(preview.getByRole("img", { name: names[0]!, exact: true })).toBeVisible();
        expect((await preview.getByRole("img").boundingBox())!.height).toBeGreaterThan(80);
        await page.keyboard.press("Escape");
        await expect(preview).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await view.getByRole("button", { name: `${names[7]} 첨부 제거`, exact: true }).click();
        await expect(strip.getByRole("listitem")).toHaveCount(7);
        const saved = page.waitForResponse((response) => response.request().method() === "POST"
            && response.url().endsWith(`/api/v1/sessions/${session.id}/messages`));
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        expect((await saved).ok()).toBe(true);
        const sent = view.getByLabel("메시지 첨부파일");
        await expect(sent.getByRole("img")).toHaveCount(7);
        await expect(sent).toHaveText("");
        await page.reload();
        await expect(sent.getByRole("img")).toHaveCount(7);
        await expect(sent).toHaveText("");
    });
}

test("파일 목록의 더보기는 파일 정보와 같은 줄에 남는다", async ({ page }, info) => {
    const { b } = await ensureProjects();
    const name = "compact-file-actions.txt";
    const project = await apiCall<{ root_path: string }>("GET", `/projects/${b.id}`);
    writeFileSync(join(project.root_path, name), "layout");
    await login(page);
    await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await page.getByTestId("sidebar").getByTestId("projects").getByRole("button", { name: new RegExp(b.name) }).first().click();
    await startProjectConversation(page.getByTestId("project-view"));
    await openProjectFiles(page);
    const action = page.getByRole("button", { name: `${name} 작업`, exact: true });
    const row = page.getByRole("listitem").filter({ has: action });
    await expectInlineActions(row);
    await page.screenshot({ path: info.outputPath("file-actions-390.png") });
});

test("봇 목록의 더보기는 이름과 같은 줄에 남는다", async ({ page }, info) => {
    const { b } = await ensureProjects();
    const name = "작업 버튼 배치";
    await apiCall("POST", "/bots", { name, project_id: b.id });
    await login(page);
    await openBots(page);
    const row = page.getByTestId("bots-panel").getByTestId("bot").filter({ hasText: name });
    await expectInlineActions(row);
    await row.getByRole("button", { name: `${name} 관리`, exact: true }).click();
    await expect(page.getByRole("group", { name: `${name} 관리`, exact: true }).getByRole("button", { name: "편집", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.screenshot({ path: info.outputPath("bot-actions-390.png") });
});
