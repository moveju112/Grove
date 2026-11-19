import { expect, test, type Page } from "@playwright/test";
import { apiCall, composerOption, ensureProjects, login, modelSettings, sessionView, state } from "./helpers";

test("모델·추론·Fast 즐겨찾기는 두 기기에서 공유되고 두 열로 펼쳐진다", async ({ page, browser }, info) => {
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
        const [left, right] = await Promise.all([standard.boundingBox(), fast.boundingBox()]);
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
            for (const i of [0, 2, 4]) {
                const [first, next] = [boxes[i]!, boxes[i + 1]!];
                expect(first.y).toBe(next.y);
                expect(first.x + first.width).toBeLessThanOrEqual(next.x);
                if (i > 0) expect(first.y).toBeGreaterThan(boxes[i - 2]!.y);
                await expect(buttons.nth(i)).toBeInViewport({ ratio: 1 });
                await expect(buttons.nth(i + 1)).toBeInViewport({ ratio: 1 });
            }
            if (width === 390) await device.screenshot({ path: info.outputPath("model-favorites-grid-390.png"), animations: "disabled" });
        }
        const last = buttons.nth(4);
        await last.tap();
        await expect(last).toHaveAttribute("aria-pressed", "true");
        await expect(otherPanel.getByRole("combobox", { name: "추론" })).toHaveAttribute("data-selected-value", "xhigh");
    } finally {
        await second.close();
        const current = await apiCall<{ items: { key: string; layers: { server: { revision: number } } }[] }>("GET", "/settings/effective");
        const row = current.items.find((item) => item.key === "model.favorites");
        if (row) await apiCall("PUT", "/settings/server/-/model.favorites", { expected_revision: row.layers.server.revision, value: [] });
        for (const profile of [codex, other]) await apiCall("DELETE", `/model-profiles/${profile.id}`);
    }
});
