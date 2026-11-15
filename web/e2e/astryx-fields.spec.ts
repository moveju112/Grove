import { expect, test } from "@playwright/test";
import { apiCall, login, openSettings } from "./helpers";

test("Astryx 입력에서도 필수 값 검증은 서버 전송 전에 동작한다", async ({ page }) => {
    await login(page);
    await openSettings(page);
    await page.getByLabel("설정 검색").fill("API 키");
    const form = page.getByTestId("setting-secrets").locator("form");
    const name = form.getByRole("textbox", { name: "키 이름", exact: true });
    const value = form.getByLabel("키 값", { exact: true });
    const submit = form.getByRole("button", { name: "추가", exact: true });
    const posts: string[] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/secrets") posts.push(request.url());
    });
    await submit.click();
    await expect(name).toBeFocused();
    expect(posts).toHaveLength(0);
    await name.fill("Astryx 필수 입력 검증");
    await submit.click();
    await expect(value).toBeFocused();
    expect(posts).toHaveLength(0);
    await value.fill("fixture-native-validation");
    const response = page.waitForResponse((response) => response.request().method() === "POST"
        && new URL(response.url()).pathname === "/api/v1/secrets");
    await submit.click();
    const result = await response;
    expect(result.ok()).toBe(true);
    const created = await result.json() as { id: string };
    try {
        await expect(name).toHaveValue("");
        await expect(value).toHaveValue("");
        expect(posts).toHaveLength(1);
    } finally {
        await apiCall("DELETE", `/secrets/${created.id}`);
    }
});

test("Astryx 기기 이름은 기존 native 길이 제한을 유지한다", async ({ page }) => {
    await login(page);
    await openSettings(page);
    await page.getByLabel("설정 검색").fill("등록 기기");
    const input = page.getByLabel("이 기기 이름", { exact: true });
    await expect(input).toBeEnabled();
    await input.fill("가".repeat(81));
    await expect(input).toHaveValue("가".repeat(80));
});
