import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login } from "./helpers";

test("시간 표시 설정은 이 기기에서 즉시 적용되고 새로고침 뒤에도 유지되며 정확한 시각을 함께 보여 준다", async ({ page }) => {
    const { a } = await ensureProjects();
    const title = `시간 표시 ${Date.now()}`;
    await apiCall("POST", `/projects/${a.id}/sessions`, { title });
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: a.name, exact: true }).click();
    const row = page.getByRole("listitem").filter({ hasText: title });
    const time = row.getByTestId("session-updated").locator("time");
    const listTab = page.getByRole("tab").getByRole("button", { name: `${a.name} 대화 목록`, exact: true });
    const settings = async (style: "relative" | "absolute", clock: "12h" | "24h") => {
        await page.getByRole("button", { name: "설정", exact: true }).first().click();
        await page.getByLabel("설정 검색", { exact: true }).fill("시간 표시");
        await page.getByLabel("지난 시각 표시", { exact: true }).selectOption(style);
        await page.getByLabel("시계 형식", { exact: true }).selectOption(clock);
        await listTab.click();
    };
    await expect(time).toHaveText(/\d/);
    await expect(time).not.toHaveText("방금 전");

    await settings("relative", "12h");
    await expect(time).toHaveText("방금 전");
    await expect(time).toHaveAttribute("title", /AM|PM|오전|오후/);

    await page.reload();
    await listTab.click();
    await expect(time).toHaveText("방금 전");
    await settings("absolute", "24h");
    await expect(time).not.toHaveText(/방금 전|AM|PM|오전|오후/);
    await expect(time).toHaveAttribute("title", /\d/);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("grove.device.prefs")!))).toMatchObject({ clock: "24h", timeStyle: "absolute" });
});
