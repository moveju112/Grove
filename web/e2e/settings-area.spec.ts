import { expect, test } from "@playwright/test";
import { apiCall, ensureProfile, login, openSettings, selectChoice } from "./helpers";

type Effective = { items: { key: string; effective: unknown; layers: Record<string, { value: unknown; revision: number }> }[] };
const language = async () => (await apiCall<Effective>("GET", "/settings/effective")).items.find((item) => item.key === "output.language")!;

for (const width of [390, 1280]) {
    test.describe(`${width}px 설정 구분`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });

        test("로컬 환경과 데몬 설정은 목록·검색·저장 대상이 섞이지 않는다", async ({ page }, info) => {
            await ensureProfile();
            const before = await language();
            const writes: string[] = [];
            page.on("request", (request) => {
                if (request.method() === "PUT" && new URL(request.url()).pathname.startsWith("/api/v1/settings/")) writes.push(request.url());
            });
            await login(page);
            await openSettings(page, "local");
            const settings = page.getByTestId("settings");
            const local = settings.getByRole("tab", { name: "로컬 설정", exact: true });
            const daemon = settings.getByRole("tab", { name: "데몬 설정", exact: true });
            await expect(local).toHaveAttribute("aria-selected", "true");
            await expect(settings.getByTestId("setting-theme")).toBeVisible();
            await expect(settings.getByTestId("setting-profiles")).toHaveCount(0);
            await expect(settings.getByRole("button", { name: "서버·데이터", exact: true })).toHaveCount(0);
            await selectChoice(settings.getByRole("combobox", { name: "테마", exact: true }), "dark");
            await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
            expect(writes).toEqual([]);
            await page.screenshot({ path: info.outputPath(`local-settings-${width}.png`) });
            await settings.getByRole("button", { name: "기기·연결", exact: true }).click();
            for (const id of ["hosts", "device-name", "client-status", "browser-capabilities", "logout"]) {
                await expect(settings.getByTestId(`setting-${id}`)).toBeVisible();
            }
            await expect(settings.getByTestId("setting-devices")).toHaveCount(0);
            await expect(settings.getByTestId("setting-pairing")).toHaveCount(0);

            await daemon.click();
            await expect(daemon).toHaveAttribute("aria-selected", "true");
            await expect(settings.getByTestId("setting-profiles")).toBeVisible();
            await expect(settings.getByTestId("setting-theme")).toHaveCount(0);
            await expect(settings.getByRole("button", { name: "화면·입력", exact: true })).toHaveCount(0);
            await settings.getByRole("button", { name: "기기·연결", exact: true }).click();
            await expect(settings.getByTestId("setting-devices")).toBeVisible();
            await expect(settings.getByTestId("setting-pairing")).toBeVisible();
            for (const id of ["hosts", "device-name", "browser-capabilities", "logout"]) {
                await expect(settings.getByTestId(`setting-${id}`)).toHaveCount(0);
            }
            try {
                await settings.getByLabel("설정 검색", { exact: true }).fill("응답 언어");
                const row = settings.getByTestId("setting-output.language");
                await expect(row).toContainText("서버 전체");
                const value = `fixture-area-${width}`;
                await row.getByLabel("응답 언어", { exact: true }).fill(value);
                await row.getByLabel("응답 언어", { exact: true }).blur();
                await expect.poll(async () => (await language()).effective).toBe(value);
                await page.screenshot({ path: info.outputPath(`daemon-settings-${width}.png`) });
                await local.click();
                await expect(settings.getByRole("combobox", { name: "테마", exact: true })).toHaveAttribute("data-selected-value", "dark");
                await settings.getByLabel("설정 검색", { exact: true }).fill("응답 언어");
                await expect(settings.getByTestId("setting-output.language")).toHaveCount(0);
                expect((await language()).effective).toBe(value);
            } finally {
                const current = await language();
                await apiCall("PUT", "/settings/server/-/output.language", {
                    expected_revision: current.layers.server?.revision ?? 0, value: before.layers.server?.value ?? null,
                });
            }
        });
    });
}
