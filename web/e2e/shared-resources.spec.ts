import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProjects, login, openProjectFiles } from "./helpers";

test("백그라운드 작업과 충돌한 파일 저장은 내 편집을 남기고 작업 종료 뒤 저장된다", async ({ page }) => {
    const { a } = await ensureProjects();
    const project = await apiCall<{ root_path: string }>("GET", `/projects/${a.id}`);
    const name = `resource-${Date.now()}.txt`;
    const path = join(project.root_path, name);
    writeFileSync(path, "original\n");
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: name });
    let task: string | undefined;
    try {
        await login(page);
        await page.getByRole("button", { name: a.name, exact: true }).first().click();
        await openProjectFiles(page);
        const files = page.getByTestId("files-view");
        await files.getByRole("button", { name, exact: true }).click();
        const editor = files.getByLabel("파일 내용");
        await expect(editor).toHaveValue("original\n");
        await editor.fill("my edit\n");
        task = (await apiCall<{ id: string }>("POST", `/sessions/${session.id}/tasks`, { command: "sleep 30" })).id;
        await files.getByRole("button", { name: "저장", exact: true }).click();
        await expect(files.getByRole("status")).toContainText("다른 파일·Git 작업 또는 프로세스");
        await expect(editor).toHaveValue("my edit\n");
        expect(readFileSync(path, "utf8")).toBe("original\n");
        await apiCall("POST", `/tasks/${task}/cancel`);
        await apiCall("GET", `/tasks/${task}/wait?timeout_ms=5000`);
        task = undefined;
        await files.getByRole("button", { name: "저장", exact: true }).click();
        await expect(files.getByRole("status")).toHaveText("저장됨");
        expect(readFileSync(path, "utf8")).toBe("my edit\n");
    } finally {
        if (task) {
            await apiCall("POST", `/tasks/${task}/cancel`);
            await apiCall("GET", `/tasks/${task}/wait?timeout_ms=5000`);
        }
        unlinkSync(path);
    }
});
