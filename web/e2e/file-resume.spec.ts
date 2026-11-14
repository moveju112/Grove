import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProjects, login } from "./helpers";

test("파일 탭과 최근 항목을 다시 열면 저장 전 편집·선택·스크롤 위치를 복원한다", async ({ page }) => {
    const { a } = await ensureProjects();
    const project = await apiCall<{ root_path: string }>("GET", `/projects/${a.id}`);
    const name = `resume-${Date.now()}.txt`;
    const original = Array.from({ length: 150 }, (_, i) => `원문 ${i}`).join("\n");
    const edited = `${original}\n아직 저장하지 않은 편집`;
    writeFileSync(join(project.root_path, name), original);
    await login(page);
    await page.getByRole("button", { name: a.name, exact: true }).first().click();
    await page.getByRole("button", { name: "파일", exact: true }).click();
    const files = page.getByTestId("files-view");
    await files.getByRole("button", { name, exact: true }).click();
    const area = files.getByLabel("파일 내용");
    await expect(area).toHaveValue(original);
    await area.fill(edited);
    const position = await area.evaluate((node: HTMLTextAreaElement) => {
        node.setSelectionRange(500, 520, "backward");
        node.scrollTop = 600;
        node.dispatchEvent(new Event("scroll", { bubbles: true }));
        return { start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection, top: node.scrollTop };
    });
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.locator(".tabbar .tab-title").filter({ hasText: `파일 · ${a.name}` }).click();
    await expect(area).toHaveValue(edited);
    await expect.poll(() => area.evaluate((node: HTMLTextAreaElement) => ({
        start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection, top: node.scrollTop,
    }))).toEqual(position);
    await expect(files.getByText("● 저장 안 됨", { exact: true })).toBeVisible();
    expect(readFileSync(join(project.root_path, name), "utf8")).toBe(original);
    await page.locator(".tabbar .tab.on").getByRole("button", { name: "탭 닫기", exact: true }).click();
    await page.locator(".recent").getByRole("button", { name: new RegExp(name) }).click();
    await expect(area).toHaveValue(edited);
    await expect.poll(() => area.evaluate((node: HTMLTextAreaElement) => node.selectionStart)).toBe(position.start);
    await files.getByRole("button", { name: "저장", exact: true }).click();
    await expect(files.getByRole("status").filter({ hasText: /\S/ })).toHaveText("저장됨");
    expect(readFileSync(join(project.root_path, name), "utf8")).toBe(edited);
});

async function openFixture(page: Page, prefix: string) {
    const { a } = await ensureProjects();
    const project = await apiCall<{ root_path: string }>("GET", `/projects/${a.id}`);
    const name = `${prefix}-${Date.now()}.txt`;
    const path = join(project.root_path, name);
    writeFileSync(path, "original\n");
    await login(page);
    await page.getByRole("button", { name: a.name, exact: true }).first().click();
    await page.getByRole("button", { name: "파일", exact: true }).click();
    const files = page.getByTestId("files-view");
    await files.getByRole("button", { name, exact: true }).click();
    const area = files.getByLabel("파일 내용");
    await expect(area).toHaveValue("original\n");
    const revisit = async (title = `파일 · ${a.name}`) => {
        await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
        await page.locator(".tabbar .tab-title").filter({ hasText: title }).click();
    };
    return { project: a, name, path, files, area, revisit };
}

test("화면을 떠난 사이 원문이 바뀌면 편집 사본의 이전 해시를 유지해 외부 변경을 덮어쓰지 않는다", async ({ page }) => {
    const { path, files, area, revisit } = await openFixture(page, "resume-conflict");
    await area.fill("my edit\n");
    writeFileSync(path, "external edit\n");
    await revisit();
    await expect(area).toHaveValue("my edit\n");
    await expect(files.getByRole("status").filter({ hasText: /\S/ })).toContainText("파일이 바뀌었습니다");
    await files.getByRole("button", { name: "저장", exact: true }).click();
    await expect(files.getByRole("status").filter({ hasText: /\S/ })).toContainText("파일이 바뀌었습니다");
    expect(readFileSync(path, "utf8")).toBe("external edit\n");
    await expect(area).toHaveValue("my edit\n");
    page.once("dialog", (dialog) => dialog.accept());
    await files.getByRole("button", { name: "최신 내용 불러오기", exact: true }).click();
    await expect(area).toHaveValue("external edit\n");
    await revisit();
    await expect(area).toHaveValue("external edit\n");
    await expect(files.getByText("● 저장 안 됨", { exact: true })).toHaveCount(0);
});

