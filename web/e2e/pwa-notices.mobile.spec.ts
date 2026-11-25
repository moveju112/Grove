import { expect, test, type Locator, type Page } from "@playwright/test";
import { apiCall, ensureProfile, ensureProjects, login, sessionView } from "./helpers";

async function openConversation(page: Page, title: string) {
    const { a } = await ensureProjects();
    await ensureProfile();
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    const recent = await apiCall<{ id: string }>("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.getByRole("button", { name: "사이드바", exact: true }).tap();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title, exact: true }).tap();
    await expect(page.getByTestId("mobile-drawer-left")).toBeHidden();
    const view = sessionView(page, session.id);
    return { recent, view, input: view.getByLabel("메시지 입력", { exact: true }) };
}

async function dismiss(notice: Locator, name: string) {
    const button = notice.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    const { width, height } = (await button.boundingBox())!;
    expect(width).toBeGreaterThanOrEqual(32);
    expect(height).toBeGreaterThanOrEqual(32);
    await button.tap();
    await expect(notice).toHaveCount(0);
}

test("쌓인 앱 캐시·저장소 경고는 각각 닫히고 같은 문제가 다시 확인돼도 초안을 유지한다", async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    const { input } = await openConversation(page, "캐시 경고와 초안");
    await input.fill("경고를 닫아도 남아야 할 입력");
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.evaluate(async () => {
        localStorage.removeItem("grove.pwa.storage-seen");
        const prefix = `grove-shell-${encodeURIComponent(new URL("./", location.href).href)}-`;
        for (const key of await caches.keys()) if (key.startsWith(prefix)) await caches.delete(key);
        window.dispatchEvent(new Event("focus"));
    });
    const shell = page.getByTestId("shell-warning");
    const storage = page.getByTestId("storage-warning");
    await expect(shell).toContainText("앱 cache가 삭제됐거나");
    await expect(storage).toBeVisible();
    await page.screenshot({ path: info.outputPath("cache-and-storage-notices-390.png") });
    await dismiss(shell, "앱 캐시 경고 닫기");
    await expect(storage).toBeVisible();
    await dismiss(storage, "저장소 경고 닫기");
    const cached = await page.evaluate(() => new Promise<boolean>((resolve) => {
        const reply = (event: MessageEvent) => {
            if (event.source !== navigator.serviceWorker.controller || event.data?.type !== "shell-status") return;
            navigator.serviceWorker.removeEventListener("message", reply);
            resolve(event.data.cached);
        };
        navigator.serviceWorker.addEventListener("message", reply);
        window.dispatchEvent(new Event("focus"));
    }));
    expect(cached).toBe(false);
    await expect(shell).toHaveCount(0);
    await expect(storage).toHaveCount(0);
    await expect(input).toHaveValue("경고를 닫아도 남아야 할 입력");
});

test("오프라인·서버 연결·호환성 알림을 닫아도 전송은 차단되고 연결을 계속 확인한다", async ({ page }) => {
    const { view, input } = await openConversation(page, "연결 알림과 초안");
    await input.fill("연결이 돌아올 때까지 남을 입력");
    const send = view.getByRole("button", { name: "보내기", exact: true });
    const offline = page.getByTestId("offline-banner");
    await expect(send).toBeEnabled();
    await page.context().setOffline(true);
    await dismiss(offline, "오프라인 알림 닫기");
    await expect(send).toBeDisabled();
    await page.context().setOffline(false);
    await expect(send).toBeEnabled();

    const health = "**/api/v1/health";
    const refresh = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.route(health, route => route.abort("connectionrefused"));
    await refresh();
    const connection = page.getByTestId("connection-toast");
    await dismiss(connection, "연결 오류 닫기");
    await expect(send).toBeDisabled();
    await page.unroute(health);
    // 사용자가 다시 확인을 누르지 않아도 백그라운드 재시도가 연결을 복구한다.
    await expect(send).toBeEnabled({ timeout: 7_000 });
    await expect(connection).toHaveCount(0);

    let protocol = 2;
    await page.route(health, route => route.fulfill({ json: { protocol } }));
    await refresh();
    const compatibility = page.getByTestId("protocol-banner");
    await expect(compatibility).toContainText("protocol 2");
    await dismiss(compatibility, "호환성 경고 닫기");
    await expect(send).toBeDisabled();
    await expect(input).toHaveValue("연결이 돌아올 때까지 남을 입력");
    protocol = 3;
    await refresh();
    await expect(compatibility).toContainText("protocol 3");
});

test("탭 닫기 결과 불명 알림을 닫고 최근 목록에서 같은 요청 결과를 확인한다", async ({ page }) => {
    const title = "결과 불명 탭 닫기";
    const { recent, view } = await openConversation(page, title);
    const requests: (string | undefined)[] = [];
    await page.route(`**/api/v1/recent/${recent.id}`, async route => {
        const request = route.request();
        if (request.method() !== "PATCH") return route.continue();
        requests.push(request.headers()["idempotency-key"]);
        if (requests.length !== 1) return route.continue();
        expect((await route.fetch()).ok()).toBe(true);
        await route.abort("connectionreset");
    });
    await page.getByRole("button", { name: "열린 세션", exact: true }).tap();
    await page.getByRole("button", { name: `${title} 탭 닫기`, exact: true }).tap();
    await page.getByRole("button", { name: "열린 세션 닫기", exact: true }).tap();
    const notice = page.getByTestId("tab-close-error");
    await expect(notice).toContainText("최근에서 숨겼는지 확인하지 못했습니다");
    await dismiss(notice, "탭 닫기 오류 알림 닫기");
    expect(requests).toHaveLength(1);
    await expect(view).toHaveCount(0);
    await page.getByRole("button", { name: "사이드바", exact: true }).tap();
    const list = page.getByRole("region", { name: "최근", exact: true });
    await list.getByRole("button", { name: "같은 요청 결과 확인", exact: true }).tap();
    await expect(list.getByRole("alert")).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    expect(requests[0]).toBeTruthy();
    expect(requests).toEqual([requests[0], requests[0]]);
});
