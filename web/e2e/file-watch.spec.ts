import { expect, test, type Page } from "@playwright/test";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { apiCall, ensureProjects, login, openProjectFiles } from "./helpers";

async function setup(page: Page) {
    const { a } = await ensureProjects();
    const project = await apiCall<{ root_path: string }>("GET", `/projects/${a.id}`);
    const name = `watch-${randomUUID()}.txt`;
    const path = join(project.root_path, name);
    writeFileSync(path, "original text\n");
    await login(page);
    await page.getByRole("button", { name: a.name, exact: true }).first().click();
    await openProjectFiles(page);
    const files = page.getByTestId("files-view");
    await files.getByRole("button", { name, exact: true }).click();
    const area = files.getByLabel("파일 내용");
    await expect(area).toHaveValue("original text\n");
    await expect(files.getByTestId("file-watch-status")).toHaveText("자동 확인 · 5초");
    return { project: a, name, path, files, area };
}

test("외부 편집을 자동 반영하고 파일 탭을 닫으면 주기 조회를 해제한다", async ({ page }) => {
    await page.clock.install();
    const { path, name, files, area } = await setup(page);
    let reads = 0;
    page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/files/content") && url.searchParams.get("path") === name) reads++;
    });
    await area.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 5));
    writeFileSync(path, "external text\n");
    await page.clock.runFor(5000);
    await expect(area).toHaveValue("external text\n");
    expect(await area.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([2, 5]);
    await expect(files.getByRole("status").filter({ hasText: /\S/ })).toContainText("외부 변경을 반영");
    await page.getByRole("tab", { selected: true }).getByRole("button", { name: "탭 닫기", exact: true }).click();
    const before = reads;
    await page.clock.runFor(10_000);
    expect(reads).toBe(before);
    await expect(page.getByTestId("file-editor")).toHaveCount(0);
});

test("서버 변경 이벤트는 바로 확인하되 저장 전 편집과 이전 SHA를 보존한다", async ({ page }) => {
    const { project, name, path, files, area } = await setup(page);
    await area.fill("my unsaved edit\n");
    const original = await apiCall<{ sha256: string }>("GET", `/projects/${project.id}/files/content?path=${encodeURIComponent(name)}`);
    await apiCall("PUT", `/projects/${project.id}/files/content`, { path: name, expected_sha256: original.sha256, text: "other device edit\n" });
    await expect(files.getByRole("status").filter({ hasText: /\S/ })).toContainText("파일이 바뀌었습니다");
    await expect(area).toHaveValue("my unsaved edit\n");
    await expect(files.getByRole("button", { name: "최신 내용 불러오기", exact: true })).toBeVisible();
    await files.getByRole("button", { name: "저장", exact: true }).click();
    await expect(files.getByRole("status").filter({ hasText: /\S/ })).toContainText("파일이 바뀌었습니다");
    expect(readFileSync(path, "utf8")).toBe("other device edit\n");
    await expect(area).toHaveValue("my unsaved edit\n");
});

test("파일 삭제를 감지해도 입력을 지우거나 파일을 자동 재생성하지 않는다", async ({ page }) => {
    const { project, name, files, area } = await setup(page);
    await area.fill("keep this copy\n");
    await apiCall("POST", `/projects/${project.id}/files/op`, { op: "delete", path: name, confirm: name });
    await expect(files.getByRole("status").filter({ hasText: /\S/ })).toContainText("파일 변경을 확인하지 못했습니다");
    await expect(area).toHaveValue("keep this copy\n");
    await files.getByRole("button", { name: "저장", exact: true }).click();
    await expect(files.getByRole("status").filter({ hasText: /\S/ })).toContainText(/없|사라/);
    await expect(area).toHaveValue("keep this copy\n");
});

test("배치를 숨기면 변경 확인을 해제하고 복원할 때 DOM·선택을 유지해 즉시 다시 확인한다", async ({ page }) => {
    await page.clock.install();
    const { path, name, area, files } = await setup(page);
    const input = await area.elementHandle();
    await area.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(1, 4));
    let reads = 0;
    page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/files/content") && url.searchParams.get("path") === name) reads++;
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(files.getByTestId("file-watch-status")).toHaveText("변경 확인 일시정지");
    const before = reads;
    writeFileSync(path, "changed while hidden\n");
    await page.clock.runFor(10_000);
    expect(reads).toBe(before);
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(area).toHaveValue("changed while hidden\n");
    expect(await input!.evaluate((node: HTMLTextAreaElement) => ({ connected: node.isConnected, start: node.selectionStart, end: node.selectionEnd })))
        .toEqual({ connected: true, start: 1, end: 4 });
});
