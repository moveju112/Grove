import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProjects, state } from "./helpers";

async function openFile(page: Page) {
    const { a } = await ensureProjects();
    const project = await apiCall<{ root_path: string }>("GET", `/projects/${a.id}`);
    const name = `external-editor-${randomUUID()}.txt`;
    writeFileSync(join(project.root_path, name), "saved text\n");
    await page.goto("/");
    await page.locator("html[data-hydrated=true]").waitFor({ state: "attached" });
    await page.getByLabel("토큰").fill(state().token);
    await page.getByRole("button", { name: "로그인" }).click();
    await page.getByRole("button", { name: a.name, exact: true }).first().click();
    await page.getByRole("button", { name: "파일", exact: true }).click();
    const files = page.getByTestId("files-view");
    await files.getByRole("button", { name, exact: true }).click();
    await expect(files.getByLabel("파일 내용")).toHaveValue("saved text\n");
    return { a, name, files };
}

test("PC capability가 있으면 고정 ID로 저장된 파일을 열도록 요청한다", async ({ page }) => {
    // 데스크톱 capability만 흉내 내고 실제 편집기 실행은 차단한다.
    await page.route("**/api/v1/external-editors", (route) => route.fulfill({ json: {
        available: true, reason: null, editors: [{ id: "vscode", name: "VS Code" }, { id: "zed", name: "Zed" }],
    } }));
    await page.route("**/api/v1/projects/*/external-editor", (route) => route.fulfill({ status: 202, json: { launched: true } }));
    const { a, name, files } = await openFile(page);
    await files.getByLabel("파일 내용").fill("unsaved text");
    await files.getByLabel("외부 편집기", { exact: true }).selectOption("zed");
    const request = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith(`/projects/${a.id}/external-editor`));
    await files.getByRole("button", { name: "외부 편집기로 열기", exact: true }).click();
    expect((await request).postDataJSON()).toEqual({ editor_id: "zed", path: name });
    await expect(files.getByTestId("external-editor")).toContainText("편집기 실행을 요청했습니다");
    await expect(files.getByLabel("파일 내용")).toHaveValue("unsaved text");
});

test("헤드리스·원격 서버는 열기 버튼 대신 이유를 표시한다", async ({ page }) => {
    await page.route("**/api/v1/external-editors", (route) => route.fulfill({ json: {
        available: false, reason: "서버 사용자에게 GUI 세션이 없습니다.", editors: [],
    } }));
    const { files } = await openFile(page);
    await expect(files.getByTestId("external-editor")).toContainText("GUI 세션이 없습니다");
    await expect(files.getByRole("button", { name: "외부 편집기로 열기", exact: true })).toHaveCount(0);
});

test("서버가 기능을 알리지 않으면 편집기 UI와 목록 조회를 숨긴다", async ({ page }) => {
    let requests = 0;
    await page.route("**/api/v1/external-editors", (route) => {
        requests++;
        return route.fulfill({ json: { available: false, reason: "호출되면 안 됩니다", editors: [] } });
    });
    await page.route("**/api/v1/events**", (route) => route.fulfill({
        status: 200, headers: { "content-type": "text/event-stream", "x-grove-protocol": "1" },
        body: `event: hello\ndata: ${JSON.stringify({ cursor: 0, protocol: 1, capabilities: ["trash_v1"] })}\n\n`,
    }));
    const { files } = await openFile(page);
    await expect(files.getByTestId("external-editor")).toHaveCount(0);
    expect(requests).toBe(0);
});

test("응답을 잃으면 같은 요청 키로 결과를 확인한다", async ({ page }) => {
    await page.route("**/api/v1/external-editors", (route) => route.fulfill({ json: {
        available: true, reason: null, editors: [{ id: "vscode", name: "VS Code" }],
    } }));
    const keys: string[] = [];
    await page.route("**/api/v1/projects/*/external-editor", (route) => {
        const key = route.request().headers()["idempotency-key"];
        if (!key) throw new Error("외부 편집기 요청에 Idempotency-Key가 없습니다");
        keys.push(key);
        return keys.length === 1 ? route.abort("failed") : route.fulfill({ status: 202, json: { launched: true } });
    });
    const { files } = await openFile(page);
    await files.getByRole("button", { name: "외부 편집기로 열기", exact: true }).click();
    await expect(files.getByTestId("external-editor").getByRole("alert")).toBeVisible();
    await files.getByRole("button", { name: "외부 편집기로 열기", exact: true }).click();
    await expect(files.getByTestId("external-editor")).toContainText("편집기 실행을 요청했습니다");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
});
