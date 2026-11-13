import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProjects, login, sessionView } from "./helpers";

async function openDraft(page: Page, name: string) {
    const { a } = await ensureProjects();
    const title = `PWA ${name} ${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    const view = sessionView(page, session.id);
    await view.getByLabel("보내기 방식").selectOption("save");
    await view.getByLabel("메시지 입력").fill(`초안 ${name}`);
    await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
        .filter((key) => key.startsWith("grove.draft.")).map((key) => localStorage.getItem(key)).join("\n"))).toContain(`초안 ${name}`);
    return { session, view };
}

test("오프라인에서 입력과 로컬 초안은 유지하고 버튼·단축키 전송을 막으며 복구 후 자동 전송하지 않는다", async ({ page }) => {
    const { session, view } = await openDraft(page, "offline");
    const mutations: string[] = [];
    page.on("request", (request) => {
        if (request.url().includes(`/sessions/${session.id}/`) && request.method() !== "GET") mutations.push(request.url());
    });
    try {
        await page.context().setOffline(true);
        await expect(page.getByTestId("offline-banner")).toBeVisible();
        await view.getByLabel("메시지 입력").fill("오프라인에서 계속 쓴 초안");
        await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeDisabled();
        await expect(view.getByRole("button", { name: "초안 서버 저장" })).toBeDisabled();
        await view.getByLabel("메시지 입력").press("Control+Enter");
        await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
            .filter((key) => key.startsWith("grove.draft.")).map((key) => localStorage.getItem(key)).join("\n"))).toContain("오프라인에서 계속 쓴 초안");
        expect(mutations).toEqual([]);
    } finally {
        await page.context().setOffline(false);
    }
    await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeEnabled();
    await expect(view.getByLabel("메시지 입력")).toHaveValue("오프라인에서 계속 쓴 초안");
    expect(mutations).toEqual([]);
});

test("오래 열린 탭은 health protocol 불일치를 먼저 표시하고 변경 요청 없이 초안을 유지한다", async ({ page }) => {
    const { session, view } = await openDraft(page, "protocol");
    const mutations: string[] = [];
    await page.route("**/api/v1/health", (route) => route.fulfill({
        status: 200, contentType: "application/json", headers: { "x-grove-protocol": "2" },
        body: JSON.stringify({ protocol: 2, version: "next-server" }),
    }));
    page.on("request", (request) => {
        if (request.url().includes(`/sessions/${session.id}/`) && request.method() !== "GET") mutations.push(request.url());
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("protocol-banner")).toContainText("protocol 2");
    await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeDisabled();
    await view.getByLabel("메시지 입력").press("Control+Enter");
    await expect(view.getByLabel("메시지 입력")).toHaveValue("초안 protocol");
    expect(mutations).toEqual([]);
});

test("실제 초안 저장 경로의 quota 오류를 알리고 입력을 지우지 않는다", async ({ page }) => {
    const { view } = await openDraft(page, "quota");
    await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
            if (key.startsWith("grove.draft.")) throw new DOMException("fixture quota exceeded", "QuotaExceededError");
            return original.call(this, key, value);
        };
    });
    await view.getByLabel("메시지 입력").fill("저장되지 않은 중요한 입력");
    await expect(page.getByTestId("storage-warning")).toContainText("quota");
    await expect(view.getByLabel("메시지 입력")).toHaveValue("저장되지 않은 중요한 입력");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view).toContainText("전송 사본을 보관하지 못해 보내지 않았습니다");
    await expect(view.getByLabel("메시지 입력")).toHaveValue("저장되지 않은 중요한 입력");
});

test("저장 데이터 유실과 앱 cache 삭제를 별도로 알리고 남아 있는 메모리 초안을 보존한다", async ({ page }) => {
    const { view } = await openDraft(page, "loss");
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.evaluate(async () => {
        localStorage.clear();
        const prefix = `grove-shell-${encodeURIComponent(new URL("./", location.href).href)}-`;
        for (const key of await caches.keys()) if (key.startsWith(prefix)) await caches.delete(key);
        window.dispatchEvent(new Event("focus"));
    });
    await expect(page.getByTestId("storage-warning")).toContainText("저장 데이터가 없어졌습니다");
    await expect(page.getByTestId("shell-warning")).toBeVisible();
    await expect(view.getByLabel("메시지 입력")).toHaveValue("초안 loss");
});

test("구 worker는 동의 전 대기하고 동의 후 한 번 전환하며 초안을 복원한다", async ({ page }) => {
    const path = join(process.cwd(), "build/client/sw.js");
    const original = readFileSync(path, "utf8");
    try {
        const { session, view } = await openDraft(page, "update");
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
        await page.evaluate(() => { document.documentElement.dataset.pwaMarker = "old-tab"; });
        writeFileSync(path, original.replace(/const VERSION = "([^"]+)"/, 'const VERSION = "$1-lifecycle"'));
        await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
        const banner = page.getByRole("status").filter({ hasText: "새 버전이 준비되었습니다" });
        await expect(banner).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-pwa-marker", "old-tab");
        await expect(view.getByLabel("메시지 입력")).toHaveValue("초안 update");
        await banner.getByRole("button", { name: "지금 업데이트" }).click();
        await page.waitForFunction(() => document.documentElement.dataset.pwaMarker === undefined);
        await expect(page.getByTestId("conn")).toHaveText("연결됨");
        await expect(sessionView(page, session.id).getByLabel("메시지 입력")).toHaveValue("초안 update");
        await expect.poll(() => page.evaluate(async () => (await caches.keys())
            .filter((key) => key.startsWith("grove-shell-")))).toEqual([expect.stringMatching(/-lifecycle$/)]);
    } finally {
        writeFileSync(path, original);
    }
});
