import { expect, test } from "@playwright/test";
import { apiCall, login, openSettings, selectChoice } from "./helpers";

test.describe("Android 앱 알림 권한 안내", () => {
    test.use({ userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36" });

    test("브라우저 허용 상태에서도 알림을 켜면 Grove 앱 권한 안내를 한 번 보여준다", async ({ page, context, baseURL }, info) => {
        await context.grantPermissions(["notifications"], { origin: baseURL! });
        await page.addInitScript(() => localStorage.setItem("grove.device.prefs", JSON.stringify({ notifyPush: false })));
        await login(page);
        await openSettings(page, "local");
        await page.getByRole("button", { name: "알림", exact: true }).click();
        const panel = page.getByTestId("setting-notify");
        await expect(panel.getByTestId("notify-permission")).toContainText("허용됨");
        const done = panel.getByRole("combobox", { name: "작업 완료·실패", exact: true });
        await selectChoice(done, "false");
        await selectChoice(done, "true");
        const guide = page.getByRole("dialog", { name: "휴대폰 앱 알림 권한", exact: true });
        await expect(guide).toBeVisible();
        await expect(guide).toContainText("Grove를 선택하고 알림의 ‘알림 허용’을 켜.");
        await expect(guide).toContainText("직접 열거나 앱 권한 상태를 읽을 수 없어");
        await page.screenshot({ path: info.outputPath("app-notification-permission-390.png"), animations: "disabled" });
        await guide.getByRole("button", { name: "앱 알림 권한 안내 닫기", exact: true }).click();
        await expect(guide).toHaveCount(0);
        const approval = panel.getByRole("combobox", { name: "승인 요청", exact: true });
        await selectChoice(approval, "false");
        await selectChoice(approval, "true");
        await expect(guide).toHaveCount(0);
        await panel.getByRole("button", { name: "앱 알림 권한 켜는 방법", exact: true }).click();
        await expect(guide).toBeVisible();
    });

    test("실제 Push를 켤 때도 안내하고 진동 설정 변경으로는 다시 띄우지 않는다", async ({ page, context, baseURL }) => {
        await context.grantPermissions(["notifications"], { origin: baseURL! });
        const config = await apiCall<{ public_key: string }>("GET", "/web-push");
        const endpoint = "https://fcm.googleapis.com/fcm/send/isolated-permission-guide";
        await page.addInitScript(({ endpoint, publicKey }) => {
            localStorage.setItem("grove.device.prefs", JSON.stringify({ notifyPush: false }));
            const subscription = { endpoint, options: {}, toJSON: () => ({
                endpoint, keys: { p256dh: publicKey, auth: "AAAAAAAAAAAAAAAAAAAAAA" },
            }) };
            PushManager.prototype.getSubscription = async () => subscription as unknown as PushSubscription;
        }, { endpoint, publicKey: config.public_key });
        const { token } = await login(page);
        try {
            await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
            await openSettings(page, "local");
            await page.getByRole("button", { name: "알림", exact: true }).click();
            const panel = page.getByTestId("setting-notify");
            await selectChoice(panel.getByRole("combobox", { name: "앱을 닫아도 완료 알림", exact: true }), "true");
            const guide = page.getByRole("dialog", { name: "휴대폰 앱 알림 권한", exact: true });
            await expect(guide).toBeVisible();
            await guide.getByRole("button", { name: "앱 알림 권한 안내 닫기", exact: true }).click();
            const revision = async () => (await apiCall<{ subscriptions: { endpoint: string; revision: number }[] }>("GET", "/web-push", undefined, token))
                .subscriptions.find((item) => item.endpoint === endpoint)?.revision ?? 0;
            await expect.poll(revision).toBeGreaterThan(0);
            const previousRevision = await revision();
            await selectChoice(panel.getByRole("combobox", { name: "알림 진동", exact: true }), "false");
            await expect(panel.getByRole("combobox", { name: "앱을 닫아도 완료 알림", exact: true })).toHaveAttribute("data-selected-value", "true");
            await expect.poll(revision).toBeGreaterThan(previousRevision);
            await expect(guide).toHaveCount(0);
        } finally {
            await apiCall("DELETE", `/web-push?endpoint=${encodeURIComponent(endpoint)}`, undefined, token);
        }
    });
});

test.describe("iPhone 앱 알림 권한 안내", () => {
    test.use({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" });
    test("수동 안내는 홈 화면에 추가한 앱의 iOS 알림 설정을 알려준다", async ({ page }) => {
        await login(page);
        await openSettings(page, "local");
        await page.getByRole("button", { name: "알림", exact: true }).click();
        await page.getByRole("button", { name: "앱 알림 권한 켜는 방법", exact: true }).click();
        const guide = page.getByRole("dialog", { name: "휴대폰 앱 알림 권한", exact: true });
        await expect(guide).toBeVisible();
        await expect(guide).toContainText("iPhone·iPad 설정에서 알림을 열어.");
        await expect(guide).toContainText("홈 화면에 추가한 Grove를 선택");
        await expect(guide).not.toContainText("애플리케이션을 열어");
    });
});
