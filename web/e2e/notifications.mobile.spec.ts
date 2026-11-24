import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login, openSettings, selectChoice } from "./helpers";

// Real worker notifications, isolated fake browser subscription: no production push service traffic.
test("기본 푸시는 설정을 열기 전에 등록되고 기기에서 끈 선택은 새로고침 뒤에도 유지된다", async ({ page, context, baseURL }) => {
    await context.grantPermissions(["notifications"], { origin: baseURL! });
    const config = await apiCall<{ public_key: string }>("GET", "/web-push");
    const endpoint = "https://fcm.googleapis.com/fcm/send/isolated-browser-test";
    await page.addInitScript(({ endpoint, publicKey }) => {
        const subscription = {
            endpoint,
            options: {},
            toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: publicKey, auth: "AAAAAAAAAAAAAAAAAAAAAA" } }),
        };
        PushManager.prototype.getSubscription = async () => sessionStorage.getItem("test-push-subscription")
            ? subscription as unknown as PushSubscription : null;
        PushManager.prototype.subscribe = async () => {
            sessionStorage.setItem("test-push-subscription", "true");
            return subscription as unknown as PushSubscription;
        };
    }, { endpoint, publicKey: config.public_key });
    const { token } = await login(page);
    const subscribed = async () => (await apiCall<{ subscriptions: { endpoint: string }[] }>("GET", "/web-push", undefined, token)).subscriptions.some((s) => s.endpoint === endpoint);
    await expect.poll(subscribed).toBe(true);
    await openSettings(page, "local");
    await page.getByRole("button", { name: "알림", exact: true }).click();
    const panel = page.getByTestId("setting-notify");
    await expect(panel).toBeVisible();
    for (const name of ["작업 완료·실패", "승인 요청", "예약·업데이트 알림", "알림 소리", "알림 진동"]) {
        await expect(panel.getByRole("combobox", { name, exact: true })).toHaveAttribute("data-selected-value", "true");
    }
    const push = panel.getByRole("combobox", { name: "앱을 닫아도 완료 알림", exact: true });
    await expect(push).toHaveAttribute("data-selected-value", "true");
    await selectChoice(push, "false");
    await expect.poll(subscribed).toBe(false);
    await page.reload();
    await openSettings(page, "local");
    await page.getByRole("button", { name: "알림", exact: true }).click();
    await expect(push).toHaveAttribute("data-selected-value", "false");
    expect(await subscribed()).toBe(false);
    await page.evaluate(async () => { for (const n of await (await navigator.serviceWorker.ready).getNotifications()) n.close(); });
});

test("푸시 기본 사용은 권한을 자동 요청하지 않고 알림 허용 뒤에만 구독한다", async ({ page, baseURL, context }) => {
    const { public_key: publicKey } = await apiCall<{ public_key: string }>("GET", "/web-push");
    const endpoint = "https://fcm.googleapis.com/fcm/send/isolated-default-permission";
    await page.addInitScript(({ endpoint, publicKey }) => {
        Notification.requestPermission = async () => {
            sessionStorage.setItem("test-permission-request", "true");
            return Notification.permission;
        };
        PushManager.prototype.getSubscription = async () => null;
        PushManager.prototype.subscribe = async () => ({
            endpoint, toJSON: () => ({ endpoint, keys: { p256dh: publicKey, auth: "AAAAAAAAAAAAAAAAAAAAAA" } }),
        }) as unknown as PushSubscription;
    }, { endpoint, publicKey });
    const { token } = await login(page);
    const subscribed = async () => (await apiCall<{ subscriptions: { endpoint: string }[] }>("GET", "/web-push", undefined, token)).subscriptions.some((s) => s.endpoint === endpoint);
    try {
        await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
        await openSettings(page, "local");
        await page.getByRole("button", { name: "알림", exact: true }).click();
        await expect(page.getByRole("button", { name: "브라우저 알림 허용", exact: true })).toBeVisible();
        expect(await page.evaluate(() => sessionStorage.getItem("test-permission-request"))).toBeNull();
        expect(await subscribed()).toBe(false);
        await context.grantPermissions(["notifications"], { origin: baseURL! });
        await expect.poll(subscribed).toBe(true);
    } finally {
        await apiCall("DELETE", `/web-push?endpoint=${encodeURIComponent(endpoint)}`, undefined, token);
    }
});

