import { expect, test } from "@playwright/test";
import { api, enter, expectNoConnectionNoise, target } from "./relay";

test("폰 relay의 두 탭은 같은 저장 자격으로 갱신하며 재등록하지 않는다", async ({ page, context }) => {
    await enter(page);
    const before = await api<{ kind: string }[]>("GET", "/devices");
    const second = await context.newPage();
    try {
        await second.goto(target().origin);
        await expect(second.getByTestId("conn")).toHaveText("연결됨");
        await Promise.all([page.reload(), second.reload()]);
        for (const tab of [page, second]) {
            await expect(tab.getByTestId("conn")).toHaveText("연결됨");
            await expect(tab.getByRole("form", { name: "로그인", exact: true })).toHaveCount(0);
            await expectNoConnectionNoise(tab);
        }
        const after = await api<{ kind: string }[]>("GET", "/devices");
        expect(after.length).toBe(before.length);
    } finally { await second.close(); }
});

test("relay 갱신 뒤 새 자격 저장을 잃어도 이전 자격과 같은 요청으로 복구한다", async ({ page }) => {
    test.skip(target().target !== "local", "자격 저장 장애는 격리된 로컬 시험에만 주입한다");
    await enter(page);
    await page.addInitScript(() => {
        const put = IDBObjectStore.prototype.put;
        let lost = false;
        IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
            if (!lost && this.transaction.db.name === "grove.e2ee.credentials.v1") {
                lost = true;
                throw new TypeError("fixture credential persistence lost");
            }
            return Reflect.apply(put, this, args);
        };
    });
    await page.reload();
    await expect(page.getByTestId("conn")).toHaveText("연결됨");
    await expect(page.getByRole("form", { name: "로그인", exact: true })).toHaveCount(0);
    await expectNoConnectionNoise(page);
});
