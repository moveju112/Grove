import { expect, test, type Page } from "@playwright/test";
import { apiCall, login, openSettings, selectChoice } from "./helpers";
import type { ServerUpdateStatus } from "../app/api/updateSettings";

async function open(page: Page) {
    await openSettings(page);
    await page.getByLabel("설정 검색").last().fill("서버 업데이트");
    return page.getByTestId("server-update-settings").last();
}

async function restore(initial: ServerUpdateStatus) {
    const current = await apiCall<ServerUpdateStatus>("GET", "/updates/settings");
    await apiCall("PUT", "/updates/settings", {
        channel: initial.settings.channel, auto_apply: initial.settings.auto_apply, expected_revision: current.settings.revision,
    });
}

test("자동 업데이트 ON/OFF만 제공하고 기존 채널을 보존하며 즉시 저장한다", async ({ page }) => {
    const initial = await apiCall<ServerUpdateStatus>("GET", "/updates/settings");
    try {
        await apiCall("PUT", "/updates/settings", {
            channel: "beta", auto_apply: "notify_only", expected_revision: initial.settings.revision,
        });
        await login(page);
        let panel = await open(page);
        await expect(panel.getByRole("combobox")).toHaveCount(1);
        await expect(panel.getByRole("combobox", { name: "자동 업데이트", exact: true })).toHaveAttribute("data-selected-value", "false");
        await expect(panel.getByRole("combobox", { name: "업데이트 채널", exact: true })).toHaveCount(0);
        await expect(panel.getByRole("combobox", { name: "자동 적용 범위", exact: true })).toHaveCount(0);
        await expect(panel.getByRole("button", { name: "서버 업데이트 확인", exact: true })).toHaveCount(0);
        await expect(panel.getByRole("button", { name: "서버 업데이트 상태 새로 조회", exact: true })).toHaveCount(0);
        await selectChoice(panel.getByLabel("자동 업데이트", { exact: true }), "true");
        await expect(panel).toContainText("서버에 저장됨");
        const saved = await apiCall<ServerUpdateStatus>("GET", "/updates/settings");
        expect(saved.settings.channel).toBe("beta");
        expect(saved.settings.auto_apply).toBe("minor");
        await page.reload();
        panel = await open(page);
        await expect(panel.getByRole("combobox", { name: "자동 업데이트", exact: true })).toHaveAttribute("data-selected-value", "true");
        await selectChoice(panel.getByLabel("자동 업데이트", { exact: true }), "false");
        await expect(panel).toContainText("서버에 저장됨");
        const disabled = await apiCall<ServerUpdateStatus>("GET", "/updates/settings");
        expect(disabled.settings.channel).toBe("beta");
        expect(disabled.settings.auto_apply).toBe("notify_only");
    } finally {
        await restore(initial);
    }
});

test("등록 기기는 업데이트 설정을 관리할 수 있다", async ({ page, request }) => {
    const device = await login(page);
    try {
        const headers = { authorization: `Bearer ${device.token}` };
        const read = await request.get("/api/v1/updates/settings", { headers });
        expect(read.status()).toBe(200);
        const status = await read.json() as ServerUpdateStatus;
        expect(status.can_manage).toBe(true);
        await page.getByRole("banner").getByRole("button", { name: "업데이트 확인", exact: true }).hover();
        const updates = page.getByRole("dialog", { name: "업데이트 확인", exact: true });
        await expect(updates.getByRole("button", { name: "데몬 업데이트 확인" })).toBeEnabled();
        await expect(updates.getByRole("button", { name: "웹 업데이트 확인" })).toBeEnabled();
        await page.keyboard.press("Escape");
        const panel = await open(page);
        await expect(panel.getByRole("combobox", { name: "자동 업데이트", exact: true })).toBeEnabled();
    } finally {
        await apiCall("DELETE", `/devices/${device.id}`);
    }
});

test("저장 응답 유실은 같은 키로 확인하고 revision 충돌에는 선택을 유지한다", async ({ page }) => {
    const initial = await apiCall<ServerUpdateStatus>("GET", "/updates/settings");
    try {
        await login(page);
        const panel = await open(page);
        const target = initial.settings.auto_apply === "notify_only";
        await page.route("**/api/v1/updates/settings", async (route) => {
            if (route.request().method() !== "PUT") return route.continue();
            await route.fetch();
            await route.abort("failed");
        }, { times: 1 });
        await selectChoice(panel.getByLabel("자동 업데이트", { exact: true }), String(target));
        await expect(panel).toContainText("결과 불명");
        await panel.getByRole("button", { name: "같은 업데이트 요청 확인", exact: true }).click();
        await expect(panel).toContainText("서버에 저장됨");
        const saved = await apiCall<ServerUpdateStatus>("GET", "/updates/settings");
        expect(saved.settings.revision).toBe(initial.settings.revision + 1);
        expect(saved.settings.channel).toBe(initial.settings.channel);
        await page.route("**/api/v1/updates/settings", async (route) => {
            if (route.request().method() !== "PUT") return route.continue();
            await apiCall("PUT", "/updates/settings", {
                channel: saved.settings.channel, auto_apply: saved.settings.auto_apply, expected_revision: saved.settings.revision,
            });
            await route.continue();
        }, { times: 1 });
        await selectChoice(panel.getByLabel("자동 업데이트", { exact: true }), String(!target));
        await expect(panel.getByRole("alert")).toContainText("다른 요청으로 변경");
        await expect(panel.getByRole("combobox", { name: "자동 업데이트", exact: true })).toHaveAttribute("data-selected-value", String(!target));
        await panel.getByRole("button", { name: "현재 설정 다시 조회", exact: true }).click();
        await expect(panel.getByRole("combobox", { name: "자동 업데이트", exact: true })).toHaveAttribute("data-selected-value", String(target));
    } finally {
        await restore(initial);
    }
});

test("390px 설정에서도 자동 업데이트 선택 하나만 보인다", async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    const panel = await open(page);
    const select = panel.getByRole("combobox", { name: "자동 업데이트", exact: true });
    await expect(select).toBeVisible();
    await expect(panel.getByRole("combobox")).toHaveCount(1);
    const bounds = (await select.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await select.click();
    await expect(page.getByRole("option", { name: "ON", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "OFF", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.screenshot({ path: info.outputPath("automatic-update-390.png") });
});
