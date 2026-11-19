import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login, openSettings, openProjectSettings, registerBrowser, selectChoice } from "./helpers";
import type { DeviceInfo } from "../app/api/generated";

for (const width of [390, 1280]) {
    for (const theme of ["light", "dark"] as const) {
        test.describe(`${width}px ${theme} 설정 그룹`, () => {
            test.use({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760 });
            test("제목은 내용을 접지 않고, 검색·버튼·입력을 유지한다", async ({ page }, info) => {
                const device = await registerBrowser(page, undefined, undefined, "레이아웃 확인용 기기");
                try {
                    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
                    await login(page);
                    await page.route("**/api/v1/devices", async (route) => {
                        const response = await route.fetch();
                        const devices = await response.json() as DeviceInfo[];
                        const current = devices.find((item) => item.current);
                        await route.fulfill({ response, json: devices.filter((item) => item.current || item.id === current?.parent_id || item.id === device.id) });
                    });
                    await page.route("**/api/v1/pairings", (route) => {
                        expect(route.request().method()).toBe("GET");
                        return route.fulfill({ json: [] });
                    });
                    await openSettings(page);
                    const settings = page.getByTestId("settings");
                    await settings.getByRole("button", { name: "기기·연결", exact: true }).click();
                    const pairing = settings.getByTestId("setting-devices");
                    const capabilities = settings.getByTestId("setting-browser-capabilities");
                    await expect(settings.getByTestId("setting-devices")).toContainText("레이아웃 확인용 기기");
                    const input = page.getByRole("dialog", { name: "페어링 링크 발급", exact: true }).getByLabel("표시할 이름", { exact: true });
                    await expect(input).toHaveCount(0);
                    await expect(pairing.getByLabel("링크 비밀번호", { exact: true })).toHaveCount(0);
                    await pairing.getByRole("heading", { name: "기기·등록 링크", exact: true }).click();
                    await expect(pairing.getByRole("button", { name: "페어링 링크 발급", exact: true })).toBeVisible();
                    await pairing.getByRole("button", { name: "고급 연결 설정", exact: true }).click();
                    const dialog = pairing.getByRole("dialog", { name: "고급 연결 설정", exact: true });
                    await expect(dialog.getByLabel("외부 암호화 연결 주소", { exact: true })).toBeVisible();
                    await page.keyboard.press("Escape");
                    await pairing.getByRole("button", { name: "페어링 링크 발급", exact: true }).click();
                    const issuance = page.getByRole("dialog", { name: "페어링 링크 발급", exact: true });
                    await expect(input).toBeFocused();
                    await input.fill("보존할 표시 이름");
                    await issuance.getByLabel("링크 비밀번호", { exact: true }).fill("discard-on-cancel");
                    expect(await issuance.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
                    await page.screenshot({ path: info.outputPath("pairing-issue.png"), animations: "disabled" });
                    await issuance.getByRole("button", { name: "취소", exact: true }).click();
                    await expect(issuance).toHaveCount(0);
                    await expect(pairing.getByRole("button", { name: "페어링 링크 발급", exact: true })).toBeFocused();
                    await pairing.getByRole("button", { name: "페어링 링크 발급", exact: true }).click();
                    await expect(input).toHaveValue("");
                    await expect(issuance.getByLabel("링크 비밀번호", { exact: true })).toHaveValue("");
                    await page.keyboard.press("Escape");
                    await expect(issuance).toHaveCount(0);
                    await settings.getByRole("tab", { name: "로컬 설정", exact: true }).click();
                    await settings.getByRole("button", { name: "기기·연결", exact: true }).click();
                    const refresh = capabilities.getByRole("button", { name: "브라우저 기능 새로 확인" });
                    await refresh.focus();
                    await page.keyboard.press("Enter");
                    await expect(refresh).toBeVisible();
                    await page.evaluate(() => document.fonts.ready);
                    expect(await page.evaluate(() => [...document.fonts].some((font) => font.family === "Pretendard" && font.status === "loaded"))).toBe(true);
                    expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
                    await page.screenshot({ path: info.outputPath("devices.png"), fullPage: true });
                    await settings.getByRole("tab", { name: "데몬 설정", exact: true }).click();
                    await settings.getByLabel("설정 검색").fill("QR 링크");
                    await expect(pairing.getByRole("button", { name: "페어링 링크 발급" })).toBeVisible();
                } finally {
                    await apiCall("DELETE", `/devices/${device.id}`);
                }
            });

            test("빈 목록도 조작 경로와 배치를 유지한다", async ({ page }) => {
                await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
                await page.route("**/api/v1/devices", (route) => route.fulfill({ json: [] }));
                await page.route("**/api/v1/pairings", (route) => route.fulfill({ json: [] }));
                await login(page);
                await openSettings(page);
                const settings = page.getByTestId("settings");
                await settings.getByRole("button", { name: "기기·연결", exact: true }).click();
                await expect(settings.getByTestId("setting-devices").locator("li")).toHaveCount(0);
                const pairing = settings.getByTestId("setting-devices");
                await expect(pairing.getByRole("button", { name: "페어링 링크 발급", exact: true })).toBeVisible();
                await expect(pairing.getByLabel("표시할 이름", { exact: true })).toHaveCount(0);
                expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
            });
        });
    }
}

test("미저장 값과 저장 실패를 본문·그룹 제목에 함께 표시한다", async ({ page }) => {
    await login(page);
    await page.getByTestId("sidebar").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("tab", { name: "데몬 설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("요청당 시간 예산");
    const row = page.getByTestId("setting-runs.budget.max_minutes");
    const group = row.locator("xpath=ancestor::*[@data-ui='settings-group'][1]");
    const heading = group.locator(":scope > header");
    await row.getByLabel("요청당 시간 예산(분)", { exact: true }).fill("30");
    await expect(heading).toContainText("저장 안 됨");
    await page.route("**/api/v1/settings/server/-/runs.budget.max_minutes", (route) =>
        route.fulfill({ status: 422, json: { error: { code: "invalid_input", message: "설정 저장 확인용 오류", retryable: false } } }));
    await heading.getByRole("heading").click();
    await expect(row.getByRole("status").filter({ hasText: "저장 실패" })).toContainText("기존 값 유지");
    await expect(heading).toContainText("저장 안 됨 · 오류");
    await expect(row.getByLabel("요청당 시간 예산(분)", { exact: true })).toHaveValue("30");
});

test("그룹의 적용 대상은 선택한 범위를 따른다", async ({ page }) => {
    const { a } = await ensureProjects();
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: a.name, exact: true }).click();
    await openProjectSettings(page);
    await page.getByLabel("설정 검색").fill("요청당 시간 예산");
    const row = page.getByTestId("setting-runs.budget.max_minutes");
    const heading = row.locator("xpath=ancestor::*[@data-ui='settings-group'][1]").locator(":scope > header");
    await expect(heading).toContainText(a.name);
    await selectChoice(row.getByLabel("요청당 시간 예산(분) 적용 범위", { exact: true }), "server");
    await expect(heading).toContainText("서버 전체");
    await expect(heading).not.toContainText(a.name);
    await selectChoice(row.getByLabel("요청당 시간 예산(분) 적용 범위", { exact: true }), "project");
    await expect(heading).toContainText(a.name);
});