test("알림 시험은 소리·직접 진동·시스템 기본 알림을 분리하고 결과를 각각 남긴다", async ({ page, context, baseURL }, info) => {
    await context.grantPermissions(["notifications"], { origin: baseURL! });
    await page.addInitScript(() => {
        localStorage.setItem("grove.device.prefs", JSON.stringify({ notifyPush: false }));
        const calls: (number | number[])[] = [];
        Object.defineProperty(navigator, "vibrate", { configurable: true, value: (pattern: number | number[]) => {
            calls.push(pattern);
            document.documentElement.dataset.vibrationTests = JSON.stringify(calls);
            return true;
        } });
    });
    await login(page);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await openSettings(page, "local");
    await page.getByRole("button", { name: "알림", exact: true }).click();
    const panel = page.getByTestId("setting-notify");
    const tests = panel.getByRole("group", { name: "알림 시험", exact: true });
    await expect(tests.getByRole("button")).toHaveCount(4);
    await tests.getByRole("button", { name: "1. 소리만 시험", exact: true }).click();
    await expect(tests.getByTestId("notification-test-result-sound")).toContainText("소리 재생 요청됨");
    await tests.getByRole("button", { name: "2. 진동 1초 시험", exact: true }).click();
    await expect(tests.getByTestId("notification-test-result-vibrate")).toContainText("반환값: true");
    await tests.getByRole("button", { name: "3. 진동 패턴 시험", exact: true }).click();
    await expect(tests.getByTestId("notification-test-result-pattern")).toContainText("반환값: true");
    expect(await page.evaluate(() => JSON.parse(document.documentElement.dataset.vibrationTests!))).toEqual([1000, [180, 80, 180]]);
    expect(await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length)).toBe(0);
    await tests.getByRole("button", { name: "4. 시스템 기본 알림 시험", exact: true }).click();
    await expect(tests.getByTestId("notification-test-result-system")).toContainText("브라우저 알림 목록에 등록됨");
    expect(await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => n.title)))
        .toEqual(["Grove 알림 시험 · 기본"]);
    await tests.getByRole("button", { name: "1. 소리만 시험", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("notification-tests-390.png") });
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.evaluate(async () => { for (const n of await (await navigator.serviceWorker.ready).getNotifications()) n.close(); });
});

test("지원하지 않는 진동과 브라우저 알림 거절은 해당 시험에 실패 원인을 표시한다", async ({ page, context, baseURL }) => {
    await context.grantPermissions(["notifications"], { origin: baseURL! });
    await page.addInitScript(() => localStorage.setItem("grove.device.prefs", JSON.stringify({ notifyPush: false })));
    await login(page);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await openSettings(page, "local");
    await page.getByRole("button", { name: "알림", exact: true }).click();
    const tests = page.getByRole("group", { name: "알림 시험", exact: true });
    await page.evaluate(() => { Object.defineProperty(navigator, "vibrate", { configurable: true, value: undefined }); });
    await tests.getByRole("button", { name: "2. 진동 1초 시험", exact: true }).click();
    await expect(tests.getByTestId("notification-test-result-vibrate")).toContainText("직접 진동을 지원하지 않아");
    await page.evaluate(() => {
        ServiceWorkerRegistration.prototype.showNotification = async () => { throw new DOMException("blocked", "NotAllowedError"); };
    });
    await tests.getByRole("button", { name: "4. 시스템 기본 알림 시험", exact: true }).click();
    await expect(tests.getByTestId("notification-test-result-system")).toContainText("NotAllowedError");
    await expect(tests.getByTestId("notification-test-result-vibrate")).toContainText("직접 진동을 지원하지 않아");
    await expect(tests.getByRole("button", { name: "4. 시스템 기본 알림 시험", exact: true })).toBeEnabled();
});

test("읽은 대화의 완료 알림은 읽음 이벤트와 앱 재시작 때 알림창에서 닫힌다", async ({ page, context, baseURL }) => {
    await context.grantPermissions(["notifications"], { origin: baseURL! });
    await page.addInitScript(() => localStorage.setItem("grove.device.prefs", JSON.stringify({ notifyPush: false })));
    const { token } = await login(page);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    const { a } = await ensureProjects();
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `알림 정리 ${test.info().testId}` });
    const show = (sessionId: string, turn: string) => page.evaluate(async ({ sessionId, turn, projectId }) => {
        const bytes = new TextEncoder().encode(JSON.stringify({ origin: location.origin }));
        const server = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification("작업 완료", { tag: `${server}:turn:${turn}`, data: { projectId, sessionId, server } });
        await reg.showNotification("승인 요청", { tag: `${server}:approval:${turn}`, data: { projectId, sessionId, server } });
    }, { sessionId, turn, projectId: a.id });
    const titles = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => n.title).sort());
    const read = () => apiCall("POST", "/recent/touch", {
        kind: "session", project_id: a.id, resource_id: session.id, reopen: false, view_state: { last_seen_seq: 0 },
    }, token);

    await show(session.id, "first");
    expect(await titles()).toEqual(["승인 요청", "작업 완료"]);
    await read();
    await expect.poll(titles).toEqual(["승인 요청"]);

    await show(session.id, "second");
    await page.reload();
    await expect.poll(titles).toEqual(["승인 요청", "승인 요청"]);
    await page.evaluate(async () => { for (const n of await (await navigator.serviceWorker.ready).getNotifications()) n.close(); });
});
