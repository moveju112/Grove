import { expect, test } from "@playwright/test";
import { apiCall, login, openSettings, selectChoice } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

type Effective = { items: { key: string; effective: unknown; layers: Record<string, { value: unknown; revision: number }> }[] };
const permission = async () => (await apiCall<Effective>("GET", "/settings/effective")).items.find((item) => item.key === "tools.full_access")!;

test("기본 전체 권한을 끄고 다시 켜며 위험 안내와 저장 결과를 확인한다", async ({ page }, info) => {
    const before = await permission();
    try {
        await login(page);
        await openSettings(page, "daemon");
        const settings = page.getByTestId("settings");
        await settings.getByLabel("설정 검색", { exact: true }).fill("일반 도구 전체 권한");
        const row = settings.getByTestId("setting-tools.full_access");
        await expect(row).toBeVisible();
        await expect(row.getByRole("combobox", { name: "일반 도구 전체 권한", exact: true })).toHaveAttribute("data-selected-value", "true");
        await expect(row).toContainText("프로젝트 밖 파일·네트워크·서버 계정의 자격증명");
        await selectChoice(row.getByRole("combobox", { name: "일반 도구 전체 권한", exact: true }), "false");
        await expect.poll(async () => (await permission()).effective).toBe(false);
        await expect(row).not.toContainText("신뢰하는 작업에만 켜세요");
        await selectChoice(row.getByRole("combobox", { name: "일반 도구 전체 권한", exact: true }), "true");
        await expect(row).toContainText("프로젝트 밖 파일·네트워크·서버 계정의 자격증명");
        await expect.poll(async () => (await permission()).effective).toBe(true);
        await expect(row).toContainText("저장됨");
        expect(await row.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath("full-access-390.png"), fullPage: true });
        await page.reload();
        await openSettings(page, "daemon");
        await settings.getByLabel("설정 검색", { exact: true }).fill("일반 도구 전체 권한");
        await expect(row.getByRole("combobox", { name: "일반 도구 전체 권한", exact: true })).toHaveAttribute("data-selected-value", "true");
        await expect(row).toContainText("신뢰하는 작업에만 켜세요");
    } finally {
        const current = await permission();
        await apiCall("PUT", "/settings/server/-/tools.full_access", {
            expected_revision: current.layers.server?.revision ?? 0, value: before.layers.server?.value ?? null,
        });
    }
});