test("저장 응답이 유실된 뒤 탭을 다시 열어도 자동 전송 없이 같은 요청으로 결과를 확인한다", async ({ page }) => {
    const { project, name, path, files, area, revisit } = await openFixture(page, "resume-receipt");
    await area.fill("saved once\n");
    const sent: { key: string; body: string | null }[] = [];
    await page.route(`**/api/v1/projects/${project.id}/files/content`, async (route) => {
        const request = route.request();
        if (request.method() !== "PUT") return route.continue();
        sent.push({ key: request.headers()["idempotency-key"]!, body: request.postData() });
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        if (sent.length === 1) await route.abort("failed");
        else {
            expect(response.headers()["idempotent-replayed"]).toBe("true");
            await route.fulfill({ response });
        }
    });
    await files.getByRole("button", { name: "저장", exact: true }).click();
    const retry = files.getByRole("button", { name: "같은 요청 결과 확인", exact: true });
    await expect(retry).toBeVisible();
    await page.locator(".tabbar .tab.on").getByRole("button", { name: "탭 닫기", exact: true }).click();
    await page.locator(".recent").getByRole("button", { name: new RegExp(name) }).click();
    await expect(retry).toBeVisible();
    // 새 탭에 이어받은 보류 요청도 다시 화면을 바꾼 뒤까지 유지한다.
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.locator(".tabbar .tab-title").filter({ hasText: name }).click();
    await expect(retry).toBeVisible();
    await expect(area).toHaveJSProperty("readOnly", true);
    expect(sent).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe("saved once\n");
    await retry.click();
    await expect(files.getByRole("status").filter({ hasText: /\S/ })).toHaveText("저장됨");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    await expect(area).toHaveValue("saved once\n");
    await expect(area).toHaveJSProperty("readOnly", false);
    await revisit(name);
    await expect(retry).toHaveCount(0);
});

test("로그아웃은 파일 편집·위치·보류 요청 사본을 정리한다", async ({ page }) => {
    const { area } = await openFixture(page, "resume-logout");
    await area.fill("private file edit fixture");
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("grove.file.buffer.")))).toBe(true);
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("로그아웃");
    await page.getByRole("button", { name: "이 브라우저에서 로그아웃" }).click();
    await expect(page.getByRole("form", { name: "로그인" })).toBeVisible();
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("grove.file.")))).toEqual([]);
});

test("최근 파일 이름 끝의 콜론과 숫자를 줄 번호로 해석하지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    const project = await apiCall<{ root_path: string }>("GET", `/projects/${a.id}`);
    const name = `literal-${Date.now()}:42`;
    writeFileSync(join(project.root_path, name), "literal colon filename fixture");
    await apiCall("POST", "/recent/touch", { kind: "file", project_id: a.id, resource_id: name, title: name });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(name) }).click();
    await expect(page.getByTestId("files-view").getByLabel("파일 내용")).toHaveValue("literal colon filename fixture");
});

test("새 파일도 화면 이동 뒤 편집을 복원하고 처음 저장한 뒤에는 실제 파일로 이어 연다", async ({ page }) => {
    const { project, files, revisit } = await openFixture(page, "new-file-start");
    const root = await apiCall<{ root_path: string }>("GET", `/projects/${project.id}`);
    const name = `new-resume-${Date.now()}.txt`;
    page.once("dialog", (dialog) => dialog.accept(name));
    await files.getByRole("button", { name: "새 파일", exact: true }).click();
    const area = files.getByLabel("파일 내용");
    await area.fill("new unsaved file\n");
    await revisit();
    await expect(area).toHaveValue("new unsaved file\n");
    await files.getByRole("button", { name: "저장", exact: true }).click();
    await expect(files.getByText("● 저장 안 됨", { exact: true })).toHaveCount(0);
    await expect(area).toHaveValue("new unsaved file\n");
    expect(readFileSync(join(root.root_path, name), "utf8")).toBe("new unsaved file\n");
    await revisit();
    await expect(area).toHaveValue("new unsaved file\n");
    await expect(files.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
});

test("기기 저장 공간이 부족하면 사본 실패를 알리고 복구 키를 보관하지 못한 저장은 실행하지 않는다", async ({ page }) => {
    const { project, path, files, area } = await openFixture(page, "resume-quota");
    await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string) {
            if (key.startsWith("grove.file.")) throw new DOMException("fixture quota", "QuotaExceededError");
            original.call(this, key, value);
        };
    });
    let requests = 0;
    page.on("request", (r) => { if (r.method() === "PUT" && r.url().includes(`/projects/${project.id}/files/content`)) requests++; });
    await area.fill("kept in current editor\n");
    await expect(files.getByRole("alert")).toContainText("편집 사본을 보관하지 못했습니다");
    await files.getByRole("button", { name: "저장", exact: true }).click();
    await expect(files.getByRole("status").filter({ hasText: /\S/ })).toContainText("요청 사본을 보관하지 못해 실행하지 않았습니다");
    await expect(area).toHaveValue("kept in current editor\n");
    expect(requests).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("original\n");
});
