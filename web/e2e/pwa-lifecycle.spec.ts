import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, composerOption, ensureProjects, login, openDetails, sessionView } from "./helpers";

async function openDraft(page: Page, name: string) {
    const { a } = await ensureProjects();
    const title = `PWA ${name} ${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    const view = sessionView(page, session.id);
    await composerOption(view, "보내기 방식", "save");
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
        await expect(view.getByRole("button", { name: "제목 생성", exact: true })).toBeDisabled();
        await expect(view.getByRole("button", { name: "제목 생성", exact: true })).toHaveAttribute("title", /오프라인/);
        await expect(view.getByRole("button", { name: "분기", exact: true })).toBeDisabled();
        await expect(view.getByLabel("워크플로우")).toBeDisabled();
        await openDetails(view.getByTestId("tasks-panel"));
        await view.getByLabel("백그라운드 명령").fill("fixture command must not execute");
        await expect(view.getByTestId("tasks-panel").getByRole("button", { name: "실행", exact: true })).toBeDisabled();
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

test("다른 탭의 업데이트 후 유일하게 남은 구 문서의 lazy asset을 보존하고 모든 문서가 전환한 뒤 회수한다", async ({ page }) => {
    const path = join(process.cwd(), "build/client/sw.js");
    const original = readFileSync(path, "utf8");
    const version = original.match(/const VERSION = "([^"]+)"/)![1]!;
    let second: Page | undefined;
    try {
        const { session } = await openDraft(page, "multi-tab");
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
        // 최초 설치 전 network 문서는 버전 불명이므로, 제어된 navigation으로 버전을 확정한다.
        await page.reload();
        await expect(page.getByTestId("conn")).toHaveText("연결됨");
        await expect(page.locator('meta[name="grove-shell-version"]')).toHaveAttribute("content", version);
        second = await page.context().newPage();
        await second.goto("/");
        await expect(second.getByTestId("conn")).toHaveText("연결됨");
        await second.evaluate(() => { document.documentElement.dataset.pwaMarker = "old-document"; });
        const asset = await second.evaluate(async () => {
            const prefix = `grove-shell-${encodeURIComponent(new URL("./", location.href).href)}-`;
            const name = (await caches.keys()).find((key) => key.startsWith(prefix))!;
            const cache = await caches.open(name);
            const loaded = new Set(performance.getEntriesByType("resource").map((entry) => entry.name));
            const request = (await cache.keys()).find((request) => request.url.includes("/assets/") && request.url.endsWith(".js") && !loaded.has(request.url))!;
            const bytes = await (await cache.match(request))!.arrayBuffer();
            const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).join(",");
            return { cache: name, url: request.url, digest };
        });
        writeFileSync(path, original.replace(/const VERSION = "([^"]+)"/, 'const VERSION = "$1-multi-recovery"'));
        await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
        const banner = (tab: Page) => tab.getByRole("status").filter({ hasText: "새 버전이 준비되었습니다" });
        await expect(banner(page)).toBeVisible();
        await banner(page).getByRole("button", { name: "지금 업데이트" }).click();
        await expect(page.locator('meta[name="grove-shell-version"]')).toHaveAttribute("content", `${version}-multi-recovery`);
        await expect(second.locator("html")).toHaveAttribute("data-pwa-marker", "old-document");
        await expect(second.locator('meta[name="grove-shell-version"]')).toHaveAttribute("content", version);
        expect(await second.evaluate(async (name) => (await caches.keys()).includes(name), asset.cache)).toBe(true);
        // 새 cache에서만 미사용 asset을 빼고 구 문서의 정확한 URL이 구 cache에서 응답하는지 확인한다.
        await second.evaluate(async ({ old, url }) => {
            for (const name of await caches.keys()) if (name !== old && name.startsWith("grove-shell-")) await (await caches.open(name)).delete(url);
        }, { old: asset.cache, url: asset.url });
        await page.close();
        await second.context().setOffline(true);
        const digest = await second.evaluate(async (url) => {
            const bytes = await (await fetch(url)).arrayBuffer();
            return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).join(",");
        }, asset.url);
        expect(digest).toBe(asset.digest);
        await second.evaluate(() => new Promise<void>((resolve) => {
            const reply = (event: MessageEvent) => {
                if (event.source !== navigator.serviceWorker.controller || event.data?.type !== "shell-status") return;
                navigator.serviceWorker.removeEventListener("message", reply);
                resolve();
            };
            navigator.serviceWorker.addEventListener("message", reply);
            window.dispatchEvent(new Event("focus"));
        }));
        expect(await second.evaluate(async (name) => (await caches.keys()).includes(name), asset.cache)).toBe(true);
        await expect(sessionView(second, session.id).getByLabel("메시지 입력")).toHaveValue("초안 multi-tab");
        await second.context().setOffline(false);
        await expect(banner(second).getByRole("button", { name: "지금 업데이트" })).toBeEnabled();
        await banner(second).getByRole("button", { name: "지금 업데이트" }).click();
        await expect(second.locator('meta[name="grove-shell-version"]')).toHaveAttribute("content", `${version}-multi-recovery`);
        await expect.poll(() => second!.evaluate(async (name) => (await caches.keys()).includes(name), asset.cache)).toBe(false);
        await expect(sessionView(second, session.id).getByLabel("메시지 입력")).toHaveValue("초안 multi-tab");
    } finally {
        await second?.context().setOffline(false);
        await second?.close();
        writeFileSync(path, original);
    }
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

test("격리된 Chrome origin의 실제 저장 한도에서 초안·서버 미전송을 보존한다", async ({ page }) => {
    const { session, view } = await openDraft(page, "real-quota");
    const drafts = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage)
        .filter((key) => key.startsWith("grove.draft.")).map((key) => [key, localStorage.getItem(key)])));
    const before = await drafts();
    // 이 시험의 disposable browser context에만 채운다. 실제 DOMException을 발생시키며 Storage를 mock하지 않는다.
    await page.evaluate(() => {
        for (const size of [65_536, 1024, 32]) {
            let exhausted = false;
            for (let i = 0; i < 256; i++) {
                try { localStorage.setItem(`grove.test.quota.${size}.${i}`, "x".repeat(size)); }
                catch (error) {
                    if (!(error instanceof DOMException) || error.name !== "QuotaExceededError") throw error;
                    exhausted = true;
                    break;
                }
            }
            if (!exhausted) throw new Error("격리한 quota 시험의 저장 상한 안에서 한도에 도달하지 못했습니다");
        }
    });
    const mutations: string[] = [];
    page.on("request", (request) => {
        if (request.url().includes(`/sessions/${session.id}/`) && request.method() !== "GET") mutations.push(request.url());
    });
    const text = "실제 quota에서 보존할 미저장 입력 ".repeat(100);
    await view.getByLabel("메시지 입력").fill(text);
    await expect(page.getByTestId("storage-warning")).toContainText("quota");
    await expect(view.getByLabel("메시지 입력")).toHaveValue(text);
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view).toContainText("전송 사본을 보관하지 못해 보내지 않았습니다");
    expect(await drafts()).toEqual(before);
    expect(mutations).toEqual([]);
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
