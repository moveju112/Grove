import { expect, test, type Locator, type Page } from "@playwright/test";
import { apiCall, composerOption, ensureProjects, login, modelSettings, sessionView, state } from "./helpers";

test("모델·추론·Fast 즐겨찾기는 두 기기에서 공유되고 공급자별 열로 나뉜다", async ({ page, browser }, info) => {
    const { a } = await ensureProjects();
    const codex = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: "Codex", protocol: "codex_cli", base_url: "", model: "fixture-codex",
    });
    const other = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: "API", protocol: "openai", base_url: `http://127.0.0.1:${state().fixturePort}/v1`, model: "fixture-alternate",
    });
    const title = `즐겨찾기 ${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    const second = await browser.newContext({ baseURL: "http://127.0.0.1:17741", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const open = async (target: Page) => {
        await target.bringToFront();
        await target.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
        await login(target);
        await target.getByRole("button", { name: "사이드바", exact: true }).click();
        await target.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title, exact: true }).click();
        await expect(target.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", false);
        return sessionView(target, session.id);
    };
    const addLabel = "현재 조합 즐겨찾기에 추가", removeLabel = "현재 조합 즐겨찾기에서 삭제";
    try {
        const view = await open(page);
        await composerOption(view, "모델 프로필", codex.id);
        await composerOption(view, "추론", "high");
        await composerOption(view, "Fast", true);
        const panel = await modelSettings(view);
        await panel.getByRole("button", { name: addLabel }).tap();
        await expect(panel.getByRole("button", { name: removeLabel })).toBeEnabled();
        await composerOption(view, "Fast", false);
        await composerOption(view, "모델 프로필", other.id);
        await composerOption(view, "추론", "medium");

        const device = await second.newPage();
        const otherView = await open(device);
        const otherPanel = await modelSettings(otherView);
        const grid = otherPanel.getByTestId("model-favorite-grid");
        await expect(grid.getByRole("button")).toHaveCount(1);

        await modelSettings(view);
        await panel.getByRole("button", { name: addLabel }).tap();
        await expect(panel.getByRole("button", { name: removeLabel })).toBeEnabled();
        await device.bringToFront();
        await expect(grid.getByRole("button")).toHaveCount(2);
        const fast = grid.getByRole("button", { name: /high · Fast 켜짐/ });
        const standard = grid.getByRole("button", { name: /· API · medium · Fast 꺼짐$/ });
        await fast.tap();
        await expect(fast).toHaveAttribute("aria-pressed", "true");
        await expect(otherPanel.getByRole("button", { name: "모델 프로필" })).toHaveAttribute("data-selected-profile", codex.id);
        await expect(otherPanel.getByRole("combobox", { name: "추론" })).toHaveAttribute("data-selected-value", "high");
        await expect(otherPanel.getByRole("switch", { name: "Fast" })).toBeChecked();
        // Codex 열이 왼쪽, 그 밖의 API 열이 오른쪽이다.
        const [left, right] = await Promise.all([fast.boundingBox(), standard.boundingBox()]);
        expect(left!.y).toBe(right!.y);
        expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x);
        await device.screenshot({ path: info.outputPath("model-favorites-390.png"), animations: "disabled" });

        await standard.tap();
        await expect(standard).toHaveAttribute("aria-pressed", "true");
        await expect(otherPanel.getByRole("button", { name: "모델 프로필" })).toHaveAttribute("data-selected-profile", other.id);
        await expect(otherPanel.getByRole("combobox", { name: "추론" })).toHaveAttribute("data-selected-value", "medium");
        await expect(otherView.getByRole("img", { name: "Fast 켜짐" })).toHaveCount(0);
        await otherPanel.getByRole("button", { name: removeLabel }).tap();
        await expect(otherPanel.getByRole("button", { name: addLabel })).toBeEnabled();
        await page.bringToFront();
        await expect(panel.getByTestId("model-favorite-grid").getByRole("button")).toHaveCount(1);
        const current = await apiCall<{ items: { key: string; effective: unknown; layers: { server: { revision: number } } }[] }>("GET", "/settings/effective");
        const saved = current.items.find((row) => row.key === "model.favorites")!;
        const remaining = { profile_id: codex.id, model: "fixture-codex", effort: "high", fast: true };
        expect(saved.effective).toEqual([remaining]);

        await apiCall("PUT", "/settings/server/-/model.favorites", {
            expected_revision: saved.layers.server.revision,
            value: [remaining, ...["low", "medium", "high", "xhigh"].map((effort) => ({ ...remaining, effort, fast: false })),
                { profile_id: other.id, model: "fixture-alternate", effort: "medium", fast: false }],
        });
        await device.bringToFront();
        const buttons = grid.getByRole("button");
        await expect(buttons).toHaveCount(6);
        for (const width of [390, 360]) {
            await device.setViewportSize({ width, height: 844 });
            await expect.poll(() => grid.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
            const boxes = await Promise.all(Array.from({ length: 6 }, (_, index) => buttons.nth(index).boundingBox()));
            // Codex 다섯 개는 왼쪽 열에 세로로, API 하나는 오른쪽 열 맨 위에 놓인다.
            for (let i = 0; i < 6; i++) {
                if (i > 0 && i < 5) {
                    expect(boxes[i]!.x).toBe(boxes[0]!.x);
                    expect(boxes[i]!.y).toBeGreaterThan(boxes[i - 1]!.y);
                }
                await expect(buttons.nth(i)).toBeInViewport({ ratio: 1 });
            }
            expect(boxes[5]!.y).toBe(boxes[0]!.y);
            expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[5]!.x);
            if (width === 390) await device.screenshot({ path: info.outputPath("model-favorites-grid-390.png"), animations: "disabled" });
        }
        const last = buttons.nth(4);
        await last.tap();
        await expect(last).toHaveAttribute("aria-pressed", "true");
        await expect(otherPanel.getByRole("combobox", { name: "추론" })).toHaveAttribute("data-selected-value", "xhigh");

        await device.setViewportSize({ width: 390, height: 844 });
        const cdp = await device.context().newCDPSession(device);
        const center = async (button: Locator) => {
            const box = (await button.boundingBox())!;
            return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        };
        const low = grid.getByRole("button", { name: /low · Fast 꺼짐/ });
        const hold = async () => {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [await center(low)] });
            await expect(low).toHaveAttribute("data-order-dragging", "true");
        };
        const keys = () => buttons.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-favorite-key")));
        const before = await keys();
        await hold();
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [await center(last)] });
        await expect(last).toHaveAttribute("data-order-drop", "true");
        await device.screenshot({ path: info.outputPath("model-favorite-drag-390.png"), animations: "disabled" });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
        await expect(low).not.toHaveAttribute("data-order-dragging", "true");
        expect(await keys()).toEqual(before);

        await hold();
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [await center(last)] });
        await expect(last).toHaveAttribute("data-order-drop", "true");
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        const expected = [before[0], before[2], before[3], before[4], before[1], before[5]];
        await expect.poll(keys).toEqual(expected);
        await expect(otherPanel.getByRole("combobox", { name: "추론" })).toHaveAttribute("data-selected-value", "xhigh");
        await page.bringToFront();
        const synced = panel.getByTestId("model-favorite-grid").getByRole("button");
        await expect.poll(() => synced.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-favorite-key")))).toEqual(expected);
    } finally {
        await second.close();
        const current = await apiCall<{ items: { key: string; layers: { server: { revision: number } } }[] }>("GET", "/settings/effective");
        const row = current.items.find((item) => item.key === "model.favorites");
        if (row) await apiCall("PUT", "/settings/server/-/model.favorites", { expected_revision: row.layers.server.revision, value: [] });
        for (const profile of [codex, other]) await apiCall("DELETE", `/model-profiles/${profile.id}`);
    }
});
