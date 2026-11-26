import { expect, test, type Locator } from "@playwright/test";
import { apiCall, ensureProjects, login, modelSettings, sessionView } from "./helpers";

type Saved = { items: { key: string; effective: unknown; layers: { server: { revision: number } } }[] };
const favorites = async () => (await apiCall<Saved>("GET", "/settings/effective")).items.find((row) => row.key === "model.favorites");

test("PC에서는 즐겨찾기를 공급자 열로 나누고, 같은 열 안에서 마우스로 끌어 순서를 바꾸며, 짧은 클릭은 그대로 적용한다", async ({ page }, info) => {
    const { a } = await ensureProjects();
    const profile = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: "Codex", protocol: "codex_cli", base_url: "", model: "fixture-codex",
    });
    const claude = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: "Claude", protocol: "claude_code", base_url: "", model: "default",
    });
    const claudeFavorite = { profile_id: claude.id, model: "fixture-claude", effort: "high", fast: false };
    const title = `즐겨찾기 마우스 ${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    const efforts = ["low", "medium", "high", "xhigh"];
    try {
        await apiCall("PUT", "/settings/server/-/model.favorites", {
            expected_revision: (await favorites())!.layers.server.revision,
            // 저장 순서에 섞여 있어도 Claude는 왼쪽, Codex는 오른쪽 열에 모인다.
            value: efforts.map((effort) => ({ profile_id: profile.id, model: "fixture-codex", effort, fast: false }))
                .flatMap((row, index) => index === 1 ? [claudeFavorite, row] : [row]),
        });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await login(page);
        const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
        if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title, exact: true }).click();
        const panel = await modelSettings(sessionView(page, session.id));
        const grid = panel.getByTestId("model-favorite-grid");
        await expect(grid.getByRole("button")).toHaveCount(5);
        const [claudeColumn, codexColumn] = [grid.getByRole("group", { name: "Claude" }), grid.getByRole("group", { name: "Codex" })];
        const claudeChip = claudeColumn.getByRole("button");
        await expect(claudeChip).toHaveCount(1);
        const buttons = codexColumn.getByRole("button");
        await expect(buttons).toHaveCount(4);
        const [claudeBox, codexBox] = await Promise.all([claudeColumn.boundingBox(), codexColumn.boundingBox()]);
        expect(claudeBox!.x + claudeBox!.width).toBeLessThanOrEqual(codexBox!.x);
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
        // 다른 공급자 열은 놓을 자리가 되지 않는다.
        const claudeCenter = await center(claudeChip);
        await page.mouse.move(claudeCenter.x, claudeCenter.y, { steps: 6 });
        await expect(claudeChip).not.toHaveAttribute("data-order-drop", "true");
        await page.mouse.move(to.x, to.y, { steps: 6 });
        await expect(xhigh).toHaveAttribute("data-order-drop", "true");
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
        await expect.poll(async () => ((await favorites())!.effective as { profile_id: string; effort: string }[])
            .filter((row) => row.profile_id === profile.id).map((row) => row.effort)).toEqual(moved);

        // 움직이지 않은 클릭은 그 조합을 적용한다.
        await chip("high").click();
        await expect(chip("high")).toHaveAttribute("aria-pressed", "true");
        await expect(panel.getByRole("combobox", { name: "추론" })).toHaveAttribute("data-selected-value", "high");
        expect(await order()).toEqual(moved);

        // 지웠다 다시 추가한 즐겨찾기는 맨 아래에 붙는다.
        await panel.getByRole("button", { name: "현재 조합 즐겨찾기에서 삭제" }).click();
        await expect.poll(order).toEqual(["medium", "xhigh", "low"]);
        await panel.getByRole("button", { name: "현재 조합 즐겨찾기에 추가" }).click();
        const appended = ["medium", "xhigh", "low", "high"];
        await expect.poll(order).toEqual(appended);
        await expect.poll(async () => ((await favorites())!.effective as { profile_id: string; effort: string }[])
            .map((row) => row.profile_id === profile.id ? row.effort : "claude")).toEqual(["claude", ...appended]);
    } finally {
        const row = await favorites();
        if (row) await apiCall("PUT", "/settings/server/-/model.favorites", { expected_revision: row.layers.server.revision, value: [] });
        for (const id of [profile.id, claude.id]) await apiCall("DELETE", `/model-profiles/${id}`);
    }
});
