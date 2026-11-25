import { expect, test, type Locator } from "@playwright/test";
import { apiCall, ensureProjects, login, modelSettings, sessionView } from "./helpers";

type Saved = { items: { key: string; effective: unknown; layers: { server: { revision: number } } }[] };
const favorites = async () => (await apiCall<Saved>("GET", "/settings/effective")).items.find((row) => row.key === "model.favorites");

test("PC에서는 즐겨찾기를 마우스로 끌어 순서를 바꾸고, 짧은 클릭은 그대로 적용한다", async ({ page }, info) => {
    const { a } = await ensureProjects();
    const profile = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: "Codex", protocol: "codex_cli", base_url: "", model: "fixture-codex",
    });
    const title = `즐겨찾기 마우스 ${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    const efforts = ["low", "medium", "high", "xhigh"];
    try {
        await apiCall("PUT", "/settings/server/-/model.favorites", {
            expected_revision: (await favorites())!.layers.server.revision,
            value: efforts.map((effort) => ({ profile_id: profile.id, model: "fixture-codex", effort, fast: false })),
        });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await login(page);
        const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
        if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title, exact: true }).click();
        const panel = await modelSettings(sessionView(page, session.id));
        const buttons = panel.getByTestId("model-favorite-grid").getByRole("button");
        await expect(buttons).toHaveCount(4);
        const chip = (effort: string) => buttons.filter({ hasText: new RegExp(`^.*${effort} · Fast 꺼짐$`) }).and(panel.locator(`[aria-label*="· ${effort} ·"]`));
        const center = async (button: Locator) => {
            const box = (await button.boundingBox())!;
            return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        };
        const order = () => buttons.evaluateAll((nodes) => nodes.map((node) => JSON.parse(node.getAttribute("data-favorite-key")!)[2]));
        expect(await order()).toEqual(efforts);
        const [low, xhigh] = [chip("low"), chip("xhigh")];

        // 누른 채 움직이면 들리고, 놓을 자리를 표시한다.
        const from = await center(low), to = await center(xhigh);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x + 12, from.y + 4, { steps: 2 });
        await expect(low).toHaveAttribute("data-order-dragging", "true");
        await page.mouse.move(to.x, to.y, { steps: 6 });
        await expect(xhigh).toHaveAttribute("data-order-drop", "true");
        await page.screenshot({ path: info.outputPath("model-favorite-mouse-drag.png"), animations: "disabled" });
        // Escape는 순서를 바꾸지 않고 끌기를 취소한다.
        await page.keyboard.press("Escape");
        await expect(low).not.toHaveAttribute("data-order-dragging", "true");
        await page.mouse.up();
        expect(await order()).toEqual(efforts);
        await expect(panel).toBeVisible();

        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 8 });
        await expect(xhigh).toHaveAttribute("data-order-drop", "true");
        await page.mouse.up();
        const moved = ["medium", "high", "xhigh", "low"];
        await expect.poll(order).toEqual(moved);
        // 끌어 놓은 직후의 클릭으로 즐겨찾기가 선택되지 않는다.
        await expect(buttons.and(panel.locator('[aria-pressed="true"]'))).toHaveCount(0);
        await expect.poll(async () => ((await favorites())!.effective as { effort: string }[]).map((row) => row.effort)).toEqual(moved);

        // 움직이지 않은 클릭은 그 조합을 적용한다.
        await chip("high").click();
        await expect(chip("high")).toHaveAttribute("aria-pressed", "true");
        await expect(panel.getByRole("combobox", { name: "추론" })).toHaveAttribute("data-selected-value", "high");
        expect(await order()).toEqual(moved);
    } finally {
        const row = await favorites();
        if (row) await apiCall("PUT", "/settings/server/-/model.favorites", { expected_revision: row.layers.server.revision, value: [] });
        await apiCall("DELETE", `/model-profiles/${profile.id}`);
    }
});
