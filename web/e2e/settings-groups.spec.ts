import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login, openSettings } from "./helpers";
import type { DeviceInfo } from "../app/api/generated";

for (const width of [390, 1280]) {
    for (const theme of ["light", "dark"] as const) {
        test.describe(`${width}px ${theme} 설정 그룹`, () => {
            test.use({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760 });
            test("제목은 내용을 접지 않고, 검색·버튼·입력을 유지한다", async ({ page }, info) => {
                const device = await apiCall<{ id: string }>("POST", "/devices", { name: "레이아웃 확인용 기기" });
                try {
                    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
                    await login(page);
                    await page.route("**/api/v1/devices", async (route) => {
                        const response = await route.fetch();
                        const devices = await response.json() as DeviceInfo[];
                        await route.fulfill({ response, json: devices.filter((item) => item.kind === "owner" || item.current || item.id === device.id) });
                    });
                    await page.route("**/api/v1/pairings", (route) => {
                        expect(route.request().method()).toBe("GET");
                        return route.fulfill({ json: [] });
                    });
                    await openSettings(page);
                    const settings = page.locator(".settings");
                    await settings.getByRole("button", { name: "기기·연결", exact: true }).click();
                    const pairing = settings.getByTestId("setting-pairing");
                    const capabilities = settings.getByTestId("setting-browser-capabilities");
                    await expect(settings.getByTestId("setting-devices")).toContainText("레이아웃 확인용 기기");
                    const input = pairing.getByLabel("등록할 기기 이름", { exact: true });
                    await input.fill("보존할 기기 이름");
                    await pairing.getByRole("heading", { name: "QR·링크로 기기 등록", exact: true }).click();
                    await expect(input).toBeVisible();
                    await expect(input).toHaveValue("보존할 기기 이름");
                    await pairing.getByRole("button", { name: "고급 연결 설정", exact: true }).click();
                    const dialog = pairing.getByRole("dialog", { name: "고급 연결 설정", exact: true });
                    await expect(dialog.getByLabel("외부 암호화 연결 주소", { exact: true })).toBeVisible();
                    await page.keyboard.press("Escape");
                    await expect(input).toHaveValue("보존할 기기 이름");
                    const refresh = capabilities.getByRole("button", { name: "브라우저 기능 새로 확인" });
                    await refresh.focus();
                    await page.keyboard.press("Enter");
                    await expect(refresh).toBeVisible();
                    await page.evaluate(() => document.fonts.ready);
                    expect(await page.evaluate(() => [...document.fonts].some((font) => font.family === "Pretendard" && font.status === "loaded"))).toBe(true);
                    expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
                    await page.screenshot({ path: info.outputPath("devices.png"), fullPage: true });
                    await settings.getByLabel("설정 검색").fill("기기 토큰");
                    await expect(settings.getByRole("button", { name: "기기 토큰 발급" })).toBeVisible();
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
                const settings = page.locator(".settings");
                await settings.getByRole("button", { name: "기기·연결", exact: true }).click();
                await expect(settings.getByTestId("setting-devices").locator("li")).toHaveCount(0);
                await expect(settings.getByRole("button", { name: "기기 토큰 발급" })).toBeVisible();
                await expect(settings.getByTestId("setting-pairing").getByLabel("등록할 기기 이름")).toBeVisible();
                expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
            });
        });
    }
}

test("미저장 값과 저장 실패를 본문·그룹 제목에 함께 표시한다", async ({ page }) => {
    await login(page);
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("응답 언어");
    const row = page.getByTestId("setting-output.language");
    const group = row.locator("xpath=ancestor::*[@data-ui='settings-group'][1]");
    const heading = group.locator(":scope > header");
    await row.getByLabel("응답 언어", { exact: true }).fill("보존할 미저장 값");
    await expect(heading).toContainText("저장 안 됨");
    await heading.getByRole("heading").click();
    await expect(row.getByLabel("응답 언어", { exact: true })).toHaveValue("보존할 미저장 값");
    await page.route("**/api/v1/settings/server/-/output.language", (route) =>
        route.fulfill({ status: 500, json: { error: { code: "internal", message: "설정 저장 확인용 오류", retryable: false } } }));
    await row.getByRole("button", { name: "저장", exact: true }).click();
    await expect(row.getByRole("status").filter({ hasText: "저장 실패" })).toContainText("기존 값 유지");
    await expect(heading).toContainText("저장 안 됨 · 오류");
    await expect(row.getByLabel("응답 언어", { exact: true })).toHaveValue("보존할 미저장 값");
});

test("그룹의 적용 대상은 선택한 범위를 따른다", async ({ page }) => {
    const { a } = await ensureProjects();
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: a.name, exact: true }).click();
    await page.getByRole("button", { name: "프로젝트 작업", exact: true }).click();
    await page.getByRole("button", { name: "프로젝트 설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("응답 언어");
    const row = page.getByTestId("setting-output.language");
    const heading = row.locator("xpath=ancestor::*[@data-ui='settings-group'][1]").locator(":scope > header");
    await expect(heading).toContainText(a.name);
    await row.getByLabel("응답 언어 적용 범위", { exact: true }).selectOption("server");
    await expect(heading).toContainText("서버 전체");
    await expect(heading).not.toContainText(a.name);
    await row.getByLabel("응답 언어 적용 범위", { exact: true }).selectOption("project");
    await expect(heading).toContainText(a.name);
});
