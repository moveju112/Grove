import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login } from "./helpers";

test("좌측 프로젝트 목록은 저장된 라벨과 예전 필터 설정의 영향을 받지 않는다", async ({ page }) => {
    const { a, b } = await ensureProjects();
    const name = `기존 라벨 ${randomUUID().slice(0, 8)}`;
    const label = await apiCall<{ id: string; revision: number }>("POST", "/labels", { name, color: "red", project_id: a.id });
    try {
        await page.addInitScript((id) => localStorage.setItem("grove.labelFilter", JSON.stringify([id])), label.id);
        await login(page);
        const list = page.getByTestId("projects");
        for (const project of [a, b]) await expect(list.getByTestId("project-row").getByRole("button", { name: project.name, exact: true })).toBeVisible();
        await expect(list.getByText(name, { exact: true })).toHaveCount(0);
        await list.getByRole("button", { name: "프로젝트 목록 옵션", exact: true }).click();
        const menu = page.getByRole("dialog", { name: "프로젝트 목록 옵션", exact: true });
        await expect(menu.getByRole("combobox", { name: "프로젝트 정렬" })).toBeVisible();
        await expect(menu.getByRole("button", { name: "보관됨", exact: true })).toBeVisible();
        await expect(menu.getByRole("button", { name: /라벨|label/i })).toHaveCount(0);
        expect(await apiCall<{ labels: string[] }>("GET", `/projects/${a.id}`)).toMatchObject({ labels: expect.arrayContaining([label.id]) });
    } finally {
        await apiCall("DELETE", `/labels/${label.id}?expected_revision=${label.revision}`);
    }
});
