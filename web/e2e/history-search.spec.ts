import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, state } from "./helpers";

// 프로젝트 기록에서 제목·본문을 찾고, 본문 결과는 첫 화면 밖 메시지까지 읽어 그 위치로 이동한다.
for (const width of [1400, 390]) {
    test(`${width}px: 기록 검색 결과에서 정확한 메시지로 이동한다`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 844 });
        const project = await apiCall<{ id: string; name: string }>("POST", "/projects", {
            root_path: mkdtempSync(join(dirname(state().projA), "history-search-")),
        });
        const word = `needle${Date.now()}`;
        const long = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: "긴 대화" });
        for (let i = 0; i < 230; i++) {
            await apiCall("POST", `/sessions/${long.id}/messages`, { text: i === 10 ? `여기에 ${word} 가 있다` : `채움 메시지 ${i}` });
        }
        await apiCall("POST", `/projects/${project.id}/sessions`, { title: "검색되지 않을 대화" });
        await login(page);
        if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
        const row = page.getByTestId("project-row").filter({ hasText: project.name });
        await row.getByRole("button", { name: "프로젝트 메뉴", exact: true }).click();
        await page.getByRole("dialog", { name: `${project.name} 메뉴`, exact: true }).getByRole("button", { name: "기록", exact: true }).click();
        const history = page.getByRole("dialog", { name: `${project.name} 기록`, exact: true });
        await expect(history.getByRole("button", { name: "검색되지 않을 대화", exact: true })).toBeVisible();

        await history.getByLabel("대화 검색").fill(word);
        const hit = history.getByTestId("search-hit");
        await expect(hit).toHaveCount(1);
        await expect(hit).toContainText(word);
        await expect(history.getByRole("button", { name: "검색되지 않을 대화", exact: true })).toHaveCount(0);
        await page.screenshot({ path: info.outputPath(`history-search-${width}.png`) });

        // 결과가 없으면 비어 있음을, 검색어를 지우면 원래 목록을 보여 준다.
        await history.getByLabel("대화 검색").fill(`${word}없음`);
        await expect(history.getByText("검색 결과가 없어요.")).toBeVisible();
        await history.getByLabel("대화 검색").fill("");
        await expect(history.getByRole("button", { name: "검색되지 않을 대화", exact: true })).toBeVisible();

        await history.getByLabel("대화 검색").fill(word);
        await history.getByTestId("search-hit").getByRole("button", { name: "긴 대화", exact: true }).click();
        await expect(history).toHaveCount(0);
        const view = page.getByTestId("session-view").filter({ visible: true });
        const target = view.locator('[data-seq][data-highlighted="true"]');
        await expect(target).toHaveCount(1, { timeout: 15_000 });
        await expect(target).toContainText(word);
        await expect(target).toBeInViewport();
    });
}
