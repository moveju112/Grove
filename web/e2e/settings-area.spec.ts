import { expect, test } from "@playwright/test";
import { apiCall, ensureProfile, login, openSettings, selectChoice } from "./helpers";

type Effective = { items: { key: string; effective: unknown; layers: Record<string, { value: unknown; revision: number }> }[] };
const timeBudget = async () => (await apiCall<Effective>("GET", "/settings/effective")).items.find((item) => item.key === "runs.budget.max_minutes")!;

for (const width of [390, 1280]) {
    test.describe(`${width}px 설정 구분`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });

        test("본문을 끝까지 내려도 로컬·데몬 설정 탭이 상단에 남는다", async ({ page }, info) => {
            await login(page);
            await openSettings(page, "local");
            const tabs = page.getByRole("tablist", { name: "설정 구분" });
            const top = (await tabs.boundingBox())!.y;
            const scroll = page.getByTestId("settings-scroll");
            const offset = await scroll.evaluate((element) => {
                element.scrollTop = element.scrollHeight;
                return element.scrollTop;
            });
            expect(offset).toBeGreaterThan(0);
            await expect(tabs).toBeInViewport({ ratio: 1 });
            expect((await tabs.boundingBox())!.y).toBeCloseTo(top, 0);
            await page.screenshot({ path: info.outputPath(`settings-scrolled-${width}.png`) });
            const daemon = tabs.getByRole("tab", { name: "데몬 설정", exact: true });
            await daemon.click();
            await expect(daemon).toHaveAttribute("aria-selected", "true");
            await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(0);
        });

        test("백업·복원은 서버 메뉴와 검색에 표시하지 않는다", async ({ page }, info) => {
            await login(page);
            await openSettings(page, "daemon");
            const settings = page.getByTestId("settings");
            await settings.getByRole("button", { name: "서버·데이터", exact: true }).click();
            await expect(settings.getByTestId("setting-health")).toBeVisible();
            await expect(settings.getByTestId("setting-server-update")).toBeVisible();
            await expect(settings.getByTestId("setting-backup")).toHaveCount(0);
            await expect(settings.getByText("백업·복원", { exact: true })).toHaveCount(0);
            await expect(settings.locator("code").filter({ hasText: /grove (snapshot|restore)/ })).toHaveCount(0);
            await page.screenshot({ path: info.outputPath(`server-settings-without-backup-${width}.png`) });
            const search = settings.getByLabel("설정 검색", { exact: true });
            for (const keyword of ["백업", "복원", "backup", "restore"]) {
                await search.fill(keyword);
                await expect(settings.getByTestId("setting-backup")).toHaveCount(0);
                await expect(settings.getByText("백업·복원", { exact: true })).toHaveCount(0);
                if (keyword === "복원") {
                    await expect(settings.getByTestId("setting-storage.history_compress_after_days")).toBeVisible();
                } else {
                    await expect(settings).toContainText("검색 결과 0개");
                }
            }
        });

        test("알림은 로컬 설정의 별도 탭에서 저장하고 도움말·클라이언트 상태는 제거한다", async ({ page }, info) => {
            await login(page);
            await openSettings(page, "local");
            const settings = page.getByTestId("settings");
            const search = settings.getByLabel("설정 검색", { exact: true });
            await expect(settings.getByRole("button", { name: "도움말", exact: true })).toHaveCount(0);
            await expect(settings.getByTestId("setting-notify")).toHaveCount(0);
            for (const keyword of ["도움말", "클라이언트 상태"]) {
                await search.fill(keyword);
                await expect(settings).toContainText("검색 결과 0개");
            }
            await settings.getByRole("button", { name: "알림", exact: true }).click();
            const panel = settings.getByTestId("setting-notify");
            await expect(panel).toBeVisible();
            await expect(panel.getByTestId("notification-tests")).toBeVisible();
            await expect(settings.getByTestId("setting-theme")).toHaveCount(0);
            await selectChoice(panel.getByRole("combobox", { name: "알림 소리", exact: true }), "true");
            await settings.getByTestId("settings-menu").scrollIntoViewIfNeeded();
            await page.screenshot({ path: info.outputPath(`notification-tab-${width}.png`) });
            await settings.getByRole("button", { name: "화면·입력", exact: true }).click();
            await expect(settings.getByTestId("setting-notify")).toHaveCount(0);
            await settings.getByRole("button", { name: "알림", exact: true }).click();
            await expect(panel.getByRole("combobox", { name: "알림 소리", exact: true })).toHaveAttribute("data-selected-value", "true");
            await page.reload();
            await openSettings(page, "local");
            await settings.getByRole("button", { name: "알림", exact: true }).click();
            await expect(panel.getByRole("combobox", { name: "알림 소리", exact: true })).toHaveAttribute("data-selected-value", "true");
            await settings.getByRole("tab", { name: "데몬 설정", exact: true }).click();
            await expect(settings.getByRole("button", { name: "알림", exact: true })).toHaveCount(0);
        });

        test("잎 설정은 펼친 상태로 보이고 검색·탭 전환·새로고침에도 저장값을 유지한다", async ({ page }, info) => {
            await login(page);
            await openSettings(page, "local");
            const settings = page.getByTestId("settings");
            const leaves = settings.getByTestId("setting-leaves");
            const enabled = leaves.getByRole("combobox", { name: "진행 중 표시", exact: true });
            const groups = leaves.getByRole("combobox", { name: "잎 무리 수", exact: true });
            const speed = leaves.getByRole("combobox", { name: "잎 회전 속도", exact: true });
            await expect(leaves.getByRole("button", { name: /^진행 중 효과/ })).toHaveCount(0);
            await expect(enabled).toBeVisible();
            await selectChoice(enabled, "animated");
            await selectChoice(groups, "4");
            await selectChoice(speed, "fast");
            await enabled.scrollIntoViewIfNeeded();
            await page.screenshot({ path: info.outputPath(`leaf-settings-${width}.png`) });
            await settings.getByRole("button", { name: "알림", exact: true }).click();
            await settings.getByRole("button", { name: "화면·입력", exact: true }).click();
            await expect(speed).toBeVisible();
            await settings.getByLabel("설정 검색", { exact: true }).fill("잎 회전 속도");
            await expect(speed).toBeVisible();
            await expect(speed).toHaveAttribute("data-selected-value", "fast");
            await expect(groups).toHaveAttribute("data-selected-value", "4");
            await selectChoice(enabled, "static");
            await page.reload();
            await openSettings(page, "local");
            await expect(enabled).toBeVisible();
            await settings.getByLabel("설정 검색", { exact: true }).fill("새싹");
            await expect(groups).toBeVisible();
            await expect(enabled).toHaveAttribute("data-selected-value", "static");
            await expect(groups).toBeDisabled();
            await expect(groups).toHaveAttribute("data-selected-value", "4");
            await expect(speed).toHaveAttribute("data-selected-value", "fast");
        });

        test("로컬 환경과 데몬 설정은 목록·검색·저장 대상이 섞이지 않는다", async ({ page }, info) => {
            await ensureProfile();
            const before = await timeBudget();
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
            for (const id of ["hosts", "device-name", "browser-capabilities", "logout"]) {
                await expect(settings.getByTestId(`setting-${id}`)).toBeVisible();
            }
            await expect(settings.getByTestId("setting-client-status")).toHaveCount(0);
            await expect(settings.getByTestId("setting-devices")).toHaveCount(0);

            await daemon.click();
            await expect(daemon).toHaveAttribute("aria-selected", "true");
            await expect(settings.getByTestId("setting-profiles")).toBeVisible();
            await expect(settings.getByTestId("setting-theme")).toHaveCount(0);
            await expect(settings.getByRole("button", { name: "화면·입력", exact: true })).toHaveCount(0);
            await settings.getByRole("button", { name: "기기·연결", exact: true }).click();
            await expect(settings.getByTestId("setting-devices")).toBeVisible();
            await expect(settings.getByTestId("setting-devices").getByRole("button", { name: "페어링 링크 발급" })).toBeVisible();
            for (const id of ["hosts", "device-name", "browser-capabilities", "logout"]) {
                await expect(settings.getByTestId(`setting-${id}`)).toHaveCount(0);
            }
            try {
                await settings.getByLabel("설정 검색", { exact: true }).fill("요청당 시간 예산");
                const row = settings.getByTestId("setting-runs.budget.max_minutes");
                await expect(row).toContainText("서버 전체");
                const value = width;
                await row.getByLabel("요청당 시간 예산(분)", { exact: true }).fill(String(value));
                await row.getByLabel("요청당 시간 예산(분)", { exact: true }).blur();
                await expect.poll(async () => (await timeBudget()).effective).toBe(value);
                await page.screenshot({ path: info.outputPath(`daemon-settings-${width}.png`) });
                await local.click();
                await expect(settings.getByRole("combobox", { name: "테마", exact: true })).toHaveAttribute("data-selected-value", "dark");
                await settings.getByLabel("설정 검색", { exact: true }).fill("요청당 시간 예산");
                await expect(settings.getByTestId("setting-runs.budget.max_minutes")).toHaveCount(0);
                expect((await timeBudget()).effective).toBe(value);
            } finally {
                const current = await timeBudget();
                await apiCall("PUT", "/settings/server/-/runs.budget.max_minutes", {
                    expected_revision: current.layers.server?.revision ?? 0, value: before.layers.server?.value ?? null,
                });
            }
        });
    });
}
