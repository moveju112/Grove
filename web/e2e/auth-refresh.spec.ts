import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("같은 브라우저의 두 탭을 함께 새로고침해도 갱신은 직렬화되고 두 로그인 모두 유지된다", async ({ page, context }) => {
    await login(page);
    const second = await context.newPage();
    await second.goto("/");
    await expect(second.getByTestId("conn")).toHaveText("연결됨");
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const observed = new Promise<void>((resolve) => { started = resolve; });
    let requests = 0;
    await context.route("**/api/v1/auth/refresh", async (route) => {
        requests++;
        if (requests === 1) {
            started();
            await held;
        }
        await route.continue();
    });
    try {
        await Promise.all([page.reload(), second.reload()]);
        await observed;
        await expect.poll(() => page.evaluate(async () => {
            const locks = await navigator.locks.query();
            return locks.pending?.filter((lock) => lock.name?.startsWith("grove.auth.refresh.v1:")).length;
        })).toBe(1);
        expect(requests).toBe(1);
        release();
        for (const tab of [page, second]) {
            await expect(tab.getByTestId("conn")).toHaveText("연결됨");
            await expect(tab.getByRole("form", { name: "로그인", exact: true })).toHaveCount(0);
        }
        expect(requests).toBe(2);
    } finally {
        release();
        await context.unroute("**/api/v1/auth/refresh");
        await second.close();
    }
});

test("서버가 갱신을 끝낸 뒤 응답이 유실돼도 같은 요청을 확인해 재등록 없이 복구한다", async ({ page }) => {
    await login(page);
    const keys: string[] = [];
    await page.route("**/api/v1/auth/refresh", async (route) => {
        keys.push(route.request().headers()["idempotency-key"] ?? "");
        if (keys.length === 1) {
            const response = await route.fetch();
            expect(response.status()).toBe(200);
            await route.abort("connectionreset");
        } else {
            await route.continue();
        }
    });
    await page.reload();
    await expect(page.getByTestId("conn")).toHaveText("연결됨");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[0] === keys[1]).toBe(true);
    await expect(page.getByRole("form", { name: "로그인", exact: true })).toHaveCount(0);
});

test("열린 탭의 갱신이 일시적으로 503이어도 로그아웃하지 않고 다음 확인에서 복구한다", async ({ page }) => {
    await login(page);
    let denied = 0;
    await page.route("**/api/v1/auth/refresh", async (route) => {
        if (denied++ === 0) await route.fulfill({ status: 503, body: "{}" });
        else await route.continue();
    });
    await page.reload();
    await expect(page.getByTestId("conn")).toHaveText("연결됨");
    expect(denied).toBe(2);
    await expect(page.getByRole("form", { name: "로그인", exact: true })).toHaveCount(0);
});

test("390px cold start에서 서버 오류가 이어져도 재등록 대신 기존 로그인 복구를 안내한다", async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    let blocked = true;
    await page.route("**/api/v1/auth/refresh", async (route) => {
        if (blocked) await route.fulfill({ status: 503, body: "{}" });
        else await route.continue();
    });
    await page.reload();
    await expect(page.getByTestId("auth-recovery")).toBeVisible();
    await expect(page.getByRole("heading", { name: "로그인을 확인할 수 없어요" })).toBeVisible();
    await expect(page.getByRole("form", { name: "로그인", exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("auth-recovery-390.png"), fullPage: true });
    blocked = false;
    await page.getByRole("button", { name: "연결·로그인 다시 확인", exact: true }).click();
    await expect(page.getByTestId("conn")).toHaveText("연결됨");
    await expect(page.getByTestId("auth-recovery")).toHaveCount(0);
});
