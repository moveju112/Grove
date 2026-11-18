import { expect, test } from "@playwright/test";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, sessionView } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

for (const theme of ["light", "dark"] as const) {
    test(`${theme}: 여러 줄 입력 중 대화 위치를 보존하고 입력·삭제·폭 변경에 맞춰 높이를 조절한다`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript((theme) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme })), theme);
        const { a } = await ensureProjects();
        await ensureProfile();
        const title = `입력 흔들림 ${theme}`;
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
        for (let i = 0; i < 24; i++) await apiCall("POST", `/sessions/${session.id}/messages`, {
            text: `메시지 ${i}\n${"입력하는 동안 대화 본문이 움직이면 안 됩니다. ".repeat(8)}`,
        });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
        await login(page);
        const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
        if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title }).first().click();
        const view = sessionView(page, session.id);
        const input = view.getByLabel("메시지 입력", { exact: true });
        await composerOption(view, "보내기 방식", "save");
        const geometry = () => input.evaluate((node) => {
            const pane = node.closest<HTMLElement>('[data-testid="pane-body"]')!;
            return { y: node.getBoundingClientRect().y, height: node.getBoundingClientRect().height, scroll: pane.scrollTop };
        });
        const settle = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        for (const viewportHeight of [844, 500]) {
            await page.setViewportSize({ width: 390, height: viewportHeight });
            for (const lines of [4, 12]) {
                const text = Array.from({ length: lines }, (_, i) => `입력 줄 ${i}`).join("\n") + " ";
                await input.fill(text);
                await input.evaluate((node) => {
                    const pane = node.closest<HTMLElement>('[data-testid="pane-body"]')!;
                    pane.scrollTop = pane.scrollHeight;
                });
                await settle();
                const before = await geometry();
                for (const character of "abcdefgh") {
                    await input.press(character);
                    await settle();
                    const current = await geometry();
                    expect(Math.abs(current.scroll - before.scroll)).toBeLessThanOrEqual(1);
                    expect(Math.abs(current.y - before.y)).toBeLessThanOrEqual(1);
                    expect(current.height).toBe(before.height);
                }
                await expect(input).toHaveValue(text + "abcdefgh");
                await settle();
                const after = await geometry();
                expect(Math.abs(after.scroll - before.scroll)).toBeLessThanOrEqual(1);
                expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
                expect(after.height).toBe(before.height);
                expect(after.height).toBeLessThanOrEqual(160);
            }
        }
        // 한글 조합 중의 중간 입력도 같은 높이·스크롤을 유지한다.
        const prefix = "첫 줄\n둘째 줄\n셋째 줄\n넷째 줄 ";
        await input.fill(prefix);
        await input.evaluate((node) => {
            const pane = node.closest<HTMLElement>('[data-testid="pane-body"]')!;
            pane.scrollTop = pane.scrollHeight;
        });
        await settle();
        const composing = await geometry();
        const ime = await page.context().newCDPSession(page);
        try {
            for (const text of ["ㅎ", "하", "한"]) {
                await ime.send("Input.imeSetComposition", { text, selectionStart: 1, selectionEnd: 1 });
                await expect(input).toHaveValue(prefix + text);
                await settle();
                const current = await geometry();
                expect(Math.abs(current.scroll - composing.scroll)).toBeLessThanOrEqual(1);
                expect(Math.abs(current.y - composing.y)).toBeLessThanOrEqual(1);
                expect(current.height).toBe(composing.height);
            }
            await ime.send("Input.insertText", { text: "한" });
            await expect(input).toHaveValue(prefix + "한");
        } finally { await ime.detach(); }
        // 빈 입력·붙여넣기·삭제로 실제 내용이 달라지면 늘어나고 다시 줄어든다.
        await input.fill("");
        await settle();
        const empty = await geometry();
        await input.fill("첫 줄\n둘째 줄\n셋째 줄\n넷째 줄");
        await settle();
        expect((await geometry()).height).toBeGreaterThan(empty.height);
        await input.fill("짧게");
        await settle();
        expect((await geometry()).height).toBe(empty.height);
        const long = "화면 폭에 맞춰 자연스럽게 줄바꿈하는 입력 내용입니다. ".repeat(6);
        await input.fill(long);
        await page.setViewportSize({ width: 700, height: 844 });
        await settle();
        const wide = await geometry();
        await page.setViewportSize({ width: 390, height: 844 });
        await settle();
        expect((await geometry()).height).toBeGreaterThan(wide.height);
        await expect(input).toHaveValue(long);
        await page.screenshot({ path: info.outputPath(`typing-${theme}-390.png`), animations: "disabled" });
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(input).toHaveValue("");
        await expect.poll(async () => (await geometry()).height).toBe(empty.height);
        await expect(view.getByTestId("msg-user").last()).toContainText(long.trim());
    });
}
